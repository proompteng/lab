"""Deterministic autonomous lane: research -> gate evaluation -> paper candidate patch."""

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence, cast

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

import pandas as pd
import yaml

from ...config import settings
from ...db import SessionLocal
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
    StrategyHypothesis,
    StrategyHypothesisMetricWindow,
    StrategyHypothesisVersion,
    StrategyPromotionDecision,
    Strategy,
    VNextDatasetSnapshot,
    VNextExperimentRun,
    VNextExperimentSpec,
    VNextFeatureViewSpec,
    VNextModelArtifact,
    VNextPromotionDecision,
    VNextShadowLiveDeviation,
    VNextSimulationCalibration,
)
from ..alpha.lane import AlphaLaneResult, run_alpha_discovery_lane
from ..completion import build_completion_trace, persist_completion_trace
from ..evaluation import (
    FoldResult,
    ProfitabilityEvidenceThresholdsV4,
    WalkForwardDecision,
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
    contract_from_artifact_payload,
    evidence_contract_payload,
)
from ..features import (
    FeatureNormalizationError,
    extract_price,
    extract_rsi,
    extract_signal_features,
    normalize_feature_vector_v3,
)
from ..forecasting import build_default_forecast_router
from ..hypotheses import (
    hypothesis_registry_requires_dependency_capability,
    load_hypothesis_registry,
    resolve_hypothesis_dependency_quorum,
)
from ..llm.evaluation import build_llm_evaluation_metrics
from ..models import SignalEnvelope
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
from ..regime_hmm import HMM_UNKNOWN_REGIME_ID, resolve_hmm_context
from ..reporting import (
    EvaluationReport,
    EvaluationReportConfig,
    PromotionRecommendation,
    build_promotion_recommendation,
    generate_evaluation_report,
    write_evaluation_report,
)
from ..strategy_specs import (
    build_compiled_strategy_artifacts,
    build_experiment_spec_from_strategy,
    compile_strategy_spec_v2,
    load_strategy_spec_v2_payload,
    strategy_type_supports_spec_v2,
)
from ..tca import build_tca_gate_inputs
from .gates import (
    GateEvaluationReport,
    GateInputs,
    GatePolicyMatrix,
    PromotionTarget,
    evaluate_gate_matrix,
)
from .janus_q import (
    build_janus_event_car_artifact_v1,
    build_janus_hgrm_reward_artifact_v1,
    build_janus_q_evidence_summary_v1,
)
from .policy_checks import (
    RollbackReadinessResult,
    evaluate_promotion_prerequisites,
    evaluate_rollback_readiness,
)
from .runtime import (
    StrategyRuntime,
    StrategyRuntimeConfig,
    compile_runtime_config,
    default_runtime_registry,
)
from .phase_manifest_contract import (
    AUTONOMY_PHASE_ORDER,
    coerce_phase_status,
    normalize_phase_transitions,
)
from .lane_candidate_payloads import (
    build_candidate_alpha_readiness_payload as _build_candidate_alpha_readiness_payload,
    build_candidate_state_payload as _build_candidate_state_payload,
    is_runbook_valid as _is_runbook_valid,
    normalize_strategy_artifacts as _normalize_strategy_artifacts,
)
from .lane_common import (
    ACTUATION_CONFIRMATION_PHRASE as _ACTUATION_CONFIRMATION_PHRASE,
    ACTUATION_INTENT_PATH as _ACTUATION_INTENT_PATH,
    ACTUATION_INTENT_SCHEMA_VERSION as _ACTUATION_INTENT_SCHEMA_VERSION,
    ADVISOR_FALLBACK_SLO_REPORT_PATH as _ADVISOR_FALLBACK_SLO_REPORT_PATH,
    AUTONOMY_LANE_SCHEMA_VERSION as _AUTONOMY_LANE_SCHEMA_VERSION,
    AutonomousLaneResult,
    BENCHMARK_PARITY_REPORT_PATH as _BENCHMARK_PARITY_REPORT_PATH,
    CONTAMINATION_REGISTRY_ARTIFACT_PATH as _CONTAMINATION_REGISTRY_ARTIFACT_PATH,
    DEEPLOB_BDLOB_REPORT_PATH as _DEEPLOB_BDLOB_REPORT_PATH,
    EXPERT_ROUTER_REGISTRY_ARTIFACT_PATH as _EXPERT_ROUTER_REGISTRY_ARTIFACT_PATH,
    FOLD_METRICS_ARTIFACT_PATH as _FOLD_METRICS_ARTIFACT_PATH,
    FOUNDATION_ROUTER_PARITY_REPORT_PATH as _FOUNDATION_ROUTER_PARITY_REPORT_PATH,
    HMM_STATE_POSTERIOR_ARTIFACT_PATH as _HMM_STATE_POSTERIOR_ARTIFACT_PATH,
    LANE_AUTONOMY_PHASE_ORDER as _AUTONOMY_PHASE_ORDER,
    PROFITABILITY_STAGE_MANIFEST_PATH as _PROFITABILITY_STAGE_MANIFEST_PATH,
    PROFITABILITY_STAGE_MANIFEST_SCHEMA_VERSION as _PROFITABILITY_STAGE_MANIFEST_SCHEMA_VERSION,
    STAGE_CANDIDATE_GENERATION as _STAGE_CANDIDATE_GENERATION,
    STAGE_EVALUATION as _STAGE_EVALUATION,
    STAGE_PROFITABILITY as _STAGE_PROFITABILITY,
    STAGE_RECOMMENDATION as _STAGE_RECOMMENDATION,
    STRESS_METRICS_ARTIFACT_PATH as _STRESS_METRICS_ARTIFACT_PATH,
    STRESS_METRICS_CASES as _STRESS_METRICS_CASES,
    StageManifestRecord as _StageManifestRecord,
    V6_08_GOVERNING_DESIGN_DOC as _V6_08_GOVERNING_DESIGN_DOC,
    as_object_dict as _as_object_dict,
    coerce_evidence_bool as _coerce_evidence_bool,
    default_strategy_configmap_path as _default_strategy_configmap_path,
    ensure_utc as _ensure_utc,
    safe_int as _safe_int,
    sha256_path as _sha256_path,
    stable_hash as _stable_hash,
)
from .lane_profitability_manifest import (
    build_profitability_stage_manifest as _build_profitability_stage_manifest,
)
from .lane_phase_payloads import (
    build_actuation_intent_payload as _build_actuation_intent_payload,
    build_phase_manifest as _build_phase_manifest,
    candidate_state_readiness_payload as _candidate_state_readiness_payload,
    coalesce_governance_context as _coalesce_governance_context,
    coerce_gate_phase_gates as _coerce_gate_phase_gates,
    coerce_int as _coerce_int,
    coerce_path_strings as _coerce_path_strings,
    coerce_str as _coerce_str,
    normalize_governance_inputs as _normalize_governance_inputs,
    prepare_lane_output_dirs as _prepare_lane_output_dirs,
)
from .lane_regime_artifacts import (
    build_contamination_registry_payload as _build_contamination_registry_payload,
    build_expert_router_registry_payload as _build_expert_router_registry_payload,
    build_expert_router_weights as _build_expert_router_weights,
    build_hmm_state_posterior_payload as _build_hmm_state_posterior_payload,
    decimal_or_none as _decimal_or_none,
    decimal_or_zero as _decimal_or_zero,
    normalize_expert_weights as _normalize_expert_weights,
    normalize_hmm_regime_id as _normalize_hmm_regime_id,
)
from .lane_stage_artifacts import (
    artifact_authority_for_check as _artifact_authority_for_check,
    artifact_authority_for_evidence as _artifact_authority_for_evidence,
    artifact_hashes as _artifact_hashes,
    build_bridge_evidence_payload as _build_bridge_evidence_payload,
    build_janus_q_summary_from_payloads as _build_janus_q_summary_from_payloads,
    build_portfolio_promotion_summary as _build_portfolio_promotion_summary,
    build_stage_lineage_payload as _build_stage_lineage_payload,
    build_vnext_gate_summary as _build_vnext_gate_summary,
    empirical_artifact_authority as _empirical_artifact_authority,
    extract_janus_q_metrics as _extract_janus_q_metrics,
    load_configured_empirical_payload as _load_configured_empirical_payload,
    load_json_if_exists as _load_json_if_exists,
    manifest_artifact_payload as _manifest_artifact_payload,
    manifest_relative_path as _manifest_relative_path,
    readable_notes_iteration_number as _readable_notes_iteration_number,
    resolve_optional_service_path as _resolve_optional_service_path,
    write_iteration_notes as _write_iteration_notes,
    write_stage_manifest as _write_stage_manifest,
)
from .lane_strategy_factory import (
    StrategyFactoryBridge as _StrategyFactoryBridge,
    build_strategy_factory_bridge as _build_strategy_factory_bridge,
    load_price_frame as _load_price_frame,
    strategy_factory_artifact_refs as _strategy_factory_artifact_refs,
    strategy_factory_gate_summary as _strategy_factory_gate_summary,
)

from .lane_config_loading import (
    load_runtime_strategy_config,
    load_signals as _load_signals,
    deterministic_run_id as _deterministic_run_id,
    required_feature_null_rate as _required_feature_null_rate,
    compute_no_signal_feature_spec_hash as _compute_no_signal_feature_spec_hash,
    compute_no_signal_dataset_version_hash as _compute_no_signal_dataset_version_hash,
    compute_feature_spec_hash as _compute_feature_spec_hash,
    compute_dataset_version_hash as _compute_dataset_version_hash,
    strategy_parameter_set as _strategy_parameter_set,
    strategy_universe_definition as _strategy_universe_definition,
    metric_counter_int as _metric_counter_int,
    build_stress_bundle as _build_stress_bundle,
)

from .lane_persistence import (
    upsert_autonomy_no_signal_run,
    collect_walk_decisions_for_runtime as _collect_walk_decisions_for_runtime,
    resolve_confidence_calibration as _resolve_confidence_calibration,
    resolve_paper_patch_path as _resolve_paper_patch_path,
    mark_run_passed_if_requested as _mark_run_passed_if_requested,
    mark_run_failed_if_requested as _mark_run_failed_if_requested,
    upsert_research_run as _upsert_research_run,
    mark_run_failed as _mark_run_failed,
    mark_run_passed as _mark_run_passed,
    persist_strategy_spec_lineage_trace as _persist_strategy_spec_lineage_trace,
    persist_hypothesis_governance_rows as _persist_hypothesis_governance_rows,
    persist_vnext_objects as _persist_vnext_objects,
    trace_id as _trace_id,
)
from .lane_result_persistence import (
    persist_run_outputs as _persist_run_outputs,
    persist_run_outputs_if_requested as _persist_run_outputs_if_requested,
)

from .lane_governance import (
    runtime_observation_contract_payload as _runtime_observation_contract_payload,
    runtime_observation_has_ledger_profit_proof as _runtime_observation_has_ledger_profit_proof,
    resolve_hypothesis_window_evidence as _resolve_hypothesis_window_evidence,
    compute_candidate_hash as _compute_candidate_hash,
    build_promotion_rationale as _build_promotion_rationale,
)

from .lane_gate_inputs import (
    coerce_fragility_state as _coerce_fragility_state,
    fragility_state_rank as _fragility_state_rank,
    coerce_fragility_bool as _coerce_fragility_bool,
    coerce_fragility_score as _coerce_fragility_score,
    coerce_fragility_measurement as _coerce_fragility_measurement,
    is_more_worse_fragility as _is_more_worse_fragility,
    resolve_gate_fragility_inputs as _resolve_gate_fragility_inputs,
    resolve_gate_forecast_metrics as _resolve_gate_forecast_metrics,
    resolve_gate_staleness_ms_p95 as _resolve_gate_staleness_ms_p95,
    to_finite_float as _to_finite_float,
    resolve_gate_llm_metrics as _resolve_gate_llm_metrics,
    nearest_rank_percentile as _nearest_rank_percentile,
    load_tca_gate_inputs as _load_tca_gate_inputs,
)

from .lane_run_summary import (
    baseline_runtime_strategies as _baseline_runtime_strategies,
    profitability_threshold_payload as _profitability_threshold_payload,
    collect_confidence_values as _collect_confidence_values,
    to_orm_strategies as _to_orm_strategies,
    strategy_universe_type as _strategy_universe_type,
    evaluate_drift_promotion_gate as _evaluate_drift_promotion_gate,
    write_paper_candidate_patch as _write_paper_candidate_patch,
)


from .lane_workflow_state import AutonomousLaneWorkflowState
from .lane_candidate_phase_execution import (
    run_candidate_generation_phase,
    run_profitability_validation_phase,
)
from .lane_gate_spec_phase import (
    run_gate_report_spec_phase,
    run_promotion_recommendation_phase,
)
from .lane_lineage_replay import run_lineage_replay_phase
from .lane_actuation_persistence import run_actuation_persistence_phase


def run_autonomous_lane(
    *,
    signals_path: Path,
    strategy_config_path: Path,
    gate_policy_path: Path,
    output_dir: Path,
    promotion_target: PromotionTarget = "paper",
    repository: str | None = None,
    base: str | None = None,
    head: str | None = None,
    strategy_configmap_path: Path | None = None,
    code_version: str = "local",
    approval_token: str | None = None,
    drift_promotion_evidence: dict[str, Any] | None = None,
    governance_inputs: Mapping[str, Any] | None = None,
    evaluated_at: datetime | None = None,
    persist_results: bool = False,
    session_factory: Callable[[], Session] | None = None,
    governance_repository: str | None = None,
    governance_base: str | None = None,
    governance_head: str | None = None,
    governance_artifact_path: str | None = None,
    artifact_path: str | None = None,
    artifactPath: str | None = None,
    priority_id: str | None = None,
    priorityId: str | None = None,
    design_doc: str | None = None,
    governance_change: str = "autonomous-promotion",
    governance_reason: str | None = None,
    alpha_train_prices_path: Path | None = None,
    alpha_test_prices_path: Path | None = None,
    alpha_gate_policy_path: Path | None = None,
) -> AutonomousLaneResult:
    """Run deterministic phase-1/2 autonomous lane and emit artifacts."""

    signals = _load_signals(signals_path)
    runtime_strategies = load_runtime_strategy_config(strategy_config_path)
    if not signals:
        raise ValueError("signals fixture is empty")

    run_id = _deterministic_run_id(
        signals_path,
        strategy_config_path,
        gate_policy_path,
        promotion_target,
        alpha_train_prices_path=alpha_train_prices_path,
        alpha_test_prices_path=alpha_test_prices_path,
        alpha_gate_policy_path=alpha_gate_policy_path,
    )
    candidate_id = f"cand-{run_id[:12]}"
    research_dir, backtest_dir, gates_dir, paper_dir, rollout_dir = (
        _prepare_lane_output_dirs(output_dir)
    )
    stages_dir = output_dir / "stages"
    stages_dir.mkdir(parents=True, exist_ok=True)

    now = evaluated_at or datetime.now(timezone.utc)
    runtime = StrategyRuntime(default_runtime_registry())
    walk_decisions: list[WalkForwardDecision] = []
    runtime_errors: list[str] = []
    baseline_runtime_errors: list[str] = []
    patch_path: Path | None = None
    walk_results: Any = None
    report: Any = None
    gate_report: Any = None
    gate_report_trace_id: str | None = None
    recommendation_trace_id: str | None = None
    promotion_recommendation: Any = None
    gate_report_path = gates_dir / "gate-evaluation.json"
    promotion_check_path = gates_dir / "promotion-prerequisites.json"
    rollback_check_path = gates_dir / "rollback-readiness.json"
    baseline_report_path = backtest_dir / "baseline-evaluation-report.json"
    profitability_benchmark_path = gates_dir / "profitability-benchmark-v4.json"
    profitability_evidence_path = gates_dir / "profitability-evidence-v4.json"
    profitability_validation_path = gates_dir / "profitability-evidence-validation.json"
    simulation_calibration_report_path = (
        gates_dir / "simulation-calibration-report-v1.json"
    )
    shadow_live_deviation_report_path = (
        gates_dir / "shadow-live-deviation-report-v1.json"
    )
    contamination_registry_path = gates_dir / _CONTAMINATION_REGISTRY_ARTIFACT_PATH
    janus_event_car_path = gates_dir / "janus-event-car-v1.json"
    janus_hgrm_reward_path = gates_dir / "janus-hgrm-reward-v1.json"
    stress_metrics_path = gates_dir / _STRESS_METRICS_ARTIFACT_PATH
    hmm_state_posterior_path = output_dir / _HMM_STATE_POSTERIOR_ARTIFACT_PATH
    expert_router_registry_path = output_dir / _EXPERT_ROUTER_REGISTRY_ARTIFACT_PATH
    fold_metrics_path = gates_dir / _FOLD_METRICS_ARTIFACT_PATH
    benchmark_parity_path = output_dir / _BENCHMARK_PARITY_REPORT_PATH
    foundation_router_parity_path = output_dir / _FOUNDATION_ROUTER_PARITY_REPORT_PATH
    deeplob_bdlob_report_path = output_dir / _DEEPLOB_BDLOB_REPORT_PATH
    advisor_fallback_slo_report_path = output_dir / _ADVISOR_FALLBACK_SLO_REPORT_PATH
    recalibration_report_path = gates_dir / "recalibration-report.json"
    promotion_gate_path = gates_dir / "promotion-evidence-gate.json"
    profitability_manifest_path = output_dir / _PROFITABILITY_STAGE_MANIFEST_PATH
    phase_manifest_path = rollout_dir / "phase-manifest.json"
    run_row = None
    resolved_priority_id = (
        priority_id if priority_id is not None else _coerce_str(priorityId)
    )
    governance_context = _coalesce_governance_context(
        governance_inputs=governance_inputs,
        governance_repository=governance_repository or repository,
        governance_base=governance_base or base,
        governance_head=governance_head or head,
        governance_artifact_path=(
            governance_artifact_path or artifact_path or artifactPath
        ),
        priority_id=resolved_priority_id,
        design_doc=design_doc,
        now=now,
    )
    governance_context = _normalize_governance_inputs(governance_context)
    notes_artifact_root = _coerce_str(
        governance_context["execution_context"].get("artifactPath")
    )
    notes_root = Path(notes_artifact_root) if notes_artifact_root else output_dir
    resolved_governance_repository = governance_context["execution_context"].get(
        "repository"
    )
    resolved_governance_base = governance_context["execution_context"].get("base")
    resolved_governance_head = governance_context["execution_context"].get("head")
    resolved_design_doc = governance_context["execution_context"].get("designDoc")
    resolved_governance_priority_id = governance_context["execution_context"].get(
        "priorityId"
    )
    promotion_recommendation_path = gates_dir / "promotion-recommendation.json"
    stage_records: list[_StageManifestRecord] = []
    manifest_paths: dict[str, Path] = {}
    stage_trace_ids: dict[str, str] = {}
    hmm_state_posterior_payload: dict[str, Any] = {}
    expert_router_registry_payload: dict[str, Any] = {}
    strategy_factory_bridge: _StrategyFactoryBridge | None = None
    strategy_factory_allowed = True
    strategy_factory_reasons: list[str] = []
    strategy_factory_summary: dict[str, Any] = {}
    strategy_factory_artifact_refs: list[str] = []
    ordered_signals: list[SignalEnvelope] = []
    advisor_fallback_slo_report: dict[str, Any] = {}
    advisor_fallback_slo_artifact_ref = ""
    baseline_candidate_id = ""
    benchmark: Any = None
    benchmark_parity_artifact_ref = ""
    candidate_alpha_readiness_payload: dict[str, Any] = {}
    candidate_dependency_quorum_payload: dict[str, Any] = {}
    candidate_generation_stage_record: Any = None
    candidate_spec_path = research_dir / "candidate-spec.json"
    candidate_state_payload: dict[str, Any] = {}
    contamination_registry_artifact_ref = ""
    contamination_registry_payload: dict[str, Any] = {}
    deeplob_bdlob_artifact_ref = ""
    drift_gate_check: dict[str, Any] = {}
    evaluation_report_path = backtest_dir / "evaluation-report.json"
    expert_router_registry_artifact_ref = ""
    fold_evidence: list[dict[str, Any]] = []
    fold_metrics_artifact_ref = ""
    fold_metrics_count = 0
    foundation_router_parity_artifact_ref = ""
    gate_report_payload: dict[str, Any] = {}
    gate_policy_payload: dict[str, Any] = {}
    hmm_state_posterior_artifact_ref = ""
    janus_event_count = 0
    janus_evidence_complete = False
    janus_q_summary: dict[str, object] = {}
    janus_reasons: list[str] = []
    janus_reward_count = 0
    profitability_validation: Any = None
    promotion_allowed = False
    promotion_check: Any = None
    promotion_reasons: list[str] = []
    raw_gate_policy: dict[str, Any] = {}
    recommended_mode = promotion_target
    replay_artifacts: dict[str, Path | None] = {}
    research_spec: dict[str, Any] = {}
    rollback_check: Any = None
    shadow_live_deviation_artifact_ref = ""
    shadow_live_deviation_report_payload: dict[str, Any] = {}
    simulation_calibration_artifact_ref = ""
    simulation_calibration_report_payload: dict[str, Any] = {}
    stage_lineage_payload: dict[str, Any] = {}
    strategy_family = ""
    stress_evidence: list[dict[str, Any]] = []
    stress_metrics_artifact_ref = ""
    stress_metrics_count = 0
    router_artifact_ref = ""
    profitability_run_context: dict[str, Any] = {}
    walk_results_path = backtest_dir / "walkforward-results.json"

    def _missing_profitability_manifest_writer() -> None:
        raise RuntimeError("profitability_manifest_writer_not_initialized")

    _write_profitability_manifest: Callable[[], None] = (
        _missing_profitability_manifest_writer
    )

    actuation_intent_path = output_dir / _ACTUATION_INTENT_PATH

    factory = session_factory or SessionLocal
    if persist_results:
        run_row = _upsert_research_run(
            session_factory=factory,
            run_id=run_id,
            strategy=runtime_strategies[0] if runtime_strategies else None,
            signals=signals,
            strategy_config_path=strategy_config_path,
            signals_path=signals_path,
            gate_policy_path=gate_policy_path,
            code_version=code_version,
            now=now,
        )

    state = AutonomousLaneWorkflowState(
        actuation_intent_path=actuation_intent_path,
        advisor_fallback_slo_artifact_ref=advisor_fallback_slo_artifact_ref,
        advisor_fallback_slo_report=advisor_fallback_slo_report,
        advisor_fallback_slo_report_path=advisor_fallback_slo_report_path,
        alpha_gate_policy_path=alpha_gate_policy_path,
        alpha_test_prices_path=alpha_test_prices_path,
        alpha_train_prices_path=alpha_train_prices_path,
        approval_token=approval_token,
        backtest_dir=backtest_dir,
        base=base,
        baseline_candidate_id=baseline_candidate_id,
        baseline_report_path=baseline_report_path,
        baseline_runtime_errors=baseline_runtime_errors,
        benchmark=benchmark,
        benchmark_parity_artifact_ref=benchmark_parity_artifact_ref,
        benchmark_parity_path=benchmark_parity_path,
        candidate_alpha_readiness_payload=candidate_alpha_readiness_payload,
        candidate_dependency_quorum_payload=candidate_dependency_quorum_payload,
        candidate_generation_stage_record=candidate_generation_stage_record,
        candidate_id=candidate_id,
        candidate_spec_path=candidate_spec_path,
        candidate_state_payload=candidate_state_payload,
        code_version=code_version,
        contamination_registry_artifact_ref=contamination_registry_artifact_ref,
        contamination_registry_path=contamination_registry_path,
        contamination_registry_payload=contamination_registry_payload,
        deeplob_bdlob_artifact_ref=deeplob_bdlob_artifact_ref,
        deeplob_bdlob_report_path=deeplob_bdlob_report_path,
        drift_gate_check=drift_gate_check,
        drift_promotion_evidence=drift_promotion_evidence,
        evaluation_report_path=evaluation_report_path,
        expert_router_registry_artifact_ref=expert_router_registry_artifact_ref,
        expert_router_registry_path=expert_router_registry_path,
        expert_router_registry_payload=expert_router_registry_payload,
        factory=factory,
        fold_evidence=fold_evidence,
        fold_metrics_artifact_ref=fold_metrics_artifact_ref,
        fold_metrics_count=fold_metrics_count,
        fold_metrics_path=fold_metrics_path,
        foundation_router_parity_artifact_ref=foundation_router_parity_artifact_ref,
        foundation_router_parity_path=foundation_router_parity_path,
        gate_policy_path=gate_policy_path,
        gate_policy_payload=gate_policy_payload,
        gate_report=gate_report,
        gate_report_path=gate_report_path,
        gate_report_payload=gate_report_payload,
        gate_report_trace_id=gate_report_trace_id,
        governance_change=governance_change,
        governance_context=governance_context,
        governance_reason=governance_reason,
        head=head,
        hmm_state_posterior_artifact_ref=hmm_state_posterior_artifact_ref,
        hmm_state_posterior_path=hmm_state_posterior_path,
        hmm_state_posterior_payload=hmm_state_posterior_payload,
        janus_event_car_path=janus_event_car_path,
        janus_event_count=janus_event_count,
        janus_evidence_complete=janus_evidence_complete,
        janus_hgrm_reward_path=janus_hgrm_reward_path,
        janus_q_summary=janus_q_summary,
        janus_reasons=janus_reasons,
        janus_reward_count=janus_reward_count,
        manifest_paths=manifest_paths,
        notes_artifact_root=notes_artifact_root,
        notes_root=notes_root,
        now=now,
        ordered_signals=ordered_signals,
        output_dir=output_dir,
        paper_dir=paper_dir,
        patch_path=patch_path,
        persist_results=persist_results,
        phase_manifest_path=phase_manifest_path,
        profitability_benchmark_path=profitability_benchmark_path,
        profitability_evidence_path=profitability_evidence_path,
        profitability_manifest_path=profitability_manifest_path,
        profitability_run_context=profitability_run_context,
        profitability_validation=profitability_validation,
        profitability_validation_path=profitability_validation_path,
        promotion_allowed=promotion_allowed,
        promotion_check=promotion_check,
        promotion_check_path=promotion_check_path,
        promotion_gate_path=promotion_gate_path,
        promotion_reasons=promotion_reasons,
        promotion_recommendation=promotion_recommendation,
        promotion_recommendation_path=promotion_recommendation_path,
        promotion_target=promotion_target,
        raw_gate_policy=raw_gate_policy,
        recalibration_report_path=recalibration_report_path,
        recommendation_trace_id=recommendation_trace_id,
        recommended_mode=recommended_mode,
        replay_artifacts=replay_artifacts,
        report=report,
        repository=repository,
        research_dir=research_dir,
        research_spec=research_spec,
        resolved_design_doc=resolved_design_doc,
        resolved_governance_base=resolved_governance_base,
        resolved_governance_head=resolved_governance_head,
        resolved_governance_priority_id=resolved_governance_priority_id,
        resolved_governance_repository=resolved_governance_repository,
        resolved_priority_id=resolved_priority_id,
        rollback_check=rollback_check,
        rollback_check_path=rollback_check_path,
        router_artifact_ref=router_artifact_ref,
        run_id=run_id,
        run_row=run_row,
        runtime=runtime,
        runtime_errors=runtime_errors,
        runtime_strategies=runtime_strategies,
        shadow_live_deviation_artifact_ref=shadow_live_deviation_artifact_ref,
        shadow_live_deviation_report_path=shadow_live_deviation_report_path,
        shadow_live_deviation_report_payload=shadow_live_deviation_report_payload,
        signals=signals,
        signals_path=signals_path,
        simulation_calibration_artifact_ref=simulation_calibration_artifact_ref,
        simulation_calibration_report_path=simulation_calibration_report_path,
        simulation_calibration_report_payload=simulation_calibration_report_payload,
        stage_lineage_payload=stage_lineage_payload,
        stage_records=stage_records,
        stage_trace_ids=stage_trace_ids,
        stages_dir=stages_dir,
        strategy_config_path=strategy_config_path,
        strategy_configmap_path=strategy_configmap_path,
        strategy_factory_allowed=strategy_factory_allowed,
        strategy_factory_artifact_refs=strategy_factory_artifact_refs,
        strategy_factory_bridge=strategy_factory_bridge,
        strategy_factory_reasons=strategy_factory_reasons,
        strategy_factory_summary=strategy_factory_summary,
        strategy_family=strategy_family,
        stress_evidence=stress_evidence,
        stress_metrics_artifact_ref=stress_metrics_artifact_ref,
        stress_metrics_count=stress_metrics_count,
        stress_metrics_path=stress_metrics_path,
        walk_decisions=walk_decisions,
        walk_results=walk_results,
        walk_results_path=walk_results_path,
    )

    try:
        run_candidate_generation_phase(state)
        run_profitability_validation_phase(state)
        run_gate_report_spec_phase(state)
        run_promotion_recommendation_phase(state)
        run_lineage_replay_phase(state)
        run_actuation_persistence_phase(state)
        if state.gate_report_trace_id is None or state.recommendation_trace_id is None:
            raise RuntimeError("autonomous_lane_trace_ids_missing")
        return AutonomousLaneResult(
            run_id=run_id,
            candidate_id=candidate_id,
            output_dir=output_dir,
            gate_report_path=gate_report_path,
            actuation_intent_path=state.actuation_intent_path,
            paper_patch_path=state.patch_path,
            phase_manifest_path=phase_manifest_path,
            recommendation_artifact_path=promotion_recommendation_path,
            candidate_spec_path=candidate_spec_path,
            candidate_generation_manifest_path=state.manifest_paths[
                _STAGE_CANDIDATE_GENERATION
            ],
            evaluation_manifest_path=state.manifest_paths[_STAGE_EVALUATION],
            recommendation_manifest_path=state.manifest_paths[_STAGE_RECOMMENDATION],
            profitability_manifest_path=profitability_manifest_path,
            benchmark_parity_path=benchmark_parity_path,
            foundation_router_parity_path=foundation_router_parity_path,
            gate_report_trace_id=state.gate_report_trace_id,
            recommendation_trace_id=state.recommendation_trace_id,
            stage_trace_ids=state.stage_trace_ids,
            stage_lineage_root=(
                state.stage_lineage_payload["root_lineage_hash"]
                if state.stage_records
                else None
            ),
        )
    except Exception as exc:
        _mark_run_failed_if_requested(
            persist_results=persist_results,
            session_factory=state.factory,
            run_id=run_id,
            run_row=state.run_row,
            now=now,
        )
        raise RuntimeError(f"autonomous_lane_persistence_failed: {exc}") from exc


__all__ = [
    "AUTONOMY_PHASE_ORDER",
    "AlphaLaneResult",
    "Any",
    "ArtifactProvenance",
    "AutonomousLaneResult",
    "Callable",
    "Decimal",
    "EvaluationReport",
    "EvaluationReportConfig",
    "EvidenceMaturity",
    "FeatureNormalizationError",
    "FoldResult",
    "GateEvaluationReport",
    "GateInputs",
    "GatePolicyMatrix",
    "HMM_UNKNOWN_REGIME_ID",
    "Mapping",
    "Path",
    "ProfitabilityEvidenceThresholdsV4",
    "PromotionRecommendation",
    "PromotionTarget",
    "ResearchAttempt",
    "ResearchCandidate",
    "ResearchCostCalibration",
    "ResearchFoldMetrics",
    "ResearchPromotion",
    "ResearchRun",
    "ResearchSequentialTrial",
    "ResearchStressMetrics",
    "ResearchValidationTest",
    "RollbackReadinessResult",
    "Sequence",
    "Session",
    "SessionLocal",
    "SignalEnvelope",
    "Strategy",
    "StrategyCapitalAllocation",
    "StrategyHypothesis",
    "StrategyHypothesisMetricWindow",
    "StrategyHypothesisVersion",
    "StrategyPromotionDecision",
    "StrategyRuntime",
    "StrategyRuntimeConfig",
    "VNextDatasetSnapshot",
    "VNextExperimentRun",
    "VNextExperimentSpec",
    "VNextFeatureViewSpec",
    "VNextModelArtifact",
    "VNextPromotionDecision",
    "VNextShadowLiveDeviation",
    "VNextSimulationCalibration",
    "WalkForwardDecision",
    "WalkForwardFold",
    "WalkForwardResults",
    "_ACTUATION_CONFIRMATION_PHRASE",
    "_ACTUATION_INTENT_PATH",
    "_ACTUATION_INTENT_SCHEMA_VERSION",
    "_ADVISOR_FALLBACK_SLO_REPORT_PATH",
    "_AUTONOMY_LANE_SCHEMA_VERSION",
    "_AUTONOMY_PHASE_ORDER",
    "_BENCHMARK_PARITY_REPORT_PATH",
    "_CONTAMINATION_REGISTRY_ARTIFACT_PATH",
    "_DEEPLOB_BDLOB_REPORT_PATH",
    "_EXPERT_ROUTER_REGISTRY_ARTIFACT_PATH",
    "_FOLD_METRICS_ARTIFACT_PATH",
    "_FOUNDATION_ROUTER_PARITY_REPORT_PATH",
    "_HMM_STATE_POSTERIOR_ARTIFACT_PATH",
    "_PROFITABILITY_STAGE_MANIFEST_PATH",
    "_PROFITABILITY_STAGE_MANIFEST_SCHEMA_VERSION",
    "_STAGE_CANDIDATE_GENERATION",
    "_STAGE_EVALUATION",
    "_STAGE_PROFITABILITY",
    "_STAGE_RECOMMENDATION",
    "_STRESS_METRICS_ARTIFACT_PATH",
    "_STRESS_METRICS_CASES",
    "_StageManifestRecord",
    "_StrategyFactoryBridge",
    "_V6_08_GOVERNING_DESIGN_DOC",
    "_artifact_authority_for_check",
    "_artifact_authority_for_evidence",
    "_artifact_hashes",
    "_as_object_dict",
    "_baseline_runtime_strategies",
    "_build_actuation_intent_payload",
    "_build_bridge_evidence_payload",
    "_build_candidate_alpha_readiness_payload",
    "_build_candidate_state_payload",
    "_build_contamination_registry_payload",
    "_build_expert_router_registry_payload",
    "_build_expert_router_weights",
    "_build_hmm_state_posterior_payload",
    "_build_janus_q_summary_from_payloads",
    "_build_phase_manifest",
    "_build_portfolio_promotion_summary",
    "_build_profitability_stage_manifest",
    "_build_promotion_rationale",
    "_build_stage_lineage_payload",
    "_build_strategy_factory_bridge",
    "_build_stress_bundle",
    "_build_vnext_gate_summary",
    "_candidate_state_readiness_payload",
    "_coalesce_governance_context",
    "_coerce_evidence_bool",
    "_coerce_fragility_bool",
    "_coerce_fragility_measurement",
    "_coerce_fragility_score",
    "_coerce_fragility_state",
    "_coerce_gate_phase_gates",
    "_coerce_int",
    "_coerce_path_strings",
    "_coerce_str",
    "_collect_confidence_values",
    "_collect_walk_decisions_for_runtime",
    "_compute_candidate_hash",
    "_compute_dataset_version_hash",
    "_compute_feature_spec_hash",
    "_compute_no_signal_dataset_version_hash",
    "_compute_no_signal_feature_spec_hash",
    "_decimal_or_none",
    "_decimal_or_zero",
    "_default_strategy_configmap_path",
    "_deterministic_run_id",
    "_empirical_artifact_authority",
    "_ensure_utc",
    "_evaluate_drift_promotion_gate",
    "_extract_janus_q_metrics",
    "_fragility_state_rank",
    "_is_more_worse_fragility",
    "_is_runbook_valid",
    "_load_configured_empirical_payload",
    "_load_json_if_exists",
    "_load_price_frame",
    "_load_signals",
    "_load_tca_gate_inputs",
    "_manifest_artifact_payload",
    "_manifest_relative_path",
    "_mark_run_failed",
    "_mark_run_failed_if_requested",
    "_mark_run_passed",
    "_mark_run_passed_if_requested",
    "_metric_counter_int",
    "_nearest_rank_percentile",
    "_normalize_expert_weights",
    "_normalize_governance_inputs",
    "_normalize_hmm_regime_id",
    "_normalize_strategy_artifacts",
    "_persist_hypothesis_governance_rows",
    "_persist_run_outputs",
    "_persist_run_outputs_if_requested",
    "_persist_strategy_spec_lineage_trace",
    "_persist_vnext_objects",
    "_prepare_lane_output_dirs",
    "_profitability_threshold_payload",
    "_readable_notes_iteration_number",
    "_required_feature_null_rate",
    "_resolve_confidence_calibration",
    "_resolve_gate_forecast_metrics",
    "_resolve_gate_fragility_inputs",
    "_resolve_gate_llm_metrics",
    "_resolve_gate_staleness_ms_p95",
    "_resolve_hypothesis_window_evidence",
    "_resolve_optional_service_path",
    "_resolve_paper_patch_path",
    "_runtime_observation_contract_payload",
    "_runtime_observation_has_ledger_profit_proof",
    "_safe_int",
    "_sha256_path",
    "_stable_hash",
    "_strategy_factory_artifact_refs",
    "_strategy_factory_gate_summary",
    "_strategy_parameter_set",
    "_strategy_universe_definition",
    "_strategy_universe_type",
    "_to_finite_float",
    "_to_orm_strategies",
    "_trace_id",
    "_upsert_research_run",
    "_write_iteration_notes",
    "_write_paper_candidate_patch",
    "_write_stage_manifest",
    "build_advisor_fallback_slo_report",
    "build_benchmark_parity_report",
    "build_compiled_strategy_artifacts",
    "build_completion_trace",
    "build_deeplob_bdlob_report",
    "build_default_forecast_router",
    "build_experiment_spec_from_strategy",
    "build_foundation_router_parity_report",
    "build_janus_event_car_artifact_v1",
    "build_janus_hgrm_reward_artifact_v1",
    "build_janus_q_evidence_summary_v1",
    "build_llm_evaluation_metrics",
    "build_profitability_evidence_v4",
    "build_promotion_recommendation",
    "build_shadow_live_deviation_report_v1",
    "build_simulation_calibration_report_v1",
    "build_tca_gate_inputs",
    "cast",
    "coerce_phase_status",
    "compile_runtime_config",
    "compile_strategy_spec_v2",
    "contract_from_artifact_payload",
    "dataclass",
    "datetime",
    "default_runtime_registry",
    "delete",
    "evaluate_gate_matrix",
    "evaluate_promotion_prerequisites",
    "evaluate_rollback_readiness",
    "evidence_contract_payload",
    "execute_profitability_benchmark_v4",
    "extract_price",
    "extract_rsi",
    "extract_signal_features",
    "field",
    "generate_evaluation_report",
    "hashlib",
    "hypothesis_registry_requires_dependency_capability",
    "json",
    "load_hypothesis_registry",
    "load_runtime_strategy_config",
    "load_strategy_spec_v2_payload",
    "math",
    "normalize_feature_vector_v3",
    "normalize_phase_transitions",
    "pd",
    "persist_completion_trace",
    "re",
    "resolve_hmm_context",
    "resolve_hypothesis_dependency_quorum",
    "run_alpha_discovery_lane",
    "run_autonomous_lane",
    "select",
    "settings",
    "strategy_type_supports_spec_v2",
    "timezone",
    "upsert_autonomy_no_signal_run",
    "validate_profitability_evidence_v4",
    "write_advisor_fallback_slo_report",
    "write_benchmark_parity_report",
    "write_deeplob_bdlob_report",
    "write_evaluation_report",
    "write_foundation_router_parity_report",
    "write_walk_forward_results",
    "yaml",
]
