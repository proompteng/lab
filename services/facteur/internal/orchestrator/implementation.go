package orchestrator

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
	"google.golang.org/protobuf/encoding/protojson"

	"github.com/proompteng/lab/services/facteur/internal/argo"
	"github.com/proompteng/lab/services/facteur/internal/froussardpb"
	"github.com/proompteng/lab/services/facteur/internal/knowledge"
	"github.com/proompteng/lab/services/facteur/internal/telemetry"
)

const (
	implementationStageLabel    = "implementation"
	defaultImplementationName   = "github-codex-implementation-"
	maxImplementationIterations = 25
)

var (
	// ErrImplementationUnsupportedStage indicates that the task's stage cannot be orchestrated by the implementer.
	ErrImplementationUnsupportedStage = errors.New("implementation orchestrator: unsupported stage")
	// ErrImplementationMissingDeliveryID indicates that the payload did not include the delivery identifier required for idempotency.
	ErrImplementationMissingDeliveryID = errors.New("implementation orchestrator: missing delivery_id")
)

// Implementer coordinates Codex implementation dispatch.
type Implementer interface {
	Implement(ctx context.Context, task *froussardpb.CodexTask) (Result, error)
}

type implementer struct {
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

// NewImplementer constructs an implementation orchestrator backed by the provided store and Argo runner.
func NewImplementer(store knowledgeStore, runner argo.Runner, cfg Config) (Implementer, error) {
	if store == nil {
		return nil, errors.New("implementer: knowledge store is required")
	}
	if runner == nil {
		return nil, errors.New("implementer: argo runner is required")
	}

	mergedParams := map[string]string{}
	for k, v := range cfg.Parameters {
		mergedParams[k] = v
	}

	if cfg.GenerateNamePrefix == "" {
		cfg.GenerateNamePrefix = defaultImplementationName
	}

	return &implementer{
		store:  store,
		runner: runner,
		cfg: Config{
			Namespace:                    cfg.Namespace,
			WorkflowTemplate:             cfg.WorkflowTemplate,
			AutonomousWorkflowTemplate:   cfg.AutonomousWorkflowTemplate,
			ServiceAccount:               cfg.ServiceAccount,
			Parameters:                   mergedParams,
			GenerateNamePrefix:           cfg.GenerateNamePrefix,
			AutonomousGenerateNamePrefix: cfg.AutonomousGenerateNamePrefix,
			JudgePrompt:                  cfg.JudgePrompt,
		},
		tracer:        telemetry.Tracer(),
		now:           func() time.Time { return time.Now().UTC() },
		evictionAfter: time.Hour,
		scheduleEviction: func(_ string, _ time.Time, ttl time.Duration, deleteFn func()) {
			time.AfterFunc(ttl, deleteFn)
		},
	}, nil
}

func resolveIterationsCount(task *froussardpb.CodexTask) int {
	if task == nil {
		return 1
	}
	policy := task.GetIterations()
	if policy == nil {
		return 1
	}

	mode := strings.ToLower(strings.TrimSpace(policy.GetMode()))
	switch mode {
	case "", "fixed":
		count := int(policy.GetCount())
		if count <= 0 {
			count = 1
		}
		if count > maxImplementationIterations {
			count = maxImplementationIterations
		}
		return count
	case "until":
		max := int(policy.GetMax())
		if max <= 0 {
			max = int(policy.GetCount())
		}
		if max <= 0 {
			max = 1
		}
		if max > maxImplementationIterations {
			max = maxImplementationIterations
		}
		return max
	default:
		return 1
	}
}

func resolveIterationCycle(task *froussardpb.CodexTask) int {
	if task == nil {
		return 1
	}
	cycle := int(task.GetIterationCycle())
	if cycle <= 0 {
		return 1
	}
	return cycle
}

func (i *implementer) Implement(ctx context.Context, task *froussardpb.CodexTask) (Result, error) {
	if task == nil {
		return Result{}, errors.New("implementation orchestrator: task is nil")
	}
	if task.GetStage() != froussardpb.CodexTaskStage_CODEX_TASK_STAGE_IMPLEMENTATION {
		return Result{}, ErrImplementationUnsupportedStage
	}

	deliveryID := strings.TrimSpace(task.GetDeliveryId())
	if deliveryID == "" {
		return Result{}, ErrImplementationMissingDeliveryID
	}

	if value, ok := i.completed.Load(deliveryID); ok {
		entry := value.(completedEntry)
		if !i.now().After(entry.expiresAt) {
			duplicate := entry.result
			duplicate.Duplicate = true
			return duplicate, nil
		}
		i.completed.Delete(deliveryID)
	}

	ctx, span := i.tracer.Start(ctx, "facteur.orchestrator.implement", trace.WithSpanKind(trace.SpanKindInternal))
	defer span.End()

	span.SetAttributes(
		attribute.String(attributePlanningStage, implementationStageLabel),
		attribute.String(attributeDeliveryID, deliveryID),
		attribute.String(attributeRepository, task.GetRepository()),
		attribute.Int64(attributeIssueNumber, task.GetIssueNumber()),
	)

	state := &requestState{done: make(chan struct{})}
	existing, loaded := i.deliveries.LoadOrStore(deliveryID, state)
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

	result, err := i.execute(ctx, span, deliveryID, task)
	if err != nil {
		state.err = err
		i.deliveries.Delete(deliveryID)
		return Result{}, err
	}

	span.SetAttributes(
		attribute.Bool(attributeDuplicate, false),
		attribute.String(attributeNamespace, result.Namespace),
		attribute.String(attributeWorkflow, result.WorkflowName),
	)
	span.SetStatus(codes.Ok, "implementation workflow dispatched")

	state.result = result
	expiresAt := i.now().Add(i.evictionAfter)
	entry := completedEntry{
		result:    result,
		expiresAt: expiresAt,
	}
	i.completed.Store(deliveryID, entry)
	deleteFn := func() {
		if value, ok := i.completed.Load(deliveryID); ok {
			stored := value.(completedEntry)
			if stored.expiresAt.Equal(expiresAt) {
				i.completed.Delete(deliveryID)
			}
		}
	}
	if i.scheduleEviction != nil {
		i.scheduleEviction(deliveryID, expiresAt, i.evictionAfter, deleteFn)
	}
	i.deliveries.Delete(deliveryID)
	return result, nil
}

func (i *implementer) execute(ctx context.Context, span trace.Span, deliveryID string, task *froussardpb.CodexTask) (Result, error) {
	eventBody, err := protojson.MarshalOptions{EmitUnpopulated: true}.Marshal(task)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "marshal event body")
		return Result{}, fmt.Errorf("implementation orchestrator: marshal event body: %w", err)
	}

	rawEvent := append([]byte(nil), eventBody...)

	eventBody, err = overrideStage(eventBody, implementationStageLabel)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "normalise event stage")
		return Result{}, fmt.Errorf("implementation orchestrator: normalise event stage: %w", err)
	}

	now := i.now()

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

	base := strings.TrimSpace(task.GetBase())
	if base == "" {
		base = "main"
	}

	taskMetadata, err := json.Marshal(map[string]any{
		"deliveryId":  deliveryID,
		"stage":       implementationStageLabel,
		"repository":  task.GetRepository(),
		"issueNumber": task.GetIssueNumber(),
		"head":        task.GetHead(),
		"base":        base,
		"autonomous":  task.GetAutonomous(),
	})
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "marshal task metadata")
		return Result{}, fmt.Errorf("implementation orchestrator: marshal task metadata: %w", err)
	}

	taskRecord := knowledge.TaskRecord{
		IdeaID:    "",
		Stage:     implementationStageLabel,
		State:     taskStateQueued,
		Metadata:  append([]byte(nil), taskMetadata...),
		CreatedAt: now,
		UpdatedAt: now,
	}

	runMetadata, err := json.Marshal(map[string]any{
		"deliveryId":       deliveryID,
		"workflowTemplate": i.cfg.WorkflowTemplate,
	})
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "marshal run metadata")
		return Result{}, fmt.Errorf("implementation orchestrator: marshal run metadata: %w", err)
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

	ideaID, err := i.store.UpsertIdea(ctx, idea)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "upsert idea failed")
		return Result{}, fmt.Errorf("implementation orchestrator: upsert idea: %w", err)
	}

	taskRecord.IdeaID = ideaID

	if _, _, err := i.store.RecordTaskLifecycle(ctx, taskRecord, taskRun); err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "record task lifecycle failed")
		return Result{}, fmt.Errorf("implementation orchestrator: record task lifecycle: %w", err)
	}

	parameters := cloneParameters(i.cfg.Parameters)
	parameters["rawEvent"] = base64.StdEncoding.EncodeToString(rawEvent)
	parameters["eventBody"] = base64.StdEncoding.EncodeToString(eventBody)
	parameters["head"] = task.GetHead()
	parameters["base"] = base
	parameters["prompt"] = task.GetPrompt()
	iterationsCount := resolveIterationsCount(task)
	parameters["implementation_iterations"] = strconv.Itoa(iterationsCount)
	parameters["iteration_cycle"] = strconv.Itoa(resolveIterationCycle(task))
	if i.cfg.JudgePrompt != "" {
		parameters["judge_prompt"] = i.cfg.JudgePrompt
	}

	span.SetAttributes(attribute.String(attributeArgoParameters, strings.Join(sortedKeys(parameters), ",")))

	namespace := i.cfg.Namespace
	if namespace == "" {
		namespace = "argo-workflows"
	}
	workflowTemplate := i.cfg.WorkflowTemplate
	generateNamePrefix := i.cfg.GenerateNamePrefix
	if workflowTemplate == "" {
		workflowTemplate = "github-codex-implementation"
	}
	if generateNamePrefix == "" {
		generateNamePrefix = defaultImplementationName
	}

	if task.GetAutonomous() {
		if i.cfg.AutonomousWorkflowTemplate != "" {
			workflowTemplate = i.cfg.AutonomousWorkflowTemplate
		} else {
			workflowTemplate = "codex-autonomous"
		}
		if i.cfg.AutonomousGenerateNamePrefix != "" {
			generateNamePrefix = i.cfg.AutonomousGenerateNamePrefix
		} else {
			generateNamePrefix = "codex-autonomous-"
		}
	}

	labels, annotations := buildCodexWorkflowMetadata(task, base)

	result, err := i.runner.Run(ctx, argo.RunInput{
		Namespace:          namespace,
		WorkflowTemplate:   workflowTemplate,
		ServiceAccount:     i.cfg.ServiceAccount,
		Parameters:         parameters,
		Labels:             labels,
		Annotations:        annotations,
		GenerateNamePrefix: generateNamePrefix,
	})
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "argo submission failed")
		return Result{}, fmt.Errorf("implementation orchestrator: submit workflow: %w", err)
	}

	return Result{
		Namespace:    result.Namespace,
		WorkflowName: result.WorkflowName,
		SubmittedAt:  result.SubmittedAt,
		Duplicate:    false,
	}, nil
}

func buildCodexWorkflowMetadata(task *froussardpb.CodexTask, base string) (map[string]string, map[string]string) {
	if task == nil {
		return nil, nil
	}

	labels := map[string]string{}
	annotations := map[string]string{}

	repository := strings.TrimSpace(task.GetRepository())
	if repository != "" {
		annotations["codex.repository"] = repository
	}

	issueNumber := task.GetIssueNumber()
	if issueNumber > 0 {
		value := strconv.FormatInt(issueNumber, 10)
		labels["codex.issue_number"] = value
		annotations["codex.issue_number"] = value
	}

	head := strings.TrimSpace(task.GetHead())
	if head != "" {
		annotations["codex.head"] = head
	}

	base = strings.TrimSpace(base)
	if base != "" {
		annotations["codex.base"] = base
	}

	if len(labels) == 0 {
		labels = nil
	}
	if len(annotations) == 0 {
		annotations = nil
	}

	return labels, annotations
}
