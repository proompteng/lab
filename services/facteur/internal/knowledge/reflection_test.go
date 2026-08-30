package knowledge

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"regexp"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/pgvector/pgvector-go"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/metric/noop"
	"go.opentelemetry.io/otel/trace"
)

func resetTelemetry(t *testing.T) {
	t.Helper()

	tracerProvider := otel.GetTracerProvider()
	meterProvider := otel.GetMeterProvider()

	otel.SetTracerProvider(trace.NewNoopTracerProvider())
	otel.SetMeterProvider(noop.NewMeterProvider())

	t.Cleanup(func() {
		otel.SetTracerProvider(tracerProvider)
		otel.SetMeterProvider(meterProvider)
	})
}

func TestSaveReflectionInsert(t *testing.T) {
	resetTelemetry(t)

	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, mock.ExpectationsWereMet()) })
	t.Cleanup(func() { db.Close() })

	store := &Store{db: db}

	embedding := make([]float32, reflectionEmbeddingDimensions)
	for i := range embedding {
		embedding[i] = float32(i) / 10
	}

	metadata := json.RawMessage(`{"score":1}`)

	now := time.Unix(1730318400, 0).UTC()
	mock.ExpectQuery(regexp.QuoteMeta(`
        INSERT INTO codex_kb.reflections (
            task_run_id,
            author,
            reflection_type,
            content,
            embedding,
            embedding_version,
            metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (task_run_id, reflection_type) DO UPDATE
        SET author = EXCLUDED.author,
            content = EXCLUDED.content,
            embedding = EXCLUDED.embedding,
            embedding_version = EXCLUDED.embedding_version,
            metadata = EXCLUDED.metadata,
            updated_at = now()
        RETURNING id, created_at, updated_at
    `)).
		WithArgs(
			"run-1",
			sql.NullString{String: "codex", Valid: true},
			"postmortem",
			"We learned to batch API calls",
			sqlmock.AnyArg(),
			sql.NullString{String: "v1", Valid: true},
			string(metadata),
		).
		WillReturnRows(sqlmock.NewRows([]string{"id", "created_at", "updated_at"}).AddRow("ref-1", now, now))

	rec := ReflectionRecord{
		TaskRunID:        "run-1",
		Author:           "codex",
		Type:             "postmortem",
		Content:          "We learned to batch API calls",
		Embedding:        embedding,
		EmbeddingVersion: "v1",
		Metadata:         metadata,
	}

	err = store.SaveReflection(context.Background(), rec)
	require.NoError(t, err)
}

func TestSaveReflectionUpsertWithNilEmbedding(t *testing.T) {
	resetTelemetry(t)

	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, mock.ExpectationsWereMet()) })
	t.Cleanup(func() { db.Close() })

	store := &Store{db: db}

	now := time.Unix(1730318400, 0).UTC()

	mock.ExpectQuery(regexp.QuoteMeta(`
        INSERT INTO codex_kb.reflections (
            task_run_id,
            author,
            reflection_type,
            content,
            embedding,
            embedding_version,
            metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (task_run_id, reflection_type) DO UPDATE
        SET author = EXCLUDED.author,
            content = EXCLUDED.content,
            embedding = EXCLUDED.embedding,
            embedding_version = EXCLUDED.embedding_version,
            metadata = EXCLUDED.metadata,
            updated_at = now()
        RETURNING id, created_at, updated_at
    `)).
		WithArgs(
			"run-2",
			sql.NullString{},
			"retro",
			"Cache writes need retries",
			nil,
			sql.NullString{},
			"{}",
		).
		WillReturnRows(sqlmock.NewRows([]string{"id", "created_at", "updated_at"}).AddRow("ref-2", now, now))

	rec := ReflectionRecord{
		TaskRunID: "run-2",
		Type:      "retro",
		Content:   "Cache writes need retries",
	}

	err = store.SaveReflection(context.Background(), rec)
	require.NoError(t, err)
}

func TestSaveReflectionRejectsBadEmbedding(t *testing.T) {
	resetTelemetry(t)

	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, mock.ExpectationsWereMet()) })
	t.Cleanup(func() { db.Close() })

	store := &Store{db: db}

	rec := ReflectionRecord{
		TaskRunID: "run-3",
		Type:      "postmortem",
		Content:   "Too short embedding",
		Embedding: []float32{0.1, 0.2},
	}

	err = store.SaveReflection(context.Background(), rec)
	require.ErrorIs(t, err, errMismatchedEmbeddingLen)
}

func TestFetchTopReflectionsWithFilters(t *testing.T) {
	resetTelemetry(t)

	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, mock.ExpectationsWereMet()) })
	t.Cleanup(func() { db.Close() })

	store := &Store{db: db}

	embedding := make([]float32, reflectionEmbeddingDimensions)
	for i := range embedding {
		embedding[i] = float32(i) / 100
	}

	probe := 8

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("SET LOCAL ivfflat.probes = $1")).
		WithArgs(probe).
		WillReturnResult(sqlmock.NewResult(0, 0))

	expectedSQL := regexp.QuoteMeta(`SELECT id, task_run_id, author, reflection_type, content, embedding, embedding_version, metadata, created_at, updated_at
FROM codex_kb.reflections
WHERE embedding IS NOT NULL AND reflection_type IN ($2) AND task_run_id NOT IN ($3) AND id NOT IN ($4)
ORDER BY embedding <-> $1, updated_at DESC
LIMIT $5`)

	returnedEmbedding := make([]float32, reflectionEmbeddingDimensions)
	for i := range returnedEmbedding {
		returnedEmbedding[i] = float32(i) / 200
	}

	createdAt := time.Unix(1730317400, 0).UTC()
	updatedAt := time.Unix(1730318400, 0).UTC()

	mock.ExpectQuery(expectedSQL).
		WithArgs(
			sqlmock.AnyArg(),
			"postmortem",
			"run-9",
			"ref-7",
			3,
		).
		WillReturnRows(sqlmock.NewRows([]string{
			"id",
			"task_run_id",
			"author",
			"reflection_type",
			"content",
			"embedding",
			"embedding_version",
			"metadata",
			"created_at",
			"updated_at",
		}).AddRow(
			"ref-3",
			"run-1",
			"codex",
			"postmortem",
			"Ship staged configs before production",
			pgvector.NewVector(returnedEmbedding),
			"v2",
			[]byte(`{"impact":"high"}`),
			createdAt,
			updatedAt,
		))

	mock.ExpectCommit()

	res, err := store.FetchTopReflections(context.Background(), ReflectionQuery{
		Embedding:            embedding,
		Limit:                3,
		Types:                []string{"postmortem"},
		ExcludeTaskRunIDs:    []string{"run-9"},
		ExcludeReflectionIDs: []string{"ref-7"},
		Probes:               &probe,
	})
	require.NoError(t, err)
	require.Len(t, res, 1)

	got := res[0]
	require.Equal(t, "ref-3", got.ID)
	require.Equal(t, "run-1", got.TaskRunID)
	require.Equal(t, "codex", got.Author)
	require.Equal(t, "postmortem", got.Type)
	require.Equal(t, "Ship staged configs before production", got.Content)
	require.Equal(t, "v2", got.EmbeddingVersion)
	require.Equal(t, createdAt, got.CreatedAt)
	require.Equal(t, updatedAt, got.UpdatedAt)
	require.JSONEq(t, `{"impact":"high"}`, string(got.Metadata))
	require.Len(t, got.Embedding, reflectionEmbeddingDimensions)
	require.Equal(t, returnedEmbedding[:5], got.Embedding[:5])
}

func TestFetchTopReflectionsNoEmbedding(t *testing.T) {
	resetTelemetry(t)

	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, mock.ExpectationsWereMet()) })
	t.Cleanup(func() { db.Close() })

	store := &Store{db: db}

	res, err := store.FetchTopReflections(context.Background(), ReflectionQuery{})
	require.NoError(t, err)
	require.Empty(t, res)
}

func TestFetchTopReflectionsQueryError(t *testing.T) {
	resetTelemetry(t)

	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, mock.ExpectationsWereMet()) })
	t.Cleanup(func() { db.Close() })

	store := &Store{db: db}

	embedding := make([]float32, reflectionEmbeddingDimensions)
	for i := range embedding {
		embedding[i] = float32(i)
	}

	mock.ExpectBegin()
	expectedSQL := regexp.QuoteMeta(`SELECT id, task_run_id, author, reflection_type, content, embedding, embedding_version, metadata, created_at, updated_at
FROM codex_kb.reflections
WHERE embedding IS NOT NULL
ORDER BY embedding <-> $1, updated_at DESC
LIMIT $2`)
	mock.ExpectQuery(expectedSQL).
		WithArgs(sqlmock.AnyArg(), 5).
		WillReturnError(errQueryFailed)
	mock.ExpectRollback()

	_, err = store.FetchTopReflections(context.Background(), ReflectionQuery{
		Embedding: embedding,
		Limit:     5,
	})
	require.Error(t, err)
}

var errQueryFailed = errors.New("query failed")
