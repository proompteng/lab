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
	ideaID       string
	taskID       string
	runID        string
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

func (s *fakeStore) UpsertIdea(_ context.Context, record knowledge.IdeaRecord) (string, error) {
	s.ideaCalls++
	s.lastIdea = record
	if len(s.responses) > 0 {
		resp := s.responses[0]
		if resp.upsertErr != nil {
			s.responses[0].upsertErr = nil
			return "", resp.upsertErr
		}
		if resp.ideaID != "" {
			return resp.ideaID, nil
		}
	}
	return "idea-auto", nil
}

func (s *fakeStore) RecordTaskLifecycle(_ context.Context, task knowledge.TaskRecord, run knowledge.TaskRunRecord) (knowledge.TaskRecord, knowledge.TaskRunRecord, error) {
	s.lifecycleCalls++
	s.lastTask = task
	s.lastRun = run
	if len(s.responses) > 0 {
		resp := s.responses[0]
		if resp.lifecycleErr != nil {
			s.responses[0].lifecycleErr = nil
			return knowledge.TaskRecord{}, knowledge.TaskRunRecord{}, resp.lifecycleErr
		}
		if resp.ideaID != "" && task.IdeaID == "" {
			task.IdeaID = resp.ideaID
		}
		if resp.taskID != "" {
			task.ID = resp.taskID
		}
		if resp.runID != "" {
			run.ID = resp.runID
		}
		if s.responses[0].upsertErr == nil && s.responses[0].lifecycleErr == nil {
			s.responses = s.responses[1:]
		}
	}
	if task.IdeaID == "" {
		task.IdeaID = "idea-auto"
	}
	if task.ID == "" {
		task.ID = "task-auto"
	}
	if run.ID == "" {
		run.ID = "run-auto"
	}
	if run.DeliveryID == "" {
		run.DeliveryID = "delivery-auto"
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
}

func (r *fakeRunner) Run(_ context.Context, input argo.RunInput) (argo.RunResult, error) {
	r.calls++
	r.inputs = append(r.inputs, input)
	if len(r.responses) == 0 {
		return argo.RunResult{}, nil
	}
	resp := r.responses[0]
	if len(r.responses) > 1 {
		r.responses = r.responses[1:]
	}
	return resp.result, resp.err
}

func (r *fakeRunner) TemplateStatus(context.Context, string, string) (argo.TemplateStatus, error) {
	return argo.TemplateStatus{}, errors.New("not implemented")
}

func TestPlanner_Success(t *testing.T) {
	store := &fakeStore{}
	runner := &fakeRunner{
		responses: []runnerResponse{
			{result: argo.RunResult{Namespace: "codex", WorkflowName: "github-codex-planning-123", SubmittedAt: time.Unix(1735600000, 0)}},
		},
	}

	plannerInstance, err := NewPlanner(store, runner, Config{
		Namespace:          "codex",
		WorkflowTemplate:   "github-codex-planning",
		ServiceAccount:     "planner-sa",
		Parameters:         map[string]string{"environment": "staging"},
		GenerateNamePrefix: "codex-planning-",
	})
	require.NoError(t, err)

	p := plannerInstance.(*planner)
	fixed := time.Unix(1735599999, 0).UTC()
	p.now = func() time.Time { return fixed }

	task := &froussardpb.CodexTask{
		Stage:       froussardpb.CodexTaskStage_CODEX_TASK_STAGE_PLANNING,
		Prompt:      "Plan work",
		Repository:  "proompteng/lab",
		Base:        "main",
		Head:        "feature",
		IssueNumber: 1636,
		IssueTitle:  "Codex planning",
		DeliveryId:  "delivery-123",
	}

	result, err := plannerInstance.Plan(context.Background(), task)
	require.NoError(t, err)
	require.False(t, result.Duplicate)
	require.Equal(t, runner.responses[0].result.WorkflowName, result.WorkflowName)
	require.Equal(t, runner.responses[0].result.Namespace, result.Namespace)
	require.Equal(t, runner.responses[0].result.SubmittedAt, result.SubmittedAt)

	require.Equal(t, 1, store.ideaCalls)
	require.Equal(t, 1, store.lifecycleCalls)
	require.Equal(t, fixed, store.lastIdea.CreatedAt)
	require.Equal(t, "github_issue", store.lastIdea.SourceType)
	require.Equal(t, "proompteng/lab#1636", store.lastIdea.SourceRef)

	_, exists := p.deliveries.Load("delivery-123")
	require.False(t, exists)

	value, ok := p.completed.Load("delivery-123")
	require.True(t, ok)
	entry := value.(completedEntry)
	require.Equal(t, runner.responses[0].result.WorkflowName, entry.result.WorkflowName)

	var payloadBody map[string]any
	require.NoError(t, json.Unmarshal(store.lastIdea.Payload, &payloadBody))
	require.Equal(t, "proompteng/lab", payloadBody["repository"])
	issueStr, ok := payloadBody["issueNumber"].(string)
	require.True(t, ok)
	require.Equal(t, "1636", issueStr)

	var taskMetadata map[string]any
	require.NoError(t, json.Unmarshal(store.lastTask.Metadata, &taskMetadata))
	require.Equal(t, "delivery-123", taskMetadata["deliveryId"])
	require.Equal(t, planningStageLabel, taskMetadata["stage"])

	require.Equal(t, 1, runner.calls)
	require.Len(t, runner.inputs, 1)
	input := runner.inputs[0]
	require.Equal(t, "codex", input.Namespace)
	require.Equal(t, "github-codex-planning", input.WorkflowTemplate)
	require.Equal(t, "planner-sa", input.ServiceAccount)
	require.Equal(t, "codex-planning-", input.GenerateNamePrefix)
	require.Equal(t, "staging", input.Parameters["environment"])

	eventBody := input.Parameters["eventBody"]
	require.NotEmpty(t, eventBody)
	decodedEventBody, err := base64.StdEncoding.DecodeString(eventBody)
	require.NoError(t, err)
	var eventPayload map[string]any
	require.NoError(t, json.Unmarshal(decodedEventBody, &eventPayload))
	require.Equal(t, "planning", eventPayload["stage"])
	require.Equal(t, "1636", eventPayload["issueNumber"])

	rawEvent := input.Parameters["rawEvent"]
	require.Equal(t, eventBody, rawEvent)
	decodedRawEvent, err := base64.StdEncoding.DecodeString(rawEvent)
	require.NoError(t, err)
	require.Equal(t, decodedEventBody, decodedRawEvent)
}

func TestPlanner_DuplicateDelivery(t *testing.T) {
	store := &fakeStore{}
	runner := &fakeRunner{
		responses: []runnerResponse{
			{result: argo.RunResult{Namespace: "codex", WorkflowName: "github-codex-planning-456", SubmittedAt: time.Unix(1735600001, 0)}},
		},
	}

	plannerInstance, err := NewPlanner(store, runner, Config{})
	require.NoError(t, err)

	p := plannerInstance.(*planner)
	fixed := time.Unix(1735600000, 0).UTC()
	p.now = func() time.Time { return fixed }

	task := &froussardpb.CodexTask{
		Stage:       froussardpb.CodexTaskStage_CODEX_TASK_STAGE_PLANNING,
		Repository:  "proompteng/lab",
		IssueNumber: 1636,
		DeliveryId:  "dup-1",
	}

	first, err := plannerInstance.Plan(context.Background(), task)
	require.NoError(t, err)
	require.False(t, first.Duplicate)

	second, err := plannerInstance.Plan(context.Background(), task)
	require.NoError(t, err)
	require.True(t, second.Duplicate)
	require.Equal(t, first.WorkflowName, second.WorkflowName)
	require.Equal(t, first.Namespace, second.Namespace)
	require.Equal(t, first.SubmittedAt, second.SubmittedAt)

	require.Equal(t, 1, runner.calls)
	require.Equal(t, 1, store.ideaCalls)
	require.Equal(t, 1, store.lifecycleCalls)

	value, ok := p.completed.Load("dup-1")
	require.True(t, ok)
	entry := value.(completedEntry)
	require.Equal(t, first.WorkflowName, entry.result.WorkflowName)
	require.False(t, p.now().After(entry.expiresAt))
}

func TestPlanner_StoreFailure(t *testing.T) {
	store := &fakeStore{responses: []storeResponse{{upsertErr: errors.New("store fail")}}}
	runner := &fakeRunner{responses: []runnerResponse{{result: argo.RunResult{Namespace: "codex", WorkflowName: "wf", SubmittedAt: time.Unix(1735600100, 0)}}}}

	plannerInstance, err := NewPlanner(store, runner, Config{})
	require.NoError(t, err)

	p := plannerInstance.(*planner)
	p.now = func() time.Time { return time.Unix(1735600050, 0).UTC() }

	task := &froussardpb.CodexTask{
		Stage:       froussardpb.CodexTaskStage_CODEX_TASK_STAGE_PLANNING,
		Repository:  "proompteng/lab",
		IssueNumber: 1636,
		DeliveryId:  "store-failure",
	}

	_, err = plannerInstance.Plan(context.Background(), task)
	require.Error(t, err)
	require.Contains(t, err.Error(), "upsert idea")
	require.Equal(t, 0, runner.calls)

	store.responses = []storeResponse{{}}
	result, err := plannerInstance.Plan(context.Background(), task)
	require.NoError(t, err)
	require.False(t, result.Duplicate)
	require.Equal(t, 1, runner.calls)
}

func TestPlanner_RunnerFailure(t *testing.T) {
	store := &fakeStore{}
	runner := &fakeRunner{
		responses: []runnerResponse{
			{err: errors.New("runner fail")},
			{result: argo.RunResult{Namespace: "codex", WorkflowName: "wf", SubmittedAt: time.Unix(1735600200, 0)}},
		},
	}

	plannerInstance, err := NewPlanner(store, runner, Config{})
	require.NoError(t, err)

	p := plannerInstance.(*planner)
	p.now = func() time.Time { return time.Unix(1735600150, 0).UTC() }

	task := &froussardpb.CodexTask{
		Stage:       froussardpb.CodexTaskStage_CODEX_TASK_STAGE_PLANNING,
		Repository:  "proompteng/lab",
		IssueNumber: 1636,
		DeliveryId:  "runner-failure",
	}

	_, err = plannerInstance.Plan(context.Background(), task)
	require.Error(t, err)
	require.Contains(t, err.Error(), "submit workflow")
	require.Equal(t, 1, runner.calls)

	result, err := plannerInstance.Plan(context.Background(), task)
	require.NoError(t, err)
	require.False(t, result.Duplicate)
	require.Equal(t, 2, runner.calls)
}

func TestPlanner_EvictsCompletedEntries(t *testing.T) {
	store := &fakeStore{}
	runner := &fakeRunner{
		responses: []runnerResponse{
			{result: argo.RunResult{Namespace: "codex", WorkflowName: "wf-1", SubmittedAt: time.Unix(1735600300, 0)}},
			{result: argo.RunResult{Namespace: "codex", WorkflowName: "wf-2", SubmittedAt: time.Unix(1735600310, 0)}},
		},
	}

	plannerInstance, err := NewPlanner(store, runner, Config{})
	require.NoError(t, err)
	p := plannerInstance.(*planner)
	p.evictionAfter = 10 * time.Millisecond

	task := &froussardpb.CodexTask{
		Stage:       froussardpb.CodexTaskStage_CODEX_TASK_STAGE_PLANNING,
		Repository:  "proompteng/lab",
		IssueNumber: 1636,
		DeliveryId:  "evict-1",
	}

	first, err := plannerInstance.Plan(context.Background(), task)
	require.NoError(t, err)
	require.False(t, first.Duplicate)

	time.Sleep(20 * time.Millisecond)

	second, err := plannerInstance.Plan(context.Background(), task)
	require.NoError(t, err)
	require.False(t, second.Duplicate)
	require.Equal(t, 2, runner.calls)
}

func TestPlanner_OldTimerDoesNotRemoveNewEntry(t *testing.T) {
	store := &fakeStore{}
	runner := &fakeRunner{
		responses: []runnerResponse{
			{result: argo.RunResult{Namespace: "codex", WorkflowName: "wf-1", SubmittedAt: time.Unix(1735600400, 0)}},
			{result: argo.RunResult{Namespace: "codex", WorkflowName: "wf-2", SubmittedAt: time.Unix(1735600500, 0)}},
		},
	}

	plannerInstance, err := NewPlanner(store, runner, Config{})
	require.NoError(t, err)
	p := plannerInstance.(*planner)
	p.evictionAfter = time.Minute

	var scheduled []struct {
		id      string
		expires time.Time
		fn      func()
	}
	p.scheduleEviction = func(id string, expires time.Time, ttl time.Duration, fn func()) {
		scheduled = append(scheduled, struct {
			id      string
			expires time.Time
			fn      func()
		}{id: id, expires: expires, fn: fn})
	}

	base := time.Unix(1735600000, 0).UTC()
	current := base
	p.now = func() time.Time { return current }

	task := &froussardpb.CodexTask{
		Stage:       froussardpb.CodexTaskStage_CODEX_TASK_STAGE_PLANNING,
		Repository:  "proompteng/lab",
		IssueNumber: 1637,
		DeliveryId:  "dedup-1",
	}

	first, err := plannerInstance.Plan(context.Background(), task)
	require.NoError(t, err)
	require.False(t, first.Duplicate)
	require.Len(t, scheduled, 1)
	firstExpiry := scheduled[0].expires

	// Advance time past the first expiry so the entry is considered stale.
	current = firstExpiry.Add(10 * time.Second)

	second, err := plannerInstance.Plan(context.Background(), task)
	require.NoError(t, err)
	require.False(t, second.Duplicate)
	require.Len(t, scheduled, 2)

	// Simulate the original timer firing after the new entry was stored.
	scheduled[0].fn()

	value, ok := p.completed.Load("dedup-1")
	require.True(t, ok)
	restored := value.(completedEntry)
	require.Equal(t, scheduled[1].expires, restored.expiresAt)

	// When the new timer fires, the entry should be removed.
	scheduled[1].fn()
	_, ok = p.completed.Load("dedup-1")
	require.False(t, ok)
}
