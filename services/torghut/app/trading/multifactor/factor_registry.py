"""Factor definitions and freshness policy for the runtime multifactor model."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Literal


FactorDirection = Literal["positive", "negative", "quality"]


@dataclass(frozen=True)
class FactorDefinition:
    """Configuration for one runtime factor."""

    name: str
    direction: FactorDirection
    weight: Decimal
    required: bool = True


DEFAULT_MODEL_ID = "active-portfolio-management-v1"
DEFAULT_INFORMATION_COEFFICIENT = Decimal("0.05")
DEFAULT_HORIZON_SECONDS = 300
DEFAULT_RISK_BUFFER_BPS = Decimal("1")
DEFAULT_LIQUIDITY_PARTICIPATION_RATE = Decimal("0.001")
DEFAULT_FACTOR_DEFINITIONS = (
    FactorDefinition("momentum_5m", "positive", Decimal("0.90")),
    FactorDefinition("book_imbalance", "positive", Decimal("0.10")),
    FactorDefinition("liquidity_usd", "quality", Decimal("0")),
    FactorDefinition("spread_bps", "negative", Decimal("0")),
    FactorDefinition("volatility_bps", "negative", Decimal("0")),
)
