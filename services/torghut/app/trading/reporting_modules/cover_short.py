# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Evaluation report generation and governance gates for walk-forward runs."""

from __future__ import annotations

import json
import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal, ROUND_FLOOR
from pathlib import Path
from typing import Any, Literal, Mapping, Optional, cast

from ...models import Strategy
from ..costs import CostModelConfig, CostModelInputs, OrderIntent, TransactionCostModel
from ..evaluation import WalkForwardDecision, WalkForwardResults
from ..evaluation_trace import SweepCandidateResult
from ..regime import RegimeLabel, classify_regime

# ruff: noqa: F401,F811,F821

from .evaluationreportconfig import (
    EvaluationGateOutcome,
    EvaluationGatePolicy,
    EvaluationImpactAssumptions,
    EvaluationMetrics,
    EvaluationReport,
    EvaluationReportConfig,
    MultipleTestingSummary,
    PromotionEvidenceSummary,
    PromotionRecommendation,
    RobustnessFoldMetrics,
    RobustnessReport,
    PositionState as _PositionState,
    ResolvedImpactInputs as _ResolvedImpactInputs,
    apply_fill as _apply_fill,
    close_long as _close_long,
    evaluate_gates as _evaluate_gates,
    evaluate_metrics as _evaluate_metrics,
    evaluate_multiple_testing as _evaluate_multiple_testing,
    evaluate_robustness as _evaluate_robustness,
    flatten_decisions as _flatten_decisions,
    open_long as _open_long,
    open_short as _open_short,
    build_promotion_recommendation,
    generate_evaluation_report,
    write_evaluation_report,
)


def _cover_short(
    state: _PositionState,
    qty: Decimal,
    price: Decimal,
    realized_pnl: Decimal,
    trade_count: int,
) -> tuple[Decimal, int]:
    closing_qty = min(qty, abs(state.qty))
    if state.avg_price is not None:
        realized_pnl += (state.avg_price - price) * closing_qty
        trade_count += 1
    state.qty += closing_qty
    if state.qty == 0:
        state.avg_price = None
    remaining = qty - closing_qty
    if remaining > 0:
        return _open_long(state, remaining, price, realized_pnl, trade_count)
    return realized_pnl, trade_count


def _unrealized_pnl(
    positions: dict[tuple[str, str], _PositionState],
    last_prices: dict[tuple[str, str], Decimal],
) -> Decimal:
    unrealized = Decimal("0")
    for key, state in positions.items():
        if state.qty == 0 or state.avg_price is None:
            continue
        price = last_prices.get(key, state.avg_price)
        if state.qty > 0:
            unrealized += (price - state.avg_price) * state.qty
        else:
            unrealized += (state.avg_price - price) * abs(state.qty)
    return unrealized


def _exposure_notional(
    positions: dict[tuple[str, str], _PositionState],
    last_prices: dict[tuple[str, str], Decimal],
) -> Decimal:
    exposure = Decimal("0")
    for key, state in positions.items():
        if state.qty == 0:
            continue
        price = last_prices.get(key, state.avg_price)
        if price is None:
            continue
        exposure += abs(state.qty * price)
    return exposure


def _estimate_cost(
    cost_model: TransactionCostModel, decision: Any, price: Decimal
) -> Decimal:
    order = OrderIntent(
        symbol=decision.symbol,
        side="buy" if decision.action == "buy" else "sell",
        qty=_decimal(decision.qty) or Decimal("0"),
        price=price,
        order_type=decision.order_type,
    )
    inputs = CostModelInputs(
        price=price,
        spread=_decimal(decision.params.get("spread")),
        volatility=_decimal(decision.params.get("volatility")),
        adv=_decimal(decision.params.get("adv")),
        execution_seconds=int(decision.params.get("execution_seconds", 60)),
    )
    estimate = cost_model.estimate_costs(order, inputs)
    return estimate.total_cost


def _resolve_price(decision: Any, item: WalkForwardDecision) -> Optional[Decimal]:
    if item.features.price is not None:
        return item.features.price
    candidate = decision.params.get("price")
    if candidate is None:
        candidate = decision.params.get("limit_price")
    if candidate is None:
        candidate = decision.params.get("stop_price")
    return _decimal(candidate)


def _cost_model_payload(config: CostModelConfig) -> dict[str, str]:
    return {
        "commission_bps": str(config.commission_bps),
        "commission_per_share": str(config.commission_per_share),
        "min_commission": str(config.min_commission),
        "max_participation_rate": str(config.max_participation_rate),
        "impact_bps_at_full_participation": str(
            config.impact_bps_at_full_participation
        ),
        "impact_participation_exponent": str(config.impact_participation_exponent),
    }


def _collect_impact_assumptions(
    decisions: list[WalkForwardDecision],
    cost_model_config: CostModelConfig,
) -> EvaluationImpactAssumptions:
    spread_count = 0
    volatility_count = 0
    adv_count = 0
    execution_seconds_values: list[int] = []
    decisions_with_recorded_inputs = 0

    for item in decisions:
        params = item.decision.params
        impact_inputs, from_recorded = _resolve_impact_inputs(params)
        if from_recorded:
            decisions_with_recorded_inputs += 1

        if impact_inputs.spread is not None:
            spread_count += 1
        if impact_inputs.volatility is not None:
            volatility_count += 1
        if impact_inputs.adv is not None:
            adv_count += 1
        execution_seconds_values.append(impact_inputs.execution_seconds)

    default_execution_seconds = 60
    if execution_seconds_values:
        default_execution_seconds = _deterministic_mode_int(execution_seconds_values)

    return EvaluationImpactAssumptions(
        default_execution_seconds=default_execution_seconds,
        decisions_with_spread=spread_count,
        decisions_with_volatility=volatility_count,
        decisions_with_adv=adv_count,
        assumptions={
            "commission_bps": str(cost_model_config.commission_bps),
            "impact_bps_at_full_participation": str(
                cost_model_config.impact_bps_at_full_participation
            ),
            "impact_participation_exponent": str(
                cost_model_config.impact_participation_exponent
            ),
            "max_participation_rate": str(cost_model_config.max_participation_rate),
            "recorded_inputs_count": str(decisions_with_recorded_inputs),
            "fallback_inputs_count": str(
                max(len(decisions) - decisions_with_recorded_inputs, 0)
            ),
        },
    )


def _strategy_payload(strategy: Strategy) -> dict[str, object]:
    return {
        "id": str(strategy.id),
        "name": strategy.name,
        "base_timeframe": strategy.base_timeframe,
        "universe_type": strategy.universe_type,
        "universe_symbols": strategy.universe_symbols,
    }


def _decimal(value: Any) -> Optional[Decimal]:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ArithmeticError, TypeError, ValueError):
        return None


def _resolve_impact_inputs(
    params: dict[str, Any],
) -> tuple[_ResolvedImpactInputs, bool]:
    recorded = _recorded_impact_inputs(params)
    if recorded is not None:
        return recorded, True

    execution_seconds = _as_int(params.get("execution_seconds"))
    if execution_seconds is None or execution_seconds <= 0:
        execution_seconds = 60
    return _ResolvedImpactInputs(
        spread=_decimal(params.get("spread")),
        volatility=_decimal(params.get("volatility")),
        adv=_decimal(params.get("adv")),
        execution_seconds=execution_seconds,
    ), False


def _recorded_impact_inputs(params: dict[str, Any]) -> Optional[_ResolvedImpactInputs]:
    raw = params.get("impact_assumptions")
    if not isinstance(raw, dict):
        return None
    raw_payload = cast(dict[str, Any], raw)
    inputs_raw = raw_payload.get("inputs")
    if not isinstance(inputs_raw, Mapping):
        return None
    inputs = cast(Mapping[str, Any], inputs_raw)

    execution_seconds = _as_int(inputs.get("execution_seconds"))
    if execution_seconds is None or execution_seconds <= 0:
        execution_seconds = 60

    return _ResolvedImpactInputs(
        spread=_decimal(inputs.get("spread")),
        volatility=_decimal(inputs.get("volatility")),
        adv=_decimal(inputs.get("adv")),
        execution_seconds=execution_seconds,
    )


def _as_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _deterministic_mode_int(values: list[int]) -> int:
    counts: dict[int, int] = {}
    for value in values:
        counts[value] = counts.get(value, 0) + 1
    # Deterministic tie-break: choose the smallest value when counts match.
    return sorted(counts.items(), key=lambda item: (-item[1], item[0]))[0][0]


def _bps_from_cost(cost: Decimal, notional: Decimal) -> Decimal:
    if notional <= 0:
        return Decimal("0")
    return (cost / notional) * Decimal("10000")


def _decimal_mean(values: list[Decimal]) -> Decimal:
    if not values:
        return Decimal("0")
    total = sum(values, Decimal("0"))
    return total / Decimal(len(values))


def _decimal_std(values: list[Decimal], mean: Decimal) -> Decimal:
    if len(values) <= 1:
        return Decimal("0")
    variance = sum((value - mean) ** 2 for value in values) / Decimal(len(values))
    return variance.sqrt()


@dataclass(frozen=True)
class ProfitabilityConstraintPolicy:
    holdout_target_net_per_day: Decimal = Decimal("250")
    min_active_holdout_days: int = 3
    max_worst_holdout_day_loss: Decimal = Decimal("150")
    max_holdout_drawdown_pct_equity: Decimal | None = Decimal("0.05")
    min_holdout_p10_daily_net: Decimal | None = None
    min_profit_factor: Decimal = Decimal("1.5")
    require_training_decisions: bool = True
    require_holdout_decisions: bool = True


@dataclass(frozen=True)
class ReplayProfitabilitySummary:
    start_date: str
    end_date: str
    start_equity: Decimal | None
    trading_day_count: int
    net_pnl: Decimal
    net_per_day: Decimal
    active_days: int
    decision_count: int
    filled_count: int
    wins: int
    losses: int
    worst_day_net: Decimal
    p10_daily_net: Decimal
    max_drawdown: Decimal
    max_drawdown_pct_equity: Decimal | None
    profit_factor: Decimal | None
    daily_net: dict[str, Decimal]


def _daily_drawdown(daily_net: Mapping[str, Decimal]) -> Decimal:
    peak = Decimal("0")
    cumulative = Decimal("0")
    max_drawdown = Decimal("0")
    for day in sorted(daily_net):
        cumulative += daily_net[day]
        if cumulative > peak:
            peak = cumulative
        drawdown = peak - cumulative
        if drawdown > max_drawdown:
            max_drawdown = drawdown
    return max_drawdown


def _daily_quantile_floor(
    daily_net: Mapping[str, Decimal], quantile: Decimal
) -> Decimal:
    values = sorted(daily_net.values())
    if not values:
        return Decimal("0")
    bounded_quantile = min(max(quantile, Decimal("0")), Decimal("1"))
    index = int(
        (Decimal(len(values) - 1) * bounded_quantile).to_integral_value(
            rounding=ROUND_FLOOR
        )
    )
    return values[index]


def summarize_replay_profitability(
    payload: Mapping[str, Any],
) -> ReplayProfitabilitySummary:
    daily_payload = cast(Mapping[str, Any], payload.get("daily") or {})
    daily_net: dict[str, Decimal] = {}
    for day, value in daily_payload.items():
        if not isinstance(value, Mapping):
            continue
        value_mapping = cast(Mapping[str, Any], value)
        daily_net[str(day)] = _decimal(value_mapping.get("net_pnl")) or Decimal("0")

    trading_day_count = len(daily_net)
    net_pnl = _decimal(payload.get("net_pnl")) or Decimal("0")
    active_days = sum(
        1
        for value in daily_payload.values()
        if isinstance(value, Mapping)
        and int(cast(Mapping[str, Any], value).get("filled_count", 0)) > 0
    )
    positive_total = sum(
        (value for value in daily_net.values() if value > 0), Decimal("0")
    )
    negative_total = sum(
        (-value for value in daily_net.values() if value < 0), Decimal("0")
    )
    profit_factor = (
        (positive_total / negative_total)
        if negative_total > 0
        else (Decimal("999999") if positive_total > 0 else None)
    )
    worst_day_net = min(daily_net.values()) if daily_net else Decimal("0")
    start_equity = _decimal(payload.get("start_equity"))
    max_drawdown = _daily_drawdown(daily_net)
    max_drawdown_pct_equity = (
        max_drawdown / start_equity
        if start_equity is not None and start_equity > 0
        else None
    )
    net_per_day = (
        net_pnl / Decimal(trading_day_count) if trading_day_count > 0 else Decimal("0")
    )
    return ReplayProfitabilitySummary(
        start_date=str(payload.get("start_date") or ""),
        end_date=str(payload.get("end_date") or ""),
        start_equity=start_equity,
        trading_day_count=trading_day_count,
        net_pnl=net_pnl,
        net_per_day=net_per_day,
        active_days=active_days,
        decision_count=int(payload.get("decision_count", 0)),
        filled_count=int(payload.get("filled_count", 0)),
        wins=int(payload.get("wins", 0)),
        losses=int(payload.get("losses", 0)),
        worst_day_net=worst_day_net,
        p10_daily_net=_daily_quantile_floor(daily_net, Decimal("0.10")),
        max_drawdown=max_drawdown,
        max_drawdown_pct_equity=max_drawdown_pct_equity,
        profit_factor=profit_factor,
        daily_net=daily_net,
    )


def score_replay_profitability_candidate(
    *,
    family: str,
    strategy_name: str,
    replay_config: Mapping[str, Any],
    train_payload: Mapping[str, Any],
    holdout_payload: Mapping[str, Any],
    policy: ProfitabilityConstraintPolicy = ProfitabilityConstraintPolicy(),
) -> SweepCandidateResult:
    train = summarize_replay_profitability(train_payload)
    holdout = summarize_replay_profitability(holdout_payload)

    penalties = Decimal("0")
    if holdout.active_days < policy.min_active_holdout_days:
        penalties += Decimal(
            policy.min_active_holdout_days - holdout.active_days
        ) * Decimal("250")
    if holdout.worst_day_net < -policy.max_worst_holdout_day_loss:
        penalties += abs(holdout.worst_day_net + policy.max_worst_holdout_day_loss)
    if (
        policy.max_holdout_drawdown_pct_equity is not None
        and holdout.max_drawdown_pct_equity is not None
        and holdout.max_drawdown_pct_equity > policy.max_holdout_drawdown_pct_equity
    ):
        equity = holdout.start_equity or Decimal("0")
        penalties += (
            holdout.max_drawdown_pct_equity - policy.max_holdout_drawdown_pct_equity
        ) * equity
    if (
        policy.min_holdout_p10_daily_net is not None
        and holdout.p10_daily_net < policy.min_holdout_p10_daily_net
    ):
        penalties += policy.min_holdout_p10_daily_net - holdout.p10_daily_net
    if holdout.profit_factor is None:
        penalties += Decimal("250")
    elif holdout.profit_factor < policy.min_profit_factor:
        penalties += (policy.min_profit_factor - holdout.profit_factor) * Decimal("250")
    if policy.require_training_decisions and train.decision_count <= 0:
        penalties += Decimal("250")
    if policy.require_holdout_decisions and holdout.decision_count <= 0:
        penalties += Decimal("500")
    if holdout.net_per_day < policy.holdout_target_net_per_day:
        penalties += policy.holdout_target_net_per_day - holdout.net_per_day

    score = holdout.net_per_day - penalties
    candidate_key = json.dumps(
        {
            "family": family,
            "strategy_name": strategy_name,
            "replay_config": dict(replay_config),
            "train": {
                "start_date": train.start_date,
                "end_date": train.end_date,
                "net_per_day": str(train.net_per_day),
            },
            "holdout": {
                "start_date": holdout.start_date,
                "end_date": holdout.end_date,
                "net_per_day": str(holdout.net_per_day),
            },
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    candidate_id = hashlib.sha256(candidate_key.encode("utf-8")).hexdigest()[:24]
    return SweepCandidateResult(
        candidate_id=candidate_id,
        family=family,
        strategy_name=strategy_name,
        train_net_per_day=train.net_per_day,
        holdout_net_per_day=holdout.net_per_day,
        train_total_net=train.net_pnl,
        holdout_total_net=holdout.net_pnl,
        active_holdout_days=holdout.active_days,
        max_holdout_drawdown_day=abs(min(holdout.worst_day_net, Decimal("0"))),
        holdout_max_drawdown=holdout.max_drawdown,
        holdout_max_drawdown_pct_equity=holdout.max_drawdown_pct_equity,
        holdout_p10_daily_net=holdout.p10_daily_net,
        profit_factor=holdout.profit_factor,
        wins=holdout.wins,
        losses=holdout.losses,
        score=score,
        replay_config=dict(replay_config),
    )


__all__ = [
    "EvaluationImpactAssumptions",
    "EvaluationGateOutcome",
    "EvaluationGatePolicy",
    "EvaluationMetrics",
    "EvaluationReport",
    "EvaluationReportConfig",
    "MultipleTestingSummary",
    "ProfitabilityConstraintPolicy",
    "PromotionEvidenceSummary",
    "PromotionRecommendation",
    "ReplayProfitabilitySummary",
    "RobustnessFoldMetrics",
    "RobustnessReport",
    "build_promotion_recommendation",
    "generate_evaluation_report",
    "score_replay_profitability_candidate",
    "summarize_replay_profitability",
    "write_evaluation_report",
]


# Public aliases used by split-module consumers.
bps_from_cost = _bps_from_cost
collect_impact_assumptions = _collect_impact_assumptions
cost_model_payload = _cost_model_payload
cover_short = _cover_short
decimal = _decimal
decimal_mean = _decimal_mean
decimal_std = _decimal_std
estimate_cost = _estimate_cost
exposure_notional = _exposure_notional
resolve_price = _resolve_price
strategy_payload = _strategy_payload
unrealized_pnl = _unrealized_pnl

__all__ = (
    "ProfitabilityConstraintPolicy",
    "ReplayProfitabilitySummary",
    "summarize_replay_profitability",
    "score_replay_profitability_candidate",
    "bps_from_cost",
    "collect_impact_assumptions",
    "cost_model_payload",
    "cover_short",
    "decimal",
    "decimal_mean",
    "decimal_std",
    "estimate_cost",
    "exposure_notional",
    "resolve_price",
    "strategy_payload",
    "unrealized_pnl",
)
