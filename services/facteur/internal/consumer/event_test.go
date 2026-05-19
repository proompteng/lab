package consumer_test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/proompteng/lab/services/facteur/internal/bridge"
	"github.com/proompteng/lab/services/facteur/internal/consumer"
	"github.com/proompteng/lab/services/facteur/internal/facteurpb"
	"github.com/proompteng/lab/services/facteur/internal/session"
)

func TestProcessEventPersistsSession(t *testing.T) {
	dispatcher := &stubDispatcher{result: bridge.DispatchResult{Namespace: "agents", AgentRunName: "codex-agent-123", WorkflowName: "codex-agent-123"}}
	store := &stubStore{}

	result, err := consumer.ProcessEvent(context.Background(), &facteurpb.CommandEvent{
		Command:       "plan",
		User:          &facteurpb.DiscordUser{Id: "user-1"},
		Options:       map[string]string{"payload": `{"prompt":"Test"}`},
		CorrelationId: "corr-1",
	}, dispatcher, store, time.Minute)
	require.NoError(t, err)
	require.Equal(t, "codex-agent-123", result.AgentRunName)
	require.True(t, store.setCalled)
	require.Equal(t, session.DispatchKey("user-1"), store.lastKey)
	require.Equal(t, time.Minute, store.lastTTL)
	require.Equal(t, dispatcher.lastReq.TraceID, "")
}

func TestProcessEventDefaultsCorrelation(t *testing.T) {
	dispatcher := &stubDispatcher{result: bridge.DispatchResult{Namespace: "agents", AgentRunName: "codex-agent-123", WorkflowName: "codex-agent-123"}}
	store := &stubStore{}

	result, err := consumer.ProcessEvent(context.Background(), &facteurpb.CommandEvent{
		Command: "plan",
		User:    &facteurpb.DiscordUser{Id: "user-1"},
	}, dispatcher, store, 0)
	require.NoError(t, err)
	require.Equal(t, dispatcher.lastReq.CorrelationID, "")
	require.Equal(t, result.CorrelationID, "")
	require.Equal(t, consumer.DefaultSessionTTL, store.lastTTL)
}

func TestProcessEventValidatesCommand(t *testing.T) {
	_, err := consumer.ProcessEvent(context.Background(), &facteurpb.CommandEvent{}, &stubDispatcher{}, nil, 0)
	require.Error(t, err)
	require.Contains(t, err.Error(), "missing command")
}

type stubDispatcher struct {
	result  bridge.DispatchResult
	lastReq bridge.DispatchRequest
}

func (s *stubDispatcher) Dispatch(_ context.Context, req bridge.DispatchRequest) (bridge.DispatchResult, error) {
	s.lastReq = req
	return s.result, nil
}

func (s *stubDispatcher) Status(context.Context) (bridge.StatusReport, error) {
	return bridge.StatusReport{}, nil
}

type stubStore struct {
	setCalled bool
	lastKey   string
	lastTTL   time.Duration
}

func (s *stubStore) Set(_ context.Context, key string, _ []byte, ttl time.Duration) error {
	s.setCalled = true
	s.lastKey = key
	s.lastTTL = ttl
	return nil
}

func (s *stubStore) Get(context.Context, string) ([]byte, error) { return nil, session.ErrNotFound }

func (s *stubStore) Delete(context.Context, string) error { return nil }
