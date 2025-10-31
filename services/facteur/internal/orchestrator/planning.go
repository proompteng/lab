package orchestrator

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
	"google.golang.org/protobuf/encoding/protojson"

	"github.com/proompteng/lab/services/facteur/internal/argo"
	"github.com/proompteng/lab/services/facteur/internal/githubpb"
	"github.com/proompteng/lab/services/facteur/internal/knowledge"
	"github.com/proompteng/lab/services/facteur/internal/telemetry"
)

const (
	planningStageLabel      = "planning"
	ideaStatusReceived      = "received"
	taskStateQueued         = "queued"
	taskRunStatusQueued     = "queued"
	defaultGenerateName     = "github-codex-planning-"
	attributeNamespace      = "facteur.codex.namespace"
	attributeWorkflow       = "facteur.codex.workflow"
	attributeDeliveryID     = "facteur.codex.delivery_id"
	attributeRepository     = "facteur.codex.repository"
	attributeIssueNumber    = "facteur.codex.issue_number"
	attributeDuplicate      = "facteur.codex.duplicate"
	attributePlanningStage  = "codex.stage"
	attributeArgoParameters = "facteur.codex.parameters"
)

var (
	// ErrUnsupportedStage indicates that the task's stage cannot be orchestrated by the planner.
	ErrUnsupportedStage = errors.New("planning orchestrator: unsupported stage")
	// ErrMissingDeliveryID indicates that the payload did not include the delivery identifier required for idempotency.
	ErrMissingDeliveryID = errors.New("planning orchestrator: missing delivery_id")
)

// Planner coordinates Codex planning dispatch.
type Planner interface {
	Plan(ctx context.Context, task *githubpb.CodexTask) (Result, error)
}

// Result captures workflow submission metadata.
type Result struct {
	Namespace    string
	WorkflowName string
	SubmittedAt  time.Time
	Duplicate    bool
}

// Config supplies overrides for planning orchestration.
type Config struct {
	Namespace          string
	WorkflowTemplate   string
	ServiceAccount     string
	Parameters         map[string]string
	GenerateNamePrefix string
}

type knowledgeStore interface {
	UpsertIdea(ctx context.Context, record knowledge.IdeaRecord) (string, error)
	RecordTaskLifecycle(ctx context.Context, task knowledge.TaskRecord, run knowledge.TaskRunRecord) (knowledge.TaskRecord, knowledge.TaskRunRecord, error)
}

type requestState struct {
	result Result
	err    error
	done   chan struct{}
}

type planner struct {
	store            knowledgeStore
	runner           argo.Runner
	cfg              Config
	deliveries       sync.Map
	completed        sync.Map
	tracer           trace.Tracer
	now              func() time.Time
	evictionAfter    time.Duration
	scheduleEviction func(deliveryID string, expiresAt time.Time, ttl time.Duration, deleteFn func())
}

// NewPlanner constructs a planning orchestrator backed by the provided store and Argo runner.
func NewPlanner(store knowledgeStore, runner argo.Runner, cfg Config) (Planner, error) {
	if store == nil {
		return nil, errors.New("planner: knowledge store is required")
	}
	if runner == nil {
		return nil, errors.New("planner: argo runner is required")
	}

	mergedParams := map[string]string{}
	for k, v := range cfg.Parameters {
		mergedParams[k] = v
	}

	if cfg.GenerateNamePrefix == "" {
		cfg.GenerateNamePrefix = defaultGenerateName
	}

	return &planner{
		store:  store,
		runner: runner,
		cfg: Config{
			Namespace:          cfg.Namespace,
			WorkflowTemplate:   cfg.WorkflowTemplate,
			ServiceAccount:     cfg.ServiceAccount,
			Parameters:         mergedParams,
			GenerateNamePrefix: cfg.GenerateNamePrefix,
		},
		tracer:        telemetry.Tracer(),
		now:           func() time.Time { return time.Now().UTC() },
		evictionAfter: time.Hour,
		scheduleEviction: func(_ string, _ time.Time, ttl time.Duration, deleteFn func()) {
			time.AfterFunc(ttl, deleteFn)
		},
	}, nil
}

func (p *planner) Plan(ctx context.Context, task *githubpb.CodexTask) (Result, error) {
	if task == nil {
		return Result{}, errors.New("planning orchestrator: task is nil")
	}
	if task.GetStage() != githubpb.CodexTaskStage_CODEX_TASK_STAGE_PLANNING {
		return Result{}, ErrUnsupportedStage
	}

	deliveryID := strings.TrimSpace(task.GetDeliveryId())
	if deliveryID == "" {
		return Result{}, ErrMissingDeliveryID
	}

	if value, ok := p.completed.Load(deliveryID); ok {
		entry := value.(completedEntry)
		if !p.now().After(entry.expiresAt) {
			duplicate := entry.result
			duplicate.Duplicate = true
			return duplicate, nil
		}
		p.completed.Delete(deliveryID)
	}

	ctx, span := p.tracer.Start(ctx, "facteur.orchestrator.plan", trace.WithSpanKind(trace.SpanKindInternal))
	defer span.End()

	span.SetAttributes(
		attribute.String(attributePlanningStage, planningStageLabel),
		attribute.String(attributeDeliveryID, deliveryID),
		attribute.String(attributeRepository, task.GetRepository()),
		attribute.Int64(attributeIssueNumber, task.GetIssueNumber()),
	)

	state := &requestState{done: make(chan struct{})}
	existing, loaded := p.deliveries.LoadOrStore(deliveryID, state)
	if loaded {
		prior := existing.(*requestState)
		<-prior.done
		if prior.err != nil {
			span.RecordError(prior.err)
			span.SetStatus(codes.Error, "previous attempt failed")
			return Result{}, prior.err
		}
		duplicate := prior.result
		duplicate.Duplicate = true
		span.SetAttributes(
			attribute.Bool(attributeDuplicate, true),
			attribute.String(attributeNamespace, duplicate.Namespace),
			attribute.String(attributeWorkflow, duplicate.WorkflowName),
		)
		span.SetStatus(codes.Ok, "duplicate delivery")
		return duplicate, nil
	}

	defer close(state.done)

	result, err := p.execute(ctx, span, deliveryID, task)
	if err != nil {
		state.err = err
		p.deliveries.Delete(deliveryID)
		return Result{}, err
	}

	span.SetAttributes(
		attribute.Bool(attributeDuplicate, false),
		attribute.String(attributeNamespace, result.Namespace),
		attribute.String(attributeWorkflow, result.WorkflowName),
	)
	span.SetStatus(codes.Ok, "planning workflow dispatched")

	state.result = result
	expiresAt := p.now().Add(p.evictionAfter)
	entry := completedEntry{
		result:    result,
		expiresAt: expiresAt,
	}
	p.completed.Store(deliveryID, entry)
	deleteFn := func() {
		if value, ok := p.completed.Load(deliveryID); ok {
			stored := value.(completedEntry)
			if stored.expiresAt.Equal(expiresAt) {
				p.completed.Delete(deliveryID)
			}
		}
	}
	if p.scheduleEviction != nil {
		p.scheduleEviction(deliveryID, expiresAt, p.evictionAfter, deleteFn)
	}
	p.deliveries.Delete(deliveryID)
	return result, nil
}

type completedEntry struct {
	result    Result
	expiresAt time.Time
}

func (p *planner) execute(ctx context.Context, span trace.Span, deliveryID string, task *githubpb.CodexTask) (Result, error) {
	eventBody, err := protojson.MarshalOptions{EmitUnpopulated: true}.Marshal(task)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "marshal event body")
		return Result{}, fmt.Errorf("planning orchestrator: marshal event body: %w", err)
	}

	eventBody, err = overrideStage(eventBody, planningStageLabel)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "normalise event stage")
		return Result{}, fmt.Errorf("planning orchestrator: normalise event stage: %w", err)
	}

	rawEvent := eventBody

	now := p.now()

	idea := knowledge.IdeaRecord{
		SourceType: "github_issue",
		SourceRef:  fmt.Sprintf("%s#%d", task.GetRepository(), task.GetIssueNumber()),
		Priority:   0,
		Status:     ideaStatusReceived,
		RiskFlags:  []byte("{}"),
		Payload:    append([]byte(nil), eventBody...),
		CreatedAt:  now,
		UpdatedAt:  now,
	}

	taskMetadata, err := json.Marshal(map[string]any{
		"deliveryId":  deliveryID,
		"stage":       planningStageLabel,
		"repository":  task.GetRepository(),
		"issueNumber": task.GetIssueNumber(),
		"head":        task.GetHead(),
		"base":        task.GetBase(),
	})
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "marshal task metadata")
		return Result{}, fmt.Errorf("planning orchestrator: marshal task metadata: %w", err)
	}

	taskRecord := knowledge.TaskRecord{
		IdeaID:    "",
		Stage:     planningStageLabel,
		State:     taskStateQueued,
		Metadata:  append([]byte(nil), taskMetadata...),
		CreatedAt: now,
		UpdatedAt: now,
	}

	runMetadata, err := json.Marshal(map[string]any{
		"deliveryId":       deliveryID,
		"workflowTemplate": p.cfg.WorkflowTemplate,
	})
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "marshal run metadata")
		return Result{}, fmt.Errorf("planning orchestrator: marshal run metadata: %w", err)
	}

	taskRun := knowledge.TaskRunRecord{
		Status:        taskRunStatusQueued,
		QueuedAt:      now,
		Metadata:      append([]byte(nil), runMetadata...),
		DeliveryID:    deliveryID,
		CreatedAt:     now,
		UpdatedAt:     now,
		ExternalRunID: sql.NullString{},
		InputRef:      sql.NullString{},
		OutputRef:     sql.NullString{},
		ErrorCode:     sql.NullString{},
	}

	ideaID, err := p.store.UpsertIdea(ctx, idea)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "upsert idea failed")
		return Result{}, fmt.Errorf("planning orchestrator: upsert idea: %w", err)
	}

	taskRecord.IdeaID = ideaID

	if _, _, err := p.store.RecordTaskLifecycle(ctx, taskRecord, taskRun); err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "record task lifecycle failed")
		return Result{}, fmt.Errorf("planning orchestrator: record task lifecycle: %w", err)
	}

	parameters := cloneParameters(p.cfg.Parameters)
	parameters["rawEvent"] = string(rawEvent)
	parameters["eventBody"] = string(eventBody)

	span.SetAttributes(attribute.String(attributeArgoParameters, strings.Join(sortedKeys(parameters), ",")))

	namespace := p.cfg.Namespace
	if namespace == "" {
		namespace = "argo-workflows"
	}
	workflowTemplate := p.cfg.WorkflowTemplate
	if workflowTemplate == "" {
		workflowTemplate = "github-codex-planning"
	}

	result, err := p.runner.Run(ctx, argo.RunInput{
		Namespace:          namespace,
		WorkflowTemplate:   workflowTemplate,
		ServiceAccount:     p.cfg.ServiceAccount,
		Parameters:         parameters,
		GenerateNamePrefix: p.cfg.GenerateNamePrefix,
	})
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "argo submission failed")
		return Result{}, fmt.Errorf("planning orchestrator: submit workflow: %w", err)
	}

	return Result{
		Namespace:    result.Namespace,
		WorkflowName: result.WorkflowName,
		SubmittedAt:  result.SubmittedAt,
		Duplicate:    false,
	}, nil
}

func cloneParameters(input map[string]string) map[string]string {
	if len(input) == 0 {
		return map[string]string{}
	}
	out := make(map[string]string, len(input))
	for k, v := range input {
		out[k] = v
	}
	return out
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func overrideStage(event []byte, stage string) ([]byte, error) {
	if len(event) == 0 {
		return event, nil
	}
	var payload map[string]any
	if err := json.Unmarshal(event, &payload); err != nil {
		return nil, err
	}
	payload["stage"] = stage
	return json.Marshal(payload)
}
