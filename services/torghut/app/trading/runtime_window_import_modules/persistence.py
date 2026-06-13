"""Persist observed runtime windows into governance and proof rows."""

from __future__ import annotations

from collections import Counter
from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Mapping, Sequence, cast

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ...models import (
    StrategyCapitalAllocation,
    StrategyHypothesis,
    StrategyHypothesisMetricWindow,
    StrategyHypothesisVersion,
    StrategyPromotionDecision,
    VNextDatasetSnapshot,
)

from .common import (
    ObservedRuntimeBucket,
    paper_probation_blocking_reasons,
    string_list,
    text_value,
)
from .daily_summary import runtime_ledger_daily_summary_from_observed_buckets
from .evidence_gates import (
    RuntimePromotionInputs,
    delay_adjusted_depth_stress_blocking_reasons,
    delay_adjusted_depth_stress_summary,
    runtime_ledger_authority_gate_targets,
    runtime_promotion_blocking_reasons,
    runtime_window_import_evidence_blocking_reasons,
    runtime_window_import_proof_blockers,
    resolve_hypothesis_manifest,
)
from .ledger_persistence import (
    RuntimeLedgerBucketDeleteRequest,
    delete_current_runtime_ledger_buckets,
    delete_replaced_runtime_ledger_buckets,
    runtime_ledger_bucket_replacement_scopes,
    runtime_ledger_post_cost_from_observed_buckets,
)
from .persistence_materialization import (
    final_summary,
    finalize_materialization,
    persist_governance_rows,
    runtime_materialization_target,
)
from .persistence_types import (
    AggregateMetrics,
    BucketSet,
    ManifestContext,
    PersistencePlan,
    PersistObservedRuntimeWindowsRequest,
    PromotionState,
    ReplacementCounts,
)


def _request_from_kwargs(
    inputs: Mapping[str, Any],
) -> PersistObservedRuntimeWindowsRequest:
    return PersistObservedRuntimeWindowsRequest(
        session=cast(Session, inputs["session"]),
        run_id=cast(str, inputs["run_id"]),
        candidate_id=cast(str | None, inputs["candidate_id"]),
        hypothesis_id=cast(str, inputs["hypothesis_id"]),
        observed_stage=cast(str, inputs["observed_stage"]),
        strategy_family=cast(str | None, inputs["strategy_family"]),
        source_manifest_ref=cast(str | None, inputs["source_manifest_ref"]),
        buckets=cast(Sequence[ObservedRuntimeBucket], inputs["buckets"]),
        slippage_budget_bps=cast(Decimal | None, inputs.get("slippage_budget_bps")),
        runtime_observation_payload=cast(
            Mapping[str, Any] | None,
            inputs.get("runtime_observation_payload"),
        ),
    )


def _manifest_context(
    request: PersistObservedRuntimeWindowsRequest,
) -> ManifestContext:
    registry, manifest = resolve_hypothesis_manifest(
        hypothesis_id=request.hypothesis_id,
        strategy_family=request.strategy_family,
    )
    runtime_payload = dict(request.runtime_observation_payload or {})
    artifact_refs = string_list(runtime_payload.get("artifact_refs"))
    dataset_snapshot_ref = text_value(
        runtime_payload.get("dataset_snapshot_ref")
    ) or next((ref for ref in artifact_refs if ref), None)
    observed_source = (
        "paper_runtime_observed"
        if request.observed_stage == "paper"
        else "live_runtime_observed"
    )
    return ManifestContext(
        registry=registry,
        manifest=manifest,
        budget=request.slippage_budget_bps or manifest.max_allowed_slippage_bps,
        runtime_payload=runtime_payload,
        delay_depth_stress_summary=delay_adjusted_depth_stress_summary(runtime_payload),
        evidence_provenance=observed_source,
        dataset_snapshot_ref=dataset_snapshot_ref,
        dataset_source=text_value(runtime_payload.get("source_kind"))
        or observed_source,
    )


def _ensure_hypothesis_records(
    request: PersistObservedRuntimeWindowsRequest,
    context: ManifestContext,
) -> None:
    existing_hypothesis = request.session.execute(
        select(StrategyHypothesis).where(
            StrategyHypothesis.hypothesis_id == request.hypothesis_id
        )
    ).scalar_one_or_none()
    if existing_hypothesis is None:
        request.session.add(
            StrategyHypothesis(
                hypothesis_id=request.hypothesis_id,
                lane_id=context.manifest.lane_id,
                strategy_family=context.manifest.strategy_family,
                source_manifest_ref=request.source_manifest_ref
                or context.registry.path,
                active=True,
                payload_json=context.manifest.model_dump(mode="json"),
            )
        )
    _ensure_hypothesis_version(request, context)


def _ensure_hypothesis_version(
    request: PersistObservedRuntimeWindowsRequest,
    context: ManifestContext,
) -> None:
    version_key = f"{context.manifest.schema_version}:{context.manifest.lane_id}"
    existing_version = request.session.execute(
        select(StrategyHypothesisVersion).where(
            StrategyHypothesisVersion.hypothesis_id == request.hypothesis_id,
            StrategyHypothesisVersion.version_key == version_key,
        )
    ).scalar_one_or_none()
    if existing_version is None:
        request.session.add(
            StrategyHypothesisVersion(
                hypothesis_id=request.hypothesis_id,
                version_key=version_key,
                source_manifest_ref=request.source_manifest_ref
                or context.registry.path,
                active=True,
                payload_json=context.manifest.model_dump(mode="json"),
            )
        )


def _bucket_set(
    request: PersistObservedRuntimeWindowsRequest,
) -> BucketSet:
    raw_buckets = sorted(request.buckets, key=lambda item: item.window_ended_at)
    sorted_buckets = [
        bucket
        for bucket in raw_buckets
        if bucket.decision_count > 0 or bucket.trade_count > 0 or bucket.order_count > 0
    ]
    return BucketSet(
        raw_buckets=raw_buckets,
        sorted_buckets=sorted_buckets,
        raw_window_count=len(raw_buckets),
        skipped_zero_activity_window_count=len(raw_buckets) - len(sorted_buckets),
    )


def _maybe_add_dataset_snapshot(
    request: PersistObservedRuntimeWindowsRequest,
    context: ManifestContext,
    buckets: BucketSet,
) -> None:
    if request.candidate_id is None or context.dataset_snapshot_ref is None:
        return
    existing_dataset = request.session.execute(
        select(VNextDatasetSnapshot).where(
            VNextDatasetSnapshot.run_id == request.run_id,
            VNextDatasetSnapshot.dataset_id == f"runtime-window-{request.run_id}",
        )
    ).scalar_one_or_none()
    if existing_dataset is not None:
        return
    request.session.add(_dataset_snapshot_row(request, context, buckets))


def _dataset_snapshot_row(
    request: PersistObservedRuntimeWindowsRequest,
    context: ManifestContext,
    buckets: BucketSet,
) -> VNextDatasetSnapshot:
    return VNextDatasetSnapshot(
        run_id=request.run_id,
        candidate_id=request.candidate_id,
        dataset_id=f"runtime-window-{request.run_id}",
        source=context.dataset_source,
        dataset_version=request.run_id,
        dataset_from=min(
            (bucket.window_started_at for bucket in buckets.raw_buckets),
            default=None,
        ),
        dataset_to=max(
            (bucket.window_ended_at for bucket in buckets.raw_buckets),
            default=None,
        ),
        artifact_ref=context.dataset_snapshot_ref,
        payload_json={
            "observed_stage": request.observed_stage,
            "hypothesis_id": request.hypothesis_id,
            "strategy_family": context.manifest.strategy_family,
            "runtime_observation": context.runtime_payload,
        },
    )


def _delete_existing_governance_rows(
    request: PersistObservedRuntimeWindowsRequest,
) -> None:
    request.session.execute(
        delete(StrategyHypothesisMetricWindow).where(
            StrategyHypothesisMetricWindow.run_id == request.run_id,
            StrategyHypothesisMetricWindow.hypothesis_id == request.hypothesis_id,
            StrategyHypothesisMetricWindow.observed_stage == request.observed_stage,
        )
    )
    request.session.execute(
        delete(StrategyCapitalAllocation).where(
            StrategyCapitalAllocation.run_id == request.run_id,
            StrategyCapitalAllocation.hypothesis_id == request.hypothesis_id,
        )
    )
    request.session.execute(
        delete(StrategyPromotionDecision).where(
            StrategyPromotionDecision.run_id == request.run_id,
            StrategyPromotionDecision.hypothesis_id == request.hypothesis_id,
            StrategyPromotionDecision.promotion_target == request.observed_stage,
        )
    )


def _replace_runtime_ledger_rows(
    request: PersistObservedRuntimeWindowsRequest,
    context: ManifestContext,
    buckets: BucketSet,
) -> ReplacementCounts:
    replacement_scopes = runtime_ledger_bucket_replacement_scopes(
        buckets=buckets.sorted_buckets,
        runtime_payload=context.runtime_payload,
    )
    delete_request = RuntimeLedgerBucketDeleteRequest(
        session=request.session,
        run_id=request.run_id,
        candidate_id=request.candidate_id,
        hypothesis_id=request.hypothesis_id,
        observed_stage=request.observed_stage,
        replacement_scopes=replacement_scopes,
    )
    return ReplacementCounts(
        current_runtime_ledger_bucket_replacement_count=(
            delete_current_runtime_ledger_buckets(delete_request)
        ),
        replaced_runtime_ledger_bucket_count=delete_replaced_runtime_ledger_buckets(
            delete_request
        ),
    )


def _post_cost_basis_counts(
    buckets: Sequence[ObservedRuntimeBucket],
) -> dict[str, int]:
    counter: Counter[str] = Counter()
    for bucket in buckets:
        counter.update(bucket.post_cost_basis_counts)
    return dict(sorted(counter.items()))


def _average_slippage(
    buckets: Sequence[ObservedRuntimeBucket],
    total_weight: Decimal,
) -> Decimal:
    if total_weight <= 0:
        return Decimal("0")
    return (
        sum(
            (
                bucket.avg_abs_slippage_bps * Decimal(bucket.market_session_count)
                for bucket in buckets
            ),
            Decimal("0"),
        )
        / total_weight
    )


def _runtime_windows(
    buckets: BucketSet,
) -> tuple[datetime, datetime, datetime]:
    latest_observation_at = max(
        (bucket.window_ended_at for bucket in buckets.sorted_buckets),
        default=max(
            (bucket.window_ended_at for bucket in buckets.raw_buckets),
            default=datetime.now(timezone.utc),
        ),
    )
    import_window_start = min(
        (bucket.window_started_at for bucket in buckets.raw_buckets),
        default=latest_observation_at,
    )
    import_window_end = max(
        (bucket.window_ended_at for bucket in buckets.raw_buckets),
        default=latest_observation_at,
    )
    return latest_observation_at, import_window_start, import_window_end


def _aggregate_metrics(
    context: ManifestContext,
    buckets: BucketSet,
) -> AggregateMetrics:
    sorted_buckets = buckets.sorted_buckets
    average_post_cost, net_pnl, filled_notional, sample_count = (
        _runtime_ledger_post_cost_metrics(sorted_buckets)
    )
    latest_observation_at, import_window_start, import_window_end = _runtime_windows(
        buckets
    )
    total_weight = sum(
        (Decimal(bucket.market_session_count) for bucket in sorted_buckets),
        Decimal("0"),
    )
    return AggregateMetrics(
        inserted=len(sorted_buckets),
        total_session_samples=sum(
            bucket.market_session_count for bucket in sorted_buckets
        ),
        total_decision_count=sum(bucket.decision_count for bucket in sorted_buckets),
        total_trade_count=sum(bucket.trade_count for bucket in sorted_buckets),
        total_order_count=sum(bucket.order_count for bucket in sorted_buckets),
        total_post_cost_promotion_sample_count=sum(
            bucket.post_cost_promotion_sample_count for bucket in sorted_buckets
        ),
        total_post_cost_basis_counts=_post_cost_basis_counts(sorted_buckets),
        latest_three_budget_ok=_latest_three_budget_ok(sorted_buckets, context.budget),
        all_continuity_ok=all(bucket.continuity_ok for bucket in sorted_buckets)
        if sorted_buckets
        else False,
        all_drift_ok=all(bucket.drift_ok for bucket in sorted_buckets)
        if sorted_buckets
        else False,
        dependency_quorum_allowed=_dependency_quorum_allowed(sorted_buckets),
        average_slippage=_average_slippage(sorted_buckets, total_weight),
        average_post_cost=average_post_cost,
        post_cost_expectancy_aggregation=(
            "runtime_ledger_notional_weighted"
            if sample_count > 0
            else "no_runtime_ledger_post_cost_rows"
        ),
        runtime_ledger_sample_count=sample_count,
        runtime_ledger_filled_notional=filled_notional,
        runtime_ledger_net_strategy_pnl_after_costs=net_pnl,
        runtime_ledger_daily_summary=_runtime_ledger_daily_summary(
            buckets,
            average_post_cost,
        ),
        latest_observation_at=latest_observation_at,
        import_window_start=import_window_start,
        import_window_end=import_window_end,
    )


def _runtime_ledger_daily_summary(
    buckets: BucketSet,
    average_post_cost: Decimal,
) -> dict[str, Any]:
    daily_summary = runtime_ledger_daily_summary_from_observed_buckets(
        buckets.raw_buckets
    )
    return {
        **daily_summary,
        "runtime_ledger_promotion_gate_targets": runtime_ledger_authority_gate_targets(
            average_post_cost_bps=average_post_cost
        ),
    }


def _runtime_ledger_post_cost_metrics(
    buckets: Sequence[ObservedRuntimeBucket],
) -> tuple[Decimal, Decimal, Decimal, int]:
    average_post_cost, net_pnl, filled_notional, sample_count = (
        runtime_ledger_post_cost_from_observed_buckets(buckets)
    )
    return (
        average_post_cost or Decimal("0"),
        net_pnl,
        filled_notional,
        sample_count,
    )


def _latest_three_budget_ok(
    buckets: Sequence[ObservedRuntimeBucket],
    budget: Decimal,
) -> bool:
    return (
        all(bucket.avg_abs_slippage_bps <= budget for bucket in buckets[-3:])
        if buckets
        else False
    )


def _dependency_quorum_allowed(
    buckets: Sequence[ObservedRuntimeBucket],
) -> bool:
    return (
        all(
            str(bucket.dependency_quorum_decision or "").strip().lower() == "allow"
            for bucket in buckets
        )
        if buckets
        else False
    )


def _base_promotion_blocking_reasons(
    context: ManifestContext,
    metrics: AggregateMetrics,
    observed_stage: str,
) -> list[str]:
    return runtime_promotion_blocking_reasons(
        RuntimePromotionInputs(
            observed_stage=observed_stage,
            inserted=metrics.inserted,
            total_session_samples=metrics.total_session_samples,
            total_decision_count=metrics.total_decision_count,
            total_trade_count=metrics.total_trade_count,
            total_order_count=metrics.total_order_count,
            total_post_cost_promotion_sample_count=(
                metrics.total_post_cost_promotion_sample_count
            ),
            runtime_ledger_notional_weighted_sample_count=(
                metrics.runtime_ledger_sample_count
            ),
            total_post_cost_basis_counts=metrics.total_post_cost_basis_counts,
            average_slippage=metrics.average_slippage,
            average_post_cost=metrics.average_post_cost,
            runtime_ledger_daily_summary=metrics.runtime_ledger_daily_summary,
            latest_three_budget_ok=metrics.latest_three_budget_ok,
            all_continuity_ok=metrics.all_continuity_ok,
            all_drift_ok=metrics.all_drift_ok,
            dependency_quorum_allowed=metrics.dependency_quorum_allowed,
            manifest=context.manifest,
            budget=context.budget,
        )
    )


def _promotion_blocking_reasons(
    plan: PersistencePlan,
) -> list[str]:
    reasons = [
        *_base_promotion_blocking_reasons(
            plan.context,
            plan.metrics,
            plan.request.observed_stage,
        ),
        *paper_probation_blocking_reasons(plan.context.runtime_payload),
        *delay_adjusted_depth_stress_blocking_reasons(
            manifest=plan.context.manifest,
            runtime_payload=plan.context.runtime_payload,
            now=plan.metrics.latest_observation_at,
        ),
    ]
    return list(dict.fromkeys(reasons))


def _promotion_state(plan: PersistencePlan) -> PromotionState:
    blocking_reasons = _promotion_blocking_reasons(plan)
    evidence_blocking_reasons = runtime_window_import_evidence_blocking_reasons(
        blocking_reasons
    )
    proof_blockers = runtime_window_import_proof_blockers(
        promotion_blocking_reasons=evidence_blocking_reasons,
        runtime_payload=plan.context.runtime_payload,
        candidate_id=plan.request.candidate_id,
        hypothesis_id=plan.request.hypothesis_id,
        observed_stage=plan.request.observed_stage,
        window_start=plan.metrics.import_window_start,
        window_end=plan.metrics.import_window_end,
    )
    promotion_allowed = not blocking_reasons
    proof_status = "blocked" if proof_blockers else "ok"
    promotion = PromotionState(
        promotion_blocking_reasons=blocking_reasons,
        promotion_allowed=promotion_allowed,
        evidence_blocking_reasons=evidence_blocking_reasons,
        proof_blockers=proof_blockers,
        proof_status=proof_status,
        runtime_materialization_target={},
    )
    state_plan = replace(plan, promotion=promotion)
    return replace(
        promotion,
        runtime_materialization_target=runtime_materialization_target(
            state_plan,
            proof_status,
            proof_blockers,
            evidence_blocking_reasons,
            promotion_allowed,
        ),
    )


def _build_plan(request: PersistObservedRuntimeWindowsRequest) -> PersistencePlan:
    if request.observed_stage not in {"paper", "live"}:
        raise RuntimeError(f"invalid_observed_stage:{request.observed_stage}")
    context = _manifest_context(request)
    _ensure_hypothesis_records(request, context)
    buckets = _bucket_set(request)
    _maybe_add_dataset_snapshot(request, context, buckets)
    _delete_existing_governance_rows(request)
    replacements = _replace_runtime_ledger_rows(request, context, buckets)
    metrics = _aggregate_metrics(context, buckets)
    empty_promotion = PromotionState([], False, [], [], "ok", {})
    plan = PersistencePlan(
        request=request,
        context=context,
        buckets=buckets,
        replacements=replacements,
        metrics=metrics,
        promotion=empty_promotion,
    )
    return replace(plan, promotion=_promotion_state(plan))


def persist_observed_runtime_windows(**inputs: Any) -> dict[str, Any]:
    plan = _build_plan(_request_from_kwargs(inputs))
    rows = persist_governance_rows(plan)
    plan, runtime_import_readback, profit_distance_readback = finalize_materialization(
        plan,
        rows,
    )
    return final_summary(plan, runtime_import_readback, profit_distance_readback)
