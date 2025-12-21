package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	"github.com/proompteng/lab/services/facteur/internal/bridge"
	"github.com/proompteng/lab/services/facteur/internal/facteurpb"
	"github.com/proompteng/lab/services/facteur/internal/froussardpb"
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

func TestCodexTasksImplementationDispatches(t *testing.T) {
	implementer := &stubImplementer{result: orchestrator.Result{
		Namespace:    "argo-workflows",
		WorkflowName: "github-codex-implementation-abc123",
		SubmittedAt:  time.Unix(1735600400, 0).UTC(),
	}}
	srv, err := server.New(server.Options{
		Dispatcher: &stubDispatcher{},
		Store:      &stubStore{},
		CodexImplementer: server.CodexImplementerOptions{
			Enabled:     true,
			Implementer: implementer,
		},
	})
	require.NoError(t, err)

	payload, err := proto.Marshal(&froussardpb.CodexTask{
		Stage:       froussardpb.CodexTaskStage_CODEX_TASK_STAGE_IMPLEMENTATION,
		Repository:  "proompteng/lab",
		IssueNumber: 1636,
		DeliveryId:  "delivery-impl",
	})
	require.NoError(t, err)

	req := httptest.NewRequest("POST", "/codex/tasks", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/x-protobuf")

	resp, err := srv.App().Test(req)
	require.NoError(t, err)
	require.Equal(t, 202, resp.StatusCode)

	var data map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&data))
	_ = resp.Body.Close()
	require.Equal(t, "implementation", data["stage"])
	require.Equal(t, "argo-workflows", data["namespace"])
	require.Equal(t, "github-codex-implementation-abc123", data["workflowName"])
	require.Equal(t, implementer.result.SubmittedAt.Format(time.RFC3339), data["submittedAt"])
	require.False(t, data["duplicate"].(bool))
	require.Equal(t, 1, implementer.calls)
}

func TestCodexTasksImplementationImplementerError(t *testing.T) {
	implementer := &stubImplementer{err: errors.New("implementer boom")}
	srv, err := server.New(server.Options{
		Dispatcher: &stubDispatcher{},
		Store:      &stubStore{},
		CodexImplementer: server.CodexImplementerOptions{
			Enabled:     true,
			Implementer: implementer,
		},
	})
	require.NoError(t, err)

	payload, err := proto.Marshal(&froussardpb.CodexTask{
		Stage:       froussardpb.CodexTaskStage_CODEX_TASK_STAGE_IMPLEMENTATION,
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
	require.Equal(t, 1, implementer.calls)
}

func TestCodexTasksImplementationDisabled(t *testing.T) {
	srv, err := server.New(server.Options{
		Dispatcher: &stubDispatcher{},
		Store:      &stubStore{},
	})
	require.NoError(t, err)

	payload, err := proto.Marshal(&froussardpb.CodexTask{
		Stage:       froussardpb.CodexTaskStage_CODEX_TASK_STAGE_IMPLEMENTATION,
		Repository:  "proompteng/lab",
		IssueNumber: 99,
		DeliveryId:  "delivery-disabled",
	})
	require.NoError(t, err)

	req := httptest.NewRequest("POST", "/codex/tasks", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/x-protobuf")

	resp, err := srv.App().Test(req)
	require.NoError(t, err)
	require.Equal(t, 503, resp.StatusCode)
}

func TestCodexTasksUnsupportedStage(t *testing.T) {
	srv, err := server.New(server.Options{
		Dispatcher: &stubDispatcher{},
		Store:      &stubStore{},
	})
	require.NoError(t, err)

	payload, err := proto.Marshal(&froussardpb.CodexTask{
		Stage:       froussardpb.CodexTaskStage_CODEX_TASK_STAGE_REVIEW,
		Repository:  "proompteng/lab",
		IssueNumber: 99,
		DeliveryId:  "delivery-unsupported",
	})
	require.NoError(t, err)

	req := httptest.NewRequest("POST", "/codex/tasks", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/x-protobuf")

	resp, err := srv.App().Test(req)
	require.NoError(t, err)
	require.Equal(t, 400, resp.StatusCode)
}

type stubDispatcher struct {
	result   bridge.DispatchResult
	requests []bridge.DispatchRequest
	err      error
}

func (s *stubDispatcher) Dispatch(_ context.Context, req bridge.DispatchRequest) (bridge.DispatchResult, error) {
	s.requests = append(s.requests, req)
	if s.err != nil {
		return bridge.DispatchResult{}, s.err
	}
	res := s.result
	if res.CorrelationID == "" {
		res.CorrelationID = req.CorrelationID
	}
	return res, nil
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

type stubImplementer struct {
	result orchestrator.Result
	err    error
	calls  int
}

func (s *stubImplementer) Implement(_ context.Context, _ *froussardpb.CodexTask) (orchestrator.Result, error) {
	s.calls++
	if s.err != nil {
		return orchestrator.Result{}, s.err
	}
	return s.result, nil
}
