package knowledge

import (
	"context"
	"errors"
)

// EmbeddingRefresh encapsulates REFINE configuration and rollout metadata.
type EmbeddingRefresh struct {
	Version     string
	Notes       string
	TriggeredBy string
}

// ScheduleEmbeddingRefresh prepares REFINE runs and index rebuilds.
func (s *Store) ScheduleEmbeddingRefresh(ctx context.Context, refresh EmbeddingRefresh) error {
	// TODO(codex-autonomy-step-08): coordinate REFINE embedding refresh and index rotation.
	_ = refresh
	return errors.New("codex-autonomy-step-08 not implemented")
}
