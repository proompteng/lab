package knowledge

import (
	"context"
	"database/sql"
	"errors"
	"time"
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
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// NewStore constructs a Store around the shared DB handle.
func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

// UpsertIdea persists intake data for downstream orchestration.
func (s *Store) UpsertIdea(ctx context.Context, record IdeaRecord) error {
	// TODO(codex-autonomy-step-01): implement persistence for ideas/tasks/task_runs bootstrap queries.
	return errors.New("codex-autonomy-step-01 not implemented")
}

// RecordWebhookIdea translates a Froussard webhook into an idea record.
func (s *Store) RecordWebhookIdea(ctx context.Context, payload []byte) error {
	// TODO(codex-autonomy-step-02): parse GitHub issue payloads and persist via UpsertIdea.
	_ = payload
	return errors.New("codex-autonomy-step-02 not implemented")
}

// RecordTaskLifecycle stores task and run state transitions.
func (s *Store) RecordTaskLifecycle(ctx context.Context, task TaskRecord, run TaskRunRecord) error {
	// TODO(codex-autonomy-step-03): persist task state, task runs, and run events atomically.
	_ = task
	_ = run
	return errors.New("codex-autonomy-step-03 not implemented")
}
