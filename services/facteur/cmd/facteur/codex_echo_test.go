package facteur

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCodexEchoCommandFailsWhenListenerDisabled(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "facteur.yaml")
	data := []byte(`discord:
  bot_token: token
  application_id: app
  public_key: key
  guild_id: guild
redis:
  url: redis://localhost:6379/0
postgres:
  dsn: postgres://user:pass@localhost:5432/db
argo:
  namespace: argo
  workflow_template: template
  service_account: sa
codex_listener:
  enabled: false
`)
	require.NoError(t, os.WriteFile(configPath, data, 0o600))

	cmd := NewCodexEchoCommand()
	cmd.SetContext(context.Background())
	cmd.SetArgs([]string{"--config", configPath})
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)

	err := cmd.Execute()
	require.Error(t, err)
	require.Contains(t, err.Error(), "codex listener disabled")
}
