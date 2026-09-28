package knowledge

import (
	"context"
	"errors"
)

// RouterFeedback encapsulates routing telemetry.
type RouterFeedback struct {
	TaskRunID     string
	Strategy      string
	RetrievalUsed bool
	Notes         string
}

// RecordRouterDecision logs retrieval/router outcomes for later analysis.
func (s *Store) RecordRouterDecision(ctx context.Context, feedback RouterFeedback) error {
	// TODO(codex-autonomy-step-06): persist router decisions into policy_checks and run_events.
	_ = feedback
	return errors.New("codex-autonomy-step-06 not implemented")
}

// SSFOPair represents inputs required for self-supervised faithfulness optimisation.
type SSFOPair struct {
	TaskRunID          string
	RetrievedAnswer    string
	NonRetrievedAnswer string
	PromptContext      string
}

// QueueSSFOPair stores material needed for nightly SSFO optimisation runs.
func (s *Store) QueueSSFOPair(ctx context.Context, pair SSFOPair) error {
	// TODO(codex-autonomy-step-07): persist SSFO preference pairs and trigger downstream jobs.
	_ = pair
	return errors.New("codex-autonomy-step-07 not implemented")
}
