package discord_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/proompteng/lab/services/facteur/internal/bridge"
	"github.com/proompteng/lab/services/facteur/internal/discord"
)

func TestHandler_Dispatch(t *testing.T) {
	ctx := context.Background()
	fake := &fakeDispatcher{
		dispatchResult: bridge.DispatchResult{Namespace: "agents", AgentRunName: "codex-agent-123", WorkflowName: "codex-agent-123", Message: "AgentRun codex-agent-123 queued."},
	}

	handler, err := discord.NewHandler(map[string][]string{
		discord.CommandPlan: {"role-ops"},
	}, fake, nil)
	require.NoError(t, err)

	resp, err := handler.Handle(ctx, discord.Interaction{
		Name:    discord.CommandPlan,
		UserID:  "user-123",
		Roles:   []string{"role-ops"},
		Options: map[string]string{"payload": `{"prompt":"Generate"}`},
	})

	require.NoError(t, err)
	require.True(t, resp.Ephemeral)
	require.Contains(t, resp.Content, "codex-agent-123 queued")
	require.True(t, fake.dispatchCalled)
	require.Equal(t, bridge.DispatchRequest{
		Command: discord.CommandPlan,
		UserID:  "user-123",
		Options: map[string]string{"payload": `{"prompt":"Generate"}`},
	}, fake.lastDispatchRequest)
}

func TestHandler_DispatchForbidden(t *testing.T) {
	ctx := context.Background()
	fake := &fakeDispatcher{}

	handler, err := discord.NewHandler(map[string][]string{
		discord.CommandPlan: {"role-ops"},
	}, fake, nil)
	require.NoError(t, err)

	resp, err := handler.Handle(ctx, discord.Interaction{
		Name:   discord.CommandPlan,
		UserID: "user-456",
		Roles:  []string{"role-guest"},
	})

	require.ErrorIs(t, err, discord.ErrForbidden)
	require.True(t, resp.Ephemeral)
	require.Contains(t, resp.Content, "permission")
	require.False(t, fake.dispatchCalled)
}

func TestHandler_Status(t *testing.T) {
	ctx := context.Background()
	fake := &fakeDispatcher{
		statusReport: bridge.StatusReport{Namespace: "agents", AgentName: "codex-agent", Ready: true},
	}

	handler, err := discord.NewHandler(map[string][]string{}, fake, nil)
	require.NoError(t, err)

	resp, err := handler.Handle(ctx, discord.Interaction{Name: discord.CommandStatus})
	require.NoError(t, err)
	require.True(t, resp.Ephemeral)
	require.Contains(t, resp.Content, "AgentRun dispatch target")
	require.True(t, fake.statusCalled)
}

func TestHandler_UnknownCommand(t *testing.T) {
	ctx := context.Background()
	fake := &fakeDispatcher{}

	handler, err := discord.NewHandler(nil, fake, nil)
	require.NoError(t, err)

	resp, err := handler.Handle(ctx, discord.Interaction{Name: "noop"})
	require.ErrorIs(t, err, discord.ErrUnknownCommand)
	require.True(t, resp.Ephemeral)
	require.Contains(t, resp.Content, "Unknown command")
}

func TestHandler_DispatchErrorBubbles(t *testing.T) {
	ctx := context.Background()
	dispatchErr := errors.New("failed to submit AgentRun")
	fake := &fakeDispatcher{dispatchErr: dispatchErr}

	handler, err := discord.NewHandler(map[string][]string{}, fake, nil)
	require.NoError(t, err)

	_, err = handler.Handle(ctx, discord.Interaction{Name: discord.CommandPlan})
	require.ErrorIs(t, err, dispatchErr)
}

func TestHandler_DispatchPersistsSession(t *testing.T) {
	ctx := context.Background()
	fake := &fakeDispatcher{
		dispatchResult: bridge.DispatchResult{
			Namespace:     "agents",
			AgentRunName:  "codex-agent-123",
			WorkflowName:  "codex-agent-123",
			CorrelationID: "corr-123",
		},
	}
	store := &fakeStore{}

	handler, err := discord.NewHandler(nil, fake, store)
	require.NoError(t, err)

	interaction := discord.Interaction{Name: discord.CommandPlan, UserID: "user-1"}
	resp, err := handler.Handle(ctx, interaction)
	require.NoError(t, err)
	require.True(t, resp.Ephemeral)
	require.True(t, store.setCalled)
	require.Equal(t, "dispatch:user-1", store.lastKey)
	require.True(t, store.lastTTL >= 14*time.Minute)

	store.getResult = store.lastValue
	report := &fakeDispatcher{statusReport: bridge.StatusReport{Namespace: "agents", AgentName: "codex-agent"}}
	handlerWithStore, err := discord.NewHandler(nil, report, store)
	require.NoError(t, err)

	store.getResult = store.lastValue
	store.getErr = nil
	resp, err = handlerWithStore.Handle(ctx, discord.Interaction{Name: discord.CommandStatus, UserID: "user-1"})
	require.NoError(t, err)
	require.Contains(t, resp.Content, "corr-123")
}

type fakeDispatcher struct {
	dispatchCalled      bool
	statusCalled        bool
	lastDispatchRequest bridge.DispatchRequest
	dispatchResult      bridge.DispatchResult
	statusReport        bridge.StatusReport
	dispatchErr         error
	statusErr           error
}

func (f *fakeDispatcher) Dispatch(_ context.Context, req bridge.DispatchRequest) (bridge.DispatchResult, error) {
	f.dispatchCalled = true
	f.lastDispatchRequest = req
	if f.dispatchErr != nil {
		return bridge.DispatchResult{}, f.dispatchErr
	}
	return f.dispatchResult, nil
}

func (f *fakeDispatcher) Status(context.Context) (bridge.StatusReport, error) {
	f.statusCalled = true
	if f.statusErr != nil {
		return bridge.StatusReport{}, f.statusErr
	}
	return f.statusReport, nil
}

type fakeStore struct {
	setCalled bool
	lastKey   string
	lastValue []byte
	lastTTL   time.Duration
	getResult []byte
	getErr    error
}

func (f *fakeStore) Set(_ context.Context, key string, value []byte, ttl time.Duration) error {
	f.setCalled = true
	f.lastKey = key
	f.lastValue = append([]byte(nil), value...)
	f.lastTTL = ttl
	return nil
}

func (f *fakeStore) Get(_ context.Context, _ string) ([]byte, error) {
	if f.getErr != nil {
		return nil, f.getErr
	}
	return f.getResult, nil
}

func (f *fakeStore) Delete(context.Context, string) error { return nil }
