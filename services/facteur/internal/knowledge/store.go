package knowledge

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	"github.com/proompteng/lab/services/facteur/internal/froussardpb"
)

// Store coordinates writes into the codex_kb schema.
type Store struct {
	db *sql.DB
}

// IdeaRecord captures normalized intake data.
type IdeaRecord struct {
	ID         string
	SourceType string
	SourceRef  string
	Priority   int
	Status     string
	RiskFlags  []byte
	Payload    []byte
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// TaskRecord represents stage-level orchestration state.
type TaskRecord struct {
	ID          string
	IdeaID      string
	Stage       string
	State       string
	Assignee    sql.NullString
	SLADeadline sql.NullTime
	Metadata    []byte
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// TaskRunRecord captures workflow execution telemetry.
type TaskRunRecord struct {
	ID            string
	TaskID        string
	ExternalRunID sql.NullString
	Status        string
	QueuedAt      time.Time
	StartedAt     sql.NullTime
	CompletedAt   sql.NullTime
	InputRef      sql.NullString
	OutputRef     sql.NullString
	RetryCount    int
	ErrorCode     sql.NullString
	Metadata      []byte
	DeliveryID    string
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

var protojsonMarshaler = protojson.MarshalOptions{
	EmitUnpopulated: true,
}

// NewStore constructs a Store around the shared DB handle.
func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

// UpsertIdea persists intake data for downstream orchestration.
func (s *Store) UpsertIdea(ctx context.Context, record IdeaRecord) (string, error) {
	if s == nil || s.db == nil {
		return "", errors.New("knowledge store is not initialised")
	}

	if strings.TrimSpace(record.SourceType) == "" {
		return "", errors.New("source type is required")
	}
	if strings.TrimSpace(record.SourceRef) == "" {
		return "", errors.New("source ref is required")
	}

	payload := record.Payload
	if len(payload) == 0 {
		payload = []byte("{}")
	}
	riskFlags := record.RiskFlags
	if len(riskFlags) == 0 {
		riskFlags = []byte("{}")
	}

	const query = `
INSERT INTO codex_kb.ideas (
  source_type,
  source_ref,
  priority,
  status,
  risk_flags,
  payload
) VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (source_type, source_ref)
DO UPDATE SET
  priority = EXCLUDED.priority,
  status = EXCLUDED.status,
  risk_flags = EXCLUDED.risk_flags,
  payload = EXCLUDED.payload,
  updated_at = now()
RETURNING id;
`

	var ideaID string
	if err := s.db.QueryRowContext(
		ctx,
		query,
		record.SourceType,
		record.SourceRef,
		record.Priority,
		record.Status,
		riskFlags,
		payload,
	).Scan(&ideaID); err != nil {
		return "", fmt.Errorf("upsert idea: %w", err)
	}

	return ideaID, nil
}

// RecordWebhookIdea translates a Froussard webhook into an idea record.
func (s *Store) RecordWebhookIdea(ctx context.Context, payload []byte) (string, error) {
	if len(payload) == 0 {
		return "", errors.New("empty webhook payload")
	}

	var body struct {
		Issue struct {
			Number int64  `json:"number"`
			Title  string `json:"title"`
			Body   string `json:"body"`
			State  string `json:"state"`
		} `json:"issue"`
		Repository struct {
			FullName string `json:"full_name"`
		} `json:"repository"`
	}

	if err := json.Unmarshal(payload, &body); err != nil {
		return "", fmt.Errorf("decode webhook payload: %w", err)
	}

	if strings.TrimSpace(body.Repository.FullName) == "" {
		return "", errors.New("repository.full_name is required")
	}
	if body.Issue.Number <= 0 {
		return "", errors.New("issue.number must be positive")
	}

	sourceRef := fmt.Sprintf("%s#%d", body.Repository.FullName, body.Issue.Number)
	status := body.Issue.State
	if strings.TrimSpace(status) == "" {
		status = "open"
	}

	id, err := s.UpsertIdea(ctx, IdeaRecord{
		SourceType: "github.issue",
		SourceRef:  sourceRef,
		Priority:   0,
		Status:     status,
		RiskFlags:  []byte("{}"),
		Payload:    payload,
	})
	if err != nil {
		return "", err
	}
	return id, nil
}

// RecordTaskLifecycle stores task and run state transitions.
func (s *Store) RecordTaskLifecycle(ctx context.Context, task TaskRecord, run TaskRunRecord) (TaskRecord, TaskRunRecord, error) {
	if s == nil || s.db == nil {
		return TaskRecord{}, TaskRunRecord{}, errors.New("knowledge store is not initialised")
	}
	if strings.TrimSpace(task.IdeaID) == "" {
		return TaskRecord{}, TaskRunRecord{}, errors.New("task idea_id is required")
	}
	if strings.TrimSpace(task.Stage) == "" {
		return TaskRecord{}, TaskRunRecord{}, errors.New("task stage is required")
	}
	if strings.TrimSpace(run.DeliveryID) == "" {
		return TaskRecord{}, TaskRunRecord{}, errors.New("task run delivery_id is required")
	}
	if run.QueuedAt.IsZero() {
		return TaskRecord{}, TaskRunRecord{}, errors.New("task run queued_at is required")
	}

	task.Metadata = ensureJSON(task.Metadata)
	run.Metadata = ensureJSON(run.Metadata)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return TaskRecord{}, TaskRunRecord{}, fmt.Errorf("begin transaction: %w", err)
	}
	defer func() {
		_ = tx.Rollback()
	}()

	const upsertTask = `
INSERT INTO codex_kb.tasks (
  idea_id, stage, state, assignee, sla_deadline, metadata
) VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (idea_id, stage)
DO UPDATE SET
  state = EXCLUDED.state,
  assignee = EXCLUDED.assignee,
  sla_deadline = EXCLUDED.sla_deadline,
  metadata = EXCLUDED.metadata,
  updated_at = now()
RETURNING id, idea_id, stage, state, assignee, sla_deadline, metadata, created_at, updated_at;
`

	var persistedTask TaskRecord
	if err := tx.QueryRowContext(
		ctx,
		upsertTask,
		task.IdeaID,
		task.Stage,
		task.State,
		task.Assignee,
		task.SLADeadline,
		task.Metadata,
	).Scan(
		&persistedTask.ID,
		&persistedTask.IdeaID,
		&persistedTask.Stage,
		&persistedTask.State,
		&persistedTask.Assignee,
		&persistedTask.SLADeadline,
		&persistedTask.Metadata,
		&persistedTask.CreatedAt,
		&persistedTask.UpdatedAt,
	); err != nil {
		return TaskRecord{}, TaskRunRecord{}, fmt.Errorf("upsert task: %w", err)
	}

	run.TaskID = persistedTask.ID

	const upsertRun = `
INSERT INTO codex_kb.task_runs (
  task_id,
  external_run_id,
  status,
  queued_at,
  started_at,
  completed_at,
  input_ref,
  output_ref,
  retry_count,
  error_code,
  metadata,
  delivery_id
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
ON CONFLICT (delivery_id)
DO UPDATE SET
  task_id = EXCLUDED.task_id,
  external_run_id = EXCLUDED.external_run_id,
  status = EXCLUDED.status,
  queued_at = EXCLUDED.queued_at,
  started_at = EXCLUDED.started_at,
  completed_at = EXCLUDED.completed_at,
  input_ref = EXCLUDED.input_ref,
  output_ref = EXCLUDED.output_ref,
  retry_count = EXCLUDED.retry_count,
  error_code = EXCLUDED.error_code,
  metadata = EXCLUDED.metadata,
  updated_at = now()
RETURNING id, task_id, external_run_id, status, queued_at, started_at, completed_at, input_ref, output_ref, retry_count, error_code, metadata, created_at, updated_at, delivery_id;
`

	var persistedRun TaskRunRecord
	if err := tx.QueryRowContext(
		ctx,
		upsertRun,
		run.TaskID,
		run.ExternalRunID,
		run.Status,
		run.QueuedAt,
		run.StartedAt,
		run.CompletedAt,
		run.InputRef,
		run.OutputRef,
		run.RetryCount,
		run.ErrorCode,
		run.Metadata,
		run.DeliveryID,
	).Scan(
		&persistedRun.ID,
		&persistedRun.TaskID,
		&persistedRun.ExternalRunID,
		&persistedRun.Status,
		&persistedRun.QueuedAt,
		&persistedRun.StartedAt,
		&persistedRun.CompletedAt,
		&persistedRun.InputRef,
		&persistedRun.OutputRef,
		&persistedRun.RetryCount,
		&persistedRun.ErrorCode,
		&persistedRun.Metadata,
		&persistedRun.CreatedAt,
		&persistedRun.UpdatedAt,
		&persistedRun.DeliveryID,
	); err != nil {
		return TaskRecord{}, TaskRunRecord{}, fmt.Errorf("upsert task run: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return TaskRecord{}, TaskRunRecord{}, fmt.Errorf("commit transaction: %w", err)
	}

	return persistedTask, persistedRun, nil
}

// IngestCodexTask normalises and persists a structured Codex task delivery.
func (s *Store) IngestCodexTask(ctx context.Context, task *froussardpb.CodexTask) (ideaID, taskID, runID string, err error) {
	if task == nil {
		return "", "", "", errors.New("codex task payload is required")
	}
	if strings.TrimSpace(task.GetDeliveryId()) == "" {
		return "", "", "", errors.New("codex task missing delivery_id")
	}

	payload, err := protojsonMarshaler.Marshal(task)
	if err != nil {
		return "", "", "", fmt.Errorf("marshal codex task payload: %w", err)
	}

	ideaSourceRef := buildIdeaSourceRef(task.GetRepository(), task.GetIssueNumber())
	ideaID, err = s.UpsertIdea(ctx, IdeaRecord{
		SourceType: "github.issue",
		SourceRef:  ideaSourceRef,
		Priority:   0,
		Status:     "open",
		RiskFlags:  []byte("{}"),
		Payload:    payload,
	})
	if err != nil {
		return "", "", "", err
	}

	stage := normaliseStage(task.GetStage())
	taskMetadata, err := buildTaskMetadata(task)
	if err != nil {
		return "", "", "", err
	}
	runMetadata, err := buildRunMetadata(task)
	if err != nil {
		return "", "", "", err
	}

	issuedAt := time.Now().UTC()
	if ts := task.GetIssuedAt(); ts != nil && ts.AsTime().Unix() > 0 {
		issuedAt = ts.AsTime().UTC()
	}

	taskRecord, runRecord, err := s.RecordTaskLifecycle(ctx, TaskRecord{
		IdeaID:   ideaID,
		Stage:    stage,
		State:    "pending",
		Assignee: nullString(task.GetSender()),
		Metadata: taskMetadata,
	}, TaskRunRecord{
		Status:        "delivered",
		QueuedAt:      issuedAt,
		InputRef:      nullString(task.GetIssueUrl()),
		OutputRef:     sql.NullString{},
		RetryCount:    0,
		ErrorCode:     sql.NullString{},
		Metadata:      runMetadata,
		DeliveryID:    task.GetDeliveryId(),
		ExternalRunID: sql.NullString{},
	})
	if err != nil {
		return "", "", "", err
	}

	return ideaID, taskRecord.ID, runRecord.ID, nil
}

func ensureJSON(data []byte) []byte {
	if len(data) == 0 {
		return []byte("{}")
	}
	return data
}

func buildIdeaSourceRef(repo string, issueNum int64) string {
	repo = strings.TrimSpace(repo)
	if repo == "" {
		return fmt.Sprintf("issue#%d", issueNum)
	}
	return fmt.Sprintf("%s#%d", repo, issueNum)
}

func normaliseStage(stage froussardpb.CodexTaskStage) string {
	name := stage.String()
	name = strings.TrimPrefix(name, "CODEX_TASK_STAGE_")
	name = strings.TrimSuffix(name, "_")
	name = strings.ToLower(name)
	if name == "" || name == "unspecified" {
		return "unspecified"
	}
	return name
}

func buildTaskMetadata(task *froussardpb.CodexTask) ([]byte, error) {
	var issuedAt time.Time
	if ts := task.GetIssuedAt(); ts != nil {
		issuedAt = ts.AsTime().UTC()
	}

	meta := map[string]any{
		"prompt":        task.GetPrompt(),
		"repository":    task.GetRepository(),
		"base":          task.GetBase(),
		"head":          task.GetHead(),
		"issue_url":     task.GetIssueUrl(),
		"issue_title":   task.GetIssueTitle(),
		"issue_body":    task.GetIssueBody(),
		"sender":        task.GetSender(),
		"stage":         normaliseStage(task.GetStage()),
		"plan_comment":  task.GetPlanCommentId(),
		"plan_url":      task.GetPlanCommentUrl(),
		"plan_body":     task.GetPlanCommentBody(),
		"delivery_id":   task.GetDeliveryId(),
		"issue_number":  task.GetIssueNumber(),
		"review_exists": task.GetReviewContext() != nil,
	}

	if !issuedAt.IsZero() {
		meta["issued_at"] = issuedAt
	}

	if rc := task.GetReviewContext(); rc != nil {
		if data, err := protojsonMarshaler.Marshal(rc); err == nil {
			meta["review_context"] = json.RawMessage(data)
		} else {
			return nil, fmt.Errorf("marshal review_context: %w", err)
		}
	}

	return json.Marshal(meta)
}

func buildRunMetadata(task *froussardpb.CodexTask) ([]byte, error) {
	meta := map[string]any{
		"stage":        normaliseStage(task.GetStage()),
		"repository":   task.GetRepository(),
		"head":         task.GetHead(),
		"delivery_id":  task.GetDeliveryId(),
		"plan_comment": task.GetPlanCommentId(),
		"sender":       task.GetSender(),
	}

	if rc := task.GetReviewContext(); rc != nil {
		if data, err := protojsonMarshaler.Marshal(rc); err == nil {
			meta["review_context"] = json.RawMessage(data)
		} else {
			return nil, fmt.Errorf("marshal review_context: %w", err)
		}
	}

	return json.Marshal(meta)
}

func nullString(value string) sql.NullString {
	value = strings.TrimSpace(value)
	if value == "" {
		return sql.NullString{}
	}
	return sql.NullString{String: value, Valid: true}
}
