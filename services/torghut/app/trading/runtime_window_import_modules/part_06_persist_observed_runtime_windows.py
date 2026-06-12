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
from .part_02_delay_adjusted_depth_stress_blocking_reaso import *
from .part_03_build_observed_runtime_buckets import *
from .part_04_runtime_ledger_bucket_replacement_scopes import *
from .part_05_runtime_ledger_daily_summary_from_observed import *


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
    delay_depth_stress_summary = _delay_adjusted_depth_stress_summary(runtime_payload)
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
    raw_buckets = sorted(buckets, key=lambda item: item.window_ended_at)
    sorted_buckets = [
        bucket
        for bucket in raw_buckets
        if bucket.decision_count > 0 or bucket.trade_count > 0 or bucket.order_count > 0
    ]
    runtime_ledger_replacement_scopes = _runtime_ledger_bucket_replacement_scopes(
        buckets=sorted_buckets,
        runtime_payload=runtime_payload,
    )
    current_runtime_ledger_bucket_replacement_count = (
        _delete_current_runtime_ledger_buckets(
            session=session,
            run_id=run_id,
            candidate_id=candidate_id,
            hypothesis_id=hypothesis_id,
            observed_stage=observed_stage,
            replacement_scopes=runtime_ledger_replacement_scopes,
        )
    )
    replaced_runtime_ledger_bucket_count = _delete_replaced_runtime_ledger_buckets(
        session=session,
        run_id=run_id,
        candidate_id=candidate_id,
        hypothesis_id=hypothesis_id,
        observed_stage=observed_stage,
        replacement_scopes=runtime_ledger_replacement_scopes,
    )
    raw_window_count = len(raw_buckets)
    skipped_zero_activity_window_count = raw_window_count - len(sorted_buckets)
    runtime_ledger_daily_summary = _runtime_ledger_daily_summary_from_observed_buckets(
        raw_buckets
    )
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
    total_post_cost_promotion_sample_count = sum(
        bucket.post_cost_promotion_sample_count for bucket in sorted_buckets
    )
    total_post_cost_basis_counter: Counter[str] = Counter()
    for bucket in sorted_buckets:
        total_post_cost_basis_counter.update(bucket.post_cost_basis_counts)
    total_post_cost_basis_counts = dict(sorted(total_post_cost_basis_counter.items()))
    latest_three_budget_ok = (
        all(bucket.avg_abs_slippage_bps <= budget for bucket in sorted_buckets[-3:])
        if sorted_buckets
        else False
    )
    all_continuity_ok = (
        all(bucket.continuity_ok for bucket in sorted_buckets)
        if sorted_buckets
        else False
    )
    all_drift_ok = (
        all(bucket.drift_ok for bucket in sorted_buckets) if sorted_buckets else False
    )
    dependency_quorum_allowed = (
        all(
            str(bucket.dependency_quorum_decision or "").strip().lower() == "allow"
            for bucket in sorted_buckets
        )
        if sorted_buckets
        else False
    )
    (
        runtime_ledger_average_post_cost,
        runtime_ledger_net_strategy_pnl_after_costs,
        runtime_ledger_filled_notional,
        runtime_ledger_sample_count,
    ) = _runtime_ledger_post_cost_from_observed_buckets(sorted_buckets)
    if runtime_ledger_average_post_cost is not None:
        average_post_cost = runtime_ledger_average_post_cost
        post_cost_expectancy_aggregation = "runtime_ledger_notional_weighted"
    else:
        average_post_cost = Decimal("0")
        post_cost_expectancy_aggregation = "no_runtime_ledger_post_cost_rows"
    runtime_ledger_promotion_gate_targets = _runtime_ledger_authority_gate_targets(
        average_post_cost_bps=average_post_cost
    )
    runtime_ledger_daily_summary = {
        **runtime_ledger_daily_summary,
        "runtime_ledger_promotion_gate_targets": runtime_ledger_promotion_gate_targets,
    }
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
        observed_stage=observed_stage,
        inserted=inserted,
        total_session_samples=total_session_samples,
        total_decision_count=total_decision_count,
        total_trade_count=total_trade_count,
        total_order_count=total_order_count,
        total_post_cost_promotion_sample_count=total_post_cost_promotion_sample_count,
        runtime_ledger_notional_weighted_sample_count=runtime_ledger_sample_count,
        total_post_cost_basis_counts=total_post_cost_basis_counts,
        average_slippage=average_slippage,
        average_post_cost=average_post_cost,
        runtime_ledger_daily_summary=runtime_ledger_daily_summary,
        latest_three_budget_ok=latest_three_budget_ok,
        all_continuity_ok=all_continuity_ok,
        all_drift_ok=all_drift_ok,
        dependency_quorum_allowed=dependency_quorum_allowed,
        manifest=manifest,
        budget=budget,
    )
    latest_observation_at = max(
        (bucket.window_ended_at for bucket in sorted_buckets),
        default=max(
            (bucket.window_ended_at for bucket in raw_buckets),
            default=datetime.now(timezone.utc),
        ),
    )
    import_window_start = min(
        (bucket.window_started_at for bucket in raw_buckets),
        default=latest_observation_at,
    )
    import_window_end = max(
        (bucket.window_ended_at for bucket in raw_buckets),
        default=latest_observation_at,
    )
    promotion_blocking_reasons = list(
        dict.fromkeys(
            [
                *promotion_blocking_reasons,
                *_paper_probation_blocking_reasons(runtime_payload),
                *_delay_adjusted_depth_stress_blocking_reasons(
                    manifest=manifest,
                    runtime_payload=runtime_payload,
                    now=latest_observation_at,
                ),
            ]
        )
    )
    promotion_allowed = not promotion_blocking_reasons
    evidence_blocking_reasons = _runtime_window_import_evidence_blocking_reasons(
        promotion_blocking_reasons
    )
    proof_blockers = _runtime_window_import_proof_blockers(
        promotion_blocking_reasons=evidence_blocking_reasons,
        runtime_payload=runtime_payload,
        candidate_id=candidate_id,
        hypothesis_id=hypothesis_id,
        observed_stage=observed_stage,
        window_start=import_window_start,
        window_end=import_window_end,
    )
    proof_status = "blocked" if proof_blockers else "ok"
    runtime_materialization_target: dict[str, Any] = {
        "candidate_id": candidate_id,
        "hypothesis_id": hypothesis_id,
        "observed_stage": observed_stage,
        "strategy_family": manifest.strategy_family,
        "account_label": _text(runtime_payload.get("account_label")),
        "strategy_name": _text(runtime_payload.get("strategy_name")),
        "window_start": import_window_start.isoformat(),
        "window_end": import_window_end.isoformat(),
        "runtime_ledger_profit_proof_present": bool(
            runtime_payload.get("runtime_ledger_profit_proof_present")
        ),
        "runtime_ledger_notional_weighted_sample_count": runtime_ledger_sample_count,
        "runtime_ledger_filled_notional": str(runtime_ledger_filled_notional),
        "runtime_ledger_net_strategy_pnl_after_costs": str(
            runtime_ledger_net_strategy_pnl_after_costs
        ),
        "runtime_ledger_daily_summary": runtime_ledger_daily_summary,
        "proof_status": proof_status,
        "proof_blockers": proof_blockers,
        "evidence_blocking_reasons": evidence_blocking_reasons,
        "capital_promotion_allowed": promotion_allowed,
        "capital_promotion_blocking_reasons": promotion_blocking_reasons,
    }
    metric_window_rows: list[StrategyHypothesisMetricWindow] = []
    runtime_ledger_rows: list[StrategyRuntimeLedgerBucket] = []
    running_session_samples = 0
    for bucket in sorted_buckets:
        running_session_samples += bucket.market_session_count
        capital_stage = _capital_stage_for_runtime_import(
            observed_stage=observed_stage,
            promotion_allowed=promotion_allowed,
            session_samples=running_session_samples,
            manifest=manifest,
        )
        metric_window_row = StrategyHypothesisMetricWindow(
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
        session.add(metric_window_row)
        metric_window_rows.append(metric_window_row)
        for raw_ledger_payload in _runtime_ledger_bucket_payloads(bucket.payload_json):
            ledger_payload = _ledger_payload_with_tigerbeetle_refs(
                session,
                raw_ledger_payload,
            )
            bucket_started_at = (
                _parse_observation_datetime(ledger_payload.get("bucket_started_at"))
                or bucket.window_started_at
            )
            bucket_ended_at = (
                _parse_observation_datetime(ledger_payload.get("bucket_ended_at"))
                or bucket.window_ended_at
            )
            runtime_ledger_row = StrategyRuntimeLedgerBucket(
                run_id=run_id,
                candidate_id=candidate_id,
                hypothesis_id=hypothesis_id,
                observed_stage=observed_stage,
                bucket_started_at=bucket_started_at,
                bucket_ended_at=bucket_ended_at,
                account_label=_text(ledger_payload.get("account_label"))
                or _text(runtime_payload.get("account_label")),
                runtime_strategy_name=_text(ledger_payload.get("strategy_id"))
                or _text(runtime_payload.get("strategy_name")),
                strategy_family=manifest.strategy_family,
                fill_count=_observation_int(ledger_payload.get("fill_count")),
                decision_count=_observation_int(ledger_payload.get("decision_count")),
                submitted_order_count=_observation_int(
                    ledger_payload.get("submitted_order_count")
                ),
                cancelled_order_count=_observation_int(
                    ledger_payload.get("cancelled_order_count")
                ),
                rejected_order_count=_observation_int(
                    ledger_payload.get("rejected_order_count")
                ),
                unfilled_order_count=_observation_int(
                    ledger_payload.get("unfilled_order_count")
                ),
                closed_trade_count=_observation_int(
                    ledger_payload.get("closed_trade_count")
                ),
                open_position_count=_observation_int(
                    ledger_payload.get("open_position_count")
                ),
                filled_notional=_observation_decimal(
                    ledger_payload.get("filled_notional")
                ),
                gross_strategy_pnl=_observation_decimal(
                    ledger_payload.get("gross_strategy_pnl")
                ),
                cost_amount=_observation_decimal(ledger_payload.get("cost_amount")),
                net_strategy_pnl_after_costs=_observation_decimal(
                    ledger_payload.get("net_strategy_pnl_after_costs")
                ),
                post_cost_expectancy_bps=_optional_decimal(
                    ledger_payload.get("post_cost_expectancy_bps")
                ),
                ledger_schema_version=_text(ledger_payload.get("ledger_schema_version"))
                or "unknown",
                pnl_basis=_text(ledger_payload.get("pnl_basis")) or "unknown",
                execution_policy_hash_counts=_mapping(
                    ledger_payload.get("execution_policy_hash_counts")
                )
                or None,
                cost_model_hash_counts=_mapping(
                    ledger_payload.get("cost_model_hash_counts")
                )
                or None,
                lineage_hash_counts=_mapping(ledger_payload.get("lineage_hash_counts"))
                or None,
                blockers_json=_string_list(ledger_payload.get("blockers")),
                payload_json={
                    **ledger_payload,
                    "runtime_ledger_daily_summary": runtime_ledger_daily_summary,
                },
            )
            session.add(runtime_ledger_row)
            _journal_tigerbeetle_runtime_ledger_bucket(session, runtime_ledger_row)
            runtime_ledger_rows.append(runtime_ledger_row)

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
                "raw_window_count": raw_window_count,
                "window_count": inserted,
                "skipped_zero_activity_window_count": skipped_zero_activity_window_count,
                "market_session_samples": total_session_samples,
                "decision_count": total_decision_count,
                "trade_count": total_trade_count,
                "order_count": total_order_count,
                "post_cost_promotion_sample_count": total_post_cost_promotion_sample_count,
                "post_cost_basis_counts": total_post_cost_basis_counts,
                "post_cost_expectancy_aggregation": post_cost_expectancy_aggregation,
                "runtime_ledger_notional_weighted_sample_count": runtime_ledger_sample_count,
                "runtime_ledger_filled_notional": str(runtime_ledger_filled_notional),
                "runtime_ledger_net_strategy_pnl_after_costs": str(
                    runtime_ledger_net_strategy_pnl_after_costs
                ),
                **runtime_ledger_daily_summary,
                "promotion_allowed": promotion_allowed,
                "promotion_blocking_reasons": promotion_blocking_reasons,
                "evidence_blocking_reasons": evidence_blocking_reasons,
                "delay_adjusted_depth_stress": delay_depth_stress_summary,
                "runtime_observation": runtime_payload,
            },
        )
    )
    promotion_decision_row = StrategyPromotionDecision(
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
            "raw_window_count": raw_window_count,
            "window_count": inserted,
            "skipped_zero_activity_window_count": skipped_zero_activity_window_count,
            "market_session_samples": total_session_samples,
            "decision_count": total_decision_count,
            "trade_count": total_trade_count,
            "order_count": total_order_count,
            "post_cost_promotion_sample_count": total_post_cost_promotion_sample_count,
            "post_cost_basis_counts": total_post_cost_basis_counts,
            "avg_abs_slippage_bps": str(average_slippage),
            "avg_post_cost_expectancy_bps": str(average_post_cost),
            "post_cost_expectancy_aggregation": post_cost_expectancy_aggregation,
            "runtime_ledger_notional_weighted_sample_count": runtime_ledger_sample_count,
            "runtime_ledger_filled_notional": str(runtime_ledger_filled_notional),
            "runtime_ledger_net_strategy_pnl_after_costs": str(
                runtime_ledger_net_strategy_pnl_after_costs
            ),
            **runtime_ledger_daily_summary,
            "latest_three_within_budget": latest_three_budget_ok,
            "promotion_allowed": promotion_allowed,
            "promotion_blocking_reasons": promotion_blocking_reasons,
            "evidence_blocking_reasons": evidence_blocking_reasons,
            "delay_adjusted_depth_stress": delay_depth_stress_summary,
            "runtime_observation": runtime_payload,
        },
    )
    session.add(promotion_decision_row)
    session.flush()
    evidence_grade_runtime_ledger_rows = [
        row
        for row in runtime_ledger_rows
        if _persisted_runtime_ledger_bucket_evidence_grade(row)
    ]
    materialization_counts = {
        "metric_window_count": len(metric_window_rows),
        "promotion_decision_count": 1,
        "runtime_ledger_bucket_count": len(runtime_ledger_rows),
        "evidence_grade_runtime_ledger_bucket_count": len(
            evidence_grade_runtime_ledger_rows
        ),
        "current_runtime_ledger_bucket_replacement_count": (
            current_runtime_ledger_bucket_replacement_count
        ),
        "replaced_runtime_ledger_bucket_count": replaced_runtime_ledger_bucket_count,
        "runtime_ledger_fill_count": sum(
            max(0, int(row.fill_count or 0)) for row in runtime_ledger_rows
        ),
        "runtime_ledger_submitted_order_count": sum(
            max(0, int(row.submitted_order_count or 0)) for row in runtime_ledger_rows
        ),
        "runtime_ledger_closed_trade_count": sum(
            max(0, int(row.closed_trade_count or 0)) for row in runtime_ledger_rows
        ),
        "runtime_ledger_open_position_count": sum(
            max(0, int(row.open_position_count or 0)) for row in runtime_ledger_rows
        ),
    }
    materialization_blockers: list[str] = []
    if not metric_window_rows:
        materialization_blockers.append("runtime_window_import_metric_window_missing")
    if runtime_payload.get("runtime_ledger_profit_proof_present") is True:
        if not runtime_ledger_rows:
            materialization_blockers.append(
                "runtime_window_import_runtime_ledger_bucket_missing"
            )
        if not evidence_grade_runtime_ledger_rows:
            materialization_blockers.append(
                "runtime_window_import_evidence_grade_runtime_ledger_bucket_missing"
            )
    for blocker in materialization_blockers:
        if blocker not in {str(item.get("blocker")) for item in proof_blockers}:
            proof_blockers.append(
                {
                    "blocker": blocker,
                    "hypothesis_id": hypothesis_id,
                    "candidate_id": candidate_id,
                    "observed_stage": observed_stage,
                    "window_start": import_window_start.isoformat(),
                    "window_end": import_window_end.isoformat(),
                    "promotion_authority": _text(
                        runtime_payload.get("promotion_authority")
                    )
                    or "unknown",
                    "authority_reason": _text(runtime_payload.get("authority_reason")),
                    "runtime_ledger_profit_proof_present": bool(
                        runtime_payload.get("runtime_ledger_profit_proof_present")
                    ),
                    "remediation": (
                        "Persist the scoped metric window, promotion decision, and "
                        "evidence-grade runtime-ledger bucket before treating this "
                        "runtime-window import target as proof."
                    ),
                }
            )
    proof_status = "blocked" if proof_blockers else "ok"
    tigerbeetle_proof_refs = _runtime_ledger_tigerbeetle_proof_refs(runtime_ledger_rows)
    # Build readback from flushed rows in the current unit of work instead of
    # re-querying broad governance tables before commit. Large SIM ledgers can
    # make those scans slow enough for the import job to be killed, rolling back
    # otherwise-valid source-backed buckets to zero durable rows.
    runtime_import_readback = _runtime_window_import_readback_from_rows(
        run_id=run_id,
        candidate_id=candidate_id,
        hypothesis_id=hypothesis_id,
        observed_stage=observed_stage,
        window_start=import_window_start,
        window_end=import_window_end,
        metric_rows=metric_window_rows,
        promotion_rows=[promotion_decision_row],
        ledger_rows=runtime_ledger_rows,
        runtime_ledger_daily_summary=runtime_ledger_daily_summary,
        proof_blocker_codes=[
            str(item.get("blocker"))
            for item in proof_blockers
            if str(item.get("blocker") or "").strip()
        ],
    )
    runtime_ledger_profit_distance_readback = cast(
        dict[str, Any],
        runtime_import_readback.get("runtime_ledger_profit_distance_readback") or {},
    )
    promotion_decision_row.payload_json = {
        **_mapping(promotion_decision_row.payload_json),
        "runtime_ledger_profit_distance_readback": (
            runtime_ledger_profit_distance_readback
        ),
    }
    runtime_materialization_target.update(
        {
            "proof_status": proof_status,
            "proof_blockers": proof_blockers,
            "materialized": not proof_blockers,
            "materialization_blockers": materialization_blockers,
            "readback": runtime_import_readback,
            "runtime_ledger_profit_distance_readback": (
                runtime_ledger_profit_distance_readback
            ),
            **materialization_counts,
            "metric_window_ids": [str(row.id) for row in metric_window_rows],
            "promotion_decision_id": str(promotion_decision_row.id),
            "runtime_ledger_bucket_ids": [str(row.id) for row in runtime_ledger_rows],
            "evidence_grade_runtime_ledger_bucket_ids": [
                str(row.id) for row in evidence_grade_runtime_ledger_rows
            ],
            **(
                {"tigerbeetle": tigerbeetle_proof_refs}
                if tigerbeetle_proof_refs
                else {}
            ),
            "replaced_runtime_ledger_bucket_count": (
                replaced_runtime_ledger_bucket_count
            ),
            "current_runtime_ledger_bucket_replacement_count": (
                current_runtime_ledger_bucket_replacement_count
            ),
        }
    )
    return {
        "run_id": run_id,
        "candidate_id": candidate_id,
        "hypothesis_id": hypothesis_id,
        "observed_stage": observed_stage,
        "raw_window_count": raw_window_count,
        "window_count": inserted,
        "skipped_zero_activity_window_count": skipped_zero_activity_window_count,
        "market_session_samples": total_session_samples,
        "decision_count": total_decision_count,
        "trade_count": total_trade_count,
        "order_count": total_order_count,
        "post_cost_promotion_sample_count": total_post_cost_promotion_sample_count,
        "post_cost_basis_counts": total_post_cost_basis_counts,
        "avg_abs_slippage_bps": str(average_slippage),
        "avg_post_cost_expectancy_bps": str(average_post_cost),
        "post_cost_expectancy_aggregation": post_cost_expectancy_aggregation,
        "runtime_ledger_notional_weighted_sample_count": runtime_ledger_sample_count,
        "runtime_ledger_filled_notional": str(runtime_ledger_filled_notional),
        "runtime_ledger_net_strategy_pnl_after_costs": str(
            runtime_ledger_net_strategy_pnl_after_costs
        ),
        "runtime_ledger_profit_distance_readback": (
            runtime_ledger_profit_distance_readback
        ),
        **runtime_ledger_daily_summary,
        "latest_three_within_budget": latest_three_budget_ok,
        "slippage_budget_bps": str(budget),
        "promotion_allowed": promotion_allowed,
        "promotion_blocking_reasons": promotion_blocking_reasons,
        "evidence_blocking_reasons": evidence_blocking_reasons,
        "proof_status": proof_status,
        "proof_blockers": proof_blockers,
        "current_runtime_ledger_bucket_replacement_count": (
            current_runtime_ledger_bucket_replacement_count
        ),
        "replaced_runtime_ledger_bucket_count": replaced_runtime_ledger_bucket_count,
        "runtime_window_import_readback": runtime_import_readback,
        "runtime_materialization_target": runtime_materialization_target,
        "runtime_observation": runtime_payload,
        "delay_adjusted_depth_stress": delay_depth_stress_summary,
    }


__all__ = [name for name in globals() if not name.startswith("__")]
