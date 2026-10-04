"""Venue-neutral contracts for Torghut's generic multifactor machine."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Literal


Direction = Literal["buy", "sell", "hold"]


def _empty_decimal_map() -> dict[str, Decimal]:
    return {}


def _empty_object_map() -> dict[str, object]:
    return {}


@dataclass(frozen=True)
class AssetKey:
    """Stable identity for a tradeable asset on a venue."""

    venue: str
    symbol: str
    market_id: str
    asset_class: str = "perp"

    @property
    def key(self) -> str:
        return f"{self.venue}:{self.market_id}"


@dataclass(frozen=True)
class UniverseSnapshot:
    """Assets selected for one multifactor cycle."""

    run_id: str
    observed_at: datetime
    lane: str
    assets: tuple[AssetKey, ...]
    selection_reason: str
    metadata: dict[str, object] = field(default_factory=_empty_object_map)


@dataclass(frozen=True)
class FactorVector:
    """Raw and normalized factor exposures for one asset."""

    run_id: str
    asset: AssetKey
    observed_at: datetime
    source_event_at: datetime
    raw_factors: dict[str, Decimal]
    normalized_factors: dict[str, Decimal]
    source_lag_seconds: int
    quote_lag_seconds: int | None
    freshness_blocker: str | None = None

    @property
    def fresh(self) -> bool:
        return self.freshness_blocker is None


@dataclass(frozen=True)
class AlphaForecast:
    """Refined expected-return forecast from normalized factor scores."""

    run_id: str
    asset: AssetKey
    model_id: str
    horizon_seconds: int
    score: Decimal
    residual_volatility_bps: Decimal
    information_coefficient: Decimal
    expected_return_bps: Decimal
    direction: Direction
    blocker: str | None = None


@dataclass(frozen=True)
class RiskForecast:
    """Pre-trade risk and blocker estimate for one asset."""

    run_id: str
    asset: AssetKey
    active_risk_bps: Decimal
    gross_exposure_usd: Decimal
    symbol_exposure_usd: Decimal
    liquidity_capacity_usd: Decimal
    concentration_bps: Decimal
    blocker: str | None = None

    @property
    def allowed(self) -> bool:
        return self.blocker is None


@dataclass(frozen=True)
class PortfolioTarget:
    """Constrained target delta generated before venue order construction."""

    run_id: str
    asset: AssetKey
    direction: Direction
    current_notional_usd: Decimal
    target_notional_usd: Decimal
    delta_notional_usd: Decimal
    expected_return_bps: Decimal
    expected_cost_bps: Decimal
    active_risk_bps: Decimal
    risk_buffer_bps: Decimal
    clip_reason: str | None = None

    @property
    def executable(self) -> bool:
        return (
            self.direction != "hold"
            and self.delta_notional_usd > Decimal("0")
            and self.clip_reason is None
        )


@dataclass(frozen=True)
class ExecutionIntent:
    """Venue-neutral intent emitted by portfolio construction."""

    run_id: str
    asset: AssetKey
    venue: str
    side: Literal["buy", "sell"]
    notional_usd: Decimal
    idempotency_key: str
    status: str = "planned"
    blocker: str | None = None


@dataclass(frozen=True)
class AttributionSnapshot:
    """Reduced realized performance and signal-quality proof."""

    run_id: str
    observed_at: datetime
    fill_count: int
    realized_pnl_usd: Decimal
    turnover_usd: Decimal
    realized_cost_usd: Decimal
    information_coefficient: Decimal | None = None
    information_ratio: Decimal | None = None
    hit_rate: Decimal | None = None
    factor_contributions: dict[str, Decimal] = field(default_factory=_empty_decimal_map)
