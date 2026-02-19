"""Application configuration for the torghut service."""

from functools import lru_cache
from typing import Any, List, Literal, Optional

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Environment-backed settings."""

    app_env: Literal["dev", "stage", "prod"] = Field(
        default="dev", alias="APP_ENV", description="Deployment environment."
    )
    db_dsn: str = Field(
        default="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        alias="DB_DSN",
        validation_alias=AliasChoices("DB_DSN", "DB_URL", "DATABASE_URL"),
        description="PostgreSQL connection string.",
    )
    apca_api_key_id: Optional[str] = Field(default=None, alias="APCA_API_KEY_ID")
    apca_api_secret_key: Optional[str] = Field(default=None, alias="APCA_API_SECRET_KEY")
    apca_api_base_url: Optional[str] = Field(default=None, alias="APCA_API_BASE_URL")
    apca_data_api_base_url: Optional[str] = Field(default=None, alias="APCA_DATA_API_BASE_URL")

    trading_enabled: bool = Field(default=False, alias="TRADING_ENABLED")
    trading_mode: Literal["paper", "live"] = Field(default="paper", alias="TRADING_MODE")
    trading_live_enabled: bool = Field(default=False, alias="TRADING_LIVE_ENABLED")
    trading_signal_source: Literal["clickhouse"] = Field(default="clickhouse", alias="TRADING_SIGNAL_SOURCE")
    trading_signal_table: str = Field(default="torghut.ta_signals", alias="TRADING_SIGNAL_TABLE")
    trading_signal_schema: Literal["auto", "envelope", "flat"] = Field(
        default="auto", alias="TRADING_SIGNAL_SCHEMA"
    )
    trading_signal_batch_size: int = Field(default=500, alias="TRADING_SIGNAL_BATCH_SIZE")
    trading_signal_lookback_minutes: int = Field(default=15, alias="TRADING_SIGNAL_LOOKBACK_MINUTES")
    trading_signal_empty_batch_advance_seconds: int = Field(
        default=60,
        alias="TRADING_SIGNAL_EMPTY_BATCH_ADVANCE_SECONDS",
        description="How far to move the cursor forward when a poll returns no new signals.",
    )
    trading_signal_no_signal_streak_alert_threshold: int = Field(
        default=2,
        alias="TRADING_SIGNAL_NO_SIGNAL_STREAK_ALERT_THRESHOLD",
        description="Consecutive no-signal batches before emitting a source continuity alert.",
    )
    trading_signal_stale_lag_alert_seconds: int = Field(
        default=300,
        alias="TRADING_SIGNAL_STALE_LAG_ALERT_SECONDS",
        description="Signal lag threshold (seconds) that triggers a source continuity alert.",
    )
    trading_price_table: str = Field(default="torghut.ta_microbars", alias="TRADING_PRICE_TABLE")
    trading_price_lookback_minutes: int = Field(default=5, alias="TRADING_PRICE_LOOKBACK_MINUTES")
    trading_poll_ms: int = Field(default=5000, alias="TRADING_POLL_MS")
    trading_reconcile_ms: int = Field(default=15000, alias="TRADING_RECONCILE_MS")
    trading_order_feed_enabled: bool = Field(default=False, alias="TRADING_ORDER_FEED_ENABLED")
    trading_order_feed_bootstrap_servers: Optional[str] = Field(
        default=None,
        alias="TRADING_ORDER_FEED_BOOTSTRAP_SERVERS",
        description="Comma-separated Kafka bootstrap servers for trade update ingestion.",
    )
    trading_order_feed_topic: str = Field(
        default="torghut.trade-updates.v1",
        alias="TRADING_ORDER_FEED_TOPIC",
        description="Canonical order update topic.",
    )
    trading_order_feed_group_id: str = Field(
        default="torghut-order-feed-v1",
        alias="TRADING_ORDER_FEED_GROUP_ID",
        description="Consumer group id for order-feed ingestion.",
    )
    trading_order_feed_client_id: str = Field(
        default="torghut-order-feed",
        alias="TRADING_ORDER_FEED_CLIENT_ID",
        description="Kafka client id for order-feed ingestion.",
    )
    trading_order_feed_auto_offset_reset: Literal["latest", "earliest"] = Field(
        default="latest",
        alias="TRADING_ORDER_FEED_AUTO_OFFSET_RESET",
        description="Offset reset behavior when consumer group has no committed offsets.",
    )
    trading_order_feed_poll_ms: int = Field(
        default=250,
        alias="TRADING_ORDER_FEED_POLL_MS",
        description="Kafka poll timeout in milliseconds for order-feed ingestion.",
    )
    trading_order_feed_batch_size: int = Field(
        default=200,
        alias="TRADING_ORDER_FEED_BATCH_SIZE",
        description="Max messages processed per order-feed poll.",
    )
    trading_strategy_config_path: Optional[str] = Field(
        default=None,
        alias="TRADING_STRATEGY_CONFIG_PATH",
        description="Optional path to a strategy catalog file (YAML/JSON).",
    )
    trading_strategy_config_mode: Literal["merge", "sync"] = Field(
        default="merge",
        alias="TRADING_STRATEGY_CONFIG_MODE",
        description="Merge keeps existing strategies; sync disables missing strategies.",
    )
    trading_strategy_reload_seconds: int = Field(
        default=10,
        alias="TRADING_STRATEGY_RELOAD_SECONDS",
        description="Seconds between strategy catalog reload checks.",
    )
    trading_strategy_runtime_mode: Literal["legacy", "plugin_v3", "scheduler_v3"] = Field(
        default="legacy",
        alias="TRADING_STRATEGY_RUNTIME_MODE",
        description=(
            "Strategy runtime mode. legacy keeps current behavior; plugin_v3 enables plugin scaffolding; "
            "scheduler_v3 enables scheduler integration behind migration flag."
        ),
    )
    trading_strategy_scheduler_enabled: bool = Field(
        default=False,
        alias="TRADING_STRATEGY_SCHEDULER_ENABLED",
        description="Migration flag for scheduler-integrated strategy runtime path.",
    )
    trading_strategy_runtime_fallback_legacy: bool = Field(
        default=True,
        alias="TRADING_STRATEGY_RUNTIME_FALLBACK_LEGACY",
        description="Fallback to legacy decision path when scheduler runtime yields no intents or errors.",
    )
    trading_strategy_runtime_circuit_errors: int = Field(
        default=3,
        alias="TRADING_STRATEGY_RUNTIME_CIRCUIT_ERRORS",
        description="Consecutive strategy plugin errors before temporary degradation.",
    )
    trading_strategy_runtime_circuit_cooldown_seconds: int = Field(
        default=300,
        alias="TRADING_STRATEGY_RUNTIME_CIRCUIT_COOLDOWN_SECONDS",
        description="Cooldown duration for degraded plugins in scheduler runtime mode.",
    )
    trading_feature_schema_version: str = Field(
        default="v3",
        alias="TRADING_FEATURE_SCHEMA_VERSION",
        description="Feature contract schema version for normalized strategy input.",
    )
    trading_feature_normalization_version: str = Field(
        default="v1",
        alias="TRADING_FEATURE_NORMALIZATION_VERSION",
        description="Feature normalization implementation version.",
    )
    trading_feature_quality_enabled: bool = Field(
        default=True,
        alias="TRADING_FEATURE_QUALITY_ENABLED",
        description="Fail closed on feature schema/freshness/data-quality violations.",
    )
    trading_feature_max_required_null_rate: float = Field(
        default=0.01,
        alias="TRADING_FEATURE_MAX_REQUIRED_NULL_RATE",
        description="Maximum allowed null-rate for required canonical v3 feature fields.",
    )
    trading_feature_max_staleness_ms: int = Field(
        default=120000,
        alias="TRADING_FEATURE_MAX_STALENESS_MS",
        description="Maximum allowed p95 feature staleness in milliseconds per batch.",
    )
    trading_feature_max_duplicate_ratio: float = Field(
        default=0.02,
        alias="TRADING_FEATURE_MAX_DUPLICATE_RATIO",
        description="Maximum duplicate event ratio per ingest batch.",
    )
    trading_autonomy_enabled: bool = Field(default=False, alias="TRADING_AUTONOMY_ENABLED")
    trading_autonomy_allow_live_promotion: bool = Field(
        default=False,
        alias="TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION",
        description="Safety gate for autonomous promotion actions; live stays disabled by default.",
    )
    trading_autonomy_approval_token: Optional[str] = Field(
        default=None,
        alias="TRADING_AUTONOMY_APPROVAL_TOKEN",
        description="Optional approval token for live promotion when required by policy.",
    )
    trading_autonomy_gate_policy_path: Optional[str] = Field(
        default=None,
        alias="TRADING_AUTONOMY_GATE_POLICY_PATH",
        description="Optional path to v3 autonomous gate policy config JSON.",
    )
    trading_autonomy_interval_seconds: int = Field(default=300, alias="TRADING_AUTONOMY_INTERVAL_SECONDS")
    trading_autonomy_signal_lookback_minutes: int = Field(
        default=15,
        alias="TRADING_AUTONOMY_SIGNAL_LOOKBACK_MINUTES",
        description="Lookback window for signals passed to autonomous lane runs.",
    )
    trading_autonomy_artifact_dir: str = Field(
        default="/tmp/torghut-autonomy",
        alias="TRADING_AUTONOMY_ARTIFACT_DIR",
        description="Output directory for autonomous lane artifacts.",
    )
    trading_evidence_continuity_enabled: bool = Field(
        default=True,
        alias="TRADING_EVIDENCE_CONTINUITY_ENABLED",
        description="Enable periodic research evidence continuity reconciliation checks.",
    )
    trading_evidence_continuity_interval_seconds: int = Field(
        default=86400,
        alias="TRADING_EVIDENCE_CONTINUITY_INTERVAL_SECONDS",
        description="Interval between evidence continuity checks.",
    )
    trading_evidence_continuity_run_limit: int = Field(
        default=8,
        alias="TRADING_EVIDENCE_CONTINUITY_RUN_LIMIT",
        description="How many latest non-skipped research runs to check for continuity.",
    )
    trading_universe_source: Literal["jangar", "static"] = Field(
        default="static", alias="TRADING_UNIVERSE_SOURCE"
    )
    trading_universe_require_non_empty_jangar: bool = Field(
        default=True,
        alias="TRADING_UNIVERSE_REQUIRE_NON_EMPTY_JANGAR",
        description="Fail closed when Jangar-backed universe cannot be resolved to a non-empty symbol set.",
    )
    trading_universe_max_stale_seconds: int = Field(
        default=900,
        alias="TRADING_UNIVERSE_MAX_STALE_SECONDS",
        description="Maximum age for cached Jangar symbol universe before it is treated as stale.",
    )
    trading_static_symbols_raw: Optional[str] = Field(default=None, alias="TRADING_STATIC_SYMBOLS")
    trading_universe_cache_seconds: int = Field(default=300, alias="TRADING_UNIVERSE_CACHE_SECONDS")
    trading_universe_timeout_seconds: int = Field(default=5, alias="TRADING_UNIVERSE_TIMEOUT_SECONDS")
    trading_default_qty: int = Field(default=1, alias="TRADING_DEFAULT_QTY")
    trading_max_notional_per_trade: Optional[float] = Field(
        default=None, alias="TRADING_MAX_NOTIONAL_PER_TRADE"
    )
    trading_min_notional_per_trade: Optional[float] = Field(
        default=None, alias="TRADING_MIN_NOTIONAL_PER_TRADE"
    )
    trading_max_participation_rate: Optional[float] = Field(
        default=None, alias="TRADING_MAX_PARTICIPATION_RATE"
    )
    trading_execution_prefer_limit: bool = Field(default=True, alias="TRADING_EXECUTION_PREFER_LIMIT")
    trading_execution_max_retries: int = Field(default=0, alias="TRADING_EXECUTION_MAX_RETRIES")
    trading_execution_backoff_base_seconds: float = Field(
        default=0.25, alias="TRADING_EXECUTION_BACKOFF_BASE_SECONDS"
    )
    trading_execution_backoff_multiplier: float = Field(
        default=2.0, alias="TRADING_EXECUTION_BACKOFF_MULTIPLIER"
    )
    trading_execution_backoff_max_seconds: float = Field(
        default=2.0, alias="TRADING_EXECUTION_BACKOFF_MAX_SECONDS"
    )
    trading_execution_adapter: Literal["alpaca", "lean"] = Field(
        default="alpaca",
        alias="TRADING_EXECUTION_ADAPTER",
        description="Primary execution adapter selection.",
    )
    trading_execution_fallback_adapter: Literal["none", "alpaca"] = Field(
        default="alpaca",
        alias="TRADING_EXECUTION_FALLBACK_ADAPTER",
        description="Fallback adapter when primary adapter fails.",
    )
    trading_execution_adapter_policy: Literal["all", "allowlist"] = Field(
        default="allowlist",
        alias="TRADING_EXECUTION_ADAPTER_POLICY",
        description="Execution adapter routing policy.",
    )
    trading_execution_adapter_symbols_raw: Optional[str] = Field(
        default=None,
        alias="TRADING_EXECUTION_ADAPTER_SYMBOLS",
        description="Comma-separated symbol allowlist for adapter routing.",
    )
    trading_lean_runner_url: Optional[str] = Field(
        default=None,
        alias="TRADING_LEAN_RUNNER_URL",
        description="Base URL for LEAN runner API.",
    )
    trading_lean_runner_timeout_seconds: int = Field(
        default=5,
        alias="TRADING_LEAN_RUNNER_TIMEOUT_SECONDS",
        description="HTTP timeout for LEAN runner calls.",
    )
    trading_max_position_pct_equity: Optional[float] = Field(
        default=None, alias="TRADING_MAX_POSITION_PCT_EQUITY"
    )
    trading_portfolio_notional_per_position: Optional[float] = Field(
        default=None,
        alias="TRADING_PORTFOLIO_NOTIONAL_PER_POSITION",
        description="Target notional per position for portfolio sizing (optional).",
    )
    trading_portfolio_volatility_target: Optional[float] = Field(
        default=None,
        alias="TRADING_PORTFOLIO_VOLATILITY_TARGET",
        description="Volatility target for portfolio sizing (optional).",
    )
    trading_portfolio_volatility_floor: float = Field(
        default=0.0,
        alias="TRADING_PORTFOLIO_VOLATILITY_FLOOR",
        description="Floor used when scaling by volatility (default 0).",
    )
    trading_portfolio_max_positions: Optional[int] = Field(
        default=None,
        alias="TRADING_PORTFOLIO_MAX_POSITIONS",
        description="Max concurrent positions allowed (optional).",
    )
    trading_portfolio_max_notional_per_symbol: Optional[float] = Field(
        default=None,
        alias="TRADING_PORTFOLIO_MAX_NOTIONAL_PER_SYMBOL",
        description="Max notional per symbol for portfolio sizing (optional).",
    )
    trading_portfolio_max_gross_exposure: Optional[float] = Field(
        default=None,
        alias="TRADING_PORTFOLIO_MAX_GROSS_EXPOSURE",
        description="Absolute gross exposure cap (optional).",
    )
    trading_portfolio_max_gross_exposure_pct_equity: Optional[float] = Field(
        default=None,
        alias="TRADING_PORTFOLIO_MAX_GROSS_EXPOSURE_PCT_EQUITY",
        description="Gross exposure cap as a pct of equity (optional).",
    )
    trading_portfolio_max_net_exposure: Optional[float] = Field(
        default=None,
        alias="TRADING_PORTFOLIO_MAX_NET_EXPOSURE",
        description="Absolute net exposure cap (optional).",
    )
    trading_portfolio_max_net_exposure_pct_equity: Optional[float] = Field(
        default=None,
        alias="TRADING_PORTFOLIO_MAX_NET_EXPOSURE_PCT_EQUITY",
        description="Net exposure cap as a pct of equity (optional).",
    )
    trading_cooldown_seconds: int = Field(default=0, alias="TRADING_COOLDOWN_SECONDS")
    trading_allow_shorts: bool = Field(default=False, alias="TRADING_ALLOW_SHORTS")
    trading_account_label: str = Field(default="paper", alias="TRADING_ACCOUNT_LABEL")
    trading_kill_switch_enabled: bool = Field(default=True, alias="TRADING_KILL_SWITCH_ENABLED")
    trading_emergency_stop_enabled: bool = Field(
        default=True,
        alias="TRADING_EMERGENCY_STOP_ENABLED",
        description="Enable autonomous emergency stop hooks that block order submission after critical safety breaches.",
    )
    trading_rollback_signal_lag_seconds_limit: int = Field(
        default=600,
        alias="TRADING_ROLLBACK_SIGNAL_LAG_SECONDS_LIMIT",
        description="Signal lag threshold (seconds) that triggers autonomous emergency stop.",
    )
    trading_rollback_autonomy_failure_streak_limit: int = Field(
        default=3,
        alias="TRADING_ROLLBACK_AUTONOMY_FAILURE_STREAK_LIMIT",
        description="Consecutive autonomous lane failures allowed before emergency stop.",
    )
    trading_rollback_fallback_ratio_limit: float = Field(
        default=0.25,
        alias="TRADING_ROLLBACK_FALLBACK_RATIO_LIMIT",
        description="Execution fallback ratio threshold that triggers emergency stop.",
    )
    trading_rollback_max_drawdown_limit: float = Field(
        default=0.08,
        alias="TRADING_ROLLBACK_MAX_DRAWDOWN_LIMIT",
        description="Absolute drawdown threshold from autonomous gate artifacts that triggers emergency stop.",
    )
    trading_jangar_symbols_url: Optional[str] = Field(default=None, alias="JANGAR_SYMBOLS_URL")
    trading_market_context_url: Optional[str] = Field(
        default=None,
        alias="TRADING_MARKET_CONTEXT_URL",
        description="Jangar market-context endpoint consumed by LLM review.",
    )
    trading_market_context_timeout_seconds: int = Field(
        default=3,
        alias="TRADING_MARKET_CONTEXT_TIMEOUT_SECONDS",
        description="Timeout for market-context fetches.",
    )
    trading_market_context_required: bool = Field(
        default=False,
        alias="TRADING_MARKET_CONTEXT_REQUIRED",
        description="Require market context for LLM requests.",
    )
    trading_market_context_fail_mode: Literal["shadow_only", "fail_closed"] = Field(
        default="shadow_only",
        alias="TRADING_MARKET_CONTEXT_FAIL_MODE",
        description="How to handle missing/low-quality market context.",
    )
    trading_market_context_min_quality: float = Field(
        default=0.4,
        alias="TRADING_MARKET_CONTEXT_MIN_QUALITY",
        description="Minimum quality score for allowing LLM reviews.",
    )
    trading_market_context_max_staleness_seconds: int = Field(
        default=300,
        alias="TRADING_MARKET_CONTEXT_MAX_STALENESS_SECONDS",
        description="Maximum accepted market-context staleness.",
    )
    trading_clickhouse_url: Optional[str] = Field(default=None, alias="TA_CLICKHOUSE_URL")
    trading_clickhouse_username: Optional[str] = Field(default=None, alias="TA_CLICKHOUSE_USERNAME")
    trading_clickhouse_password: Optional[str] = Field(default=None, alias="TA_CLICKHOUSE_PASSWORD")
    trading_clickhouse_timeout_seconds: int = Field(
        default=5,
        alias="TA_CLICKHOUSE_CONN_TIMEOUT_SECONDS",
        validation_alias=AliasChoices("TA_CLICKHOUSE_CONN_TIMEOUT_SECONDS", "CLICKHOUSE_TIMEOUT_SECONDS"),
    )

    # Jangar gateway (recommended for LLM calls in-cluster).
    jangar_base_url: Optional[str] = Field(default=None, alias="JANGAR_BASE_URL")
    jangar_api_key: Optional[str] = Field(default=None, alias="JANGAR_API_KEY")

    llm_enabled: bool = Field(default=False, alias="LLM_ENABLED")
    llm_provider: Literal["jangar", "openai"] = Field(default="openai", alias="LLM_PROVIDER")
    llm_model: str = Field(default="gpt-5.3-codex", alias="LLM_MODEL")
    # Used only when `LLM_PROVIDER=jangar` and the Jangar request fails.
    # This should point at an OpenAI-compatible endpoint (e.g. vLLM, Ollama, llama.cpp server).
    llm_self_hosted_base_url: Optional[str] = Field(default=None, alias="LLM_SELF_HOSTED_BASE_URL")
    llm_self_hosted_api_key: Optional[str] = Field(default=None, alias="LLM_SELF_HOSTED_API_KEY")
    llm_self_hosted_model: Optional[str] = Field(default=None, alias="LLM_SELF_HOSTED_MODEL")
    llm_prompt_version: str = Field(default="v1", alias="LLM_PROMPT_VERSION")
    llm_temperature: float = Field(default=0.2, alias="LLM_TEMPERATURE")
    llm_max_tokens: int = Field(default=300, alias="LLM_MAX_TOKENS")
    llm_timeout_seconds: int = Field(default=20, alias="LLM_TIMEOUT_SECONDS")
    llm_jangar_bespoke_decision_enabled: bool = Field(
        default=False, alias="LLM_JANGAR_BESPOKE_DECISION_ENABLED"
    )
    llm_jangar_bespoke_timeout_seconds: int = Field(default=75, alias="LLM_JANGAR_BESPOKE_TIMEOUT_SECONDS")
    llm_jangar_bespoke_max_retries: int = Field(default=1, alias="LLM_JANGAR_BESPOKE_MAX_RETRIES")
    llm_jangar_bespoke_retry_backoff_seconds: float = Field(
        default=0.5, alias="LLM_JANGAR_BESPOKE_RETRY_BACKOFF_SECONDS"
    )
    llm_fail_mode: Literal["veto", "pass_through"] = Field(default="veto", alias="LLM_FAIL_MODE")
    llm_min_confidence: float = Field(default=0.5, alias="LLM_MIN_CONFIDENCE")
    llm_adjustment_allowed: bool = Field(default=False, alias="LLM_ADJUSTMENT_ALLOWED")
    llm_max_qty_multiplier: float = Field(default=1.25, alias="LLM_MAX_QTY_MULTIPLIER")
    llm_min_qty_multiplier: float = Field(default=0.5, alias="LLM_MIN_QTY_MULTIPLIER")
    llm_shadow_mode: bool = Field(default=False, alias="LLM_SHADOW_MODE")
    llm_recent_decisions: int = Field(default=5, alias="LLM_RECENT_DECISIONS")
    llm_circuit_max_errors: int = Field(default=3, alias="LLM_CIRCUIT_MAX_ERRORS")
    llm_circuit_window_seconds: int = Field(default=300, alias="LLM_CIRCUIT_WINDOW_SECONDS")
    llm_circuit_cooldown_seconds: int = Field(default=600, alias="LLM_CIRCUIT_COOLDOWN_SECONDS")
    llm_allowed_models_raw: Optional[str] = Field(default=None, alias="LLM_ALLOWED_MODELS")
    llm_evaluation_report: Optional[str] = Field(default=None, alias="LLM_EVALUATION_REPORT")
    llm_effective_challenge_id: Optional[str] = Field(default=None, alias="LLM_EFFECTIVE_CHALLENGE_ID")
    llm_shadow_completed_at: Optional[str] = Field(default=None, alias="LLM_SHADOW_COMPLETED_AT")
    llm_adjustment_approved: bool = Field(default=False, alias="LLM_ADJUSTMENT_APPROVED")

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    def model_post_init(self, __context: Any) -> None:
        if "trading_account_label" not in self.model_fields_set:
            self.trading_account_label = self.trading_mode
        if self.jangar_base_url:
            self.jangar_base_url = self.jangar_base_url.strip().rstrip("/")
        if self.trading_market_context_url:
            self.trading_market_context_url = self.trading_market_context_url.strip().rstrip("/")
        if self.llm_self_hosted_base_url:
            self.llm_self_hosted_base_url = self.llm_self_hosted_base_url.strip().rstrip("/")
        if self.trading_lean_runner_url:
            self.trading_lean_runner_url = self.trading_lean_runner_url.strip().rstrip("/")
        if self.trading_execution_adapter_symbols_raw:
            self.trading_execution_adapter_symbols_raw = ",".join(
                [item.strip() for item in self.trading_execution_adapter_symbols_raw.split(",") if item.strip()]
            )
        if self.trading_autonomy_approval_token:
            self.trading_autonomy_approval_token = self.trading_autonomy_approval_token.strip() or None
        if (
            (self.trading_enabled or self.trading_autonomy_enabled or self.trading_live_enabled)
            and self.trading_universe_source != "jangar"
        ):
            raise ValueError("TRADING_UNIVERSE_SOURCE must be 'jangar' when trading or autonomy is enabled")
        if "llm_provider" not in self.model_fields_set and self.jangar_base_url:
            self.llm_provider = "jangar"
        if self.llm_allowed_models_raw:
            self.llm_allowed_models_raw = ",".join(
                [item.strip() for item in self.llm_allowed_models_raw.split(",") if item.strip()]
            )
        if self.llm_evaluation_report:
            self.llm_evaluation_report = self.llm_evaluation_report.strip()
        if self.llm_effective_challenge_id:
            self.llm_effective_challenge_id = self.llm_effective_challenge_id.strip()
        if self.llm_shadow_completed_at:
            self.llm_shadow_completed_at = self.llm_shadow_completed_at.strip()

    @property
    def sqlalchemy_dsn(self) -> str:
        """Return a SQLAlchemy-friendly DSN, normalizing postgres URIs to psycopg."""

        if self.db_dsn.startswith("postgresql+psycopg://"):
            return self.db_dsn

        if self.db_dsn.startswith("postgres://"):
            return self.db_dsn.replace("postgres://", "postgresql+psycopg://", 1)

        if self.db_dsn.startswith("postgresql://"):
            return self.db_dsn.replace("postgresql://", "postgresql+psycopg://", 1)

        return self.db_dsn

    @property
    def trading_static_symbols(self) -> List[str]:
        if not self.trading_static_symbols_raw:
            return []
        return [symbol.strip() for symbol in self.trading_static_symbols_raw.split(",") if symbol.strip()]

    @property
    def trading_execution_adapter_symbols(self) -> set[str]:
        if not self.trading_execution_adapter_symbols_raw:
            return set()
        return {
            symbol.strip()
            for symbol in self.trading_execution_adapter_symbols_raw.split(",")
            if symbol.strip()
        }

    @property
    def llm_allowed_models(self) -> set[str]:
        if not self.llm_allowed_models_raw:
            return set()
        return {model.strip() for model in self.llm_allowed_models_raw.split(",") if model.strip()}


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return a cached Settings instance so values are loaded once."""

    return Settings()  # type: ignore[call-arg]


settings = get_settings()
