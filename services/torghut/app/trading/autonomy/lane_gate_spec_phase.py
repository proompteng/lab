"""Autonomous lane phase helpers extracted from the root orchestrator."""

from __future__ import annotations

import json
from typing import Any, cast


from ..hypotheses import (
    hypothesis_registry_requires_dependency_capability,
    load_hypothesis_registry,
)
from ..reporting import (
    build_promotion_recommendation,
)
from ..strategy_specs import (
    build_compiled_strategy_artifacts,
    build_experiment_spec_from_strategy,
)
from .policy_checks import (
    evaluate_promotion_prerequisites,
    evaluate_rollback_readiness,
)
from .lane_common import (
    PROFITABILITY_STAGE_MANIFEST_PATH as _PROFITABILITY_STAGE_MANIFEST_PATH,
    STAGE_CANDIDATE_GENERATION as _STAGE_CANDIDATE_GENERATION,
)
from .lane_profitability_manifest import (
    build_profitability_stage_manifest as _build_profitability_stage_manifest,
)
from .lane_stage_artifacts import (
    artifact_authority_for_evidence as _artifact_authority_for_evidence,
    build_bridge_evidence_payload as _build_bridge_evidence_payload,
    build_portfolio_promotion_summary as _build_portfolio_promotion_summary,
    build_vnext_gate_summary as _build_vnext_gate_summary,
)


from .lane_persistence import (
    resolve_paper_patch_path as _resolve_paper_patch_path,
    trace_id as _trace_id,
)

from .lane_governance import (
    build_promotion_rationale as _build_promotion_rationale,
)


from .lane_run_summary import (
    evaluate_drift_promotion_gate as _evaluate_drift_promotion_gate,
)


from .lane_workflow_state import AutonomousLaneWorkflowState


def run_gate_report_spec_phase(state: AutonomousLaneWorkflowState) -> None:
    state.gate_report_payload["throughput"] = {
        "signal_count": len(state.signals),
        "decision_count": state.report.metrics.decision_count,
        "trade_count": state.report.metrics.trade_count,
        "no_signal_window": False,
        "no_signal_reason": None,
        "fold_metrics_count": len(state.walk_results.folds),
        "stress_metrics_count": state.stress_metrics_count,
    }
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
            "gate_reasons": sorted(state.gate_report.reasons),
            "rationale_text": "Gate matrix recommendation captured from deterministic evaluation artifacts.",
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
    state.gate_report_trace_id = _trace_id(state.gate_report_payload)
    state.gate_report_payload["dependency_quorum"] = (
        state.candidate_dependency_quorum_payload
    )
    state.gate_report_payload["alpha_readiness"] = (
        state.candidate_alpha_readiness_payload
    )
    state.gate_report_payload["provenance"] = {
        "gate_report_trace_id": state.gate_report_trace_id,
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
    state.research_spec = {
        "run_id": state.run_id,
        "candidate_id": state.candidate_id,
        "promotion_target": state.promotion_target,
        "bounded_llm": {
            "enabled": False,
            "actuation_allowed": False,
            "notes": "LLM path is advisory only. Deterministic risk/firewall are final authority.",
        },
        "runtime_errors": sorted(state.runtime_errors),
        "baseline_runtime_errors": sorted(state.baseline_runtime_errors),
        "artifacts": {
            "walkforward_results": str(state.walk_results_path),
            "evaluation_report": str(state.evaluation_report_path),
            "baseline_evaluation_report": str(state.baseline_report_path),
            "gate_report": str(state.gate_report_path),
            "benchmark_parity": str(state.benchmark_parity_path),
            "foundation_router_parity": str(state.foundation_router_parity_path),
            "deeplob_bdlob_contract": str(state.deeplob_bdlob_report_path),
            "advisor_fallback_slo": str(state.advisor_fallback_slo_report_path),
            "contamination_registry": str(state.contamination_registry_path),
            "profitability_benchmark": str(state.profitability_benchmark_path),
            "profitability_evidence": str(state.profitability_evidence_path),
            "profitability_validation": str(state.profitability_validation_path),
            "simulation_calibration": str(state.simulation_calibration_report_path),
            "shadow_live_deviation": str(state.shadow_live_deviation_report_path),
            "stress_metrics": str(state.stress_metrics_path),
            "hmm_state_posterior": str(state.hmm_state_posterior_path),
            "expert_router_registry": str(state.expert_router_registry_path),
            "fold_metrics": str(state.fold_metrics_path),
            "janus_event_car": str(state.janus_event_car_path),
            "janus_hgrm_reward": str(state.janus_hgrm_reward_path),
            "recalibration_report": str(state.recalibration_report_path),
        },
        "candidate_spec": {
            "runtime_strategies": [
                {
                    "strategy_id": strategy.strategy_id,
                    "strategy_type": strategy.strategy_type,
                    "version": strategy.version,
                    "params": strategy.params,
                    "enabled": strategy.enabled,
                    "compiler_source": strategy.compiler_source,
                    "strategy_spec_v2": strategy.strategy_spec,
                    "compiled_targets": strategy.compiled_targets,
                }
                for strategy in state.runtime_strategies
            ]
        },
        "strategy_specs_v2": [
            strategy.strategy_spec
            for strategy in state.runtime_strategies
            if strategy.compiler_source == "spec_v2" and strategy.strategy_spec
        ],
        "compiled_runtime_targets": {
            strategy.strategy_id: strategy.compiled_targets
            for strategy in state.runtime_strategies
            if strategy.compiler_source == "spec_v2" and strategy.compiled_targets
        },
        "bridge_persistence_v2": {
            "dataset_snapshots": [
                {
                    "dataset_id": f"dataset-{state.run_id}",
                    "source": "historical_market_replay",
                    "artifact_ref": str(state.walk_results_path),
                }
            ],
            "feature_view_specs": [
                {
                    "strategy_id": strategy.strategy_id,
                    "feature_view_spec_ref": str(
                        strategy.strategy_spec.get("feature_view_spec_ref", "")
                    ).strip()
                    if strategy.strategy_spec
                    else "",
                }
                for strategy in state.runtime_strategies
                if strategy.strategy_spec
            ],
            "model_artifacts": [
                {
                    "strategy_id": strategy.strategy_id,
                    "model_ref": str(
                        strategy.strategy_spec.get("model_ref")
                        or strategy.strategy_spec.get("deterministic_rule_ref", "")
                    ).strip(),
                }
                for strategy in state.runtime_strategies
                if strategy.strategy_spec
            ],
            "simulation_calibrations": [
                {"artifact_ref": str(state.simulation_calibration_report_path)}
            ],
            "shadow_live_deviations": [
                {"artifact_ref": str(state.shadow_live_deviation_report_path)}
            ],
            "promotion_decisions_v2": [],
        },
        "portfolio_promotion_v2": _build_portfolio_promotion_summary(
            state.runtime_strategies
        ),
        "dependency_quorum": state.candidate_dependency_quorum_payload,
        "alpha_readiness": state.candidate_alpha_readiness_payload,
    }
    if state.strategy_factory_bridge is not None:
        state.research_spec["artifacts"].update(
            {
                "strategy_factory_candidate_spec": str(
                    state.strategy_factory_bridge.result.candidate_spec_path
                ),
                "strategy_factory_evaluation_report": str(
                    state.strategy_factory_bridge.result.evaluation_report_path
                ),
                "strategy_factory_recommendation": str(
                    state.strategy_factory_bridge.result.recommendation_artifact_path
                ),
                "strategy_factory_attempt_ledger": str(
                    state.strategy_factory_bridge.result.attempt_ledger_path
                ),
                "strategy_factory_sequential_trial": str(
                    state.strategy_factory_bridge.result.sequential_trial_path
                ),
                "strategy_factory_cost_calibration": str(
                    state.strategy_factory_bridge.result.cost_calibration_path
                ),
                "strategy_factory_candidate_generation_manifest": str(
                    state.strategy_factory_bridge.result.candidate_generation_manifest_path
                ),
                "strategy_factory_evaluation_manifest": str(
                    state.strategy_factory_bridge.result.evaluation_manifest_path
                ),
                "strategy_factory_recommendation_manifest": str(
                    state.strategy_factory_bridge.result.recommendation_manifest_path
                ),
            }
        )
        for (
            validation_name,
            validation_path,
        ) in state.strategy_factory_bridge.result.validation_artifact_paths.items():
            state.research_spec["artifacts"][
                f"strategy_factory_validation_{validation_name}"
            ] = str(validation_path)
        state.research_spec["strategy_factory"] = {
            **state.strategy_factory_bridge.candidate_spec_payload.get(
                "strategy_factory", {}
            ),
            "recommendation": state.strategy_factory_bridge.recommendation_payload.get(
                "recommendation"
            ),
            "evaluation_summary": state.strategy_factory_bridge.evaluation_payload.get(
                "evidence_summary"
            ),
            "attempt_ledger": state.strategy_factory_bridge.attempt_payload,
            "validation_tests": list(
                state.strategy_factory_bridge.validation_payloads.values()
            ),
            "cost_calibration": state.strategy_factory_bridge.cost_calibration_payload,
            "sequential_trial": state.strategy_factory_bridge.sequential_trial_payload,
            "stage_manifest_refs": {
                "candidate-generation": str(
                    state.strategy_factory_bridge.result.candidate_generation_manifest_path
                ),
                "evaluation": str(
                    state.strategy_factory_bridge.result.evaluation_manifest_path
                ),
                "promotion-recommendation": str(
                    state.strategy_factory_bridge.result.recommendation_manifest_path
                ),
            },
            "stage_trace_ids": dict(
                state.strategy_factory_bridge.result.stage_trace_ids
            ),
            "stage_lineage_root": state.strategy_factory_bridge.result.stage_lineage_root,
            "gate_summary": state.strategy_factory_summary,
        }
    if state.runtime_strategies:
        primary_strategy = state.runtime_strategies[0]
        if (
            primary_strategy.compiler_source == "spec_v2"
            and primary_strategy.strategy_spec
        ):
            compiled_spec = build_compiled_strategy_artifacts(
                strategy_id=primary_strategy.strategy_id,
                strategy_type=primary_strategy.strategy_type,
                semantic_version=primary_strategy.version,
                params=primary_strategy.params,
                base_timeframe=primary_strategy.base_timeframe,
                source="spec_v2",
            )
            state.research_spec["experiment_spec"] = (
                build_experiment_spec_from_strategy(
                    experiment_id=f"exp-{state.run_id}",
                    hypothesis=f"compiled-{primary_strategy.strategy_type}-evaluation",
                    strategy_spec=compiled_spec.strategy_spec,
                    parent_experiment_ids=[f"candidate-{state.candidate_id}"],
                    llm_provenance={"mode": "advisory_only", "source": "none"},
                    lineage={
                        "candidate_id": state.candidate_id,
                        "run_id": state.run_id,
                        "source": "autonomous_lane",
                    },
                    research_memory={
                        "summary": f"{primary_strategy.strategy_id}:{primary_strategy.version}",
                        "runtime_errors": sorted(state.runtime_errors),
                        "baseline_runtime_errors": sorted(
                            state.baseline_runtime_errors
                        ),
                    },
                ).to_payload()
            )
    state.candidate_spec_path = state.research_dir / "candidate-spec.json"
    state.patch_path = None
    state.raw_gate_policy = state.gate_policy_payload
    state.patch_path = _resolve_paper_patch_path(
        gate_report=state.gate_report,
        strategy_configmap_path=state.strategy_configmap_path,
        runtime_strategies=state.runtime_strategies,
        candidate_id=state.candidate_id,
        paper_dir=state.paper_dir,
        promotion_target=state.promotion_target,
    )
    state.rollback_check = evaluate_rollback_readiness(
        policy_payload=state.raw_gate_policy,
        candidate_state_payload=state.candidate_state_payload,
        now=state.now,
    )
    state.rollback_check_path.write_text(
        json.dumps(state.rollback_check.to_payload(), indent=2), encoding="utf-8"
    )
    state.drift_gate_check = _evaluate_drift_promotion_gate(
        promotion_target=state.promotion_target,
        drift_promotion_evidence=state.drift_promotion_evidence,
    )
    state.candidate_spec_path.write_text(
        json.dumps(state.research_spec, indent=2), encoding="utf-8"
    )
    state.profitability_run_context = {
        "repository": str(state.resolved_governance_repository or ""),
        "base": str(state.resolved_governance_base or ""),
        "head": str(state.resolved_governance_head or ""),
        "artifact_path": state.notes_artifact_root or str(state.output_dir),
        "run_id": state.run_id,
        "design_doc": str(state.resolved_design_doc or ""),
        "priority_id": str(state.resolved_governance_priority_id or ""),
    }


def write_current_profitability_manifest(state: AutonomousLaneWorkflowState) -> None:
    profitability_manifest_payload = _build_profitability_stage_manifest(
        output_dir=state.output_dir,
        run_id=state.run_id,
        candidate_id=state.candidate_id,
        strategy_family=state.strategy_family,
        llm_artifact_ref=None,
        router_artifact_ref=state.router_artifact_ref,
        run_context=state.profitability_run_context,
        research_manifest_path=state.manifest_paths.get(_STAGE_CANDIDATE_GENERATION),
        candidate_spec_path=state.candidate_spec_path,
        evaluation_report_path=state.evaluation_report_path,
        walkforward_results_path=state.walk_results_path,
        baseline_evaluation_report_path=state.baseline_report_path,
        gate_report_payload=state.gate_report_payload,
        gate_report_path=state.gate_report_path,
        profitability_benchmark_path=state.profitability_benchmark_path,
        contamination_registry_path=state.contamination_registry_path,
        profitability_evidence_path=state.profitability_evidence_path,
        profitability_validation_path=state.profitability_validation_path,
        simulation_calibration_report_path=state.simulation_calibration_report_path,
        shadow_live_deviation_report_path=state.shadow_live_deviation_report_path,
        hmm_state_posterior_path=state.hmm_state_posterior_path,
        expert_router_registry_path=state.expert_router_registry_path,
        benchmark_parity_path=state.benchmark_parity_path,
        foundation_router_parity_path=state.foundation_router_parity_path,
        deeplob_bdlob_report_path=state.deeplob_bdlob_report_path,
        advisor_fallback_slo_report_path=state.advisor_fallback_slo_report_path,
        janus_event_car_path=state.janus_event_car_path,
        janus_hgrm_reward_path=state.janus_hgrm_reward_path,
        recalibration_report_path=state.recalibration_report_path,
        rollback_check=state.rollback_check,
        drift_gate_check=state.drift_gate_check,
        patch_path=state.patch_path,
        now=state.now,
    )
    state.profitability_manifest_path.parent.mkdir(parents=True, exist_ok=True)
    state.profitability_manifest_path.write_text(
        json.dumps(profitability_manifest_payload, indent=2), encoding="utf-8"
    )


def build_promotion_policy_payload(
    state: AutonomousLaneWorkflowState,
) -> dict[str, Any]:
    promotion_policy_payload = dict(state.raw_gate_policy)
    promotion_policy_payload["promotion_require_profitability_stage_manifest"] = True
    promotion_policy_payload["promotion_require_truthful_evidence_contracts"] = True
    require_jangar_dependency_quorum = (
        hypothesis_registry_requires_dependency_capability(
            load_hypothesis_registry(), "jangar_dependency_quorum"
        )
    )
    promotion_policy_payload["promotion_require_jangar_dependency_quorum"] = (
        require_jangar_dependency_quorum
    )
    if require_jangar_dependency_quorum:
        promotion_policy_payload.setdefault(
            "promotion_jangar_dependency_quorum_required_targets", ["paper", "live"]
        )
    else:
        promotion_policy_payload.pop(
            "promotion_jangar_dependency_quorum_required_targets", None
        )
    promotion_policy_payload["promotion_require_alpha_readiness_contract"] = True
    promotion_policy_payload.setdefault(
        "promotion_alpha_readiness_required_targets", ["paper", "live"]
    )
    promotion_policy_payload.setdefault(
        "promotion_alpha_readiness_require_registry_match", True
    )
    promotion_policy_payload.setdefault(
        "promotion_require_simulation_calibration", True
    )
    promotion_policy_payload.setdefault(
        "promotion_simulation_calibration_required_artifacts",
        ["gates/simulation-calibration-report-v1.json"],
    )
    promotion_policy_payload.setdefault(
        "promotion_simulation_calibration_required_targets", ["paper", "live"]
    )
    promotion_policy_payload.setdefault(
        "promotion_simulation_calibration_min_order_count", 1
    )
    promotion_policy_payload.setdefault(
        "promotion_simulation_calibration_min_expected_shortfall_coverage", "0.50"
    )
    promotion_policy_payload.setdefault(
        "promotion_simulation_calibration_max_avg_calibration_error_bps", "25"
    )
    promotion_policy_payload.setdefault("promotion_require_shadow_live_deviation", True)
    promotion_policy_payload.setdefault(
        "promotion_shadow_live_deviation_required_artifacts",
        ["gates/shadow-live-deviation-report-v1.json"],
    )
    promotion_policy_payload.setdefault(
        "promotion_shadow_live_deviation_required_targets", ["paper", "live"]
    )
    promotion_policy_payload.setdefault(
        "promotion_shadow_live_deviation_min_order_count", 1
    )
    promotion_policy_payload.setdefault(
        "promotion_shadow_live_deviation_max_avg_abs_slippage_bps", "20"
    )
    promotion_policy_payload.setdefault(
        "promotion_shadow_live_deviation_max_avg_abs_divergence_bps", "15"
    )
    promotion_policy_payload.setdefault(
        "promotion_profitability_stage_manifest_artifact",
        _PROFITABILITY_STAGE_MANIFEST_PATH,
    )
    return promotion_policy_payload


def evaluate_promotion_prerequisite_phase(
    state: AutonomousLaneWorkflowState, promotion_policy_payload: dict[str, Any]
) -> None:
    state.promotion_check = evaluate_promotion_prerequisites(
        policy_payload=promotion_policy_payload,
        gate_report_payload=state.gate_report_payload,
        candidate_state_payload=state.candidate_state_payload,
        promotion_target=state.promotion_target,
        artifact_root=state.output_dir,
        now=state.now,
    )
    state.promotion_check_path.write_text(
        json.dumps(state.promotion_check.to_payload(), indent=2), encoding="utf-8"
    )


def record_promotion_recommendation(state: AutonomousLaneWorkflowState) -> None:
    state.fold_metrics_count = len(state.walk_results.folds)
    state.promotion_recommendation = build_promotion_recommendation(
        run_id=state.run_id,
        candidate_id=state.candidate_id,
        requested_mode=state.promotion_target,
        recommended_mode=state.gate_report.recommended_mode,
        gate_allowed=state.gate_report.promotion_allowed
        and bool(state.drift_gate_check["allowed"]),
        prerequisite_allowed=state.promotion_check.allowed
        and state.strategy_factory_allowed,
        rollback_ready=state.rollback_check.ready,
        fold_metrics_count=state.fold_metrics_count,
        stress_metrics_count=state.stress_metrics_count,
        rationale=_build_promotion_rationale(
            gate_report=state.gate_report,
            promotion_check_reasons=state.promotion_check.reasons,
            rollback_check_reasons=state.rollback_check.reasons,
            promotion_target=state.promotion_target,
            additional_reasons=state.strategy_factory_reasons,
        ),
        reasons=[
            *state.gate_report.reasons,
            *state.promotion_check.reasons,
            *state.strategy_factory_reasons,
            *state.rollback_check.reasons,
            *[
                str(item)
                for item in state.drift_gate_check.get("reasons", [])
                if str(item).strip()
            ],
        ],
    )
    state.promotion_allowed = state.promotion_recommendation.eligible
    if state.patch_path is None and state.promotion_allowed:
        state.patch_path = _resolve_paper_patch_path(
            gate_report=state.gate_report,
            strategy_configmap_path=state.strategy_configmap_path,
            runtime_strategies=state.runtime_strategies,
            candidate_id=state.candidate_id,
            promotion_target=state.promotion_target,
            paper_dir=state.paper_dir,
        )
    state.promotion_reasons = state.promotion_recommendation.reasons
    state.recommended_mode = state.promotion_recommendation.recommended_mode
    state.recommendation_trace_id = state.promotion_recommendation.trace_id
    state.research_spec["promotion_recommendation"] = (
        state.promotion_recommendation.to_payload()
    )
    state.research_spec["promotion_evidence_requirements"] = {
        "fold_metrics_count": len(state.fold_evidence),
        "stress_case_count": len(state.stress_evidence),
        "deeplob_bdlob_contract_required": True,
        "advisor_fallback_slo_required": True,
        "strategy_factory_required": state.strategy_factory_bridge is not None,
        "rationale_required": True,
        "rationale_reason_codes": state.promotion_reasons,
    }
    state.candidate_spec_path.write_text(
        json.dumps(state.research_spec, indent=2), encoding="utf-8"
    )


def promotion_gate_artifact_refs(state: AutonomousLaneWorkflowState) -> list[str]:
    return sorted(
        {
            str(state.promotion_check_path),
            str(state.rollback_check_path),
            str(state.gate_report_path),
            str(state.benchmark_parity_path),
            str(state.deeplob_bdlob_report_path),
            str(state.advisor_fallback_slo_report_path),
            str(state.contamination_registry_path),
            str(state.profitability_benchmark_path),
            str(state.profitability_evidence_path),
            str(state.profitability_validation_path),
            str(state.simulation_calibration_report_path),
            str(state.shadow_live_deviation_report_path),
            str(state.fold_metrics_path),
            str(state.stress_metrics_path),
            str(state.hmm_state_posterior_path),
            str(state.expert_router_registry_path),
            str(state.janus_event_car_path),
            str(state.janus_hgrm_reward_path),
            *[
                str(item)
                for item in state.drift_gate_check.get("artifact_refs", [])
                if str(item).strip()
            ],
            str(state.recalibration_report_path),
            *state.strategy_factory_artifact_refs,
        }
    )


def write_promotion_gate_payload(state: AutonomousLaneWorkflowState) -> None:
    promotion_gate_payload: dict[str, Any] = {
        "allowed": state.promotion_allowed,
        "recommended_mode": state.recommended_mode,
        "reasons": state.promotion_reasons,
        "checks": {
            "gate_matrix": {
                "allowed": state.gate_report.promotion_allowed,
                "reasons": state.gate_report.reasons,
                "artifact_refs": [
                    str(state.gate_report_path),
                    str(state.benchmark_parity_path),
                    str(state.deeplob_bdlob_report_path),
                    str(state.advisor_fallback_slo_report_path),
                    str(state.profitability_evidence_path),
                    str(state.profitability_validation_path),
                    str(state.simulation_calibration_report_path),
                    str(state.shadow_live_deviation_report_path),
                    str(state.stress_metrics_path),
                    str(state.hmm_state_posterior_path),
                    str(state.expert_router_registry_path),
                    str(state.fold_metrics_path),
                    str(state.janus_event_car_path),
                    str(state.janus_hgrm_reward_path),
                    str(state.recalibration_report_path),
                    *state.strategy_factory_artifact_refs,
                ],
            },
            "promotion_prerequisites": state.promotion_check.to_payload(),
            "rollback_readiness": state.rollback_check.to_payload(),
            "profitability_validation": state.profitability_validation.to_payload(),
            "janus_q": state.janus_q_summary,
            "drift_governance": state.drift_gate_check,
            "evidence_requirements": state.promotion_recommendation.evidence.to_payload(),
        },
        "recommendation": state.promotion_recommendation.to_payload(),
        "artifact_refs": promotion_gate_artifact_refs(state),
    }
    if state.strategy_factory_bridge is not None:
        promotion_gate_checks = cast(dict[str, Any], promotion_gate_payload["checks"])
        promotion_gate_checks["strategy_factory"] = dict(state.strategy_factory_summary)
    state.promotion_gate_path.write_text(
        json.dumps(promotion_gate_payload, indent=2), encoding="utf-8"
    )
    state.gate_report_payload["promotion_recommendation"] = (
        state.promotion_recommendation.to_payload()
    )


def run_promotion_recommendation_phase(state: AutonomousLaneWorkflowState) -> None:
    write_current_profitability_manifest(state)
    evaluate_promotion_prerequisite_phase(state, build_promotion_policy_payload(state))
    record_promotion_recommendation(state)
    write_promotion_gate_payload(state)


__all__ = [
    "run_gate_report_spec_phase",
    "write_current_profitability_manifest",
    "build_promotion_policy_payload",
    "evaluate_promotion_prerequisite_phase",
    "record_promotion_recommendation",
    "promotion_gate_artifact_refs",
    "write_promotion_gate_payload",
    "run_promotion_recommendation_phase",
]
