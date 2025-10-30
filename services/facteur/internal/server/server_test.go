package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	"github.com/proompteng/lab/services/facteur/internal/bridge"
	"github.com/proompteng/lab/services/facteur/internal/facteurpb"
	"github.com/proompteng/lab/services/facteur/internal/githubpb"
	"github.com/proompteng/lab/services/facteur/internal/orchestrator"
	"github.com/proompteng/lab/services/facteur/internal/server"
	"github.com/proompteng/lab/services/facteur/internal/session"
)

func TestEventsEndpointDispatches(t *testing.T) {
	dispatcher := &stubDispatcher{result: bridge.DispatchResult{Namespace: "argo", WorkflowName: "wf-123", CorrelationID: "corr-1"}}
	store := &stubStore{}

	srv, err := server.New(server.Options{Dispatcher: dispatcher, Store: store, SessionTTL: time.Minute})
	require.NoError(t, err)

	payload, err := proto.Marshal(&facteurpb.CommandEvent{
		Command:       "dispatch",
		User:          &facteurpb.DiscordUser{Id: "user-1"},
		Options:       map[string]string{"env": "staging"},
		CorrelationId: "corr-1",
	})
	require.NoError(t, err)

	req := httptest.NewRequest("POST", "/events", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/x-protobuf")

	resp, err := srv.App().Test(req)
	require.NoError(t, err)
	require.Equal(t, 202, resp.StatusCode)
	require.True(t, store.setCalled)
	require.Equal(t, session.DispatchKey("user-1"), store.lastKey)
}

func TestEventsEndpointLogsMetadata(t *testing.T) {
	dispatcher := &stubDispatcher{result: bridge.DispatchResult{Namespace: "argo", WorkflowName: "wf-123", CorrelationID: "corr-1"}}
	store := &stubStore{}

	srv, err := server.New(server.Options{Dispatcher: dispatcher, Store: store, SessionTTL: time.Minute})
	require.NoError(t, err)

	buf := &bytes.Buffer{}
	orig := log.Writer()
	log.SetOutput(buf)
	defer log.SetOutput(orig)

	payload, err := proto.Marshal(&facteurpb.CommandEvent{Command: "dispatch", User: &facteurpb.DiscordUser{Id: "user-1"}, CorrelationId: "corr-1", TraceId: "trace-1"})
	require.NoError(t, err)

	req := httptest.NewRequest("POST", "/events", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/x-protobuf")

	resp, err := srv.App().Test(req)
	require.NoError(t, err)
	require.Equal(t, 202, resp.StatusCode)

	logs := buf.String()
	require.Contains(t, logs, "event received: command=dispatch user=user-1 correlation=corr-1 trace=trace-1")
}

func TestEventsEndpointWithoutDispatcher(t *testing.T) {
	srv, err := server.New(server.Options{})
	require.NoError(t, err)

	payload, err := proto.Marshal(&facteurpb.CommandEvent{Command: "dispatch"})
	require.NoError(t, err)

	req := httptest.NewRequest("POST", "/events", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/x-protobuf")

	resp, err := srv.App().Test(req)
	require.NoError(t, err)
	require.Equal(t, 503, resp.StatusCode)
}

func TestEventsEndpointRejectsEmptyPayload(t *testing.T) {
	srv, err := server.New(server.Options{Dispatcher: &stubDispatcher{}, Store: &stubStore{}})
	require.NoError(t, err)

	req := httptest.NewRequest("POST", "/events", bytes.NewReader(nil))
	req.Header.Set("Content-Type", "application/x-protobuf")

	resp, err := srv.App().Test(req)
	require.NoError(t, err)
	require.Equal(t, 400, resp.StatusCode)
}

func TestCodexTasksEndpointLogs(t *testing.T) {
	srv, err := server.New(server.Options{Dispatcher: &stubDispatcher{}, Store: &stubStore{}})
	require.NoError(t, err)

	buf := &bytes.Buffer{}
	orig := log.Writer()
	log.SetOutput(buf)
	defer log.SetOutput(orig)

	payload, err := proto.Marshal(&githubpb.CodexTask{
		Stage:       githubpb.CodexTaskStage_CODEX_TASK_STAGE_IMPLEMENTATION,
		Repository:  "proompteng/lab",
		IssueNumber: 42,
		Head:        "codex/issue-42-demo",
		DeliveryId:  "delivery-1",
	})
	require.NoError(t, err)

	req := httptest.NewRequest("POST", "/codex/tasks", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/x-protobuf")
	req.Header.Set("ce-id", "delivery-1")

	resp, err := srv.App().Test(req)
	require.NoError(t, err)
	require.Equal(t, 202, resp.StatusCode)

	logs := buf.String()
	require.Contains(t, logs, "codex task received: stage=CODEX_TASK_STAGE_IMPLEMENTATION repo=proompteng/lab issue=42")
}

func TestCodexTasksPlanningDispatches(t *testing.T) {
	planner := &stubPlanner{result: orchestrator.Result{
		Namespace:    "argo-workflows",
		WorkflowName: "github-codex-planning-abc123",
		SubmittedAt:  time.Unix(1735600300, 0).UTC(),
	}}

	srv, err := server.New(server.Options{
		Dispatcher:   &stubDispatcher{},
		Store:        &stubStore{},
		CodexPlanner: server.CodexPlannerOptions{Enabled: true, Planner: planner},
	})
	require.NoError(t, err)

	payload, err := proto.Marshal(&githubpb.CodexTask{
		Stage:       githubpb.CodexTaskStage_CODEX_TASK_STAGE_PLANNING,
		Repository:  "proompteng/lab",
		IssueNumber: 1636,
		DeliveryId:  "delivery-planning",
	})
	require.NoError(t, err)

	req := httptest.NewRequest("POST", "/codex/tasks", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/x-protobuf")

	resp, err := srv.App().Test(req)
	require.NoError(t, err)
	require.Equal(t, 202, resp.StatusCode)

	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	_ = resp.Body.Close()

	var data map[string]any
	require.NoError(t, json.Unmarshal(body, &data))
	require.Equal(t, "planning", data["stage"])
	require.Equal(t, "argo-workflows", data["namespace"])
	require.Equal(t, "github-codex-planning-abc123", data["workflowName"])
	require.Equal(t, planner.result.SubmittedAt.Format(time.RFC3339), data["submittedAt"])
	require.False(t, data["duplicate"].(bool))
	require.Equal(t, 1, planner.calls)
}

func TestCodexTasksPlanningPlannerError(t *testing.T) {
	planner := &stubPlanner{err: errors.New("planner boom")}
	srv, err := server.New(server.Options{
		Dispatcher:   &stubDispatcher{},
		Store:        &stubStore{},
		CodexPlanner: server.CodexPlannerOptions{Enabled: true, Planner: planner},
	})
	require.NoError(t, err)

	payload, err := proto.Marshal(&githubpb.CodexTask{
		Stage:       githubpb.CodexTaskStage_CODEX_TASK_STAGE_PLANNING,
		Repository:  "proompteng/lab",
		IssueNumber: 1636,
		DeliveryId:  "delivery-error",
	})
	require.NoError(t, err)

	req := httptest.NewRequest("POST", "/codex/tasks", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/x-protobuf")

	resp, err := srv.App().Test(req)
	require.NoError(t, err)
	require.Equal(t, 500, resp.StatusCode)

	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	_ = resp.Body.Close()

	var data map[string]any
	require.NoError(t, json.Unmarshal(body, &data))
	require.Equal(t, "planning orchestrator failed", data["error"])
	require.Contains(t, data["details"].(string), "planner boom")
	require.Equal(t, 1, planner.calls)
}

func TestCodexTasksPlannerBypass(t *testing.T) {
	planner := &stubPlanner{}
	srv, err := server.New(server.Options{
		Dispatcher:   &stubDispatcher{},
		Store:        &stubStore{},
		CodexPlanner: server.CodexPlannerOptions{Enabled: false, Planner: planner},
	})
	require.NoError(t, err)

	payload, err := proto.Marshal(&githubpb.CodexTask{
		Stage:       githubpb.CodexTaskStage_CODEX_TASK_STAGE_IMPLEMENTATION,
		Repository:  "proompteng/lab",
		IssueNumber: 1636,
		DeliveryId:  "delivery-bypass",
	})
	require.NoError(t, err)

	req := httptest.NewRequest("POST", "/codex/tasks", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/x-protobuf")

	resp, err := srv.App().Test(req)
	require.NoError(t, err)
	require.Equal(t, 202, resp.StatusCode)
	require.Equal(t, 0, planner.calls)
}

type stubDispatcher struct {
	result bridge.DispatchResult
}

func (s *stubDispatcher) Dispatch(_ context.Context, req bridge.DispatchRequest) (bridge.DispatchResult, error) {
	s.result.CorrelationID = req.CorrelationID
	return s.result, nil
}

func (s *stubDispatcher) Status(context.Context) (bridge.StatusReport, error) {
	return bridge.StatusReport{}, nil
}

type stubStore struct {
	setCalled bool
	lastKey   string
}

func (s *stubStore) Set(_ context.Context, key string, _ []byte, _ time.Duration) error {
	s.setCalled = true
	s.lastKey = key
	return nil
}

func (s *stubStore) Get(context.Context, string) ([]byte, error) { return nil, session.ErrNotFound }

func (s *stubStore) Delete(context.Context, string) error { return nil }

type stubPlanner struct {
	result orchestrator.Result
	err    error
	calls  int
}

func (s *stubPlanner) Plan(_ context.Context, _ *githubpb.CodexTask) (orchestrator.Result, error) {
	s.calls++
	if s.err != nil {
		return orchestrator.Result{}, s.err
	}
	return s.result, nil
}
