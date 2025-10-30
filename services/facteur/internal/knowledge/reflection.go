package knowledge

import (
	"context"
	"errors"
)

// ReflectionRecord represents a stored agent reflection.
type ReflectionRecord struct {
	TaskRunID string
	Author    string
	Type      string
	Content   string
	Embedding []float32
	Version   string
}

// SaveReflection persists reflection content and its embedding.
func (s *Store) SaveReflection(ctx context.Context, record ReflectionRecord) error {
	// TODO(codex-autonomy-step-04): write reflection rows and maintain vector index lifecycle.
	_ = record
	return errors.New("codex-autonomy-step-04 not implemented")
}

// FetchTopReflections finds the most relevant reflections for a new run.
func (s *Store) FetchTopReflections(ctx context.Context, taskRunID string, limit int) ([]ReflectionRecord, error) {
	// TODO(codex-autonomy-step-05): query pgvector index and hydrate reflection content.
	_ = taskRunID
	_ = limit
	return nil, errors.New("codex-autonomy-step-05 not implemented")
}
