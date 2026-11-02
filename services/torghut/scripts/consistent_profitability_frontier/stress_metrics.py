from __future__ import annotations

from decimal import Decimal, ROUND_CEILING
from typing import Any, Mapping, Sequence

from app.trading.reporting import (
    ProfitabilityConstraintPolicy,
    summarize_replay_profitability,
)
from scripts.consistent_profitability_frontier.common import (
    FullWindowConsistencyPolicy,
    _SECOND_OOS_WINDOW_ID,
    _daily_decimal_metric,
    _daily_filled_notional,
    _daily_int_metric,
    _daily_liquidity_notional,
    _max_drawdown_from_daily_net,
    _optional_decimal,
)
from scripts.consistent_profitability_frontier.ledger_order import (
    _order_lifecycle_metrics,
    _order_type_execution_metrics,
)


DELAY_ADJUSTED_DEPTH_STRESS_GRID_MS = (
    Decimal("50"),
    Decimal("150"),
    Decimal("250"),
)


CONFORMAL_TAIL_RISK_ALPHA = Decimal("0.20")


BREAKEVEN_TRANSACTION_COST_BUFFER_MIN_BPS = Decimal("1")


MARKET_IMPACT_STRESS_SOURCE_MARKERS = (
    "realistic_market_impact_arxiv_2603_29086_2026",
    "double_square_root_impact_arxiv_2502_16246_2025",
)


def _p10(values: Sequence[Decimal]) -> Decimal:
    if not values:
        return Decimal("0")
    ordered = sorted(values)
    index = int((len(ordered) - 1) * 0.10)
    return ordered[index]


def _conformal_tail_loss_buffer(
    daily_net: Mapping[str, Decimal],
    *,
    alpha: Decimal = CONFORMAL_TAIL_RISK_ALPHA,
) -> Decimal:
    losses = sorted((max(Decimal("0"), -value) for value in daily_net.values()))
    if not losses:
        return Decimal("0")
    tail_fraction = max(Decimal("0"), min(Decimal("1"), alpha))
    tail_count = max(
        1,
        int(
            (Decimal(len(losses)) * tail_fraction).to_integral_value(
                rounding=ROUND_CEILING
            )
        ),
    )
    tail_count = min(tail_count, len(losses))
    return max(losses[-tail_count:], default=Decimal("0"))


def _conformal_tail_risk_metrics(
    *,
    target_net_per_day: Decimal,
    net_per_day: Decimal,
    daily_net: Mapping[str, Decimal],
) -> dict[str, Any]:
    buffer_per_day = _conformal_tail_loss_buffer(daily_net)
    adjusted_net_per_day = net_per_day - buffer_per_day
    sample_count = len(daily_net)
    passed = sample_count > 0 and adjusted_net_per_day >= target_net_per_day
    return {
        "conformal_tail_risk_required": True,
        "conformal_tail_risk_model": "empirical_daily_loss_conformal_buffer",
        "conformal_tail_risk_alpha": str(CONFORMAL_TAIL_RISK_ALPHA),
        "conformal_tail_risk_sample_count": sample_count,
        "conformal_tail_risk_buffer_per_day": str(buffer_per_day),
        "conformal_tail_risk_adjusted_net_pnl_per_day": str(adjusted_net_per_day),
        "conformal_tail_risk_target_net_pnl_per_day": str(target_net_per_day),
        "conformal_tail_risk_passed": passed,
        "conformal_tail_risk_source_markers": [
            "regime_weighted_conformal_var_arxiv_2602_03903_2026"
        ],
    }


def _breakeven_transaction_cost_buffer_metrics(
    *,
    target_net_per_day: Decimal,
    conformal_adjusted_net_per_day: Decimal,
    avg_filled_notional_per_day: Decimal,
    required_cost_buffer_bps: Decimal,
) -> dict[str, Any]:
    selected_cost_buffer_bps = max(
        BREAKEVEN_TRANSACTION_COST_BUFFER_MIN_BPS,
        required_cost_buffer_bps,
    )
    breakeven_surplus_per_day = max(
        Decimal("0"),
        conformal_adjusted_net_per_day - target_net_per_day,
    )
    breakeven_buffer_bps = (
        breakeven_surplus_per_day / avg_filled_notional_per_day * Decimal("10000")
        if avg_filled_notional_per_day > 0
        else Decimal("0")
    )
    buffer_cost_per_day = (
        avg_filled_notional_per_day * selected_cost_buffer_bps / Decimal("10000")
    )
    buffered_net_per_day = conformal_adjusted_net_per_day - buffer_cost_per_day
    passed = (
        avg_filled_notional_per_day > 0
        and breakeven_buffer_bps >= selected_cost_buffer_bps
        and buffered_net_per_day >= target_net_per_day
    )
    return {
        "required_breakeven_transaction_cost_buffer": True,
        "required_seed_model_family_robustness": True,
        "breakeven_transaction_cost_buffer_passed": passed,
        "breakeven_transaction_cost_buffer_bps": str(breakeven_buffer_bps),
        "transaction_cost_buffer_bps": str(selected_cost_buffer_bps),
        "transaction_cost_buffer_cost_per_day": str(buffer_cost_per_day),
        "post_cost_net_pnl_after_breakeven_transaction_cost_buffer": str(
            buffered_net_per_day
        ),
        "breakeven_transaction_cost_buffer_target_net_pnl_per_day": str(
            target_net_per_day
        ),
        "seed_model_family_robustness_status": (
            "required_not_materialized_by_single_frontier_replay"
        ),
        "seed_robustness_passed": False,
        "seed_robustness_sample_count": 0,
        "model_family_robustness_passed": False,
        "model_family_robustness_family_count": 0,
        "breakeven_transaction_cost_buffer_source_markers": [
            "regime_weighted_conformal_var_arxiv_2602_03903_2026",
            "realistic_market_impact_arxiv_2603_29086_2026",
        ],
        "seed_model_family_robustness_source_markers": [
            "regime_weighted_conformal_var_arxiv_2602_03903_2026"
        ],
    }


def _delay_depth_fillability(
    *,
    daily_filled_notional: Mapping[str, Decimal],
    daily_liquidity_notional: Mapping[str, Decimal],
    stress_ms: Decimal,
) -> tuple[Decimal, int, list[Decimal]]:
    haircut_rate = min(Decimal("0.50"), stress_ms / Decimal("1000"))
    total_fillable_notional = Decimal("0")
    missing_liquidity_day_count = 0
    active_day_fillable: list[Decimal] = []
    for day, filled_notional in daily_filled_notional.items():
        if filled_notional <= 0:
            continue
        liquidity_notional = daily_liquidity_notional.get(day, Decimal("0"))
        if liquidity_notional <= 0:
            missing_liquidity_day_count += 1
            active_day_fillable.append(Decimal("0"))
            continue
        fillable_notional = min(
            filled_notional,
            liquidity_notional * (Decimal("1") - haircut_rate),
        )
        active_day_fillable.append(fillable_notional)
        total_fillable_notional += fillable_notional
    return total_fillable_notional, missing_liquidity_day_count, active_day_fillable


def _implementation_uncertainty_metrics(
    *,
    target_net_per_day: Decimal,
    net_per_day: Decimal,
    avg_filled_notional_per_day: Decimal,
    square_root_impact_cost_bps: Decimal,
    almgren_chriss_impact_cost_bps: Decimal,
    nonlinear_impact_cost_bps: Decimal,
    delay_depth_net_per_day: Decimal,
) -> dict[str, Any]:
    impact_scenarios = {
        "square_root": net_per_day
        - (
            avg_filled_notional_per_day * square_root_impact_cost_bps / Decimal("10000")
        ),
        "almgren_chriss_proxy": net_per_day
        - (
            avg_filled_notional_per_day
            * almgren_chriss_impact_cost_bps
            / Decimal("10000")
        ),
        "selected_nonlinear_impact": net_per_day
        - (avg_filled_notional_per_day * nonlinear_impact_cost_bps / Decimal("10000")),
        "impact_decay_reversion_1_5x": net_per_day
        - (
            avg_filled_notional_per_day
            * nonlinear_impact_cost_bps
            * Decimal("1.5")
            / Decimal("10000")
        ),
        "latency_depth_fillability": delay_depth_net_per_day,
    }
    lower_bound = min(impact_scenarios.values(), default=Decimal("0"))
    upper_bound = max(impact_scenarios.values(), default=Decimal("0"))
    interval_width = upper_bound - lower_bound
    passed = (
        bool(impact_scenarios)
        and avg_filled_notional_per_day > 0
        and lower_bound >= target_net_per_day
    )
    return {
        "implementation_uncertainty_required": True,
        "implementation_uncertainty_model": "impact_latency_cost_model_interval",
        "implementation_uncertainty_model_count": len(impact_scenarios),
        "implementation_uncertainty_stability_passed": passed,
        "implementation_uncertainty_lower_net_pnl_per_day": str(lower_bound),
        "implementation_uncertainty_upper_net_pnl_per_day": str(upper_bound),
        "implementation_uncertainty_interval_width_per_day": str(interval_width),
        "implementation_uncertainty_target_net_pnl_per_day": str(target_net_per_day),
        "implementation_uncertainty_scenarios": {
            name: str(value) for name, value in impact_scenarios.items()
        },
        "implementation_uncertainty_source_markers": [
            "lob_simulation_reality_gap_arxiv_2603_24137_2026",
            "order_flow_market_impact_volatility_arxiv_2601_23172_2026",
            "double_square_root_impact_arxiv_2502_16246_2025",
            "implementation_risk_backtesting_arxiv_2603_20319_2026",
        ],
    }


def _replay_stress_metrics(
    *,
    target_net_per_day: Decimal,
    net_per_day: Decimal,
    trading_day_count: int,
    daily_filled_notional: Mapping[str, Decimal],
    daily_liquidity_notional: Mapping[str, Decimal],
    avg_filled_notional_per_day: Decimal,
    total_filled_notional: Decimal,
    total_liquidity_notional: Decimal,
    fill_survival_rate: Decimal | None = None,
    fill_survival_sample_count: int = 0,
    queue_ratio_p95: Decimal | None = None,
    queue_ahead_depletion_evidence_present: bool = False,
    queue_ahead_depletion_sample_count: int = 0,
) -> dict[str, Any]:
    participation = (
        total_filled_notional / total_liquidity_notional
        if total_filled_notional > 0 and total_liquidity_notional > 0
        else Decimal("0")
    )
    square_root_impact_cost_bps = (
        participation.sqrt() * Decimal("100") if participation > 0 else Decimal("0")
    )
    almgren_chriss_temporary_impact_bps = participation * Decimal("125")
    almgren_chriss_permanent_impact_bps = (
        participation.sqrt() * Decimal("25") if participation > 0 else Decimal("0")
    )
    almgren_chriss_impact_cost_bps = (
        almgren_chriss_temporary_impact_bps + almgren_chriss_permanent_impact_bps
    )
    nonlinear_impact_cost_bps = max(
        Decimal("1"),
        square_root_impact_cost_bps,
        almgren_chriss_impact_cost_bps,
    )
    market_impact_model = (
        "almgren_chriss_proxy"
        if almgren_chriss_impact_cost_bps > square_root_impact_cost_bps
        else "square_root"
    )
    market_impact_net_per_day = net_per_day - (
        avg_filled_notional_per_day * nonlinear_impact_cost_bps / Decimal("10000")
    )
    (
        delay_depth_total_fillable_notional,
        delay_depth_missing_liquidity_day_count,
        _active_day_fillable,
    ) = _delay_depth_fillability(
        daily_filled_notional=daily_filled_notional,
        daily_liquidity_notional=daily_liquidity_notional,
        stress_ms=Decimal("50"),
    )
    grid_fillability = {
        str(stress_ms): _delay_depth_fillability(
            daily_filled_notional=daily_filled_notional,
            daily_liquidity_notional=daily_liquidity_notional,
            stress_ms=stress_ms,
        )
        for stress_ms in DELAY_ADJUSTED_DEPTH_STRESS_GRID_MS
    }
    max_grid_stress_ms = max(DELAY_ADJUSTED_DEPTH_STRESS_GRID_MS)
    (
        grid_worst_total_fillable_notional,
        grid_worst_missing_liquidity_day_count,
        grid_worst_active_day_fillable,
    ) = grid_fillability[str(max_grid_stress_ms)]
    p10_active_day_fillable = _p10(grid_worst_active_day_fillable)
    worst_active_day_fillable = (
        min(grid_worst_active_day_fillable)
        if grid_worst_active_day_fillable
        else Decimal("0")
    )
    tail_coverage_passed = (
        bool(grid_worst_active_day_fillable)
        and grid_worst_missing_liquidity_day_count == 0
        and p10_active_day_fillable > 0
        and worst_active_day_fillable > 0
    )
    delay_depth_fillable_notional_per_day = (
        delay_depth_total_fillable_notional / Decimal(trading_day_count)
        if trading_day_count > 0
        else Decimal("0")
    )
    delay_depth_fillable_ratio = (
        delay_depth_total_fillable_notional / total_filled_notional
        if total_filled_notional > 0
        else Decimal("1")
    )
    survival_adjusted_fillable_ratio = delay_depth_fillable_ratio
    if fill_survival_sample_count > 0 and fill_survival_rate is not None:
        survival_adjusted_fillable_ratio *= max(
            Decimal("0"), min(Decimal("1"), fill_survival_rate)
        )
    delay_depth_net_per_day = (net_per_day * survival_adjusted_fillable_ratio) - (
        delay_depth_fillable_notional_per_day * Decimal("1") / Decimal("10000")
    )
    queue_position_nonfill_opportunity_cost_per_day = max(
        Decimal("0"), net_per_day - delay_depth_net_per_day
    )
    queue_position_nonfill_opportunity_cost_bps = (
        queue_position_nonfill_opportunity_cost_per_day
        / avg_filled_notional_per_day
        * Decimal("10000")
        if avg_filled_notional_per_day > 0
        else Decimal("0")
    )
    implementation_uncertainty = _implementation_uncertainty_metrics(
        target_net_per_day=target_net_per_day,
        net_per_day=net_per_day,
        avg_filled_notional_per_day=avg_filled_notional_per_day,
        square_root_impact_cost_bps=square_root_impact_cost_bps,
        almgren_chriss_impact_cost_bps=almgren_chriss_impact_cost_bps,
        nonlinear_impact_cost_bps=nonlinear_impact_cost_bps,
        delay_depth_net_per_day=delay_depth_net_per_day,
    )
    return {
        "market_impact_stress_passed": bool(
            total_liquidity_notional > 0
            and avg_filled_notional_per_day > 0
            and market_impact_net_per_day > 0
        ),
        "market_impact_stress_model": market_impact_model,
        "market_impact_stress_cost_bps": str(nonlinear_impact_cost_bps),
        "market_impact_stress_net_pnl_per_day": str(market_impact_net_per_day),
        "market_impact_stress_source_markers": list(
            MARKET_IMPACT_STRESS_SOURCE_MARKERS
        ),
        "market_impact_stress_components": {
            "square_root_cost_bps": str(square_root_impact_cost_bps),
            "almgren_chriss_temporary_impact_bps": str(
                almgren_chriss_temporary_impact_bps
            ),
            "almgren_chriss_permanent_impact_bps": str(
                almgren_chriss_permanent_impact_bps
            ),
            "almgren_chriss_cost_bps": str(almgren_chriss_impact_cost_bps),
            "selected_cost_bps": str(nonlinear_impact_cost_bps),
            "selected_model": market_impact_model,
            "source_marker": "realistic_market_impact_arxiv_2603_29086_2026",
            "source_markers": list(MARKET_IMPACT_STRESS_SOURCE_MARKERS),
        },
        "nonlinear_market_impact_stress_passed": bool(
            total_liquidity_notional > 0
            and avg_filled_notional_per_day > 0
            and market_impact_net_per_day > 0
        ),
        "nonlinear_market_impact_stress_model": market_impact_model,
        "nonlinear_market_impact_stress_cost_bps": str(nonlinear_impact_cost_bps),
        "nonlinear_market_impact_stress_net_pnl_per_day": str(
            market_impact_net_per_day
        ),
        "permanent_impact_decay_model": "exponential_decay_proxy",
        "delay_adjusted_depth_stress_passed": bool(
            total_liquidity_notional > 0
            and grid_worst_missing_liquidity_day_count == 0
            and tail_coverage_passed
            and delay_depth_fillable_notional_per_day > 0
            and delay_depth_net_per_day > 0
        ),
        "delay_adjusted_depth_stress_model": "latency_depth_haircut",
        "delay_adjusted_depth_stress_ms": "50",
        "delay_adjusted_depth_latency_grid_ms": [
            str(stress_ms) for stress_ms in DELAY_ADJUSTED_DEPTH_STRESS_GRID_MS
        ],
        "delay_adjusted_depth_grid_max_stress_ms": str(max_grid_stress_ms),
        "delay_adjusted_depth_liquidity_evidence_present": bool(
            total_liquidity_notional > 0 and grid_worst_missing_liquidity_day_count == 0
        ),
        "delay_adjusted_depth_liquidity_missing_day_count": max(
            delay_depth_missing_liquidity_day_count,
            grid_worst_missing_liquidity_day_count,
        ),
        "delay_adjusted_depth_fillable_notional_per_day": str(
            delay_depth_fillable_notional_per_day
        ),
        "delay_adjusted_depth_worst_grid_fillable_notional_per_day": str(
            grid_worst_total_fillable_notional / Decimal(trading_day_count)
            if trading_day_count > 0
            else Decimal("0")
        ),
        "delay_adjusted_depth_worst_active_day_fillable_notional": str(
            worst_active_day_fillable
        ),
        "delay_adjusted_depth_p10_active_day_fillable_notional": str(
            p10_active_day_fillable
        ),
        "delay_adjusted_depth_tail_coverage_passed": tail_coverage_passed,
        "delay_adjusted_depth_fillable_ratio": str(delay_depth_fillable_ratio),
        "delay_adjusted_depth_survival_adjusted_fillable_ratio": str(
            survival_adjusted_fillable_ratio
        ),
        "delay_adjusted_depth_fill_survival_evidence_present": (
            fill_survival_sample_count > 0
        ),
        "delay_adjusted_depth_fill_survival_sample_count": fill_survival_sample_count,
        "delay_adjusted_depth_fill_survival_rate": str(fill_survival_rate)
        if fill_survival_rate is not None
        else "",
        "delay_adjusted_depth_queue_ratio_p95": str(queue_ratio_p95)
        if queue_ratio_p95 is not None
        else "",
        "queue_position_survival_fill_curve_evidence_present": (
            fill_survival_sample_count > 0
            and queue_ratio_p95 is not None
            and queue_ahead_depletion_evidence_present
            and queue_ahead_depletion_sample_count > 0
        ),
        "queue_position_survival_sample_count": fill_survival_sample_count,
        "queue_position_survival_fill_rate": str(fill_survival_rate)
        if fill_survival_rate is not None
        else "",
        "queue_position_survival_queue_ratio_p95": str(queue_ratio_p95)
        if queue_ratio_p95 is not None
        else "",
        "queue_position_survival_queue_ahead_depletion_evidence_present": (
            queue_ahead_depletion_evidence_present
        ),
        "queue_position_survival_queue_ahead_depletion_sample_count": (
            queue_ahead_depletion_sample_count
        ),
        "queue_position_survival_adjusted_fillable_ratio": str(
            survival_adjusted_fillable_ratio
        ),
        "queue_position_survival_nonfill_opportunity_cost_per_day": str(
            queue_position_nonfill_opportunity_cost_per_day
        ),
        "queue_position_survival_nonfill_opportunity_cost_bps": str(
            queue_position_nonfill_opportunity_cost_bps
        ),
        "queue_position_survival_stress_net_pnl_per_day": str(delay_depth_net_per_day),
        "post_cost_net_pnl_after_queue_position_survival_fill_stress": str(
            delay_depth_net_per_day
        ),
        "queue_position_survival_source_marker": (
            "queue_position_survival_fill_probability_arxiv_2512_05734_2025"
        ),
        "delay_adjusted_depth_unfillable_notional_per_day": str(
            max(
                Decimal("0"),
                (total_filled_notional - delay_depth_total_fillable_notional)
                / Decimal(trading_day_count)
                if trading_day_count > 0
                else Decimal("0"),
            )
        ),
        "delay_adjusted_depth_stress_net_pnl_per_day": str(delay_depth_net_per_day),
        **implementation_uncertainty,
    }


def _decimal_payload_metric(
    payload: Mapping[str, Any],
    key: str,
    *,
    default: Decimal,
) -> Decimal:
    raw_value = payload.get(key)
    if raw_value is None:
        return default
    return Decimal(str(raw_value))


def _max_best_day_share_of_total_pnl(
    *,
    daily_net: Mapping[str, Decimal],
    total_net_pnl: Decimal,
) -> Decimal:
    if total_net_pnl <= 0:
        return Decimal("1")
    best_positive_day = max(
        (value for value in daily_net.values() if value > 0), default=Decimal("0")
    )
    if best_positive_day <= 0:
        return Decimal("0")
    return best_positive_day / total_net_pnl


def _consistency_penalty(
    *,
    full_window_payload: Mapping[str, Any],
    policy: FullWindowConsistencyPolicy,
) -> tuple[Decimal, dict[str, Any]]:
    summary = summarize_replay_profitability(full_window_payload)
    daily_filled_notional = _daily_filled_notional(full_window_payload)
    daily_liquidity_notional = _daily_liquidity_notional(full_window_payload)
    daily_gross_exposure_pct_equity = _daily_decimal_metric(
        full_window_payload,
        "max_gross_exposure_pct_equity",
    )
    daily_min_cash = _daily_decimal_metric(full_window_payload, "min_cash")
    daily_negative_cash_observations = _daily_int_metric(
        full_window_payload,
        "negative_cash_observation_count",
    )
    negative_days = sum(1 for value in summary.daily_net.values() if value < 0)
    positive_days = sum(1 for value in summary.daily_net.values() if value > 0)
    drawdown = _max_drawdown_from_daily_net(summary.daily_net)
    active_ratio = (
        Decimal(summary.active_days) / Decimal(summary.trading_day_count)
        if summary.trading_day_count > 0
        else Decimal("0")
    )
    total_filled_notional = sum(daily_filled_notional.values(), Decimal("0"))
    total_liquidity_notional = sum(
        daily_liquidity_notional.values(),
        Decimal("0"),
    )
    avg_filled_notional_per_day = (
        total_filled_notional / Decimal(summary.trading_day_count)
        if summary.trading_day_count > 0
        else Decimal("0")
    )
    avg_liquidity_notional_per_day = (
        total_liquidity_notional / Decimal(summary.trading_day_count)
        if summary.trading_day_count > 0
        else Decimal("0")
    )
    avg_filled_notional_per_active_day = (
        total_filled_notional / Decimal(summary.active_days)
        if summary.active_days > 0
        else Decimal("0")
    )
    order_lifecycle_metrics = _order_lifecycle_metrics(full_window_payload)
    fill_survival_rate = _optional_decimal(
        order_lifecycle_metrics.get("fill_survival_fill_rate")
    )
    queue_ratio_p95 = _optional_decimal(
        order_lifecycle_metrics.get("order_qty_to_touch_qty_ratio_p95")
    )
    replay_stress_metrics = _replay_stress_metrics(
        target_net_per_day=policy.target_net_per_day,
        net_per_day=summary.net_per_day,
        trading_day_count=summary.trading_day_count,
        daily_filled_notional=daily_filled_notional,
        daily_liquidity_notional=daily_liquidity_notional,
        avg_filled_notional_per_day=avg_filled_notional_per_day,
        total_filled_notional=total_filled_notional,
        total_liquidity_notional=total_liquidity_notional,
        fill_survival_rate=fill_survival_rate,
        fill_survival_sample_count=int(
            order_lifecycle_metrics.get("fill_survival_sample_count") or 0
        ),
        queue_ratio_p95=queue_ratio_p95,
        queue_ahead_depletion_evidence_present=bool(
            order_lifecycle_metrics.get("queue_ahead_depletion_evidence_present")
        ),
        queue_ahead_depletion_sample_count=int(
            order_lifecycle_metrics.get("queue_ahead_depletion_sample_count") or 0
        ),
    )
    conformal_tail_risk_metrics = _conformal_tail_risk_metrics(
        target_net_per_day=policy.target_net_per_day,
        net_per_day=summary.net_per_day,
        daily_net=summary.daily_net,
    )
    breakeven_cost_buffer_metrics = _breakeven_transaction_cost_buffer_metrics(
        target_net_per_day=policy.target_net_per_day,
        conformal_adjusted_net_per_day=Decimal(
            str(
                conformal_tail_risk_metrics[
                    "conformal_tail_risk_adjusted_net_pnl_per_day"
                ]
            )
        ),
        avg_filled_notional_per_day=avg_filled_notional_per_day,
        required_cost_buffer_bps=Decimal(
            str(replay_stress_metrics.get("market_impact_stress_cost_bps") or "0")
        ),
    )
    best_day_share_of_total_pnl = _max_best_day_share_of_total_pnl(
        daily_net=summary.daily_net,
        total_net_pnl=summary.net_pnl,
    )
    min_daily_net_pnl = min(summary.daily_net.values(), default=Decimal("0"))
    daily_net_below_min_count = sum(
        1 for value in summary.daily_net.values() if value < policy.min_daily_net_pnl
    )
    if (
        policy.min_daily_net_pnl > 0
        and len(summary.daily_net) < summary.trading_day_count
    ):
        daily_net_below_min_count += summary.trading_day_count - len(summary.daily_net)
    max_gross_exposure_pct_equity = max(
        (
            _decimal_payload_metric(
                full_window_payload,
                "max_gross_exposure_pct_equity",
                default=Decimal("0"),
            ),
            *daily_gross_exposure_pct_equity.values(),
        ),
        default=Decimal("0"),
    )
    min_cash = min(
        (
            _decimal_payload_metric(
                full_window_payload, "min_cash", default=Decimal("0")
            ),
            *daily_min_cash.values(),
        ),
        default=Decimal("0"),
    )
    negative_cash_observation_count = max(
        int(full_window_payload.get("negative_cash_observation_count") or 0),
        sum(daily_negative_cash_observations.values()),
    )
    penalties = Decimal("0")

    if (
        policy.min_window_weekday_count > 0
        and summary.trading_day_count < policy.min_window_weekday_count
    ):
        penalties += Decimal(
            policy.min_window_weekday_count - summary.trading_day_count
        ) * Decimal("1000")
    if summary.net_per_day < policy.target_net_per_day:
        penalties += policy.target_net_per_day - summary.net_per_day
    if policy.min_daily_net_pnl > 0 and daily_net_below_min_count > 0:
        penalties += sum(
            max(Decimal("0"), policy.min_daily_net_pnl - value)
            for value in summary.daily_net.values()
        )
        penalties += (
            Decimal(max(0, summary.trading_day_count - len(summary.daily_net)))
            * policy.min_daily_net_pnl
        )
    effective_min_active_days = min(policy.min_active_days, summary.trading_day_count)
    if summary.active_days < effective_min_active_days:
        penalties += Decimal(effective_min_active_days - summary.active_days) * Decimal(
            "250"
        )
    if active_ratio < policy.min_active_ratio:
        penalties += (policy.min_active_ratio - active_ratio) * Decimal("2000")
    effective_min_positive_days = min(
        policy.min_positive_days,
        summary.trading_day_count,
    )
    if positive_days < effective_min_positive_days:
        penalties += Decimal(effective_min_positive_days - positive_days) * Decimal(
            "350"
        )
    if (
        policy.require_every_day_active
        and summary.active_days < summary.trading_day_count
    ):
        penalties += Decimal(summary.trading_day_count - summary.active_days) * Decimal(
            "400"
        )
    if summary.worst_day_net < -policy.max_worst_day_loss:
        penalties += abs(summary.worst_day_net + policy.max_worst_day_loss)
    if negative_days > policy.max_negative_days:
        penalties += Decimal(negative_days - policy.max_negative_days) * Decimal("300")
    if drawdown > policy.max_drawdown:
        penalties += drawdown - policy.max_drawdown
    if best_day_share_of_total_pnl > policy.max_best_day_share_of_total_pnl:
        penalties += (
            best_day_share_of_total_pnl - policy.max_best_day_share_of_total_pnl
        ) * abs(summary.net_pnl)
    if avg_filled_notional_per_day < policy.min_avg_filled_notional_per_day:
        penalties += (
            policy.min_avg_filled_notional_per_day - avg_filled_notional_per_day
        ) / Decimal("1000")
    if (
        avg_filled_notional_per_active_day
        < policy.min_avg_filled_notional_per_active_day
    ):
        penalties += (
            policy.min_avg_filled_notional_per_active_day
            - avg_filled_notional_per_active_day
        ) / Decimal("1000")
    if max_gross_exposure_pct_equity > policy.max_gross_exposure_pct_equity:
        penalties += (
            max_gross_exposure_pct_equity - policy.max_gross_exposure_pct_equity
        ) * Decimal("1000")
    if min_cash < policy.min_cash:
        penalties += policy.min_cash - min_cash
    implementation_uncertainty_lower_bound = Decimal(
        str(
            replay_stress_metrics.get(
                "implementation_uncertainty_lower_net_pnl_per_day"
            )
            or "0"
        )
    )
    if not bool(
        replay_stress_metrics.get("implementation_uncertainty_stability_passed")
    ):
        penalties += max(
            Decimal("0"),
            policy.target_net_per_day - implementation_uncertainty_lower_bound,
        )
    if not bool(conformal_tail_risk_metrics["conformal_tail_risk_passed"]):
        penalties += max(
            Decimal("0"),
            policy.target_net_per_day
            - Decimal(
                str(
                    conformal_tail_risk_metrics[
                        "conformal_tail_risk_adjusted_net_pnl_per_day"
                    ]
                )
            ),
        )
    if not bool(
        breakeven_cost_buffer_metrics["breakeven_transaction_cost_buffer_passed"]
    ):
        penalties += max(
            Decimal("0"),
            policy.target_net_per_day
            - Decimal(
                str(
                    breakeven_cost_buffer_metrics[
                        "post_cost_net_pnl_after_breakeven_transaction_cost_buffer"
                    ]
                )
            ),
        )

    return (
        penalties,
        {
            "start_date": summary.start_date,
            "end_date": summary.end_date,
            "trading_day_count": summary.trading_day_count,
            "min_window_weekday_count_required": policy.min_window_weekday_count,
            "net_pnl": str(summary.net_pnl),
            "net_per_day": str(summary.net_per_day),
            "min_daily_net_pnl": str(min_daily_net_pnl),
            "min_daily_net_pnl_required": str(policy.min_daily_net_pnl),
            "daily_net_below_min_count": daily_net_below_min_count,
            "active_days": summary.active_days,
            "active_ratio": str(active_ratio),
            "positive_days": positive_days,
            "worst_day_net": str(summary.worst_day_net),
            "negative_days": negative_days,
            "max_drawdown": str(drawdown),
            "total_filled_notional": str(total_filled_notional),
            "avg_filled_notional_per_day": str(avg_filled_notional_per_day),
            "avg_filled_notional_per_active_day": str(
                avg_filled_notional_per_active_day
            ),
            "market_impact_liquidity_evidence_present": bool(daily_liquidity_notional),
            "market_impact_liquidity_day_count": len(daily_liquidity_notional),
            "market_impact_liquidity_missing_day_count": max(
                0,
                summary.trading_day_count - len(daily_liquidity_notional),
            ),
            "total_liquidity_notional": str(total_liquidity_notional),
            "avg_liquidity_notional_per_day": str(avg_liquidity_notional_per_day),
            **replay_stress_metrics,
            **conformal_tail_risk_metrics,
            **breakeven_cost_buffer_metrics,
            "best_day_share_of_total_pnl": str(best_day_share_of_total_pnl),
            "max_gross_exposure_pct_equity": str(max_gross_exposure_pct_equity),
            "max_gross_exposure_pct_equity_required": str(
                policy.max_gross_exposure_pct_equity
            ),
            "min_cash": str(min_cash),
            "min_cash_required": str(policy.min_cash),
            "negative_cash_observation_count": negative_cash_observation_count,
            "daily_net": {day: str(value) for day, value in summary.daily_net.items()},
            "daily_filled_notional": {
                day: str(value) for day, value in daily_filled_notional.items()
            },
            "daily_liquidity_notional": {
                day: str(value) for day, value in daily_liquidity_notional.items()
            },
            "daily_max_gross_exposure_pct_equity": {
                day: str(value)
                for day, value in daily_gross_exposure_pct_equity.items()
            },
            "daily_min_cash": {
                day: str(value) for day, value in daily_min_cash.items()
            },
            "daily_negative_cash_observation_count": daily_negative_cash_observations,
            **_order_type_execution_metrics(full_window_payload),
            **order_lifecycle_metrics,
        },
    )


def _second_oos_summary(
    *,
    second_oos_payload: Mapping[str, Any],
    policy: FullWindowConsistencyPolicy,
) -> tuple[Decimal, dict[str, Any]]:
    summary = summarize_replay_profitability(second_oos_payload)
    daily_filled_notional = _daily_filled_notional(second_oos_payload)
    daily_liquidity_notional = _daily_liquidity_notional(second_oos_payload)
    active_ratio = (
        Decimal(summary.active_days) / Decimal(summary.trading_day_count)
        if summary.trading_day_count > 0
        else Decimal("0")
    )
    positive_days = sum(1 for value in summary.daily_net.values() if value > 0)
    positive_ratio = (
        Decimal(positive_days) / Decimal(summary.trading_day_count)
        if summary.trading_day_count > 0
        else Decimal("0")
    )
    drawdown = _max_drawdown_from_daily_net(summary.daily_net)
    total_filled_notional = sum(daily_filled_notional.values(), Decimal("0"))
    total_liquidity_notional = sum(
        daily_liquidity_notional.values(),
        Decimal("0"),
    )
    avg_filled_notional_per_day = (
        total_filled_notional / Decimal(summary.trading_day_count)
        if summary.trading_day_count > 0
        else Decimal("0")
    )
    avg_liquidity_notional_per_day = (
        total_liquidity_notional / Decimal(summary.trading_day_count)
        if summary.trading_day_count > 0
        else Decimal("0")
    )
    reasons: list[str] = []
    penalty = Decimal("0")
    if summary.trading_day_count <= 0:
        reasons.append(f"{_SECOND_OOS_WINDOW_ID}_trading_days_missing")
    if summary.decision_count <= 0:
        reasons.append(f"{_SECOND_OOS_WINDOW_ID}_no_decisions")
    if summary.filled_count <= 0:
        reasons.append(f"{_SECOND_OOS_WINDOW_ID}_no_fills")
    if summary.net_per_day < policy.target_net_per_day:
        reasons.append(f"{_SECOND_OOS_WINDOW_ID}_net_per_day_below_target")
        penalty += policy.target_net_per_day - summary.net_per_day
    if active_ratio < policy.min_active_ratio:
        reasons.append(f"{_SECOND_OOS_WINDOW_ID}_active_ratio_below_min")
        penalty += (policy.min_active_ratio - active_ratio) * Decimal("2000")
    if drawdown > policy.max_drawdown:
        reasons.append(f"{_SECOND_OOS_WINDOW_ID}_max_drawdown_above_max")
        penalty += drawdown - policy.max_drawdown
    if summary.worst_day_net < -policy.max_worst_day_loss:
        reasons.append(f"{_SECOND_OOS_WINDOW_ID}_worst_day_loss_above_max")
        penalty += abs(summary.worst_day_net + policy.max_worst_day_loss)
    if avg_filled_notional_per_day < policy.min_avg_filled_notional_per_day:
        reasons.append(f"{_SECOND_OOS_WINDOW_ID}_filled_notional_below_min")
        penalty += (
            policy.min_avg_filled_notional_per_day - avg_filled_notional_per_day
        ) / Decimal("1000")

    return (
        penalty,
        {
            "schema_version": "torghut.frontier-second-oos-window.v1",
            "window_id": _SECOND_OOS_WINDOW_ID,
            "start_date": summary.start_date,
            "end_date": summary.end_date,
            "trading_day_count": summary.trading_day_count,
            "net_pnl": str(summary.net_pnl),
            "net_per_day": str(summary.net_per_day),
            "target_net_per_day": str(policy.target_net_per_day),
            "active_days": summary.active_days,
            "active_ratio": str(active_ratio),
            "positive_days": positive_days,
            "positive_ratio": str(positive_ratio),
            "decision_count": summary.decision_count,
            "filled_count": summary.filled_count,
            "worst_day_net": str(summary.worst_day_net),
            "max_drawdown": str(drawdown),
            "total_filled_notional": str(total_filled_notional),
            "avg_filled_notional_per_day": str(avg_filled_notional_per_day),
            "market_impact_liquidity_evidence_present": bool(daily_liquidity_notional),
            "market_impact_liquidity_day_count": len(daily_liquidity_notional),
            "market_impact_liquidity_missing_day_count": max(
                0,
                summary.trading_day_count - len(daily_liquidity_notional),
            ),
            "total_liquidity_notional": str(total_liquidity_notional),
            "avg_liquidity_notional_per_day": str(avg_liquidity_notional_per_day),
            "daily_net": {day: str(value) for day, value in summary.daily_net.items()},
            "daily_filled_notional": {
                day: str(value) for day, value in daily_filled_notional.items()
            },
            "daily_liquidity_notional": {
                day: str(value) for day, value in daily_liquidity_notional.items()
            },
            "passed": not reasons,
            "reasons": reasons,
        },
    )


def _holdout_oos_passed(
    *,
    holdout_payload: Mapping[str, Any],
    policy: ProfitabilityConstraintPolicy,
) -> bool:
    summary = summarize_replay_profitability(holdout_payload)
    if policy.require_holdout_decisions and summary.decision_count <= 0:
        return False
    if summary.active_days < policy.min_active_holdout_days:
        return False
    if summary.net_per_day < policy.holdout_target_net_per_day:
        return False
    if summary.worst_day_net < -policy.max_worst_holdout_day_loss:
        return False
    if (
        summary.profit_factor is None
        or summary.profit_factor < policy.min_profit_factor
    ):
        return False
    return True


__all__ = [
    "DELAY_ADJUSTED_DEPTH_STRESS_GRID_MS",
    "CONFORMAL_TAIL_RISK_ALPHA",
    "BREAKEVEN_TRANSACTION_COST_BUFFER_MIN_BPS",
    "MARKET_IMPACT_STRESS_SOURCE_MARKERS",
    "_p10",
    "_conformal_tail_loss_buffer",
    "_conformal_tail_risk_metrics",
    "_breakeven_transaction_cost_buffer_metrics",
    "_delay_depth_fillability",
    "_implementation_uncertainty_metrics",
    "_replay_stress_metrics",
    "_decimal_payload_metric",
    "_max_best_day_share_of_total_pnl",
    "_consistency_penalty",
    "_second_oos_summary",
    "_holdout_oos_passed",
]
