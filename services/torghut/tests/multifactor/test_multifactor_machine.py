from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from app.hyperliquid_execution.models import FeatureSnapshot
from app.trading.multifactor.adapters.hyperliquid import factor_vector_from_feature
from app.trading.multifactor.alpha_model import build_alpha_forecast
from app.trading.multifactor.cost_model import estimate_transaction_cost
from app.trading.multifactor.portfolio_construction import (
    PortfolioCostInput,
    PortfolioLimits,
    build_portfolio_target,
)
from app.trading.multifactor.risk_model import (
    RiskExposureState,
    RiskLimits,
    build_risk_forecast,
)


def test_multifactor_machine_builds_executable_target_from_hyperliquid_features() -> (
    None
):
    vector = factor_vector_from_feature(
        run_id="run-1",
        feature=_feature(momentum=Decimal("12")),
        max_staleness_seconds=120,
    )
    forecast = build_alpha_forecast(
        vector,
        residual_volatility_bps=Decimal("50"),
    )
    risk = build_risk_forecast(
        vector=vector,
        forecast=forecast,
        exposure=RiskExposureState(
            gross_exposure_usd=Decimal("0"),
            symbol_exposure_usd=Decimal("0"),
            daily_realized_pnl_usd=Decimal("0"),
        ),
        limits=RiskLimits(
            max_gross_exposure_usd=Decimal("100"),
            max_symbol_exposure_usd=Decimal("25"),
            max_daily_loss_usd=Decimal("25"),
        ),
    )
    target = build_portfolio_target(
        forecast=forecast,
        risk=risk,
        costs=PortfolioCostInput(
            expected_cost_bps=estimate_transaction_cost(
                vector,
                cost_buffer_bps=Decimal("2"),
                participation_rate=Decimal("0.001"),
            ),
            min_edge_bps=Decimal("5"),
        ),
        limits=PortfolioLimits(
            min_order_notional_usd=Decimal("10"),
            max_order_notional_usd=Decimal("10"),
            max_gross_exposure_usd=Decimal("100"),
            max_symbol_exposure_usd=Decimal("25"),
        ),
    )

    assert vector.asset.key == "hyperliquid:hl:perp:default:BNB"
    assert vector.normalized_factors["momentum_5m"] == Decimal("3.0000")
    assert forecast.direction == "buy"
    assert forecast.expected_return_bps > Decimal("5")
    assert risk.allowed
    assert target.executable
    assert target.target_notional_usd == Decimal("10")


def test_multifactor_machine_blocks_stale_quote_before_order_target() -> None:
    vector = factor_vector_from_feature(
        run_id="run-1",
        feature=_feature(momentum=Decimal("20"), quote_lag_seconds=240),
        max_staleness_seconds=120,
    )
    forecast = build_alpha_forecast(vector, residual_volatility_bps=Decimal("50"))
    risk = build_risk_forecast(
        vector=vector,
        forecast=forecast,
        exposure=RiskExposureState(
            gross_exposure_usd=Decimal("0"),
            symbol_exposure_usd=Decimal("0"),
            daily_realized_pnl_usd=Decimal("0"),
        ),
        limits=RiskLimits(
            max_gross_exposure_usd=Decimal("100"),
            max_symbol_exposure_usd=Decimal("25"),
            max_daily_loss_usd=Decimal("25"),
        ),
    )

    assert vector.fresh is False
    assert forecast.direction == "hold"
    assert forecast.blocker == "stale_quote"
    assert risk.blocker == "stale_quote"


def _feature(
    *,
    momentum: Decimal,
    quote_lag_seconds: int | None = 1,
) -> FeatureSnapshot:
    return FeatureSnapshot(
        market_id="hl:perp:default:BNB",
        coin="BNB",
        dex="default",
        event_ts=datetime(2026, 6, 25, 12, 0, tzinfo=timezone.utc),
        price=Decimal("600"),
        momentum_5m_bps=momentum,
        spread_bps=Decimal("1"),
        liquidity_usd=Decimal("100000"),
        volatility_bps=Decimal("50"),
        book_imbalance=Decimal("0"),
        source_lag_seconds=1,
        bid_price=Decimal("599.5"),
        ask_price=Decimal("600.5"),
        quote_lag_seconds=quote_lag_seconds,
    )
