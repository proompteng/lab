package config_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/proompteng/lab/services/facteur/internal/config"
)

func TestLoadWithOptions(t *testing.T) {
	t.Run("loads from file", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "facteur.yaml")
		data := []byte(`discord:
  bot_token: file-token
  application_id: file-app
  public_key: file-pub
  guild_id: guild-123
redis:
  url: redis://localhost:6379/0
postgres:
  dsn: postgres://facteur:facteur@localhost:5432/facteur?sslmode=disable
argo:
  namespace: argo-workflows
  workflow_template: facteur-dispatch
  service_account: facteur-workflow
  parameters:
    payload: '{}'
codex_implementation_orchestrator:
  enabled: true
  namespace: implementation
  autonomous_namespace: jangar
  workflow_template: github-codex-implementation
  service_account: implementer
  autonomous_service_account: jangar-inspector
  parameters:
    eventBody: '{}'
server:
  listen_address: ":9000"
role_map:
  plan:
    - admin
    - operator
  status:
    - moderator
codex_listener:
  enabled: true
  brokers:
    - kafka:9092
  topic: github.issues.codex.tasks
  group_id: facteur-codex
`)
		require.NoError(t, os.WriteFile(path, data, 0o600))

		cfg, err := config.LoadWithOptions(config.Options{Path: path, EnvPrefix: "FACTEUR"})
		require.NoError(t, err)

		require.Equal(t, "file-token", cfg.Discord.BotToken)
		require.Equal(t, "file-app", cfg.Discord.ApplicationID)
		require.Equal(t, "file-pub", cfg.Discord.PublicKey)
		require.Equal(t, "guild-123", cfg.Discord.GuildID)
		require.Equal(t, "redis://localhost:6379/0", cfg.Redis.URL)
		require.Equal(t, "postgres://facteur:facteur@localhost:5432/facteur?sslmode=disable", cfg.Postgres.DSN)
		require.Equal(t, "argo-workflows", cfg.Argo.Namespace)
		require.Equal(t, "facteur-dispatch", cfg.Argo.WorkflowTemplate)
		require.Equal(t, "facteur-workflow", cfg.Argo.ServiceAccount)
		require.Equal(t, map[string]string{"payload": "{}"}, cfg.Argo.Parameters)
		require.True(t, cfg.Implementer.Enabled)
		require.Equal(t, "implementation", cfg.Implementer.Namespace)
		require.Equal(t, "jangar", cfg.Implementer.AutonomousNamespace)
		require.Equal(t, "github-codex-implementation", cfg.Implementer.WorkflowTemplate)
		require.Equal(t, "implementer", cfg.Implementer.ServiceAccount)
		require.Equal(t, "jangar-inspector", cfg.Implementer.AutonomousServiceAccount)
		require.Equal(t, map[string]string{"eventbody": "{}"}, cfg.Implementer.Parameters)
		require.Equal(t, ":9000", cfg.Server.ListenAddress)
		require.Equal(t, map[string][]string{
			"plan":   []string{"admin", "operator"},
			"status": []string{"moderator"},
		}, cfg.RoleMap)
		require.True(t, cfg.Codex.Enabled)
		require.Equal(t, []string{"kafka:9092"}, cfg.Codex.Brokers)
		require.Equal(t, "github.issues.codex.tasks", cfg.Codex.Topic)
		require.Equal(t, "facteur-codex", cfg.Codex.GroupID)
	})

	t.Run("env overrides file", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "facteur.yaml")
		data := []byte(`discord:
  bot_token: file-token
  application_id: file-app
redis:
  url: redis://localhost:6379/0
postgres:
  dsn: postgres://facteur:facteur@localhost:5432/facteur?sslmode=disable
argo:
  namespace: argo
  workflow_template: template
`)
		require.NoError(t, os.WriteFile(path, data, 0o600))

		t.Setenv("FACTEUR_DISCORD_BOT_TOKEN", "env-token")
		t.Setenv("FACTEUR_ARGO_WORKFLOW_TEMPLATE", "env-template")
		t.Setenv("FACTEUR_POSTGRES_DSN", "postgres://override")
		t.Setenv("FACTEUR_CODEX_ENABLE_IMPLEMENTATION_ORCHESTRATION", "true")
		t.Setenv("FACTEUR_CODEX_IMPLEMENTATION_ORCHESTRATOR_WORKFLOW_TEMPLATE", "env-implementation")

		cfg, err := config.LoadWithOptions(config.Options{Path: path, EnvPrefix: "FACTEUR"})
		require.NoError(t, err)
		require.Equal(t, "env-token", cfg.Discord.BotToken)
		require.Equal(t, "env-template", cfg.Argo.WorkflowTemplate)
		require.Equal(t, "postgres://override", cfg.Postgres.DSN)
		require.Equal(t, ":8080", cfg.Server.ListenAddress)
		require.False(t, cfg.Codex.Enabled)
		require.True(t, cfg.Implementer.Enabled)
		require.Equal(t, "env-implementation", cfg.Implementer.WorkflowTemplate)
	})

	t.Run("missing required fields", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "facteur.yaml")
		data := []byte(`discord:
  bot_token: file-token
redis:
  url: redis://localhost:6379/0
`)
		require.NoError(t, os.WriteFile(path, data, 0o600))

		_, err := config.LoadWithOptions(config.Options{Path: path, EnvPrefix: "FACTEUR"})
		require.Error(t, err)
		require.Contains(t, err.Error(), "discord.application_id is required")
		require.Contains(t, err.Error(), "argo.namespace is required")
		require.Contains(t, err.Error(), "postgres.dsn is required")
	})

	t.Run("env only", func(t *testing.T) {
		t.Setenv("FACTEUR_DISCORD_BOT_TOKEN", "token")
		t.Setenv("FACTEUR_DISCORD_APPLICATION_ID", "app")
		t.Setenv("FACTEUR_REDIS_URL", "redis://localhost:6379/1")
		t.Setenv("FACTEUR_ARGO_NAMESPACE", "argo-workflows")
		t.Setenv("FACTEUR_ARGO_WORKFLOW_TEMPLATE", "template")
		t.Setenv("FACTEUR_POSTGRES_DSN", "postgres://facteur:facteur@localhost:5432/facteur?sslmode=disable")
		cfg, err := config.LoadWithOptions(config.Options{EnvPrefix: "FACTEUR"})
		require.NoError(t, err)
		require.Equal(t, "token", cfg.Discord.BotToken)
		require.Equal(t, "app", cfg.Discord.ApplicationID)
		require.Equal(t, "redis://localhost:6379/1", cfg.Redis.URL)
		require.Equal(t, "postgres://facteur:facteur@localhost:5432/facteur?sslmode=disable", cfg.Postgres.DSN)
		require.Equal(t, ":8080", cfg.Server.ListenAddress)
		require.NotNil(t, cfg.RoleMap)
		require.Empty(t, cfg.RoleMap)
		require.False(t, cfg.Codex.Enabled)
		require.False(t, cfg.Implementer.Enabled)
		require.NotNil(t, cfg.Implementer.Parameters)
		require.Empty(t, cfg.Implementer.Parameters)
	})

	t.Run("validates codex listener when enabled", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "facteur.yaml")
		data := []byte(`discord:
  bot_token: token
  application_id: app
redis:
  url: redis://localhost:6379/0
postgres:
  dsn: postgres://facteur:facteur@localhost:5432/facteur?sslmode=disable
argo:
  namespace: argo
  workflow_template: template
codex_listener:
  enabled: true
`)
		require.NoError(t, os.WriteFile(path, data, 0o600))

		_, err := config.LoadWithOptions(config.Options{Path: path, EnvPrefix: "FACTEUR"})
		require.Error(t, err)
		require.Contains(t, err.Error(), "codex_listener.brokers is required when enabled")
		require.Contains(t, err.Error(), "codex_listener.topic is required when enabled")
	})
}

func TestLoadUsesDefaultOptions(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "facteur.yaml")
	data := []byte(`discord:
  bot_token: token
  application_id: app
  public_key: key
  guild_id: guild
redis:
  url: redis://localhost:6379/0
postgres:
  dsn: postgres://facteur:facteur@localhost:5432/facteur?sslmode=disable
argo:
  namespace: argo
  workflow_template: template
  service_account: sa
`)
	require.NoError(t, os.WriteFile(path, data, 0o600))

	cfg, err := config.Load(path)
	require.NoError(t, err)
	require.Equal(t, "token", cfg.Discord.BotToken)
	require.Equal(t, "sa", cfg.Argo.ServiceAccount)
}
