package facteur

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/proompteng/lab/services/facteur/internal/bridge"
	"github.com/proompteng/lab/services/facteur/internal/config"
)

func TestBuildDispatcherReturnsNoopWhenDisabled(t *testing.T) {
	t.Setenv("FACTEUR_DISABLE_DISPATCHER", "true")

	dispatcher, runner, err := buildDispatcher(&config.Config{})
	require.NoError(t, err)
	require.Nil(t, runner)

	_, ok := dispatcher.(bridge.NoopDispatcher)
	require.True(t, ok, "expected dispatcher to be noop dispatcher when disabled")
}

func TestBuildDispatcherPropagatesConfigErrors(t *testing.T) {
	t.Setenv("FACTEUR_DISABLE_DISPATCHER", "")
	t.Setenv("FACTEUR_KUBECONFIG", filepath.Join(t.TempDir(), "missing"))

	_, _, err := buildDispatcher(&config.Config{
		Argo: config.ArgoConfig{
			Namespace:        "argo-workflows",
			WorkflowTemplate: "template",
			ServiceAccount:   "sa",
		},
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "kubeconfig")
}

func TestResolveRESTConfigPrefersFacteurEnv(t *testing.T) {
	dir := t.TempDir()
	kubePath := filepath.Join(dir, "config")
	data := []byte(`apiVersion: v1
clusters:
- cluster:
    server: https://example.invalid
  name: default
contexts:
- context:
    cluster: default
    user: default
  name: default
current-context: default
kind: Config
preferences: {}
users:
- name: default
  user:
    token: fake
`)

	require.NoError(t, os.WriteFile(kubePath, data, 0o600))

	t.Setenv("FACTEUR_KUBECONFIG", kubePath)
	cfg, err := resolveRESTConfig()
	require.NoError(t, err)
	require.NotNil(t, cfg)
	require.Contains(t, cfg.Host, "example.invalid")
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
