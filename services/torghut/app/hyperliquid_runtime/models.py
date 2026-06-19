"""Typed contracts for the isolated Hyperliquid runtime lane."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Literal


AssetClass = Literal["stocks", "indices", "preipo"]
DecisionAction = Literal["buy", "sell", "hold", "cancel_only"]
OrderSide = Literal["buy", "sell"]
OrderStatus = Literal[
    "accepted", "rejected", "submitted", "filled", "cancelled", "unknown"
]
RiskStatus = Literal["allowed", "blocked"]


def _empty_details() -> dict[str, object]:
    return {}


def _empty_payload() -> dict[str, object]:
    return {}


@dataclass(frozen=True)
class RuntimeDependencyStatus:
    """Readiness state for a runtime dependency."""

    name: str
    ready: bool
    observed_at: datetime | None = None
    lag_seconds: int | None = None
    reason: str | None = None
    details: dict[str, object] = field(default_factory=_empty_details)


@dataclass(frozen=True)
class HyperliquidMarket:
    """Canonical Hyperliquid market selected from the public feed catalog."""

    market_id: str
    coin: str
    dex: str
    asset_class: AssetClass
    network: str
    day_notional_volume_usd: Decimal
    mark_price: Decimal | None
    mid_price: Decimal | None
    open_interest_usd: Decimal
    max_leverage: int | None
    payload: dict[str, object] = field(default_factory=_empty_payload)


@dataclass(frozen=True)
class FeatureSnapshot:
    """Latest ClickHouse feature row at the market grain."""

    market_id: str
    coin: str
    dex: str
    event_ts: datetime
    price: Decimal
    momentum_1m_bps: Decimal
    momentum_3m_bps: Decimal
    momentum_5m_bps: Decimal
    momentum_15m_bps: Decimal
    momentum_1h_bps: Decimal
    volatility_bps: Decimal
    vwap_distance_bps: Decimal
    spread_bps: Decimal
    book_imbalance: Decimal
    liquidity_usd: Decimal
    funding_rate: Decimal
    open_interest_usd: Decimal
    regime: str
    source_lag_seconds: int
    bid_price: Decimal | None = None
    ask_price: Decimal | None = None
    quote_event_ts: datetime | None = None
    quote_lag_seconds: int | None = None


@dataclass(frozen=True)
class Signal:
    """Deterministic strategy signal persisted before any order path."""

    market_id: str
    coin: str
    generated_at: datetime
    action: DecisionAction
    strength: Decimal
    reason: str
    parameter_version: str
    feature: FeatureSnapshot


@dataclass(frozen=True)
class DecisionRecord:
    """Decision row derived from a persisted signal and risk verdict."""

    signal_id: str
    signal: Signal
    status: RiskStatus
    reason: str
    order_notional_usd: Decimal


@dataclass(frozen=True)
class RiskState:
    """Operational state required for risk gating a candidate decision."""

    gross_exposure_usd: Decimal
    daily_realized_pnl_usd: Decimal
    unrealized_pnl_usd: Decimal
    daily_fees_usd: Decimal
    open_order_markets: frozenset[str]
    dependencies: tuple[RuntimeDependencyStatus, ...]


@dataclass(frozen=True)
class RiskVerdict:
    """Outcome of deterministic risk gates."""

    status: RiskStatus
    reason: str
    order_notional_usd: Decimal

    @property
    def allowed(self) -> bool:
        return self.status == "allowed"


@dataclass(frozen=True)
class OrderIntent:
    """Hyperliquid IOC limit order intent after signal and risk gates."""

    market_id: str
    coin: str
    dex: str
    side: OrderSide
    size: Decimal
    limit_price: Decimal
    notional_usd: Decimal
    cloid: str
    reduce_only: bool
    decision_id: str


@dataclass(frozen=True)
class OrderResult:
    """Normalized Hyperliquid order submission result."""

    status: OrderStatus
    exchange_order_id: str | None
    raw_response: dict[str, object]
    rejection_reason: str | None = None


@dataclass(frozen=True)
class Fill:
    """Normalized fill read back from Hyperliquid user-state APIs."""

    market_id: str
    coin: str
    side: OrderSide
    price: Decimal
    size: Decimal
    notional_usd: Decimal
    fee_usd: Decimal
    closed_pnl_usd: Decimal
    exchange_order_id: str | None
    fill_hash: str
    event_ts: datetime
    raw_payload: dict[str, object]


@dataclass(frozen=True)
class PositionSnapshot:
    """Latest reconciled Hyperliquid position for risk and performance state."""

    market_id: str
    coin: str
    size: Decimal
    entry_price: Decimal | None
    notional_usd: Decimal
    unrealized_pnl_usd: Decimal
    observed_at: datetime
    raw_payload: dict[str, object]


@dataclass(frozen=True)
class AccountSnapshot:
    """Latest reconciled account summary from the dedicated testnet account."""

    observed_at: datetime
    account_value_usd: Decimal
    withdrawable_usd: Decimal
    gross_exposure_usd: Decimal
    raw_payload: dict[str, object]


@dataclass(frozen=True)
class AccountState:
    """Exchange user-state reconciliation result for one runtime cycle."""

    account: AccountSnapshot
    positions: tuple[PositionSnapshot, ...]


@dataclass(frozen=True)
class PerformanceSnapshot:
    """Runtime performance row derived from Postgres and TigerBeetle evidence."""

    observed_at: datetime
    gross_exposure_usd: Decimal
    realized_pnl_usd: Decimal
    unrealized_pnl_usd: Decimal
    fees_usd: Decimal
    trade_count: int
    reconciliation_status: str


@dataclass(frozen=True)
class CycleResult:
    """One runtime loop result for readiness and metrics."""

    observed_at: datetime
    markets_seen: int
    signals_written: int
    decisions_written: int
    orders_submitted: int
    blocked_decisions: int
    dependency_statuses: tuple[RuntimeDependencyStatus, ...]
