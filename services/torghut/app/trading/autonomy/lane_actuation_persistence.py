"""Autonomous lane phase helpers extracted from the root orchestrator."""

from __future__ import annotations

import json
from pathlib import Path
from typing import cast


from .lane_common import (
    ACTUATION_INTENT_PATH as _ACTUATION_INTENT_PATH,
    STAGE_CANDIDATE_GENERATION as _STAGE_CANDIDATE_GENERATION,
    STAGE_EVALUATION as _STAGE_EVALUATION,
    STAGE_RECOMMENDATION as _STAGE_RECOMMENDATION,
)
from .lane_phase_payloads import (
    build_actuation_intent_payload as _build_actuation_intent_payload,
    build_phase_manifest as _build_phase_manifest,
)
from .lane_stage_artifacts import (
    artifact_hashes as _artifact_hashes,
    write_iteration_notes as _write_iteration_notes,
)


from .lane_persistence import (
    mark_run_passed_if_requested as _mark_run_passed_if_requested,
)
from .lane_result_persistence import (
    persist_run_outputs_if_requested as _persist_run_outputs_if_requested,
)

from .lane_governance import (
    compute_candidate_hash as _compute_candidate_hash,
)


from .lane_workflow_state import AutonomousLaneWorkflowState
from .lane_gate_spec_phase import write_current_profitability_manifest


def run_actuation_persistence_phase(state: AutonomousLaneWorkflowState) -> None:
    if state.recommendation_trace_id is None or state.gate_report_trace_id is None:
        raise RuntimeError("autonomous_lane_trace_ids_missing")
    candidate_spec_replay_artifacts: dict[str, Path | None] = {
        key: value
        for key, value in state.replay_artifacts.items()
        if key != "profitability_stage_manifest"
    }
    replay_artifact_hashes = _artifact_hashes(candidate_spec_replay_artifacts)
    candidate_hash = _compute_candidate_hash(
        run_id=state.run_id,
        runtime_strategies=state.runtime_strategies,
        gate_report=state.gate_report,
        signals_path=state.signals_path,
        strategy_config_path=state.strategy_config_path,
        gate_policy_path=state.gate_policy_path,
        stage_lineage_payload=state.stage_lineage_payload,
        replay_artifact_hashes=replay_artifact_hashes,
    )
    state.research_spec["candidate_hash"] = candidate_hash
    state.research_spec["replay_artifact_hashes"] = replay_artifact_hashes
    state.candidate_spec_path.write_text(
        json.dumps(state.research_spec, indent=2), encoding="utf-8"
    )
    write_current_profitability_manifest(state)
    _write_iteration_notes(
        artifact_root=state.notes_root,
        run_id=state.run_id,
        candidate_id=state.candidate_id,
        stage_records=state.stage_records,
        repository=cast(str, state.resolved_governance_repository),
        base=cast(str, state.resolved_governance_base),
        head=cast(str, state.resolved_governance_head),
        priority_id=cast(str, state.resolved_governance_priority_id)
        if state.resolved_governance_priority_id
        else None,
    )
    actuation_allowed = (
        bool(state.recommendation_trace_id)
        and state.promotion_recommendation.eligible
        and state.rollback_check.ready
    )
    state.actuation_intent_path = state.output_dir / _ACTUATION_INTENT_PATH
    state.actuation_intent_path.parent.mkdir(parents=True, exist_ok=True)
    actuation_intent_payload = _build_actuation_intent_payload(
        run_id=state.run_id,
        candidate_id=state.candidate_id,
        generated_at=state.now,
        recommendation_trace_id=state.recommendation_trace_id,
        gate_report_trace_id=state.gate_report_trace_id,
        promotion_target=state.promotion_target,
        recommended_mode=state.recommended_mode,
        actuation_allowed=actuation_allowed,
        promotion_check=state.promotion_check.to_payload(),
        rollback_check=state.rollback_check.to_payload(),
        candidate_state_payload=state.candidate_state_payload,
        gate_report_path=state.gate_report_path,
        rollback_check_path=state.rollback_check_path,
        candidate_spec_path=state.candidate_spec_path,
        candidate_generation_manifest_path=state.manifest_paths[
            _STAGE_CANDIDATE_GENERATION
        ],
        evaluation_manifest_path=state.manifest_paths[_STAGE_EVALUATION],
        recommendation_manifest_path=state.manifest_paths[_STAGE_RECOMMENDATION],
        profitability_manifest_path=state.profitability_manifest_path,
        promotion_recommendation_path=state.promotion_recommendation_path,
        evaluation_report_path=state.evaluation_report_path,
        walk_results_path=state.walk_results_path,
        paper_patch_path=state.patch_path,
        patch_required=bool(
            state.promotion_target in {"paper", "live"}
            and state.gate_report.recommended_mode == "paper"
        ),
        profitability_benchmark_path=state.profitability_benchmark_path,
        profitability_evidence_path=state.profitability_evidence_path,
        profitability_validation_path=state.profitability_validation_path,
        simulation_calibration_report_path=state.simulation_calibration_report_path,
        shadow_live_deviation_report_path=state.shadow_live_deviation_report_path,
        benchmark_parity_path=state.benchmark_parity_path,
        foundation_router_parity_path=state.foundation_router_parity_path,
        deeplob_bdlob_report_path=state.deeplob_bdlob_report_path,
        advisor_fallback_slo_report_path=state.advisor_fallback_slo_report_path,
        janus_event_car_path=state.janus_event_car_path,
        janus_hgrm_reward_path=state.janus_hgrm_reward_path,
        recalibration_report_path=state.recalibration_report_path,
        promotion_gate_path=state.promotion_gate_path,
        promotion_recommendation=state.promotion_recommendation,
        recommendations=state.promotion_reasons,
        governance_repository=cast(str, state.resolved_governance_repository),
        governance_base=cast(str, state.resolved_governance_base),
        governance_head=cast(str, state.resolved_governance_head),
        governance_artifact_path=state.notes_artifact_root
        if state.notes_artifact_root
        else str(state.output_dir),
        priority_id=cast(str, state.resolved_governance_priority_id)
        if state.resolved_governance_priority_id
        else None,
        governance_change=state.governance_change,
        governance_reason=state.governance_reason
        or f"Autonomous recommendation for {state.promotion_target} target.",
        stage_lineage_payload=state.stage_lineage_payload,
        replay_artifact_hashes=replay_artifact_hashes,
        candidate_hash=candidate_hash,
    )
    state.actuation_intent_path.write_text(
        json.dumps(actuation_intent_payload, indent=2), encoding="utf-8"
    )
    phase_manifest_payload = _build_phase_manifest(
        run_id=state.run_id,
        candidate_id=state.candidate_id,
        evaluated_at=state.now,
        output_dir=state.output_dir,
        signals=state.signals,
        requested_promotion_target=state.promotion_target,
        gate_report=state.gate_report,
        gate_report_payload=state.gate_report_payload,
        gate_report_path=state.gate_report_path,
        promotion_check=state.promotion_check,
        rollback_check=state.rollback_check,
        drift_gate_check=state.drift_gate_check,
        patch_path=state.patch_path,
        recommended_mode=state.recommended_mode,
        promotion_reasons=state.promotion_reasons,
        governance_inputs=state.governance_context,
        drift_promotion_evidence=state.drift_promotion_evidence,
    )
    state.phase_manifest_path.write_text(
        json.dumps(phase_manifest_payload, indent=2), encoding="utf-8"
    )
    _persist_run_outputs_if_requested(
        persist_results=state.persist_results,
        session_factory=state.factory,
        run_id=state.run_id,
        candidate_id=state.candidate_id,
        candidate_hash=candidate_hash,
        runtime_strategies=state.runtime_strategies,
        signals=state.signals,
        walk_results=state.walk_results,
        report=state.report,
        candidate_spec_path=state.candidate_spec_path,
        evaluation_report_path=state.evaluation_report_path,
        gate_report_path=state.gate_report_path,
        actuation_intent_path=state.actuation_intent_path,
        patch_path=state.patch_path,
        now=state.now,
        promotion_target=state.promotion_target,
        actuation_allowed=actuation_allowed,
        promotion_allowed=state.promotion_allowed,
        promotion_reasons=state.promotion_reasons,
        promotion_recommendation=state.promotion_recommendation,
        fold_metrics_count=state.fold_metrics_count,
        stress_metrics_count=state.stress_metrics_count,
        gate_report_trace_id=state.gate_report_trace_id,
        recommendation_trace_id=state.recommendation_trace_id,
        stage_trace_ids=state.stage_trace_ids,
        stage_lineage_payload=state.stage_lineage_payload,
        stage_manifest_refs=state.research_spec["stage_manifest_refs"],
        replay_artifact_hashes=replay_artifact_hashes,
        simulation_calibration_report_payload=state.simulation_calibration_report_payload,
        shadow_live_deviation_report_payload=state.shadow_live_deviation_report_payload,
    )
    _mark_run_passed_if_requested(
        persist_results=state.persist_results,
        session_factory=state.factory,
        run_id=state.run_id,
        run_row=state.run_row,
        now=state.now,
        gate_report_trace_id=state.gate_report_trace_id,
        recommendation_trace_id=state.recommendation_trace_id,
    )


__all__ = ["run_actuation_persistence_phase"]
