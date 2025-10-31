package facteur

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/pressly/goose/v3"
	"github.com/spf13/cobra"
	"github.com/stretchr/testify/require"

	"github.com/proompteng/lab/services/facteur/internal/migrate"
)

func TestMigrateCommandRequiresDSN(t *testing.T) {
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

	cmd := NewMigrateCommand()
	cmd.SetContext(context.Background())
	cmd.SetArgs([]string{"--config", configPath})
	cmd.SetErr(io.Discard)
	cmd.SetOut(io.Discard)

	err := cmd.Execute()
	require.Error(t, err)
	require.EqualError(t, err, missingDSNMessage)
}

func TestWrapMigrationError(t *testing.T) {
	require.EqualError(t, wrapMigrationError(migrate.ErrMissingDSN), missingDSNMessage)

	err := errors.New("boom")
	wrapped := wrapMigrationError(err)
	require.Error(t, wrapped)
	require.Contains(t, wrapped.Error(), "run migrations")
}

func TestLogMigrationResults(t *testing.T) {
	cmd := &cobra.Command{}
	buf := &bytes.Buffer{}
	cmd.SetOut(buf)

	result := &goose.MigrationResult{
		Source: &goose.Source{
			Version: 20250101010101,
			Path:    "/tmp/20250101010101_create_table.sql",
		},
	}

	logMigrationResults(cmd, []*goose.MigrationResult{result, nil})

	output := buf.String()
	require.Contains(t, output, "migration 20250101010101 applied (20250101010101_create_table.sql)")
}

func TestApplyMigrationsPropagatesErrors(t *testing.T) {
	cmd := &cobra.Command{}
	_, err := applyMigrations(context.Background(), cmd, "postgres://localhost:1/facteur?sslmode=disable")
	require.Error(t, err)
	require.Contains(t, err.Error(), "run migrations")
}
