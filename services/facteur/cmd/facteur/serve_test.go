package facteur

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestServeCommandReturnsHelpfulErrorWhenDSNMissing(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "facteur.yaml")
	data := []byte(`discord:
  bot_token: token
  application_id: app
redis:
  url: redis://localhost:6379/0
postgres:
  dsn: "   "
argo:
  namespace: argo
  workflow_template: template
`)
	require.NoError(t, os.WriteFile(configPath, data, 0o600))

	cmd := NewServeCommand()
	cmd.SetContext(context.Background())
	cmd.SetArgs([]string{"--config", configPath})
	cmd.SetErr(io.Discard)
	cmd.SetOut(io.Discard)

	err := cmd.Execute()
	require.Error(t, err)
	require.ErrorContains(t, err, "postgres DSN is required")
}
