package knowledge

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/pgvector/pgvector-go"
	"github.com/proompteng/lab/services/facteur/internal/telemetry"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

const (
	reflectionEmbeddingDimensions = 1536
	defaultReflectionFetchLimit   = 5
)

var (
	errMissingTaskRunID       = errors.New("knowledge: task_run_id is required")
	errMissingReflectionType  = errors.New("knowledge: reflection type is required")
	errMissingReflectionBody  = errors.New("knowledge: reflection content is required")
	errMismatchedEmbeddingLen = fmt.Errorf(
		"knowledge: reflection embedding must contain %d dimensions",
		reflectionEmbeddingDimensions,
	)
)

// ReflectionRecord represents a stored agent reflection.
type ReflectionRecord struct {
	ID               string
	TaskRunID        string
	Author           string
	Type             string
	Content          string
	Embedding        []float32
	EmbeddingVersion string
	Metadata         json.RawMessage
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// ReflectionQuery expresses optional filters applied during retrieval.
type ReflectionQuery struct {
	Embedding            []float32
	Limit                int
	Types                []string
	ExcludeTaskRunIDs    []string
	ExcludeReflectionIDs []string
	Probes               *int
}

// SaveReflection persists reflection content and its embedding.
func (s *Store) SaveReflection(ctx context.Context, record ReflectionRecord) error {
	ctx, span := telemetry.Tracer().Start(ctx, "knowledge.save_reflection", trace.WithSpanKind(trace.SpanKindInternal))
	defer span.End()

	span.SetAttributes(
		attribute.String("task_run_id", record.TaskRunID),
		attribute.String("reflection_type", record.Type),
	)

	if record.TaskRunID == "" {
		span.RecordError(errMissingTaskRunID)
		span.SetStatus(codes.Error, errMissingTaskRunID.Error())
		return errMissingTaskRunID
	}
	if record.Type == "" {
		span.RecordError(errMissingReflectionType)
		span.SetStatus(codes.Error, errMissingReflectionType.Error())
		return errMissingReflectionType
	}
	if strings.TrimSpace(record.Content) == "" {
		span.RecordError(errMissingReflectionBody)
		span.SetStatus(codes.Error, errMissingReflectionBody.Error())
		return errMissingReflectionBody
	}

	var vectorArg any
	if len(record.Embedding) > 0 {
		if len(record.Embedding) != reflectionEmbeddingDimensions {
			span.RecordError(errMismatchedEmbeddingLen)
			span.SetStatus(codes.Error, errMismatchedEmbeddingLen.Error())
			return errMismatchedEmbeddingLen
		}
		vectorArg = pgvector.NewVector(record.Embedding)
	}

	metadata := record.Metadata
	if len(metadata) == 0 {
		metadata = json.RawMessage("{}")
	} else if !json.Valid(metadata) {
		err := errors.New("knowledge: reflection metadata must be valid JSON")
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return err
	}

	author := sql.NullString{}
	if strings.TrimSpace(record.Author) != "" {
		author = sql.NullString{String: record.Author, Valid: true}
	}

	version := sql.NullString{}
	if strings.TrimSpace(record.EmbeddingVersion) != "" {
		version = sql.NullString{String: record.EmbeddingVersion, Valid: true}
	}

	const stmt = `
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
    `

	var (
		reflectionID string
		createdAt    time.Time
		updatedAt    time.Time
	)

	err := s.db.QueryRowContext(
		ctx,
		stmt,
		record.TaskRunID,
		author,
		record.Type,
		record.Content,
		vectorArg,
		version,
		string(metadata),
	).Scan(&reflectionID, &createdAt, &updatedAt)
	if err != nil {
		wrapped := fmt.Errorf("knowledge: save reflection: %w", err)
		span.RecordError(wrapped)
		span.SetStatus(codes.Error, wrapped.Error())
		return wrapped
	}

	span.SetAttributes(attribute.String("reflection_id", reflectionID))
	span.SetStatus(codes.Ok, "stored")

	recordReflectionSaved(ctx, record.Type)
	slog.InfoContext(
		ctx,
		"knowledge: saved reflection",
		"task_run_id", record.TaskRunID,
		"reflection_type", record.Type,
		"reflection_id", reflectionID,
	)

	return nil
}

// FetchTopReflections finds the most relevant reflections for a new run.
func (s *Store) FetchTopReflections(ctx context.Context, query ReflectionQuery) ([]ReflectionRecord, error) {
	ctx, span := telemetry.Tracer().Start(ctx, "knowledge.fetch_reflections", trace.WithSpanKind(trace.SpanKindInternal))
	defer span.End()

	limit := query.Limit
	if limit <= 0 {
		limit = defaultReflectionFetchLimit
	}
	span.SetAttributes(
		attribute.Int("limit", limit),
		attribute.Int("type_filters", len(query.Types)),
		attribute.Int("exclude_task_runs", len(query.ExcludeTaskRunIDs)),
		attribute.Int("exclude_reflections", len(query.ExcludeReflectionIDs)),
	)

	if len(query.Embedding) == 0 {
		slog.InfoContext(ctx, "knowledge: fetch reflections skipped; no embedding supplied")
		span.SetStatus(codes.Ok, "no embedding provided")
		return nil, nil
	}

	if len(query.Embedding) != reflectionEmbeddingDimensions {
		span.RecordError(errMismatchedEmbeddingLen)
		span.SetStatus(codes.Error, errMismatchedEmbeddingLen.Error())
		return nil, errMismatchedEmbeddingLen
	}

	vec := pgvector.NewVector(query.Embedding)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		wrapped := fmt.Errorf("knowledge: begin reflection fetch tx: %w", err)
		span.RecordError(wrapped)
		span.SetStatus(codes.Error, wrapped.Error())
		return nil, wrapped
	}
	defer func() {
		if rollbackErr := tx.Rollback(); rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
			slog.WarnContext(ctx, "knowledge: rollback fetch reflections", "error", rollbackErr)
		}
	}()

	if query.Probes != nil && *query.Probes > 0 {
		if _, err := tx.ExecContext(ctx, "SET LOCAL ivfflat.probes = $1", *query.Probes); err != nil {
			wrapped := fmt.Errorf("knowledge: set ivfflat probes: %w", err)
			span.RecordError(wrapped)
			span.SetStatus(codes.Error, wrapped.Error())
			return nil, wrapped
		}
		span.SetAttributes(attribute.Int("ivfflat.probes", *query.Probes))
	}

	var (
		builder      strings.Builder
		conditions   []string
		args         []any
		placeholderN = 1
	)

	builder.WriteString(`SELECT id, task_run_id, author, reflection_type, content, embedding, embedding_version, metadata, created_at, updated_at
FROM codex_kb.reflections
`)

	conditions = append(conditions, "embedding IS NOT NULL")

	args = append(args, vec)

	if len(query.Types) > 0 {
		placeholders := make([]string, len(query.Types))
		for i, typ := range query.Types {
			placeholderN++
			placeholders[i] = fmt.Sprintf("$%d", placeholderN)
			args = append(args, typ)
		}
		conditions = append(conditions, fmt.Sprintf("reflection_type IN (%s)", strings.Join(placeholders, ", ")))
	}

	if len(query.ExcludeTaskRunIDs) > 0 {
		placeholders := make([]string, len(query.ExcludeTaskRunIDs))
		for i, id := range query.ExcludeTaskRunIDs {
			placeholderN++
			placeholders[i] = fmt.Sprintf("$%d", placeholderN)
			args = append(args, id)
		}
		conditions = append(conditions, fmt.Sprintf("task_run_id NOT IN (%s)", strings.Join(placeholders, ", ")))
	}

	if len(query.ExcludeReflectionIDs) > 0 {
		placeholders := make([]string, len(query.ExcludeReflectionIDs))
		for i, id := range query.ExcludeReflectionIDs {
			placeholderN++
			placeholders[i] = fmt.Sprintf("$%d", placeholderN)
			args = append(args, id)
		}
		conditions = append(conditions, fmt.Sprintf("id NOT IN (%s)", strings.Join(placeholders, ", ")))
	}

	if len(conditions) > 0 {
		builder.WriteString("WHERE ")
		builder.WriteString(strings.Join(conditions, " AND "))
		builder.WriteByte('\n')
	}

	builder.WriteString("ORDER BY embedding <-> $1, updated_at DESC\n")
	placeholderN++
	builder.WriteString(fmt.Sprintf("LIMIT $%d", placeholderN))

	args = append(args, limit)

	rows, err := tx.QueryContext(ctx, builder.String(), args...)
	if err != nil {
		wrapped := fmt.Errorf("knowledge: fetch reflections query: %w", err)
		span.RecordError(wrapped)
		span.SetStatus(codes.Error, wrapped.Error())
		return nil, wrapped
	}
	defer rows.Close()

	var results []ReflectionRecord

	for rows.Next() {
		var (
			rec      ReflectionRecord
			author   sql.NullString
			version  sql.NullString
			metadata []byte
			vector   pgvector.Vector
		)

		scanErr := rows.Scan(
			&rec.ID,
			&rec.TaskRunID,
			&author,
			&rec.Type,
			&rec.Content,
			&vector,
			&version,
			&metadata,
			&rec.CreatedAt,
			&rec.UpdatedAt,
		)
		if scanErr != nil {
			wrapped := fmt.Errorf("knowledge: scan reflection: %w", scanErr)
			span.RecordError(wrapped)
			span.SetStatus(codes.Error, wrapped.Error())
			return nil, wrapped
		}

		if author.Valid {
			rec.Author = author.String
		}
		if version.Valid {
			rec.EmbeddingVersion = version.String
		}
		if len(metadata) == 0 {
			rec.Metadata = json.RawMessage("{}")
		} else {
			rec.Metadata = json.RawMessage(append([]byte(nil), metadata...))
		}
		rec.Embedding = append([]float32(nil), vector.Slice()...)

		results = append(results, rec)
	}

	if err := rows.Err(); err != nil {
		wrapped := fmt.Errorf("knowledge: iterate reflections: %w", err)
		span.RecordError(wrapped)
		span.SetStatus(codes.Error, wrapped.Error())
		return nil, wrapped
	}

	if err := tx.Commit(); err != nil {
		wrapped := fmt.Errorf("knowledge: commit reflection fetch tx: %w", err)
		span.RecordError(wrapped)
		span.SetStatus(codes.Error, wrapped.Error())
		return nil, wrapped
	}

	span.SetStatus(codes.Ok, "fetched")
	span.SetAttributes(attribute.Int("result_count", len(results)))

	recordReflectionsRetrieved(ctx, len(results))
	slog.InfoContext(
		ctx,
		"knowledge: fetched reflections",
		"result_count", len(results),
		"limit", limit,
	)

	return results, nil
}
