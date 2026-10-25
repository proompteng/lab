package bridge

import "context"

// NoopDispatcher is a Dispatcher that disables AgentRun submissions.
type NoopDispatcher struct{}

// Dispatch immediately returns without submitting an AgentRun.
func (NoopDispatcher) Dispatch(_ context.Context, req DispatchRequest) (DispatchResult, error) {
	return DispatchResult{
		Message:       "dispatcher disabled",
		CorrelationID: req.CorrelationID,
		TraceID:       req.TraceID,
	}, nil
}

// Status reports that the dispatcher is disabled.
func (NoopDispatcher) Status(context.Context) (StatusReport, error) {
	return StatusReport{
		Ready:   false,
		Message: "dispatcher disabled",
	}, nil
}
