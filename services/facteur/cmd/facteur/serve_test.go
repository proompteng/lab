package facteur

import (
	"context"
	"database/sql"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/pressly/goose/v3"
	"github.com/spf13/cobra"
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

func TestServeCommandStartsAndStopsCleanly(t *testing.T) {
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
server:
  listen_address: 127.0.0.1:0
codex_listener:
  enabled: false
`)
	require.NoError(t, os.WriteFile(configPath, data, 0o600))

	origOpener := postgresOpener
	t.Cleanup(func() { postgresOpener = origOpener })

	postgresOpener = func(ctx context.Context, dsn string) (*sql.DB, error) {
		db, mock, err := sqlmock.New(sqlmock.MonitorPingsOption(true))
		if err != nil {
			return nil, err
		}
		mock.ExpectPing()
		mock.ExpectClose()
		require.NoError(t, db.PingContext(ctx))
		return db, nil
	}

	origMigrations := migrationsRunner
	t.Cleanup(func() { migrationsRunner = origMigrations })

	var migrationsCalled bool
	migrationsRunner = func(ctx context.Context, cmd *cobra.Command, dsn string) ([]*goose.MigrationResult, error) {
		migrationsCalled = true
		return nil, nil
	}

	t.Setenv("FACTEUR_DISABLE_DISPATCHER", "1")
	cmd := NewServeCommand()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	cmd.SetContext(ctx)
	cmd.SetArgs([]string{"--config", configPath})
	cmd.SetErr(io.Discard)
	cmd.SetOut(io.Discard)

	done := make(chan error, 1)
	go func() {
		done <- cmd.Execute()
	}()

	time.Sleep(100 * time.Millisecond)
	cancel()

	select {
	case err := <-done:
		require.NoError(t, err)
	default:
		select {
		case err := <-done:
			require.NoError(t, err)
		case <-time.After(2 * time.Second):
			t.Fatal("serve command did not terminate")
		}
	}
	require.True(t, migrationsCalled, "expected migrations to run")
}

func TestOpenPostgresRejectsInvalidDSN(t *testing.T) {
	_, err := openPostgres(context.Background(), "not-a-dsn")
	require.Error(t, err)
	require.Contains(t, err.Error(), "postgres")
}
