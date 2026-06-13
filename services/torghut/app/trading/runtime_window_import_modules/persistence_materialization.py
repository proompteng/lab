"""Row builders and materialization readback for runtime-window persistence."""

from __future__ import annotations

from dataclasses import replace
from typing import Any, Mapping, Sequence, cast

from ...models import (
    StrategyCapitalAllocation,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    StrategyRuntimeLedgerBucket,
)

from .common import (
    ObservedRuntimeBucket,
    mapping_payload,
    observation_decimal,
    observation_int,
    optional_decimal,
    parse_observation_datetime,
    persisted_runtime_ledger_bucket_evidence_grade,
    string_list,
    text_value,
)
from .evidence_gates import (
    capital_multiplier_for_stage,
    capital_stage_for_runtime_import,
)
from .ledger_persistence import (
    journal_tigerbeetle_runtime_ledger_bucket,
    ledger_payload_with_tigerbeetle_refs,
    runtime_ledger_tigerbeetle_proof_refs,
)
from .observed_buckets import (
    runtime_ledger_bucket_payloads,
    runtime_window_import_readback_from_rows,
)
from .persistence_types import (
    MaterializationUpdate,
    PersistedRows,
    PersistencePlan,
)


def runtime_materialization_target(
    plan: PersistencePlan,
    proof_status: str,
    proof_blockers: Sequence[dict[str, Any]],
    evidence_blocking_reasons: Sequence[str],
    promotion_allowed: bool,
) -> dict[str, Any]:
    return {
        "candidate_id": plan.request.candidate_id,
        "hypothesis_id": plan.request.hypothesis_id,
        "observed_stage": plan.request.observed_stage,
        "strategy_family": plan.context.manifest.strategy_family,
        "account_label": text_value(plan.context.runtime_payload.get("account_label")),
        "strategy_name": text_value(plan.context.runtime_payload.get("strategy_name")),
        "window_start": plan.metrics.import_window_start.isoformat(),
        "window_end": plan.metrics.import_window_end.isoformat(),
        "runtime_ledger_profit_proof_present": bool(
            plan.context.runtime_payload.get("runtime_ledger_profit_proof_present")
        ),
        "runtime_ledger_notional_weighted_sample_count": (
            plan.metrics.runtime_ledger_sample_count
        ),
        "runtime_ledger_filled_notional": str(
            plan.metrics.runtime_ledger_filled_notional
        ),
        "runtime_ledger_net_strategy_pnl_after_costs": str(
            plan.metrics.runtime_ledger_net_strategy_pnl_after_costs
        ),
        "runtime_ledger_daily_summary": plan.metrics.runtime_ledger_daily_summary,
        "proof_status": proof_status,
        "proof_blockers": list(proof_blockers),
        "evidence_blocking_reasons": list(evidence_blocking_reasons),
        "capital_promotion_allowed": promotion_allowed,
        "capital_promotion_blocking_reasons": plan.promotion.promotion_blocking_reasons,
    }


def _metric_window_row(
    plan: PersistencePlan,
    bucket: ObservedRuntimeBucket,
    capital_stage: str,
) -> StrategyHypothesisMetricWindow:
    return StrategyHypothesisMetricWindow(
        run_id=plan.request.run_id,
        candidate_id=plan.request.candidate_id,
        hypothesis_id=plan.request.hypothesis_id,
        observed_stage=plan.request.observed_stage,
        window_started_at=bucket.window_started_at,
        window_ended_at=bucket.window_ended_at,
        market_session_count=bucket.market_session_count,
        decision_count=bucket.decision_count,
        trade_count=bucket.trade_count,
        order_count=bucket.order_count,
        evidence_provenance=plan.context.evidence_provenance,
        evidence_maturity="empirically_validated",
        decision_alignment_ratio=str(bucket.decision_alignment_ratio),
        avg_abs_slippage_bps=str(bucket.avg_abs_slippage_bps),
        slippage_budget_bps=str(plan.context.budget),
        post_cost_expectancy_bps=str(bucket.post_cost_expectancy_bps),
        continuity_ok=bucket.continuity_ok,
        drift_ok=bucket.drift_ok,
        dependency_quorum_decision=bucket.dependency_quorum_decision,
        capital_stage=capital_stage,
        payload_json={
            **bucket.payload_json,
            "source_manifest_ref": plan.request.source_manifest_ref
            or plan.context.registry.path,
            "runtime_observation": plan.context.runtime_payload,
        },
    )


def _runtime_ledger_row(
    plan: PersistencePlan,
    bucket: ObservedRuntimeBucket,
    ledger_payload: dict[str, Any],
) -> StrategyRuntimeLedgerBucket:
    bucket_started_at = (
        parse_observation_datetime(ledger_payload.get("bucket_started_at"))
        or bucket.window_started_at
    )
    bucket_ended_at = (
        parse_observation_datetime(ledger_payload.get("bucket_ended_at"))
        or bucket.window_ended_at
    )
    return StrategyRuntimeLedgerBucket(
        run_id=plan.request.run_id,
        candidate_id=plan.request.candidate_id,
        hypothesis_id=plan.request.hypothesis_id,
        observed_stage=plan.request.observed_stage,
        bucket_started_at=bucket_started_at,
        bucket_ended_at=bucket_ended_at,
        account_label=text_value(ledger_payload.get("account_label"))
        or text_value(plan.context.runtime_payload.get("account_label")),
        runtime_strategy_name=text_value(ledger_payload.get("strategy_id"))
        or text_value(plan.context.runtime_payload.get("strategy_name")),
        strategy_family=plan.context.manifest.strategy_family,
        fill_count=observation_int(ledger_payload.get("fill_count")),
        decision_count=observation_int(ledger_payload.get("decision_count")),
        submitted_order_count=observation_int(
            ledger_payload.get("submitted_order_count")
        ),
        cancelled_order_count=observation_int(
            ledger_payload.get("cancelled_order_count")
        ),
        rejected_order_count=observation_int(
            ledger_payload.get("rejected_order_count")
        ),
        unfilled_order_count=observation_int(
            ledger_payload.get("unfilled_order_count")
        ),
        closed_trade_count=observation_int(ledger_payload.get("closed_trade_count")),
        open_position_count=observation_int(ledger_payload.get("open_position_count")),
        filled_notional=observation_decimal(ledger_payload.get("filled_notional")),
        gross_strategy_pnl=observation_decimal(
            ledger_payload.get("gross_strategy_pnl")
        ),
        cost_amount=observation_decimal(ledger_payload.get("cost_amount")),
        net_strategy_pnl_after_costs=observation_decimal(
            ledger_payload.get("net_strategy_pnl_after_costs")
        ),
        post_cost_expectancy_bps=optional_decimal(
            ledger_payload.get("post_cost_expectancy_bps")
        ),
        ledger_schema_version=text_value(ledger_payload.get("ledger_schema_version"))
        or "unknown",
        pnl_basis=text_value(ledger_payload.get("pnl_basis")) or "unknown",
        execution_policy_hash_counts=mapping_payload(
            ledger_payload.get("execution_policy_hash_counts")
        )
        or None,
        cost_model_hash_counts=mapping_payload(
            ledger_payload.get("cost_model_hash_counts")
        )
        or None,
        lineage_hash_counts=mapping_payload(ledger_payload.get("lineage_hash_counts"))
        or None,
        blockers_json=string_list(ledger_payload.get("blockers")),
        payload_json={
            **ledger_payload,
            "runtime_ledger_daily_summary": plan.metrics.runtime_ledger_daily_summary,
        },
    )


def persist_governance_rows(plan: PersistencePlan) -> PersistedRows:
    metric_window_rows, runtime_ledger_rows = _persist_metric_and_ledger_rows(plan)
    final_capital_stage = _final_capital_stage(plan)
    _add_capital_allocation(plan, final_capital_stage)
    promotion_decision_row = _add_promotion_decision(plan, final_capital_stage)
    plan.request.session.flush()
    return PersistedRows(
        metric_window_rows=metric_window_rows,
        runtime_ledger_rows=runtime_ledger_rows,
        promotion_decision_row=promotion_decision_row,
    )


def _persist_metric_and_ledger_rows(
    plan: PersistencePlan,
) -> tuple[list[StrategyHypothesisMetricWindow], list[StrategyRuntimeLedgerBucket]]:
    metric_window_rows: list[StrategyHypothesisMetricWindow] = []
    runtime_ledger_rows: list[StrategyRuntimeLedgerBucket] = []
    running_session_samples = 0
    for bucket in plan.buckets.sorted_buckets:
        running_session_samples += bucket.market_session_count
        capital_stage = capital_stage_for_runtime_import(
            observed_stage=plan.request.observed_stage,
            promotion_allowed=plan.promotion.promotion_allowed,
            session_samples=running_session_samples,
            manifest=plan.context.manifest,
        )
        metric_row = _metric_window_row(plan, bucket, capital_stage)
        plan.request.session.add(metric_row)
        metric_window_rows.append(metric_row)
        runtime_ledger_rows.extend(_persist_bucket_ledger_rows(plan, bucket))
    return metric_window_rows, runtime_ledger_rows


def _persist_bucket_ledger_rows(
    plan: PersistencePlan,
    bucket: ObservedRuntimeBucket,
) -> list[StrategyRuntimeLedgerBucket]:
    rows: list[StrategyRuntimeLedgerBucket] = []
    for raw_ledger_payload in runtime_ledger_bucket_payloads(bucket.payload_json):
        ledger_payload = ledger_payload_with_tigerbeetle_refs(
            plan.request.session,
            raw_ledger_payload,
        )
        runtime_ledger_row = _runtime_ledger_row(plan, bucket, ledger_payload)
        plan.request.session.add(runtime_ledger_row)
        journal_tigerbeetle_runtime_ledger_bucket(
            plan.request.session,
            runtime_ledger_row,
        )
        rows.append(runtime_ledger_row)
    return rows


def _final_capital_stage(plan: PersistencePlan) -> str:
    return capital_stage_for_runtime_import(
        observed_stage=plan.request.observed_stage,
        promotion_allowed=plan.promotion.promotion_allowed,
        session_samples=plan.metrics.total_session_samples,
        manifest=plan.context.manifest,
    )


def _add_capital_allocation(plan: PersistencePlan, final_capital_stage: str) -> None:
    plan.request.session.add(
        StrategyCapitalAllocation(
            run_id=plan.request.run_id,
            candidate_id=plan.request.candidate_id,
            hypothesis_id=plan.request.hypothesis_id,
            prior_stage="shadow",
            stage=final_capital_stage,
            capital_multiplier=capital_multiplier_for_stage(final_capital_stage),
            rollback_target_stage="shadow",
            payload_json=_capital_allocation_payload(plan),
        )
    )


def _capital_allocation_payload(plan: PersistencePlan) -> dict[str, Any]:
    return {
        **_summary_payload(plan),
        **plan.metrics.runtime_ledger_daily_summary,
        "promotion_allowed": plan.promotion.promotion_allowed,
        "promotion_blocking_reasons": plan.promotion.promotion_blocking_reasons,
        "evidence_blocking_reasons": plan.promotion.evidence_blocking_reasons,
        "delay_adjusted_depth_stress": plan.context.delay_depth_stress_summary,
        "runtime_observation": plan.context.runtime_payload,
    }


def _promotion_decision_payload(plan: PersistencePlan) -> dict[str, Any]:
    return {
        **_summary_payload(plan),
        "avg_abs_slippage_bps": str(plan.metrics.average_slippage),
        "avg_post_cost_expectancy_bps": str(plan.metrics.average_post_cost),
        **plan.metrics.runtime_ledger_daily_summary,
        "latest_three_within_budget": plan.metrics.latest_three_budget_ok,
        "promotion_allowed": plan.promotion.promotion_allowed,
        "promotion_blocking_reasons": plan.promotion.promotion_blocking_reasons,
        "evidence_blocking_reasons": plan.promotion.evidence_blocking_reasons,
        "delay_adjusted_depth_stress": plan.context.delay_depth_stress_summary,
        "runtime_observation": plan.context.runtime_payload,
    }


def _summary_payload(plan: PersistencePlan) -> dict[str, Any]:
    return {
        "imported": True,
        "observed_stage": plan.request.observed_stage,
        "raw_window_count": plan.buckets.raw_window_count,
        "window_count": plan.metrics.inserted,
        "skipped_zero_activity_window_count": (
            plan.buckets.skipped_zero_activity_window_count
        ),
        "market_session_samples": plan.metrics.total_session_samples,
        "decision_count": plan.metrics.total_decision_count,
        "trade_count": plan.metrics.total_trade_count,
        "order_count": plan.metrics.total_order_count,
        "post_cost_promotion_sample_count": (
            plan.metrics.total_post_cost_promotion_sample_count
        ),
        "post_cost_basis_counts": plan.metrics.total_post_cost_basis_counts,
        "post_cost_expectancy_aggregation": plan.metrics.post_cost_expectancy_aggregation,
        "runtime_ledger_notional_weighted_sample_count": (
            plan.metrics.runtime_ledger_sample_count
        ),
        "runtime_ledger_filled_notional": str(
            plan.metrics.runtime_ledger_filled_notional
        ),
        "runtime_ledger_net_strategy_pnl_after_costs": str(
            plan.metrics.runtime_ledger_net_strategy_pnl_after_costs
        ),
    }


def _add_promotion_decision(
    plan: PersistencePlan,
    final_capital_stage: str,
) -> StrategyPromotionDecision:
    promotion_decision_row = StrategyPromotionDecision(
        run_id=plan.request.run_id,
        candidate_id=plan.request.candidate_id,
        hypothesis_id=plan.request.hypothesis_id,
        promotion_target=plan.request.observed_stage,
        state=final_capital_stage,
        allowed=plan.promotion.promotion_allowed,
        reason_summary=_reason_summary(plan),
        payload_json=_promotion_decision_payload(plan),
    )
    plan.request.session.add(promotion_decision_row)
    return promotion_decision_row


def _reason_summary(plan: PersistencePlan) -> str:
    if plan.promotion.promotion_allowed:
        return "runtime_evidence_thresholds_satisfied"
    return ",".join(plan.promotion.promotion_blocking_reasons)[:255]


def materialization_counts(
    plan: PersistencePlan,
    rows: PersistedRows,
) -> dict[str, Any]:
    evidence_grade_rows = evidence_grade_runtime_ledger_rows(rows)
    return {
        "metric_window_count": len(rows.metric_window_rows),
        "promotion_decision_count": 1,
        "runtime_ledger_bucket_count": len(rows.runtime_ledger_rows),
        "evidence_grade_runtime_ledger_bucket_count": len(evidence_grade_rows),
        "current_runtime_ledger_bucket_replacement_count": (
            plan.replacements.current_runtime_ledger_bucket_replacement_count
        ),
        "replaced_runtime_ledger_bucket_count": (
            plan.replacements.replaced_runtime_ledger_bucket_count
        ),
        "runtime_ledger_fill_count": sum(
            max(0, int(row.fill_count or 0)) for row in rows.runtime_ledger_rows
        ),
        "runtime_ledger_submitted_order_count": sum(
            max(0, int(row.submitted_order_count or 0))
            for row in rows.runtime_ledger_rows
        ),
        "runtime_ledger_closed_trade_count": sum(
            max(0, int(row.closed_trade_count or 0)) for row in rows.runtime_ledger_rows
        ),
        "runtime_ledger_open_position_count": sum(
            max(0, int(row.open_position_count or 0))
            for row in rows.runtime_ledger_rows
        ),
    }


def evidence_grade_runtime_ledger_rows(
    rows: PersistedRows,
) -> list[StrategyRuntimeLedgerBucket]:
    return [
        row
        for row in rows.runtime_ledger_rows
        if persisted_runtime_ledger_bucket_evidence_grade(row)
    ]


def materialization_blockers(
    plan: PersistencePlan,
    rows: PersistedRows,
) -> list[str]:
    blockers: list[str] = []
    if not rows.metric_window_rows:
        blockers.append("runtime_window_import_metric_window_missing")
    if plan.context.runtime_payload.get("runtime_ledger_profit_proof_present") is True:
        if not rows.runtime_ledger_rows:
            blockers.append("runtime_window_import_runtime_ledger_bucket_missing")
        if not evidence_grade_runtime_ledger_rows(rows):
            blockers.append(
                "runtime_window_import_evidence_grade_runtime_ledger_bucket_missing"
            )
    return blockers


def _materialization_blocker_payload(
    plan: PersistencePlan,
    blocker: str,
) -> dict[str, Any]:
    return {
        "blocker": blocker,
        "hypothesis_id": plan.request.hypothesis_id,
        "candidate_id": plan.request.candidate_id,
        "observed_stage": plan.request.observed_stage,
        "window_start": plan.metrics.import_window_start.isoformat(),
        "window_end": plan.metrics.import_window_end.isoformat(),
        "promotion_authority": text_value(
            plan.context.runtime_payload.get("promotion_authority")
        )
        or "unknown",
        "authority_reason": text_value(
            plan.context.runtime_payload.get("authority_reason")
        ),
        "runtime_ledger_profit_proof_present": bool(
            plan.context.runtime_payload.get("runtime_ledger_profit_proof_present")
        ),
        "remediation": (
            "Persist the scoped metric window, promotion decision, and "
            "evidence-grade runtime-ledger bucket before treating this "
            "runtime-window import target as proof."
        ),
    }


def append_materialization_blockers(
    plan: PersistencePlan,
    blockers: Sequence[str],
) -> list[dict[str, Any]]:
    proof_blockers = list(plan.promotion.proof_blockers)
    existing = {str(item.get("blocker")) for item in proof_blockers}
    for blocker in blockers:
        if blocker not in existing:
            proof_blockers.append(_materialization_blocker_payload(plan, blocker))
            existing.add(blocker)
    return proof_blockers


def runtime_import_readback(
    plan: PersistencePlan,
    rows: PersistedRows,
    proof_blockers: Sequence[dict[str, Any]],
) -> dict[str, Any]:
    return runtime_window_import_readback_from_rows(
        run_id=plan.request.run_id,
        candidate_id=plan.request.candidate_id,
        hypothesis_id=plan.request.hypothesis_id,
        observed_stage=plan.request.observed_stage,
        window_start=plan.metrics.import_window_start,
        window_end=plan.metrics.import_window_end,
        metric_rows=rows.metric_window_rows,
        promotion_rows=[rows.promotion_decision_row],
        ledger_rows=rows.runtime_ledger_rows,
        runtime_ledger_daily_summary=plan.metrics.runtime_ledger_daily_summary,
        proof_blocker_codes=[
            str(item.get("blocker"))
            for item in proof_blockers
            if str(item.get("blocker") or "").strip()
        ],
    )


def finalize_materialization(
    plan: PersistencePlan,
    rows: PersistedRows,
) -> tuple[PersistencePlan, dict[str, Any], dict[str, Any]]:
    blockers = materialization_blockers(plan, rows)
    proof_blockers = append_materialization_blockers(plan, blockers)
    proof_status = "blocked" if proof_blockers else "ok"
    readback = runtime_import_readback(plan, rows, proof_blockers)
    profit_distance_readback = cast(
        dict[str, Any],
        readback.get("runtime_ledger_profit_distance_readback") or {},
    )
    rows.promotion_decision_row.payload_json = {
        **mapping_payload(rows.promotion_decision_row.payload_json),
        "runtime_ledger_profit_distance_readback": profit_distance_readback,
    }
    plan.promotion.runtime_materialization_target.update(
        materialization_target_update(
            plan,
            rows,
            MaterializationUpdate(
                proof_status=proof_status,
                proof_blockers=proof_blockers,
                materialization_blockers=blockers,
                runtime_import_readback=readback,
                profit_distance_readback=profit_distance_readback,
            ),
        )
    )
    updated_plan = replace(
        plan,
        promotion=replace(
            plan.promotion,
            proof_blockers=proof_blockers,
            proof_status=proof_status,
        ),
    )
    return updated_plan, readback, profit_distance_readback


def materialization_target_update(
    plan: PersistencePlan,
    rows: PersistedRows,
    update: MaterializationUpdate,
) -> dict[str, Any]:
    evidence_grade_rows = evidence_grade_runtime_ledger_rows(rows)
    tigerbeetle_proof_refs = runtime_ledger_tigerbeetle_proof_refs(
        rows.runtime_ledger_rows
    )
    return {
        "proof_status": update.proof_status,
        "proof_blockers": list(update.proof_blockers),
        "materialized": not update.proof_blockers,
        "materialization_blockers": list(update.materialization_blockers),
        "readback": dict(update.runtime_import_readback),
        "runtime_ledger_profit_distance_readback": dict(
            update.profit_distance_readback
        ),
        **materialization_counts(plan, rows),
        "metric_window_ids": [str(row.id) for row in rows.metric_window_rows],
        "promotion_decision_id": str(rows.promotion_decision_row.id),
        "runtime_ledger_bucket_ids": [str(row.id) for row in rows.runtime_ledger_rows],
        "evidence_grade_runtime_ledger_bucket_ids": [
            str(row.id) for row in evidence_grade_rows
        ],
        **({"tigerbeetle": tigerbeetle_proof_refs} if tigerbeetle_proof_refs else {}),
        "replaced_runtime_ledger_bucket_count": (
            plan.replacements.replaced_runtime_ledger_bucket_count
        ),
        "current_runtime_ledger_bucket_replacement_count": (
            plan.replacements.current_runtime_ledger_bucket_replacement_count
        ),
    }


def final_summary(
    plan: PersistencePlan,
    runtime_import_readback: Mapping[str, Any],
    profit_distance_readback: Mapping[str, Any],
) -> dict[str, Any]:
    return {
        "run_id": plan.request.run_id,
        "candidate_id": plan.request.candidate_id,
        "hypothesis_id": plan.request.hypothesis_id,
        "observed_stage": plan.request.observed_stage,
        "raw_window_count": plan.buckets.raw_window_count,
        "window_count": plan.metrics.inserted,
        "skipped_zero_activity_window_count": (
            plan.buckets.skipped_zero_activity_window_count
        ),
        "market_session_samples": plan.metrics.total_session_samples,
        "decision_count": plan.metrics.total_decision_count,
        "trade_count": plan.metrics.total_trade_count,
        "order_count": plan.metrics.total_order_count,
        "post_cost_promotion_sample_count": (
            plan.metrics.total_post_cost_promotion_sample_count
        ),
        "post_cost_basis_counts": plan.metrics.total_post_cost_basis_counts,
        "avg_abs_slippage_bps": str(plan.metrics.average_slippage),
        "avg_post_cost_expectancy_bps": str(plan.metrics.average_post_cost),
        "post_cost_expectancy_aggregation": plan.metrics.post_cost_expectancy_aggregation,
        "runtime_ledger_notional_weighted_sample_count": (
            plan.metrics.runtime_ledger_sample_count
        ),
        "runtime_ledger_filled_notional": str(
            plan.metrics.runtime_ledger_filled_notional
        ),
        "runtime_ledger_net_strategy_pnl_after_costs": str(
            plan.metrics.runtime_ledger_net_strategy_pnl_after_costs
        ),
        "runtime_ledger_profit_distance_readback": dict(profit_distance_readback),
        **plan.metrics.runtime_ledger_daily_summary,
        "latest_three_within_budget": plan.metrics.latest_three_budget_ok,
        "slippage_budget_bps": str(plan.context.budget),
        "promotion_allowed": plan.promotion.promotion_allowed,
        "promotion_blocking_reasons": plan.promotion.promotion_blocking_reasons,
        "evidence_blocking_reasons": plan.promotion.evidence_blocking_reasons,
        "proof_status": plan.promotion.proof_status,
        "proof_blockers": plan.promotion.proof_blockers,
        "current_runtime_ledger_bucket_replacement_count": (
            plan.replacements.current_runtime_ledger_bucket_replacement_count
        ),
        "replaced_runtime_ledger_bucket_count": (
            plan.replacements.replaced_runtime_ledger_bucket_count
        ),
        "runtime_window_import_readback": dict(runtime_import_readback),
        "runtime_materialization_target": plan.promotion.runtime_materialization_target,
        "runtime_observation": plan.context.runtime_payload,
        "delay_adjusted_depth_stress": plan.context.delay_depth_stress_summary,
    }
