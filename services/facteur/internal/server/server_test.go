package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	"github.com/proompteng/lab/services/facteur/internal/bridge"
	"github.com/proompteng/lab/services/facteur/internal/facteurpb"
	"github.com/proompteng/lab/services/facteur/internal/server"
	"github.com/proompteng/lab/services/facteur/internal/session"
)

func TestEventsEndpointDispatches(t *testing.T) {
	dispatcher := &stubDispatcher{result: bridge.DispatchResult{Namespace: "agents", AgentRunName: "codex-agent-123", CorrelationID: "corr-1"}}
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

	var body map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	require.Equal(t, "codex-agent-123", body["agentRunName"])
	require.NotContains(t, body, "workflowName")
}

func TestEventsEndpointLogsMetadata(t *testing.T) {
	dispatcher := &stubDispatcher{result: bridge.DispatchResult{Namespace: "agents", AgentRunName: "codex-agent-123", CorrelationID: "corr-1"}}
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
	require.Contains(t, logs, "agentrun=codex-agent-123")
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

func TestLegacyCodexTaskIngressIsNotRegistered(t *testing.T) {
	srv, err := server.New(server.Options{})
	require.NoError(t, err)

	for _, path := range []string{"/codex/tasks", "/agent-runs/github-issues"} {
		req := httptest.NewRequest("POST", path, bytes.NewReader([]byte("legacy")))
		req.Header.Set("Content-Type", "application/x-protobuf")

		resp, err := srv.App().Test(req)
		require.NoError(t, err)
		require.Equal(t, 404, resp.StatusCode)
	}
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
