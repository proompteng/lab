"""Autonomous lane phase helpers extracted from the root orchestrator."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


from ...config import settings
from ..evaluation import (
    FoldResult,
    ProfitabilityEvidenceThresholdsV4,
    WalkForwardFold,
    WalkForwardResults,
    build_profitability_evidence_v4,
    build_shadow_live_deviation_report_v1,
    build_simulation_calibration_report_v1,
    execute_profitability_benchmark_v4,
    validate_profitability_evidence_v4,
    write_walk_forward_results,
)
from ..evidence_contracts import (
    ArtifactProvenance,
    EvidenceMaturity,
    evidence_contract_payload,
)
from ..parity import (
    build_advisor_fallback_slo_report,
    build_benchmark_parity_report,
    build_deeplob_bdlob_report,
    build_foundation_router_parity_report,
    write_advisor_fallback_slo_report,
    write_benchmark_parity_report,
    write_deeplob_bdlob_report,
    write_foundation_router_parity_report,
)
from ..reporting import (
    EvaluationReport,
    EvaluationReportConfig,
    generate_evaluation_report,
    write_evaluation_report,
)
from .gates import (
    GateInputs,
    GatePolicyMatrix,
    evaluate_gate_matrix,
)
from .janus_q import (
    build_janus_event_car_artifact_v1,
    build_janus_hgrm_reward_artifact_v1,
    build_janus_q_evidence_summary_v1,
)
from .runtime import (
    StrategyRuntimeConfig,
)
from .lane_candidate_payloads import (
    build_candidate_alpha_readiness_payload as _build_candidate_alpha_readiness_payload,
    build_candidate_state_payload as _build_candidate_state_payload,
    is_runbook_valid as _is_runbook_valid,
)
from .lane_common import (
    STAGE_CANDIDATE_GENERATION as _STAGE_CANDIDATE_GENERATION,
    STRESS_METRICS_CASES as _STRESS_METRICS_CASES,
    coerce_evidence_bool as _coerce_evidence_bool,
    sha256_path as _sha256_path,
)
from .lane_phase_payloads import (
    candidate_state_readiness_payload as _candidate_state_readiness_payload,
    coerce_int as _coerce_int,
    coerce_str as _coerce_str,
)
from .lane_regime_artifacts import (
    build_contamination_registry_payload as _build_contamination_registry_payload,
    build_expert_router_registry_payload as _build_expert_router_registry_payload,
    build_hmm_state_posterior_payload as _build_hmm_state_posterior_payload,
    decimal_or_zero as _decimal_or_zero,
)
from .lane_stage_artifacts import (
    extract_janus_q_metrics as _extract_janus_q_metrics,
    write_stage_manifest as _write_stage_manifest,
)
from .lane_strategy_factory import (
    build_strategy_factory_bridge as _build_strategy_factory_bridge,
    strategy_factory_artifact_refs as _strategy_factory_artifact_refs,
    strategy_factory_gate_summary as _strategy_factory_gate_summary,
)

from .lane_config_loading import (
    required_feature_null_rate as _required_feature_null_rate,
    build_stress_bundle as _build_stress_bundle,
)

from .lane_persistence import (
    collect_walk_decisions_for_runtime as _collect_walk_decisions_for_runtime,
    resolve_confidence_calibration as _resolve_confidence_calibration,
)


from .lane_gate_inputs import (
    resolve_gate_fragility_inputs as _resolve_gate_fragility_inputs,
    resolve_gate_forecast_metrics as _resolve_gate_forecast_metrics,
    resolve_gate_staleness_ms_p95 as _resolve_gate_staleness_ms_p95,
    resolve_gate_llm_metrics as _resolve_gate_llm_metrics,
    load_tca_gate_inputs as _load_tca_gate_inputs,
)

from .lane_run_summary import (
    baseline_runtime_strategies as _baseline_runtime_strategies,
    profitability_threshold_payload as _profitability_threshold_payload,
    collect_confidence_values as _collect_confidence_values,
    to_orm_strategies as _to_orm_strategies,
)


from .lane_workflow_state import AutonomousLaneWorkflowState


def run_strategy_factory_gate(state: AutonomousLaneWorkflowState) -> None:
    state.strategy_factory_bridge = _build_strategy_factory_bridge(
        output_dir=state.output_dir,
        notes_artifact_root=state.notes_artifact_root,
        train_prices_path=state.alpha_train_prices_path,
        test_prices_path=state.alpha_test_prices_path,
        alpha_gate_policy_path=state.alpha_gate_policy_path,
        repository=state.resolved_governance_repository
        if isinstance(state.resolved_governance_repository, str)
        else state.repository,
        base=state.resolved_governance_base
        if isinstance(state.resolved_governance_base, str)
        else state.base,
        head=state.resolved_governance_head
        if isinstance(state.resolved_governance_head, str)
        else state.head,
        priority_id=state.resolved_governance_priority_id
        if isinstance(state.resolved_governance_priority_id, str)
        else state.resolved_priority_id,
        promotion_target=state.promotion_target,
        now=state.now,
    )
    if state.strategy_factory_bridge is None:
        return
    (
        state.strategy_factory_allowed,
        state.strategy_factory_reasons,
        state.strategy_factory_summary,
    ) = _strategy_factory_gate_summary(
        state.strategy_factory_bridge, promotion_target=state.promotion_target
    )
    state.strategy_factory_artifact_refs = _strategy_factory_artifact_refs(
        state.strategy_factory_bridge
    )


def build_walkforward_artifacts(
    state: AutonomousLaneWorkflowState,
) -> tuple[list[StrategyRuntimeConfig], WalkForwardResults]:
    state.ordered_signals = sorted(
        state.signals, key=lambda item: (item.event_ts, item.symbol, item.seq or 0)
    )
    state.strategy_family = _coerce_str(
        state.runtime_strategies[0].strategy_type
        if state.runtime_strategies
        else "deterministic"
    )
    state.router_artifact_ref = str(state.strategy_config_path)
    state.walk_decisions, state.runtime_errors = _collect_walk_decisions_for_runtime(
        runtime=state.runtime,
        ordered_signals=state.ordered_signals,
        runtime_strategies=state.runtime_strategies,
    )
    baseline_runtime_strategies = _baseline_runtime_strategies()
    baseline_walk_decisions, state.baseline_runtime_errors = (
        _collect_walk_decisions_for_runtime(
            runtime=state.runtime,
            ordered_signals=state.ordered_signals,
            runtime_strategies=baseline_runtime_strategies,
        )
    )
    walk_fold = WalkForwardFold(
        name="autonomous_lane",
        train_start=state.signals[0].event_ts,
        train_end=state.signals[0].event_ts,
        test_start=state.signals[0].event_ts,
        test_end=state.signals[-1].event_ts,
    )
    state.walk_results = WalkForwardResults(
        generated_at=state.now,
        folds=[
            FoldResult(
                fold=walk_fold,
                decisions=state.walk_decisions,
                signals_count=len(state.signals),
            )
        ],
        feature_spec="app.trading.features.normalize_feature_vector_v3",
    )
    baseline_walk_results = WalkForwardResults(
        generated_at=state.now,
        folds=[
            FoldResult(
                fold=walk_fold,
                decisions=baseline_walk_decisions,
                signals_count=len(state.signals),
            )
        ],
        feature_spec="app.trading.features.normalize_feature_vector_v3",
    )
    state.walk_results_path = state.backtest_dir / "walkforward-results.json"
    write_walk_forward_results(state.walk_results, state.walk_results_path)
    return (baseline_runtime_strategies, baseline_walk_results)


def write_evaluation_artifacts(
    state: AutonomousLaneWorkflowState,
    baseline_runtime_strategies: list[StrategyRuntimeConfig],
    baseline_walk_results: WalkForwardResults,
) -> EvaluationReport:
    state.hmm_state_posterior_payload = _build_hmm_state_posterior_payload(
        output_dir=state.output_dir,
        run_id=state.run_id,
        candidate_id=state.candidate_id,
        now=state.now,
        walk_decisions=state.walk_decisions,
        walkforward_results_path=state.walk_results_path,
        gate_policy_path=state.gate_policy_path,
    )
    state.hmm_state_posterior_path.parent.mkdir(parents=True, exist_ok=True)
    state.hmm_state_posterior_path.write_text(
        json.dumps(state.hmm_state_posterior_payload, indent=2), encoding="utf-8"
    )
    state.report = generate_evaluation_report(
        state.walk_results,
        config=EvaluationReportConfig(
            evaluation_start=state.signals[0].event_ts,
            evaluation_end=state.signals[-1].event_ts,
            signal_source=str(state.signals_path),
            strategies=_to_orm_strategies(state.runtime_strategies),
            run_id=state.run_id,
            strategy_config_path=str(state.strategy_config_path),
            git_sha=state.code_version,
        ),
        promotion_target=state.promotion_target,
    )
    state.evaluation_report_path = state.backtest_dir / "evaluation-report.json"
    write_evaluation_report(state.report, state.evaluation_report_path)
    state.baseline_candidate_id = "baseline-legacy-macd-rsi"
    baseline_report = generate_evaluation_report(
        baseline_walk_results,
        config=EvaluationReportConfig(
            evaluation_start=state.signals[0].event_ts,
            evaluation_end=state.signals[-1].event_ts,
            signal_source=str(state.signals_path),
            strategies=_to_orm_strategies(baseline_runtime_strategies),
            run_id=f"{state.run_id}-baseline",
            strategy_config_path=f"baseline:{state.baseline_candidate_id}@1.0.0",
            git_sha=state.code_version,
        ),
        promotion_target="shadow",
    )
    write_evaluation_report(baseline_report, state.baseline_report_path)
    state.candidate_generation_stage_record = _write_stage_manifest(
        stage=_STAGE_CANDIDATE_GENERATION,
        stage_index=1,
        stage_output_dir=state.stages_dir,
        run_id=state.run_id,
        candidate_id=state.candidate_id,
        lineage_parent_hash=None,
        lineage_parent_stage=None,
        inputs={
            "run_id": state.run_id,
            "candidate_id": state.candidate_id,
            "promotion_target": state.promotion_target,
            "strategy_count": str(len(state.runtime_strategies)),
        },
        input_artifacts={
            "signals": state.signals_path,
            "strategy_config": state.strategy_config_path,
            "gate_policy": state.gate_policy_path,
        },
        output_artifacts={
            "walkforward_results": state.walk_results_path,
            "baseline_evaluation_report": state.baseline_report_path,
            "evaluation_report": None,
        },
        created_at=state.now,
    )
    state.stage_records.append(state.candidate_generation_stage_record)
    state.manifest_paths[_STAGE_CANDIDATE_GENERATION] = (
        state.stages_dir / f"{_STAGE_CANDIDATE_GENERATION}-manifest.json"
    )
    state.stage_trace_ids[_STAGE_CANDIDATE_GENERATION] = (
        state.candidate_generation_stage_record.stage_trace_id
    )
    return baseline_report


def write_janus_and_benchmark_artifacts(
    state: AutonomousLaneWorkflowState, baseline_report: EvaluationReport
) -> None:
    janus_event_car = build_janus_event_car_artifact_v1(
        run_id=state.run_id, signals=state.ordered_signals, generated_at=state.now
    )
    state.janus_event_car_path.write_text(
        json.dumps(janus_event_car.to_payload(), indent=2), encoding="utf-8"
    )
    janus_hgrm_reward = build_janus_hgrm_reward_artifact_v1(
        run_id=state.run_id,
        candidate_id=state.candidate_id,
        event_car=janus_event_car,
        walk_decisions=state.walk_decisions,
        generated_at=state.now,
    )
    state.janus_hgrm_reward_path.write_text(
        json.dumps(janus_hgrm_reward.to_payload(), indent=2), encoding="utf-8"
    )
    state.janus_q_summary = build_janus_q_evidence_summary_v1(
        event_car=janus_event_car,
        hgrm_reward=janus_hgrm_reward,
        event_car_artifact_ref=str(state.janus_event_car_path),
        hgrm_reward_artifact_ref=str(state.janus_hgrm_reward_path),
    )
    (
        state.janus_event_count,
        state.janus_reward_count,
        state.janus_evidence_complete,
        state.janus_reasons,
    ) = _extract_janus_q_metrics(state.janus_q_summary)
    state.benchmark = execute_profitability_benchmark_v4(
        candidate_id=state.candidate_id,
        baseline_id=state.baseline_candidate_id,
        candidate_report_payload=state.report.to_payload(),
        baseline_report_payload=baseline_report.to_payload(),
        required_slice_keys=[
            "market:all",
            f"regime:{state.walk_results.folds[0].fold_metrics()['regime_label']}",
        ],
        executed_at=state.now,
    )
    state.profitability_benchmark_path.write_text(
        json.dumps(state.benchmark.to_payload(), indent=2), encoding="utf-8"
    )
    benchmark_parity_report = build_benchmark_parity_report(
        candidate_id=state.candidate_id,
        baseline_candidate_id=state.baseline_candidate_id,
        now=state.now,
    )
    write_benchmark_parity_report(benchmark_parity_report, state.benchmark_parity_path)


def write_router_contract_artifacts(state: AutonomousLaneWorkflowState) -> None:
    state.gate_policy_payload = json.loads(
        state.gate_policy_path.read_text(encoding="utf-8")
    )
    foundation_router_parity_report = build_foundation_router_parity_report(
        candidate_id=state.candidate_id,
        router_policy_version=str(
            state.gate_policy_payload.get(
                "forecast_router_policy_version", "forecast_router_policy_v1"
            )
        ),
        now=state.now,
    )
    write_foundation_router_parity_report(
        foundation_router_parity_report, state.foundation_router_parity_path
    )
    deeplob_bdlob_report = build_deeplob_bdlob_report(
        candidate_id=state.candidate_id,
        feature_policy_version=str(
            state.gate_policy_payload.get(
                "required_feature_schema_version",
                settings.trading_feature_schema_version,
            )
        ),
        now=state.now,
    )
    write_deeplob_bdlob_report(deeplob_bdlob_report, state.deeplob_bdlob_report_path)
    state.advisor_fallback_slo_report = build_advisor_fallback_slo_report(
        candidate_id=state.candidate_id,
        advisor_policy_version=str(
            state.gate_policy_payload.get("policy_version", "v3-gates-1")
        ),
        now=state.now,
    )
    write_advisor_fallback_slo_report(
        state.advisor_fallback_slo_report, state.advisor_fallback_slo_report_path
    )
    state.expert_router_registry_payload = _build_expert_router_registry_payload(
        output_dir=state.output_dir,
        run_id=state.run_id,
        candidate_id=state.candidate_id,
        now=state.now,
        walk_decisions=state.walk_decisions,
        walkforward_results_path=state.walk_results_path,
        gate_policy_path=state.gate_policy_path,
        strategy_config_path=state.strategy_config_path,
        hmm_state_posterior_path=state.hmm_state_posterior_path,
        policy_payload=state.gate_policy_payload,
    )
    state.expert_router_registry_path.parent.mkdir(parents=True, exist_ok=True)
    state.expert_router_registry_path.write_text(
        json.dumps(state.expert_router_registry_payload, indent=2), encoding="utf-8"
    )


def run_candidate_generation_phase(state: AutonomousLaneWorkflowState) -> None:
    run_strategy_factory_gate(state)
    baseline_runtime_strategies, baseline_walk_results = build_walkforward_artifacts(
        state
    )
    baseline_report = write_evaluation_artifacts(
        state, baseline_runtime_strategies, baseline_walk_results
    )
    write_janus_and_benchmark_artifacts(state, baseline_report)
    write_router_contract_artifacts(state)


def artifact_ref(state: AutonomousLaneWorkflowState, path: Path) -> str:
    if state.output_dir.is_absolute():
        return str(path)
    return str(path.relative_to(state.output_dir))


def write_profitability_evidence_artifacts(
    state: AutonomousLaneWorkflowState,
) -> tuple[Any, dict[str, Any], dict[str, object]]:
    profitability_evidence = build_profitability_evidence_v4(
        run_id=state.run_id,
        candidate_id=state.candidate_id,
        baseline_id=state.baseline_candidate_id,
        candidate_report_payload=state.report.to_payload(),
        benchmark=state.benchmark,
        confidence_values=_collect_confidence_values(state.walk_decisions),
        reproducibility_hashes={
            "signals": _sha256_path(state.signals_path),
            "strategy_config": _sha256_path(state.strategy_config_path),
            "gate_policy": _sha256_path(state.gate_policy_path),
            "walkforward_results": _sha256_path(state.walk_results_path),
            "foundation_router_parity": _sha256_path(
                state.foundation_router_parity_path
            ),
            "deeplob_bdlob_contract": _sha256_path(state.deeplob_bdlob_report_path),
            "advisor_fallback_slo": _sha256_path(
                state.advisor_fallback_slo_report_path
            ),
            "hmm_state_posterior": _sha256_path(state.hmm_state_posterior_path),
            "expert_router_registry": _sha256_path(state.expert_router_registry_path),
            "candidate_report": _sha256_path(state.evaluation_report_path),
            "baseline_report": _sha256_path(state.baseline_report_path),
            "janus_event_car": _sha256_path(state.janus_event_car_path),
            "janus_hgrm_reward": _sha256_path(state.janus_hgrm_reward_path),
        },
        artifact_refs=[
            str(state.evaluation_report_path),
            str(state.baseline_report_path),
            str(state.walk_results_path),
            str(state.hmm_state_posterior_path),
            str(state.expert_router_registry_path),
            str(state.deeplob_bdlob_report_path),
            str(state.advisor_fallback_slo_report_path),
            str(state.signals_path),
            str(state.strategy_config_path),
            str(state.gate_policy_path),
        ],
        generated_at=state.now,
    )
    evidence_payload = profitability_evidence.to_payload()
    evidence_payload["janus_q"] = state.janus_q_summary
    state.profitability_evidence_path.write_text(
        json.dumps(evidence_payload, indent=2), encoding="utf-8"
    )
    state.profitability_validation = validate_profitability_evidence_v4(
        profitability_evidence,
        thresholds=ProfitabilityEvidenceThresholdsV4.from_payload(
            _profitability_threshold_payload(state.gate_policy_payload)
        ),
        checked_at=state.now,
    )
    state.profitability_validation_path.write_text(
        json.dumps(state.profitability_validation.to_payload(), indent=2),
        encoding="utf-8",
    )
    return (
        profitability_evidence,
        evidence_payload,
        _load_tca_gate_inputs(state.factory),
    )


def write_simulation_and_contamination_artifacts(
    state: AutonomousLaneWorkflowState,
    profitability_evidence: Any,
    tca_gate_inputs: dict[str, object],
) -> None:
    simulation_calibration_report = build_simulation_calibration_report_v1(
        run_id=state.run_id,
        candidate_id=state.candidate_id,
        profitability_evidence=profitability_evidence,
        tca_metrics=tca_gate_inputs,
        min_order_count=_coerce_int(
            state.gate_policy_payload.get(
                "promotion_simulation_calibration_min_order_count", 1
            ),
            default=1,
        ),
        min_expected_shortfall_coverage=_decimal_or_zero(
            state.gate_policy_payload.get(
                "promotion_simulation_calibration_min_expected_shortfall_coverage",
                "0.50",
            )
        ),
        max_avg_calibration_error_bps=_decimal_or_zero(
            state.gate_policy_payload.get(
                "promotion_simulation_calibration_max_avg_calibration_error_bps", "25"
            )
        ),
        generated_at=state.now,
    )
    state.simulation_calibration_report_payload = (
        simulation_calibration_report.to_payload()
    )
    state.simulation_calibration_report_path.write_text(
        json.dumps(state.simulation_calibration_report_payload, indent=2),
        encoding="utf-8",
    )
    shadow_live_deviation_report = build_shadow_live_deviation_report_v1(
        run_id=state.run_id,
        candidate_id=state.candidate_id,
        profitability_evidence=profitability_evidence,
        tca_metrics=tca_gate_inputs,
        min_order_count=_coerce_int(
            state.gate_policy_payload.get(
                "promotion_shadow_live_deviation_min_order_count", 1
            ),
            default=1,
        ),
        max_avg_abs_slippage_bps=_decimal_or_zero(
            state.gate_policy_payload.get(
                "promotion_shadow_live_deviation_max_avg_abs_slippage_bps", "20"
            )
        ),
        max_avg_abs_divergence_bps=_decimal_or_zero(
            state.gate_policy_payload.get(
                "promotion_shadow_live_deviation_max_avg_abs_divergence_bps", "15"
            )
        ),
        generated_at=state.now,
    )
    state.shadow_live_deviation_report_payload = (
        shadow_live_deviation_report.to_payload()
    )
    state.shadow_live_deviation_report_path.write_text(
        json.dumps(state.shadow_live_deviation_report_payload, indent=2),
        encoding="utf-8",
    )
    state.contamination_registry_payload = _build_contamination_registry_payload(
        output_dir=state.output_dir,
        run_id=state.run_id,
        candidate_id=state.candidate_id,
        now=state.now,
        artifact_refs=[
            state.signals_path,
            state.strategy_config_path,
            state.gate_policy_path,
            state.walk_results_path,
            state.evaluation_report_path,
            state.baseline_report_path,
            state.profitability_evidence_path,
            state.profitability_validation_path,
            state.simulation_calibration_report_path,
            state.shadow_live_deviation_report_path,
            state.profitability_benchmark_path,
            state.benchmark_parity_path,
            state.foundation_router_parity_path,
            state.deeplob_bdlob_report_path,
            state.hmm_state_posterior_path,
            state.expert_router_registry_path,
        ],
    )
    state.contamination_registry_path.write_text(
        json.dumps(state.contamination_registry_payload, indent=2), encoding="utf-8"
    )


def write_recalibration_request(
    state: AutonomousLaneWorkflowState, profitability_evidence_payload: dict[str, Any]
) -> dict[str, Any]:
    confidence_calibration, uncertainty_action, recalibration_run_id = (
        _resolve_confidence_calibration(
            profitability_evidence_payload=profitability_evidence_payload,
            run_id=state.run_id,
            recalibration_report_path=state.recalibration_report_path,
        )
    )
    state.recalibration_report_path.write_text(
        json.dumps(
            {
                "schema_version": "recalibration_report_v1",
                "run_id": state.run_id,
                "candidate_id": state.candidate_id,
                "requested_at": state.now.isoformat(),
                "status": "queued" if recalibration_run_id else "not_required",
                "recalibration_run_id": recalibration_run_id,
                "uncertainty_gate_action": uncertainty_action,
                "coverage_error": confidence_calibration.get("coverage_error"),
                "shift_score": confidence_calibration.get("shift_score"),
                "artifact_refs": sorted(
                    {
                        str(state.profitability_evidence_path),
                        str(state.profitability_validation_path),
                    }
                ),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    return confidence_calibration


def evaluate_gate_report(
    state: AutonomousLaneWorkflowState,
    profitability_evidence_payload: dict[str, Any],
    tca_gate_inputs: dict[str, object],
) -> None:
    gate_policy = GatePolicyMatrix.from_path(state.gate_policy_path)
    profitability_evidence_payload["validation"] = (
        state.profitability_validation.to_payload()
    )
    fragility_state, fragility_score, stability_mode_active, fragility_inputs_valid = (
        _resolve_gate_fragility_inputs(
            metrics_payload=state.report.metrics.to_payload(),
            decisions=state.walk_decisions,
        )
    )
    write_recalibration_request(state, profitability_evidence_payload)
    (
        state.candidate_alpha_readiness_payload,
        state.candidate_dependency_quorum_payload,
    ) = _build_candidate_alpha_readiness_payload(
        runtime_strategies=state.runtime_strategies
    )
    state.candidate_state_payload = _build_candidate_state_payload(
        candidate_id=state.candidate_id,
        run_id=state.run_id,
        promotion_target=state.promotion_target,
        approval_token=state.approval_token,
        runtime_strategies=state.runtime_strategies,
        now=state.now,
        code_version=state.code_version,
        runbook_validated=_is_runbook_valid(state.strategy_configmap_path),
        dependency_quorum_payload=state.candidate_dependency_quorum_payload,
        alpha_readiness_payload=state.candidate_alpha_readiness_payload,
    )
    candidate_state_readiness = _candidate_state_readiness_payload(
        state.candidate_state_payload
    )
    state.gate_report = evaluate_gate_matrix(
        GateInputs(
            feature_schema_version=gate_policy.required_feature_schema_version,
            required_feature_null_rate=_required_feature_null_rate(state.signals),
            staleness_ms_p95=_resolve_gate_staleness_ms_p95(
                signals=state.ordered_signals
            ),
            symbol_coverage=len({signal.symbol for signal in state.signals}),
            metrics=state.report.metrics.to_payload(),
            robustness=state.report.robustness.to_payload(),
            tca_metrics=tca_gate_inputs,
            llm_metrics=_resolve_gate_llm_metrics(
                session_factory=state.factory, now=state.now
            ),
            forecast_metrics=_resolve_gate_forecast_metrics(
                signals=state.ordered_signals
            ),
            profitability_evidence=profitability_evidence_payload,
            fragility_state=fragility_state,
            fragility_score=fragility_score,
            stability_mode_active=stability_mode_active,
            fragility_inputs_valid=fragility_inputs_valid,
            operational_ready=not bool(
                state.candidate_state_payload.get("paused", False)
            ),
            runbook_validated=bool(
                _coerce_evidence_bool(
                    state.candidate_state_payload.get("runbookValidated")
                )
            ),
            kill_switch_dry_run_passed=bool(
                _coerce_evidence_bool(
                    candidate_state_readiness.get("killSwitchDryRunPassed")
                )
            ),
            rollback_dry_run_passed=bool(
                _coerce_evidence_bool(
                    candidate_state_readiness.get("gitopsRevertDryRunPassed")
                )
                and _coerce_evidence_bool(
                    candidate_state_readiness.get("strategyDisableDryRunPassed")
                )
            ),
            approval_token=state.approval_token,
        ),
        policy=gate_policy,
        promotion_target=state.promotion_target,
        code_version=state.code_version,
        evaluated_at=state.now,
    )
    state.fold_evidence = [
        {
            "fold_name": fold.fold_name,
            "decision_count": fold.decision_count,
            "trade_count": fold.trade_count,
            "net_pnl": str(fold.net_pnl),
            "max_drawdown": str(fold.max_drawdown),
            "cost_bps": str(fold.cost_bps),
            "regime_label": fold.regime.label(),
        }
        for fold in state.report.robustness.folds
    ]
    state.stress_evidence = [
        _build_stress_bundle(state.report, stress_case)
        for stress_case in _STRESS_METRICS_CASES
    ]
    state.stress_metrics_count = len(state.stress_evidence)


def write_metric_artifact_refs(state: AutonomousLaneWorkflowState) -> None:
    state.stress_metrics_path.write_text(
        json.dumps(
            {
                "schema_version": "stress-metrics-v1",
                "run_id": state.run_id,
                "generated_at": state.now.isoformat(),
                "count": state.stress_metrics_count,
                "items": state.stress_evidence,
                "artifact_authority": evidence_contract_payload(
                    provenance=ArtifactProvenance.HISTORICAL_MARKET_REPLAY,
                    maturity=EvidenceMaturity.UNCALIBRATED,
                    calibration_summary={"status": "pending_calibration"},
                ),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    state.fold_metrics_path.write_text(
        json.dumps(
            {
                "schema_version": "fold-metrics-v1",
                "run_id": state.run_id,
                "generated_at": state.now.isoformat(),
                "count": len(state.fold_evidence),
                "items": state.fold_evidence,
                "artifact_authority": evidence_contract_payload(
                    provenance=ArtifactProvenance.HISTORICAL_MARKET_REPLAY,
                    maturity=EvidenceMaturity.UNCALIBRATED,
                    calibration_summary={"status": "pending_calibration"},
                ),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    state.stress_metrics_artifact_ref = artifact_ref(state, state.stress_metrics_path)
    state.fold_metrics_artifact_ref = artifact_ref(state, state.fold_metrics_path)
    state.simulation_calibration_artifact_ref = artifact_ref(
        state, state.simulation_calibration_report_path
    )
    state.shadow_live_deviation_artifact_ref = artifact_ref(
        state, state.shadow_live_deviation_report_path
    )
    state.benchmark_parity_artifact_ref = artifact_ref(
        state, state.benchmark_parity_path
    )
    state.foundation_router_parity_artifact_ref = artifact_ref(
        state, state.foundation_router_parity_path
    )
    state.deeplob_bdlob_artifact_ref = artifact_ref(
        state, state.deeplob_bdlob_report_path
    )
    state.advisor_fallback_slo_artifact_ref = artifact_ref(
        state, state.advisor_fallback_slo_report_path
    )
    state.contamination_registry_artifact_ref = artifact_ref(
        state, state.contamination_registry_path
    )
    state.hmm_state_posterior_artifact_ref = artifact_ref(
        state, state.hmm_state_posterior_path
    )
    state.expert_router_registry_artifact_ref = artifact_ref(
        state, state.expert_router_registry_path
    )
    state.gate_report_payload = state.gate_report.to_payload()
    state.gate_report_payload["run_id"] = state.run_id


def run_profitability_validation_phase(state: AutonomousLaneWorkflowState) -> None:
    profitability_evidence, evidence_payload, tca_gate_inputs = (
        write_profitability_evidence_artifacts(state)
    )
    write_simulation_and_contamination_artifacts(
        state, profitability_evidence, tca_gate_inputs
    )
    evaluate_gate_report(state, evidence_payload, tca_gate_inputs)
    write_metric_artifact_refs(state)


__all__ = [
    "run_strategy_factory_gate",
    "build_walkforward_artifacts",
    "write_evaluation_artifacts",
    "write_janus_and_benchmark_artifacts",
    "write_router_contract_artifacts",
    "run_candidate_generation_phase",
    "artifact_ref",
    "write_profitability_evidence_artifacts",
    "write_simulation_and_contamination_artifacts",
    "write_recalibration_request",
    "evaluate_gate_report",
    "write_metric_artifact_refs",
    "run_profitability_validation_phase",
]
