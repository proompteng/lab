package bridge_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/proompteng/lab/services/facteur/internal/agents"
	"github.com/proompteng/lab/services/facteur/internal/bridge"
)

func TestAgentRunDispatcherDispatch(t *testing.T) {
	ctx := context.Background()
	submitter := &fakeSubmitter{
		result: agents.SubmitAgentRunResult{
			Namespace:    "agents",
			AgentRunName: "codex-agent-123",
			SubmittedAt:  time.Unix(1735602000, 0),
		},
	}

	dispatcher, err := bridge.NewDispatcher(submitter, nil, bridge.ServiceConfig{
		Namespace:     "agents",
		AgentName:     "codex-agent",
		RuntimeType:   "job",
		RuntimeConfig: map[string]any{"serviceAccountName": "agents-sa"},
		Parameters:    map[string]string{"environment": "prod"},
		Secrets:       []string{"github-token"},
	})
	require.NoError(t, err)

	result, err := dispatcher.Dispatch(ctx, bridge.DispatchRequest{
		Command:       "plan",
		UserID:        "user-123",
		CorrelationID: "corr-123",
		TraceID:       "trace-456",
		Options:       map[string]string{"payload": `{"prompt":"Generate plan","repository":"proompteng/lab","issueNumber":7152}`},
	})
	require.NoError(t, err)
	require.Equal(t, "codex-agent-123", result.AgentRunName)
	require.Equal(t, "codex-agent-123", result.WorkflowName)
	require.Equal(t, "corr-123", result.CorrelationID)
	require.Equal(t, "trace-456", result.TraceID)
	require.Contains(t, result.Message, "AgentRun `codex-agent-123`")

	require.True(t, submitter.called)
	require.Equal(t, "agents", submitter.lastInput.Namespace)
	require.Equal(t, "codex-agent", submitter.lastInput.AgentName)
	require.Equal(t, "corr-123", submitter.lastInput.DeliveryID)
	require.Equal(t, "Generate plan", submitter.lastInput.GoalObjective)
	require.Equal(t, "job", submitter.lastInput.RuntimeType)
	require.Equal(t, map[string]any{"serviceAccountName": "agents-sa"}, submitter.lastInput.RuntimeConfig)
	require.Equal(t, []string{"github-token"}, submitter.lastInput.Secrets)
	require.Equal(t, "Generate plan", submitter.lastInput.Implementation["text"])
	require.Equal(t, "prod", submitter.lastInput.Parameters["environment"])
	require.Equal(t, "plan", submitter.lastInput.Parameters["command"])
	require.Equal(t, "user-123", submitter.lastInput.Parameters["discordUserId"])
	require.Equal(t, "implementation", submitter.lastInput.Parameters["stage"])
	require.Equal(t, "proompteng/lab", submitter.lastInput.Parameters["repository"])
	require.Equal(t, "7152", submitter.lastInput.Parameters["issueNumber"])
}

func TestAgentRunDispatcherUsesPayloadDeliveryID(t *testing.T) {
	submitter := &fakeSubmitter{result: agents.SubmitAgentRunResult{Namespace: "agents", AgentRunName: "codex-agent-456"}}
	dispatcher, err := bridge.NewDispatcher(submitter, nil, bridge.ServiceConfig{
		Namespace:   "agents",
		AgentName:   "codex-agent",
		RuntimeType: "job",
	})
	require.NoError(t, err)

	result, err := dispatcher.Dispatch(context.Background(), bridge.DispatchRequest{
		Command: "plan",
		Options: map[string]string{"payload": `{"prompt":"Generate plan","deliveryId":"delivery-abc","stage":"review"}`},
	})
	require.NoError(t, err)
	require.Equal(t, "delivery-abc", result.CorrelationID)
	require.Equal(t, "delivery-abc", submitter.lastInput.DeliveryID)
	require.Equal(t, "review", submitter.lastInput.Parameters["stage"])
}

func TestAgentRunDispatcherStatus(t *testing.T) {
	checker := &fakeReadyChecker{status: agents.ReadyStatus{Ready: true, Message: "Agents ready"}}
	dispatcher, err := bridge.NewDispatcher(&fakeSubmitter{}, checker, bridge.ServiceConfig{
		Namespace:   "agents",
		AgentName:   "codex-agent",
		RuntimeType: "job",
	})
	require.NoError(t, err)

	status, err := dispatcher.Status(context.Background())
	require.NoError(t, err)
	require.True(t, checker.called)
	require.True(t, status.Ready)
	require.Equal(t, "codex-agent", status.AgentName)
	require.Contains(t, status.Message, "Agents ready")
}

func TestAgentRunDispatcherErrors(t *testing.T) {
	_, err := bridge.NewDispatcher(nil, nil, bridge.ServiceConfig{})
	require.Error(t, err)

	dispatcher, err := bridge.NewDispatcher(&fakeSubmitter{}, &fakeReadyChecker{err: errors.New("not ready")}, bridge.ServiceConfig{
		Namespace:   "agents",
		AgentName:   "codex-agent",
		RuntimeType: "job",
	})
	require.NoError(t, err)

	_, err = dispatcher.Status(context.Background())
	require.Error(t, err)

	dispatcher, err = bridge.NewDispatcher(&fakeSubmitter{err: errors.New("submit failed")}, nil, bridge.ServiceConfig{
		Namespace:   "agents",
		AgentName:   "codex-agent",
		RuntimeType: "job",
	})
	require.NoError(t, err)

	_, err = dispatcher.Dispatch(context.Background(), bridge.DispatchRequest{
		Options: map[string]string{"payload": `{"prompt":"Generate"}`},
	})
	require.Error(t, err)

	_, err = dispatcher.Dispatch(context.Background(), bridge.DispatchRequest{
		Options: map[string]string{"payload": `{"prompt":`},
	})
	require.Error(t, err)

	_, err = dispatcher.Dispatch(context.Background(), bridge.DispatchRequest{})
	require.Error(t, err)
}

type fakeSubmitter struct {
	called    bool
	lastInput agents.SubmitAgentRunInput
	result    agents.SubmitAgentRunResult
	err       error
}

func (f *fakeSubmitter) SubmitAgentRun(_ context.Context, input agents.SubmitAgentRunInput) (agents.SubmitAgentRunResult, error) {
	f.called = true
	f.lastInput = input
	if f.err != nil {
		return agents.SubmitAgentRunResult{}, f.err
	}
	return f.result, nil
}

type fakeReadyChecker struct {
	called bool
	status agents.ReadyStatus
	err    error
}

func (f *fakeReadyChecker) CheckReady(context.Context) (agents.ReadyStatus, error) {
	f.called = true
	if f.err != nil {
		return agents.ReadyStatus{}, f.err
	}
	return f.status, nil
}
