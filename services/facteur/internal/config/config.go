package config

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/viper"
	"gopkg.in/yaml.v3"
)

// Config captures runtime configuration for the facteur service.
type Config struct {
	Discord       DiscordConfig       `mapstructure:"discord"`
	Redis         RedisConfig         `mapstructure:"redis"`
	Argo          ArgoConfig          `mapstructure:"argo"`
	RoleMap       map[string][]string `mapstructure:"role_map"`
	Server        ServerConfig        `mapstructure:"server"`
	Codex         CodexListenerConfig `mapstructure:"codex_listener"`
	Planner       PlannerConfig       `mapstructure:"codex_orchestrator"`
	Postgres      DatabaseConfig      `mapstructure:"postgres"`
	CodexDispatch CodexDispatchConfig `mapstructure:"codex_dispatch"`
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

// PlannerConfig controls Facteur-led Codex orchestration behaviour.
type PlannerConfig struct {
	Enabled          bool              `mapstructure:"enabled"`
	Namespace        string            `mapstructure:"namespace"`
	WorkflowTemplate string            `mapstructure:"workflow_template"`
	ServiceAccount   string            `mapstructure:"service_account"`
	Parameters       map[string]string `mapstructure:"parameters"`
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

// CodexDispatchConfig governs Codex-triggered workflow submissions.
type CodexDispatchConfig struct {
	PlanningEnabled  bool              `mapstructure:"planning_enabled"`
	PayloadOverrides map[string]string `mapstructure:"payload_overrides"`
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
			key:  "codex_orchestrator.enabled",
			envs: []string{"FACTEUR_CODEX_ORCHESTRATOR_ENABLED", "FACTEUR_CODEX_ENABLE_PLANNING_ORCHESTRATION"},
		},
		{key: "codex_orchestrator.namespace"},
		{key: "codex_orchestrator.workflow_template"},
		{key: "codex_orchestrator.service_account"},
		{key: "codex_orchestrator.parameters"},
		{key: "codex_dispatch.planning_enabled"},
		{key: "codex_dispatch.payload_overrides"},
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

	cfg.CodexDispatch.PayloadOverrides = mergePayloadOverridesCaseSensitive(opts, cfg.CodexDispatch.PayloadOverrides)

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
	if cfg.Planner.Parameters == nil {
		cfg.Planner.Parameters = map[string]string{}
	}
	if cfg.Server.ListenAddress == "" {
		cfg.Server.ListenAddress = ":8080"
	}
	if cfg.Codex.GroupID == "" {
		cfg.Codex.GroupID = "facteur-codex-listener"
	}
	if cfg.CodexDispatch.PayloadOverrides == nil {
		cfg.CodexDispatch.PayloadOverrides = map[string]string{}
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

func mergePayloadOverridesCaseSensitive(opts Options, fallback map[string]string) map[string]string {
	caseSensitive := map[string]string{}
	keyIndex := map[string]string{}

	set := func(key, value string) {
		if key == "" {
			return
		}
		lower := strings.ToLower(key)
		if existingKey, ok := keyIndex[lower]; ok && existingKey != key {
			delete(caseSensitive, existingKey)
		}
		caseSensitive[key] = value
		keyIndex[lower] = key
	}

	for k, v := range readPayloadOverridesFromFile(opts.Path) {
		set(k, v)
	}

	for k, v := range readPayloadOverridesFromEnv(opts.EnvPrefix) {
		set(k, v)
	}

	if len(caseSensitive) == 0 {
		if fallback == nil {
			return map[string]string{}
		}
		return fallback
	}

	for k, v := range fallback {
		if _, ok := keyIndex[strings.ToLower(k)]; ok {
			continue
		}
		set(k, v)
	}

	return caseSensitive
}

func readPayloadOverridesFromFile(path string) map[string]string {
	if path == "" {
		return nil
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}

	var root map[string]any
	if err := yaml.Unmarshal(data, &root); err != nil {
		return nil
	}

	dispatchRaw, ok := root["codex_dispatch"]
	if !ok {
		return nil
	}

	dispatchMap, ok := dispatchRaw.(map[string]any)
	if !ok {
		return nil
	}

	overridesRaw, ok := dispatchMap["payload_overrides"]
	if !ok {
		return nil
	}

	overrideMap, ok := overridesRaw.(map[string]any)
	if !ok {
		return nil
	}

	result := make(map[string]string, len(overrideMap))
	for key, value := range overrideMap {
		result[key] = fmt.Sprint(value)
	}

	return result
}

func readPayloadOverridesFromEnv(prefix string) map[string]string {
	upperPrefix := strings.ToUpper(prefix)
	if upperPrefix == "" {
		upperPrefix = "FACTEUR"
	}
	envPrefix := upperPrefix + "_CODEX_DISPATCH_PAYLOAD_OVERRIDES__"

	result := map[string]string{}
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, envPrefix) {
			continue
		}
		pair := strings.TrimPrefix(entry, envPrefix)
		parts := strings.SplitN(pair, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := parts[0]
		value := parts[1]
		result[key] = value
	}

	return result
}
