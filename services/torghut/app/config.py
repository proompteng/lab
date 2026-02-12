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
    trading_price_table: str = Field(default="torghut.ta_microbars", alias="TRADING_PRICE_TABLE")
    trading_price_lookback_minutes: int = Field(default=5, alias="TRADING_PRICE_LOOKBACK_MINUTES")
    trading_poll_ms: int = Field(default=5000, alias="TRADING_POLL_MS")
    trading_reconcile_ms: int = Field(default=15000, alias="TRADING_RECONCILE_MS")
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
    trading_strategy_runtime_mode: Literal["legacy", "plugin_v3"] = Field(
        default="legacy",
        alias="TRADING_STRATEGY_RUNTIME_MODE",
        description="Strategy runtime mode. legacy keeps current behavior; plugin_v3 enables plugin scaffolding.",
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
    trading_universe_source: Literal["jangar", "static"] = Field(
        default="static", alias="TRADING_UNIVERSE_SOURCE"
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
    trading_jangar_symbols_url: Optional[str] = Field(default=None, alias="JANGAR_SYMBOLS_URL")
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
