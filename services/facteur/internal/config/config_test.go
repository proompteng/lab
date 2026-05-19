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
codex_implementation_orchestrator:
  enabled: true
  agents_base_url: http://agents.agents.svc.cluster.local
  namespace: implementation
  agent_name: codex-agent
  runtime_type: job
  runtime_config:
    serviceAccountName: agents-runner
  secrets:
    - github-token
    - codex-auth
  secret_binding_ref: codex-github-token
  vcs_provider: github
  vcs_policy_mode: read-write
  vcs_required: true
  goal_token_budget: 4096
  ttl_seconds_after_finished: 86400
  parameters:
    environment: production
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
		require.Empty(t, cfg.Argo.Namespace)
		require.Empty(t, cfg.Argo.WorkflowTemplate)
		require.Empty(t, cfg.Argo.ServiceAccount)
		require.Equal(t, map[string]string{}, cfg.Argo.Parameters)
		require.True(t, cfg.Implementer.Enabled)
		require.Equal(t, "http://agents.agents.svc.cluster.local", cfg.Implementer.AgentsBaseURL)
		require.Equal(t, "implementation", cfg.Implementer.Namespace)
		require.Equal(t, "codex-agent", cfg.Implementer.AgentName)
		require.Equal(t, "job", cfg.Implementer.RuntimeType)
		require.Equal(t, map[string]any{"serviceAccountName": "agents-runner"}, cfg.Implementer.RuntimeConfig)
		require.Equal(t, []string{"github-token", "codex-auth"}, cfg.Implementer.Secrets)
		require.Equal(t, "codex-github-token", cfg.Implementer.SecretBindingRef)
		require.Equal(t, "github", cfg.Implementer.VCSProvider)
		require.Equal(t, "read-write", cfg.Implementer.VCSPolicyMode)
		require.True(t, cfg.Implementer.VCSRequired)
		require.Equal(t, 4096, cfg.Implementer.GoalTokenBudget)
		require.Equal(t, 86400, cfg.Implementer.TTLSecondsAfterFinished)
		require.Equal(t, map[string]string{"environment": "production"}, cfg.Implementer.Parameters)
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
`)
		require.NoError(t, os.WriteFile(path, data, 0o600))

		t.Setenv("FACTEUR_DISCORD_BOT_TOKEN", "env-token")
		t.Setenv("FACTEUR_POSTGRES_DSN", "postgres://override")
		t.Setenv("FACTEUR_CODEX_ENABLE_IMPLEMENTATION_ORCHESTRATION", "true")
		t.Setenv("FACTEUR_CODEX_IMPLEMENTATION_ORCHESTRATOR_AGENT_NAME", "env-codex-agent")

		cfg, err := config.LoadWithOptions(config.Options{Path: path, EnvPrefix: "FACTEUR"})
		require.NoError(t, err)
		require.Equal(t, "env-token", cfg.Discord.BotToken)
		require.Equal(t, "postgres://override", cfg.Postgres.DSN)
		require.Equal(t, ":8080", cfg.Server.ListenAddress)
		require.False(t, cfg.Codex.Enabled)
		require.True(t, cfg.Implementer.Enabled)
		require.Equal(t, "env-codex-agent", cfg.Implementer.AgentName)
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
		require.Contains(t, err.Error(), "postgres.dsn is required")
	})

	t.Run("env only", func(t *testing.T) {
		t.Setenv("FACTEUR_DISCORD_BOT_TOKEN", "token")
		t.Setenv("FACTEUR_DISCORD_APPLICATION_ID", "app")
		t.Setenv("FACTEUR_REDIS_URL", "redis://localhost:6379/1")
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
		require.NotNil(t, cfg.Implementer.Secrets)
		require.Empty(t, cfg.Implementer.Secrets)
		require.Equal(t, "http://agents.agents.svc.cluster.local", cfg.Implementer.AgentsBaseURL)
		require.Equal(t, "agents", cfg.Implementer.Namespace)
		require.Equal(t, "codex-agent", cfg.Implementer.AgentName)
		require.Equal(t, "job", cfg.Implementer.RuntimeType)
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
`)
	require.NoError(t, os.WriteFile(path, data, 0o600))

	cfg, err := config.Load(path)
	require.NoError(t, err)
	require.Equal(t, "token", cfg.Discord.BotToken)
	require.Equal(t, "http://agents.agents.svc.cluster.local", cfg.Implementer.AgentsBaseURL)
}
