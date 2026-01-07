package config

import (
	"errors"
	"fmt"
	"strings"

	"github.com/spf13/viper"
)

// Config captures runtime configuration for the facteur service.
type Config struct {
	Discord     DiscordConfig       `mapstructure:"discord"`
	Redis       RedisConfig         `mapstructure:"redis"`
	Argo        ArgoConfig          `mapstructure:"argo"`
	RoleMap     map[string][]string `mapstructure:"role_map"`
	Server      ServerConfig        `mapstructure:"server"`
	Codex       CodexListenerConfig `mapstructure:"codex_listener"`
	Implementer ImplementerConfig   `mapstructure:"codex_implementation_orchestrator"`
	Postgres    DatabaseConfig      `mapstructure:"postgres"`
}

// DiscordConfig aggregates Discord bot credentials and routing data.
type DiscordConfig struct {
	BotToken      string `mapstructure:"bot_token"`
	ApplicationID string `mapstructure:"application_id"`
	PublicKey     string `mapstructure:"public_key"`
	GuildID       string `mapstructure:"guild_id"`
}

// RedisConfig identifies the Redis DSN for session storage.
type RedisConfig struct {
	URL string `mapstructure:"url"`
}

// ArgoConfig contains the settings necessary to submit workflows.
type ArgoConfig struct {
	Namespace        string            `mapstructure:"namespace"`
	WorkflowTemplate string            `mapstructure:"workflow_template"`
	ServiceAccount   string            `mapstructure:"service_account"`
	Parameters       map[string]string `mapstructure:"parameters"`
}

// ImplementerConfig controls Facteur-led Codex implementation orchestration behaviour.
type ImplementerConfig struct {
	Enabled                      bool              `mapstructure:"enabled"`
	Namespace                    string            `mapstructure:"namespace"`
	AutonomousNamespace          string            `mapstructure:"autonomous_namespace"`
	WorkflowTemplate             string            `mapstructure:"workflow_template"`
	AutonomousWorkflowTemplate   string            `mapstructure:"autonomous_workflow_template"`
	ServiceAccount               string            `mapstructure:"service_account"`
	AutonomousServiceAccount     string            `mapstructure:"autonomous_service_account"`
	Parameters                   map[string]string `mapstructure:"parameters"`
	AutonomousGenerateNamePrefix string            `mapstructure:"autonomous_generate_name_prefix"`
	JudgePrompt                  string            `mapstructure:"judge_prompt"`
}

// ServerConfig contains HTTP server runtime options.
type ServerConfig struct {
	ListenAddress string `mapstructure:"listen_address"`
}

// CodexListenerConfig captures Kafka settings for the structured Codex task stream.
type CodexListenerConfig struct {
	Enabled bool            `mapstructure:"enabled"`
	Brokers []string        `mapstructure:"brokers"`
	Topic   string          `mapstructure:"topic"`
	GroupID string          `mapstructure:"group_id"`
	TLS     KafkaTLSConfig  `mapstructure:"tls"`
	SASL    KafkaSASLConfig `mapstructure:"sasl"`
}

// KafkaTLSConfig toggles TLS behaviour for Kafka clients.
type KafkaTLSConfig struct {
	Enabled            bool `mapstructure:"enabled"`
	InsecureSkipVerify bool `mapstructure:"insecure_skip_verify"`
}

// KafkaSASLConfig captures SASL auth for Kafka clients.
type KafkaSASLConfig struct {
	Enabled   bool   `mapstructure:"enabled"`
	Mechanism string `mapstructure:"mechanism"`
	Username  string `mapstructure:"username"`
	Password  string `mapstructure:"password"`
}

// DatabaseConfig identifies the Postgres DSN used for application storage.
type DatabaseConfig struct {
	DSN string `mapstructure:"dsn"`
}

// Options customises how configuration should be loaded.
type Options struct {
	Path      string
	EnvPrefix string
}

// Load parses configuration from YAML and environment variables.
func Load(path string) (*Config, error) {
	return LoadWithOptions(Options{Path: path, EnvPrefix: "FACTEUR"})
}

// LoadWithOptions provides additional control for tests.
func LoadWithOptions(opts Options) (*Config, error) {
	if opts.EnvPrefix == "" {
		opts.EnvPrefix = "FACTEUR"
	}

	v := viper.New()
	v.SetEnvPrefix(opts.EnvPrefix)
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	v.AutomaticEnv()
	for _, binding := range []struct {
		key  string
		envs []string
	}{
		{key: "discord.bot_token"},
		{key: "discord.application_id"},
		{key: "discord.public_key"},
		{key: "discord.guild_id"},
		{key: "redis.url"},
		{key: "postgres.dsn"},
		{key: "argo.namespace"},
		{key: "argo.workflow_template"},
		{key: "argo.service_account"},
		{key: "argo.parameters"},
		{key: "role_map"},
		{key: "server.listen_address"},
		{key: "codex_listener.enabled"},
		{key: "codex_listener.brokers"},
		{key: "codex_listener.topic"},
		{key: "codex_listener.group_id"},
		{key: "codex_listener.tls.enabled"},
		{key: "codex_listener.tls.insecure_skip_verify"},
		{key: "codex_listener.sasl.enabled"},
		{key: "codex_listener.sasl.mechanism"},
		{key: "codex_listener.sasl.username"},
		{key: "codex_listener.sasl.password"},
		{
			key:  "codex_implementation_orchestrator.enabled",
			envs: []string{"FACTEUR_CODEX_ENABLE_IMPLEMENTATION_ORCHESTRATION"},
		},
		{key: "codex_implementation_orchestrator.namespace"},
		{key: "codex_implementation_orchestrator.autonomous_namespace"},
		{key: "codex_implementation_orchestrator.workflow_template"},
		{key: "codex_implementation_orchestrator.autonomous_workflow_template"},
		{key: "codex_implementation_orchestrator.service_account"},
		{key: "codex_implementation_orchestrator.autonomous_service_account"},
		{key: "codex_implementation_orchestrator.parameters"},
		{key: "codex_implementation_orchestrator.autonomous_generate_name_prefix"},
		{key: "codex_implementation_orchestrator.judge_prompt"},
	} {
		if len(binding.envs) == 0 {
			if err := v.BindEnv(binding.key); err != nil {
				return nil, fmt.Errorf("bind env %s: %w", binding.key, err)
			}
			continue
		}
		args := append([]string{binding.key}, binding.envs...)
		if err := v.BindEnv(args...); err != nil {
			return nil, fmt.Errorf("bind env %s: %w", binding.key, err)
		}
	}

	if opts.Path != "" {
		v.SetConfigFile(opts.Path)
		if err := v.ReadInConfig(); err != nil {
			return nil, fmt.Errorf("load configuration: %w", err)
		}
	}

	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return nil, fmt.Errorf("decode configuration: %w", err)
	}

	normaliseConfig(&cfg)

	if err := validate(cfg); err != nil {
		return nil, err
	}

	return &cfg, nil
}

func normaliseConfig(cfg *Config) {
	if cfg.RoleMap == nil {
		cfg.RoleMap = map[string][]string{}
	}
	if cfg.Argo.Parameters == nil {
		cfg.Argo.Parameters = map[string]string{}
	}
	if cfg.Implementer.Parameters == nil {
		cfg.Implementer.Parameters = map[string]string{}
	}
	if cfg.Server.ListenAddress == "" {
		cfg.Server.ListenAddress = ":8080"
	}
	if cfg.Codex.GroupID == "" {
		cfg.Codex.GroupID = "facteur-codex-listener"
	}
}

func validate(cfg Config) error {
	var errs []string

	if cfg.Discord.BotToken == "" {
		err := "discord.bot_token is required"
		errs = append(errs, err)
	}
	if cfg.Discord.ApplicationID == "" {
		errs = append(errs, "discord.application_id is required")
	}
	if cfg.Redis.URL == "" {
		errs = append(errs, "redis.url is required")
	}
	if cfg.Postgres.DSN == "" {
		errs = append(errs, "postgres.dsn is required")
	}
	if cfg.Argo.Namespace == "" {
		errs = append(errs, "argo.namespace is required")
	}
	if cfg.Argo.WorkflowTemplate == "" {
		errs = append(errs, "argo.workflow_template is required")
	}
	if cfg.Codex.Enabled {
		if len(cfg.Codex.Brokers) == 0 {
			errs = append(errs, "codex_listener.brokers is required when enabled")
		}
		if cfg.Codex.Topic == "" {
			errs = append(errs, "codex_listener.topic is required when enabled")
		}
		if cfg.Codex.GroupID == "" {
			errs = append(errs, "codex_listener.group_id is required when enabled")
		}
	}

	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}

	return nil
}
