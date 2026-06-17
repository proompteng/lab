# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
# fmt: off
"""Traceability helpers for doc 29 completion gates."""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping, Sequence, cast
from zoneinfo import ZoneInfo

import yaml
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...models import (
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    StrategyRuntimeLedgerBucket,
    VNextCompletionGateResult,
    VNextEmpiricalJobRun,
)
from ..empirical_jobs import EMPIRICAL_JOB_TYPES, build_empirical_jobs_status
from ..hypotheses import HypothesisManifest, load_hypothesis_registry
from ..runtime_cost_authority import (
    cost_basis_counts_have_non_promotion_grade_costs,
    is_non_promotion_grade_runtime_cost_basis,
)
from ..runtime_ledger import POST_COST_PNL_BASIS
from ..runtime_ledger_source_authority import (
    build_runtime_ledger_profit_distance_readback,
    runtime_ledger_promotion_source_authority_blockers,
)

# ruff: noqa: F401,F403,F405,F811,F821

from .runtime_matrix_path import (
    DOC29_COMPLETION_ENDPOINT,
    DOC29_COMPLETION_MATRIX_DOC_PATH,
    DOC29_COMPLETION_MATRIX_RUNTIME_PATH,
    DOC29_EMPIRICAL_JOBS_GATE,
    DOC29_EMPIRICAL_MANIFEST_GATE,
    DOC29_LIVE_CANARY_GATE,
    DOC29_LIVE_SCALE_GATE,
    DOC29_PAPER_GATE,
    DOC29_SIMULATION_FULL_DAY_GATE,
    DOC29_SIMULATION_SMOKE_GATE,
    TRACE_STATUSES,
    TRACE_STATUS_BLOCKED,
    TRACE_STATUS_REGRESSED,
    TRACE_STATUS_SATISFIED,
    TRACE_STATUS_STALE,
    US_EQUITIES_REGULAR_TIMEZONE,
    PromotionDecisionKey as _PromotionDecisionKey,
    RUNTIME_LEDGER_BUCKET_SCHEMAS as _RUNTIME_LEDGER_BUCKET_SCHEMAS,
    as_dict as _as_dict,
    as_list as _as_list,
    as_text as _as_text,
    candidate_hypothesis_manifests as _candidate_hypothesis_manifests,
    doc_matrix_path as _doc_matrix_path,
    gate_policy_parameters as _gate_policy_parameters,
    latest_completion_rows as _latest_completion_rows,
    latest_completion_rows_filtered as _latest_completion_rows_filtered,
    latest_empirical_rows as _latest_empirical_rows,
    latest_hypothesis_windows as _latest_hypothesis_windows,
    load_hypothesis_manifests_by_id as _load_hypothesis_manifests_by_id,
    load_yaml_mapping as _load_yaml_mapping,
    manifest_runtime_session_threshold as _manifest_runtime_session_threshold,
    median_decimal as _median_decimal,
    normalize_gate_definition as _normalize_gate_definition,
    p10_decimal as _p10_decimal,
    policy_int as _policy_int,
    positive_hash_count as _positive_hash_count,
    promotion_decision_blocked_reason as _promotion_decision_blocked_reason,
    promotion_decision_key as _promotion_decision_key,
    promotion_decision_key_for_decision as _promotion_decision_key_for_decision,
    promotion_decision_key_for_window as _promotion_decision_key_for_window,
    promotion_decision_keys_for_windows as _promotion_decision_keys_for_windows,
    runtime_ledger_bucket_promotion_payload as _runtime_ledger_bucket_promotion_payload,
    runtime_ledger_trading_day_key as _runtime_ledger_trading_day_key,
    runtime_matrix_path as _runtime_matrix_path,
    safe_float as _safe_float,
    safe_int as _safe_int,
    utc as _utc,
    windows_with_allowed_promotion_decisions as _windows_with_allowed_promotion_decisions,
    build_completion_trace,
    load_doc29_completion_matrix,
    persist_completion_trace,
    runtime_and_doc_completion_matrices_match,
    upsert_completion_gate_result,
    validate_doc29_completion_matrix,
)

@dataclass(frozen=True)
class _RuntimeLedgerBucketTotals:
    filled_notional: Decimal
    net_pnl: Decimal
    cost_amount: Decimal
    closed_trade_count: int
    open_position_count: int

@dataclass(frozen=True)
class _RuntimeLedgerSourceAuthoritySummary:
    bucket_count: int
    blockers: list[str]
    cost_basis_counts: dict[str, int]

@dataclass(frozen=True)
class _RuntimeLedgerDailySeries:
    trading_days: list[str]
    net_pnl_by_day: dict[str, Decimal]
    filled_notional_by_day: dict[str, Decimal]
    closed_trade_count_by_day: dict[str, int]
    max_intraday_drawdown: Decimal

@dataclass(frozen=True)
class _WindowWeightedMetrics:
    alignment_ratio: float
    avg_slippage_bps: float
    avg_expectancy_bps: float

@dataclass(frozen=True)
class _EmpiricalJobsGateEvidence:
    dataset_snapshot_ref: Any
    candidate_id: Any
    artifact_refs: list[str]
    db_row_refs: dict[str, Any]
    dataset_refs: set[str]
    candidate_ids: set[str]

@dataclass(frozen=True)
class _TraceGateRefs:
    artifact_refs: list[str]
    db_row_refs: dict[str, Any]
    dataset_snapshot_ref: Any
    candidate_id: Any

@dataclass(frozen=True)
class _LiveScaleRuntimeSummary:
    window_summary: dict[str, Any]
    ledger_summary: dict[str, Any]
    unbacked_window_refs: list[str]
    backed_windows: list[StrategyHypothesisMetricWindow]

def _runtime_ledger_bucket_existing_blockers(
    bucket: StrategyRuntimeLedgerBucket,
) -> list[str]:
    payload = _as_dict(bucket.payload_json)
    blockers = [
        str(item).strip()
        for item in [*_as_list(bucket.blockers_json), *_as_list(payload.get('blockers'))]
        if str(item).strip()
    ]
    return list(dict.fromkeys(blockers))

def _runtime_ledger_bucket_matches_window(
    bucket: StrategyRuntimeLedgerBucket,
    window: StrategyHypothesisMetricWindow,
) -> bool:
    identity_matches = (
        _as_text(bucket.run_id) == _as_text(window.run_id)
        and _as_text(bucket.hypothesis_id) == _as_text(window.hypothesis_id)
        and _as_text(bucket.candidate_id) == _as_text(window.candidate_id)
        and _as_text(bucket.observed_stage) == _as_text(window.observed_stage)
    )
    if not identity_matches:
        return False
    window_started = _utc(window.window_started_at)
    window_ended = _utc(window.window_ended_at)
    bucket_started = _utc(bucket.bucket_started_at)
    bucket_ended = _utc(bucket.bucket_ended_at)
    if window_started is None or window_ended is None or bucket_started is None or bucket_ended is None:
        return False
    return bucket_started <= window_started and bucket_ended >= window_ended

def _runtime_ledger_bucket_window_match_key(
    bucket: StrategyRuntimeLedgerBucket,
    window: StrategyHypothesisMetricWindow,
) -> tuple[int, float, float, float, str]:
    window_started = _utc(window.window_started_at)
    window_ended = _utc(window.window_ended_at)
    bucket_started = _utc(bucket.bucket_started_at)
    bucket_ended = _utc(bucket.bucket_ended_at)
    if window_started is None or window_ended is None or bucket_started is None or bucket_ended is None:
        return (1, float('inf'), 0.0, 0.0, str(bucket.id))
    exact_boundary_miss = int(bucket_started != window_started or bucket_ended != window_ended)
    bucket_duration = max(0.0, (bucket_ended - bucket_started).total_seconds())
    window_duration = max(0.0, (window_ended - window_started).total_seconds())
    overcoverage_seconds = max(0.0, bucket_duration - window_duration)
    created_at = _utc(bucket.created_at)
    return (
        exact_boundary_miss,
        overcoverage_seconds,
        -bucket_ended.timestamp(),
        -created_at.timestamp() if created_at is not None else 0.0,
        str(bucket.id),
    )

def _runtime_ledger_bucket_is_promotion_grade(
    bucket: StrategyRuntimeLedgerBucket,
) -> bool:
    payload = _runtime_ledger_bucket_promotion_payload(bucket)
    blockers = _runtime_ledger_bucket_existing_blockers(bucket)
    if blockers:
        return False
    if runtime_ledger_promotion_source_authority_blockers(payload):
        return False
    if is_non_promotion_grade_runtime_cost_basis(payload.get('cost_basis')):
        return False
    if cost_basis_counts_have_non_promotion_grade_costs(payload.get('cost_basis_counts')):
        return False
    return (
        _as_text(payload.get('ledger_schema_version')) in _RUNTIME_LEDGER_BUCKET_SCHEMAS
        and _as_text(payload.get('pnl_basis')) == POST_COST_PNL_BASIS
        and _safe_int(payload.get('fill_count')) > 0
        and _safe_int(payload.get('decision_count')) > 0
        and _safe_int(payload.get('submitted_order_count')) > 0
        and _safe_int(payload.get('closed_trade_count')) > 0
        and _safe_int(payload.get('open_position_count')) == 0
        and _safe_float(payload.get('filled_notional')) > 0
        and _positive_hash_count(payload.get('execution_policy_hash_counts'))
        and _positive_hash_count(payload.get('cost_model_hash_counts'))
        and _positive_hash_count(payload.get('lineage_hash_counts'))
    )

def _runtime_ledger_bucket_summary(
    rows: Sequence[StrategyRuntimeLedgerBucket],
) -> dict[str, Any]:
    totals = _runtime_ledger_bucket_totals(rows)
    source_authority = _runtime_ledger_source_authority_summary(rows)
    expectancy_bps = (
        float((totals.net_pnl / totals.filled_notional) * Decimal('10000')) if totals.filled_notional > 0 else 0.0
    )
    daily_summary = _runtime_ledger_daily_summary(rows)
    return {
        'runtime_ledger_bucket_count': len(rows),
        'runtime_ledger_fill_count': sum(max(0, _safe_int(row.fill_count)) for row in rows),
        'runtime_ledger_submitted_order_count': sum(max(0, _safe_int(row.submitted_order_count)) for row in rows),
        'runtime_ledger_closed_trade_count': totals.closed_trade_count,
        'runtime_ledger_closed_round_trip_count': totals.closed_trade_count,
        'runtime_ledger_open_position_count': totals.open_position_count,
        'runtime_ledger_filled_notional': float(totals.filled_notional),
        'runtime_ledger_cost_amount': float(totals.cost_amount),
        'runtime_ledger_cost_basis_counts': source_authority.cost_basis_counts,
        'runtime_ledger_cost_model_hash_count': sum(
            len(_as_dict(row.cost_model_hash_counts)) for row in rows
        ),
        'runtime_ledger_net_strategy_pnl_after_costs': float(totals.net_pnl),
        'runtime_ledger_post_cost_expectancy_bps': expectancy_bps,
        'runtime_ledger_schema_versions': _runtime_ledger_schema_versions(rows),
        'runtime_ledger_source_authority_bucket_count': source_authority.bucket_count,
        'runtime_ledger_source_authority_blockers': source_authority.blockers,
        'runtime_ledger_authority_blockers': [],
        'runtime_ledger_profit_distance_readback': build_runtime_ledger_profit_distance_readback(
            summary={
                **daily_summary,
                'runtime_ledger_filled_notional': str(totals.filled_notional),
            },
            candidate_id=_as_text(rows[0].candidate_id) if rows else None,
            observed_stage=_as_text(rows[0].observed_stage) if rows else None,
            runtime_ledger_bucket_count=len(rows),
            evidence_grade_runtime_ledger_bucket_count=sum(
                1 for row in rows if _runtime_ledger_bucket_is_promotion_grade(row)
            ),
            source_authority_bucket_count=source_authority.bucket_count,
            source_authority_blockers=source_authority.blockers,
            total_filled_notional=totals.filled_notional,
            total_closed_trade_count=totals.closed_trade_count,
            open_position_count=totals.open_position_count,
        ),
        **daily_summary,
        'db_row_refs': [str(row.id) for row in rows],
    }

def _runtime_ledger_bucket_totals(
    rows: Sequence[StrategyRuntimeLedgerBucket],
) -> _RuntimeLedgerBucketTotals:
    return _RuntimeLedgerBucketTotals(
        filled_notional=sum((row.filled_notional for row in rows), Decimal('0')),
        net_pnl=sum((row.net_strategy_pnl_after_costs for row in rows), Decimal('0')),
        cost_amount=sum((row.cost_amount for row in rows), Decimal('0')),
        closed_trade_count=sum(max(0, _safe_int(row.closed_trade_count)) for row in rows),
        open_position_count=sum(max(0, _safe_int(row.open_position_count)) for row in rows),
    )

def _runtime_ledger_source_authority_summary(
    rows: Sequence[StrategyRuntimeLedgerBucket],
) -> _RuntimeLedgerSourceAuthoritySummary:
    cost_basis_counts: dict[str, int] = {}
    blockers: list[str] = []
    bucket_count = 0
    for row in rows:
        payload = _runtime_ledger_bucket_promotion_payload(row)
        row_source_authority_blockers = runtime_ledger_promotion_source_authority_blockers(payload)
        if not row_source_authority_blockers:
            bucket_count += 1
        for cost_basis, count in _as_dict(payload.get('cost_basis_counts')).items():
            key = _as_text(cost_basis)
            if key is None:
                continue
            cost_basis_counts[key] = cost_basis_counts.get(key, 0) + _safe_int(count)
        for blocker in row_source_authority_blockers:
            if blocker not in blockers:
                blockers.append(blocker)
    return _RuntimeLedgerSourceAuthoritySummary(
        bucket_count=bucket_count,
        blockers=blockers,
        cost_basis_counts=cost_basis_counts,
    )

def _runtime_ledger_schema_versions(
    rows: Sequence[StrategyRuntimeLedgerBucket],
) -> list[str]:
    return sorted(
        {
            schema_version
            for row in rows
            if (schema_version := _as_text(row.ledger_schema_version)) is not None
        }
    )

def _runtime_ledger_daily_summary(
    rows: Sequence[StrategyRuntimeLedgerBucket],
) -> dict[str, Any]:
    persisted = _runtime_ledger_persisted_daily_summary(rows)
    if persisted:
        return persisted
    series = _runtime_ledger_daily_series(rows)
    day_count = len(series.trading_days)
    daily_net_values = [series.net_pnl_by_day[day] for day in series.trading_days]
    total_daily_net_pnl = sum(daily_net_values, Decimal('0'))
    total_filled_notional = sum(
        (series.filled_notional_by_day[day] for day in series.trading_days),
        Decimal('0'),
    )
    mean_daily_net_pnl = total_daily_net_pnl / Decimal(day_count) if day_count > 0 else Decimal('0')
    avg_daily_filled_notional = total_filled_notional / Decimal(day_count) if day_count > 0 else Decimal('0')
    return {
        'runtime_ledger_observed_trading_day_count': day_count,
        'runtime_ledger_net_pnl_by_trading_day': {day: str(series.net_pnl_by_day[day]) for day in series.trading_days},
        'runtime_ledger_mean_daily_net_pnl_after_costs': str(mean_daily_net_pnl),
        'runtime_ledger_median_daily_net_pnl_after_costs': str(_median_decimal(daily_net_values)),
        'runtime_ledger_p10_daily_net_pnl_after_costs': str(_p10_decimal(daily_net_values)),
        'runtime_ledger_worst_day_net_pnl_after_costs': str(
            min(daily_net_values) if daily_net_values else Decimal('0')
        ),
        'runtime_ledger_max_intraday_drawdown': str(series.max_intraday_drawdown),
        'runtime_ledger_avg_daily_filled_notional': str(avg_daily_filled_notional),
        'runtime_ledger_filled_notional_by_trading_day': {
            day: str(series.filled_notional_by_day[day]) for day in series.trading_days
        },
        'runtime_ledger_closed_trade_count_by_day': {
            day: series.closed_trade_count_by_day[day] for day in series.trading_days
        },
    }

def _runtime_ledger_daily_series(
    rows: Sequence[StrategyRuntimeLedgerBucket],
) -> _RuntimeLedgerDailySeries:
    trading_days = sorted({_runtime_ledger_trading_day_key(row.bucket_started_at) for row in rows})
    net_pnl_by_day = {day: Decimal('0') for day in trading_days}
    filled_notional_by_day = {day: Decimal('0') for day in trading_days}
    closed_trade_count_by_day = {day: 0 for day in trading_days}
    cumulative_by_day = {day: Decimal('0') for day in trading_days}
    peak_by_day = {day: Decimal('0') for day in trading_days}
    max_intraday_drawdown = Decimal('0')
    for row in sorted(rows, key=lambda item: item.bucket_started_at or item.created_at):
        day = _runtime_ledger_trading_day_key(row.bucket_started_at)
        net_pnl = row.net_strategy_pnl_after_costs or Decimal('0')
        net_pnl_by_day[day] += net_pnl
        filled_notional_by_day[day] += row.filled_notional or Decimal('0')
        closed_trade_count_by_day[day] += max(0, _safe_int(row.closed_trade_count))
        cumulative_by_day[day] += net_pnl
        if cumulative_by_day[day] > peak_by_day[day]:
            peak_by_day[day] = cumulative_by_day[day]
        drawdown = peak_by_day[day] - cumulative_by_day[day]
        if drawdown > max_intraday_drawdown:
            max_intraday_drawdown = drawdown
    return _RuntimeLedgerDailySeries(
        trading_days=trading_days,
        net_pnl_by_day=net_pnl_by_day,
        filled_notional_by_day=filled_notional_by_day,
        closed_trade_count_by_day=closed_trade_count_by_day,
        max_intraday_drawdown=max_intraday_drawdown,
    )

def _runtime_ledger_persisted_daily_summary(
    rows: Sequence[StrategyRuntimeLedgerBucket],
) -> dict[str, Any]:
    selected: dict[str, Any] = {}
    selected_day_count = -1
    for row in rows:
        payload = _as_dict(row.payload_json)
        summary = _as_dict(payload.get('runtime_ledger_daily_summary'))
        if not summary:
            continue
        day_count = _safe_int(summary.get('runtime_ledger_observed_trading_day_count'))
        if day_count > selected_day_count:
            selected = summary
            selected_day_count = day_count
    return dict(selected)

def _runtime_ledger_bucket_refs_for_windows(
    session: Session,
    rows: Sequence[StrategyHypothesisMetricWindow],
) -> tuple[list[StrategyHypothesisMetricWindow], list[StrategyRuntimeLedgerBucket], list[str]]:
    hypothesis_ids = sorted(
        {hypothesis_id for row in rows if (hypothesis_id := _as_text(row.hypothesis_id)) is not None}
    )
    run_ids = sorted({run_id for row in rows if (run_id := _as_text(row.run_id)) is not None})
    if not hypothesis_ids or not run_ids:
        return [], [], [str(row.id) for row in rows]
    buckets = list(
        session.execute(
            select(StrategyRuntimeLedgerBucket)
            .where(StrategyRuntimeLedgerBucket.hypothesis_id.in_(hypothesis_ids))
            .where(StrategyRuntimeLedgerBucket.run_id.in_(run_ids))
            .order_by(
                StrategyRuntimeLedgerBucket.bucket_ended_at.desc(),
                StrategyRuntimeLedgerBucket.created_at.desc(),
            )
        ).scalars()
    )
    backed_windows: list[StrategyHypothesisMetricWindow] = []
    matched_buckets: list[StrategyRuntimeLedgerBucket] = []
    unbacked_window_refs: list[str] = []
    used_bucket_ids: set[str] = set()
    for window in rows:
        candidates = [
            bucket
            for bucket in buckets
            if str(bucket.id) not in used_bucket_ids
            and _runtime_ledger_bucket_matches_window(bucket, window)
            and _runtime_ledger_bucket_is_promotion_grade(bucket)
        ]
        matched_bucket = (
            min(candidates, key=lambda bucket: _runtime_ledger_bucket_window_match_key(bucket, window))
            if candidates
            else None
        )
        if matched_bucket is None:
            unbacked_window_refs.append(str(window.id))
            continue
        used_bucket_ids.add(str(matched_bucket.id))
        backed_windows.append(window)
        matched_buckets.append(matched_bucket)
    return backed_windows, matched_buckets, unbacked_window_refs

def _window_gate_summary(
    rows: Sequence[StrategyHypothesisMetricWindow],
) -> dict[str, Any]:
    metrics = _window_weighted_metrics(rows)
    return {
        'market_session_count': sum(max(0, int(row.market_session_count or 0)) for row in rows),
        'window_count': len(rows),
        'decision_alignment_ratio': metrics.alignment_ratio,
        'avg_abs_slippage_bps': metrics.avg_slippage_bps,
        'avg_post_cost_expectancy_bps': metrics.avg_expectancy_bps,
        'latest_three_within_budget': _latest_three_within_budget(rows),
        'continuity_ok': all(bool(row.continuity_ok) for row in rows),
        'drift_ok': all(bool(row.drift_ok) for row in rows),
        'dependency_allow': all((_as_text(row.dependency_quorum_decision) or 'unknown') == 'allow' for row in rows),
        'hypothesis_ids': sorted({row.hypothesis_id for row in rows}),
        'db_row_refs': [str(row.id) for row in rows],
    }

def _window_weighted_metrics(
    rows: Sequence[StrategyHypothesisMetricWindow],
) -> _WindowWeightedMetrics:
    weighted_alignment = 0.0
    weighted_slippage = 0.0
    weighted_expectancy = 0.0
    total_weight = 0.0
    for row in rows:
        weight = float(max(1, int(row.market_session_count or 0)))
        total_weight += weight
        weighted_alignment += _safe_float(row.decision_alignment_ratio) * weight
        weighted_slippage += _safe_float(row.avg_abs_slippage_bps) * weight
        weighted_expectancy += _safe_float(row.post_cost_expectancy_bps) * weight
    return _WindowWeightedMetrics(
        alignment_ratio=(weighted_alignment / total_weight) if total_weight > 0 else 0.0,
        avg_slippage_bps=(weighted_slippage / total_weight) if total_weight > 0 else 0.0,
        avg_expectancy_bps=(weighted_expectancy / total_weight) if total_weight > 0 else 0.0,
    )

def _latest_three_within_budget(
    rows: Sequence[StrategyHypothesisMetricWindow],
) -> bool:
    latest_rows = sorted(
        rows,
        key=lambda row: (
            row.window_ended_at or row.created_at,
            row.created_at,
        ),
        reverse=True,
    )
    latest_three = latest_rows[:3]
    if not latest_three:
        return False
    return all(_safe_float(row.avg_abs_slippage_bps) <= _safe_float(row.slippage_budget_bps) for row in latest_three)

def _evaluate_empirical_jobs_gate(
    *,
    empirical_jobs_status: Mapping[str, Any],
    empirical_rows: Mapping[str, VNextEmpiricalJobRun],
) -> dict[str, Any]:
    jobs = _as_dict(empirical_jobs_status.get('jobs'))
    missing = _missing_or_ineligible_empirical_jobs(jobs)
    status = TRACE_STATUS_SATISFIED if not missing else TRACE_STATUS_BLOCKED
    blocked_reason = None if not missing else f'empirical_jobs_missing_or_ineligible:{",".join(sorted(missing))}'
    evidence = _empirical_jobs_gate_evidence(empirical_rows)
    status, blocked_reason = _empirical_jobs_consistency_status(
        status=status,
        blocked_reason=blocked_reason,
        evidence=evidence,
    )
    return {
        'status': status,
        'blocked_reason': blocked_reason,
        'dataset_snapshot_ref': evidence.dataset_snapshot_ref,
        'candidate_id': evidence.candidate_id,
        'artifact_refs': sorted(set(evidence.artifact_refs)),
        'db_row_refs': evidence.db_row_refs,
    }

def _missing_or_ineligible_empirical_jobs(
    jobs: Mapping[str, Any],
) -> list[str]:
    return [
        job_type
        for job_type in EMPIRICAL_JOB_TYPES
        if job_type not in jobs
        or not bool(_as_dict(jobs.get(job_type)).get('promotion_authority_eligible'))
        or _as_text(_as_dict(jobs.get(job_type)).get('authority')) != 'empirical'
        or not _as_text(_as_dict(jobs.get(job_type)).get('dataset_snapshot_ref'))
        or bool(_as_dict(jobs.get(job_type)).get('stale', False))
    ]

def _empirical_jobs_gate_evidence(
    empirical_rows: Mapping[str, VNextEmpiricalJobRun],
) -> _EmpiricalJobsGateEvidence:
    dataset_snapshot_ref = None
    candidate_id = None
    artifact_refs: list[str] = []
    db_row_refs: dict[str, Any] = {}
    dataset_refs: set[str] = set()
    candidate_ids: set[str] = set()
    for job_type, row in empirical_rows.items():
        if dataset_snapshot_ref is None:
            dataset_snapshot_ref = row.dataset_snapshot_ref
        if candidate_id is None:
            candidate_id = row.candidate_id
        dataset_ref = _as_text(row.dataset_snapshot_ref)
        if dataset_ref is not None:
            dataset_refs.add(dataset_ref)
        empirical_candidate = _as_text(row.candidate_id)
        if empirical_candidate is not None:
            candidate_ids.add(empirical_candidate)
        artifact_refs.extend(str(item) for item in cast(list[object], row.artifact_refs or []) if str(item).strip())
        db_row_refs[job_type] = {
            'row_id': str(row.id),
            'job_run_id': row.job_run_id,
        }
    return _EmpiricalJobsGateEvidence(
        dataset_snapshot_ref=dataset_snapshot_ref,
        candidate_id=candidate_id,
        artifact_refs=artifact_refs,
        db_row_refs=db_row_refs,
        dataset_refs=dataset_refs,
        candidate_ids=candidate_ids,
    )

def _empirical_jobs_consistency_status(
    *,
    status: str,
    blocked_reason: str | None,
    evidence: _EmpiricalJobsGateEvidence,
) -> tuple[str, str | None]:
    if status == TRACE_STATUS_SATISFIED and len(evidence.dataset_refs) != 1:
        status = TRACE_STATUS_BLOCKED
        blocked_reason = 'empirical_dataset_snapshot_ref_mismatch'
    if status == TRACE_STATUS_SATISFIED and len(evidence.candidate_ids) != 1:
        status = TRACE_STATUS_BLOCKED
        blocked_reason = 'empirical_candidate_id_mismatch'
    return status, blocked_reason

def _trace_gate_refs_from_gate(
    gate: Mapping[str, Any],
    *,
    artifact_refs: Sequence[str] | None = None,
    db_row_refs: Mapping[str, Any] | None = None,
    dataset_snapshot_ref: Any = None,
    candidate_id: Any = None,
) -> _TraceGateRefs:
    return _TraceGateRefs(
        artifact_refs=list(artifact_refs) if artifact_refs is not None else cast(list[str], gate.get('artifact_refs') or []),
        db_row_refs=dict(db_row_refs) if db_row_refs is not None else {},
        dataset_snapshot_ref=gate.get('dataset_snapshot_ref') if dataset_snapshot_ref is None else dataset_snapshot_ref,
        candidate_id=gate.get('candidate_id') if candidate_id is None else candidate_id,
    )

def _trace_gate_result(
    *,
    status: str,
    blocked_reason: str | None,
    refs: _TraceGateRefs,
) -> dict[str, Any]:
    return {
        'status': status,
        'blocked_reason': blocked_reason,
        'artifact_refs': refs.artifact_refs,
        'db_row_refs': refs.db_row_refs,
        'dataset_snapshot_ref': refs.dataset_snapshot_ref,
        'candidate_id': refs.candidate_id,
    }

def _blocked_trace_gate_result(
    blocked_reason: str,
    refs: _TraceGateRefs,
) -> dict[str, Any]:
    return _trace_gate_result(status=TRACE_STATUS_BLOCKED, blocked_reason=blocked_reason, refs=refs)

def _satisfied_trace_gate_result(
    refs: _TraceGateRefs,
) -> dict[str, Any]:
    return _trace_gate_result(status=TRACE_STATUS_SATISFIED, blocked_reason=None, refs=refs)

def _evaluate_paper_gate(
    *,
    empirical_gate: Mapping[str, Any],
    full_day_row: VNextCompletionGateResult | None,
    empirical_rows: Mapping[str, VNextEmpiricalJobRun],
    gate_definition: Mapping[str, Any] | None,
) -> dict[str, Any]:
    precondition_result = _paper_gate_precondition_result(empirical_gate, full_day_row)
    if precondition_result is not None:
        return precondition_result
    full_day_ref = {'simulation_full_day_coverage': str(full_day_row.id)}
    refs = _trace_gate_refs_from_gate(empirical_gate, db_row_refs=full_day_ref)
    identity_result = _paper_gate_identity_result(empirical_gate, full_day_row)
    if identity_result is not None:
        return identity_result
    acceptance = _paper_gate_acceptance(full_day_row)
    if _paper_gate_has_insufficient_decisions(acceptance, gate_definition):
        return _blocked_trace_gate_result('insufficient_simulated_decisions', refs)
    benchmark_row = empirical_rows.get('benchmark_parity')
    if benchmark_row is None:
        return _blocked_trace_gate_result('missing_benchmark_parity_row', refs)
    refs = _trace_gate_refs_from_gate(
        empirical_gate,
        db_row_refs={**full_day_ref, 'benchmark_parity': str(benchmark_row.id)},
    )
    blocked_reason = _paper_gate_benchmark_blocked_reason(benchmark_row, acceptance)
    if blocked_reason is not None:
        return _blocked_trace_gate_result(blocked_reason, refs)
    return _satisfied_trace_gate_result(_paper_gate_refs_with_fill_price_artifact(refs, acceptance))

def _paper_gate_precondition_result(
    empirical_gate: Mapping[str, Any],
    full_day_row: VNextCompletionGateResult | None,
) -> dict[str, Any] | None:
    refs = _trace_gate_refs_from_gate(empirical_gate, artifact_refs=[], db_row_refs={})
    if empirical_gate.get('status') != TRACE_STATUS_SATISFIED:
        return _blocked_trace_gate_result('empirical_jobs_not_satisfied', refs)
    if full_day_row is None:
        return _blocked_trace_gate_result('missing_full_day_simulation_trace', refs)
    return None

def _paper_gate_identity_result(
    empirical_gate: Mapping[str, Any],
    full_day_row: VNextCompletionGateResult,
) -> dict[str, Any] | None:
    candidate_id = _as_text(empirical_gate.get('candidate_id'))
    dataset_snapshot_ref = _as_text(empirical_gate.get('dataset_snapshot_ref'))
    refs = _trace_gate_refs_from_gate(
        empirical_gate,
        db_row_refs={'simulation_full_day_coverage': str(full_day_row.id)},
        dataset_snapshot_ref=dataset_snapshot_ref,
        candidate_id=candidate_id,
    )
    if candidate_id is not None and full_day_row.candidate_id != candidate_id:
        return _blocked_trace_gate_result('full_day_candidate_id_mismatch', refs)
    if dataset_snapshot_ref is not None and full_day_row.dataset_snapshot_ref != dataset_snapshot_ref:
        return _blocked_trace_gate_result('full_day_dataset_snapshot_ref_mismatch', refs)
    return None

def _paper_gate_acceptance(
    full_day_row: VNextCompletionGateResult,
) -> dict[str, Any]:
    return _as_dict(_as_dict(_as_dict(full_day_row.details_json).get('gate_result')).get('acceptance_snapshot'))

def _paper_gate_has_insufficient_decisions(
    acceptance: Mapping[str, Any],
    gate_definition: Mapping[str, Any] | None,
) -> bool:
    return _safe_int(acceptance.get('trade_decisions')) < _policy_int(
        _gate_policy_parameters(gate_definition),
        'min_simulated_decisions',
        default=500,
    )

def _paper_gate_benchmark_blocked_reason(
    benchmark_row: VNextEmpiricalJobRun,
    acceptance: Mapping[str, Any],
) -> str | None:
    missing_families = _benchmark_missing_families(benchmark_row)
    if missing_families:
        return f'benchmark_family_coverage_incomplete:{",".join(str(item) for item in missing_families)}'
    fill_price_status = _as_text(acceptance.get('fill_price_error_budget_status')) or 'missing'
    if fill_price_status == 'within_budget':
        return None
    return {
        'missing': 'fill_price_error_budget_not_recorded',
        'pending_runtime_observation': 'fill_price_error_budget_pending_runtime_observation',
        'out_of_budget': 'fill_price_error_budget_exceeded',
    }.get(fill_price_status, f'fill_price_error_budget_{fill_price_status}')

def _benchmark_missing_families(
    benchmark_row: VNextEmpiricalJobRun,
) -> list[Any]:
    benchmark_payload = _as_dict(benchmark_row.payload_json)
    return _as_list(_as_dict(benchmark_payload.get('lineage')).get('missing_families'))

def _paper_gate_refs_with_fill_price_artifact(
    refs: _TraceGateRefs,
    acceptance: Mapping[str, Any],
) -> _TraceGateRefs:
    fill_price_ref = _as_text(acceptance.get('fill_price_error_budget_artifact_ref'))
    artifact_refs = refs.artifact_refs
    if fill_price_ref and fill_price_ref not in artifact_refs:
        artifact_refs = [*artifact_refs, fill_price_ref]
    return _TraceGateRefs(
        artifact_refs=artifact_refs,
        db_row_refs=refs.db_row_refs,
        dataset_snapshot_ref=refs.dataset_snapshot_ref,
        candidate_id=refs.candidate_id,
    )

def _evaluate_live_canary_gate(
    *,
    paper_gate: Mapping[str, Any],
    paper_rows: Sequence[StrategyHypothesisMetricWindow],
    allowed_promotion_decision_keys: set[_PromotionDecisionKey],
    denied_promotion_decision_keys: set[_PromotionDecisionKey],
    gate_definition: Mapping[str, Any] | None,
) -> dict[str, Any]:
    if paper_gate.get('status') != TRACE_STATUS_SATISFIED:
        return {
            'status': TRACE_STATUS_BLOCKED,
            'blocked_reason': 'paper_gate_not_satisfied',
            'artifact_refs': cast(list[str], paper_gate.get('artifact_refs') or []),
            'db_row_refs': {},
            'dataset_snapshot_ref': paper_gate.get('dataset_snapshot_ref'),
            'candidate_id': paper_gate.get('candidate_id'),
        }
    candidate_id = _as_text(paper_gate.get('candidate_id'))
    candidate_rows = [
        row
        for row in paper_rows
        if candidate_id is None or row.candidate_id == candidate_id
        if (_as_text(row.evidence_provenance) == 'paper_runtime_observed')
        and (_as_text(row.evidence_maturity) == 'empirically_validated')
    ]
    promotion_decision_blocked_reason = _promotion_decision_blocked_reason(
        candidate_rows,
        allowed_keys=allowed_promotion_decision_keys,
        denied_keys=denied_promotion_decision_keys,
    )
    if promotion_decision_blocked_reason is not None:
        return {
            'status': TRACE_STATUS_BLOCKED,
            'blocked_reason': promotion_decision_blocked_reason,
            'artifact_refs': cast(list[str], paper_gate.get('artifact_refs') or []),
            'db_row_refs': {'hypothesis_metric_windows': [str(row.id) for row in candidate_rows]},
            'dataset_snapshot_ref': paper_gate.get('dataset_snapshot_ref'),
            'candidate_id': paper_gate.get('candidate_id'),
        }
    qualifying = _windows_with_allowed_promotion_decisions(
        candidate_rows,
        allowed_keys=allowed_promotion_decision_keys,
    )
    summary = _window_gate_summary(qualifying)
    min_market_session_samples = _manifest_runtime_session_threshold(
        candidate_id=candidate_id,
        rows=qualifying,
        policy_parameters=_gate_policy_parameters(gate_definition),
        fallback_key='fallback_min_market_session_samples',
        default=40,
        manifest_attr='min_sample_count_for_live_canary',
    )
    if summary['market_session_count'] < min_market_session_samples:
        blocked_reason = 'insufficient_paper_runtime_sessions'
    elif summary['decision_alignment_ratio'] < 0.95:
        blocked_reason = 'shadow_live_alignment_below_threshold'
    elif not summary['dependency_allow']:
        blocked_reason = 'dependency_quorum_not_allow'
    elif not summary['continuity_ok']:
        blocked_reason = 'continuity_gate_failed'
    elif summary['avg_abs_slippage_bps'] > max(
        (_safe_float(row.slippage_budget_bps) for row in qualifying),
        default=0.0,
    ):
        blocked_reason = 'slippage_budget_exceeded'
    else:
        blocked_reason = None
    return {
        'status': TRACE_STATUS_SATISFIED if blocked_reason is None else TRACE_STATUS_BLOCKED,
        'blocked_reason': blocked_reason,
        'artifact_refs': cast(list[str], paper_gate.get('artifact_refs') or []),
        'db_row_refs': {'hypothesis_metric_windows': summary['db_row_refs']},
        'dataset_snapshot_ref': paper_gate.get('dataset_snapshot_ref'),
        'candidate_id': paper_gate.get('candidate_id'),
    }

def _evaluate_live_scale_gate(
    *,
    session: Session,
    canary_gate: Mapping[str, Any],
    live_rows: Sequence[StrategyHypothesisMetricWindow],
    allowed_promotion_decision_keys: set[_PromotionDecisionKey],
    denied_promotion_decision_keys: set[_PromotionDecisionKey],
    gate_definition: Mapping[str, Any] | None,
) -> dict[str, Any]:
    if canary_gate.get('status') != TRACE_STATUS_SATISFIED:
        return _blocked_trace_gate_result('live_canary_not_satisfied', _trace_gate_refs_from_gate(canary_gate))
    candidate_id = _as_text(canary_gate.get('candidate_id'))
    candidate_rows = _runtime_observed_rows_for_candidate(
        live_rows,
        candidate_id=candidate_id,
        evidence_provenance='live_runtime_observed',
    )
    promotion_decision_blocked_reason = _promotion_decision_blocked_reason(
        candidate_rows,
        allowed_keys=allowed_promotion_decision_keys,
        denied_keys=denied_promotion_decision_keys,
    )
    if promotion_decision_blocked_reason is not None:
        return _promotion_decision_blocked_gate_result(
            canary_gate,
            promotion_decision_blocked_reason,
            candidate_rows,
        )
    qualifying = _windows_with_allowed_promotion_decisions(
        candidate_rows,
        allowed_keys=allowed_promotion_decision_keys,
    )
    runtime_summary = _live_scale_runtime_summary(session, qualifying)
    min_market_session_samples = _manifest_runtime_session_threshold(
        candidate_id=candidate_id,
        rows=runtime_summary.backed_windows,
        policy_parameters=_gate_policy_parameters(gate_definition),
        fallback_key='fallback_min_market_session_samples',
        default=120,
        manifest_attr='min_sample_count_for_scale_up',
    )
    blocked_reason = _live_scale_blocked_reason(runtime_summary.window_summary, min_market_session_samples)
    return _live_scale_gate_result(
        canary_gate=canary_gate,
        runtime_summary=runtime_summary,
        blocked_reason=blocked_reason,
    )

def _runtime_observed_rows_for_candidate(
    rows: Sequence[StrategyHypothesisMetricWindow],
    *,
    candidate_id: str | None,
    evidence_provenance: str,
) -> list[StrategyHypothesisMetricWindow]:
    return [
        row
        for row in rows
        if candidate_id is None or row.candidate_id == candidate_id
        if (_as_text(row.evidence_provenance) == evidence_provenance)
        and (_as_text(row.evidence_maturity) == 'empirically_validated')
    ]

def _promotion_decision_blocked_gate_result(
    parent_gate: Mapping[str, Any],
    blocked_reason: str,
    candidate_rows: Sequence[StrategyHypothesisMetricWindow],
) -> dict[str, Any]:
    return _blocked_trace_gate_result(
        blocked_reason,
        _trace_gate_refs_from_gate(
            parent_gate,
            db_row_refs={'hypothesis_metric_windows': [str(row.id) for row in candidate_rows]},
        ),
    )

def _live_scale_runtime_summary(
    session: Session,
    qualifying: Sequence[StrategyHypothesisMetricWindow],
) -> _LiveScaleRuntimeSummary:
    ledger_qualifying, runtime_ledger_buckets, unbacked_window_refs = _runtime_ledger_bucket_refs_for_windows(
        session,
        qualifying,
    )
    window_summary = _window_gate_summary(ledger_qualifying)
    ledger_summary = _runtime_ledger_bucket_summary(runtime_ledger_buckets)
    window_summary['avg_post_cost_expectancy_bps'] = ledger_summary['runtime_ledger_post_cost_expectancy_bps']
    return _LiveScaleRuntimeSummary(
        window_summary=window_summary,
        ledger_summary=ledger_summary,
        unbacked_window_refs=unbacked_window_refs,
        backed_windows=ledger_qualifying,
    )

def _live_scale_blocked_reason(
    summary: Mapping[str, Any],
    min_market_session_samples: int,
) -> str | None:
    blocked_rules = (
        (summary['window_count'] == 0, 'runtime_ledger_profit_proof_missing'),
        (summary['market_session_count'] < min_market_session_samples, 'insufficient_live_runtime_sessions'),
        (summary['window_count'] < 10, 'insufficient_live_runtime_windows'),
        (summary['avg_post_cost_expectancy_bps'] <= 0, 'post_cost_expectancy_non_positive'),
        (not summary['latest_three_within_budget'], 'slippage_budget_not_stable'),
        (not summary['continuity_ok'], 'continuity_gate_failed'),
        (not summary['drift_ok'], 'drift_gate_failed'),
        (not summary['dependency_allow'], 'dependency_quorum_not_allow'),
    )
    for is_blocked, reason in blocked_rules:
        if is_blocked:
            return reason
    return None

def _live_scale_gate_result(
    *,
    canary_gate: Mapping[str, Any],
    runtime_summary: _LiveScaleRuntimeSummary,
    blocked_reason: str | None,
) -> dict[str, Any]:
    summary = runtime_summary.window_summary
    ledger_summary = runtime_summary.ledger_summary
    return {
        'status': TRACE_STATUS_SATISFIED if blocked_reason is None else TRACE_STATUS_BLOCKED,
        'blocked_reason': blocked_reason,
        'artifact_refs': cast(list[str], canary_gate.get('artifact_refs') or []),
        'db_row_refs': {
            'hypothesis_metric_windows': summary['db_row_refs'],
            'strategy_runtime_ledger_buckets': ledger_summary['db_row_refs'],
            'runtime_ledger_unbacked_hypothesis_metric_windows': runtime_summary.unbacked_window_refs,
        },
        'runtime_ledger_summary': ledger_summary,
        'dataset_snapshot_ref': canary_gate.get('dataset_snapshot_ref'),
        'candidate_id': canary_gate.get('candidate_id'),
    }


runtime_ledger_bucket_matches_window = _runtime_ledger_bucket_matches_window
runtime_ledger_bucket_refs_for_windows = _runtime_ledger_bucket_refs_for_windows
runtime_ledger_bucket_summary = _runtime_ledger_bucket_summary
runtime_ledger_daily_summary = _runtime_ledger_daily_summary

__all__ = [name for name in globals() if not name.startswith("__")]
