"""Application configuration for the torghut service."""

from functools import lru_cache
from typing import List, Literal, Optional

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
    trading_max_position_pct_equity: Optional[float] = Field(
        default=None, alias="TRADING_MAX_POSITION_PCT_EQUITY"
    )
    trading_cooldown_seconds: int = Field(default=0, alias="TRADING_COOLDOWN_SECONDS")
    trading_account_label: str = Field(default="paper", alias="TRADING_ACCOUNT_LABEL")
    trading_jangar_symbols_url: Optional[str] = Field(default=None, alias="JANGAR_SYMBOLS_URL")
    trading_clickhouse_url: Optional[str] = Field(default=None, alias="TA_CLICKHOUSE_URL")
    trading_clickhouse_username: Optional[str] = Field(default=None, alias="TA_CLICKHOUSE_USERNAME")
    trading_clickhouse_password: Optional[str] = Field(default=None, alias="TA_CLICKHOUSE_PASSWORD")
    trading_clickhouse_timeout_seconds: int = Field(default=5, alias="TA_CLICKHOUSE_CONN_TIMEOUT_SECONDS")

    llm_enabled: bool = Field(default=False, alias="LLM_ENABLED")
    llm_model: str = Field(default="gpt-4.1-mini", alias="LLM_MODEL")
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

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

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


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return a cached Settings instance so values are loaded once."""

    return Settings()  # type: ignore[call-arg]


settings = get_settings()
