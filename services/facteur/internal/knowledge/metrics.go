package knowledge

import (
	"context"
	"errors"
)

// MetricsSnapshot bundles run-level SLO and observability data.
type MetricsSnapshot struct {
	TaskRunID     string
	QueueLatency  int64
	Runtime       int64
	RetryLatency  int64
	ResourceUsage []byte
}

// PublishRunMetrics records metrics for dashboards and alerting.
func (s *Store) PublishRunMetrics(ctx context.Context, snapshot MetricsSnapshot) error {
	// TODO(codex-autonomy-step-10): persist run metrics and forward to observability sinks.
	_ = snapshot
	return errors.New("codex-autonomy-step-10 not implemented")
}

// PromotionDecision captures whether new models satisfy guardrails.
type PromotionDecision struct {
	CandidateVersion  string
	FaithfulnessDelta float64
	RetrievalGain     float64
	Approved          bool
}

// RecordPromotionGate enforces promotion gates before rollout.
func (s *Store) RecordPromotionGate(ctx context.Context, decision PromotionDecision) error {
	// TODO(codex-autonomy-step-11): track model promotion gates and audit outcomes before deployment.
	_ = decision
	return errors.New("codex-autonomy-step-11 not implemented")
}
