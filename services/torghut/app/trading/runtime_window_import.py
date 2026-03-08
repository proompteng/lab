"""Import observed runtime windows into the hypothesis governance ledger."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Any, Mapping, Sequence
from zoneinfo import ZoneInfo

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..models import (
    StrategyCapitalAllocation,
    StrategyHypothesis,
    StrategyHypothesisMetricWindow,
    StrategyHypothesisVersion,
    StrategyPromotionDecision,
)
from .hypotheses import HypothesisManifest, HypothesisRegistryLoadResult, load_hypothesis_registry

US_EQUITIES_REGULAR_TIMEZONE = 'America/New_York'
US_EQUITIES_REGULAR_OPEN = time(hour=9, minute=30)
US_EQUITIES_REGULAR_CLOSE = time(hour=16, minute=0)


@dataclass(frozen=True)
class ObservedRuntimeBucket:
    window_started_at: datetime
    window_ended_at: datetime
    market_session_count: int
    decision_count: int
    trade_count: int
    order_count: int
    decision_alignment_ratio: Decimal
    avg_abs_slippage_bps: Decimal
    post_cost_expectancy_bps: Decimal
    continuity_ok: bool
    drift_ok: bool
    dependency_quorum_decision: str
    payload_json: dict[str, Any]


@dataclass(frozen=True)
class _NormalizedTcaRow:
    computed_at: datetime
    abs_slippage_bps: Decimal
    post_cost_expectancy_bps: Decimal


def _utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _decimal(value: Any, *, default: str = '0') -> Decimal:
    if isinstance(value, Decimal):
        return value
    if value is None:
        return Decimal(default)
    return Decimal(str(value))


def _strategy_family_matches(
    *,
    manifest: HypothesisManifest,
    strategy_family: str | None,
) -> bool:
    if strategy_family is None:
        return True
    normalized_manifest = manifest.strategy_family.replace('-', '_').lower()
    normalized_input = strategy_family.replace('-', '_').lower()
    if normalized_manifest == normalized_input:
        return True
    return normalized_input in normalized_manifest or normalized_manifest in normalized_input


def resolve_hypothesis_manifest(
    *,
    hypothesis_id: str,
    strategy_family: str | None = None,
) -> tuple[HypothesisRegistryLoadResult, HypothesisManifest]:
    registry = load_hypothesis_registry(raise_on_error=True)
    manifest = next((item for item in registry.items if item.hypothesis_id == hypothesis_id), None)
    if manifest is None:
        raise RuntimeError(f'hypothesis_manifest_not_found:{hypothesis_id}')
    if not _strategy_family_matches(manifest=manifest, strategy_family=strategy_family):
        raise RuntimeError(
            f'hypothesis_strategy_family_mismatch:{hypothesis_id}:{manifest.strategy_family}:{strategy_family}'
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
        raise RuntimeError('bucket_minutes_must_be_positive')
    if sample_minutes <= 0:
        raise RuntimeError('sample_minutes_must_be_positive')
    start_utc = _utc(window_start)
    end_utc = _utc(window_end)
    if end_utc <= start_utc:
        raise RuntimeError('window_end_must_be_after_window_start')

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
        session_start_local = datetime.combine(current_day, US_EQUITIES_REGULAR_OPEN, tzinfo=zone)
        session_end_local = datetime.combine(current_day, US_EQUITIES_REGULAR_CLOSE, tzinfo=zone)
        bucket_start = max(start_utc, session_start_local.astimezone(timezone.utc))
        session_end = min(end_utc, session_end_local.astimezone(timezone.utc))
        while bucket_start < session_end:
            bucket_end = min(bucket_start + bucket_delta, session_end)
            duration = max(bucket_end - bucket_start, timedelta())
            sample_count = max(int(duration.total_seconds() // sample_delta.total_seconds()), 1)
            buckets.append((bucket_start, bucket_end, sample_count))
            bucket_start = bucket_end
        current_day += timedelta(days=1)
    return buckets


def build_observed_runtime_buckets(
    *,
    bucket_ranges: Sequence[tuple[datetime, datetime, int]],
    decision_times: Sequence[datetime],
    execution_times: Sequence[datetime],
    tca_rows: Sequence[Mapping[str, Any]],
    continuity_ok: bool,
    drift_ok: bool,
    dependency_quorum_decision: str,
) -> list[ObservedRuntimeBucket]:
    normalized_decisions = [_utc(item) for item in decision_times]
    normalized_executions = [_utc(item) for item in execution_times]
    normalized_tca_rows: list[_NormalizedTcaRow] = []
    for row in tca_rows:
        computed_at_raw = row.get('computed_at')
        if not isinstance(computed_at_raw, datetime):
            continue
        normalized_tca_rows.append(
            _NormalizedTcaRow(
                computed_at=_utc(computed_at_raw),
                abs_slippage_bps=_decimal(row.get('abs_slippage_bps')),
                post_cost_expectancy_bps=_decimal(
                    row.get('post_cost_expectancy_bps')
                ),
            )
        )

    buckets: list[ObservedRuntimeBucket] = []
    for bucket_start, bucket_end, market_session_count in bucket_ranges:
        decisions = [item for item in normalized_decisions if bucket_start <= item < bucket_end]
        executions = [item for item in normalized_executions if bucket_start <= item < bucket_end]
        bucket_tca = [
            row
            for row in normalized_tca_rows
            if bucket_start <= row.computed_at < bucket_end
        ]
        decision_count = len(decisions)
        trade_count = len(executions)
        order_count = len(executions)
        if decision_count <= 0 and trade_count <= 0:
            decision_alignment_ratio = Decimal('1')
        elif decision_count <= 0:
            decision_alignment_ratio = Decimal('0')
        else:
            decision_alignment_ratio = Decimal(trade_count) / Decimal(decision_count)
        if bucket_tca:
            avg_abs_slippage_bps = (
                sum(row.abs_slippage_bps for row in bucket_tca)
                / Decimal(len(bucket_tca))
            )
            post_cost_expectancy_bps = (
                sum(row.post_cost_expectancy_bps for row in bucket_tca)
                / Decimal(len(bucket_tca))
            )
        else:
            avg_abs_slippage_bps = Decimal('0')
            post_cost_expectancy_bps = Decimal('0')
        buckets.append(
            ObservedRuntimeBucket(
                window_started_at=bucket_start,
                window_ended_at=bucket_end,
                market_session_count=max(market_session_count, 1),
                decision_count=decision_count,
                trade_count=trade_count,
                order_count=order_count,
                decision_alignment_ratio=decision_alignment_ratio,
                avg_abs_slippage_bps=avg_abs_slippage_bps,
                post_cost_expectancy_bps=post_cost_expectancy_bps,
                continuity_ok=continuity_ok,
                drift_ok=drift_ok,
                dependency_quorum_decision=dependency_quorum_decision,
                payload_json={
                    'bucket_start': bucket_start.isoformat(),
                    'bucket_end': bucket_end.isoformat(),
                    'market_session_count': market_session_count,
                    'decision_count': decision_count,
                    'trade_count': trade_count,
                    'order_count': order_count,
                    'tca_row_count': len(bucket_tca),
                },
            )
        )
    return buckets


def persist_observed_runtime_windows(
    *,
    session: Session,
    run_id: str,
    candidate_id: str | None,
    hypothesis_id: str,
    observed_stage: str,
    strategy_family: str | None,
    source_manifest_ref: str | None,
    buckets: Sequence[ObservedRuntimeBucket],
    slippage_budget_bps: Decimal | None = None,
    runtime_observation_payload: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    if observed_stage not in {'paper', 'live'}:
        raise RuntimeError(f'invalid_observed_stage:{observed_stage}')
    registry, manifest = resolve_hypothesis_manifest(
        hypothesis_id=hypothesis_id,
        strategy_family=strategy_family,
    )
    budget = slippage_budget_bps or manifest.max_allowed_slippage_bps

    existing_hypothesis = session.execute(
        select(StrategyHypothesis).where(StrategyHypothesis.hypothesis_id == hypothesis_id)
    ).scalar_one_or_none()
    if existing_hypothesis is None:
        session.add(
            StrategyHypothesis(
                hypothesis_id=hypothesis_id,
                lane_id=manifest.lane_id,
                strategy_family=manifest.strategy_family,
                source_manifest_ref=source_manifest_ref or registry.path,
                active=True,
                payload_json=manifest.model_dump(mode='json'),
            )
        )
    version_key = f'{manifest.schema_version}:{manifest.lane_id}'
    existing_version = session.execute(
        select(StrategyHypothesisVersion).where(
            StrategyHypothesisVersion.hypothesis_id == hypothesis_id,
            StrategyHypothesisVersion.version_key == version_key,
        )
    ).scalar_one_or_none()
    if existing_version is None:
        session.add(
            StrategyHypothesisVersion(
                hypothesis_id=hypothesis_id,
                version_key=version_key,
                source_manifest_ref=source_manifest_ref or registry.path,
                active=True,
                payload_json=manifest.model_dump(mode='json'),
            )
        )

    session.execute(
        delete(StrategyHypothesisMetricWindow).where(
            StrategyHypothesisMetricWindow.run_id == run_id,
            StrategyHypothesisMetricWindow.hypothesis_id == hypothesis_id,
            StrategyHypothesisMetricWindow.observed_stage == observed_stage,
        )
    )
    session.execute(
        delete(StrategyCapitalAllocation).where(
            StrategyCapitalAllocation.run_id == run_id,
            StrategyCapitalAllocation.hypothesis_id == hypothesis_id,
        )
    )
    session.execute(
        delete(StrategyPromotionDecision).where(
            StrategyPromotionDecision.run_id == run_id,
            StrategyPromotionDecision.hypothesis_id == hypothesis_id,
            StrategyPromotionDecision.promotion_target == observed_stage,
        )
    )

    evidence_provenance = 'paper_runtime_observed' if observed_stage == 'paper' else 'live_runtime_observed'
    inserted = 0
    total_session_samples = 0
    total_post_cost = Decimal('0')
    total_weight = Decimal('0')
    latest_three_budget_ok = True
    sorted_buckets = sorted(buckets, key=lambda item: item.window_ended_at)
    runtime_payload = dict(runtime_observation_payload or {})
    for bucket in sorted_buckets:
        weight = Decimal(bucket.market_session_count)
        total_weight += weight
        total_session_samples += bucket.market_session_count
        total_post_cost += bucket.post_cost_expectancy_bps * weight
        capital_stage = (
            'shadow'
            if observed_stage == 'paper'
            else '0.50x live'
            if total_session_samples >= manifest.min_sample_count_for_scale_up
            else '0.10x canary'
        )
        session.add(
            StrategyHypothesisMetricWindow(
                run_id=run_id,
                candidate_id=candidate_id,
                hypothesis_id=hypothesis_id,
                observed_stage=observed_stage,
                window_started_at=bucket.window_started_at,
                window_ended_at=bucket.window_ended_at,
                market_session_count=bucket.market_session_count,
                decision_count=bucket.decision_count,
                trade_count=bucket.trade_count,
                order_count=bucket.order_count,
                evidence_provenance=evidence_provenance,
                evidence_maturity='empirically_validated',
                decision_alignment_ratio=str(bucket.decision_alignment_ratio),
                avg_abs_slippage_bps=str(bucket.avg_abs_slippage_bps),
                slippage_budget_bps=str(budget),
                post_cost_expectancy_bps=str(bucket.post_cost_expectancy_bps),
                continuity_ok=bucket.continuity_ok,
                drift_ok=bucket.drift_ok,
                dependency_quorum_decision=bucket.dependency_quorum_decision,
                capital_stage=capital_stage,
                payload_json={
                    **bucket.payload_json,
                    'source_manifest_ref': source_manifest_ref or registry.path,
                    'runtime_observation': runtime_payload,
                },
            )
        )
        inserted += 1

    latest_three_budget_ok = all(
        bucket.avg_abs_slippage_bps <= budget for bucket in sorted_buckets[-3:]
    ) if sorted_buckets else False
    average_post_cost = (total_post_cost / total_weight) if total_weight > 0 else Decimal('0')
    average_slippage = (
        sum(bucket.avg_abs_slippage_bps * Decimal(bucket.market_session_count) for bucket in sorted_buckets)
        / total_weight
        if total_weight > 0
        else Decimal('0')
    )
    final_capital_stage = (
        'shadow'
        if observed_stage == 'paper'
        else '0.50x live'
        if total_session_samples >= manifest.min_sample_count_for_scale_up
        else '0.10x canary'
    )
    session.add(
        StrategyCapitalAllocation(
            run_id=run_id,
            candidate_id=candidate_id,
            hypothesis_id=hypothesis_id,
            prior_stage='shadow',
            stage=final_capital_stage,
            capital_multiplier='0' if observed_stage == 'paper' else '0.50' if final_capital_stage == '0.50x live' else '0.10',
            rollback_target_stage='shadow',
            payload_json={
                'imported': True,
                'observed_stage': observed_stage,
                'window_count': inserted,
                'market_session_samples': total_session_samples,
                'runtime_observation': runtime_payload,
            },
        )
    )
    session.add(
        StrategyPromotionDecision(
            run_id=run_id,
            candidate_id=candidate_id,
            hypothesis_id=hypothesis_id,
            promotion_target=observed_stage,
            state=final_capital_stage,
            allowed=bool(inserted),
            reason_summary='imported_observed_runtime_windows',
            payload_json={
                'imported': True,
                'observed_stage': observed_stage,
                'window_count': inserted,
                'market_session_samples': total_session_samples,
                'avg_abs_slippage_bps': str(average_slippage),
                'avg_post_cost_expectancy_bps': str(average_post_cost),
                'latest_three_within_budget': latest_three_budget_ok,
                'runtime_observation': runtime_payload,
            },
        )
    )
    session.flush()
    return {
        'run_id': run_id,
        'candidate_id': candidate_id,
        'hypothesis_id': hypothesis_id,
        'observed_stage': observed_stage,
        'window_count': inserted,
        'market_session_samples': total_session_samples,
        'avg_abs_slippage_bps': str(average_slippage),
        'avg_post_cost_expectancy_bps': str(average_post_cost),
        'latest_three_within_budget': latest_three_budget_ok,
        'slippage_budget_bps': str(budget),
    }


__all__ = [
    'ObservedRuntimeBucket',
    'build_observed_runtime_buckets',
    'build_regular_session_buckets',
    'persist_observed_runtime_windows',
    'resolve_hypothesis_manifest',
]
