package facteur

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/proompteng/lab/services/facteur/internal/bridge"
	"github.com/proompteng/lab/services/facteur/internal/config"
)

func TestBuildDispatcherReturnsNoopWhenDisabled(t *testing.T) {
	t.Setenv("FACTEUR_DISABLE_DISPATCHER", "true")

	dispatcher, submitter, err := buildDispatcher(&config.Config{})
	require.NoError(t, err)
	require.Nil(t, submitter)

	_, ok := dispatcher.(bridge.NoopDispatcher)
	require.True(t, ok, "expected dispatcher to be noop dispatcher when disabled")
}

func TestBuildDispatcherCreatesAgentRunDispatcher(t *testing.T) {
	t.Setenv("FACTEUR_DISABLE_DISPATCHER", "")

	dispatcher, submitter, err := buildDispatcher(&config.Config{
		Implementer: config.ImplementerConfig{
			AgentsBaseURL: "http://agents.agents.svc.cluster.local",
			Namespace:     "agents",
			AgentName:     "codex-agent",
			RuntimeType:   "job",
		},
	})
	require.NoError(t, err)
	require.NotNil(t, dispatcher)
	require.NotNil(t, submitter)
}

func TestBuildDispatcherPropagatesAgentsConfigErrors(t *testing.T) {
	t.Setenv("FACTEUR_DISABLE_DISPATCHER", "")

	_, _, err := buildDispatcher(&config.Config{
		Implementer: config.ImplementerConfig{
			AgentsBaseURL: "://bad-url",
			Namespace:     "agents",
			AgentName:     "codex-agent",
			RuntimeType:   "job",
		},
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "invalid base URL")
}

func TestIsDispatcherDisabled(t *testing.T) {
	cases := map[string]bool{
		"":          false,
		"0":         false,
		"false":     false,
		"NO":        false,
		"true":      true,
		"random":    true,
		"1":         true,
		"enable":    true,
		" disable ": true,
	}

	for value, expected := range cases {
		value, expected := value, expected
		t.Run("value="+value, func(t *testing.T) {
			t.Setenv("FACTEUR_DISABLE_DISPATCHER", value)
			require.Equal(t, expected, isDispatcherDisabled())
		})
	}
}
