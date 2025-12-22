package knowledge_test

import (
	"bytes"
	"context"
	"database/sql/driver"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/proompteng/lab/services/facteur/internal/froussardpb"
	"github.com/proompteng/lab/services/facteur/internal/knowledge"
)

func TestUpsertIdea(t *testing.T) {
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() {
		mock.ExpectClose()
		require.NoError(t, db.Close())
	})

	store := knowledge.NewStore(db)
	ctx := context.Background()

	mock.ExpectQuery(`INSERT INTO codex_kb\.ideas`).
		WithArgs(
			"github.issue",
			"proompteng/lab#1635",
			1,
			"open",
			sqlmock.AnyArg(),
			jsonContains(`"example":"value"`),
		).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow("idea-123"))

	id, err := store.UpsertIdea(ctx, knowledge.IdeaRecord{
		SourceType: "github.issue",
		SourceRef:  "proompteng/lab#1635",
		Priority:   1,
		Status:     "open",
		RiskFlags:  nil,
		Payload:    []byte(`{"example":"value"}`),
	})
	require.NoError(t, err)
	assert.Equal(t, "idea-123", id)
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestRecordWebhookIdea(t *testing.T) {
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() {
		mock.ExpectClose()
		require.NoError(t, db.Close())
	})

	store := knowledge.NewStore(db)
	ctx := context.Background()

	payload := []byte(`{"issue":{"number":1635,"title":"Codex","body":"Implement","state":"open"},"repository":{"full_name":"proompteng/lab"}}`)

	mock.ExpectQuery(`INSERT INTO codex_kb\.ideas`).
		WithArgs(
			"github.issue",
			"proompteng/lab#1635",
			0,
			"open",
			sqlmock.AnyArg(),
			jsonContains(`"title":"Codex"`),
		).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow("idea-webhook"))

	id, err := store.RecordWebhookIdea(ctx, payload)
	require.NoError(t, err)
	assert.Equal(t, "idea-webhook", id)
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestRecordTaskLifecycle(t *testing.T) {
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() {
		mock.ExpectClose()
		require.NoError(t, db.Close())
	})

	store := knowledge.NewStore(db)
	ctx := context.Background()
	now := time.Date(2025, 10, 30, 21, 0, 0, 0, time.UTC)
	created := now.Add(time.Second)

	expectTaskLifecycle(mock, "idea-1", "implementation", "task-1", "run-1", now, "delivery-1", created)

	taskRec, runRec, err := store.RecordTaskLifecycle(ctx, knowledge.TaskRecord{
		IdeaID:   "idea-1",
		Stage:    "implementation",
		State:    "pending",
		Metadata: []byte(`{"stage":"implementation"}`),
	}, knowledge.TaskRunRecord{
		Status:     "delivered",
		QueuedAt:   now,
		Metadata:   []byte(`{"delivery_id":"delivery-1"}`),
		DeliveryID: "delivery-1",
	})
	require.NoError(t, err)
	assert.Equal(t, "task-1", taskRec.ID)
	assert.Equal(t, "run-1", runRec.ID)
	assert.Equal(t, "delivery-1", runRec.DeliveryID)
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestRecordTaskLifecycleDuplicateDelivery(t *testing.T) {
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() {
		mock.ExpectClose()
		require.NoError(t, db.Close())
	})

	store := knowledge.NewStore(db)
	ctx := context.Background()
	now := time.Date(2025, 10, 30, 21, 1, 0, 0, time.UTC)
	created := now.Add(time.Second)

	expectTaskLifecycle(mock, "idea-1", "implementation", "task-impl", "run-impl", now, "delivery-dup", created)
	expectTaskLifecycle(mock, "idea-1", "implementation", "task-impl", "run-impl", now, "delivery-dup", created)

	taskRec1, runRec1, err := store.RecordTaskLifecycle(ctx, knowledge.TaskRecord{
		IdeaID: "idea-1",
		Stage:  "implementation",
		State:  "pending",
	}, knowledge.TaskRunRecord{
		Status:     "delivered",
		QueuedAt:   now,
		DeliveryID: "delivery-dup",
	})
	require.NoError(t, err)

	taskRec2, runRec2, err := store.RecordTaskLifecycle(ctx, knowledge.TaskRecord{
		IdeaID: "idea-1",
		Stage:  "implementation",
		State:  "pending",
	}, knowledge.TaskRunRecord{
		Status:     "delivered",
		QueuedAt:   now,
		DeliveryID: "delivery-dup",
	})
	require.NoError(t, err)

	assert.Equal(t, taskRec1.ID, taskRec2.ID)
	assert.Equal(t, runRec1.ID, runRec2.ID)
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestIngestCodexTask(t *testing.T) {
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() {
		mock.ExpectClose()
		require.NoError(t, db.Close())
	})

	store := knowledge.NewStore(db)
	ctx := context.Background()

	issuedAt := time.Date(2025, 10, 30, 21, 2, 0, 0, time.UTC)
	created := issuedAt.Add(time.Second)

	mock.ExpectQuery(`INSERT INTO codex_kb\.ideas`).
		WithArgs(
			"github.issue",
			"proompteng/lab#1635",
			0,
			"open",
			sqlmock.AnyArg(),
			jsonContains(`"repository":"proompteng/lab"`),
		).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow("idea-ingest"))

	expectTaskLifecycle(mock, "idea-ingest", "implementation", "task-ingest", "run-ingest", issuedAt, "delivery-xyz", created)

	ideaID, taskID, runID, err := store.IngestCodexTask(ctx, &froussardpb.CodexTask{
		Stage:       froussardpb.CodexTaskStage_CODEX_TASK_STAGE_IMPLEMENTATION,
		Prompt:      "Implement ingestion",
		Repository:  "proompteng/lab",
		Base:        "main",
		Head:        "feature",
		IssueNumber: 1635,
		IssueUrl:    "https://github.com/proompteng/lab/issues/1635",
		IssueTitle:  "Codex ingestion",
		IssueBody:   "Persist codex tasks",
		Sender:      "codex-bot",
		IssuedAt:    timestamppb.New(issuedAt),
		DeliveryId:  "delivery-xyz",
	})
	require.NoError(t, err)

	assert.Equal(t, "idea-ingest", ideaID)
	assert.Equal(t, "task-ingest", taskID)
	assert.Equal(t, "run-ingest", runID)
	require.NoError(t, mock.ExpectationsWereMet())
}

func TestIngestCodexTaskRejectsNilPayload(t *testing.T) {
	store := knowledge.NewStore(nil)

	_, _, _, err := store.IngestCodexTask(context.Background(), nil)
	require.Error(t, err)
	require.Contains(t, err.Error(), "payload is required")
}

func TestIngestCodexTaskRejectsMissingDeliveryID(t *testing.T) {
	store := knowledge.NewStore(nil)

	_, _, _, err := store.IngestCodexTask(context.Background(), &froussardpb.CodexTask{
		Stage:       froussardpb.CodexTaskStage_CODEX_TASK_STAGE_IMPLEMENTATION,
		Repository:  "proompteng/lab",
		IssueNumber: 1635,
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "missing delivery_id")
}

func expectTaskLifecycle(mock sqlmock.Sqlmock, ideaID, stage, taskID, runID string, queuedAt time.Time, deliveryID string, created time.Time) {
	mock.ExpectBegin()

	mock.ExpectQuery(`INSERT INTO codex_kb\.tasks`).
		WithArgs(
			ideaID,
			stage,
			"pending",
			sqlmock.AnyArg(),
			sqlmock.AnyArg(),
			sqlmock.AnyArg(),
		).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "idea_id", "stage", "state", "assignee", "sla_deadline", "metadata", "created_at", "updated_at",
		}).AddRow(
			taskID,
			ideaID,
			stage,
			"pending",
			nil,
			nil,
			[]byte(`{"stage":"`+stage+`"}`),
			created,
			created,
		))

	mock.ExpectQuery(`INSERT INTO codex_kb\.task_runs`).
		WithArgs(
			taskID,
			sqlmock.AnyArg(),
			"delivered",
			queuedAt,
			sqlmock.AnyArg(),
			sqlmock.AnyArg(),
			sqlmock.AnyArg(),
			sqlmock.AnyArg(),
			0,
			sqlmock.AnyArg(),
			sqlmock.AnyArg(),
			deliveryID,
		).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "task_id", "external_run_id", "status", "queued_at", "started_at", "completed_at",
			"input_ref", "output_ref", "retry_count", "error_code", "metadata", "created_at", "updated_at", "delivery_id",
		}).AddRow(
			runID,
			taskID,
			nil,
			"delivered",
			queuedAt,
			nil,
			nil,
			nil,
			nil,
			0,
			nil,
			[]byte(`{"delivery_id":"`+deliveryID+`"}`),
			created,
			created,
			deliveryID,
		))

	mock.ExpectCommit()
}

type jsonContains string

func (m jsonContains) Match(v driver.Value) bool {
	b, ok := v.([]byte)
	if !ok {
		return false
	}
	return bytes.Contains(b, []byte(m))
}
