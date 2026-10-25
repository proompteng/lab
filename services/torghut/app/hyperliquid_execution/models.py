"""Typed contracts for the Hyperliquid execution v2 lane."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Literal

from app.trading.multifactor.contracts import (
    AlphaForecast,
    FactorVector,
    PortfolioTarget,
    RiskForecast,
)


Action = Literal["buy", "sell", "hold"]
OrderSide = Literal["buy", "sell"]
OrderStatus = Literal["accepted", "cancelled", "filled", "rejected", "submitted"]
RiskStatus = Literal["allowed", "blocked"]


def _empty_payload() -> dict[str, object]:
    return {}


def _empty_decimal_map() -> dict[str, Decimal]:
    return {}


@dataclass(frozen=True)
class RuntimeDependencyStatus:
    """Readiness state for one runtime dependency."""

    name: str
    ready: bool
    observed_at: datetime | None = None
    lag_seconds: int | None = None
    reason: str | None = None
    details: dict[str, object] = field(default_factory=_empty_payload)


@dataclass(frozen=True)
class ConfiguredCoin:
    """One operator-configured execution symbol."""

    raw: str
    symbol: str
    dex: str | None = None

    @property
    def key(self) -> str:
        return f"{self.dex}:{self.symbol}" if self.dex else self.symbol


@dataclass(frozen=True)
class ExecutionMarket:
    """Market selected from mainnet data and testnet execution metadata."""

    market_id: str
    coin: str
    dex: str
    network: str
    day_notional_volume_usd: Decimal
    mark_price: Decimal | None = None
    mid_price: Decimal | None = None
    max_leverage: Decimal | None = None
    payload: dict[str, object] = field(default_factory=_empty_payload)

    @property
    def symbol(self) -> str:
        return symbol_key(self.coin)


@dataclass(frozen=True)
class FeatureSnapshot:
    """Latest feature row at the selected market grain."""

    market_id: str
    coin: str
    dex: str
    event_ts: datetime
    price: Decimal
    momentum_5m_bps: Decimal
    spread_bps: Decimal
    liquidity_usd: Decimal
    volatility_bps: Decimal
    book_imbalance: Decimal
    source_lag_seconds: int
    bid_price: Decimal | None = None
    ask_price: Decimal | None = None
    quote_lag_seconds: int | None = None
    raw_features: dict[str, object] = field(default_factory=_empty_payload)


@dataclass(frozen=True)
class Signal:
    """Deterministic v2 edge signal."""

    market_id: str
    coin: str
    generated_at: datetime
    action: Action
    edge_bps: Decimal
    reason: str
    feature: FeatureSnapshot
    factor_vector: FactorVector | None = None
    alpha_forecast: AlphaForecast | None = None


@dataclass(frozen=True)
class RiskState:
    """Operational state required before submitting an order."""

    trading_enabled: bool
    dependencies: tuple[RuntimeDependencyStatus, ...]
    gross_exposure_usd: Decimal
    daily_realized_pnl_usd: Decimal
    open_order_coins: frozenset[str]
    symbol_exposure_usd_by_coin: dict[str, Decimal]
    cooldown_reason_by_coin: dict[str, str]
    position_exposure_usd_by_coin: dict[str, Decimal] | None = None
    account_value_usd: Decimal = Decimal("0")
    withdrawable_usd: Decimal = Decimal("0")
    max_leverage_by_coin: dict[str, Decimal] = field(default_factory=_empty_decimal_map)


@dataclass(frozen=True)
class RiskVerdict:
    """Risk gate result for one signal."""

    status: RiskStatus
    reason: str
    order_notional_usd: Decimal
    risk_forecast: RiskForecast | None = None
    portfolio_target: PortfolioTarget | None = None

    @property
    def allowed(self) -> bool:
        return self.status == "allowed"


@dataclass(frozen=True)
class OrderIntent:
    """Hyperliquid limit order intent."""

    market_id: str
    coin: str
    dex: str
    side: OrderSide
    size: Decimal
    limit_price: Decimal
    notional_usd: Decimal
    cloid: str
    tif: str
    reduce_only: bool
    signal_id: str
    expires_at: datetime


@dataclass(frozen=True)
class OrderResult:
    """Normalized exchange order result."""

    status: OrderStatus
    exchange_order_id: str | None
    raw_response: dict[str, object]
    rejection_reason: str | None = None


@dataclass(frozen=True)
class OpenOrder:
    """Open order persisted by v2 and tracked through TTL cancellation."""

    order_id: str
    coin: str
    dex: str
    exchange_order_id: str | None
    cloid: str
    status: str
    expires_at: datetime


@dataclass(frozen=True)
class Fill:
    """Normalized fill read back from Hyperliquid account state."""

    fill_hash: str
    market_id: str
    coin: str
    side: OrderSide
    price: Decimal
    size: Decimal
    notional_usd: Decimal
    fee_usd: Decimal
    closed_pnl_usd: Decimal
    exchange_order_id: str | None
    event_ts: datetime
    raw_payload: dict[str, object]


@dataclass(frozen=True)
class PositionSnapshot:
    """Latest exchange position for one coin."""

    market_id: str
    coin: str
    size: Decimal
    entry_price: Decimal | None
    notional_usd: Decimal
    unrealized_pnl_usd: Decimal
    observed_at: datetime
    raw_payload: dict[str, object]
    sdk_coin: str | None = None


@dataclass(frozen=True)
class AccountSnapshot:
    """Latest account summary from the dedicated testnet account."""

    observed_at: datetime
    account_value_usd: Decimal
    withdrawable_usd: Decimal
    gross_exposure_usd: Decimal
    raw_payload: dict[str, object]


@dataclass(frozen=True)
class AccountState:
    """Account snapshot plus current external exchange positions."""

    account: AccountSnapshot
    positions: tuple[PositionSnapshot, ...]


@dataclass(frozen=True)
class CycleResult:
    """One v2 runtime cycle result."""

    observed_at: datetime
    markets_seen: int
    selected_coins: tuple[str, ...]
    signals_written: int
    orders_submitted: int
    orders_cancelled: int
    dependencies: tuple[RuntimeDependencyStatus, ...]
    universe_details: dict[str, object]


@dataclass(frozen=True)
class CycleRecord:
    """Persistable v2 runtime cycle summary."""

    cycle_id: str
    started_at: datetime
    finished_at: datetime
    trading_enabled: bool
    selected_coins: tuple[str, ...]
    signals_written: int
    orders_submitted: int
    orders_cancelled: int
    dependency_statuses: tuple[RuntimeDependencyStatus, ...]
    universe_details: dict[str, object]
    error: str | None = None


def symbol_key(value: str) -> str:
    """Return the execution symbol for raw values like `xyz:NVDA`."""

    return value.strip().split(":")[-1].upper()


def coin_key(value: str) -> str:
    """Return a case-insensitive exact coin key."""

    return value.strip().upper()
