"""Import observed runtime windows into the hypothesis governance ledger."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Any, Mapping, Sequence, cast
from zoneinfo import ZoneInfo

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..models import (
    StrategyCapitalAllocation,
    StrategyHypothesis,
    StrategyHypothesisMetricWindow,
    StrategyHypothesisVersion,
    StrategyPromotionDecision,
    VNextDatasetSnapshot,
)
from .hypotheses import (
    HypothesisManifest,
    HypothesisRegistryLoadResult,
    load_hypothesis_registry,
)

US_EQUITIES_REGULAR_TIMEZONE = "America/New_York"
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


def _decimal(value: Any, *, default: str = "0") -> Decimal:
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
    normalized_manifest = manifest.strategy_family.replace("-", "_").lower()
    normalized_input = strategy_family.replace("-", "_").lower()
    if normalized_manifest == normalized_input:
        return True
    return (
        normalized_input in normalized_manifest
        or normalized_manifest in normalized_input
    )


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _parse_observation_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return _utc(value)
    text = _text(value)
    if text is None:
        return None
    try:
        return _utc(datetime.fromisoformat(text.replace("Z", "+00:00")))
    except ValueError:
        return None


def _observation_bool(value: Any) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float, Decimal)):
        return bool(value)
    text = _text(value)
    if text is None:
        return None
    normalized = text.lower()
    if normalized in {"1", "true", "yes", "on", "pass", "passed", "ok", "ready"}:
        return True
    if normalized in {"0", "false", "no", "off", "fail", "failed", "blocked"}:
        return False
    return None


def _observation_int(value: Any) -> int:
    try:
        return max(0, int(Decimal(str(value))))
    except Exception:
        return 0


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    return [
        text
        for item in cast(Sequence[object], value)
        if (text := _text(item)) is not None
    ]


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
    return list(dict.fromkeys(reasons))


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


def _runtime_promotion_blocking_reasons(
    *,
    inserted: int,
    total_session_samples: int,
    total_decision_count: int,
    total_trade_count: int,
    total_order_count: int,
    average_slippage: Decimal,
    average_post_cost: Decimal,
    latest_three_budget_ok: bool,
    manifest: HypothesisManifest,
    budget: Decimal,
) -> list[str]:
    reasons: list[str] = []
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
    if average_post_cost <= Decimal("0"):
        reasons.append("post_cost_expectancy_non_positive")
    elif average_post_cost < manifest.expected_gross_edge_bps:
        reasons.append("post_cost_expectancy_below_manifest_threshold")
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
        computed_at_raw = row.get("computed_at")
        if not isinstance(computed_at_raw, datetime):
            continue
        normalized_tca_rows.append(
            _NormalizedTcaRow(
                computed_at=_utc(computed_at_raw),
                abs_slippage_bps=_decimal(row.get("abs_slippage_bps")),
                post_cost_expectancy_bps=_decimal(row.get("post_cost_expectancy_bps")),
            )
        )

    buckets: list[ObservedRuntimeBucket] = []
    for bucket_start, bucket_end, market_session_count in bucket_ranges:
        decisions = [
            item for item in normalized_decisions if bucket_start <= item < bucket_end
        ]
        executions = [
            item for item in normalized_executions if bucket_start <= item < bucket_end
        ]
        bucket_tca = [
            row
            for row in normalized_tca_rows
            if bucket_start <= row.computed_at < bucket_end
        ]
        decision_count = len(decisions)
        trade_count = len(executions)
        order_count = len(executions)
        if decision_count <= 0 and trade_count <= 0:
            decision_alignment_ratio = Decimal("1")
        elif decision_count <= 0:
            decision_alignment_ratio = Decimal("0")
        else:
            decision_alignment_ratio = Decimal(trade_count) / Decimal(decision_count)
        if bucket_tca:
            avg_abs_slippage_bps = sum(
                row.abs_slippage_bps for row in bucket_tca
            ) / Decimal(len(bucket_tca))
            post_cost_expectancy_bps = sum(
                row.post_cost_expectancy_bps for row in bucket_tca
            ) / Decimal(len(bucket_tca))
        else:
            avg_abs_slippage_bps = Decimal("0")
            post_cost_expectancy_bps = Decimal("0")
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
                    "bucket_start": bucket_start.isoformat(),
                    "bucket_end": bucket_end.isoformat(),
                    "market_session_count": market_session_count,
                    "decision_count": decision_count,
                    "trade_count": trade_count,
                    "order_count": order_count,
                    "tca_row_count": len(bucket_tca),
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
    if observed_stage not in {"paper", "live"}:
        raise RuntimeError(f"invalid_observed_stage:{observed_stage}")
    registry, manifest = resolve_hypothesis_manifest(
        hypothesis_id=hypothesis_id,
        strategy_family=strategy_family,
    )
    budget = slippage_budget_bps or manifest.max_allowed_slippage_bps

    existing_hypothesis = session.execute(
        select(StrategyHypothesis).where(
            StrategyHypothesis.hypothesis_id == hypothesis_id
        )
    ).scalar_one_or_none()
    if existing_hypothesis is None:
        session.add(
            StrategyHypothesis(
                hypothesis_id=hypothesis_id,
                lane_id=manifest.lane_id,
                strategy_family=manifest.strategy_family,
                source_manifest_ref=source_manifest_ref or registry.path,
                active=True,
                payload_json=manifest.model_dump(mode="json"),
            )
        )
    version_key = f"{manifest.schema_version}:{manifest.lane_id}"
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
                payload_json=manifest.model_dump(mode="json"),
            )
        )

    runtime_payload = dict(runtime_observation_payload or {})
    artifact_refs = _string_list(runtime_payload.get("artifact_refs"))
    dataset_snapshot_ref = _text(runtime_payload.get("dataset_snapshot_ref")) or next(
        (ref for ref in artifact_refs if ref), None
    )
    dataset_source = _text(runtime_payload.get("source_kind")) or (
        "paper_runtime_observed"
        if observed_stage == "paper"
        else "live_runtime_observed"
    )
    if candidate_id is not None and dataset_snapshot_ref is not None:
        existing_dataset = session.execute(
            select(VNextDatasetSnapshot).where(
                VNextDatasetSnapshot.run_id == run_id,
                VNextDatasetSnapshot.dataset_id == f"runtime-window-{run_id}",
            )
        ).scalar_one_or_none()
        if existing_dataset is None:
            session.add(
                VNextDatasetSnapshot(
                    run_id=run_id,
                    candidate_id=candidate_id,
                    dataset_id=f"runtime-window-{run_id}",
                    source=dataset_source,
                    dataset_version=run_id,
                    dataset_from=min(
                        (bucket.window_started_at for bucket in buckets), default=None
                    ),
                    dataset_to=max(
                        (bucket.window_ended_at for bucket in buckets), default=None
                    ),
                    artifact_ref=dataset_snapshot_ref,
                    payload_json={
                        "observed_stage": observed_stage,
                        "hypothesis_id": hypothesis_id,
                        "strategy_family": manifest.strategy_family,
                        "runtime_observation": runtime_payload,
                    },
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

    evidence_provenance = (
        "paper_runtime_observed"
        if observed_stage == "paper"
        else "live_runtime_observed"
    )
    sorted_buckets = sorted(buckets, key=lambda item: item.window_ended_at)
    inserted = len(sorted_buckets)
    total_session_samples = sum(
        bucket.market_session_count for bucket in sorted_buckets
    )
    total_weight = sum(
        (Decimal(bucket.market_session_count) for bucket in sorted_buckets),
        Decimal("0"),
    )
    total_decision_count = sum(bucket.decision_count for bucket in sorted_buckets)
    total_trade_count = sum(bucket.trade_count for bucket in sorted_buckets)
    total_order_count = sum(bucket.order_count for bucket in sorted_buckets)
    total_post_cost = sum(
        (
            bucket.post_cost_expectancy_bps * Decimal(bucket.market_session_count)
            for bucket in sorted_buckets
        ),
        Decimal("0"),
    )
    latest_three_budget_ok = (
        all(bucket.avg_abs_slippage_bps <= budget for bucket in sorted_buckets[-3:])
        if sorted_buckets
        else False
    )
    average_post_cost = (
        (total_post_cost / total_weight) if total_weight > 0 else Decimal("0")
    )
    average_slippage = (
        sum(
            (
                bucket.avg_abs_slippage_bps * Decimal(bucket.market_session_count)
                for bucket in sorted_buckets
            ),
            Decimal("0"),
        )
        / total_weight
        if total_weight > 0
        else Decimal("0")
    )
    promotion_blocking_reasons = _runtime_promotion_blocking_reasons(
        inserted=inserted,
        total_session_samples=total_session_samples,
        total_decision_count=total_decision_count,
        total_trade_count=total_trade_count,
        total_order_count=total_order_count,
        average_slippage=average_slippage,
        average_post_cost=average_post_cost,
        latest_three_budget_ok=latest_three_budget_ok,
        manifest=manifest,
        budget=budget,
    )
    latest_observation_at = max(
        (bucket.window_ended_at for bucket in sorted_buckets),
        default=datetime.now(timezone.utc),
    )
    promotion_blocking_reasons = list(
        dict.fromkeys(
            [
                *promotion_blocking_reasons,
                *_delay_adjusted_depth_stress_blocking_reasons(
                    manifest=manifest,
                    runtime_payload=runtime_payload,
                    now=latest_observation_at,
                ),
            ]
        )
    )
    promotion_allowed = not promotion_blocking_reasons
    running_session_samples = 0
    for bucket in sorted_buckets:
        running_session_samples += bucket.market_session_count
        capital_stage = _capital_stage_for_runtime_import(
            observed_stage=observed_stage,
            promotion_allowed=promotion_allowed,
            session_samples=running_session_samples,
            manifest=manifest,
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
                evidence_maturity="empirically_validated",
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
                    "source_manifest_ref": source_manifest_ref or registry.path,
                    "runtime_observation": runtime_payload,
                },
            )
        )

    final_capital_stage = _capital_stage_for_runtime_import(
        observed_stage=observed_stage,
        promotion_allowed=promotion_allowed,
        session_samples=total_session_samples,
        manifest=manifest,
    )
    reason_summary = (
        "runtime_evidence_thresholds_satisfied"
        if promotion_allowed
        else ",".join(promotion_blocking_reasons)[:255]
    )
    session.add(
        StrategyCapitalAllocation(
            run_id=run_id,
            candidate_id=candidate_id,
            hypothesis_id=hypothesis_id,
            prior_stage="shadow",
            stage=final_capital_stage,
            capital_multiplier=_capital_multiplier_for_stage(final_capital_stage),
            rollback_target_stage="shadow",
            payload_json={
                "imported": True,
                "observed_stage": observed_stage,
                "window_count": inserted,
                "market_session_samples": total_session_samples,
                "decision_count": total_decision_count,
                "trade_count": total_trade_count,
                "order_count": total_order_count,
                "promotion_allowed": promotion_allowed,
                "promotion_blocking_reasons": promotion_blocking_reasons,
                "runtime_observation": runtime_payload,
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
            allowed=promotion_allowed,
            reason_summary=reason_summary,
            payload_json={
                "imported": True,
                "observed_stage": observed_stage,
                "window_count": inserted,
                "market_session_samples": total_session_samples,
                "decision_count": total_decision_count,
                "trade_count": total_trade_count,
                "order_count": total_order_count,
                "avg_abs_slippage_bps": str(average_slippage),
                "avg_post_cost_expectancy_bps": str(average_post_cost),
                "latest_three_within_budget": latest_three_budget_ok,
                "promotion_allowed": promotion_allowed,
                "promotion_blocking_reasons": promotion_blocking_reasons,
                "runtime_observation": runtime_payload,
            },
        )
    )
    session.flush()
    return {
        "run_id": run_id,
        "candidate_id": candidate_id,
        "hypothesis_id": hypothesis_id,
        "observed_stage": observed_stage,
        "window_count": inserted,
        "market_session_samples": total_session_samples,
        "decision_count": total_decision_count,
        "trade_count": total_trade_count,
        "order_count": total_order_count,
        "avg_abs_slippage_bps": str(average_slippage),
        "avg_post_cost_expectancy_bps": str(average_post_cost),
        "latest_three_within_budget": latest_three_budget_ok,
        "slippage_budget_bps": str(budget),
        "promotion_allowed": promotion_allowed,
        "promotion_blocking_reasons": promotion_blocking_reasons,
    }


__all__ = [
    "ObservedRuntimeBucket",
    "build_observed_runtime_buckets",
    "build_regular_session_buckets",
    "persist_observed_runtime_windows",
    "resolve_hypothesis_manifest",
]
