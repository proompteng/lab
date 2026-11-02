"""Active Portfolio Management style alpha refinement."""

from __future__ import annotations

from decimal import Decimal

from .contracts import AlphaForecast, FactorVector
from .factor_registry import (
    DEFAULT_FACTOR_DEFINITIONS,
    DEFAULT_HORIZON_SECONDS,
    DEFAULT_INFORMATION_COEFFICIENT,
    DEFAULT_MODEL_ID,
)
from .normalization import quantize_bps


def build_alpha_forecast(
    vector: FactorVector,
    *,
    residual_volatility_bps: Decimal,
    information_coefficient: Decimal = DEFAULT_INFORMATION_COEFFICIENT,
    horizon_seconds: int = DEFAULT_HORIZON_SECONDS,
    model_id: str = DEFAULT_MODEL_ID,
) -> AlphaForecast:
    """Transform normalized factors into a refined return forecast."""

    if not vector.fresh:
        return AlphaForecast(
            run_id=vector.run_id,
            asset=vector.asset,
            model_id=model_id,
            horizon_seconds=horizon_seconds,
            score=Decimal("0"),
            residual_volatility_bps=residual_volatility_bps,
            information_coefficient=information_coefficient,
            expected_return_bps=Decimal("0"),
            direction="hold",
            blocker=vector.freshness_blocker,
        )
    score = sum(
        (
            definition.weight
            * vector.normalized_factors.get(definition.name, Decimal("0"))
            for definition in DEFAULT_FACTOR_DEFINITIONS
        ),
        Decimal("0"),
    )
    expected_return_bps = quantize_bps(
        residual_volatility_bps * information_coefficient * score
    )
    if expected_return_bps > Decimal("0"):
        direction = "buy"
    elif expected_return_bps < Decimal("0"):
        direction = "sell"
    else:
        direction = "hold"
    return AlphaForecast(
        run_id=vector.run_id,
        asset=vector.asset,
        model_id=model_id,
        horizon_seconds=horizon_seconds,
        score=score,
        residual_volatility_bps=residual_volatility_bps,
        information_coefficient=information_coefficient,
        expected_return_bps=expected_return_bps,
        direction=direction,
        blocker=None if direction != "hold" else "zero_expected_return",
    )
