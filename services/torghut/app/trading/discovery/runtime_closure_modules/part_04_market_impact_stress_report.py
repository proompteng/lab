# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Runtime-closure bundle helpers for MLX autoresearch outputs."""

from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence, cast

import yaml

from app.trading.autonomy.policy_checks import (
    evaluate_promotion_prerequisites,
    evaluate_rollback_readiness,
)
from app.trading.discovery.autoresearch import (
    StrategyAutoresearchProgram,
    candidate_meets_objective,
)
from app.trading.discovery.decomposition import (
    build_replay_decomposition,
    max_family_contribution_share,
    max_symbol_concentration_share,
    regime_slice_pass_rate,
)
from app.trading.discovery.mlx_snapshot import MlxSnapshotManifest
from app.trading.discovery.objectives import (
    ObjectiveVetoPolicy,
    build_scorecard,
    evaluate_vetoes,
)
from app.trading.discovery.portfolio_candidates import PortfolioCandidateSpec
from app.trading.evidence_receipts import build_portfolio_proof_receipt
from app.trading.costs import BPS_SCALE, CostModelConfig, participation_power
from app.trading.hypotheses import (
    hypothesis_registry_requires_dependency_capability,
    load_hypothesis_registry,
)
from app.trading.reporting import summarize_replay_profitability
import scripts.local_intraday_tsmom_replay as replay_mod
from scripts.search_consistent_profitability_frontier import (
    apply_candidate_to_configmap_with_overrides,
)

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_discover_runtime_root import *
from .part_02_portfolio_candidate_runtime_payload import *
from .part_03_replay_analysis import *


def _market_impact_stress_report(
    *,
    runner_run_id: str,
    best_candidate: Mapping[str, Any],
    approval_report: Mapping[str, Any],
    program: StrategyAutoresearchProgram,
    cost_model_config: CostModelConfig | None = None,
) -> dict[str, Any]:
    config = cost_model_config or CostModelConfig()
    report = _mapping(approval_report)
    summary = _mapping(report.get("summary"))
    scorecard = _mapping(report.get("scorecard"))
    daily_net = {
        day: _decimal(value)
        for day, value in _mapping(summary.get("daily_net")).items()
    }
    daily_notional = {
        day: _decimal(value)
        for day, value in _mapping(summary.get("daily_filled_notional")).items()
    }
    daily_liquidity = {
        day: _decimal(value)
        for day, value in _mapping(summary.get("daily_liquidity_notional")).items()
    }
    trading_days = max(_int(summary.get("trading_day_count")), len(daily_net))
    total_filled_notional = sum(daily_notional.values(), Decimal("0"))
    avg_filled_notional = (
        total_filled_notional / Decimal(trading_days)
        if trading_days > 0
        else Decimal("0")
    )
    reference_notional = max(
        program.objective.min_daily_notional,
        avg_filled_notional,
        Decimal("1"),
    )
    max_participation = (
        config.max_participation_rate
        if config.max_participation_rate > 0
        else Decimal("0.1")
    )
    reference_adv = reference_notional / max_participation
    daily_rows: list[dict[str, Any]] = []
    total_impact_cost = Decimal("0")
    weighted_impact_bps_notional = Decimal("0")
    missing_liquidity_days: list[str] = []
    recorded_liquidity_days = 0
    for day in sorted(daily_net):
        notional = daily_notional.get(day, Decimal("0"))
        liquidity_notional = daily_liquidity.get(day, Decimal("0"))
        if notional > 0 and liquidity_notional > 0:
            recorded_liquidity_days += 1
            participation_denominator = liquidity_notional
            liquidity_evidence_source = "recorded_liquidity_notional"
        else:
            participation_denominator = reference_adv
            liquidity_evidence_source = "synthetic_proxy"
            if notional > 0:
                missing_liquidity_days.append(day)
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
        post_impact_net = daily_net[day] - impact_cost
        total_impact_cost += impact_cost
        weighted_impact_bps_notional += impact_bps * notional
        daily_rows.append(
            {
                "day": day,
                "net_pnl": _decimal_string(daily_net[day]),
                "filled_notional": _decimal_string(notional),
                "liquidity_notional": _decimal_string(liquidity_notional),
                "liquidity_evidence_source": liquidity_evidence_source,
                "participation_rate_proxy": _decimal_string(participation),
                "impact_cost_bps": _decimal_string(impact_bps),
                "impact_cost": _decimal_string(impact_cost),
                "post_impact_net_pnl": _decimal_string(post_impact_net),
            }
        )
    impact_cost_bps = (
        weighted_impact_bps_notional / total_filled_notional
        if total_filled_notional > 0
        else Decimal("0")
    )
    net_pnl = _decimal(summary.get("net_pnl"))
    post_impact_net_pnl = net_pnl - total_impact_cost
    post_impact_net_pnl_per_day = (
        post_impact_net_pnl / Decimal(trading_days)
        if trading_days > 0
        else Decimal("0")
    )
    reasons: list[str] = []
    if trading_days <= 0:
        reasons.append("market_impact_stress_trading_days_missing")
    if total_filled_notional <= 0:
        reasons.append("market_impact_stress_filled_notional_missing")
    if missing_liquidity_days:
        reasons.append("market_impact_stress_liquidity_evidence_missing")
    if impact_cost_bps <= 0:
        reasons.append("market_impact_stress_cost_bps_zero")
    if post_impact_net_pnl_per_day < program.objective.target_net_pnl_per_day:
        reasons.append("market_impact_stress_net_pnl_below_target")
    if not bool(report.get("objective_met")):
        reasons.append("approval_replay_objective_not_met")
    objective_met = not reasons
    return {
        "schema_version": "torghut.market-impact-stress-report.v1",
        "run_id": runner_run_id,
        "candidate_id": _string(best_candidate.get("candidate_id")),
        "runtime_family": _runtime_family(best_candidate),
        "runtime_strategy_name": _runtime_strategy_name(best_candidate),
        "runtime_strategy_names": list(
            _portfolio_runtime_strategy_names(best_candidate)
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
        "target_net_pnl_per_day": _decimal_string(
            program.objective.target_net_pnl_per_day
        ),
        "net_pnl_per_day": _decimal_string(_decimal(scorecard.get("net_pnl_per_day"))),
        "post_impact_net_pnl_per_day": _decimal_string(post_impact_net_pnl_per_day),
        "stressed_net_pnl_per_day": _decimal_string(post_impact_net_pnl_per_day),
        "net_pnl": _decimal_string(net_pnl),
        "post_impact_net_pnl": _decimal_string(post_impact_net_pnl),
        "impact_cost": _decimal_string(total_impact_cost),
        "impact_cost_bps": _decimal_string(impact_cost_bps),
        "market_impact_cost_bps": _decimal_string(impact_cost_bps),
        "liquidity_evidence_present": not missing_liquidity_days
        and total_filled_notional > 0,
        "liquidity_input_source": "recorded_liquidity_notional"
        if recorded_liquidity_days
        else "synthetic_proxy",
        "recorded_liquidity_day_count": recorded_liquidity_days,
        "missing_liquidity_days": missing_liquidity_days,
        "reference_notional": _decimal_string(reference_notional),
        "reference_adv_proxy": _decimal_string(reference_adv),
        "max_participation_rate": _decimal_string(max_participation),
        "impact_bps_at_full_participation": _decimal_string(
            config.impact_bps_at_full_participation
        ),
        "impact_participation_exponent": _decimal_string(
            config.impact_participation_exponent
        ),
        "trading_day_count": trading_days,
        "total_filled_notional": _decimal_string(total_filled_notional),
        "avg_filled_notional_per_day": _decimal_string(avg_filled_notional),
        "daily": daily_rows,
    }


def _delay_adjusted_depth_stress_report(
    *,
    runner_run_id: str,
    best_candidate: Mapping[str, Any],
    approval_report: Mapping[str, Any],
    program: StrategyAutoresearchProgram,
    cost_model_config: CostModelConfig | None = None,
) -> dict[str, Any]:
    config = cost_model_config or CostModelConfig()
    report = _mapping(approval_report)
    summary = _mapping(report.get("summary"))
    scorecard = _mapping(report.get("scorecard"))
    daily_lob_event_stream_count = _mapping(summary.get("daily_lob_event_stream_count"))
    daily_fill_outcome_count = _mapping(summary.get("daily_fill_outcome_count"))
    lob_event_stream_event_count = max(
        _int(summary.get("lob_event_stream_event_count")),
        _int(summary.get("lob_event_stream_sample_count")),
    )
    fill_outcome_count = max(
        _int(summary.get("fill_outcome_count")),
        _int(summary.get("fill_outcome_sample_count")),
    )
    live_paper_parity_sample_count = max(
        _int(summary.get("live_paper_parity_sample_count")),
        _int(summary.get("simulation_live_parity_sample_count")),
    )
    live_paper_parity_status = _string(
        summary.get("live_paper_parity_status")
        or summary.get("simulation_live_parity_status")
    )
    live_paper_parity_max_fill_error_bps_raw = summary.get(
        "live_paper_parity_max_fill_error_bps"
    ) or summary.get("simulation_live_fill_error_bps")
    live_paper_parity_max_fill_error_bps = _decimal(
        live_paper_parity_max_fill_error_bps_raw
    )
    live_paper_parity_max_adverse_selection_error_bps_raw = summary.get(
        "live_paper_parity_max_adverse_selection_error_bps"
    ) or summary.get("adverse_selection_error_bps")
    live_paper_parity_max_adverse_selection_error_bps = _decimal(
        live_paper_parity_max_adverse_selection_error_bps_raw
    )
    simulation_live_parity_status = _string(
        summary.get("simulation_live_parity_status")
    )
    implementation_trace_ref = _string(
        summary.get("implementation_trace_ref")
        or summary.get("runtime_implementation_artifact_ref")
    )
    lob_event_stream_artifact_ref = _string(
        summary.get("lob_event_stream_artifact_ref")
    )
    fill_outcomes_artifact_ref = _string(summary.get("fill_outcomes_artifact_ref"))
    simulation_live_parity_artifact_ref = _string(
        summary.get("simulation_live_parity_artifact_ref")
    )
    parity_status_ok = live_paper_parity_status in _EXECUTION_REALISM_PASS_STATUSES
    lob_event_stream_evidence_present = lob_event_stream_event_count > 0
    fill_outcome_evidence_present = fill_outcome_count > 0
    live_paper_parity_evidence_present = (
        live_paper_parity_sample_count >= _MIN_SIMULATION_PARITY_SAMPLE_COUNT
        and parity_status_ok
        and _string(live_paper_parity_max_fill_error_bps_raw) != ""
        and _string(live_paper_parity_max_adverse_selection_error_bps_raw) != ""
        and live_paper_parity_max_fill_error_bps <= _MAX_SIMULATION_LIVE_FILL_ERROR_BPS
        and live_paper_parity_max_adverse_selection_error_bps
        <= _MAX_ADVERSE_SELECTION_ERROR_BPS
    )
    execution_realism_missing_evidence = _execution_realism_missing_evidence(
        {
            "lob_event_stream_event_count": lob_event_stream_event_count,
            "lob_event_stream_artifact_ref": lob_event_stream_artifact_ref,
            "fill_outcome_count": fill_outcome_count,
            "fill_outcomes_artifact_ref": fill_outcomes_artifact_ref,
            "live_paper_parity_status": live_paper_parity_status,
            "live_paper_parity_sample_count": live_paper_parity_sample_count,
            "live_paper_parity_max_fill_error_bps": _optional_decimal_string(
                live_paper_parity_max_fill_error_bps_raw
            ),
            "live_paper_parity_max_adverse_selection_error_bps": _optional_decimal_string(
                live_paper_parity_max_adverse_selection_error_bps_raw
            ),
            "simulation_live_parity_artifact_ref": simulation_live_parity_artifact_ref,
            "implementation_trace_ref": implementation_trace_ref,
        }
    )
    lob_execution_realism_evidence_present = not execution_realism_missing_evidence
    daily_net = {
        day: _decimal(value)
        for day, value in _mapping(summary.get("daily_net")).items()
    }
    daily_notional = {
        day: _decimal(value)
        for day, value in _mapping(summary.get("daily_filled_notional")).items()
    }
    daily_liquidity = {
        day: _decimal(value)
        for day, value in _mapping(summary.get("daily_liquidity_notional")).items()
    }
    trading_days = max(_int(summary.get("trading_day_count")), len(daily_net))
    total_filled_notional = sum(daily_notional.values(), Decimal("0"))
    avg_filled_notional = (
        total_filled_notional / Decimal(trading_days)
        if trading_days > 0
        else Decimal("0")
    )
    stress_delay_ms = Decimal("250")
    latency_grid_ms = (Decimal("50"), Decimal("150"), Decimal("250"))
    depth_haircut_rate = min(
        Decimal("0.50"),
        max(Decimal("0.10"), stress_delay_ms / Decimal("1000")),
    )
    max_participation = (
        config.max_participation_rate
        if config.max_participation_rate > 0
        else Decimal("0.1")
    )
    daily_rows: list[dict[str, Any]] = []
    total_delay_depth_cost = Decimal("0")
    total_fillable_notional = Decimal("0")
    total_unfillable_notional = Decimal("0")
    total_post_delay_depth_net_pnl = Decimal("0")
    weighted_delay_depth_bps_notional = Decimal("0")
    recorded_liquidity_days = 0
    missing_liquidity_days = 0
    active_day_fillable_notional: list[Decimal] = []
    for day in sorted(daily_net):
        notional = daily_notional.get(day, Decimal("0"))
        liquidity_notional = daily_liquidity.get(day, Decimal("0"))
        if liquidity_notional > 0:
            recorded_liquidity_days += 1
        elif notional > 0:
            missing_liquidity_days += 1
        participation = (
            min(Decimal("1"), notional / liquidity_notional)
            if liquidity_notional > 0 and notional > 0
            else Decimal("0")
        )
        fillable_notional = (
            min(notional, liquidity_notional * (Decimal("1") - depth_haircut_rate))
            if liquidity_notional > 0 and notional > 0
            else Decimal("0")
        )
        latency_grid_fillable_notional = {
            _decimal_string(grid_ms): _decimal_string(
                min(
                    notional,
                    liquidity_notional
                    * (
                        Decimal("1")
                        - min(
                            Decimal("0.50"),
                            max(Decimal("0.10"), grid_ms / Decimal("1000")),
                        )
                    ),
                )
                if liquidity_notional > 0 and notional > 0
                else Decimal("0")
            )
            for grid_ms in latency_grid_ms
        }
        unfillable_notional = max(Decimal("0"), notional - fillable_notional)
        fillable_ratio = fillable_notional / notional if notional > 0 else Decimal("1")
        delay_depth_cost_bps = max(
            Decimal("1"),
            config.impact_bps_at_full_participation
            * participation_power(
                participation,
                config.impact_participation_exponent,
            )
            * depth_haircut_rate,
        )
        delay_depth_cost = (fillable_notional * delay_depth_cost_bps) / BPS_SCALE
        post_delay_depth_net = (daily_net[day] * fillable_ratio) - delay_depth_cost
        total_fillable_notional += fillable_notional
        total_unfillable_notional += unfillable_notional
        total_delay_depth_cost += delay_depth_cost
        total_post_delay_depth_net_pnl += post_delay_depth_net
        weighted_delay_depth_bps_notional += delay_depth_cost_bps * notional
        if notional > 0:
            active_day_fillable_notional.append(fillable_notional)
        daily_rows.append(
            {
                "day": day,
                "net_pnl": _decimal_string(daily_net[day]),
                "filled_notional": _decimal_string(notional),
                "liquidity_notional": _decimal_string(liquidity_notional),
                "lob_event_stream_count": _int(daily_lob_event_stream_count.get(day)),
                "fill_outcome_count": _int(daily_fill_outcome_count.get(day)),
                "stress_delay_ms": _decimal_string(stress_delay_ms),
                "depth_haircut_rate": _decimal_string(depth_haircut_rate),
                "latency_grid_fillable_notional": latency_grid_fillable_notional,
                "fillable_notional": _decimal_string(fillable_notional),
                "unfillable_notional": _decimal_string(unfillable_notional),
                "fillable_ratio": _decimal_string(fillable_ratio),
                "participation_rate_proxy": _decimal_string(participation),
                "delay_depth_cost_bps": _decimal_string(delay_depth_cost_bps),
                "delay_depth_cost": _decimal_string(delay_depth_cost),
                "post_delay_depth_net_pnl": _decimal_string(post_delay_depth_net),
            }
        )
    delay_depth_cost_bps = (
        weighted_delay_depth_bps_notional / total_filled_notional
        if total_filled_notional > 0
        else Decimal("0")
    )
    fillable_notional_per_day = (
        total_fillable_notional / Decimal(trading_days)
        if trading_days > 0
        else Decimal("0")
    )
    net_pnl = _decimal(summary.get("net_pnl"))
    post_delay_depth_net_pnl = total_post_delay_depth_net_pnl
    post_delay_depth_net_pnl_per_day = (
        post_delay_depth_net_pnl / Decimal(trading_days)
        if trading_days > 0
        else Decimal("0")
    )
    worst_active_day_fillable_notional = (
        min(active_day_fillable_notional)
        if active_day_fillable_notional
        else Decimal("0")
    )
    p10_active_day_fillable_notional = _p10(active_day_fillable_notional)
    tail_coverage_passed = (
        bool(active_day_fillable_notional)
        and missing_liquidity_days == 0
        and worst_active_day_fillable_notional >= program.objective.min_daily_notional
        and p10_active_day_fillable_notional >= program.objective.min_daily_notional
    )
    reasons: list[str] = []
    if trading_days <= 0:
        reasons.append("delay_adjusted_depth_stress_trading_days_missing")
    if total_filled_notional <= 0:
        reasons.append("delay_adjusted_depth_stress_filled_notional_missing")
    if missing_liquidity_days:
        reasons.append("delay_adjusted_depth_stress_liquidity_evidence_missing")
    if not lob_event_stream_evidence_present:
        reasons.append("delay_adjusted_depth_lob_event_stream_evidence_missing")
    if not fill_outcome_evidence_present:
        reasons.append("delay_adjusted_depth_fill_outcome_evidence_missing")
    if live_paper_parity_sample_count <= 0:
        reasons.append("delay_adjusted_depth_live_paper_parity_evidence_missing")
    if not parity_status_ok:
        reasons.append(
            "delay_adjusted_depth_live_paper_parity_status_not_within_budget"
        )
    if live_paper_parity_sample_count < _MIN_SIMULATION_PARITY_SAMPLE_COUNT:
        reasons.append(
            "delay_adjusted_depth_live_paper_parity_sample_count_below_minimum"
        )
    if _string(live_paper_parity_max_fill_error_bps_raw) == "":
        reasons.append(
            "delay_adjusted_depth_live_paper_parity_fill_error_evidence_missing"
        )
    elif live_paper_parity_max_fill_error_bps > _MAX_SIMULATION_LIVE_FILL_ERROR_BPS:
        reasons.append(
            "delay_adjusted_depth_live_paper_parity_fill_error_above_maximum"
        )
    if _string(live_paper_parity_max_adverse_selection_error_bps_raw) == "":
        reasons.append(
            "delay_adjusted_depth_live_paper_parity_adverse_selection_error_evidence_missing"
        )
    elif (
        live_paper_parity_max_adverse_selection_error_bps
        > _MAX_ADVERSE_SELECTION_ERROR_BPS
    ):
        reasons.append(
            "delay_adjusted_depth_live_paper_parity_adverse_selection_error_above_maximum"
        )
    if lob_event_stream_artifact_ref == "":
        reasons.append("delay_adjusted_depth_lob_event_stream_artifact_ref_missing")
    if fill_outcomes_artifact_ref == "":
        reasons.append("delay_adjusted_depth_fill_outcomes_artifact_ref_missing")
    if simulation_live_parity_artifact_ref == "":
        reasons.append(
            "delay_adjusted_depth_simulation_live_parity_artifact_ref_missing"
        )
    if implementation_trace_ref == "":
        reasons.append("implementation_trace_evidence_missing")
    if not lob_execution_realism_evidence_present:
        reasons.append("lob_execution_realism_evidence_missing")
    if delay_depth_cost_bps <= 0:
        reasons.append("delay_adjusted_depth_stress_cost_bps_zero")
    if fillable_notional_per_day < program.objective.min_daily_notional:
        reasons.append("delay_adjusted_depth_fillable_notional_below_minimum")
    if not tail_coverage_passed:
        reasons.append("delay_adjusted_depth_tail_fillable_notional_below_minimum")
    if post_delay_depth_net_pnl_per_day < program.objective.target_net_pnl_per_day:
        reasons.append("delay_adjusted_depth_stress_net_pnl_below_target")
    if not bool(report.get("objective_met")):
        reasons.append("approval_replay_objective_not_met")
    objective_met = not reasons
    generated_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    candidate_id = _string(best_candidate.get("candidate_id"))
    return {
        "schema_version": "torghut.delay-adjusted-depth-stress-report.v1",
        "run_id": runner_run_id,
        "candidate_id": candidate_id,
        "report_id": f"{runner_run_id}:{candidate_id}:delay-adjusted-depth-stress",
        "generated_at": generated_at,
        "checked_at": generated_at,
        "runtime_family": _runtime_family(best_candidate),
        "runtime_strategy_name": _runtime_strategy_name(best_candidate),
        "runtime_strategy_names": list(
            _portfolio_runtime_strategy_names(best_candidate)
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
        "case_count": len(daily_rows),
        "stress_case_count": len(daily_rows),
        "target_net_pnl_per_day": _decimal_string(
            program.objective.target_net_pnl_per_day
        ),
        "net_pnl_per_day": _decimal_string(_decimal(scorecard.get("net_pnl_per_day"))),
        "post_delay_depth_net_pnl_per_day": _decimal_string(
            post_delay_depth_net_pnl_per_day
        ),
        "stressed_net_pnl_per_day": _decimal_string(post_delay_depth_net_pnl_per_day),
        "net_pnl": _decimal_string(net_pnl),
        "post_delay_depth_net_pnl": _decimal_string(post_delay_depth_net_pnl),
        "delay_depth_cost": _decimal_string(total_delay_depth_cost),
        "delay_depth_cost_bps": _decimal_string(delay_depth_cost_bps),
        "stress_delay_ms": _decimal_string(stress_delay_ms),
        "latency_grid_ms": [
            _decimal_string(stress_ms) for stress_ms in latency_grid_ms
        ],
        "delay_adjusted_depth_latency_grid_ms": [
            _decimal_string(stress_ms) for stress_ms in latency_grid_ms
        ],
        "delay_adjusted_depth_grid_max_stress_ms": _decimal_string(
            max(latency_grid_ms)
        ),
        "depth_haircut_rate": _decimal_string(depth_haircut_rate),
        "liquidity_input_source": "recorded_liquidity_notional"
        if recorded_liquidity_days
        else "missing_recorded_liquidity",
        "execution_realism_status": "complete"
        if not execution_realism_missing_evidence
        else "missing_required_evidence",
        "execution_realism_missing_evidence": list(execution_realism_missing_evidence),
        "lob_execution_realism_evidence_present": lob_execution_realism_evidence_present,
        "lob_event_stream_evidence_present": lob_event_stream_evidence_present,
        "lob_event_stream_artifact_ref": lob_event_stream_artifact_ref,
        "lob_event_stream_event_count": lob_event_stream_event_count,
        "lob_event_stream_sample_count": lob_event_stream_event_count,
        "fill_outcome_evidence_present": fill_outcome_evidence_present,
        "fill_outcomes_artifact_ref": fill_outcomes_artifact_ref,
        "fill_outcome_count": fill_outcome_count,
        "fill_outcome_sample_count": fill_outcome_count,
        "live_paper_parity_evidence_present": live_paper_parity_evidence_present,
        "live_paper_parity_status": live_paper_parity_status,
        "live_paper_parity_sample_count": live_paper_parity_sample_count,
        "live_paper_parity_max_fill_error_bps": _optional_decimal_string(
            live_paper_parity_max_fill_error_bps_raw
        ),
        "live_paper_parity_max_adverse_selection_error_bps": _optional_decimal_string(
            live_paper_parity_max_adverse_selection_error_bps_raw
        ),
        "simulation_live_parity_sample_count": live_paper_parity_sample_count,
        "simulation_live_parity_status": simulation_live_parity_status,
        "simulation_live_parity_artifact_ref": simulation_live_parity_artifact_ref,
        "implementation_trace_ref": implementation_trace_ref,
        "recorded_liquidity_day_count": recorded_liquidity_days,
        "missing_liquidity_days": missing_liquidity_days,
        "max_participation_rate": _decimal_string(max_participation),
        "impact_participation_exponent": _decimal_string(
            config.impact_participation_exponent
        ),
        "trading_day_count": trading_days,
        "total_filled_notional": _decimal_string(total_filled_notional),
        "avg_filled_notional_per_day": _decimal_string(avg_filled_notional),
        "unfillable_notional": _decimal_string(total_unfillable_notional),
        "fillable_notional_per_day": _decimal_string(fillable_notional_per_day),
        "worst_active_day_fillable_notional": _decimal_string(
            worst_active_day_fillable_notional
        ),
        "delay_adjusted_depth_worst_active_day_fillable_notional": _decimal_string(
            worst_active_day_fillable_notional
        ),
        "p10_active_day_fillable_notional": _decimal_string(
            p10_active_day_fillable_notional
        ),
        "delay_adjusted_depth_p10_active_day_fillable_notional": _decimal_string(
            p10_active_day_fillable_notional
        ),
        "tail_coverage_passed": tail_coverage_passed,
        "delay_adjusted_depth_tail_coverage_passed": tail_coverage_passed,
        "daily": daily_rows,
    }


def _runtime_replay_net_pnl_per_day(report: Mapping[str, Any]) -> Decimal:
    scorecard = _mapping(report.get("scorecard"))
    summary = _mapping(report.get("summary"))
    explicit = _decimal(
        scorecard.get("portfolio_post_cost_net_pnl_per_day")
        or scorecard.get("net_pnl_per_day")
        or summary.get("net_per_day"),
        default="-999999999",
    )
    if explicit != Decimal("-999999999"):
        return explicit
    trading_days = _int(summary.get("trading_day_count"))
    if trading_days <= 0:
        return Decimal("0")
    return _decimal(summary.get("net_pnl")) / Decimal(trading_days)


def _double_oos_window_row(
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
    summary = _mapping(report.get("summary"))
    net_pnl_per_day = _runtime_replay_net_pnl_per_day(report)
    reasons: list[str] = []
    if not bool(report.get("objective_met")):
        reasons.append(f"{window_id}_objective_not_met")
    if net_pnl_per_day < target_net_pnl_per_day:
        reasons.append(f"{window_id}_net_pnl_below_target")
    if _int(summary.get("trading_day_count")) <= 0:
        reasons.append(f"{window_id}_trading_days_missing")
    passed = not reasons
    return {
        "window_id": window_id,
        "source": "double_oos_walkforward_arxiv_2602_10785_2026",
        "validation_type": "double_oos_walkforward",
        "passed": passed,
        "status": "pass" if passed else "fail",
        "net_pnl_per_day": _decimal_string(net_pnl_per_day),
        "post_cost_net_pnl_per_day": _decimal_string(net_pnl_per_day),
        "trading_day_count": _int(summary.get("trading_day_count")),
        "start_date": _string(summary.get("start_date")),
        "end_date": _string(summary.get("end_date")),
        "decision_count": _int(summary.get("decision_count")),
        "filled_count": _int(summary.get("filled_count")),
        "reasons": reasons,
    }


def _double_oos_cost_shock_net_pnl_per_day(
    *,
    double_oos_net_pnl_per_day: Decimal,
    market_impact_report: Mapping[str, Any] | None,
    delay_depth_report: Mapping[str, Any] | None,
) -> Decimal:
    stressed = [double_oos_net_pnl_per_day]
    if market_impact_report is not None:
        stressed.append(
            _decimal(
                market_impact_report.get("post_impact_net_pnl_per_day")
                or market_impact_report.get("stressed_net_pnl_per_day")
            )
        )
    if delay_depth_report is not None:
        stressed.append(
            _decimal(
                delay_depth_report.get("post_delay_depth_net_pnl_per_day")
                or delay_depth_report.get("stressed_net_pnl_per_day")
            )
        )
    return min(stressed, default=Decimal("0"))


__all__ = [name for name in globals() if not name.startswith("__")]
