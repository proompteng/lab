package orchestrator

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/proompteng/lab/services/facteur/internal/argo"
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

type runnerResponse struct {
	result argo.RunResult
	err    error
}

type fakeRunner struct {
	responses []runnerResponse
	calls     int
	inputs    []argo.RunInput
	index     int
}

func (r *fakeRunner) Run(_ context.Context, input argo.RunInput) (argo.RunResult, error) {
	r.calls++
	r.inputs = append(r.inputs, input)
	if r.index >= len(r.responses) {
		return argo.RunResult{}, nil
	}
	resp := r.responses[r.index]
	r.index++
	return resp.result, resp.err
}

func (r *fakeRunner) TemplateStatus(
	_ context.Context,
	_ string,
	_ string,
) (argo.TemplateStatus, error) {
	return argo.TemplateStatus{}, nil
}

func TestImplementer_Success(t *testing.T) {
	store := &fakeStore{}
	runner := &fakeRunner{
		responses: []runnerResponse{
			{result: argo.RunResult{Namespace: "argo-workflows", WorkflowName: "github-codex-implementation-123", SubmittedAt: time.Unix(1735601000, 0)}},
		},
	}

	implementerInstance, err := NewImplementer(store, runner, Config{
		Namespace:          "argo-workflows",
		WorkflowTemplate:   "github-codex-implementation",
		ServiceAccount:     "implementer-sa",
		Parameters:         map[string]string{"environment": "staging"},
		GenerateNamePrefix: "github-codex-implementation-",
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
		DeliveryId:  "delivery-impl",
	}

	result, err := implementerInstance.Implement(context.Background(), task)
	require.NoError(t, err)
	require.False(t, result.Duplicate)
	require.Equal(t, runner.responses[0].result.WorkflowName, result.WorkflowName)
	require.Equal(t, runner.responses[0].result.Namespace, result.Namespace)
	require.Equal(t, runner.responses[0].result.SubmittedAt, result.SubmittedAt)

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

	require.Equal(t, 1, runner.calls)
	require.Len(t, runner.inputs, 1)
	input := runner.inputs[0]
	require.Equal(t, "argo-workflows", input.Namespace)
	require.Equal(t, "github-codex-implementation", input.WorkflowTemplate)
	require.Equal(t, "implementer-sa", input.ServiceAccount)
	require.Equal(t, "github-codex-implementation-", input.GenerateNamePrefix)
	require.Equal(t, "staging", input.Parameters["environment"])
	require.Equal(t, "codex/issue-1966-demo", input.Parameters["head"])
	require.Equal(t, "main", input.Parameters["base"])

	eventBody := input.Parameters["eventBody"]
	require.NotEmpty(t, eventBody)
	decodedEventBody, err := base64.StdEncoding.DecodeString(eventBody)
	require.NoError(t, err)
	var eventPayload map[string]any
	require.NoError(t, json.Unmarshal(decodedEventBody, &eventPayload))
	require.Equal(t, "implementation", eventPayload["stage"])
	require.Equal(t, "1966", eventPayload["issueNumber"])

	rawEvent := input.Parameters["rawEvent"]
	require.NotEmpty(t, rawEvent)
	decodedRawEvent, err := base64.StdEncoding.DecodeString(rawEvent)
	require.NoError(t, err)
	require.NotEqual(t, decodedEventBody, decodedRawEvent)
	var rawPayload map[string]any
	require.NoError(t, json.Unmarshal(decodedRawEvent, &rawPayload))
	require.Equal(t, "CODEX_TASK_STAGE_IMPLEMENTATION", rawPayload["stage"])
}

func TestImplementer_DuplicateDelivery(t *testing.T) {
	store := &fakeStore{}
	runner := &fakeRunner{
		responses: []runnerResponse{
			{result: argo.RunResult{Namespace: "codex", WorkflowName: "github-codex-implementation-456", SubmittedAt: time.Unix(1735601001, 0)}},
		},
	}

	implementerInstance, err := NewImplementer(store, runner, Config{})
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
	require.Equal(t, first.WorkflowName, second.WorkflowName)
	require.Equal(t, first.Namespace, second.Namespace)
	require.Equal(t, first.SubmittedAt, second.SubmittedAt)

	require.Equal(t, 1, runner.calls)
	require.Equal(t, 1, store.ideaCalls)
	require.Equal(t, 1, store.lifecycleCalls)
}

func TestImplementer_StoreFailure(t *testing.T) {
	store := &fakeStore{responses: []storeResponse{{upsertErr: errors.New("store fail")}}}
	runner := &fakeRunner{responses: []runnerResponse{{result: argo.RunResult{Namespace: "codex", WorkflowName: "wf", SubmittedAt: time.Unix(1735601100, 0)}}}}

	implementerInstance, err := NewImplementer(store, runner, Config{})
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
	require.Equal(t, 0, runner.calls)

	store.responses = []storeResponse{{}}
	result, err := implementerInstance.Implement(context.Background(), task)
	require.NoError(t, err)
	require.False(t, result.Duplicate)
	require.Equal(t, 1, runner.calls)
}

func TestImplementer_RunnerFailure(t *testing.T) {
	store := &fakeStore{}
	runner := &fakeRunner{
		responses: []runnerResponse{
			{err: errors.New("runner fail")},
			{result: argo.RunResult{Namespace: "codex", WorkflowName: "wf", SubmittedAt: time.Unix(1735601200, 0)}},
		},
	}

	implementerInstance, err := NewImplementer(store, runner, Config{})
	require.NoError(t, err)

	i := implementerInstance.(*implementer)
	i.now = func() time.Time { return time.Unix(1735601150, 0).UTC() }

	task := &froussardpb.CodexTask{
		Stage:       froussardpb.CodexTaskStage_CODEX_TASK_STAGE_IMPLEMENTATION,
		Repository:  "proompteng/lab",
		IssueNumber: 1636,
		DeliveryId:  "runner-failure",
	}

	_, err = implementerInstance.Implement(context.Background(), task)
	require.Error(t, err)
	require.Contains(t, err.Error(), "submit workflow")
	require.Equal(t, 1, runner.calls)

	result, err := implementerInstance.Implement(context.Background(), task)
	require.NoError(t, err)
	require.False(t, result.Duplicate)
	require.Equal(t, 2, runner.calls)
}

func TestImplementer_UnsupportedStage(t *testing.T) {
	store := &fakeStore{}
	runner := &fakeRunner{}

	implementerInstance, err := NewImplementer(store, runner, Config{})
	require.NoError(t, err)

	_, err = implementerInstance.Implement(context.Background(), &froussardpb.CodexTask{
		Stage:       froussardpb.CodexTaskStage_CODEX_TASK_STAGE_PLANNING,
		Repository:  "proompteng/lab",
		IssueNumber: 1636,
		DeliveryId:  "invalid-stage",
	})
	require.ErrorIs(t, err, ErrImplementationUnsupportedStage)
	require.Equal(t, 0, runner.calls)
	require.Equal(t, 0, store.ideaCalls)
}
