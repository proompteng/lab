"""Transaction-cost estimates for deterministic runtime gating."""

from __future__ import annotations

from decimal import Decimal

from .contracts import FactorVector
from .normalization import quantize_bps


def estimate_transaction_cost(
    vector: FactorVector,
    *,
    cost_buffer_bps: Decimal,
    participation_rate: Decimal,
) -> Decimal:
    """Estimate spread, slippage, and impact in basis points."""

    spread_bps = vector.raw_factors.get("spread_bps", Decimal("0"))
    volatility_bps = vector.raw_factors.get("volatility_bps", Decimal("0"))
    slippage_bps = min(volatility_bps * Decimal("0.01"), Decimal("5"))
    impact_bps = min(participation_rate * Decimal("1000"), Decimal("10"))
    return quantize_bps(spread_bps + slippage_bps + impact_bps + cost_buffer_bps)
