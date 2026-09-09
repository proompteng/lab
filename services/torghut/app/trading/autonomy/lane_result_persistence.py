"""Autonomous lane result persistence helpers."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, cast

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ...models import (
    ResearchAttempt,
    ResearchCandidate,
    ResearchCostCalibration,
    ResearchFoldMetrics,
    ResearchPromotion,
    ResearchRun,
    ResearchSequentialTrial,
    ResearchStressMetrics,
    ResearchValidationTest,
    StrategyCapitalAllocation,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    VNextDatasetSnapshot,
    VNextExperimentRun,
    VNextExperimentSpec,
    VNextFeatureViewSpec,
    VNextModelArtifact,
    VNextPromotionDecision,
    VNextShadowLiveDeviation,
    VNextSimulationCalibration,
)
from ..evaluation import WalkForwardResults
from ..models import SignalEnvelope
from ..reporting import EvaluationReport, PromotionRecommendation
from .lane_config_loading import (
    build_stress_bundle as _build_stress_bundle,
    metric_counter_int as _metric_counter_int,
    strategy_parameter_set as _strategy_parameter_set,
    strategy_universe_definition as _strategy_universe_definition,
)
from .lane_persistence import (
    persist_vnext_objects as _persist_vnext_objects,
    trace_id as _trace_id,
)
from .lane_phase_payloads import coerce_str as _coerce_str
from .lane_regime_artifacts import decimal_or_none as _decimal_or_none
from .lane_stage_artifacts import (
    artifact_authority_for_evidence as _artifact_authority_for_evidence,
    load_json_if_exists as _load_json_if_exists,
)
from .runtime import StrategyRuntimeConfig


def _persist_run_outputs_if_requested(
    *,
    persist_results: bool,
    session_factory: Callable[[], Session],
    run_id: str,
    candidate_id: str,
    candidate_hash: str,
    runtime_strategies: list[StrategyRuntimeConfig],
    signals: list[SignalEnvelope],
    walk_results: WalkForwardResults,
    report: EvaluationReport,
    candidate_spec_path: Path,
    evaluation_report_path: Path,
    gate_report_path: Path,
    actuation_intent_path: Path | None,
    patch_path: Path | None,
    now: datetime,
    promotion_target: str,
    actuation_allowed: bool,
    promotion_allowed: bool,
    promotion_reasons: list[str],
    promotion_recommendation: PromotionRecommendation,
    fold_metrics_count: int,
    stress_metrics_count: int,
    gate_report_trace_id: str,
    recommendation_trace_id: str,
    stage_trace_ids: dict[str, str],
    stage_lineage_payload: dict[str, Any],
    stage_manifest_refs: dict[str, str],
    replay_artifact_hashes: dict[str, str],
    simulation_calibration_report_payload: dict[str, Any],
    shadow_live_deviation_report_payload: dict[str, Any],
) -> None:
    if not persist_results:
        return
    _persist_run_outputs(
        session_factory=session_factory,
        run_id=run_id,
        candidate_id=candidate_id,
        candidate_hash=candidate_hash,
        runtime_strategies=runtime_strategies,
        signals=signals,
        walk_results=walk_results,
        report=report,
        candidate_spec_path=candidate_spec_path,
        evaluation_report_path=evaluation_report_path,
        gate_report_path=gate_report_path,
        actuation_intent_path=actuation_intent_path,
        patch_path=patch_path,
        now=now,
        promotion_target=promotion_target,
        actuation_allowed=actuation_allowed,
        promotion_allowed=promotion_allowed,
        promotion_reasons=promotion_reasons,
        promotion_recommendation=promotion_recommendation,
        fold_metrics_count=fold_metrics_count,
        stress_metrics_count=stress_metrics_count,
        gate_report_trace_id=gate_report_trace_id,
        recommendation_trace_id=recommendation_trace_id,
        stage_trace_ids=stage_trace_ids,
        stage_lineage_payload=stage_lineage_payload,
        stage_manifest_refs=stage_manifest_refs,
        replay_artifact_hashes=replay_artifact_hashes,
        simulation_calibration_report_payload=simulation_calibration_report_payload,
        shadow_live_deviation_report_payload=shadow_live_deviation_report_payload,
    )


def _persist_run_outputs(
    *,
    session_factory: Callable[[], Session],
    run_id: str,
    candidate_id: str,
    candidate_hash: str,
    runtime_strategies: list[StrategyRuntimeConfig],
    signals: list[SignalEnvelope],
    walk_results: WalkForwardResults,
    report: EvaluationReport,
    candidate_spec_path: Path,
    evaluation_report_path: Path,
    gate_report_path: Path,
    actuation_intent_path: Path | None,
    patch_path: Path | None,
    now: datetime,
    promotion_target: str,
    actuation_allowed: bool,
    promotion_allowed: bool,
    promotion_reasons: list[str],
    promotion_recommendation: PromotionRecommendation,
    fold_metrics_count: int,
    stress_metrics_count: int,
    gate_report_trace_id: str,
    recommendation_trace_id: str,
    stage_trace_ids: dict[str, str],
    stage_lineage_payload: dict[str, Any],
    stage_manifest_refs: dict[str, str],
    replay_artifact_hashes: dict[str, str],
    simulation_calibration_report_payload: dict[str, Any],
    shadow_live_deviation_report_payload: dict[str, Any],
) -> None:
    robustness_by_fold = {fold.fold_name: fold for fold in report.robustness.folds}
    effective_promotion_allowed = bool(promotion_allowed and actuation_allowed)
    candidate_spec_payload = _load_json_if_exists(candidate_spec_path) or {}
    candidate_dependency_quorum_payload = (
        cast(dict[str, Any], candidate_spec_payload.get("dependency_quorum"))
        if isinstance(candidate_spec_payload.get("dependency_quorum"), dict)
        else {}
    )
    candidate_alpha_readiness_payload = (
        cast(dict[str, Any], candidate_spec_payload.get("alpha_readiness"))
        if isinstance(candidate_spec_payload.get("alpha_readiness"), dict)
        else {}
    )
    strategy_factory_payload = (
        cast(dict[str, Any], candidate_spec_payload.get("strategy_factory"))
        if isinstance(candidate_spec_payload.get("strategy_factory"), dict)
        else {}
    )
    strategy_factory_attempt_payload = (
        cast(dict[str, Any], strategy_factory_payload.get("attempt_ledger"))
        if isinstance(strategy_factory_payload.get("attempt_ledger"), dict)
        else {}
    )
    strategy_factory_cost_calibration_payload = (
        cast(dict[str, Any], strategy_factory_payload.get("cost_calibration"))
        if isinstance(strategy_factory_payload.get("cost_calibration"), dict)
        else {}
    )
    strategy_factory_sequential_payload = (
        cast(dict[str, Any], strategy_factory_payload.get("sequential_trial"))
        if isinstance(strategy_factory_payload.get("sequential_trial"), dict)
        else {}
    )
    strategy_factory_validation_payloads = [
        cast(dict[str, Any], item)
        for item in cast(
            list[Any], strategy_factory_payload.get("validation_tests", [])
        )
        if isinstance(item, dict)
    ]

    with session_factory() as session:
        with session.begin():
            existing_champion = (
                session.execute(
                    select(ResearchCandidate)
                    .where(
                        ResearchCandidate.lifecycle_role == "champion",
                        ResearchCandidate.lifecycle_status == "active",
                        ResearchCandidate.promotion_target == promotion_target,
                        ResearchCandidate.candidate_id != candidate_id,
                    )
                    .order_by(ResearchCandidate.created_at.desc())
                )
                .scalars()
                .first()
            )
            session.execute(
                delete(ResearchFoldMetrics).where(
                    ResearchFoldMetrics.candidate_id == candidate_id
                )
            )
            session.execute(
                delete(ResearchAttempt).where(ResearchAttempt.run_id == run_id)
            )
            session.execute(
                delete(ResearchValidationTest).where(
                    ResearchValidationTest.candidate_id == candidate_id
                )
            )
            session.execute(
                delete(ResearchSequentialTrial).where(
                    ResearchSequentialTrial.candidate_id == candidate_id
                )
            )
            session.execute(
                delete(ResearchStressMetrics).where(
                    ResearchStressMetrics.candidate_id == candidate_id
                )
            )
            session.execute(
                delete(ResearchCandidate).where(
                    ResearchCandidate.candidate_id == candidate_id
                )
            )
            session.execute(
                delete(VNextDatasetSnapshot).where(
                    VNextDatasetSnapshot.run_id == run_id
                )
            )
            session.execute(
                delete(VNextFeatureViewSpec).where(
                    VNextFeatureViewSpec.candidate_id == candidate_id
                )
            )
            session.execute(
                delete(VNextModelArtifact).where(
                    VNextModelArtifact.candidate_id == candidate_id
                )
            )
            session.execute(
                delete(VNextExperimentSpec).where(
                    VNextExperimentSpec.candidate_id == candidate_id
                )
            )
            session.execute(
                delete(VNextExperimentRun).where(
                    VNextExperimentRun.candidate_id == candidate_id
                )
            )
            session.execute(
                delete(VNextSimulationCalibration).where(
                    VNextSimulationCalibration.candidate_id == candidate_id
                )
            )
            session.execute(
                delete(VNextShadowLiveDeviation).where(
                    VNextShadowLiveDeviation.candidate_id == candidate_id
                )
            )
            session.execute(
                delete(VNextPromotionDecision).where(
                    VNextPromotionDecision.candidate_id == candidate_id
                )
            )
            session.execute(
                delete(StrategyHypothesisMetricWindow).where(
                    StrategyHypothesisMetricWindow.candidate_id == candidate_id
                )
            )
            session.execute(
                delete(StrategyCapitalAllocation).where(
                    StrategyCapitalAllocation.candidate_id == candidate_id
                )
            )
            session.execute(
                delete(StrategyPromotionDecision).where(
                    StrategyPromotionDecision.candidate_id == candidate_id
                )
            )
            calibration_id = _coerce_str(
                strategy_factory_cost_calibration_payload.get("calibration_id")
            )
            if calibration_id:
                session.execute(
                    delete(ResearchCostCalibration).where(
                        ResearchCostCalibration.calibration_id == calibration_id
                    )
                )
            should_promote = (
                effective_promotion_allowed
                and promotion_recommendation.action == "promote"
                and promotion_recommendation.recommended_mode in {"paper", "live"}
            )
            candidate_role = "champion" if should_promote else "challenger"
            candidate_status = "active" if should_promote else "evaluated"
            metadata_bundle = {
                "promotion_gate_trace_id": gate_report_trace_id,
                "recommendation_trace_id": recommendation_trace_id,
                "throughput": {
                    "signal_count": len(signals),
                    "decision_count": report.metrics.decision_count,
                    "trade_count": report.metrics.trade_count,
                },
                "gate_reasons": sorted(set(promotion_reasons)),
                "stage_lineage": stage_lineage_payload,
                "stage_trace_ids": dict(stage_trace_ids),
                "stage_manifest_refs": dict(stage_manifest_refs),
                "replay_artifact_hashes": replay_artifact_hashes,
                "existing_champion_candidate_id": (
                    existing_champion.candidate_id
                    if existing_champion is not None
                    else None
                ),
                "actuation_allowed": effective_promotion_allowed,
                "dependency_quorum": candidate_dependency_quorum_payload,
                "alpha_readiness": candidate_alpha_readiness_payload,
                "actuation_intent_artifact": (
                    str(actuation_intent_path) if actuation_intent_path else None
                ),
                "strategy_compilation": [
                    {
                        "strategy_id": strategy.strategy_id,
                        "compiler_source": strategy.compiler_source,
                        "strategy_spec_v2": strategy.strategy_spec,
                    }
                    for strategy in runtime_strategies
                ],
                "simulation_calibration": {
                    key: simulation_calibration_report_payload.get(key)
                    for key in (
                        "status",
                        "order_count",
                        "expected_shortfall_coverage",
                        "avg_calibration_error_bps",
                        "confidence_gate_action",
                    )
                },
                "shadow_live_deviation": {
                    key: shadow_live_deviation_report_payload.get(key)
                    for key in (
                        "status",
                        "order_count",
                        "avg_abs_slippage_bps",
                        "avg_abs_divergence_bps",
                        "deviation_budget_utilization",
                    )
                },
            }
            if strategy_factory_payload:
                metadata_bundle["strategy_factory"] = {
                    "candidate_family": strategy_factory_payload.get(
                        "candidate_family"
                    ),
                    "semantic_hash": strategy_factory_payload.get("semantic_hash"),
                    "posterior_edge_summary": strategy_factory_payload.get(
                        "posterior_edge_summary"
                    ),
                    "economic_validity_card": strategy_factory_payload.get(
                        "economic_validity_card"
                    ),
                    "null_comparator_summary": strategy_factory_payload.get(
                        "null_comparator_summary"
                    ),
                    "cost_calibration": strategy_factory_cost_calibration_payload,
                    "sequential_trial": strategy_factory_sequential_payload,
                    "validation_test_count": len(strategy_factory_validation_payloads),
                    "attempt_count": len(
                        cast(
                            list[Any],
                            strategy_factory_attempt_payload.get("attempts", []),
                        )
                    ),
                    "gate_summary": strategy_factory_payload.get("gate_summary"),
                }
            recommended_mode = promotion_recommendation.recommended_mode
            lifecycle_payload = {
                "role": "challenger",
                "status": "promoted_champion"
                if should_promote
                else "retained_challenger",
                "promotable": effective_promotion_allowed,
                "promotion_target": promotion_target,
                "recommended_mode": recommended_mode,
                "reason_codes": list(promotion_reasons),
                "recommendation_trace_id": recommendation_trace_id,
                "gate_report_trace_id": gate_report_trace_id,
                "champion_before": (
                    {"candidate_id": existing_champion.candidate_id}
                    if existing_champion is not None
                    else None
                ),
            }

            candidate = ResearchCandidate(
                run_id=run_id,
                candidate_id=candidate_id,
                candidate_hash=candidate_hash,
                parameter_set=_strategy_parameter_set(runtime_strategies),
                decision_count=report.metrics.decision_count,
                trade_count=report.metrics.trade_count,
                symbols_covered=sorted({signal.symbol for signal in signals}),
                universe_definition=_strategy_universe_definition(
                    runtime_strategies,
                    lifecycle_payload=lifecycle_payload,
                ),
                promotion_target=promotion_target,
                lifecycle_role=candidate_role,
                lifecycle_status=candidate_status,
                metadata_bundle=metadata_bundle,
                recommendation_bundle=promotion_recommendation.to_payload(),
                candidate_family=_coerce_str(
                    strategy_factory_payload.get("candidate_family")
                ),
                canonical_spec=strategy_factory_payload.get("canonical_spec"),
                semantic_hash=_coerce_str(
                    strategy_factory_payload.get("semantic_hash")
                ),
                economic_rationale=_coerce_str(
                    strategy_factory_payload.get("economic_rationale")
                ),
                complexity_score=_decimal_or_none(
                    strategy_factory_payload.get("complexity_score")
                ),
                discovery_rank=_metric_counter_int(
                    strategy_factory_payload.get("discovery_rank")
                )
                if strategy_factory_payload.get("discovery_rank") is not None
                else None,
                posterior_edge_summary=strategy_factory_payload.get(
                    "posterior_edge_summary"
                ),
                economic_validity_card=strategy_factory_payload.get(
                    "economic_validity_card"
                ),
                valid_regime_envelope=strategy_factory_payload.get(
                    "valid_regime_envelope"
                ),
                invalidation_clauses=strategy_factory_payload.get(
                    "invalidation_clauses"
                ),
                null_comparator_summary=strategy_factory_payload.get(
                    "null_comparator_summary"
                ),
            )
            session.add(candidate)

            for fold_order, fold in enumerate(walk_results.folds, start=1):
                fold_metrics = fold.fold_metrics()
                robustness = robustness_by_fold.get(fold.fold.name)
                decision_count = _metric_counter_int(
                    fold_metrics.get("decision_count", 0)
                )
                trade_count = _metric_counter_int(
                    fold_metrics.get("buy_count", 0)
                ) + _metric_counter_int(
                    fold_metrics.get("sell_count", 0),
                )
                regime_label = (
                    robustness.regime.label()
                    if robustness is not None
                    else str(
                        fold_metrics.get("regime_label", "unknown"),
                    )
                )

                session.add(
                    ResearchFoldMetrics(
                        candidate_id=candidate_id,
                        fold_name=fold.fold.name,
                        fold_order=fold_order,
                        train_start=fold.fold.train_start,
                        train_end=fold.fold.train_end,
                        test_start=fold.fold.test_start,
                        test_end=fold.fold.test_end,
                        decision_count=decision_count,
                        trade_count=trade_count,
                        gross_pnl=robustness.net_pnl
                        if robustness is not None
                        else None,
                        net_pnl=robustness.net_pnl
                        if robustness is not None
                        else report.metrics.net_pnl,
                        max_drawdown=robustness.max_drawdown
                        if robustness is not None
                        else report.metrics.max_drawdown,
                        turnover_ratio=robustness.turnover_ratio
                        if robustness is not None
                        else report.metrics.turnover_ratio,
                        cost_bps=robustness.cost_bps
                        if robustness is not None
                        else report.metrics.cost_bps,
                        cost_assumptions=report.impact_assumptions.assumptions,
                        regime_label=regime_label,
                        stat_bundle=(
                            strategy_factory_payload.get("fold_stat_bundle")
                            if fold_order == 1 and strategy_factory_payload
                            else None
                        ),
                        purge_window=0 if strategy_factory_payload else None,
                        embargo_window=0 if strategy_factory_payload else None,
                        feature_availability_hash=(
                            _coerce_str(strategy_factory_payload.get("semantic_hash"))
                            or None
                        ),
                    ),
                )

            for stress_case in ("spread", "volatility", "liquidity", "halt"):
                session.add(
                    ResearchStressMetrics(
                        candidate_id=candidate_id,
                        stress_case=stress_case,
                        metric_bundle=_build_stress_bundle(report, stress_case),
                        pessimistic_pnl_delta=None,
                    )
                )

            evidence_bundle: dict[str, Any] = {
                "fold_metrics_count": fold_metrics_count,
                "stress_metrics_count": stress_metrics_count,
                "rationale_present": bool(promotion_recommendation.rationale),
                "evidence_complete": promotion_recommendation.evidence.evidence_complete,
                "actuation_allowed": effective_promotion_allowed,
                "stage_lineage": stage_lineage_payload,
                "stage_trace_ids": dict(stage_trace_ids),
                "stage_manifest_refs": dict(stage_manifest_refs),
                "replay_artifact_hashes": replay_artifact_hashes,
                "dependency_quorum": candidate_dependency_quorum_payload,
                "alpha_readiness": candidate_alpha_readiness_payload,
                "reasons": list(promotion_recommendation.evidence.reasons),
                "actuation_intent_artifact": (
                    str(actuation_intent_path) if actuation_intent_path else None
                ),
                "strategy_compilation": [
                    {
                        "strategy_id": strategy.strategy_id,
                        "compiler_source": strategy.compiler_source,
                    }
                    for strategy in runtime_strategies
                ],
                "evidence_authority": {
                    "fold_metrics": _artifact_authority_for_evidence("fold_metrics"),
                    "stress_metrics": _artifact_authority_for_evidence(
                        "stress_metrics"
                    ),
                    "simulation_calibration": simulation_calibration_report_payload.get(
                        "artifact_authority"
                    ),
                    "shadow_live_deviation": shadow_live_deviation_report_payload.get(
                        "artifact_authority"
                    ),
                    "benchmark_parity": _artifact_authority_for_evidence(
                        "benchmark_parity"
                    ),
                    "foundation_router_parity": _artifact_authority_for_evidence(
                        "foundation_router_parity"
                    ),
                    "deeplob_bdlob_contract": _artifact_authority_for_evidence(
                        "deeplob_bdlob_contract"
                    ),
                    "advisor_fallback_slo": _artifact_authority_for_evidence(
                        "advisor_fallback_slo"
                    ),
                    "hmm_state_posterior": _artifact_authority_for_evidence(
                        "hmm_state_posterior"
                    ),
                    "expert_router_registry": _artifact_authority_for_evidence(
                        "expert_router_registry"
                    ),
                    "contamination_registry": _artifact_authority_for_evidence(
                        "contamination_registry"
                    ),
                    "janus_q": _artifact_authority_for_evidence("janus_q"),
                },
                "simulation_calibration": {
                    key: simulation_calibration_report_payload.get(key)
                    for key in (
                        "status",
                        "order_count",
                        "expected_shortfall_coverage",
                        "avg_calibration_error_bps",
                    )
                },
                "shadow_live_deviation": {
                    key: shadow_live_deviation_report_payload.get(key)
                    for key in (
                        "status",
                        "order_count",
                        "avg_abs_slippage_bps",
                        "avg_abs_divergence_bps",
                        "deviation_budget_utilization",
                    )
                },
            }
            if strategy_factory_payload:
                evidence_bundle["strategy_factory"] = metadata_bundle.get(
                    "strategy_factory"
                )
            challenger_decision = {
                "decision_type": "promotion",
                "run_id": run_id,
                "candidate_id": candidate_id,
                "promotion_target": promotion_target,
                "recommended_mode": recommended_mode,
                "promotion_allowed": effective_promotion_allowed,
                "reason_codes": list(promotion_reasons),
                "recommendation_trace_id": recommendation_trace_id,
                "gate_report_trace_id": gate_report_trace_id,
            }
            session.add(
                ResearchPromotion(
                    candidate_id=candidate_id,
                    requested_mode=promotion_target,
                    approved_mode=recommended_mode
                    if effective_promotion_allowed
                    else None,
                    approver="autonomous_scheduler",
                    approver_role="system",
                    approve_reason=json.dumps(challenger_decision, sort_keys=True)
                    if effective_promotion_allowed
                    else None,
                    deny_reason=None
                    if effective_promotion_allowed
                    else json.dumps(challenger_decision, sort_keys=True),
                    paper_candidate_patch_ref=str(patch_path) if patch_path else None,
                    effective_time=now if effective_promotion_allowed else None,
                    decision_action=promotion_recommendation.action,
                    decision_rationale=promotion_recommendation.rationale,
                    evidence_bundle=evidence_bundle,
                    recommendation_trace_id=recommendation_trace_id,
                    successor_candidate_id=(
                        None
                        if promotion_recommendation.action != "demote"
                        else candidate_id
                    ),
                    rollback_candidate_id=(
                        existing_champion.candidate_id
                        if existing_champion is not None
                        else None
                    ),
                )
            )
            if should_promote and existing_champion is not None:
                existing_champion.lifecycle_role = "demoted"
                existing_champion.lifecycle_status = "standby"
                existing_champion.metadata_bundle = {
                    "demoted_at": now.isoformat(),
                    "demoted_by_candidate_id": candidate_id,
                    "rollback_safe": True,
                    "gate_report_trace_id": gate_report_trace_id,
                }
                session.add(existing_champion)
                demotion_trace_id = _trace_id(
                    {
                        "decision_action": "demote",
                        "candidate_id": existing_champion.candidate_id,
                        "successor_candidate_id": candidate_id,
                        "run_id": run_id,
                        "recommended_mode": promotion_recommendation.recommended_mode,
                    }
                )
                demotion_decision = {
                    "decision_type": "demotion",
                    "run_id": run_id,
                    "candidate_id": existing_champion.candidate_id,
                    "successor_candidate_id": candidate_id,
                    "recommended_mode": promotion_recommendation.recommended_mode,
                    "rollback_safe": True,
                    "recommendation_trace_id": demotion_trace_id,
                    "gate_report_trace_id": gate_report_trace_id,
                }
                session.add(
                    ResearchPromotion(
                        candidate_id=existing_champion.candidate_id,
                        requested_mode=promotion_target,
                        approved_mode="shadow",
                        approver="autonomous_scheduler",
                        approver_role="system",
                        approve_reason=json.dumps(demotion_decision, sort_keys=True),
                        deny_reason=None,
                        paper_candidate_patch_ref=None,
                        effective_time=now,
                        decision_action="demote",
                        decision_rationale=(
                            f"demoted_after_promotion_of_{candidate_id}_for_{promotion_target}"
                        ),
                        evidence_bundle=evidence_bundle,
                        recommendation_trace_id=demotion_trace_id,
                        successor_candidate_id=candidate_id,
                        rollback_candidate_id=existing_champion.candidate_id,
                    )
                )
            run = session.execute(
                select(ResearchRun).where(ResearchRun.run_id == run_id)
            ).scalar_one_or_none()
            if run is not None:
                run.gate_report_trace_id = gate_report_trace_id
                run.recommendation_trace_id = recommendation_trace_id
                if strategy_factory_payload:
                    run.discovery_mode = "strategy_factory_autonomy_v1"
                    run.generator_family = _coerce_str(
                        strategy_factory_payload.get("candidate_family"),
                        "strategy_factory_bridge_v1",
                    )
                    run.grammar_version = "strategy_factory.bridge.v1"
                    run.selection_protocol_version = "autonomy-strategy-factory-v1"
                    run.pilot_program_id = "torghut-strategy-factory-pilot-v1"
                    run.kill_criteria_version = "pilot-kill-criteria-v1"
                run.updated_at = now
                session.add(run)

            for attempt in cast(
                list[dict[str, Any]],
                strategy_factory_attempt_payload.get("attempts", []),
            ):
                session.add(
                    ResearchAttempt(
                        attempt_id=str(attempt["attempt_id"]),
                        run_id=run_id,
                        candidate_hash=cast(str | None, attempt.get("candidate_hash")),
                        generator_family=cast(
                            str | None, attempt.get("generator_family")
                        ),
                        attempt_stage=str(attempt["attempt_stage"]),
                        status=str(attempt["status"]),
                        reason_codes=attempt.get("reason_codes"),
                        artifact_ref=cast(str | None, attempt.get("artifact_ref")),
                        metadata_bundle=attempt.get("metadata_bundle"),
                    )
                )

            for validation_payload in strategy_factory_validation_payloads:
                session.add(
                    ResearchValidationTest(
                        candidate_id=candidate_id,
                        test_name=str(validation_payload["test_name"]),
                        status=str(validation_payload["status"]),
                        metric_bundle=validation_payload,
                        artifact_ref=_coerce_str(
                            validation_payload.get("artifact_name")
                        )
                        or cast(str | None, validation_payload.get("artifact_ref")),
                        computed_at=now,
                    )
                )

            if strategy_factory_sequential_payload:
                session.add(
                    ResearchSequentialTrial(
                        candidate_id=candidate_id,
                        trial_stage=str(
                            strategy_factory_sequential_payload["trial_stage"]
                        ),
                        account=str(strategy_factory_sequential_payload["account"]),
                        start_at=datetime.fromisoformat(
                            str(strategy_factory_sequential_payload["start_at"])
                        ),
                        last_update_at=datetime.fromisoformat(
                            str(strategy_factory_sequential_payload["last_update_at"])
                        ),
                        sample_count=_metric_counter_int(
                            strategy_factory_sequential_payload.get("sample_count")
                        ),
                        confidence_sequence_lower=_decimal_or_none(
                            strategy_factory_sequential_payload.get(
                                "confidence_sequence_lower"
                            )
                        ),
                        confidence_sequence_upper=_decimal_or_none(
                            strategy_factory_sequential_payload.get(
                                "confidence_sequence_upper"
                            )
                        ),
                        posterior_edge_mean=_decimal_or_none(
                            strategy_factory_sequential_payload.get(
                                "posterior_edge_mean"
                            )
                        ),
                        posterior_edge_lower=_decimal_or_none(
                            strategy_factory_sequential_payload.get(
                                "posterior_edge_lower"
                            )
                        ),
                        status=str(strategy_factory_sequential_payload["status"]),
                        reason_codes=strategy_factory_sequential_payload.get(
                            "reason_codes"
                        ),
                    )
                )

            if strategy_factory_cost_calibration_payload:
                computed_at_raw = _coerce_str(
                    strategy_factory_cost_calibration_payload.get("computed_at")
                )
                session.add(
                    ResearchCostCalibration(
                        calibration_id=str(
                            strategy_factory_cost_calibration_payload["calibration_id"]
                        ),
                        scope_type=str(
                            strategy_factory_cost_calibration_payload["scope_type"]
                        ),
                        scope_id=str(
                            strategy_factory_cost_calibration_payload["scope_id"]
                        ),
                        window_start=(
                            datetime.fromisoformat(
                                str(
                                    strategy_factory_cost_calibration_payload[
                                        "window_start"
                                    ]
                                )
                            )
                            if strategy_factory_cost_calibration_payload.get(
                                "window_start"
                            )
                            else None
                        ),
                        window_end=(
                            datetime.fromisoformat(
                                str(
                                    strategy_factory_cost_calibration_payload[
                                        "window_end"
                                    ]
                                )
                            )
                            if strategy_factory_cost_calibration_payload.get(
                                "window_end"
                            )
                            else None
                        ),
                        modeled_slippage_bps=_decimal_or_none(
                            strategy_factory_cost_calibration_payload.get(
                                "modeled_slippage_bps"
                            )
                        ),
                        realized_slippage_bps=_decimal_or_none(
                            strategy_factory_cost_calibration_payload.get(
                                "realized_slippage_bps"
                            )
                        ),
                        modeled_shortfall_bps=_decimal_or_none(
                            strategy_factory_cost_calibration_payload.get(
                                "modeled_shortfall_bps"
                            )
                        ),
                        realized_shortfall_bps=_decimal_or_none(
                            strategy_factory_cost_calibration_payload.get(
                                "realized_shortfall_bps"
                            )
                        ),
                        calibration_error_bundle=strategy_factory_cost_calibration_payload.get(
                            "calibration_error_bundle"
                        ),
                        status=str(strategy_factory_cost_calibration_payload["status"]),
                        computed_at=(
                            datetime.fromisoformat(computed_at_raw)
                            if computed_at_raw
                            else now
                        ),
                    )
                )

            _persist_vnext_objects(
                session=session,
                run_id=run_id,
                candidate_id=candidate_id,
                runtime_strategies=runtime_strategies,
                candidate_spec_payload=candidate_spec_payload,
                signals=signals,
                walk_results=walk_results,
                report=report,
                promotion_target=promotion_target,
                promotion_recommendation=promotion_recommendation,
                effective_promotion_allowed=effective_promotion_allowed,
                gate_report_trace_id=gate_report_trace_id,
                recommendation_trace_id=recommendation_trace_id,
                now=now,
                simulation_calibration_report_payload=simulation_calibration_report_payload,
                shadow_live_deviation_report_payload=shadow_live_deviation_report_payload,
            )


persist_run_outputs_if_requested = _persist_run_outputs_if_requested
persist_run_outputs = _persist_run_outputs

__all__ = [
    "_persist_run_outputs_if_requested",
    "_persist_run_outputs",
]
