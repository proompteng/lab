"""Autonomous lane phase helpers extracted from the root orchestrator."""

from __future__ import annotations

import json
from typing import Any, cast


from .lane_common import (
    STAGE_CANDIDATE_GENERATION as _STAGE_CANDIDATE_GENERATION,
    STAGE_EVALUATION as _STAGE_EVALUATION,
    STAGE_PROFITABILITY as _STAGE_PROFITABILITY,
    STAGE_RECOMMENDATION as _STAGE_RECOMMENDATION,
)
from .lane_stage_artifacts import (
    artifact_authority_for_evidence as _artifact_authority_for_evidence,
    build_bridge_evidence_payload as _build_bridge_evidence_payload,
    build_stage_lineage_payload as _build_stage_lineage_payload,
    build_vnext_gate_summary as _build_vnext_gate_summary,
    write_stage_manifest as _write_stage_manifest,
)


from .lane_workflow_state import AutonomousLaneWorkflowState


def run_lineage_replay_phase(state: AutonomousLaneWorkflowState) -> None:
    state.gate_report_payload["promotion_evidence"] = {
        "fold_metrics": {
            "count": len(state.fold_evidence),
            "items": state.fold_evidence,
            "artifact_ref": state.fold_metrics_artifact_ref,
            "artifact_authority": _artifact_authority_for_evidence("fold_metrics"),
        },
        "stress_metrics": {
            "count": len(state.stress_evidence),
            "items": state.stress_evidence,
            "artifact_ref": state.stress_metrics_artifact_ref,
            "artifact_authority": _artifact_authority_for_evidence("stress_metrics"),
        },
        "simulation_calibration": _build_bridge_evidence_payload(
            state.simulation_calibration_report_payload,
            artifact_ref=state.simulation_calibration_artifact_ref,
            summary_fields=(
                "order_count",
                "expected_shortfall_sample_count",
                "expected_shortfall_coverage",
                "avg_calibration_error_bps",
                "confidence_gate_action",
            ),
        ),
        "shadow_live_deviation": _build_bridge_evidence_payload(
            state.shadow_live_deviation_report_payload,
            artifact_ref=state.shadow_live_deviation_artifact_ref,
            summary_fields=(
                "order_count",
                "decision_count",
                "trade_count",
                "avg_abs_slippage_bps",
                "avg_abs_divergence_bps",
                "deviation_budget_utilization",
            ),
        ),
        "janus_q": {
            "event_car": {
                "count": state.janus_event_count,
                "artifact_ref": str(state.janus_event_car_path),
                "artifact_authority": _artifact_authority_for_evidence(
                    "janus_event_car"
                ),
            },
            "hgrm_reward": {
                "count": state.janus_reward_count,
                "artifact_ref": str(state.janus_hgrm_reward_path),
                "artifact_authority": _artifact_authority_for_evidence(
                    "janus_hgrm_reward"
                ),
            },
            "evidence_complete": state.janus_evidence_complete,
            "reasons": state.janus_reasons,
            "artifact_authority": _artifact_authority_for_evidence("janus_q"),
        },
        "benchmark_parity": {
            "artifact_ref": state.benchmark_parity_artifact_ref,
            "artifact_authority": _artifact_authority_for_evidence("benchmark_parity"),
        },
        "foundation_router_parity": {
            "artifact_ref": state.foundation_router_parity_artifact_ref,
            "artifact_authority": _artifact_authority_for_evidence(
                "foundation_router_parity"
            ),
        },
        "deeplob_bdlob_contract": {
            "artifact_ref": state.deeplob_bdlob_artifact_ref,
            "artifact_authority": _artifact_authority_for_evidence(
                "deeplob_bdlob_contract"
            ),
        },
        "advisor_fallback_slo": {
            "artifact_ref": state.advisor_fallback_slo_artifact_ref,
            "artifact_authority": _artifact_authority_for_evidence(
                "advisor_fallback_slo"
            ),
            "schema_version": state.advisor_fallback_slo_report.get("schema_version"),
            "evaluated_samples": state.advisor_fallback_slo_report.get(
                "evaluated_samples"
            ),
            "timeout_rate": cast(
                dict[str, Any],
                state.advisor_fallback_slo_report.get("fallback_reason_rates", {}),
            ).get("timeout_rate"),
            "state_stale_rate": cast(
                dict[str, Any],
                state.advisor_fallback_slo_report.get("fallback_reason_rates", {}),
            ).get("state_stale_rate"),
            "advice_stale_rate": cast(
                dict[str, Any],
                state.advisor_fallback_slo_report.get("fallback_reason_rates", {}),
            ).get("advice_stale_rate"),
            "safe_fallback_rate": cast(
                dict[str, Any],
                state.advisor_fallback_slo_report.get("fallback_reason_rates", {}),
            ).get("safe_fallback_rate"),
            "slo_pass": cast(
                dict[str, Any],
                state.advisor_fallback_slo_report.get("fallback_reason_rates", {}),
            ).get("slo_pass"),
            "artifact_hash": state.advisor_fallback_slo_report.get("artifact_hash"),
        },
        "hmm_state_posterior": {
            "artifact_ref": state.hmm_state_posterior_artifact_ref,
            "artifact_authority": _artifact_authority_for_evidence(
                "hmm_state_posterior"
            ),
            "schema_version": state.hmm_state_posterior_payload.get("schema_version"),
            "samples_total": state.hmm_state_posterior_payload.get("samples_total"),
            "authoritative_samples": state.hmm_state_posterior_payload.get(
                "authoritative_samples"
            ),
            "authoritative_sample_ratio": state.hmm_state_posterior_payload.get(
                "authoritative_sample_ratio"
            ),
            "transition_shock_samples": state.hmm_state_posterior_payload.get(
                "transition_shock_samples"
            ),
            "stale_or_defensive_samples": state.hmm_state_posterior_payload.get(
                "stale_or_defensive_samples"
            ),
            "top_regime_by_posterior_mass": state.hmm_state_posterior_payload.get(
                "top_regime_by_posterior_mass"
            ),
            "artifact_hash": state.hmm_state_posterior_payload.get("artifact_hash"),
        },
        "expert_router_registry": {
            "artifact_ref": state.expert_router_registry_artifact_ref,
            "artifact_authority": _artifact_authority_for_evidence(
                "expert_router_registry"
            ),
            "schema_version": state.expert_router_registry_payload.get(
                "schema_version"
            ),
            "router_version": state.expert_router_registry_payload.get(
                "router_version"
            ),
            "route_count": state.expert_router_registry_payload.get("route_count"),
            "fallback_count": state.expert_router_registry_payload.get(
                "fallback_count"
            ),
            "fallback_rate": state.expert_router_registry_payload.get("fallback_rate"),
            "max_expert_weight": state.expert_router_registry_payload.get(
                "max_expert_weight"
            ),
            "artifact_hash": state.expert_router_registry_payload.get("artifact_hash"),
        },
        "contamination_registry": {
            "artifact_ref": state.contamination_registry_artifact_ref,
            "artifact_authority": _artifact_authority_for_evidence(
                "contamination_registry"
            ),
            "status": state.contamination_registry_payload.get("status", "fail"),
            "leakage_detected": state.contamination_registry_payload.get(
                "leakage_detected", True
            ),
            "leakage_rate": state.contamination_registry_payload.get(
                "leakage_rate", 1.0
            ),
        },
        "promotion_rationale": {
            "requested_target": state.promotion_target,
            "gate_recommended_mode": state.gate_report.recommended_mode,
            "recommended_mode": state.recommended_mode,
            "promotion_allowed": state.promotion_allowed,
            "reason_codes": state.promotion_reasons,
            "recommendation_trace_id": state.recommendation_trace_id,
            "rationale_text": "Promotion decision derives from gate, prerequisite, and rollback checks.",
            "artifact_authority": _artifact_authority_for_evidence(
                "promotion_rationale"
            ),
        },
    }
    if state.strategy_factory_bridge is not None:
        state.gate_report_payload["promotion_evidence"]["strategy_factory"] = {
            **state.strategy_factory_summary,
            "artifact_authority": _artifact_authority_for_evidence("strategy_factory"),
        }
    state.gate_report_payload["promotion_decision"] = {
        "candidate_id": state.candidate_id,
        "promotion_target": state.promotion_target,
        "recommended_mode": state.recommended_mode,
        "promotion_allowed": state.promotion_allowed,
        "reason_codes": state.promotion_reasons,
        "promotion_gate_artifact": str(state.promotion_gate_path),
    }
    state.gate_report_payload["dependency_quorum"] = (
        state.candidate_dependency_quorum_payload
    )
    state.gate_report_payload["alpha_readiness"] = (
        state.candidate_alpha_readiness_payload
    )
    state.gate_report_payload["provenance"] = {
        "gate_report_trace_id": state.gate_report_trace_id,
        "recommendation_trace_id": state.recommendation_trace_id,
        "benchmark_parity_artifact": str(state.benchmark_parity_path),
        "foundation_router_parity_artifact": str(state.foundation_router_parity_path),
        "deeplob_bdlob_contract_artifact": str(state.deeplob_bdlob_report_path),
        "advisor_fallback_slo_artifact": str(state.advisor_fallback_slo_report_path),
        "contamination_registry_artifact": str(state.contamination_registry_path),
        "profitability_benchmark_artifact": str(state.profitability_benchmark_path),
        "profitability_evidence_artifact": str(state.profitability_evidence_path),
        "profitability_validation_artifact": str(state.profitability_validation_path),
        "simulation_calibration_artifact": str(
            state.simulation_calibration_report_path
        ),
        "shadow_live_deviation_artifact": str(state.shadow_live_deviation_report_path),
        "hmm_state_posterior_artifact": str(state.hmm_state_posterior_path),
        "expert_router_registry_artifact": str(state.expert_router_registry_path),
        "janus_event_car_artifact": str(state.janus_event_car_path),
        "janus_hgrm_reward_artifact": str(state.janus_hgrm_reward_path),
        "recalibration_artifact": str(state.recalibration_report_path),
        "promotion_gate_artifact": str(state.promotion_gate_path),
        "promotion_evidence_authority": {
            name: payload.get("artifact_authority")
            for name, payload in cast(
                dict[str, dict[str, Any]],
                state.gate_report_payload["promotion_evidence"],
            ).items()
            if payload.get("artifact_authority")
        },
    }
    state.gate_report_payload["vnext"] = _build_vnext_gate_summary(
        runtime_strategies=state.runtime_strategies,
        simulation_calibration_payload=state.simulation_calibration_report_payload,
        shadow_live_deviation_payload=state.shadow_live_deviation_report_payload,
    )
    state.gate_report_path.write_text(
        json.dumps(state.gate_report_payload, indent=2), encoding="utf-8"
    )
    evaluation_stage_record = _write_stage_manifest(
        stage=_STAGE_EVALUATION,
        stage_index=2,
        stage_output_dir=state.stages_dir,
        run_id=state.run_id,
        candidate_id=state.candidate_id,
        lineage_parent_hash=state.candidate_generation_stage_record.lineage_hash,
        lineage_parent_stage=state.candidate_generation_stage_record.stage,
        inputs={
            "run_id": state.run_id,
            "candidate_id": state.candidate_id,
            "recommendation_trace_id": "",
        },
        input_artifacts={
            "walkforward_results": state.walk_results_path,
            "baseline_evaluation_report": state.baseline_report_path,
            "signals": state.signals_path,
        },
        output_artifacts={
            "evaluation_report": state.evaluation_report_path,
            "gate_evaluation": state.gate_report_path,
            "benchmark_parity": state.benchmark_parity_path,
            "foundation_router_parity": state.foundation_router_parity_path,
            "deeplob_bdlob_contract": state.deeplob_bdlob_report_path,
            "advisor_fallback_slo": state.advisor_fallback_slo_report_path,
            "contamination_registry": state.contamination_registry_path,
            "profitability_benchmark": state.profitability_benchmark_path,
            "profitability_evidence": state.profitability_evidence_path,
            "profitability_validation": state.profitability_validation_path,
            "simulation_calibration": state.simulation_calibration_report_path,
            "shadow_live_deviation": state.shadow_live_deviation_report_path,
            "hmm_state_posterior": state.hmm_state_posterior_path,
            "expert_router_registry": state.expert_router_registry_path,
            "janus_event_car": state.janus_event_car_path,
            "janus_hgrm_reward": state.janus_hgrm_reward_path,
            "recalibration_report": state.recalibration_report_path,
            **(
                {
                    "strategy_factory_candidate_spec": state.strategy_factory_bridge.result.candidate_spec_path,
                    "strategy_factory_evaluation_report": state.strategy_factory_bridge.result.evaluation_report_path,
                    "strategy_factory_recommendation": state.strategy_factory_bridge.result.recommendation_artifact_path,
                    "strategy_factory_attempt_ledger": state.strategy_factory_bridge.result.attempt_ledger_path,
                    "strategy_factory_sequential_trial": state.strategy_factory_bridge.result.sequential_trial_path,
                    "strategy_factory_cost_calibration": state.strategy_factory_bridge.result.cost_calibration_path,
                    **{
                        f"strategy_factory_validation_{name}": path
                        for name, path in state.strategy_factory_bridge.result.validation_artifact_paths.items()
                    },
                }
                if state.strategy_factory_bridge is not None
                else {}
            ),
        },
        created_at=state.now,
    )
    state.stage_records.append(evaluation_stage_record)
    state.manifest_paths[_STAGE_EVALUATION] = (
        state.stages_dir / f"{_STAGE_EVALUATION}-manifest.json"
    )
    state.stage_trace_ids[_STAGE_EVALUATION] = evaluation_stage_record.stage_trace_id
    promotion_recommendation_payload = {
        "schema_version": "torghut-autonomy-promotion-recommendation-v1",
        "run_id": state.run_id,
        "candidate_id": state.candidate_id,
        "promotion_target": state.promotion_target,
        "recommendation": state.promotion_recommendation.to_payload(),
        "recommendation_trace_id": state.recommendation_trace_id,
        "stage_trace_ids": state.stage_trace_ids,
        "gates": {
            "gate_matrix_recommended_mode": state.gate_report.recommended_mode,
            "gate_matrix_allowed": state.gate_report.promotion_allowed,
            "drift_gate_allowed": bool(state.drift_gate_check.get("allowed")),
            "rollback_ready": state.rollback_check.ready,
            "prerequisite_allowed": state.promotion_check.allowed,
            "strategy_factory_allowed": state.strategy_factory_allowed,
        },
        "artifact_refs": sorted(
            set(
                [
                    str(state.gate_report_path),
                    str(state.promotion_gate_path),
                    str(state.profitability_manifest_path),
                    str(state.benchmark_parity_path),
                    str(state.advisor_fallback_slo_report_path),
                    str(state.contamination_registry_path),
                    str(state.profitability_benchmark_path),
                    str(state.profitability_evidence_path),
                    str(state.profitability_validation_path),
                    str(state.simulation_calibration_report_path),
                    str(state.shadow_live_deviation_report_path),
                    str(state.hmm_state_posterior_path),
                    str(state.expert_router_registry_path),
                    str(state.janus_event_car_path),
                    str(state.janus_hgrm_reward_path),
                    str(state.recalibration_report_path),
                    *state.strategy_factory_artifact_refs,
                ]
            )
        ),
    }
    state.promotion_recommendation_path.write_text(
        json.dumps(promotion_recommendation_payload, indent=2), encoding="utf-8"
    )
    recommendation_stage_record = _write_stage_manifest(
        stage=_STAGE_RECOMMENDATION,
        stage_index=3,
        stage_output_dir=state.stages_dir,
        run_id=state.run_id,
        candidate_id=state.candidate_id,
        lineage_parent_hash=evaluation_stage_record.lineage_hash,
        lineage_parent_stage=evaluation_stage_record.stage,
        inputs={
            "run_id": state.run_id,
            "candidate_id": state.candidate_id,
            "recommendation_trace_id": state.recommendation_trace_id or "",
            "stage_trace_ids": json.dumps(
                state.stage_trace_ids, sort_keys=True, separators=(",", ":")
            ),
        },
        input_artifacts={
            "gate_evaluation": state.gate_report_path,
            "promotion_gate": state.promotion_gate_path,
        },
        output_artifacts={
            "promotion_recommendation": state.promotion_recommendation_path
        },
        created_at=state.now,
    )
    state.stage_records.append(recommendation_stage_record)
    state.manifest_paths[_STAGE_RECOMMENDATION] = (
        state.stages_dir / f"{_STAGE_RECOMMENDATION}-manifest.json"
    )
    state.stage_trace_ids[_STAGE_RECOMMENDATION] = (
        recommendation_stage_record.stage_trace_id
    )
    state.stage_lineage_payload = _build_stage_lineage_payload(
        stage_records=state.stage_records, manifest_paths=state.manifest_paths
    )
    state.replay_artifacts = {
        "signals": state.signals_path,
        "strategy_config": state.strategy_config_path,
        "gate_policy": state.gate_policy_path,
        "walkforward_results": state.walk_results_path,
        "baseline_evaluation_report": state.baseline_report_path,
        "evaluation_report": state.evaluation_report_path,
        "gate_report": state.gate_report_path,
        "profitability_stage_manifest": state.profitability_manifest_path,
        "benchmark_parity": state.benchmark_parity_path,
        "foundation_router_parity": state.foundation_router_parity_path,
        "deeplob_bdlob_contract": state.deeplob_bdlob_report_path,
        "advisor_fallback_slo": state.advisor_fallback_slo_report_path,
        "contamination_registry": state.contamination_registry_path,
        "profitability_benchmark": state.profitability_benchmark_path,
        "profitability_evidence": state.profitability_evidence_path,
        "profitability_validation": state.profitability_validation_path,
        "simulation_calibration": state.simulation_calibration_report_path,
        "shadow_live_deviation": state.shadow_live_deviation_report_path,
        "expert_router_registry": state.expert_router_registry_path,
        "janus_event_car": state.janus_event_car_path,
        "janus_hgrm_reward": state.janus_hgrm_reward_path,
        "recalibration_report": state.recalibration_report_path,
        "promotion_gate": state.promotion_gate_path,
        "promotion_recommendation": state.promotion_recommendation_path,
        "recommendation_manifest": state.manifest_paths.get(_STAGE_RECOMMENDATION),
        "evaluation_manifest": state.manifest_paths.get(_STAGE_EVALUATION),
        "candidate_generation_manifest": state.manifest_paths.get(
            _STAGE_CANDIDATE_GENERATION
        ),
    }
    state.research_spec["stage_lineage"] = state.stage_lineage_payload
    state.research_spec["stage_trace_ids"] = dict(state.stage_trace_ids)
    state.research_spec["stage_lineage_root"] = state.stage_lineage_payload.get(
        "root_lineage_hash"
    )
    experiment_spec_payload = (
        cast(dict[str, Any], state.research_spec.get("experiment_spec"))
        if isinstance(state.research_spec.get("experiment_spec"), dict)
        else None
    )
    if experiment_spec_payload is not None:
        lineage_payload = (
            cast(dict[str, Any], experiment_spec_payload.get("lineage"))
            if isinstance(experiment_spec_payload.get("lineage"), dict)
            else {}
        )
        lineage_payload["stage_lineage_root"] = state.stage_lineage_payload.get(
            "root_lineage_hash"
        )
        lineage_payload["stage_trace_ids"] = dict(state.stage_trace_ids)
        experiment_spec_payload["lineage"] = lineage_payload
    state.research_spec["stage_manifest_refs"] = {
        _STAGE_CANDIDATE_GENERATION: str(
            state.manifest_paths[_STAGE_CANDIDATE_GENERATION]
        ),
        _STAGE_EVALUATION: str(state.manifest_paths[_STAGE_EVALUATION]),
        _STAGE_RECOMMENDATION: str(state.manifest_paths[_STAGE_RECOMMENDATION]),
        _STAGE_PROFITABILITY: str(state.profitability_manifest_path),
    }
    bridge_payload = (
        cast(dict[str, Any], state.research_spec.get("bridge_persistence_v2"))
        if isinstance(state.research_spec.get("bridge_persistence_v2"), dict)
        else {}
    )
    bridge_payload["experiment_runs"] = [
        {
            "experiment_id": str(experiment_spec_payload.get("experiment_id"))
            if experiment_spec_payload is not None
            else None,
            "run_id": state.run_id,
            "candidate_id": state.candidate_id,
            "stage_lineage_root": state.stage_lineage_payload.get("root_lineage_hash"),
        }
    ]
    bridge_payload["promotion_decisions_v2"] = [
        {
            "candidate_id": state.candidate_id,
            "run_id": state.run_id,
            "promotion_target": state.promotion_target,
            "recommended_mode": promotion_recommendation_payload.get(
                "recommended_mode"
            ),
            "eligible": state.promotion_check.allowed,
            "artifact_ref": str(state.promotion_recommendation_path),
        }
    ]
    state.research_spec["bridge_persistence_v2"] = bridge_payload
    state.research_spec["artifacts"] = {
        **state.research_spec["artifacts"],
        **{
            key: str(artifact_path)
            for key, artifact_path in state.replay_artifacts.items()
            if artifact_path is not None
        },
        "promotion_recommendation": str(state.promotion_recommendation_path),
        _STAGE_PROFITABILITY: str(state.profitability_manifest_path),
        _STAGE_CANDIDATE_GENERATION: str(
            state.manifest_paths[_STAGE_CANDIDATE_GENERATION]
        ),
        _STAGE_EVALUATION: str(state.manifest_paths[_STAGE_EVALUATION]),
        _STAGE_RECOMMENDATION: str(state.manifest_paths[_STAGE_RECOMMENDATION]),
    }
    state.candidate_spec_path.write_text(
        json.dumps(state.research_spec, indent=2), encoding="utf-8"
    )


__all__ = ["run_lineage_replay_phase"]
