package knowledge

import (
	"context"
	"errors"
)

// AnomalyRecord stores synthetic or real anomaly evaluations.
type AnomalyRecord struct {
	TaskRunID string
	Kind      string
	Payload   []byte
	Outcome   string
}

// RecordAnomalyResult logs anomaly detection rehearsal outcomes.
func (s *Store) RecordAnomalyResult(ctx context.Context, record AnomalyRecord) error {
	// TODO(codex-autonomy-step-09): persist anomaly metrics into policy checks and metrics tables.
	_ = record
	return errors.New("codex-autonomy-step-09 not implemented")
}
