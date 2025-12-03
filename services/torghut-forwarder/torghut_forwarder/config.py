from __future__ import annotations

from functools import lru_cache
from typing import List, Optional

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _split_symbols(value: str) -> List[str]:
    return [item.strip().upper() for item in value.split(",") if item.strip()]


class Settings(BaseSettings):
    """Runtime configuration driven by environment variables."""

    model_config = SettingsConfigDict(env_prefix="", extra="ignore")

    alpaca_api_key: str = Field(alias="ALPACA_API_KEY_ID")
    alpaca_secret_key: str = Field(alias="ALPACA_SECRET_KEY")
    alpaca_feed: str = Field("sip", alias="ALPACA_FEED")
    alpaca_stream_url: Optional[str] = Field(None, alias="ALPACA_STREAM_URL")

    symbols: List[str] = Field(default_factory=lambda: ["SPY", "QQQ"], alias="ALPACA_SYMBOLS")
    enable_trade_updates: bool = Field(False, alias="ENABLE_TRADE_UPDATES")

    kafka_bootstrap_servers: str = Field(
        "kafka-kafka-bootstrap.kafka:9092", alias="KAFKA_BOOTSTRAP_SERVERS"
    )
    kafka_username: str = Field(alias="KAFKA_USERNAME")
    kafka_password: str = Field(alias="KAFKA_PASSWORD")
    kafka_security_protocol: str = Field("SASL_PLAINTEXT", alias="KAFKA_SECURITY_PROTOCOL")
    kafka_sasl_mechanism: str = Field("SCRAM-SHA-512", alias="KAFKA_SASL_MECHANISM")

    topic_trades: str = Field("alpaca.trades.v1", alias="TOPIC_TRADES")
    topic_quotes: str = Field("alpaca.quotes.v1", alias="TOPIC_QUOTES")
    topic_bars: str = Field("alpaca.bars.1m.v1", alias="TOPIC_BARS")
    topic_status: str = Field("alpaca.status.v1", alias="TOPIC_STATUS")

    producer_linger_ms: int = Field(50, alias="PRODUCER_LINGER_MS")
    producer_batch_size: Optional[int] = Field(None, alias="PRODUCER_BATCH_SIZE")
    producer_compression: str = Field("lz4", alias="PRODUCER_COMPRESSION")
    producer_max_request_size: int = Field(1_000_000, alias="PRODUCER_MAX_REQUEST_SIZE")

    dedup_ttl_seconds: int = Field(900, alias="DEDUP_TTL_SECONDS")
    dedup_max_keys: int = Field(50_000, alias="DEDUP_MAX_KEYS")

    reconnect_initial: float = Field(1.0, alias="RECONNECT_INITIAL")
    reconnect_max: float = Field(60.0, alias="RECONNECT_MAX")

    metrics_host: str = Field("0.0.0.0", alias="METRICS_HOST")
    metrics_port: int = Field(8080, alias="METRICS_PORT")

    log_level: str = Field("info", alias="LOG_LEVEL")

    @field_validator("symbols", mode="before")
    @classmethod
    def _parse_symbols(cls, value: object) -> List[str]:
        if isinstance(value, str):
            return _split_symbols(value)
        if isinstance(value, (list, tuple)):
            return [str(item).upper() for item in value]
        return ["SPY"]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
