# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Import observed runtime windows into the hypothesis governance ledger."""

from __future__ import annotations

import logging
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Any, Mapping, Sequence, cast
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import and_, delete, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from ...config import settings
from ...models import (
    StrategyCapitalAllocation,
    StrategyHypothesis,
    StrategyHypothesisMetricWindow,
    StrategyHypothesisVersion,
    StrategyPromotionDecision,
    StrategyRuntimeLedgerBucket,
    TigerBeetleAccountRef,
    TigerBeetleTransferRef,
    VNextDatasetSnapshot,
)
from ..hypotheses import (
    HypothesisManifest,
    HypothesisRegistryLoadResult,
    load_hypothesis_registry,
)
from ..runtime_ledger import EXACT_REPLAY_LEDGER_SCHEMA_VERSION, POST_COST_PNL_BASIS
from ..runtime_cost_authority import (
    cost_basis_counts_have_non_promotion_grade_costs,
    is_non_promotion_grade_runtime_cost_basis,
)
from ..runtime_decision_authority import (
    SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER,
    SOURCE_DECISION_MODE_PROFIT_PROOF_MISSING_BLOCKER,
    normalize_source_decision_mode,
    source_decision_mode_counts_have_non_profit_proof_modes,
    source_decision_mode_counts_have_profit_proof_modes,
    source_decision_mode_is_profit_proof_eligible,
)
from ..runtime_ledger_proof_policy import runtime_ledger_proof_policy_from_env
from ..runtime_ledger_source_authority import (
    build_runtime_ledger_profit_distance_readback,
    runtime_ledger_promotion_source_authority_blockers as _base_runtime_ledger_promotion_source_authority_blockers,
)
from ..tigerbeetle_journal import (
    TIGERBEETLE_BLOCKER_JOURNAL_DISABLED,
    TIGERBEETLE_BLOCKER_JOURNAL_ENTRY_UNAVAILABLE,
    TIGERBEETLE_BLOCKER_JOURNAL_ERROR,
    TIGERBEETLE_RUNTIME_LEDGER_JOURNAL_STATUS_NON_AUTHORITY_BLOCKED,
    TIGERBEETLE_RUNTIME_LEDGER_JOURNAL_STATUS_PASS,
    TigerBeetleLedgerJournal,
    tigerbeetle_runtime_ledger_journal_payload,
)

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_63 import *


def _delay_adjusted_depth_stress_blocking_reasons(
    *,
    manifest: HypothesisManifest,
    runtime_payload: Mapping[str, Any],
    now: datetime,
) -> list[str]:
    requirements = manifest.entry_requirements
    if not requirements.require_delay_adjusted_depth_stress:
        return []

    raw_report = runtime_payload.get("delay_adjusted_depth_stress_report")
    report: Mapping[str, Any]
    if isinstance(raw_report, Mapping):
        report = cast(Mapping[str, Any], raw_report)
    else:
        report = {}
    check_count = max(
        _observation_int(
            runtime_payload.get("delay_adjusted_depth_stress_checks_total")
        ),
        _observation_int(runtime_payload.get("delay_depth_stress_checks_total")),
        _observation_int(report.get("stress_case_count")),
        _observation_int(report.get("case_count")),
        _observation_int(report.get("trading_day_count")),
    )
    passed = _observation_bool(
        runtime_payload.get("delay_adjusted_depth_stress_passed")
        if runtime_payload.get("delay_adjusted_depth_stress_passed") is not None
        else report.get("passed", report.get("ok"))
    )
    checked_at = (
        _parse_observation_datetime(
            runtime_payload.get("delay_adjusted_depth_stress_checked_at")
        )
        or _parse_observation_datetime(report.get("generated_at"))
        or _parse_observation_datetime(report.get("checked_at"))
    )

    reasons: list[str] = []
    if check_count < requirements.min_delay_adjusted_depth_stress_checks:
        reasons.append("delay_adjusted_depth_stress_missing")
    elif passed is not True:
        reasons.append("delay_adjusted_depth_stress_failed")
    if checked_at is None:
        reasons.append("delay_adjusted_depth_stress_missing")
    elif (
        requirements.max_delay_adjusted_depth_stress_age_minutes is not None
        and checked_at
        < now
        - timedelta(minutes=requirements.max_delay_adjusted_depth_stress_age_minutes)
    ):
        reasons.append("delay_adjusted_depth_stress_stale")
    if not reasons:
        summary = _delay_adjusted_depth_stress_summary(runtime_payload)
        if _observation_bool(summary.get("tail_coverage_passed")) is not True:
            reasons.append("delay_adjusted_depth_tail_coverage_missing")
        if _observation_decimal(summary.get("p10_active_day_fillable_notional")) <= 0:
            reasons.append("delay_adjusted_depth_p10_fillable_non_positive")
        if _observation_decimal(summary.get("worst_active_day_fillable_notional")) <= 0:
            reasons.append("delay_adjusted_depth_worst_fillable_non_positive")
        if _observation_decimal(summary.get("stress_net_pnl_per_day")) <= 0:
            reasons.append("delay_adjusted_depth_stress_net_pnl_non_positive")
        if _observation_bool(summary.get("fill_survival_evidence_present")) is not True:
            reasons.append("fill_survival_evidence_missing")
        if _observation_int(summary.get("fill_survival_sample_count")) <= 0:
            reasons.append("fill_survival_sample_count_zero")
        if (
            _observation_bool(summary.get("queue_ahead_depletion_evidence_present"))
            is not True
        ):
            reasons.append("queue_ahead_depletion_evidence_missing")
        if _observation_int(summary.get("queue_ahead_depletion_sample_count")) <= 0:
            reasons.append("queue_ahead_depletion_sample_count_zero")
    return list(dict.fromkeys(reasons))


def _delay_adjusted_depth_stress_summary(
    runtime_payload: Mapping[str, Any],
) -> dict[str, object]:
    raw_report = runtime_payload.get("delay_adjusted_depth_stress_report")
    report: Mapping[str, Any]
    if isinstance(raw_report, Mapping):
        report = cast(Mapping[str, Any], raw_report)
    else:
        report = {}
    check_count = max(
        _observation_int(
            runtime_payload.get("delay_adjusted_depth_stress_checks_total")
        ),
        _observation_int(runtime_payload.get("delay_depth_stress_checks_total")),
        _observation_int(report.get("stress_case_count")),
        _observation_int(report.get("case_count")),
        _observation_int(report.get("trading_day_count")),
    )
    checked_at = (
        _parse_observation_datetime(
            runtime_payload.get("delay_adjusted_depth_stress_checked_at")
        )
        or _parse_observation_datetime(report.get("generated_at"))
        or _parse_observation_datetime(report.get("checked_at"))
    )
    latency_grid_ms = (
        _string_list(runtime_payload.get("delay_adjusted_depth_latency_grid_ms"))
        or _string_list(report.get("delay_adjusted_depth_latency_grid_ms"))
        or _string_list(report.get("latency_grid_ms"))
    )
    return {
        "checks_total": check_count,
        "passed": _observation_bool(
            runtime_payload.get("delay_adjusted_depth_stress_passed")
            if runtime_payload.get("delay_adjusted_depth_stress_passed") is not None
            else report.get("passed", report.get("ok"))
        ),
        "checked_at": checked_at.isoformat() if checked_at is not None else None,
        "artifact_ref": _text(
            runtime_payload.get("delay_adjusted_depth_stress_artifact_ref")
        )
        or _text(report.get("artifact_ref")),
        "latency_grid_ms": latency_grid_ms,
        "grid_max_stress_ms": _text(
            runtime_payload.get("delay_adjusted_depth_grid_max_stress_ms")
        )
        or _text(report.get("delay_adjusted_depth_grid_max_stress_ms"))
        or _text(report.get("grid_max_stress_ms")),
        "worst_grid_fillable_notional_per_day": _text(
            runtime_payload.get(
                "delay_adjusted_depth_worst_grid_fillable_notional_per_day"
            )
        )
        or _text(
            report.get("delay_adjusted_depth_worst_grid_fillable_notional_per_day")
        )
        or _text(report.get("worst_grid_fillable_notional_per_day")),
        "worst_active_day_fillable_notional": _text(
            runtime_payload.get(
                "delay_adjusted_depth_worst_active_day_fillable_notional"
            )
        )
        or _text(report.get("delay_adjusted_depth_worst_active_day_fillable_notional"))
        or _text(report.get("worst_active_day_fillable_notional")),
        "p10_active_day_fillable_notional": _text(
            runtime_payload.get("delay_adjusted_depth_p10_active_day_fillable_notional")
        )
        or _text(report.get("delay_adjusted_depth_p10_active_day_fillable_notional"))
        or _text(report.get("p10_active_day_fillable_notional")),
        "tail_coverage_passed": _observation_bool(
            runtime_payload.get("delay_adjusted_depth_tail_coverage_passed")
            if runtime_payload.get("delay_adjusted_depth_tail_coverage_passed")
            is not None
            else report.get(
                "delay_adjusted_depth_tail_coverage_passed",
                report.get("tail_coverage_passed"),
            )
        ),
        "fillable_ratio": _text(
            runtime_payload.get("delay_adjusted_depth_fillable_ratio")
        )
        or _text(report.get("delay_adjusted_depth_fillable_ratio"))
        or _text(report.get("fillable_ratio")),
        "survival_adjusted_fillable_ratio": _text(
            runtime_payload.get("delay_adjusted_depth_survival_adjusted_fillable_ratio")
        )
        or _text(report.get("delay_adjusted_depth_survival_adjusted_fillable_ratio"))
        or _text(report.get("survival_adjusted_fillable_ratio")),
        "unfillable_notional_per_day": _text(
            runtime_payload.get("delay_adjusted_depth_unfillable_notional_per_day")
        )
        or _text(report.get("delay_adjusted_depth_unfillable_notional_per_day"))
        or _text(report.get("unfillable_notional_per_day")),
        "stress_net_pnl_per_day": _text(
            runtime_payload.get("delay_adjusted_depth_stress_net_pnl_per_day")
        )
        or _text(report.get("delay_adjusted_depth_stress_net_pnl_per_day"))
        or _text(report.get("stress_net_pnl_per_day")),
        "fill_survival_evidence_present": _observation_bool(
            runtime_payload.get("delay_adjusted_depth_fill_survival_evidence_present")
            if runtime_payload.get(
                "delay_adjusted_depth_fill_survival_evidence_present"
            )
            is not None
            else report.get(
                "delay_adjusted_depth_fill_survival_evidence_present",
                report.get("fill_survival_evidence_present"),
            )
        ),
        "fill_survival_sample_count": max(
            _observation_int(
                runtime_payload.get("delay_adjusted_depth_fill_survival_sample_count")
            ),
            _observation_int(
                report.get("delay_adjusted_depth_fill_survival_sample_count")
            ),
            _observation_int(report.get("fill_survival_sample_count")),
        ),
        "fill_survival_rate": _text(
            runtime_payload.get("delay_adjusted_depth_fill_survival_rate")
        )
        or _text(report.get("delay_adjusted_depth_fill_survival_rate"))
        or _text(report.get("fill_survival_rate")),
        "queue_ratio_p95": _text(
            runtime_payload.get("delay_adjusted_depth_queue_ratio_p95")
        )
        or _text(report.get("delay_adjusted_depth_queue_ratio_p95"))
        or _text(report.get("queue_ratio_p95")),
        "queue_ahead_depletion_evidence_present": _observation_bool(
            runtime_payload.get(
                "delay_adjusted_depth_queue_ahead_depletion_evidence_present"
            )
            if runtime_payload.get(
                "delay_adjusted_depth_queue_ahead_depletion_evidence_present"
            )
            is not None
            else report.get(
                "delay_adjusted_depth_queue_ahead_depletion_evidence_present",
                report.get("queue_ahead_depletion_evidence_present"),
            )
        ),
        "queue_ahead_depletion_sample_count": max(
            _observation_int(
                runtime_payload.get(
                    "delay_adjusted_depth_queue_ahead_depletion_sample_count"
                )
            ),
            _observation_int(
                report.get("delay_adjusted_depth_queue_ahead_depletion_sample_count")
            ),
            _observation_int(report.get("queue_ahead_depletion_sample_count")),
        ),
    }


def _capital_stage_for_runtime_import(
    *,
    observed_stage: str,
    promotion_allowed: bool,
    session_samples: int,
    manifest: HypothesisManifest,
) -> str:
    if observed_stage == "paper" or not promotion_allowed:
        return "shadow"
    if session_samples >= manifest.min_sample_count_for_scale_up:
        return "0.50x live"
    return "0.10x canary"


def _capital_multiplier_for_stage(stage: str) -> str:
    return {
        "shadow": "0",
        "0.10x canary": "0.10",
        "0.25x canary": "0.25",
        "0.50x live": "0.50",
        "1.00x live": "1.00",
    }.get(stage, "0")


def _runtime_window_import_proof_blockers(
    *,
    promotion_blocking_reasons: Sequence[str],
    runtime_payload: Mapping[str, Any],
    candidate_id: str | None,
    hypothesis_id: str,
    observed_stage: str,
    window_start: datetime,
    window_end: datetime,
) -> list[dict[str, Any]]:
    blockers: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add_blocker(reason: str) -> None:
        code = _text(reason)
        if not code or code in seen:
            return
        seen.add(code)
        blockers.append(
            {
                "blocker": code,
                "hypothesis_id": hypothesis_id,
                "candidate_id": candidate_id,
                "observed_stage": observed_stage,
                "window_start": window_start.isoformat(),
                "window_end": window_end.isoformat(),
                "promotion_authority": _text(runtime_payload.get("promotion_authority"))
                or "unknown",
                "authority_reason": _text(runtime_payload.get("authority_reason")),
                "runtime_ledger_profit_proof_present": bool(
                    runtime_payload.get("runtime_ledger_profit_proof_present")
                ),
                "remediation": (
                    "Inspect the imported runtime-window ledger rows and repair route, "
                    "TCA, fill, cost, or lineage evidence before treating this target as "
                    "promotion proof."
                ),
            }
        )

    for reason in promotion_blocking_reasons:
        add_blocker(reason)

    if runtime_payload and runtime_payload.get("authoritative") is False:
        add_blocker(
            _text(runtime_payload.get("authority_reason"))
            or "runtime_observation_not_authoritative"
        )

    return blockers


def _runtime_window_import_evidence_blocking_reasons(
    promotion_blocking_reasons: Sequence[str],
) -> list[str]:
    return [
        reason
        for reason in promotion_blocking_reasons
        if reason not in _RUNTIME_WINDOW_IMPORT_CAPITAL_ONLY_BLOCKERS
    ]


def _runtime_ledger_authority_gate_targets(
    *,
    average_post_cost_bps: Decimal,
) -> dict[str, Any]:
    target_implied_notional = (
        RUNTIME_LEDGER_PROOF_POLICY.authority_min_mean_daily_net_pnl_after_costs
        * Decimal("10000")
        / average_post_cost_bps
        if average_post_cost_bps > 0
        else None
    )
    return {
        "min_observed_trading_days": (
            RUNTIME_LEDGER_PROOF_POLICY.authority_min_trading_days
        ),
        "min_mean_daily_net_pnl_after_costs": str(
            RUNTIME_LEDGER_PROOF_POLICY.authority_min_mean_daily_net_pnl_after_costs
        ),
        "min_median_daily_net_pnl_after_costs": str(
            RUNTIME_LEDGER_PROOF_POLICY.authority_min_median_daily_net_pnl_after_costs
        ),
        "min_p10_daily_net_pnl_after_costs": str(
            RUNTIME_LEDGER_PROOF_POLICY.authority_min_p10_daily_net_pnl_after_costs
        ),
        "min_worst_day_net_pnl_after_costs": str(
            RUNTIME_LEDGER_PROOF_POLICY.authority_min_worst_day_net_pnl_after_costs
        ),
        "max_intraday_drawdown": str(
            RUNTIME_LEDGER_PROOF_POLICY.authority_max_intraday_drawdown
        ),
        "max_best_day_share": str(
            RUNTIME_LEDGER_PROOF_POLICY.authority_max_best_day_share
        ),
        "target_implied_avg_daily_filled_notional": (
            _decimal_text(target_implied_notional)
            if target_implied_notional is not None
            else None
        ),
        "target_implied_avg_daily_filled_notional_basis": (
            "min_mean_daily_net_pnl_after_costs / observed_post_cost_expectancy_bps"
            if target_implied_notional is not None
            else None
        ),
    }


def _runtime_summary_decimal(
    runtime_ledger_daily_summary: Mapping[str, Any],
    key: str,
) -> Decimal:
    return _optional_decimal(runtime_ledger_daily_summary.get(key)) or Decimal("0")


def _runtime_promotion_blocking_reasons(
    *,
    observed_stage: str,
    inserted: int,
    total_session_samples: int,
    total_decision_count: int,
    total_trade_count: int,
    total_order_count: int,
    total_post_cost_promotion_sample_count: int,
    runtime_ledger_notional_weighted_sample_count: int,
    total_post_cost_basis_counts: Mapping[str, int],
    average_slippage: Decimal,
    average_post_cost: Decimal,
    runtime_ledger_daily_summary: Mapping[str, Any],
    latest_three_budget_ok: bool,
    all_continuity_ok: bool,
    all_drift_ok: bool,
    dependency_quorum_allowed: bool,
    manifest: HypothesisManifest,
    budget: Decimal,
) -> list[str]:
    reasons: list[str] = []
    if observed_stage == "paper":
        reasons.append("paper_stage_evidence_collection_only")
    if inserted <= 0:
        reasons.append("runtime_window_evidence_missing")
    if total_session_samples < manifest.min_sample_count_for_live_canary:
        reasons.append("sample_count_below_canary_minimum")
    if total_decision_count <= 0:
        reasons.append("runtime_decision_count_zero")
    if total_order_count <= 0:
        reasons.append("runtime_order_count_zero")
    if total_trade_count <= 0:
        reasons.append("runtime_trade_count_zero")
    if average_slippage > budget:
        reasons.append("slippage_budget_exceeded")
    if not latest_three_budget_ok:
        reasons.append("recent_slippage_budget_exceeded")
    if not all_continuity_ok:
        reasons.append("evidence_continuity_not_ok")
    if not all_drift_ok:
        reasons.append("drift_checks_not_ok")
    if not dependency_quorum_allowed:
        reasons.append("dependency_quorum_not_allow")
    if total_post_cost_promotion_sample_count <= 0:
        reasons.append("post_cost_pnl_basis_missing")
    if (
        runtime_ledger_notional_weighted_sample_count <= 0
        or runtime_ledger_notional_weighted_sample_count
        < total_post_cost_promotion_sample_count
    ):
        reasons.append("runtime_ledger_pnl_basis_missing")
    if average_post_cost <= Decimal("0"):
        reasons.append("post_cost_expectancy_non_positive")
    elif average_post_cost < manifest.expected_gross_edge_bps:
        reasons.append("post_cost_expectancy_below_manifest_threshold")
    observed_trading_days = int(
        _runtime_summary_decimal(
            runtime_ledger_daily_summary,
            "runtime_ledger_observed_trading_day_count",
        )
    )
    mean_daily_net_pnl = _runtime_summary_decimal(
        runtime_ledger_daily_summary,
        "runtime_ledger_mean_daily_net_pnl_after_costs",
    )
    median_daily_net_pnl = _runtime_summary_decimal(
        runtime_ledger_daily_summary,
        "runtime_ledger_median_daily_net_pnl_after_costs",
    )
    p10_daily_net_pnl = _runtime_summary_decimal(
        runtime_ledger_daily_summary,
        "runtime_ledger_p10_daily_net_pnl_after_costs",
    )
    worst_day_net_pnl = _runtime_summary_decimal(
        runtime_ledger_daily_summary,
        "runtime_ledger_worst_day_net_pnl_after_costs",
    )
    max_intraday_drawdown = _runtime_summary_decimal(
        runtime_ledger_daily_summary,
        "runtime_ledger_max_intraday_drawdown",
    )
    best_day_share = _optional_decimal(
        runtime_ledger_daily_summary.get("runtime_ledger_best_day_share")
    )
    avg_daily_filled_notional = _runtime_summary_decimal(
        runtime_ledger_daily_summary,
        "runtime_ledger_avg_daily_filled_notional",
    )

    if observed_trading_days < RUNTIME_LEDGER_PROOF_POLICY.authority_min_trading_days:
        reasons.append(
            "runtime_ledger_observed_trading_day_count_below_authority_minimum"
        )
    if (
        mean_daily_net_pnl
        < RUNTIME_LEDGER_PROOF_POLICY.authority_min_mean_daily_net_pnl_after_costs
    ):
        reasons.append("runtime_ledger_mean_daily_net_pnl_after_costs_below_target")
    if (
        median_daily_net_pnl
        < RUNTIME_LEDGER_PROOF_POLICY.authority_min_median_daily_net_pnl_after_costs
    ):
        reasons.append("runtime_ledger_median_daily_net_pnl_after_costs_below_floor")
    if (
        p10_daily_net_pnl
        < RUNTIME_LEDGER_PROOF_POLICY.authority_min_p10_daily_net_pnl_after_costs
    ):
        reasons.append("runtime_ledger_p10_daily_net_pnl_after_costs_below_floor")
    if (
        worst_day_net_pnl
        < RUNTIME_LEDGER_PROOF_POLICY.authority_min_worst_day_net_pnl_after_costs
    ):
        reasons.append("runtime_ledger_worst_day_net_pnl_after_costs_below_floor")
    if (
        max_intraday_drawdown
        > RUNTIME_LEDGER_PROOF_POLICY.authority_max_intraday_drawdown
    ):
        reasons.append("runtime_ledger_max_intraday_drawdown_above_limit")
    if (
        best_day_share is not None
        and best_day_share > RUNTIME_LEDGER_PROOF_POLICY.authority_max_best_day_share
    ):
        reasons.append("runtime_ledger_best_day_share_above_limit")
    if average_post_cost > 0:
        target_implied_notional = (
            RUNTIME_LEDGER_PROOF_POLICY.authority_min_mean_daily_net_pnl_after_costs
            * Decimal("10000")
            / average_post_cost
        )
        if avg_daily_filled_notional < target_implied_notional:
            reasons.append(
                "runtime_ledger_avg_daily_filled_notional_below_target_implied_floor"
            )
    return reasons


def resolve_hypothesis_manifest(
    *,
    hypothesis_id: str,
    strategy_family: str | None = None,
) -> tuple[HypothesisRegistryLoadResult, HypothesisManifest]:
    registry = load_hypothesis_registry(raise_on_error=True)
    manifest = next(
        (item for item in registry.items if item.hypothesis_id == hypothesis_id), None
    )
    if manifest is None:
        raise RuntimeError(f"hypothesis_manifest_not_found:{hypothesis_id}")
    if not _strategy_family_matches(manifest=manifest, strategy_family=strategy_family):
        raise RuntimeError(
            f"hypothesis_strategy_family_mismatch:{hypothesis_id}:{manifest.strategy_family}:{strategy_family}"
        )
    return registry, manifest


def build_regular_session_buckets(
    *,
    window_start: datetime,
    window_end: datetime,
    bucket_minutes: int,
    sample_minutes: int,
    timezone_name: str = US_EQUITIES_REGULAR_TIMEZONE,
) -> list[tuple[datetime, datetime, int]]:
    if bucket_minutes <= 0:
        raise RuntimeError("bucket_minutes_must_be_positive")
    if sample_minutes <= 0:
        raise RuntimeError("sample_minutes_must_be_positive")
    start_utc = _utc(window_start)
    end_utc = _utc(window_end)
    if end_utc <= start_utc:
        raise RuntimeError("window_end_must_be_after_window_start")

    zone = ZoneInfo(timezone_name)
    bucket_delta = timedelta(minutes=bucket_minutes)
    sample_delta = timedelta(minutes=sample_minutes)
    buckets: list[tuple[datetime, datetime, int]] = []

    current_day = start_utc.astimezone(zone).date()
    final_day = (end_utc - timedelta(microseconds=1)).astimezone(zone).date()
    while current_day <= final_day:
        if current_day.weekday() >= 5:
            current_day += timedelta(days=1)
            continue
        session_start_local = datetime.combine(
            current_day, US_EQUITIES_REGULAR_OPEN, tzinfo=zone
        )
        session_end_local = datetime.combine(
            current_day, US_EQUITIES_REGULAR_CLOSE, tzinfo=zone
        )
        bucket_start = max(start_utc, session_start_local.astimezone(timezone.utc))
        session_end = min(end_utc, session_end_local.astimezone(timezone.utc))
        while bucket_start < session_end:
            bucket_end = min(bucket_start + bucket_delta, session_end)
            duration = max(bucket_end - bucket_start, timedelta())
            sample_count = max(
                int(duration.total_seconds() // sample_delta.total_seconds()), 1
            )
            buckets.append((bucket_start, bucket_end, sample_count))
            bucket_start = bucket_end
        current_day += timedelta(days=1)
    return buckets


__all__ = [name for name in globals() if not name.startswith("__")]
