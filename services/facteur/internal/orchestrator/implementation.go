package orchestrator

import (
	"context"
	"database/sql"
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

	"github.com/proompteng/lab/services/facteur/internal/agents"
	"github.com/proompteng/lab/services/facteur/internal/froussardpb"
	"github.com/proompteng/lab/services/facteur/internal/knowledge"
	"github.com/proompteng/lab/services/facteur/internal/telemetry"
)

const (
	implementationStageLabel    = "implementation"
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
	submitter        agents.Submitter
	cfg              Config
	deliveries       sync.Map
	completed        sync.Map
	tracer           trace.Tracer
	now              func() time.Time
	evictionAfter    time.Duration
	scheduleEviction func(deliveryID string, expiresAt time.Time, ttl time.Duration, deleteFn func())
}

// NewImplementer constructs an implementation orchestrator backed by the Agents service.
func NewImplementer(store knowledgeStore, submitter agents.Submitter, cfg Config) (Implementer, error) {
	if store == nil {
		return nil, errors.New("implementer: knowledge store is required")
	}
	if submitter == nil {
		return nil, errors.New("implementer: agents submitter is required")
	}

	mergedParams := map[string]string{}
	for k, v := range cfg.Parameters {
		mergedParams[k] = v
	}

	return &implementer{
		store:     store,
		submitter: submitter,
		cfg: Config{
			Namespace:               cfg.Namespace,
			AgentName:               cfg.AgentName,
			RuntimeType:             cfg.RuntimeType,
			RuntimeConfig:           cloneAnyMap(cfg.RuntimeConfig),
			Parameters:              mergedParams,
			Secrets:                 cloneStringSlice(cfg.Secrets),
			SecretBindingRef:        cfg.SecretBindingRef,
			VCSProvider:             cfg.VCSProvider,
			VCSPolicyMode:           cfg.VCSPolicyMode,
			VCSRequired:             cfg.VCSRequired,
			GoalTokenBudget:         cfg.GoalTokenBudget,
			TTLSecondsAfterFinished: cfg.TTLSecondsAfterFinished,
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
			attribute.String(attributeAgentRun, duplicate.AgentRunName),
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
		attribute.String(attributeAgentRun, result.AgentRunName),
	)
	span.SetStatus(codes.Ok, "implementation AgentRun dispatched")

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
		"deliveryId": deliveryID,
		"target":     "agentrun",
		"namespace":  resolveNamespace(i.cfg.Namespace),
		"agentName":  resolveAgentName(i.cfg.AgentName),
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
	parameters["deliveryId"] = deliveryID
	parameters["stage"] = implementationStageLabel
	if repository := strings.TrimSpace(task.GetRepository()); repository != "" {
		parameters["repository"] = repository
	}
	if issueNumber := task.GetIssueNumber(); issueNumber > 0 {
		parameters["issueNumber"] = strconv.FormatInt(issueNumber, 10)
		parameters["issue_number"] = strconv.FormatInt(issueNumber, 10)
	}
	parameters["head"] = task.GetHead()
	parameters["base"] = base
	if title := strings.TrimSpace(task.GetIssueTitle()); title != "" {
		parameters["issueTitle"] = title
	}
	if body := strings.TrimSpace(task.GetIssueBody()); body != "" {
		parameters["issueBody"] = body
	}
	if issueURL := strings.TrimSpace(task.GetIssueUrl()); issueURL != "" {
		parameters["issueUrl"] = issueURL
	}
	if sender := strings.TrimSpace(task.GetSender()); sender != "" {
		parameters["sender"] = sender
	}
	if issuedAt := task.GetIssuedAt(); issuedAt != nil {
		parameters["issuedAt"] = issuedAt.AsTime().UTC().Format(time.RFC3339)
	}
	if metadataVersion := task.GetMetadataVersion(); metadataVersion > 0 {
		parameters["metadataVersion"] = strconv.FormatInt(int64(metadataVersion), 10)
	}
	iterationsCount := resolveIterationsCount(task)
	parameters["implementation_iterations"] = strconv.Itoa(iterationsCount)
	parameters["iteration_cycle"] = strconv.Itoa(resolveIterationCycle(task))

	span.SetAttributes(attribute.String(attributeRunParameters, strings.Join(sortedKeys(parameters), ",")))

	implementation := buildAgentRunImplementation(task, base)
	result, err := i.submitter.SubmitAgentRun(ctx, agents.SubmitAgentRunInput{
		Namespace:               resolveNamespace(i.cfg.Namespace),
		AgentName:               resolveAgentName(i.cfg.AgentName),
		DeliveryID:              deliveryID,
		Implementation:          implementation,
		GoalObjective:           resolveGoalObjective(task),
		GoalTokenBudget:         i.cfg.GoalTokenBudget,
		RuntimeType:             resolveRuntimeType(i.cfg.RuntimeType),
		RuntimeConfig:           cloneAnyMap(i.cfg.RuntimeConfig),
		Parameters:              parameters,
		Secrets:                 cloneStringSlice(i.cfg.Secrets),
		SecretBindingRef:        i.cfg.SecretBindingRef,
		VCSProvider:             i.cfg.VCSProvider,
		VCSPolicyMode:           i.cfg.VCSPolicyMode,
		VCSRequired:             i.cfg.VCSRequired,
		TTLSecondsAfterFinished: i.cfg.TTLSecondsAfterFinished,
	})
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "agentrun submission failed")
		return Result{}, fmt.Errorf("implementation orchestrator: submit AgentRun: %w", err)
	}

	return Result{
		Namespace:    result.Namespace,
		AgentRunName: result.AgentRunName,
		SubmittedAt:  result.SubmittedAt,
		Duplicate:    false,
	}, nil
}

func resolveNamespace(value string) string {
	if strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	return "agents"
}

func resolveAgentName(value string) string {
	if strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	return "codex-agent"
}

func resolveRuntimeType(value string) string {
	if strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	return "job"
}

func resolveGoalObjective(task *froussardpb.CodexTask) string {
	if task == nil {
		return "Run Codex implementation task"
	}
	if prompt := strings.TrimSpace(task.GetPrompt()); prompt != "" {
		return prompt
	}
	if repository := strings.TrimSpace(task.GetRepository()); repository != "" && task.GetIssueNumber() > 0 {
		return fmt.Sprintf("Implement %s#%d", repository, task.GetIssueNumber())
	}
	return "Run Codex implementation task"
}

func buildAgentRunImplementation(task *froussardpb.CodexTask, base string) map[string]any {
	summary := strings.TrimSpace(task.GetIssueTitle())
	if summary == "" && strings.TrimSpace(task.GetRepository()) != "" && task.GetIssueNumber() > 0 {
		summary = fmt.Sprintf("Implement %s#%d", task.GetRepository(), task.GetIssueNumber())
	}
	if summary == "" {
		summary = "Codex implementation task"
	}
	text := strings.TrimSpace(task.GetPrompt())
	if text == "" {
		text = summary
	}

	implementation := map[string]any{
		"summary": summary,
		"text":    text,
		"contract": map[string]any{
			"requiredKeys": []string{"repository", "issueNumber", "base", "head", "stage"},
		},
	}

	source := map[string]any{"provider": "github"}
	if repository := strings.TrimSpace(task.GetRepository()); repository != "" && task.GetIssueNumber() > 0 {
		source["externalId"] = fmt.Sprintf("%s#%d", repository, task.GetIssueNumber())
	}
	if issueURL := strings.TrimSpace(task.GetIssueUrl()); issueURL != "" {
		source["url"] = issueURL
	}
	implementation["source"] = source

	metadata := map[string]any{
		"stage": implementationStageLabel,
		"base":  strings.TrimSpace(base),
	}
	if repository := strings.TrimSpace(task.GetRepository()); repository != "" {
		metadata["repository"] = repository
	}
	if issueNumber := task.GetIssueNumber(); issueNumber > 0 {
		metadata["issueNumber"] = strconv.FormatInt(issueNumber, 10)
	}
	if head := strings.TrimSpace(task.GetHead()); head != "" {
		metadata["head"] = head
	}
	if issueURL := strings.TrimSpace(task.GetIssueUrl()); issueURL != "" {
		metadata["issueUrl"] = issueURL
	}
	implementation["metadata"] = metadata

	return implementation
}

func cloneAnyMap(input map[string]any) map[string]any {
	if len(input) == 0 {
		return map[string]any{}
	}
	output := make(map[string]any, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}

func cloneStringSlice(input []string) []string {
	if len(input) == 0 {
		return []string{}
	}
	output := make([]string, len(input))
	copy(output, input)
	return output
}
