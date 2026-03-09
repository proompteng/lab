"""Dedicated configuration surface for the Torghut options lane."""

from __future__ import annotations

from functools import lru_cache
from typing import Annotated, Any, cast

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


def _split_csv(value: str | None) -> list[str]:
    if value is None:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


class OptionsLaneSettings(BaseSettings):
    """Environment-driven options-lane settings."""

    model_config = SettingsConfigDict(extra="ignore", case_sensitive=False)

    http_host: str = Field("0.0.0.0", validation_alias=AliasChoices("OPTIONS_HTTP_HOST"))
    http_port: int = Field(8080, validation_alias=AliasChoices("OPTIONS_HTTP_PORT"))

    sqlalchemy_dsn: str = Field(
        ...,
        validation_alias=AliasChoices("SQLALCHEMY_DSN", "DATABASE_URL", "DB_DSN"),
    )
    kafka_bootstrap: str = Field(
        "kafka-kafka-bootstrap.kafka:9092",
        validation_alias=AliasChoices("KAFKA_BOOTSTRAP"),
    )
    kafka_security_protocol: str = Field(
        "SASL_PLAINTEXT",
        validation_alias=AliasChoices("KAFKA_SECURITY_PROTOCOL"),
    )
    kafka_sasl_mechanism: str = Field(
        "SCRAM-SHA-512",
        validation_alias=AliasChoices("KAFKA_SASL_MECH"),
    )
    kafka_sasl_user: str = Field(
        "torghut-options",
        validation_alias=AliasChoices("KAFKA_SASL_USER"),
    )
    kafka_sasl_password: str = Field(
        "",
        validation_alias=AliasChoices("KAFKA_SASL_PASSWORD"),
    )
    kafka_linger_ms: int = Field(30, validation_alias=AliasChoices("KAFKA_LINGER_MS"))
    kafka_batch_size: int = Field(32768, validation_alias=AliasChoices("KAFKA_BATCH_SIZE"))
    kafka_request_timeout_ms: int = Field(
        15000, validation_alias=AliasChoices("KAFKA_REQUEST_TIMEOUT_MS")
    )

    alpaca_key_id: str = Field(
        ...,
        validation_alias=AliasChoices("ALPACA_OPTIONS_KEY_ID", "APCA_API_KEY_ID"),
    )
    alpaca_secret_key: str = Field(
        ...,
        validation_alias=AliasChoices("ALPACA_OPTIONS_SECRET_KEY", "APCA_API_SECRET_KEY"),
    )
    alpaca_feed: str = Field(
        "opra",
        validation_alias=AliasChoices("ALPACA_OPTIONS_FEED", "ALPACA_FEED"),
    )
    alpaca_contracts_base_url: str = Field(
        "https://paper-api.alpaca.markets",
        validation_alias=AliasChoices("ALPACA_OPTIONS_CONTRACTS_BASE_URL", "APCA_API_BASE_URL"),
    )
    alpaca_data_base_url: str = Field(
        "https://data.alpaca.markets",
        validation_alias=AliasChoices("ALPACA_OPTIONS_DATA_BASE_URL", "ALPACA_OPTIONS_BASE_URL"),
    )
    alpaca_stream_url: str = Field(
        "wss://stream.data.alpaca.markets",
        validation_alias=AliasChoices("ALPACA_OPTIONS_STREAM_URL"),
    )

    options_contract_discovery_interval_sec: int = Field(
        300,
        validation_alias=AliasChoices("OPTIONS_CONTRACT_DISCOVERY_INTERVAL_SEC"),
    )
    options_contract_discovery_offsession_interval_sec: int = Field(
        3600,
        validation_alias=AliasChoices("OPTIONS_CONTRACT_DISCOVERY_OFFSESSION_INTERVAL_SEC"),
    )
    options_contract_discovery_page_limit: int = Field(
        100,
        validation_alias=AliasChoices("OPTIONS_CONTRACT_DISCOVERY_PAGE_LIMIT"),
    )
    options_contract_expiration_horizon_days: int = Field(
        730,
        validation_alias=AliasChoices("OPTIONS_CONTRACT_EXPIRATION_HORIZON_DAYS"),
    )
    options_subscription_hot_cap: int = Field(
        400,
        validation_alias=AliasChoices("OPTIONS_SUBSCRIPTION_HOT_CAP"),
    )
    options_subscription_warm_cap: int = Field(
        2000,
        validation_alias=AliasChoices("OPTIONS_SUBSCRIPTION_WARM_CAP"),
    )
    options_subscription_rotation_batch_size: int = Field(
        250,
        validation_alias=AliasChoices("OPTIONS_SUBSCRIPTION_ROTATION_BATCH_SIZE"),
    )
    options_subscription_rotation_min_interval_sec: int = Field(
        30,
        validation_alias=AliasChoices("OPTIONS_SUBSCRIPTION_ROTATION_MIN_INTERVAL_SEC"),
    )
    options_provider_cap_bootstrap: int = Field(
        500,
        validation_alias=AliasChoices("OPTIONS_PROVIDER_CAP_BOOTSTRAP"),
    )

    options_snapshot_hot_interval_sec: int = Field(
        30,
        validation_alias=AliasChoices("OPTIONS_SNAPSHOT_HOT_INTERVAL_SEC"),
    )
    options_snapshot_warm_interval_sec: int = Field(
        300,
        validation_alias=AliasChoices("OPTIONS_SNAPSHOT_WARM_INTERVAL_SEC"),
    )
    options_snapshot_cold_interval_sec: int = Field(
        21600,
        validation_alias=AliasChoices("OPTIONS_SNAPSHOT_COLD_INTERVAL_SEC"),
    )
    options_snapshot_batch_size: int = Field(
        64,
        validation_alias=AliasChoices("OPTIONS_SNAPSHOT_BATCH_SIZE"),
    )
    options_backfill_max_days: int = Field(
        5,
        validation_alias=AliasChoices("OPTIONS_BACKFILL_MAX_DAYS"),
    )

    options_slo_discovery_freshness_sec: int = Field(
        300,
        validation_alias=AliasChoices("OPTIONS_SLO_DISCOVERY_FRESHNESS_SEC"),
    )
    options_slo_hot_snapshot_freshness_sec: int = Field(
        30,
        validation_alias=AliasChoices("OPTIONS_SLO_HOT_SNAPSHOT_FRESHNESS_SEC"),
    )
    options_market_holidays: Annotated[list[str], NoDecode] = Field(
        default_factory=list,
        validation_alias=AliasChoices("OPTIONS_MARKET_HOLIDAYS"),
    )
    options_underlying_priority_symbols: Annotated[list[str], NoDecode] = Field(
        default_factory=list,
        validation_alias=AliasChoices("OPTIONS_UNDERLYING_PRIORITY_SYMBOLS"),
    )

    topic_contracts: str = Field(
        "torghut.options.contracts.v1",
        validation_alias=AliasChoices("TOPIC_OPTIONS_CONTRACTS"),
    )
    topic_trades: str = Field(
        "torghut.options.trades.v1",
        validation_alias=AliasChoices("TOPIC_OPTIONS_TRADES"),
    )
    topic_quotes: str = Field(
        "torghut.options.quotes.v1",
        validation_alias=AliasChoices("TOPIC_OPTIONS_QUOTES"),
    )
    topic_snapshots: str = Field(
        "torghut.options.snapshots.v1",
        validation_alias=AliasChoices("TOPIC_OPTIONS_SNAPSHOTS"),
    )
    topic_status: str = Field(
        "torghut.options.status.v1",
        validation_alias=AliasChoices("TOPIC_OPTIONS_STATUS"),
    )

    @field_validator("options_market_holidays", "options_underlying_priority_symbols", mode="before")
    @classmethod
    def _normalize_csv_fields(cls, value: Any) -> list[str]:
        if isinstance(value, list):
            normalized: list[str] = []
            for item in cast(list[object], value):
                item_text = str(item).strip()
                if item_text:
                    normalized.append(item_text.upper())
            return normalized
        if isinstance(value, str):
            return [item.upper() for item in _split_csv(value)]
        return []

    @property
    def holiday_set(self) -> set[str]:
        return {item for item in self.options_market_holidays if item}

    @property
    def underlying_priority_set(self) -> set[str]:
        return {item for item in self.options_underlying_priority_symbols if item}


@lru_cache(maxsize=1)
def get_options_lane_settings() -> OptionsLaneSettings:
    """Return the cached options-lane settings singleton."""

    return OptionsLaneSettings()  # pyright: ignore[reportCallIssue]
