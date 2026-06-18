"""Configuration for the isolated Hyperliquid runtime lane."""

from __future__ import annotations

import os
from dataclasses import dataclass
from decimal import Decimal
from typing import Mapping


_TRUE_VALUES = {"1", "true", "yes", "y", "on"}
_FALSE_VALUES = {"0", "false", "no", "n", "off"}
_DEFAULT_ALLOWED_ASSET_CLASSES = ("stocks", "indices", "preipo")


@dataclass(frozen=True)
class HyperliquidRuntimeConfig:
    """Runtime settings intentionally separate from the legacy Alpaca settings."""

    enabled: bool
    trading_enabled: bool
    execution_network: str
    market_data_network: str
    exchange_api_url: str
    account_address: str | None
    api_wallet_private_key: str | None
    poll_interval_seconds: int
    dependency_staleness_seconds: int
    signal_staleness_seconds: int
    exchange_staleness_seconds: int
    clickhouse_http_url: str
    clickhouse_database: str
    clickhouse_username: str
    clickhouse_password: str | None
    clickhouse_timeout_seconds: int
    min_day_notional_volume_usd: Decimal
    max_markets_per_cycle: int
    allowed_asset_classes: tuple[str, ...]
    max_order_notional_usd: Decimal
    max_gross_exposure_usd: Decimal
    max_daily_loss_usd: Decimal
    max_slippage_bps: Decimal
    min_order_size: Decimal
    strategy_parameter_version: str
    optimizer_enabled: bool
    optimizer_min_trades: int
    optimizer_max_drawdown_usd: Decimal
    optimizer_min_net_pnl_usd: Decimal
    metrics_namespace: str
    tigerbeetle_enabled: bool
    tigerbeetle_required: bool
    tigerbeetle_cluster_id: int
    tigerbeetle_replica_addresses: str
    tigerbeetle_rpc_timeout_seconds: float
    tigerbeetle_journal_enabled: bool

    @classmethod
    def from_env(
        cls,
        env: Mapping[str, str] | None = None,
    ) -> "HyperliquidRuntimeConfig":
        source = env if env is not None else os.environ
        execution_network = _text(
            source, "HYPERLIQUID_RUNTIME_EXECUTION_NETWORK", "testnet"
        ).lower()
        market_data_network = _text(
            source, "HYPERLIQUID_RUNTIME_MARKET_DATA_NETWORK", "mainnet"
        ).lower()
        return cls(
            enabled=_bool(source, "HYPERLIQUID_RUNTIME_ENABLED", True),
            trading_enabled=_bool(source, "HYPERLIQUID_RUNTIME_TRADING_ENABLED", False),
            execution_network=execution_network,
            market_data_network=market_data_network,
            exchange_api_url=_text(
                source,
                "HYPERLIQUID_RUNTIME_EXCHANGE_API_URL",
                "https://api.hyperliquid-testnet.xyz",
            ),
            account_address=_optional_text(
                source, "HYPERLIQUID_RUNTIME_ACCOUNT_ADDRESS"
            ),
            api_wallet_private_key=_optional_text(
                source, "HYPERLIQUID_RUNTIME_API_WALLET_PRIVATE_KEY"
            ),
            poll_interval_seconds=_int(
                source, "HYPERLIQUID_RUNTIME_POLL_INTERVAL_SECONDS", 15
            ),
            dependency_staleness_seconds=_int(
                source, "HYPERLIQUID_RUNTIME_DEPENDENCY_STALENESS_SECONDS", 180
            ),
            signal_staleness_seconds=_int(
                source, "HYPERLIQUID_RUNTIME_SIGNAL_STALENESS_SECONDS", 120
            ),
            exchange_staleness_seconds=_int(
                source, "HYPERLIQUID_RUNTIME_EXCHANGE_STALENESS_SECONDS", 120
            ),
            clickhouse_http_url=_text(
                source,
                "HYPERLIQUID_RUNTIME_CLICKHOUSE_HTTP_URL",
                _text(
                    source,
                    "CLICKHOUSE_HTTP_URL",
                    "http://torghut-clickhouse.torghut.svc.cluster.local:8123",
                ),
            ),
            clickhouse_database=_text(
                source,
                "HYPERLIQUID_RUNTIME_CLICKHOUSE_DATABASE",
                _text(source, "CLICKHOUSE_DATABASE", "torghut"),
            ),
            clickhouse_username=_text(
                source,
                "HYPERLIQUID_RUNTIME_CLICKHOUSE_USERNAME",
                _text(source, "CLICKHOUSE_USERNAME", "torghut"),
            ),
            clickhouse_password=_optional_text(
                source, "HYPERLIQUID_RUNTIME_CLICKHOUSE_PASSWORD"
            )
            or _optional_text(source, "CLICKHOUSE_PASSWORD"),
            clickhouse_timeout_seconds=_int(
                source, "HYPERLIQUID_RUNTIME_CLICKHOUSE_TIMEOUT_SECONDS", 10
            ),
            min_day_notional_volume_usd=_decimal(
                source,
                "HYPERLIQUID_RUNTIME_MIN_DAY_NOTIONAL_VOLUME_USD",
                "100000",
            ),
            max_markets_per_cycle=_int(
                source, "HYPERLIQUID_RUNTIME_MAX_MARKETS_PER_CYCLE", 100
            ),
            allowed_asset_classes=tuple(
                _csv(
                    source,
                    "HYPERLIQUID_RUNTIME_ALLOWED_ASSET_CLASSES",
                    _DEFAULT_ALLOWED_ASSET_CLASSES,
                )
            ),
            max_order_notional_usd=_decimal(
                source, "HYPERLIQUID_RUNTIME_MAX_ORDER_NOTIONAL_USD", "25"
            ),
            max_gross_exposure_usd=_decimal(
                source, "HYPERLIQUID_RUNTIME_MAX_GROSS_EXPOSURE_USD", "100"
            ),
            max_daily_loss_usd=_decimal(
                source, "HYPERLIQUID_RUNTIME_MAX_DAILY_LOSS_USD", "25"
            ),
            max_slippage_bps=_decimal(
                source, "HYPERLIQUID_RUNTIME_MAX_SLIPPAGE_BPS", "15"
            ),
            min_order_size=_decimal(
                source, "HYPERLIQUID_RUNTIME_MIN_ORDER_SIZE", "0.0001"
            ),
            strategy_parameter_version=_text(
                source,
                "HYPERLIQUID_RUNTIME_STRATEGY_PARAMETER_VERSION",
                "hl-equity-momentum-v1",
            ),
            optimizer_enabled=_bool(
                source, "HYPERLIQUID_RUNTIME_OPTIMIZER_ENABLED", True
            ),
            optimizer_min_trades=_int(
                source, "HYPERLIQUID_RUNTIME_OPTIMIZER_MIN_TRADES", 40
            ),
            optimizer_max_drawdown_usd=_decimal(
                source,
                "HYPERLIQUID_RUNTIME_OPTIMIZER_MAX_DRAWDOWN_USD",
                "20",
            ),
            optimizer_min_net_pnl_usd=_decimal(
                source,
                "HYPERLIQUID_RUNTIME_OPTIMIZER_MIN_NET_PNL_USD",
                "1",
            ),
            metrics_namespace=_text(
                source,
                "HYPERLIQUID_RUNTIME_METRICS_NAMESPACE",
                "torghut_hyperliquid_runtime",
            ),
            tigerbeetle_enabled=_bool(source, "TORGHUT_TIGERBEETLE_ENABLED", False),
            tigerbeetle_required=_bool(source, "TORGHUT_TIGERBEETLE_REQUIRED", False),
            tigerbeetle_cluster_id=_int(source, "TORGHUT_TIGERBEETLE_CLUSTER_ID", 2001),
            tigerbeetle_replica_addresses=_text(
                source,
                "TORGHUT_TIGERBEETLE_REPLICA_ADDRESSES",
                "torghut-tigerbeetle.torghut.svc.cluster.local:3000",
            ),
            tigerbeetle_rpc_timeout_seconds=_float(
                source, "TORGHUT_TIGERBEETLE_RPC_TIMEOUT_SECONDS", 10.0
            ),
            tigerbeetle_journal_enabled=_bool(
                source, "TORGHUT_TIGERBEETLE_JOURNAL_ENABLED", False
            ),
        )

    def validation_errors(self) -> list[str]:
        errors: list[str] = []
        if self.execution_network != "testnet":
            errors.append("execution_network_must_be_testnet")
        if "hyperliquid-testnet.xyz" not in self.exchange_api_url:
            errors.append("exchange_api_url_must_target_hyperliquid_testnet")
        if self.trading_enabled and not self.account_address:
            errors.append("account_address_required_when_trading_enabled")
        if self.trading_enabled and not self.api_wallet_private_key:
            errors.append("api_wallet_private_key_required_when_trading_enabled")
        if self.max_order_notional_usd <= Decimal("0"):
            errors.append("max_order_notional_usd_must_be_positive")
        if self.max_gross_exposure_usd < self.max_order_notional_usd:
            errors.append("max_gross_exposure_usd_must_cover_one_order")
        if self.max_daily_loss_usd <= Decimal("0"):
            errors.append("max_daily_loss_usd_must_be_positive")
        if self.max_slippage_bps <= Decimal("0"):
            errors.append("max_slippage_bps_must_be_positive")
        if self.tigerbeetle_cluster_id <= 0:
            errors.append("tigerbeetle_cluster_id_must_be_positive")
        if self.tigerbeetle_rpc_timeout_seconds <= 0:
            errors.append("tigerbeetle_rpc_timeout_seconds_must_be_positive")
        if self.tigerbeetle_enabled and not self.tigerbeetle_replica_addresses:
            errors.append("tigerbeetle_replica_addresses_required_when_enabled")
        if self.trading_enabled and not self.tigerbeetle_enabled:
            errors.append("tigerbeetle_enabled_required_when_trading_enabled")
        if self.trading_enabled and not self.tigerbeetle_journal_enabled:
            errors.append("tigerbeetle_journal_enabled_required_when_trading_enabled")
        if self.trading_enabled and not self.tigerbeetle_required:
            errors.append("tigerbeetle_required_when_trading_enabled")
        if not set(self.allowed_asset_classes).issubset(
            set(_DEFAULT_ALLOWED_ASSET_CLASSES)
        ):
            errors.append("allowed_asset_classes_must_be_stocks_indices_preipo")
        return errors


def _text(env: Mapping[str, str], name: str, default: str) -> str:
    value = env.get(name, default)
    cleaned = value.strip()
    return cleaned if cleaned else default


def _optional_text(env: Mapping[str, str], name: str) -> str | None:
    value = env.get(name)
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned or None


def _bool(env: Mapping[str, str], name: str, default: bool) -> bool:
    value = env.get(name)
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in _TRUE_VALUES:
        return True
    if normalized in _FALSE_VALUES:
        return False
    raise ValueError(f"{name}_must_be_boolean")


def _int(env: Mapping[str, str], name: str, default: int) -> int:
    value = env.get(name)
    if value is None:
        return default
    return int(value.strip())


def _float(env: Mapping[str, str], name: str, default: float) -> float:
    value = env.get(name)
    if value is None:
        return default
    return float(value.strip())


def _decimal(env: Mapping[str, str], name: str, default: str) -> Decimal:
    value = env.get(name, default)
    return Decimal(value.strip())


def _csv(
    env: Mapping[str, str],
    name: str,
    default: tuple[str, ...],
) -> list[str]:
    value = env.get(name)
    if value is None:
        return list(default)
    return [part.strip().lower() for part in value.split(",") if part.strip()]
