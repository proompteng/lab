package server_test

import (
	"bytes"
	"context"
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

func TestCodexTasksEndpointPersists(t *testing.T) {
	codex := &stubCodexStore{
		ideaID: "idea-1",
		taskID: "task-1",
		runID:  "run-1",
	}

	srv, err := server.New(server.Options{
		Dispatcher: &stubDispatcher{},
		Store:      &stubStore{},
		CodexStore: codex,
	})
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

	resp, err := srv.App().Test(req)
	require.NoError(t, err)
	t.Cleanup(func() {
		_ = resp.Body.Close()
	})

	require.Equal(t, 202, resp.StatusCode)

	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	require.Contains(t, string(body), `"ideaId":"idea-1"`)
	require.Contains(t, string(body), `"taskRunId":"run-1"`)

	require.Equal(t, 1, codex.calls)
	require.Equal(t, "delivery-1", codex.lastTask.GetDeliveryId())

	logs := buf.String()
	require.Contains(t, logs, "codex task ingested: idea_id=idea-1 task_id=task-1 run_id=run-1")
}

func TestCodexTasksEndpointHandlesError(t *testing.T) {
	codex := &stubCodexStore{err: errors.New("boom")}

	srv, err := server.New(server.Options{
		Dispatcher: &stubDispatcher{},
		Store:      &stubStore{},
		CodexStore: codex,
	})
	require.NoError(t, err)

	payload, err := proto.Marshal(&githubpb.CodexTask{
		Stage:       githubpb.CodexTaskStage_CODEX_TASK_STAGE_PLANNING,
		Repository:  "proompteng/lab",
		IssueNumber: 7,
		DeliveryId:  "delivery-error",
	})
	require.NoError(t, err)

	req := httptest.NewRequest("POST", "/codex/tasks", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/x-protobuf")

	resp, err := srv.App().Test(req)
	require.NoError(t, err)
	t.Cleanup(func() {
		_ = resp.Body.Close()
	})

	require.Equal(t, 500, resp.StatusCode)
	require.Equal(t, 1, codex.calls)
}

func TestCodexTasksEndpointUnavailable(t *testing.T) {
	srv, err := server.New(server.Options{})
	require.NoError(t, err)

	payload, err := proto.Marshal(&githubpb.CodexTask{
		Stage:       githubpb.CodexTaskStage_CODEX_TASK_STAGE_REVIEW,
		Repository:  "proompteng/lab",
		IssueNumber: 99,
		DeliveryId:  "delivery-none",
	})
	require.NoError(t, err)

	req := httptest.NewRequest("POST", "/codex/tasks", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/x-protobuf")

	resp, err := srv.App().Test(req)
	require.NoError(t, err)
	t.Cleanup(func() {
		_ = resp.Body.Close()
	})

	require.Equal(t, 503, resp.StatusCode)
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

type stubCodexStore struct {
	ideaID   string
	taskID   string
	runID    string
	err      error
	calls    int
	lastTask *githubpb.CodexTask
}

func (s *stubCodexStore) IngestCodexTask(_ context.Context, task *githubpb.CodexTask) (string, string, string, error) {
	s.calls++
	s.lastTask = task
	if s.err != nil {
		return "", "", "", s.err
	}
	return s.ideaID, s.taskID, s.runID, nil
}
