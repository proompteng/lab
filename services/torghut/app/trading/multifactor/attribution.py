"""Small attribution helpers for multifactor proof snapshots."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from .contracts import AttributionSnapshot


@dataclass(frozen=True)
class AttributionInputs:
    """Reduced realized performance inputs for one runtime proof snapshot."""

    run_id: str
    observed_at: datetime
    fill_count: int
    realized_pnl_usd: Decimal
    turnover_usd: Decimal
    realized_cost_usd: Decimal


def build_attribution_snapshot(inputs: AttributionInputs) -> AttributionSnapshot:
    """Build the reduced attribution payload persisted with each runtime cycle."""

    hit_rate = (
        Decimal("1")
        if inputs.fill_count > 0 and inputs.realized_pnl_usd > Decimal("0")
        else Decimal("0")
    )
    return AttributionSnapshot(
        run_id=inputs.run_id,
        observed_at=inputs.observed_at,
        fill_count=inputs.fill_count,
        realized_pnl_usd=inputs.realized_pnl_usd,
        turnover_usd=inputs.turnover_usd,
        realized_cost_usd=inputs.realized_cost_usd,
        hit_rate=hit_rate,
    )
