"""Runtime-closure bundle helpers for MLX autoresearch outputs."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Mapping


from app.trading.discovery.autoresearch import (
    StrategyAutoresearchProgram,
)
from app.trading.costs import BPS_SCALE, CostModelConfig, participation_power


from .context import (
    to_string,
    to_mapping,
    to_int,
    to_decimal,
    decimal_to_string,
    runtime_family,
    runtime_strategy_name,
)
from .candidate_payloads import (
    portfolio_runtime_strategy_names,
)


@dataclass(frozen=True)
class MarketImpactSource:
    report: Mapping[str, Any]
    summary: Mapping[str, Any]
    scorecard: Mapping[str, Any]
    daily_net: Mapping[str, Decimal]
    daily_notional: Mapping[str, Decimal]
    daily_liquidity: Mapping[str, Decimal]
    trading_days: int
    total_filled_notional: Decimal
    avg_filled_notional: Decimal
    reference_notional: Decimal
    reference_adv: Decimal
    max_participation: Decimal


@dataclass(frozen=True)
class MarketImpactDayResult:
    row: Mapping[str, Any]
    impact_cost: Decimal
    impact_bps_notional: Decimal
    recorded_liquidity: bool
    missing_liquidity_day: str | None


@dataclass(frozen=True)
class MarketImpactRollup:
    rows: list[Mapping[str, Any]]
    total_impact_cost: Decimal
    weighted_impact_bps_notional: Decimal
    recorded_liquidity_days: int
    missing_liquidity_days: tuple[str, ...]


def market_impact_stress_report(
    *,
    runner_run_id: str,
    best_candidate: Mapping[str, Any],
    approval_report: Mapping[str, Any],
    program: StrategyAutoresearchProgram,
    cost_model_config: CostModelConfig | None = None,
) -> dict[str, Any]:
    config = cost_model_config or CostModelConfig()
    source = market_impact_source(
        approval_report=approval_report,
        program=program,
        config=config,
    )
    rollup = market_impact_rollup(source=source, config=config)
    impact_cost_bps = weighted_bps(
        weighted_bps_notional=rollup.weighted_impact_bps_notional,
        total_filled_notional=source.total_filled_notional,
    )
    net_pnl = to_decimal(source.summary.get("net_pnl"))
    post_impact_net_pnl = net_pnl - rollup.total_impact_cost
    post_impact_net_pnl_per_day = per_trading_day(
        value=post_impact_net_pnl,
        trading_days=source.trading_days,
    )
    reasons = market_impact_reasons(
        source=source,
        rollup=rollup,
        impact_cost_bps=impact_cost_bps,
        post_impact_net_pnl_per_day=post_impact_net_pnl_per_day,
        program=program,
    )
    objective_met = not reasons
    return {
        "schema_version": "torghut.market-impact-stress-report.v1",
        "run_id": runner_run_id,
        "candidate_id": to_string(best_candidate.get("candidate_id")),
        "runtime_family": runtime_family(best_candidate),
        "runtime_strategy_name": runtime_strategy_name(best_candidate),
        "runtime_strategy_names": list(
            portfolio_runtime_strategy_names(best_candidate)
        ),
        "model": "square_root",
        "impact_model": "square_root",
        "source_markers": [
            "order_flow_market_impact_arxiv_2601_23172_2026",
            "realistic_market_impact_arxiv_2603_29086_2026",
        ],
        "objective_met": objective_met,
        "passed": objective_met,
        "reasons": reasons,
        "target_net_pnl_per_day": decimal_to_string(
            program.objective.target_net_pnl_per_day
        ),
        "net_pnl_per_day": decimal_to_string(
            to_decimal(source.scorecard.get("net_pnl_per_day"))
        ),
        "post_impact_net_pnl_per_day": decimal_to_string(post_impact_net_pnl_per_day),
        "stressed_net_pnl_per_day": decimal_to_string(post_impact_net_pnl_per_day),
        "net_pnl": decimal_to_string(net_pnl),
        "post_impact_net_pnl": decimal_to_string(post_impact_net_pnl),
        "impact_cost": decimal_to_string(rollup.total_impact_cost),
        "impact_cost_bps": decimal_to_string(impact_cost_bps),
        "market_impact_cost_bps": decimal_to_string(impact_cost_bps),
        "liquidity_evidence_present": not rollup.missing_liquidity_days
        and source.total_filled_notional > 0,
        "liquidity_input_source": "recorded_liquidity_notional"
        if rollup.recorded_liquidity_days
        else "synthetic_proxy",
        "recorded_liquidity_day_count": rollup.recorded_liquidity_days,
        "missing_liquidity_days": list(rollup.missing_liquidity_days),
        "reference_notional": decimal_to_string(source.reference_notional),
        "reference_adv_proxy": decimal_to_string(source.reference_adv),
        "max_participation_rate": decimal_to_string(source.max_participation),
        "impact_bps_at_full_participation": decimal_to_string(
            config.impact_bps_at_full_participation
        ),
        "impact_participation_exponent": decimal_to_string(
            config.impact_participation_exponent
        ),
        "trading_day_count": source.trading_days,
        "total_filled_notional": decimal_to_string(source.total_filled_notional),
        "avg_filled_notional_per_day": decimal_to_string(source.avg_filled_notional),
        "daily": rollup.rows,
    }


def market_impact_source(
    *,
    approval_report: Mapping[str, Any],
    program: StrategyAutoresearchProgram,
    config: CostModelConfig,
) -> MarketImpactSource:
    report = to_mapping(approval_report)
    summary = to_mapping(report.get("summary"))
    daily_net = daily_decimal_map(summary, "daily_net")
    daily_notional = daily_decimal_map(summary, "daily_filled_notional")
    trading_days = max(to_int(summary.get("trading_day_count")), len(daily_net))
    total_filled_notional = sum(daily_notional.values(), Decimal("0"))
    avg_filled_notional = per_trading_day(
        value=total_filled_notional,
        trading_days=trading_days,
    )
    reference_notional = max(
        program.objective.min_daily_notional,
        avg_filled_notional,
        Decimal("1"),
    )
    max_participation = max_participation_rate(config)
    return MarketImpactSource(
        report=report,
        summary=summary,
        scorecard=to_mapping(report.get("scorecard")),
        daily_net=daily_net,
        daily_notional=daily_notional,
        daily_liquidity=daily_decimal_map(summary, "daily_liquidity_notional"),
        trading_days=trading_days,
        total_filled_notional=total_filled_notional,
        avg_filled_notional=avg_filled_notional,
        reference_notional=reference_notional,
        reference_adv=reference_notional / max_participation,
        max_participation=max_participation,
    )


def daily_decimal_map(summary: Mapping[str, Any], key: str) -> dict[str, Decimal]:
    return {
        day: to_decimal(value) for day, value in to_mapping(summary.get(key)).items()
    }


def max_participation_rate(config: CostModelConfig) -> Decimal:
    if config.max_participation_rate > 0:
        return config.max_participation_rate
    return Decimal("0.1")


def per_trading_day(*, value: Decimal, trading_days: int) -> Decimal:
    return value / Decimal(trading_days) if trading_days > 0 else Decimal("0")


def weighted_bps(
    *,
    weighted_bps_notional: Decimal,
    total_filled_notional: Decimal,
) -> Decimal:
    if total_filled_notional <= 0:
        return Decimal("0")
    return weighted_bps_notional / total_filled_notional


def market_impact_rollup(
    *,
    source: MarketImpactSource,
    config: CostModelConfig,
) -> MarketImpactRollup:
    day_results = [
        market_impact_day_result(source=source, config=config, day=day)
        for day in sorted(source.daily_net)
    ]
    return MarketImpactRollup(
        rows=[item.row for item in day_results],
        total_impact_cost=sum(
            (item.impact_cost for item in day_results),
            Decimal("0"),
        ),
        weighted_impact_bps_notional=sum(
            (item.impact_bps_notional for item in day_results),
            Decimal("0"),
        ),
        recorded_liquidity_days=sum(
            1 for item in day_results if item.recorded_liquidity
        ),
        missing_liquidity_days=tuple(
            item.missing_liquidity_day
            for item in day_results
            if item.missing_liquidity_day is not None
        ),
    )


def market_impact_day_result(
    *,
    source: MarketImpactSource,
    config: CostModelConfig,
    day: str,
) -> MarketImpactDayResult:
    notional = source.daily_notional.get(day, Decimal("0"))
    liquidity_notional = source.daily_liquidity.get(day, Decimal("0"))
    recorded_liquidity = notional > 0 and liquidity_notional > 0
    participation_denominator = (
        liquidity_notional if recorded_liquidity else source.reference_adv
    )
    participation = (
        min(Decimal("1"), notional / participation_denominator)
        if participation_denominator > 0 and notional > 0
        else Decimal("0")
    )
    impact_bps = config.impact_bps_at_full_participation * participation_power(
        participation,
        config.impact_participation_exponent,
    )
    impact_cost = (notional * impact_bps) / BPS_SCALE
    return MarketImpactDayResult(
        row={
            "day": day,
            "net_pnl": decimal_to_string(source.daily_net[day]),
            "filled_notional": decimal_to_string(notional),
            "liquidity_notional": decimal_to_string(liquidity_notional),
            "liquidity_evidence_source": "recorded_liquidity_notional"
            if recorded_liquidity
            else "synthetic_proxy",
            "participation_rate_proxy": decimal_to_string(participation),
            "impact_cost_bps": decimal_to_string(impact_bps),
            "impact_cost": decimal_to_string(impact_cost),
            "post_impact_net_pnl": decimal_to_string(
                source.daily_net[day] - impact_cost
            ),
        },
        impact_cost=impact_cost,
        impact_bps_notional=impact_bps * notional,
        recorded_liquidity=recorded_liquidity,
        missing_liquidity_day=day if notional > 0 and not recorded_liquidity else None,
    )


def market_impact_reasons(
    *,
    source: MarketImpactSource,
    rollup: MarketImpactRollup,
    impact_cost_bps: Decimal,
    post_impact_net_pnl_per_day: Decimal,
    program: StrategyAutoresearchProgram,
) -> list[str]:
    reasons: list[str] = []
    if source.trading_days <= 0:
        reasons.append("market_impact_stress_trading_days_missing")
    if source.total_filled_notional <= 0:
        reasons.append("market_impact_stress_filled_notional_missing")
    if rollup.missing_liquidity_days:
        reasons.append("market_impact_stress_liquidity_evidence_missing")
    if impact_cost_bps <= 0:
        reasons.append("market_impact_stress_cost_bps_zero")
    if post_impact_net_pnl_per_day < program.objective.target_net_pnl_per_day:
        reasons.append("market_impact_stress_net_pnl_below_target")
    return reasons


def runtime_replay_net_pnl_per_day(report: Mapping[str, Any]) -> Decimal:
    scorecard = to_mapping(report.get("scorecard"))
    summary = to_mapping(report.get("summary"))
    explicit = to_decimal(
        scorecard.get("portfolio_post_cost_net_pnl_per_day")
        or scorecard.get("net_pnl_per_day")
        or summary.get("net_per_day"),
        default="-999999999",
    )
    if explicit != Decimal("-999999999"):
        return explicit
    trading_days = to_int(summary.get("trading_day_count"))
    if trading_days <= 0:
        return Decimal("0")
    return to_decimal(summary.get("net_pnl")) / Decimal(trading_days)


def double_oos_window_row(
    *,
    window_id: str,
    report: Mapping[str, Any] | None,
    target_net_pnl_per_day: Decimal,
) -> dict[str, Any]:
    if report is None:
        return {
            "window_id": window_id,
            "source": "double_oos_walkforward_arxiv_2602_10785_2026",
            "validation_type": "double_oos_walkforward",
            "passed": False,
            "status": "missing",
            "net_pnl_per_day": "0",
            "post_cost_net_pnl_per_day": "0",
            "trading_day_count": 0,
            "reasons": [f"{window_id}_replay_missing"],
        }
    summary = to_mapping(report.get("summary"))
    net_pnl_per_day = runtime_replay_net_pnl_per_day(report)
    reasons: list[str] = []
    if not bool(report.get("objective_met")):
        reasons.append(f"{window_id}_objective_not_met")
    if net_pnl_per_day < target_net_pnl_per_day:
        reasons.append(f"{window_id}_net_pnl_below_target")
    if to_int(summary.get("trading_day_count")) <= 0:
        reasons.append(f"{window_id}_trading_days_missing")
    passed = not reasons
    return {
        "window_id": window_id,
        "source": "double_oos_walkforward_arxiv_2602_10785_2026",
        "validation_type": "double_oos_walkforward",
        "passed": passed,
        "status": "pass" if passed else "fail",
        "net_pnl_per_day": decimal_to_string(net_pnl_per_day),
        "post_cost_net_pnl_per_day": decimal_to_string(net_pnl_per_day),
        "trading_day_count": to_int(summary.get("trading_day_count")),
        "start_date": to_string(summary.get("start_date")),
        "end_date": to_string(summary.get("end_date")),
        "decision_count": to_int(summary.get("decision_count")),
        "filled_count": to_int(summary.get("filled_count")),
        "reasons": reasons,
    }


def double_oos_cost_shock_net_pnl_per_day(
    *,
    double_oos_net_pnl_per_day: Decimal,
    market_impact_report: Mapping[str, Any] | None,
    delay_depth_report: Mapping[str, Any] | None,
) -> Decimal:
    stressed = [double_oos_net_pnl_per_day]
    if market_impact_report is not None:
        stressed.append(
            to_decimal(
                market_impact_report.get("post_impact_net_pnl_per_day")
                or market_impact_report.get("stressed_net_pnl_per_day")
            )
        )
    if delay_depth_report is not None:
        stressed.append(
            to_decimal(
                delay_depth_report.get("post_delay_depth_net_pnl_per_day")
                or delay_depth_report.get("stressed_net_pnl_per_day")
            )
        )
    return min(stressed, default=Decimal("0"))
