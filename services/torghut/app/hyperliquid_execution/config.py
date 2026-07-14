"""Configuration for the Hyperliquid execution v2 lane."""

from __future__ import annotations

import os
from dataclasses import dataclass
from decimal import Decimal
from typing import Mapping


_TRUE_VALUES = {"1", "true", "yes", "y", "on"}
_FALSE_VALUES = {"0", "false", "no", "n", "off"}
_ENV_PREFIX = "HYPERLIQUID_EXECUTION_"
_OLD_ENV_PREFIX = "HYPERLIQUID_RUNTIME_"
_RESTORE_ORDER_POLICY = "marketable_ioc"
_REMOVED_FIXED_CAP_ENV_SUFFIXES = {
    "MAX_ORDER_NOTIONAL_USD",
    "MAX_SYMBOL_EXPOSURE_USD",
    "MAX_GROSS_EXPOSURE_USD",
}
_DEFAULT_TRADE_COINS = (
    "BTC",
    "ETH",
    "HYPE",
    "SOL",
    "xyz:SKHX",
    "xyz:MU",
    "xyz:XYZ100",
    "xyz:CL",
    "xyz:SNDK",
    "xyz:MSTR",
    "xyz:SILVER",
    "xyz:GOLD",
)


@dataclass(frozen=True)
class _ProfitabilityEnvValues:
    min_after_cost_edge_bps: Decimal
    min_edge_cost_ratio: Decimal
    max_symbol_turnover_equity_multiple_1h: Decimal
    min_seconds_between_symbol_entries: int
    min_seconds_between_side_flip: int


@dataclass(frozen=True)
class HyperliquidExecutionConfig:
    """Runtime settings for the hard-reset Hyperliquid v2 lane."""

    enabled: bool
    trading_enabled: bool
    allow_short_entries: bool
    market_data_network: str
    execution_network: str
    exchange_api_url: str
    account_label: str
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
    feed_readiness_url: str | None
    feed_readiness_timeout_seconds: int
    trade_coins: tuple[str, ...]
    excluded_coins: tuple[str, ...]
    max_markets_per_cycle: int
    min_day_notional_volume_usd: Decimal
    min_order_notional_usd: Decimal
    target_margin_utilization: Decimal
    max_symbol_margin_utilization: Decimal
    max_order_margin_utilization: Decimal
    max_daily_loss_usd: Decimal
    order_policy: str
    order_ttl_seconds: int
    max_open_orders_per_symbol: int
    reject_cooldown_threshold: int
    reject_cooldown_window_seconds: int
    reject_cooldown_seconds: int
    min_order_size: Decimal
    cost_buffer_bps: Decimal
    marketable_ioc_slippage_bps: Decimal
    min_after_cost_edge_bps: Decimal
    min_edge_cost_ratio: Decimal
    max_symbol_turnover_equity_multiple_1h: Decimal
    min_seconds_between_symbol_entries: int
    min_seconds_between_side_flip: int
    maintenance_reduce_only_close_enabled: bool
    metrics_namespace: str
    old_env_names: tuple[str, ...] = ()
    removed_env_names: tuple[str, ...] = ()

    @classmethod
    def from_env(
        cls,
        env: Mapping[str, str] | None = None,
    ) -> "HyperliquidExecutionConfig":
        source = env if env is not None else os.environ
        profitability = _profitability_env_values(source)
        return cls(
            enabled=_bool(source, "ENABLED", True),
            trading_enabled=_bool(source, "TRADING_ENABLED", False),
            allow_short_entries=_bool(source, "ALLOW_SHORT_ENTRIES", False),
            market_data_network=_text(source, "MARKET_DATA_NETWORK", "mainnet").lower(),
            execution_network=_text(source, "EXECUTION_NETWORK", "testnet").lower(),
            exchange_api_url=_text(
                source,
                "EXCHANGE_API_URL",
                "https://api.hyperliquid-testnet.xyz",
            ),
            account_label=_text(source, "ACCOUNT_LABEL", "hyperliquid-testnet"),
            account_address=_optional_text(source, "ACCOUNT_ADDRESS"),
            api_wallet_private_key=_optional_text(source, "API_WALLET_PRIVATE_KEY"),
            poll_interval_seconds=_int(source, "POLL_INTERVAL_SECONDS", 15),
            dependency_staleness_seconds=_int(
                source, "DEPENDENCY_STALENESS_SECONDS", 180
            ),
            signal_staleness_seconds=_int(source, "SIGNAL_STALENESS_SECONDS", 120),
            exchange_staleness_seconds=_int(source, "EXCHANGE_STALENESS_SECONDS", 120),
            clickhouse_http_url=_text(
                source,
                "CLICKHOUSE_HTTP_URL",
                _text(
                    source,
                    "CLICKHOUSE_HTTP_URL",
                    "http://torghut-clickhouse.torghut.svc.cluster.local:8123",
                    prefixed=False,
                ),
            ),
            clickhouse_database=_text(
                source,
                "CLICKHOUSE_DATABASE",
                _text(source, "CLICKHOUSE_DATABASE", "torghut", prefixed=False),
            ),
            clickhouse_username=_text(
                source,
                "CLICKHOUSE_USERNAME",
                _text(source, "CLICKHOUSE_USERNAME", "torghut", prefixed=False),
            ),
            clickhouse_password=_optional_text(source, "CLICKHOUSE_PASSWORD")
            or _optional_text(source, "CLICKHOUSE_PASSWORD", prefixed=False),
            clickhouse_timeout_seconds=_int(source, "CLICKHOUSE_TIMEOUT_SECONDS", 10),
            feed_readiness_url=_optional_text(source, "FEED_READINESS_URL"),
            feed_readiness_timeout_seconds=_int(
                source, "FEED_READINESS_TIMEOUT_SECONDS", 3
            ),
            trade_coins=tuple(_csv(source, "TRADE_COINS", _DEFAULT_TRADE_COINS)),
            excluded_coins=tuple(_csv(source, "EXCLUDED_COINS", ("SPX",))),
            max_markets_per_cycle=_int(source, "MAX_MARKETS_PER_CYCLE", 20),
            min_day_notional_volume_usd=_decimal(
                source, "MIN_DAY_NOTIONAL_VOLUME_USD", "0"
            ),
            min_order_notional_usd=_decimal(source, "MIN_ORDER_NOTIONAL_USD", "10"),
            target_margin_utilization=_decimal(
                source, "TARGET_MARGIN_UTILIZATION", "0.35"
            ),
            max_symbol_margin_utilization=_decimal(
                source, "MAX_SYMBOL_MARGIN_UTILIZATION", "0.08"
            ),
            max_order_margin_utilization=_decimal(
                source, "MAX_ORDER_MARGIN_UTILIZATION", "0.02"
            ),
            max_daily_loss_usd=_decimal(source, "MAX_DAILY_LOSS_USD", "25"),
            order_policy=_text(source, "ORDER_POLICY", _RESTORE_ORDER_POLICY).lower(),
            order_ttl_seconds=_int(source, "ORDER_TTL_SECONDS", 10),
            max_open_orders_per_symbol=_int(source, "MAX_OPEN_ORDERS_PER_SYMBOL", 1),
            reject_cooldown_threshold=_int(source, "REJECT_COOLDOWN_THRESHOLD", 3),
            reject_cooldown_window_seconds=_int(
                source, "REJECT_COOLDOWN_WINDOW_SECONDS", 1800
            ),
            reject_cooldown_seconds=_int(source, "REJECT_COOLDOWN_SECONDS", 900),
            min_order_size=_decimal(source, "MIN_ORDER_SIZE", "0.0001"),
            cost_buffer_bps=_decimal(source, "COST_BUFFER_BPS", "2"),
            marketable_ioc_slippage_bps=_decimal(
                source, "MARKETABLE_IOC_SLIPPAGE_BPS", "0"
            ),
            min_after_cost_edge_bps=profitability.min_after_cost_edge_bps,
            min_edge_cost_ratio=profitability.min_edge_cost_ratio,
            max_symbol_turnover_equity_multiple_1h=profitability.max_symbol_turnover_equity_multiple_1h,
            min_seconds_between_symbol_entries=profitability.min_seconds_between_symbol_entries,
            min_seconds_between_side_flip=profitability.min_seconds_between_side_flip,
            maintenance_reduce_only_close_enabled=_bool(
                source, "MAINTENANCE_REDUCE_ONLY_CLOSE_ENABLED", False
            ),
            metrics_namespace=_text(
                source,
                "METRICS_NAMESPACE",
                "torghut_hyperliquid_execution",
            ),
            old_env_names=_old_runtime_env_names(source),
            removed_env_names=_removed_fixed_cap_env_names(source),
        )

    def validation_errors(self) -> list[str]:
        """Return strict config blockers for readiness and order submission."""

        errors: list[str] = []
        errors.extend(_runtime_validation_errors(self))
        errors.extend(_policy_validation_errors(self))
        errors.extend(_profitability_validation_errors(self))
        errors.extend(_margin_validation_errors(self))
        return errors

    def order_submission_enabled(self) -> bool:
        """Return whether config alone allows a live testnet order path."""

        return self.trading_enabled and not self.validation_errors()

    @property
    def effective_order_tif(self) -> str:
        """Return the actual limit order time-in-force for the active policy."""

        if self.order_policy == _RESTORE_ORDER_POLICY:
            return "Ioc"
        return "Ioc"


def _profitability_validation_errors(
    config: HyperliquidExecutionConfig,
) -> list[str]:
    errors: list[str] = []
    if config.min_after_cost_edge_bps < Decimal("0"):
        errors.append("min_after_cost_edge_bps_must_be_non_negative")
    if config.min_edge_cost_ratio < Decimal("0"):
        errors.append("min_edge_cost_ratio_must_be_non_negative")
    if config.max_symbol_turnover_equity_multiple_1h <= Decimal("0"):
        errors.append("max_symbol_turnover_equity_multiple_1h_must_be_positive")
    if config.min_seconds_between_symbol_entries < 0:
        errors.append("min_seconds_between_symbol_entries_must_be_non_negative")
    if config.min_seconds_between_side_flip < 0:
        errors.append("min_seconds_between_side_flip_must_be_non_negative")
    return errors


def _profitability_env_values(
    source: Mapping[str, str],
) -> _ProfitabilityEnvValues:
    return _ProfitabilityEnvValues(
        min_after_cost_edge_bps=_decimal(source, "MIN_AFTER_COST_EDGE_BPS", "4"),
        min_edge_cost_ratio=_decimal(source, "MIN_EDGE_COST_RATIO", "2"),
        max_symbol_turnover_equity_multiple_1h=_decimal(
            source, "MAX_SYMBOL_TURNOVER_EQUITY_MULTIPLE_1H", "1"
        ),
        min_seconds_between_symbol_entries=_int(
            source, "MIN_SECONDS_BETWEEN_SYMBOL_ENTRIES", 300
        ),
        min_seconds_between_side_flip=_int(
            source, "MIN_SECONDS_BETWEEN_SIDE_FLIP", 900
        ),
    )


def _runtime_validation_errors(config: HyperliquidExecutionConfig) -> list[str]:
    errors: list[str] = []
    if config.old_env_names:
        errors.append("old_hyperliquid_runtime_env_present")
    if config.removed_env_names:
        errors.append("removed_fixed_notional_cap_env_present")
    if config.market_data_network != "mainnet":
        errors.append("market_data_network_must_be_mainnet")
    if config.execution_network != "testnet":
        errors.append("execution_network_must_be_testnet")
    if "hyperliquid-testnet.xyz" not in config.exchange_api_url:
        errors.append("exchange_api_url_must_target_testnet")
    if config.trading_enabled and not config.account_address:
        errors.append("account_address_required_when_trading_enabled")
    if config.trading_enabled and not config.api_wallet_private_key:
        errors.append("api_wallet_private_key_required_when_trading_enabled")
    return errors


def _policy_validation_errors(config: HyperliquidExecutionConfig) -> list[str]:
    errors: list[str] = []
    if config.order_policy != _RESTORE_ORDER_POLICY:
        errors.append("order_policy_must_be_marketable_ioc")
    if config.marketable_ioc_slippage_bps < Decimal("0"):
        errors.append("marketable_ioc_slippage_bps_must_be_non_negative")
    if config.marketable_ioc_slippage_bps >= Decimal("10000"):
        errors.append("marketable_ioc_slippage_bps_must_be_below_10000")
    if config.order_ttl_seconds <= 0:
        errors.append("order_ttl_seconds_must_be_positive")
    if config.max_open_orders_per_symbol != 1:
        errors.append("max_open_orders_per_symbol_must_be_one")
    return errors


def _margin_validation_errors(config: HyperliquidExecutionConfig) -> list[str]:
    errors: list[str] = []
    if config.min_order_notional_usd <= Decimal("0"):
        errors.append("min_order_notional_usd_must_be_positive")
    if config.target_margin_utilization <= Decimal("0"):
        errors.append("target_margin_utilization_must_be_positive")
    if config.max_symbol_margin_utilization <= Decimal("0"):
        errors.append("max_symbol_margin_utilization_must_be_positive")
    if config.max_order_margin_utilization <= Decimal("0"):
        errors.append("max_order_margin_utilization_must_be_positive")
    if config.target_margin_utilization > Decimal("1"):
        errors.append("target_margin_utilization_must_not_exceed_one")
    if config.max_symbol_margin_utilization > config.target_margin_utilization:
        errors.append("symbol_margin_utilization_must_not_exceed_target")
    if config.max_order_margin_utilization > config.max_symbol_margin_utilization:
        errors.append("order_margin_utilization_must_not_exceed_symbol")
    if not config.trade_coins:
        errors.append("trade_coins_required")
    if "SPX" not in {
        coin.strip().split(":")[-1].upper() for coin in config.excluded_coins
    }:
        errors.append("spx_must_be_excluded")
    return errors


def _env_name(key: str, *, prefixed: bool = True) -> str:
    return f"{_ENV_PREFIX}{key}" if prefixed else key


def _old_runtime_env_names(source: Mapping[str, str]) -> tuple[str, ...]:
    return tuple(sorted(key for key in source if key.startswith(_OLD_ENV_PREFIX)))


def _removed_fixed_cap_env_names(source: Mapping[str, str]) -> tuple[str, ...]:
    return tuple(
        sorted(
            env_name
            for key in _REMOVED_FIXED_CAP_ENV_SUFFIXES
            if (env_name := _env_name(key)) in source
        )
    )


def _text(
    source: Mapping[str, str], key: str, default: str, *, prefixed: bool = True
) -> str:
    value = source.get(_env_name(key, prefixed=prefixed), default)
    return value.strip()


def _optional_text(
    source: Mapping[str, str], key: str, *, prefixed: bool = True
) -> str | None:
    value = source.get(_env_name(key, prefixed=prefixed))
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def _bool(source: Mapping[str, str], key: str, default: bool) -> bool:
    value = source.get(_env_name(key))
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in _TRUE_VALUES:
        return True
    if normalized in _FALSE_VALUES:
        return False
    raise ValueError(f"invalid_boolean_env:{_env_name(key)}")


def _int(source: Mapping[str, str], key: str, default: int) -> int:
    value = source.get(_env_name(key))
    if value is None:
        return default
    return int(value.strip())


def _decimal(source: Mapping[str, str], key: str, default: str) -> Decimal:
    value = source.get(_env_name(key), default)
    return Decimal(value.strip())


def _csv(source: Mapping[str, str], key: str, default: tuple[str, ...]) -> list[str]:
    value = source.get(_env_name(key))
    if value is None:
        return list(default)
    return [item.strip() for item in value.split(",") if item.strip()]
