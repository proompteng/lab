from __future__ import annotations

from app.trading.costs import (
    CostModelInputs,
    OrderIntent,
    TransactionCostModel,
)

from app.trading.models import (
    SignalEnvelope,
    StrategyDecision,
)

from decimal import Decimal

from typing import (
    Any,
    Mapping,
)

from .replay_types import ReplayCostLineage

from .signal_rows import (
    _extract_price,
    _extract_spread,
    _extract_volatility,
    _observed_adv_notional_with_source,
)


def _estimate_trade_cost(
    *,
    model: TransactionCostModel,
    decision: StrategyDecision,
    signal: SignalEnvelope,
    day_bucket: Mapping[str, Any] | None = None,
    symbol_bucket: Mapping[str, Any] | None = None,
) -> Decimal:
    return _estimate_trade_cost_lineage(
        model=model,
        decision=decision,
        signal=signal,
        day_bucket=day_bucket,
        symbol_bucket=symbol_bucket,
    ).total_cost


def _estimate_trade_cost_lineage(
    *,
    model: TransactionCostModel,
    decision: StrategyDecision,
    signal: SignalEnvelope,
    day_bucket: Mapping[str, Any] | None = None,
    symbol_bucket: Mapping[str, Any] | None = None,
) -> ReplayCostLineage:
    price = _extract_price(signal)
    spread = _extract_spread(signal)
    volatility = _extract_volatility(signal)
    adv, adv_source = _observed_adv_notional_with_source(
        signal=signal,
        day_bucket=day_bucket,
        symbol_bucket=symbol_bucket,
    )
    estimate = model.estimate_costs(
        order=OrderIntent(
            symbol=decision.symbol,
            side=decision.action,
            qty=decision.qty,
            price=price,
            order_type=decision.order_type,
            time_in_force=decision.time_in_force,
        ),
        market=CostModelInputs(
            price=price,
            spread=spread,
            volatility=volatility,
            adv=adv,
        ),
    )
    return ReplayCostLineage(
        total_cost=estimate.total_cost,
        notional=estimate.notional,
        adv_notional=adv,
        adv_source=adv_source,
        participation_rate=estimate.participation_rate,
        spread=spread,
        volatility=volatility,
        spread_cost_bps=estimate.spread_cost_bps,
        volatility_cost_bps=estimate.volatility_cost_bps,
        impact_cost_bps=estimate.impact_cost_bps,
        commission_cost=estimate.commission_cost,
        commission_cost_bps=estimate.commission_cost_bps,
        sec_fee_cost=estimate.sec_fee_cost,
        taf_fee_cost=estimate.taf_fee_cost,
        cat_fee_cost=estimate.cat_fee_cost,
        regulatory_fee_cost=estimate.regulatory_fee_cost,
        regulatory_fee_cost_bps=estimate.regulatory_fee_cost_bps,
        total_cost_bps=estimate.total_cost_bps,
        capacity_ok=estimate.capacity_ok,
        warnings=tuple(estimate.warnings),
        max_participation_rate=model.config.max_participation_rate,
        impact_bps_at_full_participation=model.config.impact_bps_at_full_participation,
        impact_participation_exponent=model.config.impact_participation_exponent,
    )
