"""Delay-adjusted depth stress helpers for runtime closure."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Mapping

from app.trading.costs import BPS_SCALE, CostModelConfig, participation_power
from app.trading.discovery.autoresearch import StrategyAutoresearchProgram

from .context import (
    EXECUTION_REALISM_PASS_STATUSES,
    MAX_ADVERSE_SELECTION_ERROR_BPS,
    MAX_SIMULATION_LIVE_FILL_ERROR_BPS,
    MIN_SIMULATION_PARITY_SAMPLE_COUNT,
    to_decimal,
    decimal_to_string,
    execution_realism_missing_evidence,
    to_int,
    to_mapping,
    optional_decimal_to_string,
    p10,
    runtime_family,
    runtime_strategy_name,
    to_string,
)
from .candidate_payloads import portfolio_runtime_strategy_names
from .market_impact import (
    daily_decimal_map,
    max_participation_rate,
    per_trading_day,
    weighted_bps,
)


@dataclass(frozen=True)
class ExecutionRealismEvidence:
    lob_event_stream_event_count: int
    fill_outcome_count: int
    live_paper_parity_sample_count: int
    live_paper_parity_status: str
    live_paper_parity_max_fill_error_bps_raw: Any
    live_paper_parity_max_fill_error_bps: Decimal
    live_paper_parity_max_adverse_selection_error_bps_raw: Any
    live_paper_parity_max_adverse_selection_error_bps: Decimal
    simulation_live_parity_status: str
    implementation_trace_ref: str
    lob_event_stream_artifact_ref: str
    fill_outcomes_artifact_ref: str
    simulation_live_parity_artifact_ref: str
    missing_evidence: tuple[str, ...]

    @property
    def parity_status_ok(self) -> bool:
        return self.live_paper_parity_status in EXECUTION_REALISM_PASS_STATUSES

    @property
    def lob_event_stream_evidence_present(self) -> bool:
        return self.lob_event_stream_event_count > 0

    @property
    def fill_outcome_evidence_present(self) -> bool:
        return self.fill_outcome_count > 0

    @property
    def live_paper_parity_evidence_present(self) -> bool:
        return (
            self.live_paper_parity_sample_count >= MIN_SIMULATION_PARITY_SAMPLE_COUNT
            and self.parity_status_ok
            and to_string(self.live_paper_parity_max_fill_error_bps_raw) != ""
            and to_string(self.live_paper_parity_max_adverse_selection_error_bps_raw)
            != ""
            and self.live_paper_parity_max_fill_error_bps
            <= MAX_SIMULATION_LIVE_FILL_ERROR_BPS
            and self.live_paper_parity_max_adverse_selection_error_bps
            <= MAX_ADVERSE_SELECTION_ERROR_BPS
        )


@dataclass(frozen=True)
class DelayDepthSource:
    report: Mapping[str, Any]
    summary: Mapping[str, Any]
    scorecard: Mapping[str, Any]
    daily_net: Mapping[str, Decimal]
    daily_notional: Mapping[str, Decimal]
    daily_liquidity: Mapping[str, Decimal]
    daily_lob_event_stream_count: Mapping[str, Any]
    daily_fill_outcome_count: Mapping[str, Any]
    trading_days: int
    total_filled_notional: Decimal
    avg_filled_notional: Decimal
    stress_delay_ms: Decimal
    latency_grid_ms: tuple[Decimal, ...]
    depth_haircut_rate: Decimal
    max_participation: Decimal


@dataclass(frozen=True)
class DelayDepthDayResult:
    row: Mapping[str, Any]
    delay_depth_cost: Decimal
    fillable_notional: Decimal
    unfillable_notional: Decimal
    post_delay_depth_net_pnl: Decimal
    delay_depth_bps_notional: Decimal
    recorded_liquidity_day: bool
    missing_liquidity_day: bool
    active_day_fillable_notional: Decimal | None


@dataclass(frozen=True)
class DelayDepthRollup:
    rows: list[Mapping[str, Any]]
    total_delay_depth_cost: Decimal
    total_fillable_notional: Decimal
    total_unfillable_notional: Decimal
    total_post_delay_depth_net_pnl: Decimal
    weighted_delay_depth_bps_notional: Decimal
    recorded_liquidity_days: int
    missing_liquidity_days: int
    active_day_fillable_notional: tuple[Decimal, ...]


def delay_adjusted_depth_stress_report(
    *,
    runner_run_id: str,
    best_candidate: Mapping[str, Any],
    approval_report: Mapping[str, Any],
    program: StrategyAutoresearchProgram,
    cost_model_config: CostModelConfig | None = None,
) -> dict[str, Any]:
    config = cost_model_config or CostModelConfig()
    source = delay_depth_source(approval_report=approval_report, config=config)
    evidence = execution_realism_evidence(source.summary)
    rollup = delay_depth_rollup(source=source, config=config)
    metrics = delay_depth_metrics(source=source, rollup=rollup, program=program)
    reasons = delay_depth_reasons(
        source=source,
        evidence=evidence,
        rollup=rollup,
        metrics=metrics,
        program=program,
    )
    objective_met = not reasons
    generated_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    candidate_id = to_string(best_candidate.get("candidate_id"))
    return {
        "schema_version": "torghut.delay-adjusted-depth-stress-report.v1",
        "run_id": runner_run_id,
        "candidate_id": candidate_id,
        "report_id": f"{runner_run_id}:{candidate_id}:delay-adjusted-depth-stress",
        "generated_at": generated_at,
        "checked_at": generated_at,
        "runtime_family": runtime_family(best_candidate),
        "runtime_strategy_name": runtime_strategy_name(best_candidate),
        "runtime_strategy_names": list(
            portfolio_runtime_strategy_names(best_candidate)
        ),
        "model": "latency_depth_haircut",
        "source_markers": [
            "lob_simulation_reality_gap_arxiv_2603_24137_2026",
            "market_depth_execution_delays_ssrn_6440898_2026",
            "latency_execution_policy_arxiv_2504_00846_2025",
            "rl_market_limit_execution_arxiv_2507_06345_2026",
        ],
        "objective_met": objective_met,
        "passed": objective_met,
        "reasons": reasons,
        "case_count": len(rollup.rows),
        "stress_case_count": len(rollup.rows),
        "target_net_pnl_per_day": decimal_to_string(
            program.objective.target_net_pnl_per_day
        ),
        "net_pnl_per_day": decimal_to_string(
            to_decimal(source.scorecard.get("net_pnl_per_day"))
        ),
        "post_delay_depth_net_pnl_per_day": decimal_to_string(
            metrics.post_delay_depth_net_pnl_per_day
        ),
        "stressed_net_pnl_per_day": decimal_to_string(
            metrics.post_delay_depth_net_pnl_per_day
        ),
        "net_pnl": decimal_to_string(metrics.net_pnl),
        "post_delay_depth_net_pnl": decimal_to_string(metrics.post_delay_depth_net_pnl),
        "delay_depth_cost": decimal_to_string(rollup.total_delay_depth_cost),
        "delay_depth_cost_bps": decimal_to_string(metrics.delay_depth_cost_bps),
        "stress_delay_ms": decimal_to_string(source.stress_delay_ms),
        "latency_grid_ms": [
            decimal_to_string(stress_ms) for stress_ms in source.latency_grid_ms
        ],
        "delay_adjusted_depth_latency_grid_ms": [
            decimal_to_string(stress_ms) for stress_ms in source.latency_grid_ms
        ],
        "delay_adjusted_depth_grid_max_stress_ms": decimal_to_string(
            max(source.latency_grid_ms)
        ),
        "depth_haircut_rate": decimal_to_string(source.depth_haircut_rate),
        "liquidity_input_source": "recorded_liquidity_notional"
        if rollup.recorded_liquidity_days
        else "missing_recorded_liquidity",
        "execution_realism_status": "complete"
        if not evidence.missing_evidence
        else "missing_required_evidence",
        "execution_realism_missing_evidence": list(evidence.missing_evidence),
        "lob_execution_realism_evidence_present": not evidence.missing_evidence,
        "lob_event_stream_evidence_present": evidence.lob_event_stream_evidence_present,
        "lob_event_stream_artifact_ref": evidence.lob_event_stream_artifact_ref,
        "lob_event_stream_event_count": evidence.lob_event_stream_event_count,
        "lob_event_stream_sample_count": evidence.lob_event_stream_event_count,
        "fill_outcome_evidence_present": evidence.fill_outcome_evidence_present,
        "fill_outcomes_artifact_ref": evidence.fill_outcomes_artifact_ref,
        "fill_outcome_count": evidence.fill_outcome_count,
        "fill_outcome_sample_count": evidence.fill_outcome_count,
        "live_paper_parity_evidence_present": evidence.live_paper_parity_evidence_present,
        "live_paper_parity_status": evidence.live_paper_parity_status,
        "live_paper_parity_sample_count": evidence.live_paper_parity_sample_count,
        "live_paper_parity_max_fill_error_bps": optional_decimal_to_string(
            evidence.live_paper_parity_max_fill_error_bps_raw
        ),
        "live_paper_parity_max_adverse_selection_error_bps": optional_decimal_to_string(
            evidence.live_paper_parity_max_adverse_selection_error_bps_raw
        ),
        "simulation_live_parity_sample_count": evidence.live_paper_parity_sample_count,
        "simulation_live_parity_status": evidence.simulation_live_parity_status,
        "simulation_live_parity_artifact_ref": evidence.simulation_live_parity_artifact_ref,
        "implementation_trace_ref": evidence.implementation_trace_ref,
        "recorded_liquidity_day_count": rollup.recorded_liquidity_days,
        "missing_liquidity_days": rollup.missing_liquidity_days,
        "max_participation_rate": decimal_to_string(source.max_participation),
        "impact_participation_exponent": decimal_to_string(
            config.impact_participation_exponent
        ),
        "trading_day_count": source.trading_days,
        "total_filled_notional": decimal_to_string(source.total_filled_notional),
        "avg_filled_notional_per_day": decimal_to_string(source.avg_filled_notional),
        "unfillable_notional": decimal_to_string(rollup.total_unfillable_notional),
        "fillable_notional_per_day": decimal_to_string(
            metrics.fillable_notional_per_day
        ),
        "worst_active_day_fillable_notional": decimal_to_string(
            metrics.worst_active_day_fillable_notional
        ),
        "delay_adjusted_depth_worst_active_day_fillable_notional": decimal_to_string(
            metrics.worst_active_day_fillable_notional
        ),
        "p10_active_day_fillable_notional": decimal_to_string(
            metrics.p10_active_day_fillable_notional
        ),
        "delay_adjusted_depth_p10_active_day_fillable_notional": decimal_to_string(
            metrics.p10_active_day_fillable_notional
        ),
        "tail_coverage_passed": metrics.tail_coverage_passed,
        "delay_adjusted_depth_tail_coverage_passed": metrics.tail_coverage_passed,
        "daily": rollup.rows,
    }


@dataclass(frozen=True)
class DelayDepthMetrics:
    delay_depth_cost_bps: Decimal
    fillable_notional_per_day: Decimal
    net_pnl: Decimal
    post_delay_depth_net_pnl: Decimal
    post_delay_depth_net_pnl_per_day: Decimal
    worst_active_day_fillable_notional: Decimal
    p10_active_day_fillable_notional: Decimal
    tail_coverage_passed: bool


def delay_depth_source(
    *,
    approval_report: Mapping[str, Any],
    config: CostModelConfig,
) -> DelayDepthSource:
    report = to_mapping(approval_report)
    summary = to_mapping(report.get("summary"))
    daily_net = daily_decimal_map(summary, "daily_net")
    daily_notional = daily_decimal_map(summary, "daily_filled_notional")
    trading_days = max(to_int(summary.get("trading_day_count")), len(daily_net))
    total_filled_notional = sum(daily_notional.values(), Decimal("0"))
    stress_delay_ms = Decimal("250")
    latency_grid_ms = (Decimal("50"), Decimal("150"), Decimal("250"))
    return DelayDepthSource(
        report=report,
        summary=summary,
        scorecard=to_mapping(report.get("scorecard")),
        daily_net=daily_net,
        daily_notional=daily_notional,
        daily_liquidity=daily_decimal_map(summary, "daily_liquidity_notional"),
        daily_lob_event_stream_count=to_mapping(
            summary.get("daily_lob_event_stream_count")
        ),
        daily_fill_outcome_count=to_mapping(summary.get("daily_fill_outcome_count")),
        trading_days=trading_days,
        total_filled_notional=total_filled_notional,
        avg_filled_notional=per_trading_day(
            value=total_filled_notional,
            trading_days=trading_days,
        ),
        stress_delay_ms=stress_delay_ms,
        latency_grid_ms=latency_grid_ms,
        depth_haircut_rate=min(
            Decimal("0.50"),
            max(Decimal("0.10"), stress_delay_ms / Decimal("1000")),
        ),
        max_participation=max_participation_rate(config),
    )


def execution_realism_evidence(
    summary: Mapping[str, Any],
) -> ExecutionRealismEvidence:
    fill_error_raw = summary.get("live_paper_parity_max_fill_error_bps") or summary.get(
        "simulation_live_fill_error_bps"
    )
    adverse_selection_raw = summary.get(
        "live_paper_parity_max_adverse_selection_error_bps"
    ) or summary.get("adverse_selection_error_bps")
    evidence_summary = execution_realism_evidence_summary(
        summary=summary,
        fill_error_raw=fill_error_raw,
        adverse_selection_raw=adverse_selection_raw,
    )
    return ExecutionRealismEvidence(
        lob_event_stream_event_count=max(
            to_int(summary.get("lob_event_stream_event_count")),
            to_int(summary.get("lob_event_stream_sample_count")),
        ),
        fill_outcome_count=max(
            to_int(summary.get("fill_outcome_count")),
            to_int(summary.get("fill_outcome_sample_count")),
        ),
        live_paper_parity_sample_count=max(
            to_int(summary.get("live_paper_parity_sample_count")),
            to_int(summary.get("simulation_live_parity_sample_count")),
        ),
        live_paper_parity_status=to_string(
            summary.get("live_paper_parity_status")
            or summary.get("simulation_live_parity_status")
        ),
        live_paper_parity_max_fill_error_bps_raw=fill_error_raw,
        live_paper_parity_max_fill_error_bps=to_decimal(fill_error_raw),
        live_paper_parity_max_adverse_selection_error_bps_raw=adverse_selection_raw,
        live_paper_parity_max_adverse_selection_error_bps=to_decimal(
            adverse_selection_raw
        ),
        simulation_live_parity_status=to_string(
            summary.get("simulation_live_parity_status")
        ),
        implementation_trace_ref=to_string(
            summary.get("implementation_trace_ref")
            or summary.get("runtime_implementation_artifact_ref")
        ),
        lob_event_stream_artifact_ref=to_string(
            summary.get("lob_event_stream_artifact_ref")
        ),
        fill_outcomes_artifact_ref=to_string(summary.get("fill_outcomes_artifact_ref")),
        simulation_live_parity_artifact_ref=to_string(
            summary.get("simulation_live_parity_artifact_ref")
        ),
        missing_evidence=execution_realism_missing_evidence(evidence_summary),
    )


def execution_realism_evidence_summary(
    *,
    summary: Mapping[str, Any],
    fill_error_raw: Any,
    adverse_selection_raw: Any,
) -> dict[str, Any]:
    return {
        "lob_event_stream_event_count": max(
            to_int(summary.get("lob_event_stream_event_count")),
            to_int(summary.get("lob_event_stream_sample_count")),
        ),
        "lob_event_stream_artifact_ref": to_string(
            summary.get("lob_event_stream_artifact_ref")
        ),
        "fill_outcome_count": max(
            to_int(summary.get("fill_outcome_count")),
            to_int(summary.get("fill_outcome_sample_count")),
        ),
        "fill_outcomes_artifact_ref": to_string(
            summary.get("fill_outcomes_artifact_ref")
        ),
        "live_paper_parity_status": to_string(
            summary.get("live_paper_parity_status")
            or summary.get("simulation_live_parity_status")
        ),
        "live_paper_parity_sample_count": max(
            to_int(summary.get("live_paper_parity_sample_count")),
            to_int(summary.get("simulation_live_parity_sample_count")),
        ),
        "live_paper_parity_max_fill_error_bps": optional_decimal_to_string(
            fill_error_raw
        ),
        "live_paper_parity_max_adverse_selection_error_bps": optional_decimal_to_string(
            adverse_selection_raw
        ),
        "simulation_live_parity_artifact_ref": to_string(
            summary.get("simulation_live_parity_artifact_ref")
        ),
        "implementation_trace_ref": to_string(
            summary.get("implementation_trace_ref")
            or summary.get("runtime_implementation_artifact_ref")
        ),
    }


def delay_depth_rollup(
    *,
    source: DelayDepthSource,
    config: CostModelConfig,
) -> DelayDepthRollup:
    day_results = [
        delay_depth_day_result(source=source, config=config, day=day)
        for day in sorted(source.daily_net)
    ]
    return DelayDepthRollup(
        rows=[item.row for item in day_results],
        total_delay_depth_cost=sum(
            (item.delay_depth_cost for item in day_results), Decimal("0")
        ),
        total_fillable_notional=sum(
            (item.fillable_notional for item in day_results), Decimal("0")
        ),
        total_unfillable_notional=sum(
            (item.unfillable_notional for item in day_results), Decimal("0")
        ),
        total_post_delay_depth_net_pnl=sum(
            (item.post_delay_depth_net_pnl for item in day_results),
            Decimal("0"),
        ),
        weighted_delay_depth_bps_notional=sum(
            (item.delay_depth_bps_notional for item in day_results),
            Decimal("0"),
        ),
        recorded_liquidity_days=sum(
            1 for item in day_results if item.recorded_liquidity_day
        ),
        missing_liquidity_days=sum(
            1 for item in day_results if item.missing_liquidity_day
        ),
        active_day_fillable_notional=tuple(
            item.active_day_fillable_notional
            for item in day_results
            if item.active_day_fillable_notional is not None
        ),
    )


def delay_depth_day_result(
    *,
    source: DelayDepthSource,
    config: CostModelConfig,
    day: str,
) -> DelayDepthDayResult:
    notional = source.daily_notional.get(day, Decimal("0"))
    liquidity_notional = source.daily_liquidity.get(day, Decimal("0"))
    participation = participation_rate(
        notional=notional, liquidity_notional=liquidity_notional
    )
    day_fillable_notional = fillable_notional(
        notional=notional,
        liquidity_notional=liquidity_notional,
        depth_haircut_rate=source.depth_haircut_rate,
    )
    unfillable_notional = max(Decimal("0"), notional - day_fillable_notional)
    fillable_ratio = day_fillable_notional / notional if notional > 0 else Decimal("1")
    day_delay_depth_cost_bps = delay_depth_cost_bps(
        participation=participation,
        depth_haircut_rate=source.depth_haircut_rate,
        config=config,
    )
    delay_depth_cost = (day_fillable_notional * day_delay_depth_cost_bps) / BPS_SCALE
    post_delay_depth_net = (source.daily_net[day] * fillable_ratio) - delay_depth_cost
    return DelayDepthDayResult(
        row={
            "day": day,
            "net_pnl": decimal_to_string(source.daily_net[day]),
            "filled_notional": decimal_to_string(notional),
            "liquidity_notional": decimal_to_string(liquidity_notional),
            "lob_event_stream_count": to_int(
                source.daily_lob_event_stream_count.get(day)
            ),
            "fill_outcome_count": to_int(source.daily_fill_outcome_count.get(day)),
            "stress_delay_ms": decimal_to_string(source.stress_delay_ms),
            "depth_haircut_rate": decimal_to_string(source.depth_haircut_rate),
            "latency_grid_fillable_notional": latency_grid_fillable_notional(
                source=source,
                notional=notional,
                liquidity_notional=liquidity_notional,
            ),
            "fillable_notional": decimal_to_string(day_fillable_notional),
            "unfillable_notional": decimal_to_string(unfillable_notional),
            "fillable_ratio": decimal_to_string(fillable_ratio),
            "participation_rate_proxy": decimal_to_string(participation),
            "delay_depth_cost_bps": decimal_to_string(day_delay_depth_cost_bps),
            "delay_depth_cost": decimal_to_string(delay_depth_cost),
            "post_delay_depth_net_pnl": decimal_to_string(post_delay_depth_net),
        },
        delay_depth_cost=delay_depth_cost,
        fillable_notional=day_fillable_notional,
        unfillable_notional=unfillable_notional,
        post_delay_depth_net_pnl=post_delay_depth_net,
        delay_depth_bps_notional=day_delay_depth_cost_bps * notional,
        recorded_liquidity_day=liquidity_notional > 0,
        missing_liquidity_day=liquidity_notional <= 0 and notional > 0,
        active_day_fillable_notional=day_fillable_notional if notional > 0 else None,
    )


def participation_rate(*, notional: Decimal, liquidity_notional: Decimal) -> Decimal:
    if liquidity_notional <= 0 or notional <= 0:
        return Decimal("0")
    return min(Decimal("1"), notional / liquidity_notional)


def fillable_notional(
    *,
    notional: Decimal,
    liquidity_notional: Decimal,
    depth_haircut_rate: Decimal,
) -> Decimal:
    if liquidity_notional <= 0 or notional <= 0:
        return Decimal("0")
    return min(notional, liquidity_notional * (Decimal("1") - depth_haircut_rate))


def delay_depth_cost_bps(
    *,
    participation: Decimal,
    depth_haircut_rate: Decimal,
    config: CostModelConfig,
) -> Decimal:
    return max(
        Decimal("1"),
        config.impact_bps_at_full_participation
        * participation_power(participation, config.impact_participation_exponent)
        * depth_haircut_rate,
    )


def latency_grid_fillable_notional(
    *,
    source: DelayDepthSource,
    notional: Decimal,
    liquidity_notional: Decimal,
) -> dict[str, str]:
    return {
        decimal_to_string(grid_ms): decimal_to_string(
            fillable_notional(
                notional=notional,
                liquidity_notional=liquidity_notional,
                depth_haircut_rate=min(
                    Decimal("0.50"),
                    max(Decimal("0.10"), grid_ms / Decimal("1000")),
                ),
            )
        )
        for grid_ms in source.latency_grid_ms
    }


def delay_depth_metrics(
    *,
    source: DelayDepthSource,
    rollup: DelayDepthRollup,
    program: StrategyAutoresearchProgram,
) -> DelayDepthMetrics:
    worst_fillable = min(rollup.active_day_fillable_notional, default=Decimal("0"))
    p10_fillable = p10(rollup.active_day_fillable_notional)
    return DelayDepthMetrics(
        delay_depth_cost_bps=weighted_bps(
            weighted_bps_notional=rollup.weighted_delay_depth_bps_notional,
            total_filled_notional=source.total_filled_notional,
        ),
        fillable_notional_per_day=per_trading_day(
            value=rollup.total_fillable_notional,
            trading_days=source.trading_days,
        ),
        net_pnl=to_decimal(source.summary.get("net_pnl")),
        post_delay_depth_net_pnl=rollup.total_post_delay_depth_net_pnl,
        post_delay_depth_net_pnl_per_day=per_trading_day(
            value=rollup.total_post_delay_depth_net_pnl,
            trading_days=source.trading_days,
        ),
        worst_active_day_fillable_notional=worst_fillable,
        p10_active_day_fillable_notional=p10_fillable,
        tail_coverage_passed=tail_coverage_passed(
            rollup=rollup,
            worst_fillable=worst_fillable,
            p10_fillable=p10_fillable,
            program=program,
        ),
    )


def tail_coverage_passed(
    *,
    rollup: DelayDepthRollup,
    worst_fillable: Decimal,
    p10_fillable: Decimal,
    program: StrategyAutoresearchProgram,
) -> bool:
    return (
        bool(rollup.active_day_fillable_notional)
        and rollup.missing_liquidity_days == 0
        and worst_fillable >= program.objective.min_daily_notional
        and p10_fillable >= program.objective.min_daily_notional
    )


def delay_depth_reasons(
    *,
    source: DelayDepthSource,
    evidence: ExecutionRealismEvidence,
    rollup: DelayDepthRollup,
    metrics: DelayDepthMetrics,
    program: StrategyAutoresearchProgram,
) -> list[str]:
    return [
        *delay_depth_data_reasons(source=source, rollup=rollup),
        *delay_depth_evidence_reasons(evidence),
        *delay_depth_metric_reasons(source=source, metrics=metrics, program=program),
    ]


def delay_depth_data_reasons(
    *,
    source: DelayDepthSource,
    rollup: DelayDepthRollup,
) -> list[str]:
    reasons: list[str] = []
    if source.trading_days <= 0:
        reasons.append("delay_adjusted_depth_stress_trading_days_missing")
    if source.total_filled_notional <= 0:
        reasons.append("delay_adjusted_depth_stress_filled_notional_missing")
    if rollup.missing_liquidity_days:
        reasons.append("delay_adjusted_depth_stress_liquidity_evidence_missing")
    if not bool(source.report.get("objective_met")):
        reasons.append("approval_replay_objective_not_met")
    return reasons


def delay_depth_evidence_reasons(evidence: ExecutionRealismEvidence) -> list[str]:
    reasons: list[str] = []
    if not evidence.lob_event_stream_evidence_present:
        reasons.append("delay_adjusted_depth_lob_event_stream_evidence_missing")
    if not evidence.fill_outcome_evidence_present:
        reasons.append("delay_adjusted_depth_fill_outcome_evidence_missing")
    reasons.extend(delay_depth_parity_reasons(evidence))
    if evidence.lob_event_stream_artifact_ref == "":
        reasons.append("delay_adjusted_depth_lob_event_stream_artifact_ref_missing")
    if evidence.fill_outcomes_artifact_ref == "":
        reasons.append("delay_adjusted_depth_fill_outcomes_artifact_ref_missing")
    if evidence.simulation_live_parity_artifact_ref == "":
        reasons.append(
            "delay_adjusted_depth_simulation_live_parity_artifact_ref_missing"
        )
    if evidence.implementation_trace_ref == "":
        reasons.append("implementation_trace_evidence_missing")
    if evidence.missing_evidence:
        reasons.append("lob_execution_realism_evidence_missing")
    return reasons


def delay_depth_parity_reasons(evidence: ExecutionRealismEvidence) -> list[str]:
    reasons: list[str] = []
    if evidence.live_paper_parity_sample_count <= 0:
        reasons.append("delay_adjusted_depth_live_paper_parity_evidence_missing")
    if not evidence.parity_status_ok:
        reasons.append(
            "delay_adjusted_depth_live_paper_parity_status_not_within_budget"
        )
    if evidence.live_paper_parity_sample_count < MIN_SIMULATION_PARITY_SAMPLE_COUNT:
        reasons.append(
            "delay_adjusted_depth_live_paper_parity_sample_count_below_minimum"
        )
    if to_string(evidence.live_paper_parity_max_fill_error_bps_raw) == "":
        reasons.append(
            "delay_adjusted_depth_live_paper_parity_fill_error_evidence_missing"
        )
    elif (
        evidence.live_paper_parity_max_fill_error_bps
        > MAX_SIMULATION_LIVE_FILL_ERROR_BPS
    ):
        reasons.append(
            "delay_adjusted_depth_live_paper_parity_fill_error_above_maximum"
        )
    if to_string(evidence.live_paper_parity_max_adverse_selection_error_bps_raw) == "":
        reasons.append(
            "delay_adjusted_depth_live_paper_parity_adverse_selection_error_evidence_missing"
        )
    elif (
        evidence.live_paper_parity_max_adverse_selection_error_bps
        > MAX_ADVERSE_SELECTION_ERROR_BPS
    ):
        reasons.append(
            "delay_adjusted_depth_live_paper_parity_adverse_selection_error_above_maximum"
        )
    return reasons


def delay_depth_metric_reasons(
    *,
    source: DelayDepthSource,
    metrics: DelayDepthMetrics,
    program: StrategyAutoresearchProgram,
) -> list[str]:
    reasons: list[str] = []
    if metrics.delay_depth_cost_bps <= 0:
        reasons.append("delay_adjusted_depth_stress_cost_bps_zero")
    if metrics.fillable_notional_per_day < program.objective.min_daily_notional:
        reasons.append("delay_adjusted_depth_fillable_notional_below_minimum")
    if not metrics.tail_coverage_passed:
        reasons.append("delay_adjusted_depth_tail_fillable_notional_below_minimum")
    if (
        metrics.post_delay_depth_net_pnl_per_day
        < program.objective.target_net_pnl_per_day
    ):
        reasons.append("delay_adjusted_depth_stress_net_pnl_below_target")
    if not bool(source.report.get("objective_met")):
        reasons.append("approval_replay_objective_not_met")
    return reasons
