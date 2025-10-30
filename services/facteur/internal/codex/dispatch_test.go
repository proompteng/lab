package codex_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/proompteng/lab/services/facteur/internal/bridge"
	"github.com/proompteng/lab/services/facteur/internal/codex"
	"github.com/proompteng/lab/services/facteur/internal/githubpb"
)

type recordingDispatcher struct {
	requests []bridge.DispatchRequest
}

func (r *recordingDispatcher) Dispatch(_ context.Context, req bridge.DispatchRequest) (bridge.DispatchResult, error) {
	r.requests = append(r.requests, req)
	return bridge.DispatchResult{Namespace: "argo", WorkflowName: "facteur-dispatch", CorrelationID: req.CorrelationID}, nil
}

func (r *recordingDispatcher) Status(context.Context) (bridge.StatusReport, error) {
	return bridge.StatusReport{}, nil
}

func TestDispatchPlanningBuildsPayload(t *testing.T) {
	dispatcher := &recordingDispatcher{}
	task := &githubpb.CodexTask{
		Stage:       githubpb.CodexTaskStage_CODEX_TASK_STAGE_PLANNING,
		Prompt:      "Generate rollout plan",
		Repository:  "proompteng/lab",
		IssueNumber: 1638,
		IssueTitle:  "Codex: plan planning-dispatch rollout",
		DeliveryId:  "delivery-1638",
	}

	result, err := codex.DispatchPlanning(context.Background(), dispatcher, task, map[string]string{"postToGithub": "true"})
	require.NoError(t, err)
	require.Equal(t, "facteur-dispatch", result.WorkflowName)
	require.Len(t, dispatcher.requests, 1)

	req := dispatcher.requests[0]
	require.Equal(t, "codex-planning", req.Command)
	require.Equal(t, "delivery-1638", req.CorrelationID)

	var payload map[string]any
	require.NoError(t, json.Unmarshal([]byte(req.Options["payload"]), &payload))
	require.Equal(t, "planning", payload["stage"])
	require.Equal(t, "Generate rollout plan", payload["prompt"])
	require.EqualValues(t, 1638, payload["issueNumber"])
	require.Equal(t, true, payload["postToGithub"])
}

func TestDispatchPlanningRequiresPrompt(t *testing.T) {
	dispatcher := &recordingDispatcher{}
	task := &githubpb.CodexTask{Stage: githubpb.CodexTaskStage_CODEX_TASK_STAGE_PLANNING}

	_, err := codex.DispatchPlanning(context.Background(), dispatcher, task, nil)
	require.Error(t, err)
	require.Contains(t, err.Error(), "planning prompt is required")
}

func TestDispatchPlanningRejectsNonPlanningStage(t *testing.T) {
	dispatcher := &recordingDispatcher{}
	task := &githubpb.CodexTask{Stage: githubpb.CodexTaskStage_CODEX_TASK_STAGE_IMPLEMENTATION, Prompt: "hi"}

	_, err := codex.DispatchPlanning(context.Background(), dispatcher, task, nil)
	require.Error(t, err)
	require.Contains(t, err.Error(), "not supported")
}
