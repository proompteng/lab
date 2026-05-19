package orchestrator

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/proompteng/lab/services/facteur/internal/agents"
	"github.com/proompteng/lab/services/facteur/internal/froussardpb"
	"github.com/proompteng/lab/services/facteur/internal/knowledge"
)

type storeResponse struct {
	upsertErr    error
	lifecycleErr error
}

type fakeStore struct {
	responses      []storeResponse
	ideaCalls      int
	lifecycleCalls int
	lastIdea       knowledge.IdeaRecord
	lastTask       knowledge.TaskRecord
	lastRun        knowledge.TaskRunRecord
}

func (s *fakeStore) nextResponse() storeResponse {
	if len(s.responses) == 0 {
		return storeResponse{}
	}
	resp := s.responses[0]
	s.responses = s.responses[1:]
	return resp
}

func (s *fakeStore) UpsertIdea(_ context.Context, record knowledge.IdeaRecord) (string, error) {
	s.ideaCalls++
	s.lastIdea = record
	resp := s.nextResponse()
	if resp.upsertErr != nil {
		return "", resp.upsertErr
	}
	return "idea-1", nil
}

func (s *fakeStore) RecordTaskLifecycle(
	_ context.Context,
	task knowledge.TaskRecord,
	run knowledge.TaskRunRecord,
) (knowledge.TaskRecord, knowledge.TaskRunRecord, error) {
	s.lifecycleCalls++
	s.lastTask = task
	s.lastRun = run
	resp := s.nextResponse()
	if resp.lifecycleErr != nil {
		return knowledge.TaskRecord{}, knowledge.TaskRunRecord{}, resp.lifecycleErr
	}
	return task, run, nil
}

type submitterResponse struct {
	result agents.SubmitAgentRunResult
	err    error
}

type fakeSubmitter struct {
	responses []submitterResponse
	calls     int
	inputs    []agents.SubmitAgentRunInput
	index     int
}

func (s *fakeSubmitter) SubmitAgentRun(_ context.Context, input agents.SubmitAgentRunInput) (agents.SubmitAgentRunResult, error) {
	s.calls++
	s.inputs = append(s.inputs, input)
	if s.index >= len(s.responses) {
		return agents.SubmitAgentRunResult{}, nil
	}
	resp := s.responses[s.index]
	s.index++
	return resp.result, resp.err
}

func TestImplementer_Success(t *testing.T) {
	store := &fakeStore{}
	submitter := &fakeSubmitter{
		responses: []submitterResponse{
			{
				result: agents.SubmitAgentRunResult{
					Namespace:    "agents",
					AgentRunName: "codex-agent-123",
					SubmittedAt:  time.Unix(1735601000, 0),
				},
			},
		},
	}

	implementerInstance, err := NewImplementer(store, submitter, Config{
		Namespace:               "agents",
		AgentName:               "codex-agent",
		RuntimeType:             "job",
		RuntimeConfig:           map[string]any{"serviceAccount": "agents-runner"},
		Parameters:              map[string]string{"environment": "staging"},
		Secrets:                 []string{"github-token", "codex-auth"},
		SecretBindingRef:        "codex-github-token",
		VCSProvider:             "github",
		VCSPolicyMode:           "read-write",
		VCSRequired:             true,
		GoalTokenBudget:         4096,
		TTLSecondsAfterFinished: 86400,
	})
	require.NoError(t, err)

	i := implementerInstance.(*implementer)
	fixed := time.Unix(1735600999, 0).UTC()
	i.now = func() time.Time { return fixed }

	task := &froussardpb.CodexTask{
		Stage:       froussardpb.CodexTaskStage_CODEX_TASK_STAGE_IMPLEMENTATION,
		Prompt:      "Implement work",
		Repository:  "proompteng/lab",
		Head:        "codex/issue-1966-demo",
		IssueNumber: 1966,
		IssueTitle:  "Implement changes",
		IssueUrl:    "https://github.com/proompteng/lab/issues/1966",
		IssueBody:   "Detailed issue body.",
		Sender:      "gregkonush",
		DeliveryId:  "delivery-impl",
	}

	result, err := implementerInstance.Implement(context.Background(), task)
	require.NoError(t, err)
	require.False(t, result.Duplicate)
	require.Equal(t, "codex-agent-123", result.AgentRunName)
	require.Equal(t, "agents", result.Namespace)
	require.Equal(t, submitter.responses[0].result.SubmittedAt, result.SubmittedAt)

	require.Equal(t, 1, store.ideaCalls)
	require.Equal(t, 1, store.lifecycleCalls)
	require.Equal(t, fixed, store.lastIdea.CreatedAt)
	require.Equal(t, "github_issue", store.lastIdea.SourceType)
	require.Equal(t, "proompteng/lab#1966", store.lastIdea.SourceRef)

	var taskMetadata map[string]any
	require.NoError(t, json.Unmarshal(store.lastTask.Metadata, &taskMetadata))
	require.Equal(t, "delivery-impl", taskMetadata["deliveryId"])
	require.Equal(t, implementationStageLabel, taskMetadata["stage"])
	require.Equal(t, "main", taskMetadata["base"])

	var runMetadata map[string]any
	require.NoError(t, json.Unmarshal(store.lastRun.Metadata, &runMetadata))
	require.Equal(t, "agentrun", runMetadata["target"])
	require.Equal(t, "agents", runMetadata["namespace"])
	require.Equal(t, "codex-agent", runMetadata["agentName"])

	require.Equal(t, 1, submitter.calls)
	require.Len(t, submitter.inputs, 1)
	input := submitter.inputs[0]
	require.Equal(t, "agents", input.Namespace)
	require.Equal(t, "codex-agent", input.AgentName)
	require.Equal(t, "delivery-impl", input.DeliveryID)
	require.Equal(t, "job", input.RuntimeType)
	require.Equal(t, "agents-runner", input.RuntimeConfig["serviceAccount"])
	require.Equal(t, []string{"github-token", "codex-auth"}, input.Secrets)
	require.Equal(t, "codex-github-token", input.SecretBindingRef)
	require.Equal(t, "github", input.VCSProvider)
	require.Equal(t, "read-write", input.VCSPolicyMode)
	require.True(t, input.VCSRequired)
	require.Equal(t, 4096, input.GoalTokenBudget)
	require.Equal(t, 86400, input.TTLSecondsAfterFinished)
	require.Equal(t, "staging", input.Parameters["environment"])
	require.Equal(t, "proompteng/lab", input.Parameters["repository"])
	require.Equal(t, "1966", input.Parameters["issueNumber"])
	require.Equal(t, "codex/issue-1966-demo", input.Parameters["head"])
	require.Equal(t, "main", input.Parameters["base"])
	require.Equal(t, "implementation", input.Parameters["stage"])
	require.Equal(t, "1", input.Parameters["implementation_iterations"])
	require.Equal(t, "1", input.Parameters["iteration_cycle"])
	require.NotContains(t, input.Parameters, "prompt")
	require.Equal(t, "Implement changes", input.Implementation["summary"])
	require.Equal(t, "Implement work", input.Implementation["text"])
	require.Equal(t, "Implement work", input.GoalObjective)
	require.Equal(t, "github", input.Implementation["source"].(map[string]any)["provider"])
	require.Equal(t, "proompteng/lab#1966", input.Implementation["source"].(map[string]any)["externalId"])

	var eventPayload map[string]any
	require.NoError(t, json.Unmarshal(store.lastIdea.Payload, &eventPayload))
	require.Equal(t, "implementation", eventPayload["stage"])
	require.Equal(t, "1966", eventPayload["issueNumber"])
}

func TestImplementer_UsesAgentRunDefaults(t *testing.T) {
	store := &fakeStore{}
	submitter := &fakeSubmitter{
		responses: []submitterResponse{
			{result: agents.SubmitAgentRunResult{Namespace: "agents", AgentRunName: "codex-agent-123", SubmittedAt: time.Unix(1735602000, 0)}},
		},
	}

	implementerInstance, err := NewImplementer(store, submitter, Config{})
	require.NoError(t, err)

	task := &froussardpb.CodexTask{
		Stage:       froussardpb.CodexTaskStage_CODEX_TASK_STAGE_IMPLEMENTATION,
		Repository:  "proompteng/lab",
		Head:        "codex/issue-2000-demo",
		IssueNumber: 2000,
		DeliveryId:  "delivery-defaults",
	}

	result, err := implementerInstance.Implement(context.Background(), task)
	require.NoError(t, err)
	require.False(t, result.Duplicate)

	require.Equal(t, 1, submitter.calls)
	require.Len(t, submitter.inputs, 1)
	input := submitter.inputs[0]
	require.Equal(t, "agents", input.Namespace)
	require.Equal(t, "codex-agent", input.AgentName)
	require.Equal(t, "job", input.RuntimeType)
	require.Equal(t, "codex-agent-123", result.AgentRunName)
}

func TestImplementer_DuplicateDelivery(t *testing.T) {
	store := &fakeStore{}
	submitter := &fakeSubmitter{
		responses: []submitterResponse{
			{result: agents.SubmitAgentRunResult{Namespace: "agents", AgentRunName: "codex-agent-456", SubmittedAt: time.Unix(1735601001, 0)}},
		},
	}

	implementerInstance, err := NewImplementer(store, submitter, Config{})
	require.NoError(t, err)

	i := implementerInstance.(*implementer)
	fixed := time.Unix(1735601000, 0).UTC()
	i.now = func() time.Time { return fixed }

	task := &froussardpb.CodexTask{
		Stage:       froussardpb.CodexTaskStage_CODEX_TASK_STAGE_IMPLEMENTATION,
		Repository:  "proompteng/lab",
		IssueNumber: 1636,
		DeliveryId:  "dup-impl",
	}

	first, err := implementerInstance.Implement(context.Background(), task)
	require.NoError(t, err)
	require.False(t, first.Duplicate)

	second, err := implementerInstance.Implement(context.Background(), task)
	require.NoError(t, err)
	require.True(t, second.Duplicate)
	require.Equal(t, first.AgentRunName, second.AgentRunName)
	require.Equal(t, first.Namespace, second.Namespace)
	require.Equal(t, first.SubmittedAt, second.SubmittedAt)

	require.Equal(t, 1, submitter.calls)
	require.Equal(t, 1, store.ideaCalls)
	require.Equal(t, 1, store.lifecycleCalls)
}

func TestImplementer_StoreFailure(t *testing.T) {
	store := &fakeStore{responses: []storeResponse{{upsertErr: errors.New("store fail")}}}
	submitter := &fakeSubmitter{
		responses: []submitterResponse{
			{result: agents.SubmitAgentRunResult{Namespace: "agents", AgentRunName: "codex-agent-1", SubmittedAt: time.Unix(1735601100, 0)}},
		},
	}

	implementerInstance, err := NewImplementer(store, submitter, Config{})
	require.NoError(t, err)

	i := implementerInstance.(*implementer)
	i.now = func() time.Time { return time.Unix(1735601050, 0).UTC() }

	task := &froussardpb.CodexTask{
		Stage:       froussardpb.CodexTaskStage_CODEX_TASK_STAGE_IMPLEMENTATION,
		Repository:  "proompteng/lab",
		IssueNumber: 1636,
		DeliveryId:  "store-failure",
	}

	_, err = implementerInstance.Implement(context.Background(), task)
	require.Error(t, err)
	require.Contains(t, err.Error(), "upsert idea")
	require.Equal(t, 0, submitter.calls)

	store.responses = []storeResponse{{}}
	result, err := implementerInstance.Implement(context.Background(), task)
	require.NoError(t, err)
	require.False(t, result.Duplicate)
	require.Equal(t, 1, submitter.calls)
}

func TestImplementer_SubmitterFailure(t *testing.T) {
	store := &fakeStore{}
	submitter := &fakeSubmitter{
		responses: []submitterResponse{
			{err: errors.New("agents fail")},
			{result: agents.SubmitAgentRunResult{Namespace: "agents", AgentRunName: "codex-agent-2", SubmittedAt: time.Unix(1735601200, 0)}},
		},
	}

	implementerInstance, err := NewImplementer(store, submitter, Config{})
	require.NoError(t, err)

	i := implementerInstance.(*implementer)
	i.now = func() time.Time { return time.Unix(1735601150, 0).UTC() }

	task := &froussardpb.CodexTask{
		Stage:       froussardpb.CodexTaskStage_CODEX_TASK_STAGE_IMPLEMENTATION,
		Repository:  "proompteng/lab",
		IssueNumber: 1636,
		DeliveryId:  "submitter-failure",
	}

	_, err = implementerInstance.Implement(context.Background(), task)
	require.Error(t, err)
	require.Contains(t, err.Error(), "submit AgentRun")
	require.Equal(t, 1, submitter.calls)

	result, err := implementerInstance.Implement(context.Background(), task)
	require.NoError(t, err)
	require.False(t, result.Duplicate)
	require.Equal(t, 2, submitter.calls)
}

func TestImplementer_MissingDeliveryID(t *testing.T) {
	store := &fakeStore{}
	submitter := &fakeSubmitter{}

	implementerInstance, err := NewImplementer(store, submitter, Config{})
	require.NoError(t, err)

	_, err = implementerInstance.Implement(context.Background(), &froussardpb.CodexTask{
		Stage:       froussardpb.CodexTaskStage_CODEX_TASK_STAGE_IMPLEMENTATION,
		Repository:  "proompteng/lab",
		IssueNumber: 1636,
		DeliveryId:  " ",
	})
	require.ErrorIs(t, err, ErrImplementationMissingDeliveryID)
	require.Equal(t, 0, submitter.calls)
	require.Equal(t, 0, store.ideaCalls)
	require.Equal(t, 0, store.lifecycleCalls)
}

func TestImplementer_UnsupportedStage(t *testing.T) {
	store := &fakeStore{}
	submitter := &fakeSubmitter{}

	implementerInstance, err := NewImplementer(store, submitter, Config{})
	require.NoError(t, err)

	_, err = implementerInstance.Implement(context.Background(), &froussardpb.CodexTask{
		Stage:       froussardpb.CodexTaskStage_CODEX_TASK_STAGE_PLANNING,
		Repository:  "proompteng/lab",
		IssueNumber: 1636,
		DeliveryId:  "invalid-stage",
	})
	require.ErrorIs(t, err, ErrImplementationUnsupportedStage)
	require.Equal(t, 0, submitter.calls)
	require.Equal(t, 0, store.ideaCalls)
}
