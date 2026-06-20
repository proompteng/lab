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
from . import lane_gate_inputs as lane_gate_inputs_module
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
    resolve_gate_forecast_metrics as _base_resolve_gate_forecast_metrics,
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


def _resolve_gate_forecast_metrics(*, signals: list[SignalEnvelope]) -> dict[str, str]:
    original_router_builder = lane_gate_inputs_module.build_default_forecast_router
    lane_gate_inputs_module.build_default_forecast_router = (
        build_default_forecast_router
    )
    try:
        return _base_resolve_gate_forecast_metrics(signals=signals)
    finally:
        lane_gate_inputs_module.build_default_forecast_router = original_router_builder


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

    def _run_strategy_factory_gate() -> None:
        nonlocal strategy_factory_allowed, strategy_factory_artifact_refs
        nonlocal strategy_factory_bridge, strategy_factory_reasons
        nonlocal strategy_factory_summary

        strategy_factory_bridge = _build_strategy_factory_bridge(
            output_dir=output_dir,
            notes_artifact_root=notes_artifact_root,
            train_prices_path=alpha_train_prices_path,
            test_prices_path=alpha_test_prices_path,
            alpha_gate_policy_path=alpha_gate_policy_path,
            repository=resolved_governance_repository
            if isinstance(resolved_governance_repository, str)
            else repository,
            base=resolved_governance_base
            if isinstance(resolved_governance_base, str)
            else base,
            head=resolved_governance_head
            if isinstance(resolved_governance_head, str)
            else head,
            priority_id=(
                resolved_governance_priority_id
                if isinstance(resolved_governance_priority_id, str)
                else resolved_priority_id
            ),
            promotion_target=promotion_target,
            now=now,
        )
        if strategy_factory_bridge is None:
            return
        (
            strategy_factory_allowed,
            strategy_factory_reasons,
            strategy_factory_summary,
        ) = _strategy_factory_gate_summary(
            strategy_factory_bridge,
            promotion_target=promotion_target,
        )
        strategy_factory_artifact_refs = _strategy_factory_artifact_refs(
            strategy_factory_bridge
        )

    def _build_walkforward_artifacts() -> tuple[
        list[StrategyRuntimeConfig],
        WalkForwardResults,
    ]:
        nonlocal baseline_runtime_errors, ordered_signals, router_artifact_ref
        nonlocal runtime_errors, strategy_family, walk_decisions, walk_results
        nonlocal walk_results_path

        ordered_signals = sorted(
            signals, key=lambda item: (item.event_ts, item.symbol, item.seq or 0)
        )
        strategy_family = _coerce_str(
            runtime_strategies[0].strategy_type
            if runtime_strategies
            else "deterministic"
        )
        router_artifact_ref = str(strategy_config_path)
        walk_decisions, runtime_errors = _collect_walk_decisions_for_runtime(
            runtime=runtime,
            ordered_signals=ordered_signals,
            runtime_strategies=runtime_strategies,
        )
        baseline_runtime_strategies = _baseline_runtime_strategies()
        baseline_walk_decisions, baseline_runtime_errors = (
            _collect_walk_decisions_for_runtime(
                runtime=runtime,
                ordered_signals=ordered_signals,
                runtime_strategies=baseline_runtime_strategies,
            )
        )
        walk_fold = WalkForwardFold(
            name="autonomous_lane",
            train_start=signals[0].event_ts,
            train_end=signals[0].event_ts,
            test_start=signals[0].event_ts,
            test_end=signals[-1].event_ts,
        )
        walk_results = WalkForwardResults(
            generated_at=now,
            folds=[
                FoldResult(
                    fold=walk_fold,
                    decisions=walk_decisions,
                    signals_count=len(signals),
                )
            ],
            feature_spec="app.trading.features.normalize_feature_vector_v3",
        )
        baseline_walk_results = WalkForwardResults(
            generated_at=now,
            folds=[
                FoldResult(
                    fold=walk_fold,
                    decisions=baseline_walk_decisions,
                    signals_count=len(signals),
                )
            ],
            feature_spec="app.trading.features.normalize_feature_vector_v3",
        )
        walk_results_path = backtest_dir / "walkforward-results.json"
        write_walk_forward_results(walk_results, walk_results_path)
        return baseline_runtime_strategies, baseline_walk_results

    def _write_evaluation_artifacts(
        baseline_runtime_strategies: list[StrategyRuntimeConfig],
        baseline_walk_results: WalkForwardResults,
    ) -> EvaluationReport:
        nonlocal baseline_candidate_id, candidate_generation_stage_record
        nonlocal evaluation_report_path, hmm_state_posterior_payload, report

        hmm_state_posterior_payload = _build_hmm_state_posterior_payload(
            output_dir=output_dir,
            run_id=run_id,
            candidate_id=candidate_id,
            now=now,
            walk_decisions=walk_decisions,
            walkforward_results_path=walk_results_path,
            gate_policy_path=gate_policy_path,
        )
        hmm_state_posterior_path.parent.mkdir(parents=True, exist_ok=True)
        hmm_state_posterior_path.write_text(
            json.dumps(hmm_state_posterior_payload, indent=2),
            encoding="utf-8",
        )
        report = generate_evaluation_report(
            walk_results,
            config=EvaluationReportConfig(
                evaluation_start=signals[0].event_ts,
                evaluation_end=signals[-1].event_ts,
                signal_source=str(signals_path),
                strategies=_to_orm_strategies(runtime_strategies),
                run_id=run_id,
                strategy_config_path=str(strategy_config_path),
                git_sha=code_version,
            ),
            promotion_target=promotion_target,
        )
        evaluation_report_path = backtest_dir / "evaluation-report.json"
        write_evaluation_report(report, evaluation_report_path)
        baseline_candidate_id = "baseline-legacy-macd-rsi"
        baseline_report = generate_evaluation_report(
            baseline_walk_results,
            config=EvaluationReportConfig(
                evaluation_start=signals[0].event_ts,
                evaluation_end=signals[-1].event_ts,
                signal_source=str(signals_path),
                strategies=_to_orm_strategies(baseline_runtime_strategies),
                run_id=f"{run_id}-baseline",
                strategy_config_path=f"baseline:{baseline_candidate_id}@1.0.0",
                git_sha=code_version,
            ),
            promotion_target="shadow",
        )
        write_evaluation_report(baseline_report, baseline_report_path)
        candidate_generation_stage_record = _write_stage_manifest(
            stage=_STAGE_CANDIDATE_GENERATION,
            stage_index=1,
            stage_output_dir=stages_dir,
            run_id=run_id,
            candidate_id=candidate_id,
            lineage_parent_hash=None,
            lineage_parent_stage=None,
            inputs={
                "run_id": run_id,
                "candidate_id": candidate_id,
                "promotion_target": promotion_target,
                "strategy_count": str(len(runtime_strategies)),
            },
            input_artifacts={
                "signals": signals_path,
                "strategy_config": strategy_config_path,
                "gate_policy": gate_policy_path,
            },
            output_artifacts={
                "walkforward_results": walk_results_path,
                "baseline_evaluation_report": baseline_report_path,
                "evaluation_report": None,
            },
            created_at=now,
        )
        stage_records.append(candidate_generation_stage_record)
        manifest_paths[_STAGE_CANDIDATE_GENERATION] = (
            stages_dir / f"{_STAGE_CANDIDATE_GENERATION}-manifest.json"
        )
        stage_trace_ids[_STAGE_CANDIDATE_GENERATION] = (
            candidate_generation_stage_record.stage_trace_id
        )
        return baseline_report

    def _write_janus_and_benchmark_artifacts(
        baseline_report: EvaluationReport,
    ) -> None:
        nonlocal benchmark, janus_event_count, janus_evidence_complete
        nonlocal janus_q_summary, janus_reasons, janus_reward_count

        janus_event_car = build_janus_event_car_artifact_v1(
            run_id=run_id,
            signals=ordered_signals,
            generated_at=now,
        )
        janus_event_car_path.write_text(
            json.dumps(janus_event_car.to_payload(), indent=2),
            encoding="utf-8",
        )
        janus_hgrm_reward = build_janus_hgrm_reward_artifact_v1(
            run_id=run_id,
            candidate_id=candidate_id,
            event_car=janus_event_car,
            walk_decisions=walk_decisions,
            generated_at=now,
        )
        janus_hgrm_reward_path.write_text(
            json.dumps(janus_hgrm_reward.to_payload(), indent=2), encoding="utf-8"
        )
        janus_q_summary = build_janus_q_evidence_summary_v1(
            event_car=janus_event_car,
            hgrm_reward=janus_hgrm_reward,
            event_car_artifact_ref=str(janus_event_car_path),
            hgrm_reward_artifact_ref=str(janus_hgrm_reward_path),
        )
        (
            janus_event_count,
            janus_reward_count,
            janus_evidence_complete,
            janus_reasons,
        ) = _extract_janus_q_metrics(janus_q_summary)
        benchmark = execute_profitability_benchmark_v4(
            candidate_id=candidate_id,
            baseline_id=baseline_candidate_id,
            candidate_report_payload=report.to_payload(),
            baseline_report_payload=baseline_report.to_payload(),
            required_slice_keys=[
                "market:all",
                f"regime:{walk_results.folds[0].fold_metrics()['regime_label']}",
            ],
            executed_at=now,
        )
        profitability_benchmark_path.write_text(
            json.dumps(benchmark.to_payload(), indent=2), encoding="utf-8"
        )
        benchmark_parity_report = build_benchmark_parity_report(
            candidate_id=candidate_id,
            baseline_candidate_id=baseline_candidate_id,
            now=now,
        )
        write_benchmark_parity_report(benchmark_parity_report, benchmark_parity_path)

    def _write_router_contract_artifacts() -> None:
        nonlocal advisor_fallback_slo_report, expert_router_registry_payload
        nonlocal gate_policy_payload

        gate_policy_payload = json.loads(gate_policy_path.read_text(encoding="utf-8"))
        foundation_router_parity_report = build_foundation_router_parity_report(
            candidate_id=candidate_id,
            router_policy_version=str(
                gate_policy_payload.get(
                    "forecast_router_policy_version", "forecast_router_policy_v1"
                )
            ),
            now=now,
        )
        write_foundation_router_parity_report(
            foundation_router_parity_report,
            foundation_router_parity_path,
        )
        deeplob_bdlob_report = build_deeplob_bdlob_report(
            candidate_id=candidate_id,
            feature_policy_version=str(
                gate_policy_payload.get(
                    "required_feature_schema_version",
                    settings.trading_feature_schema_version,
                )
            ),
            now=now,
        )
        write_deeplob_bdlob_report(
            deeplob_bdlob_report,
            deeplob_bdlob_report_path,
        )
        advisor_fallback_slo_report = build_advisor_fallback_slo_report(
            candidate_id=candidate_id,
            advisor_policy_version=str(
                gate_policy_payload.get("policy_version", "v3-gates-1")
            ),
            now=now,
        )
        write_advisor_fallback_slo_report(
            advisor_fallback_slo_report,
            advisor_fallback_slo_report_path,
        )
        expert_router_registry_payload = _build_expert_router_registry_payload(
            output_dir=output_dir,
            run_id=run_id,
            candidate_id=candidate_id,
            now=now,
            walk_decisions=walk_decisions,
            walkforward_results_path=walk_results_path,
            gate_policy_path=gate_policy_path,
            strategy_config_path=strategy_config_path,
            hmm_state_posterior_path=hmm_state_posterior_path,
            policy_payload=gate_policy_payload,
        )
        expert_router_registry_path.parent.mkdir(parents=True, exist_ok=True)
        expert_router_registry_path.write_text(
            json.dumps(expert_router_registry_payload, indent=2),
            encoding="utf-8",
        )

    def _run_candidate_generation_phase() -> None:
        _run_strategy_factory_gate()
        baseline_runtime_strategies, baseline_walk_results = (
            _build_walkforward_artifacts()
        )
        baseline_report = _write_evaluation_artifacts(
            baseline_runtime_strategies,
            baseline_walk_results,
        )
        _write_janus_and_benchmark_artifacts(baseline_report)
        _write_router_contract_artifacts()

    def _artifact_ref(path: Path) -> str:
        if output_dir.is_absolute():
            return str(path)
        return str(path.relative_to(output_dir))

    def _write_profitability_evidence_artifacts() -> tuple[
        Any,
        dict[str, Any],
        dict[str, object],
    ]:
        nonlocal profitability_validation

        profitability_evidence = build_profitability_evidence_v4(
            run_id=run_id,
            candidate_id=candidate_id,
            baseline_id=baseline_candidate_id,
            candidate_report_payload=report.to_payload(),
            benchmark=benchmark,
            confidence_values=_collect_confidence_values(walk_decisions),
            reproducibility_hashes={
                "signals": _sha256_path(signals_path),
                "strategy_config": _sha256_path(strategy_config_path),
                "gate_policy": _sha256_path(gate_policy_path),
                "walkforward_results": _sha256_path(walk_results_path),
                "foundation_router_parity": _sha256_path(foundation_router_parity_path),
                "deeplob_bdlob_contract": _sha256_path(deeplob_bdlob_report_path),
                "advisor_fallback_slo": _sha256_path(advisor_fallback_slo_report_path),
                "hmm_state_posterior": _sha256_path(hmm_state_posterior_path),
                "expert_router_registry": _sha256_path(expert_router_registry_path),
                "candidate_report": _sha256_path(evaluation_report_path),
                "baseline_report": _sha256_path(baseline_report_path),
                "janus_event_car": _sha256_path(janus_event_car_path),
                "janus_hgrm_reward": _sha256_path(janus_hgrm_reward_path),
            },
            artifact_refs=[
                str(evaluation_report_path),
                str(baseline_report_path),
                str(walk_results_path),
                str(hmm_state_posterior_path),
                str(expert_router_registry_path),
                str(deeplob_bdlob_report_path),
                str(advisor_fallback_slo_report_path),
                str(signals_path),
                str(strategy_config_path),
                str(gate_policy_path),
            ],
            generated_at=now,
        )
        evidence_payload = profitability_evidence.to_payload()
        evidence_payload["janus_q"] = janus_q_summary
        profitability_evidence_path.write_text(
            json.dumps(evidence_payload, indent=2), encoding="utf-8"
        )
        profitability_validation = validate_profitability_evidence_v4(
            profitability_evidence,
            thresholds=ProfitabilityEvidenceThresholdsV4.from_payload(
                _profitability_threshold_payload(gate_policy_payload)
            ),
            checked_at=now,
        )
        profitability_validation_path.write_text(
            json.dumps(profitability_validation.to_payload(), indent=2),
            encoding="utf-8",
        )
        return (
            profitability_evidence,
            evidence_payload,
            _load_tca_gate_inputs(factory),
        )

    def _write_simulation_and_contamination_artifacts(
        profitability_evidence: Any,
        tca_gate_inputs: dict[str, object],
    ) -> None:
        nonlocal contamination_registry_payload
        nonlocal shadow_live_deviation_report_payload
        nonlocal simulation_calibration_report_payload

        simulation_calibration_report = build_simulation_calibration_report_v1(
            run_id=run_id,
            candidate_id=candidate_id,
            profitability_evidence=profitability_evidence,
            tca_metrics=tca_gate_inputs,
            min_order_count=_coerce_int(
                gate_policy_payload.get(
                    "promotion_simulation_calibration_min_order_count",
                    1,
                ),
                default=1,
            ),
            min_expected_shortfall_coverage=_decimal_or_zero(
                gate_policy_payload.get(
                    "promotion_simulation_calibration_min_expected_shortfall_coverage",
                    "0.50",
                )
            ),
            max_avg_calibration_error_bps=_decimal_or_zero(
                gate_policy_payload.get(
                    "promotion_simulation_calibration_max_avg_calibration_error_bps",
                    "25",
                )
            ),
            generated_at=now,
        )
        simulation_calibration_report_payload = (
            simulation_calibration_report.to_payload()
        )
        simulation_calibration_report_path.write_text(
            json.dumps(simulation_calibration_report_payload, indent=2),
            encoding="utf-8",
        )
        shadow_live_deviation_report = build_shadow_live_deviation_report_v1(
            run_id=run_id,
            candidate_id=candidate_id,
            profitability_evidence=profitability_evidence,
            tca_metrics=tca_gate_inputs,
            min_order_count=_coerce_int(
                gate_policy_payload.get(
                    "promotion_shadow_live_deviation_min_order_count",
                    1,
                ),
                default=1,
            ),
            max_avg_abs_slippage_bps=_decimal_or_zero(
                gate_policy_payload.get(
                    "promotion_shadow_live_deviation_max_avg_abs_slippage_bps",
                    "20",
                )
            ),
            max_avg_abs_divergence_bps=_decimal_or_zero(
                gate_policy_payload.get(
                    "promotion_shadow_live_deviation_max_avg_abs_divergence_bps",
                    "15",
                )
            ),
            generated_at=now,
        )
        shadow_live_deviation_report_payload = shadow_live_deviation_report.to_payload()
        shadow_live_deviation_report_path.write_text(
            json.dumps(shadow_live_deviation_report_payload, indent=2),
            encoding="utf-8",
        )
        contamination_registry_payload = _build_contamination_registry_payload(
            output_dir=output_dir,
            run_id=run_id,
            candidate_id=candidate_id,
            now=now,
            artifact_refs=[
                signals_path,
                strategy_config_path,
                gate_policy_path,
                walk_results_path,
                evaluation_report_path,
                baseline_report_path,
                profitability_evidence_path,
                profitability_validation_path,
                simulation_calibration_report_path,
                shadow_live_deviation_report_path,
                profitability_benchmark_path,
                benchmark_parity_path,
                foundation_router_parity_path,
                deeplob_bdlob_report_path,
                hmm_state_posterior_path,
                expert_router_registry_path,
            ],
        )
        contamination_registry_path.write_text(
            json.dumps(contamination_registry_payload, indent=2),
            encoding="utf-8",
        )

    def _write_recalibration_request(
        profitability_evidence_payload: dict[str, Any],
    ) -> dict[str, Any]:
        confidence_calibration, uncertainty_action, recalibration_run_id = (
            _resolve_confidence_calibration(
                profitability_evidence_payload=profitability_evidence_payload,
                run_id=run_id,
                recalibration_report_path=recalibration_report_path,
            )
        )
        recalibration_report_path.write_text(
            json.dumps(
                {
                    "schema_version": "recalibration_report_v1",
                    "run_id": run_id,
                    "candidate_id": candidate_id,
                    "requested_at": now.isoformat(),
                    "status": "queued" if recalibration_run_id else "not_required",
                    "recalibration_run_id": recalibration_run_id,
                    "uncertainty_gate_action": uncertainty_action,
                    "coverage_error": confidence_calibration.get("coverage_error"),
                    "shift_score": confidence_calibration.get("shift_score"),
                    "artifact_refs": sorted(
                        {
                            str(profitability_evidence_path),
                            str(profitability_validation_path),
                        }
                    ),
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        return confidence_calibration

    def _evaluate_gate_report(
        profitability_evidence_payload: dict[str, Any],
        tca_gate_inputs: dict[str, object],
    ) -> None:
        nonlocal candidate_alpha_readiness_payload
        nonlocal candidate_dependency_quorum_payload, candidate_state_payload
        nonlocal fold_evidence, gate_report, stress_evidence, stress_metrics_count

        gate_policy = GatePolicyMatrix.from_path(gate_policy_path)
        profitability_evidence_payload["validation"] = (
            profitability_validation.to_payload()
        )
        (
            fragility_state,
            fragility_score,
            stability_mode_active,
            fragility_inputs_valid,
        ) = _resolve_gate_fragility_inputs(
            metrics_payload=report.metrics.to_payload(), decisions=walk_decisions
        )
        _write_recalibration_request(profitability_evidence_payload)
        (
            candidate_alpha_readiness_payload,
            candidate_dependency_quorum_payload,
        ) = _build_candidate_alpha_readiness_payload(
            runtime_strategies=runtime_strategies,
        )
        candidate_state_payload = _build_candidate_state_payload(
            candidate_id=candidate_id,
            run_id=run_id,
            promotion_target=promotion_target,
            approval_token=approval_token,
            runtime_strategies=runtime_strategies,
            now=now,
            code_version=code_version,
            runbook_validated=_is_runbook_valid(strategy_configmap_path),
            dependency_quorum_payload=candidate_dependency_quorum_payload,
            alpha_readiness_payload=candidate_alpha_readiness_payload,
        )
        candidate_state_readiness = _candidate_state_readiness_payload(
            candidate_state_payload
        )
        gate_report = evaluate_gate_matrix(
            GateInputs(
                feature_schema_version=gate_policy.required_feature_schema_version,
                required_feature_null_rate=_required_feature_null_rate(signals),
                staleness_ms_p95=_resolve_gate_staleness_ms_p95(
                    signals=ordered_signals,
                ),
                symbol_coverage=len({signal.symbol for signal in signals}),
                metrics=report.metrics.to_payload(),
                robustness=report.robustness.to_payload(),
                tca_metrics=tca_gate_inputs,
                llm_metrics=_resolve_gate_llm_metrics(
                    session_factory=factory,
                    now=now,
                ),
                forecast_metrics=_resolve_gate_forecast_metrics(
                    signals=ordered_signals
                ),
                profitability_evidence=profitability_evidence_payload,
                fragility_state=fragility_state,
                fragility_score=fragility_score,
                stability_mode_active=stability_mode_active,
                fragility_inputs_valid=fragility_inputs_valid,
                operational_ready=not bool(
                    candidate_state_payload.get("paused", False)
                ),
                runbook_validated=bool(
                    _coerce_evidence_bool(
                        candidate_state_payload.get("runbookValidated")
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
                approval_token=approval_token,
            ),
            policy=gate_policy,
            promotion_target=promotion_target,
            code_version=code_version,
            evaluated_at=now,
        )
        fold_evidence = [
            {
                "fold_name": fold.fold_name,
                "decision_count": fold.decision_count,
                "trade_count": fold.trade_count,
                "net_pnl": str(fold.net_pnl),
                "max_drawdown": str(fold.max_drawdown),
                "cost_bps": str(fold.cost_bps),
                "regime_label": fold.regime.label(),
            }
            for fold in report.robustness.folds
        ]
        stress_evidence = [
            _build_stress_bundle(report, stress_case)
            for stress_case in _STRESS_METRICS_CASES
        ]
        stress_metrics_count = len(stress_evidence)

    def _write_metric_artifact_refs() -> None:
        nonlocal advisor_fallback_slo_artifact_ref, benchmark_parity_artifact_ref
        nonlocal contamination_registry_artifact_ref, deeplob_bdlob_artifact_ref
        nonlocal expert_router_registry_artifact_ref, fold_metrics_artifact_ref
        nonlocal foundation_router_parity_artifact_ref, gate_report_payload
        nonlocal hmm_state_posterior_artifact_ref
        nonlocal shadow_live_deviation_artifact_ref
        nonlocal simulation_calibration_artifact_ref, stress_metrics_artifact_ref

        stress_metrics_path.write_text(
            json.dumps(
                {
                    "schema_version": "stress-metrics-v1",
                    "run_id": run_id,
                    "generated_at": now.isoformat(),
                    "count": stress_metrics_count,
                    "items": stress_evidence,
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
        fold_metrics_path.write_text(
            json.dumps(
                {
                    "schema_version": "fold-metrics-v1",
                    "run_id": run_id,
                    "generated_at": now.isoformat(),
                    "count": len(fold_evidence),
                    "items": fold_evidence,
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
        stress_metrics_artifact_ref = _artifact_ref(stress_metrics_path)
        fold_metrics_artifact_ref = _artifact_ref(fold_metrics_path)
        simulation_calibration_artifact_ref = _artifact_ref(
            simulation_calibration_report_path
        )
        shadow_live_deviation_artifact_ref = _artifact_ref(
            shadow_live_deviation_report_path
        )
        benchmark_parity_artifact_ref = _artifact_ref(benchmark_parity_path)
        foundation_router_parity_artifact_ref = _artifact_ref(
            foundation_router_parity_path
        )
        deeplob_bdlob_artifact_ref = _artifact_ref(deeplob_bdlob_report_path)
        advisor_fallback_slo_artifact_ref = _artifact_ref(
            advisor_fallback_slo_report_path
        )
        contamination_registry_artifact_ref = _artifact_ref(contamination_registry_path)
        hmm_state_posterior_artifact_ref = _artifact_ref(hmm_state_posterior_path)
        expert_router_registry_artifact_ref = _artifact_ref(expert_router_registry_path)
        gate_report_payload = gate_report.to_payload()
        gate_report_payload["run_id"] = run_id

    def _run_profitability_validation_phase() -> None:
        profitability_evidence, evidence_payload, tca_gate_inputs = (
            _write_profitability_evidence_artifacts()
        )
        _write_simulation_and_contamination_artifacts(
            profitability_evidence,
            tca_gate_inputs,
        )
        _evaluate_gate_report(evidence_payload, tca_gate_inputs)
        _write_metric_artifact_refs()

    def _run_gate_report_spec_phase() -> None:
        nonlocal candidate_spec_path, drift_gate_check, gate_report_trace_id, patch_path
        nonlocal \
            profitability_run_context, \
            raw_gate_policy, \
            research_spec, \
            rollback_check
        gate_report_payload["throughput"] = {
            "signal_count": len(signals),
            "decision_count": report.metrics.decision_count,
            "trade_count": report.metrics.trade_count,
            "no_signal_window": False,
            "no_signal_reason": None,
            "fold_metrics_count": len(walk_results.folds),
            "stress_metrics_count": stress_metrics_count,
        }
        gate_report_payload["promotion_evidence"] = {
            "fold_metrics": {
                "count": len(fold_evidence),
                "items": fold_evidence,
                "artifact_ref": fold_metrics_artifact_ref,
                "artifact_authority": _artifact_authority_for_evidence("fold_metrics"),
            },
            "stress_metrics": {
                "count": len(stress_evidence),
                "items": stress_evidence,
                "artifact_ref": stress_metrics_artifact_ref,
                "artifact_authority": _artifact_authority_for_evidence(
                    "stress_metrics"
                ),
            },
            "simulation_calibration": _build_bridge_evidence_payload(
                simulation_calibration_report_payload,
                artifact_ref=simulation_calibration_artifact_ref,
                summary_fields=(
                    "order_count",
                    "expected_shortfall_sample_count",
                    "expected_shortfall_coverage",
                    "avg_calibration_error_bps",
                    "confidence_gate_action",
                ),
            ),
            "shadow_live_deviation": _build_bridge_evidence_payload(
                shadow_live_deviation_report_payload,
                artifact_ref=shadow_live_deviation_artifact_ref,
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
                    "count": janus_event_count,
                    "artifact_ref": str(janus_event_car_path),
                    "artifact_authority": _artifact_authority_for_evidence(
                        "janus_event_car"
                    ),
                },
                "hgrm_reward": {
                    "count": janus_reward_count,
                    "artifact_ref": str(janus_hgrm_reward_path),
                    "artifact_authority": _artifact_authority_for_evidence(
                        "janus_hgrm_reward"
                    ),
                },
                "evidence_complete": janus_evidence_complete,
                "reasons": janus_reasons,
                "artifact_authority": _artifact_authority_for_evidence("janus_q"),
            },
            "benchmark_parity": {
                "artifact_ref": benchmark_parity_artifact_ref,
                "artifact_authority": _artifact_authority_for_evidence(
                    "benchmark_parity"
                ),
            },
            "foundation_router_parity": {
                "artifact_ref": foundation_router_parity_artifact_ref,
                "artifact_authority": _artifact_authority_for_evidence(
                    "foundation_router_parity"
                ),
            },
            "deeplob_bdlob_contract": {
                "artifact_ref": deeplob_bdlob_artifact_ref,
                "artifact_authority": _artifact_authority_for_evidence(
                    "deeplob_bdlob_contract"
                ),
            },
            "advisor_fallback_slo": {
                "artifact_ref": advisor_fallback_slo_artifact_ref,
                "artifact_authority": _artifact_authority_for_evidence(
                    "advisor_fallback_slo"
                ),
                "schema_version": advisor_fallback_slo_report.get("schema_version"),
                "evaluated_samples": advisor_fallback_slo_report.get(
                    "evaluated_samples"
                ),
                "timeout_rate": cast(
                    dict[str, Any],
                    advisor_fallback_slo_report.get("fallback_reason_rates", {}),
                ).get("timeout_rate"),
                "state_stale_rate": cast(
                    dict[str, Any],
                    advisor_fallback_slo_report.get("fallback_reason_rates", {}),
                ).get("state_stale_rate"),
                "advice_stale_rate": cast(
                    dict[str, Any],
                    advisor_fallback_slo_report.get("fallback_reason_rates", {}),
                ).get("advice_stale_rate"),
                "safe_fallback_rate": cast(
                    dict[str, Any],
                    advisor_fallback_slo_report.get("fallback_reason_rates", {}),
                ).get("safe_fallback_rate"),
                "slo_pass": cast(
                    dict[str, Any],
                    advisor_fallback_slo_report.get("fallback_reason_rates", {}),
                ).get("slo_pass"),
                "artifact_hash": advisor_fallback_slo_report.get("artifact_hash"),
            },
            "hmm_state_posterior": {
                "artifact_ref": hmm_state_posterior_artifact_ref,
                "artifact_authority": _artifact_authority_for_evidence(
                    "hmm_state_posterior"
                ),
                "schema_version": hmm_state_posterior_payload.get("schema_version"),
                "samples_total": hmm_state_posterior_payload.get("samples_total"),
                "authoritative_samples": hmm_state_posterior_payload.get(
                    "authoritative_samples"
                ),
                "authoritative_sample_ratio": hmm_state_posterior_payload.get(
                    "authoritative_sample_ratio"
                ),
                "transition_shock_samples": hmm_state_posterior_payload.get(
                    "transition_shock_samples"
                ),
                "stale_or_defensive_samples": hmm_state_posterior_payload.get(
                    "stale_or_defensive_samples"
                ),
                "top_regime_by_posterior_mass": hmm_state_posterior_payload.get(
                    "top_regime_by_posterior_mass"
                ),
                "artifact_hash": hmm_state_posterior_payload.get("artifact_hash"),
            },
            "expert_router_registry": {
                "artifact_ref": expert_router_registry_artifact_ref,
                "artifact_authority": _artifact_authority_for_evidence(
                    "expert_router_registry"
                ),
                "schema_version": expert_router_registry_payload.get("schema_version"),
                "router_version": expert_router_registry_payload.get("router_version"),
                "route_count": expert_router_registry_payload.get("route_count"),
                "fallback_count": expert_router_registry_payload.get("fallback_count"),
                "fallback_rate": expert_router_registry_payload.get("fallback_rate"),
                "max_expert_weight": expert_router_registry_payload.get(
                    "max_expert_weight"
                ),
                "artifact_hash": expert_router_registry_payload.get("artifact_hash"),
            },
            "contamination_registry": {
                "artifact_ref": contamination_registry_artifact_ref,
                "artifact_authority": _artifact_authority_for_evidence(
                    "contamination_registry"
                ),
                "status": contamination_registry_payload.get("status", "fail"),
                "leakage_detected": contamination_registry_payload.get(
                    "leakage_detected", True
                ),
                "leakage_rate": contamination_registry_payload.get("leakage_rate", 1.0),
            },
            "promotion_rationale": {
                "requested_target": promotion_target,
                "gate_recommended_mode": gate_report.recommended_mode,
                "gate_reasons": sorted(gate_report.reasons),
                "rationale_text": "Gate matrix recommendation captured from deterministic evaluation artifacts.",
                "artifact_authority": _artifact_authority_for_evidence(
                    "promotion_rationale"
                ),
            },
        }
        if strategy_factory_bridge is not None:
            gate_report_payload["promotion_evidence"]["strategy_factory"] = {
                **strategy_factory_summary,
                "artifact_authority": _artifact_authority_for_evidence(
                    "strategy_factory"
                ),
            }
        gate_report_trace_id = _trace_id(gate_report_payload)
        gate_report_payload["dependency_quorum"] = candidate_dependency_quorum_payload
        gate_report_payload["alpha_readiness"] = candidate_alpha_readiness_payload
        gate_report_payload["provenance"] = {
            "gate_report_trace_id": gate_report_trace_id,
            "promotion_evidence_authority": {
                name: payload.get("artifact_authority")
                for name, payload in cast(
                    dict[str, dict[str, Any]],
                    gate_report_payload["promotion_evidence"],
                ).items()
                if payload.get("artifact_authority")
            },
        }
        gate_report_payload["vnext"] = _build_vnext_gate_summary(
            runtime_strategies=runtime_strategies,
            simulation_calibration_payload=simulation_calibration_report_payload,
            shadow_live_deviation_payload=shadow_live_deviation_report_payload,
        )
        gate_report_path.write_text(
            json.dumps(gate_report_payload, indent=2), encoding="utf-8"
        )

        research_spec = {
            "run_id": run_id,
            "candidate_id": candidate_id,
            "promotion_target": promotion_target,
            "bounded_llm": {
                "enabled": False,
                "actuation_allowed": False,
                "notes": "LLM path is advisory only. Deterministic risk/firewall are final authority.",
            },
            "runtime_errors": sorted(runtime_errors),
            "baseline_runtime_errors": sorted(baseline_runtime_errors),
            "artifacts": {
                "walkforward_results": str(walk_results_path),
                "evaluation_report": str(evaluation_report_path),
                "baseline_evaluation_report": str(baseline_report_path),
                "gate_report": str(gate_report_path),
                "benchmark_parity": str(benchmark_parity_path),
                "foundation_router_parity": str(foundation_router_parity_path),
                "deeplob_bdlob_contract": str(deeplob_bdlob_report_path),
                "advisor_fallback_slo": str(advisor_fallback_slo_report_path),
                "contamination_registry": str(contamination_registry_path),
                "profitability_benchmark": str(profitability_benchmark_path),
                "profitability_evidence": str(profitability_evidence_path),
                "profitability_validation": str(profitability_validation_path),
                "simulation_calibration": str(simulation_calibration_report_path),
                "shadow_live_deviation": str(shadow_live_deviation_report_path),
                "stress_metrics": str(stress_metrics_path),
                "hmm_state_posterior": str(hmm_state_posterior_path),
                "expert_router_registry": str(expert_router_registry_path),
                "fold_metrics": str(fold_metrics_path),
                "janus_event_car": str(janus_event_car_path),
                "janus_hgrm_reward": str(janus_hgrm_reward_path),
                "recalibration_report": str(recalibration_report_path),
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
                    for strategy in runtime_strategies
                ],
            },
            "strategy_specs_v2": [
                strategy.strategy_spec
                for strategy in runtime_strategies
                if strategy.compiler_source == "spec_v2" and strategy.strategy_spec
            ],
            "compiled_runtime_targets": {
                strategy.strategy_id: strategy.compiled_targets
                for strategy in runtime_strategies
                if strategy.compiler_source == "spec_v2" and strategy.compiled_targets
            },
            "bridge_persistence_v2": {
                "dataset_snapshots": [
                    {
                        "dataset_id": f"dataset-{run_id}",
                        "source": "historical_market_replay",
                        "artifact_ref": str(walk_results_path),
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
                    for strategy in runtime_strategies
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
                    for strategy in runtime_strategies
                    if strategy.strategy_spec
                ],
                "simulation_calibrations": [
                    {
                        "artifact_ref": str(simulation_calibration_report_path),
                    }
                ],
                "shadow_live_deviations": [
                    {
                        "artifact_ref": str(shadow_live_deviation_report_path),
                    }
                ],
                "promotion_decisions_v2": [],
            },
            "portfolio_promotion_v2": _build_portfolio_promotion_summary(
                runtime_strategies
            ),
            "dependency_quorum": candidate_dependency_quorum_payload,
            "alpha_readiness": candidate_alpha_readiness_payload,
        }
        if strategy_factory_bridge is not None:
            research_spec["artifacts"].update(
                {
                    "strategy_factory_candidate_spec": str(
                        strategy_factory_bridge.result.candidate_spec_path
                    ),
                    "strategy_factory_evaluation_report": str(
                        strategy_factory_bridge.result.evaluation_report_path
                    ),
                    "strategy_factory_recommendation": str(
                        strategy_factory_bridge.result.recommendation_artifact_path
                    ),
                    "strategy_factory_attempt_ledger": str(
                        strategy_factory_bridge.result.attempt_ledger_path
                    ),
                    "strategy_factory_sequential_trial": str(
                        strategy_factory_bridge.result.sequential_trial_path
                    ),
                    "strategy_factory_cost_calibration": str(
                        strategy_factory_bridge.result.cost_calibration_path
                    ),
                    "strategy_factory_candidate_generation_manifest": str(
                        strategy_factory_bridge.result.candidate_generation_manifest_path
                    ),
                    "strategy_factory_evaluation_manifest": str(
                        strategy_factory_bridge.result.evaluation_manifest_path
                    ),
                    "strategy_factory_recommendation_manifest": str(
                        strategy_factory_bridge.result.recommendation_manifest_path
                    ),
                }
            )
            for (
                validation_name,
                validation_path,
            ) in strategy_factory_bridge.result.validation_artifact_paths.items():
                research_spec["artifacts"][
                    f"strategy_factory_validation_{validation_name}"
                ] = str(validation_path)
            research_spec["strategy_factory"] = {
                **strategy_factory_bridge.candidate_spec_payload.get(
                    "strategy_factory", {}
                ),
                "recommendation": strategy_factory_bridge.recommendation_payload.get(
                    "recommendation"
                ),
                "evaluation_summary": strategy_factory_bridge.evaluation_payload.get(
                    "evidence_summary"
                ),
                "attempt_ledger": strategy_factory_bridge.attempt_payload,
                "validation_tests": list(
                    strategy_factory_bridge.validation_payloads.values()
                ),
                "cost_calibration": strategy_factory_bridge.cost_calibration_payload,
                "sequential_trial": strategy_factory_bridge.sequential_trial_payload,
                "stage_manifest_refs": {
                    "candidate-generation": str(
                        strategy_factory_bridge.result.candidate_generation_manifest_path
                    ),
                    "evaluation": str(
                        strategy_factory_bridge.result.evaluation_manifest_path
                    ),
                    "promotion-recommendation": str(
                        strategy_factory_bridge.result.recommendation_manifest_path
                    ),
                },
                "stage_trace_ids": dict(strategy_factory_bridge.result.stage_trace_ids),
                "stage_lineage_root": strategy_factory_bridge.result.stage_lineage_root,
                "gate_summary": strategy_factory_summary,
            }
        if runtime_strategies:
            primary_strategy = runtime_strategies[0]
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
                research_spec["experiment_spec"] = build_experiment_spec_from_strategy(
                    experiment_id=f"exp-{run_id}",
                    hypothesis=f"compiled-{primary_strategy.strategy_type}-evaluation",
                    strategy_spec=compiled_spec.strategy_spec,
                    parent_experiment_ids=[f"candidate-{candidate_id}"],
                    llm_provenance={"mode": "advisory_only", "source": "none"},
                    lineage={
                        "candidate_id": candidate_id,
                        "run_id": run_id,
                        "source": "autonomous_lane",
                    },
                    research_memory={
                        "summary": f"{primary_strategy.strategy_id}:{primary_strategy.version}",
                        "runtime_errors": sorted(runtime_errors),
                        "baseline_runtime_errors": sorted(baseline_runtime_errors),
                    },
                ).to_payload()
        candidate_spec_path = research_dir / "candidate-spec.json"

        patch_path = None

        raw_gate_policy = gate_policy_payload
        patch_path = _resolve_paper_patch_path(
            gate_report=gate_report,
            strategy_configmap_path=strategy_configmap_path,
            runtime_strategies=runtime_strategies,
            candidate_id=candidate_id,
            paper_dir=paper_dir,
            promotion_target=promotion_target,
        )
        rollback_check = evaluate_rollback_readiness(
            policy_payload=raw_gate_policy,
            candidate_state_payload=candidate_state_payload,
            now=now,
        )
        rollback_check_path.write_text(
            json.dumps(rollback_check.to_payload(), indent=2), encoding="utf-8"
        )
        drift_gate_check = _evaluate_drift_promotion_gate(
            promotion_target=promotion_target,
            drift_promotion_evidence=drift_promotion_evidence,
        )
        candidate_spec_path.write_text(
            json.dumps(research_spec, indent=2), encoding="utf-8"
        )
        profitability_run_context = {
            "repository": str(resolved_governance_repository or ""),
            "base": str(resolved_governance_base or ""),
            "head": str(resolved_governance_head or ""),
            "artifact_path": notes_artifact_root or str(output_dir),
            "run_id": run_id,
            "design_doc": str(resolved_design_doc or ""),
            "priority_id": str(resolved_governance_priority_id or ""),
        }

    def _write_current_profitability_manifest() -> None:
        profitability_manifest_payload = _build_profitability_stage_manifest(
            output_dir=output_dir,
            run_id=run_id,
            candidate_id=candidate_id,
            strategy_family=strategy_family,
            llm_artifact_ref=None,
            router_artifact_ref=router_artifact_ref,
            run_context=profitability_run_context,
            research_manifest_path=manifest_paths.get(_STAGE_CANDIDATE_GENERATION),
            candidate_spec_path=candidate_spec_path,
            evaluation_report_path=evaluation_report_path,
            walkforward_results_path=walk_results_path,
            baseline_evaluation_report_path=baseline_report_path,
            gate_report_payload=gate_report_payload,
            gate_report_path=gate_report_path,
            profitability_benchmark_path=profitability_benchmark_path,
            contamination_registry_path=contamination_registry_path,
            profitability_evidence_path=profitability_evidence_path,
            profitability_validation_path=profitability_validation_path,
            simulation_calibration_report_path=simulation_calibration_report_path,
            shadow_live_deviation_report_path=shadow_live_deviation_report_path,
            hmm_state_posterior_path=hmm_state_posterior_path,
            expert_router_registry_path=expert_router_registry_path,
            benchmark_parity_path=benchmark_parity_path,
            foundation_router_parity_path=foundation_router_parity_path,
            deeplob_bdlob_report_path=deeplob_bdlob_report_path,
            advisor_fallback_slo_report_path=advisor_fallback_slo_report_path,
            janus_event_car_path=janus_event_car_path,
            janus_hgrm_reward_path=janus_hgrm_reward_path,
            recalibration_report_path=recalibration_report_path,
            rollback_check=rollback_check,
            drift_gate_check=drift_gate_check,
            patch_path=patch_path,
            now=now,
        )
        profitability_manifest_path.parent.mkdir(parents=True, exist_ok=True)
        profitability_manifest_path.write_text(
            json.dumps(profitability_manifest_payload, indent=2),
            encoding="utf-8",
        )

    _write_profitability_manifest = _write_current_profitability_manifest

    def _build_promotion_policy_payload() -> dict[str, Any]:
        promotion_policy_payload = dict(raw_gate_policy)
        promotion_policy_payload["promotion_require_profitability_stage_manifest"] = (
            True
        )
        promotion_policy_payload["promotion_require_truthful_evidence_contracts"] = True
        require_jangar_dependency_quorum = (
            hypothesis_registry_requires_dependency_capability(
                load_hypothesis_registry(),
                "jangar_dependency_quorum",
            )
        )
        promotion_policy_payload["promotion_require_jangar_dependency_quorum"] = (
            require_jangar_dependency_quorum
        )
        if require_jangar_dependency_quorum:
            promotion_policy_payload.setdefault(
                "promotion_jangar_dependency_quorum_required_targets",
                ["paper", "live"],
            )
        else:
            promotion_policy_payload.pop(
                "promotion_jangar_dependency_quorum_required_targets",
                None,
            )
        promotion_policy_payload["promotion_require_alpha_readiness_contract"] = True
        promotion_policy_payload.setdefault(
            "promotion_alpha_readiness_required_targets",
            ["paper", "live"],
        )
        promotion_policy_payload.setdefault(
            "promotion_alpha_readiness_require_registry_match",
            True,
        )
        promotion_policy_payload.setdefault(
            "promotion_require_simulation_calibration",
            True,
        )
        promotion_policy_payload.setdefault(
            "promotion_simulation_calibration_required_artifacts",
            ["gates/simulation-calibration-report-v1.json"],
        )
        promotion_policy_payload.setdefault(
            "promotion_simulation_calibration_required_targets",
            ["paper", "live"],
        )
        promotion_policy_payload.setdefault(
            "promotion_simulation_calibration_min_order_count",
            1,
        )
        promotion_policy_payload.setdefault(
            "promotion_simulation_calibration_min_expected_shortfall_coverage",
            "0.50",
        )
        promotion_policy_payload.setdefault(
            "promotion_simulation_calibration_max_avg_calibration_error_bps",
            "25",
        )
        promotion_policy_payload.setdefault(
            "promotion_require_shadow_live_deviation",
            True,
        )
        promotion_policy_payload.setdefault(
            "promotion_shadow_live_deviation_required_artifacts",
            ["gates/shadow-live-deviation-report-v1.json"],
        )
        promotion_policy_payload.setdefault(
            "promotion_shadow_live_deviation_required_targets",
            ["paper", "live"],
        )
        promotion_policy_payload.setdefault(
            "promotion_shadow_live_deviation_min_order_count",
            1,
        )
        promotion_policy_payload.setdefault(
            "promotion_shadow_live_deviation_max_avg_abs_slippage_bps",
            "20",
        )
        promotion_policy_payload.setdefault(
            "promotion_shadow_live_deviation_max_avg_abs_divergence_bps",
            "15",
        )
        promotion_policy_payload.setdefault(
            "promotion_profitability_stage_manifest_artifact",
            _PROFITABILITY_STAGE_MANIFEST_PATH,
        )
        return promotion_policy_payload

    def _evaluate_promotion_prerequisites(
        promotion_policy_payload: dict[str, Any],
    ) -> None:
        nonlocal promotion_check

        promotion_check = evaluate_promotion_prerequisites(
            policy_payload=promotion_policy_payload,
            gate_report_payload=gate_report_payload,
            candidate_state_payload=candidate_state_payload,
            promotion_target=promotion_target,
            artifact_root=output_dir,
            now=now,
        )
        promotion_check_path.write_text(
            json.dumps(promotion_check.to_payload(), indent=2), encoding="utf-8"
        )

    def _record_promotion_recommendation() -> None:
        nonlocal fold_metrics_count, patch_path, promotion_allowed
        nonlocal promotion_reasons, promotion_recommendation
        nonlocal recommendation_trace_id, recommended_mode

        fold_metrics_count = len(walk_results.folds)
        promotion_recommendation = build_promotion_recommendation(
            run_id=run_id,
            candidate_id=candidate_id,
            requested_mode=promotion_target,
            recommended_mode=gate_report.recommended_mode,
            gate_allowed=(
                gate_report.promotion_allowed and bool(drift_gate_check["allowed"])
            ),
            prerequisite_allowed=promotion_check.allowed and strategy_factory_allowed,
            rollback_ready=rollback_check.ready,
            fold_metrics_count=fold_metrics_count,
            stress_metrics_count=stress_metrics_count,
            rationale=_build_promotion_rationale(
                gate_report=gate_report,
                promotion_check_reasons=promotion_check.reasons,
                rollback_check_reasons=rollback_check.reasons,
                promotion_target=promotion_target,
                additional_reasons=strategy_factory_reasons,
            ),
            reasons=[
                *gate_report.reasons,
                *promotion_check.reasons,
                *strategy_factory_reasons,
                *rollback_check.reasons,
                *[
                    str(item)
                    for item in drift_gate_check.get("reasons", [])
                    if str(item).strip()
                ],
            ],
        )
        promotion_allowed = promotion_recommendation.eligible
        if patch_path is None and promotion_allowed:
            patch_path = _resolve_paper_patch_path(
                gate_report=gate_report,
                strategy_configmap_path=strategy_configmap_path,
                runtime_strategies=runtime_strategies,
                candidate_id=candidate_id,
                promotion_target=promotion_target,
                paper_dir=paper_dir,
            )
        promotion_reasons = promotion_recommendation.reasons
        recommended_mode = promotion_recommendation.recommended_mode
        recommendation_trace_id = promotion_recommendation.trace_id
        research_spec["promotion_recommendation"] = (
            promotion_recommendation.to_payload()
        )
        research_spec["promotion_evidence_requirements"] = {
            "fold_metrics_count": len(fold_evidence),
            "stress_case_count": len(stress_evidence),
            "deeplob_bdlob_contract_required": True,
            "advisor_fallback_slo_required": True,
            "strategy_factory_required": strategy_factory_bridge is not None,
            "rationale_required": True,
            "rationale_reason_codes": promotion_reasons,
        }
        candidate_spec_path.write_text(
            json.dumps(research_spec, indent=2), encoding="utf-8"
        )

    def _promotion_gate_artifact_refs() -> list[str]:
        return sorted(
            {
                str(promotion_check_path),
                str(rollback_check_path),
                str(gate_report_path),
                str(benchmark_parity_path),
                str(deeplob_bdlob_report_path),
                str(advisor_fallback_slo_report_path),
                str(contamination_registry_path),
                str(profitability_benchmark_path),
                str(profitability_evidence_path),
                str(profitability_validation_path),
                str(simulation_calibration_report_path),
                str(shadow_live_deviation_report_path),
                str(fold_metrics_path),
                str(stress_metrics_path),
                str(hmm_state_posterior_path),
                str(expert_router_registry_path),
                str(janus_event_car_path),
                str(janus_hgrm_reward_path),
                *[
                    str(item)
                    for item in drift_gate_check.get("artifact_refs", [])
                    if str(item).strip()
                ],
                str(recalibration_report_path),
                *strategy_factory_artifact_refs,
            }
        )

    def _write_promotion_gate_payload() -> None:
        promotion_gate_payload: dict[str, Any] = {
            "allowed": promotion_allowed,
            "recommended_mode": recommended_mode,
            "reasons": promotion_reasons,
            "checks": {
                "gate_matrix": {
                    "allowed": gate_report.promotion_allowed,
                    "reasons": gate_report.reasons,
                    "artifact_refs": [
                        str(gate_report_path),
                        str(benchmark_parity_path),
                        str(deeplob_bdlob_report_path),
                        str(advisor_fallback_slo_report_path),
                        str(profitability_evidence_path),
                        str(profitability_validation_path),
                        str(simulation_calibration_report_path),
                        str(shadow_live_deviation_report_path),
                        str(stress_metrics_path),
                        str(hmm_state_posterior_path),
                        str(expert_router_registry_path),
                        str(fold_metrics_path),
                        str(janus_event_car_path),
                        str(janus_hgrm_reward_path),
                        str(recalibration_report_path),
                        *strategy_factory_artifact_refs,
                    ],
                },
                "promotion_prerequisites": promotion_check.to_payload(),
                "rollback_readiness": rollback_check.to_payload(),
                "profitability_validation": profitability_validation.to_payload(),
                "janus_q": janus_q_summary,
                "drift_governance": drift_gate_check,
                "evidence_requirements": (
                    promotion_recommendation.evidence.to_payload()
                ),
            },
            "recommendation": promotion_recommendation.to_payload(),
            "artifact_refs": _promotion_gate_artifact_refs(),
        }
        if strategy_factory_bridge is not None:
            promotion_gate_checks = cast(
                dict[str, Any], promotion_gate_payload["checks"]
            )
            promotion_gate_checks["strategy_factory"] = dict(strategy_factory_summary)
        promotion_gate_path.write_text(
            json.dumps(promotion_gate_payload, indent=2), encoding="utf-8"
        )
        gate_report_payload["promotion_recommendation"] = (
            promotion_recommendation.to_payload()
        )

    def _run_promotion_recommendation_phase() -> None:
        _write_profitability_manifest()
        _evaluate_promotion_prerequisites(_build_promotion_policy_payload())
        _record_promotion_recommendation()
        _write_promotion_gate_payload()

    def _run_lineage_replay_phase() -> None:
        nonlocal replay_artifacts, stage_lineage_payload
        gate_report_payload["promotion_evidence"] = {
            "fold_metrics": {
                "count": len(fold_evidence),
                "items": fold_evidence,
                "artifact_ref": fold_metrics_artifact_ref,
                "artifact_authority": _artifact_authority_for_evidence("fold_metrics"),
            },
            "stress_metrics": {
                "count": len(stress_evidence),
                "items": stress_evidence,
                "artifact_ref": stress_metrics_artifact_ref,
                "artifact_authority": _artifact_authority_for_evidence(
                    "stress_metrics"
                ),
            },
            "simulation_calibration": _build_bridge_evidence_payload(
                simulation_calibration_report_payload,
                artifact_ref=simulation_calibration_artifact_ref,
                summary_fields=(
                    "order_count",
                    "expected_shortfall_sample_count",
                    "expected_shortfall_coverage",
                    "avg_calibration_error_bps",
                    "confidence_gate_action",
                ),
            ),
            "shadow_live_deviation": _build_bridge_evidence_payload(
                shadow_live_deviation_report_payload,
                artifact_ref=shadow_live_deviation_artifact_ref,
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
                    "count": janus_event_count,
                    "artifact_ref": str(janus_event_car_path),
                    "artifact_authority": _artifact_authority_for_evidence(
                        "janus_event_car"
                    ),
                },
                "hgrm_reward": {
                    "count": janus_reward_count,
                    "artifact_ref": str(janus_hgrm_reward_path),
                    "artifact_authority": _artifact_authority_for_evidence(
                        "janus_hgrm_reward"
                    ),
                },
                "evidence_complete": janus_evidence_complete,
                "reasons": janus_reasons,
                "artifact_authority": _artifact_authority_for_evidence("janus_q"),
            },
            "benchmark_parity": {
                "artifact_ref": benchmark_parity_artifact_ref,
                "artifact_authority": _artifact_authority_for_evidence(
                    "benchmark_parity"
                ),
            },
            "foundation_router_parity": {
                "artifact_ref": foundation_router_parity_artifact_ref,
                "artifact_authority": _artifact_authority_for_evidence(
                    "foundation_router_parity"
                ),
            },
            "deeplob_bdlob_contract": {
                "artifact_ref": deeplob_bdlob_artifact_ref,
                "artifact_authority": _artifact_authority_for_evidence(
                    "deeplob_bdlob_contract"
                ),
            },
            "advisor_fallback_slo": {
                "artifact_ref": advisor_fallback_slo_artifact_ref,
                "artifact_authority": _artifact_authority_for_evidence(
                    "advisor_fallback_slo"
                ),
                "schema_version": advisor_fallback_slo_report.get("schema_version"),
                "evaluated_samples": advisor_fallback_slo_report.get(
                    "evaluated_samples"
                ),
                "timeout_rate": cast(
                    dict[str, Any],
                    advisor_fallback_slo_report.get("fallback_reason_rates", {}),
                ).get("timeout_rate"),
                "state_stale_rate": cast(
                    dict[str, Any],
                    advisor_fallback_slo_report.get("fallback_reason_rates", {}),
                ).get("state_stale_rate"),
                "advice_stale_rate": cast(
                    dict[str, Any],
                    advisor_fallback_slo_report.get("fallback_reason_rates", {}),
                ).get("advice_stale_rate"),
                "safe_fallback_rate": cast(
                    dict[str, Any],
                    advisor_fallback_slo_report.get("fallback_reason_rates", {}),
                ).get("safe_fallback_rate"),
                "slo_pass": cast(
                    dict[str, Any],
                    advisor_fallback_slo_report.get("fallback_reason_rates", {}),
                ).get("slo_pass"),
                "artifact_hash": advisor_fallback_slo_report.get("artifact_hash"),
            },
            "hmm_state_posterior": {
                "artifact_ref": hmm_state_posterior_artifact_ref,
                "artifact_authority": _artifact_authority_for_evidence(
                    "hmm_state_posterior"
                ),
                "schema_version": hmm_state_posterior_payload.get("schema_version"),
                "samples_total": hmm_state_posterior_payload.get("samples_total"),
                "authoritative_samples": hmm_state_posterior_payload.get(
                    "authoritative_samples"
                ),
                "authoritative_sample_ratio": hmm_state_posterior_payload.get(
                    "authoritative_sample_ratio"
                ),
                "transition_shock_samples": hmm_state_posterior_payload.get(
                    "transition_shock_samples"
                ),
                "stale_or_defensive_samples": hmm_state_posterior_payload.get(
                    "stale_or_defensive_samples"
                ),
                "top_regime_by_posterior_mass": hmm_state_posterior_payload.get(
                    "top_regime_by_posterior_mass"
                ),
                "artifact_hash": hmm_state_posterior_payload.get("artifact_hash"),
            },
            "expert_router_registry": {
                "artifact_ref": expert_router_registry_artifact_ref,
                "artifact_authority": _artifact_authority_for_evidence(
                    "expert_router_registry"
                ),
                "schema_version": expert_router_registry_payload.get("schema_version"),
                "router_version": expert_router_registry_payload.get("router_version"),
                "route_count": expert_router_registry_payload.get("route_count"),
                "fallback_count": expert_router_registry_payload.get("fallback_count"),
                "fallback_rate": expert_router_registry_payload.get("fallback_rate"),
                "max_expert_weight": expert_router_registry_payload.get(
                    "max_expert_weight"
                ),
                "artifact_hash": expert_router_registry_payload.get("artifact_hash"),
            },
            "contamination_registry": {
                "artifact_ref": contamination_registry_artifact_ref,
                "artifact_authority": _artifact_authority_for_evidence(
                    "contamination_registry"
                ),
                "status": contamination_registry_payload.get("status", "fail"),
                "leakage_detected": contamination_registry_payload.get(
                    "leakage_detected", True
                ),
                "leakage_rate": contamination_registry_payload.get("leakage_rate", 1.0),
            },
            "promotion_rationale": {
                "requested_target": promotion_target,
                "gate_recommended_mode": gate_report.recommended_mode,
                "recommended_mode": recommended_mode,
                "promotion_allowed": promotion_allowed,
                "reason_codes": promotion_reasons,
                "recommendation_trace_id": recommendation_trace_id,
                "rationale_text": "Promotion decision derives from gate, prerequisite, and rollback checks.",
                "artifact_authority": _artifact_authority_for_evidence(
                    "promotion_rationale"
                ),
            },
        }
        if strategy_factory_bridge is not None:
            gate_report_payload["promotion_evidence"]["strategy_factory"] = {
                **strategy_factory_summary,
                "artifact_authority": _artifact_authority_for_evidence(
                    "strategy_factory"
                ),
            }
        gate_report_payload["promotion_decision"] = {
            "candidate_id": candidate_id,
            "promotion_target": promotion_target,
            "recommended_mode": recommended_mode,
            "promotion_allowed": promotion_allowed,
            "reason_codes": promotion_reasons,
            "promotion_gate_artifact": str(promotion_gate_path),
        }
        gate_report_payload["dependency_quorum"] = candidate_dependency_quorum_payload
        gate_report_payload["alpha_readiness"] = candidate_alpha_readiness_payload
        gate_report_payload["provenance"] = {
            "gate_report_trace_id": gate_report_trace_id,
            "recommendation_trace_id": recommendation_trace_id,
            "benchmark_parity_artifact": str(benchmark_parity_path),
            "foundation_router_parity_artifact": str(foundation_router_parity_path),
            "deeplob_bdlob_contract_artifact": str(deeplob_bdlob_report_path),
            "advisor_fallback_slo_artifact": str(advisor_fallback_slo_report_path),
            "contamination_registry_artifact": str(contamination_registry_path),
            "profitability_benchmark_artifact": str(profitability_benchmark_path),
            "profitability_evidence_artifact": str(profitability_evidence_path),
            "profitability_validation_artifact": str(profitability_validation_path),
            "simulation_calibration_artifact": str(simulation_calibration_report_path),
            "shadow_live_deviation_artifact": str(shadow_live_deviation_report_path),
            "hmm_state_posterior_artifact": str(hmm_state_posterior_path),
            "expert_router_registry_artifact": str(expert_router_registry_path),
            "janus_event_car_artifact": str(janus_event_car_path),
            "janus_hgrm_reward_artifact": str(janus_hgrm_reward_path),
            "recalibration_artifact": str(recalibration_report_path),
            "promotion_gate_artifact": str(promotion_gate_path),
            "promotion_evidence_authority": {
                name: payload.get("artifact_authority")
                for name, payload in cast(
                    dict[str, dict[str, Any]],
                    gate_report_payload["promotion_evidence"],
                ).items()
                if payload.get("artifact_authority")
            },
        }
        gate_report_payload["vnext"] = _build_vnext_gate_summary(
            runtime_strategies=runtime_strategies,
            simulation_calibration_payload=simulation_calibration_report_payload,
            shadow_live_deviation_payload=shadow_live_deviation_report_payload,
        )
        gate_report_path.write_text(
            json.dumps(gate_report_payload, indent=2), encoding="utf-8"
        )

        evaluation_stage_record = _write_stage_manifest(
            stage=_STAGE_EVALUATION,
            stage_index=2,
            stage_output_dir=stages_dir,
            run_id=run_id,
            candidate_id=candidate_id,
            lineage_parent_hash=candidate_generation_stage_record.lineage_hash,
            lineage_parent_stage=candidate_generation_stage_record.stage,
            inputs={
                "run_id": run_id,
                "candidate_id": candidate_id,
                "recommendation_trace_id": "",
            },
            input_artifacts={
                "walkforward_results": walk_results_path,
                "baseline_evaluation_report": baseline_report_path,
                "signals": signals_path,
            },
            output_artifacts={
                "evaluation_report": evaluation_report_path,
                "gate_evaluation": gate_report_path,
                "benchmark_parity": benchmark_parity_path,
                "foundation_router_parity": foundation_router_parity_path,
                "deeplob_bdlob_contract": deeplob_bdlob_report_path,
                "advisor_fallback_slo": advisor_fallback_slo_report_path,
                "contamination_registry": contamination_registry_path,
                "profitability_benchmark": profitability_benchmark_path,
                "profitability_evidence": profitability_evidence_path,
                "profitability_validation": profitability_validation_path,
                "simulation_calibration": simulation_calibration_report_path,
                "shadow_live_deviation": shadow_live_deviation_report_path,
                "hmm_state_posterior": hmm_state_posterior_path,
                "expert_router_registry": expert_router_registry_path,
                "janus_event_car": janus_event_car_path,
                "janus_hgrm_reward": janus_hgrm_reward_path,
                "recalibration_report": recalibration_report_path,
                **(
                    {
                        "strategy_factory_candidate_spec": strategy_factory_bridge.result.candidate_spec_path,
                        "strategy_factory_evaluation_report": strategy_factory_bridge.result.evaluation_report_path,
                        "strategy_factory_recommendation": strategy_factory_bridge.result.recommendation_artifact_path,
                        "strategy_factory_attempt_ledger": strategy_factory_bridge.result.attempt_ledger_path,
                        "strategy_factory_sequential_trial": strategy_factory_bridge.result.sequential_trial_path,
                        "strategy_factory_cost_calibration": strategy_factory_bridge.result.cost_calibration_path,
                        **{
                            f"strategy_factory_validation_{name}": path
                            for name, path in strategy_factory_bridge.result.validation_artifact_paths.items()
                        },
                    }
                    if strategy_factory_bridge is not None
                    else {}
                ),
            },
            created_at=now,
        )
        stage_records.append(evaluation_stage_record)
        manifest_paths[_STAGE_EVALUATION] = (
            stages_dir / f"{_STAGE_EVALUATION}-manifest.json"
        )
        stage_trace_ids[_STAGE_EVALUATION] = evaluation_stage_record.stage_trace_id

        promotion_recommendation_payload = {
            "schema_version": "torghut-autonomy-promotion-recommendation-v1",
            "run_id": run_id,
            "candidate_id": candidate_id,
            "promotion_target": promotion_target,
            "recommendation": promotion_recommendation.to_payload(),
            "recommendation_trace_id": recommendation_trace_id,
            "stage_trace_ids": stage_trace_ids,
            "gates": {
                "gate_matrix_recommended_mode": gate_report.recommended_mode,
                "gate_matrix_allowed": gate_report.promotion_allowed,
                "drift_gate_allowed": bool(drift_gate_check.get("allowed")),
                "rollback_ready": rollback_check.ready,
                "prerequisite_allowed": promotion_check.allowed,
                "strategy_factory_allowed": strategy_factory_allowed,
            },
            "artifact_refs": sorted(
                set(
                    [
                        str(gate_report_path),
                        str(promotion_gate_path),
                        str(profitability_manifest_path),
                        str(benchmark_parity_path),
                        str(advisor_fallback_slo_report_path),
                        str(contamination_registry_path),
                        str(profitability_benchmark_path),
                        str(profitability_evidence_path),
                        str(profitability_validation_path),
                        str(simulation_calibration_report_path),
                        str(shadow_live_deviation_report_path),
                        str(hmm_state_posterior_path),
                        str(expert_router_registry_path),
                        str(janus_event_car_path),
                        str(janus_hgrm_reward_path),
                        str(recalibration_report_path),
                        *strategy_factory_artifact_refs,
                    ]
                )
            ),
        }
        promotion_recommendation_path.write_text(
            json.dumps(promotion_recommendation_payload, indent=2),
            encoding="utf-8",
        )
        recommendation_stage_record = _write_stage_manifest(
            stage=_STAGE_RECOMMENDATION,
            stage_index=3,
            stage_output_dir=stages_dir,
            run_id=run_id,
            candidate_id=candidate_id,
            lineage_parent_hash=evaluation_stage_record.lineage_hash,
            lineage_parent_stage=evaluation_stage_record.stage,
            inputs={
                "run_id": run_id,
                "candidate_id": candidate_id,
                "recommendation_trace_id": recommendation_trace_id or "",
                "stage_trace_ids": json.dumps(
                    stage_trace_ids, sort_keys=True, separators=(",", ":")
                ),
            },
            input_artifacts={
                "gate_evaluation": gate_report_path,
                "promotion_gate": promotion_gate_path,
            },
            output_artifacts={
                "promotion_recommendation": promotion_recommendation_path,
            },
            created_at=now,
        )
        stage_records.append(recommendation_stage_record)
        manifest_paths[_STAGE_RECOMMENDATION] = (
            stages_dir / f"{_STAGE_RECOMMENDATION}-manifest.json"
        )
        stage_trace_ids[_STAGE_RECOMMENDATION] = (
            recommendation_stage_record.stage_trace_id
        )
        stage_lineage_payload = _build_stage_lineage_payload(
            stage_records=stage_records,
            manifest_paths=manifest_paths,
        )
        replay_artifacts = {
            "signals": signals_path,
            "strategy_config": strategy_config_path,
            "gate_policy": gate_policy_path,
            "walkforward_results": walk_results_path,
            "baseline_evaluation_report": baseline_report_path,
            "evaluation_report": evaluation_report_path,
            "gate_report": gate_report_path,
            "profitability_stage_manifest": profitability_manifest_path,
            "benchmark_parity": benchmark_parity_path,
            "foundation_router_parity": foundation_router_parity_path,
            "deeplob_bdlob_contract": deeplob_bdlob_report_path,
            "advisor_fallback_slo": advisor_fallback_slo_report_path,
            "contamination_registry": contamination_registry_path,
            "profitability_benchmark": profitability_benchmark_path,
            "profitability_evidence": profitability_evidence_path,
            "profitability_validation": profitability_validation_path,
            "simulation_calibration": simulation_calibration_report_path,
            "shadow_live_deviation": shadow_live_deviation_report_path,
            "expert_router_registry": expert_router_registry_path,
            "janus_event_car": janus_event_car_path,
            "janus_hgrm_reward": janus_hgrm_reward_path,
            "recalibration_report": recalibration_report_path,
            "promotion_gate": promotion_gate_path,
            "promotion_recommendation": promotion_recommendation_path,
            "recommendation_manifest": manifest_paths.get(_STAGE_RECOMMENDATION),
            "evaluation_manifest": manifest_paths.get(_STAGE_EVALUATION),
            "candidate_generation_manifest": manifest_paths.get(
                _STAGE_CANDIDATE_GENERATION
            ),
        }
        research_spec["stage_lineage"] = stage_lineage_payload
        research_spec["stage_trace_ids"] = dict(stage_trace_ids)
        research_spec["stage_lineage_root"] = stage_lineage_payload.get(
            "root_lineage_hash"
        )
        experiment_spec_payload = (
            cast(dict[str, Any], research_spec.get("experiment_spec"))
            if isinstance(research_spec.get("experiment_spec"), dict)
            else None
        )
        if experiment_spec_payload is not None:
            lineage_payload = (
                cast(dict[str, Any], experiment_spec_payload.get("lineage"))
                if isinstance(experiment_spec_payload.get("lineage"), dict)
                else {}
            )
            lineage_payload["stage_lineage_root"] = stage_lineage_payload.get(
                "root_lineage_hash"
            )
            lineage_payload["stage_trace_ids"] = dict(stage_trace_ids)
            experiment_spec_payload["lineage"] = lineage_payload
        research_spec["stage_manifest_refs"] = {
            _STAGE_CANDIDATE_GENERATION: str(
                manifest_paths[_STAGE_CANDIDATE_GENERATION]
            ),
            _STAGE_EVALUATION: str(manifest_paths[_STAGE_EVALUATION]),
            _STAGE_RECOMMENDATION: str(manifest_paths[_STAGE_RECOMMENDATION]),
            _STAGE_PROFITABILITY: str(profitability_manifest_path),
        }
        bridge_payload = (
            cast(dict[str, Any], research_spec.get("bridge_persistence_v2"))
            if isinstance(research_spec.get("bridge_persistence_v2"), dict)
            else {}
        )
        bridge_payload["experiment_runs"] = [
            {
                "experiment_id": (
                    str(experiment_spec_payload.get("experiment_id"))
                    if experiment_spec_payload is not None
                    else None
                ),
                "run_id": run_id,
                "candidate_id": candidate_id,
                "stage_lineage_root": stage_lineage_payload.get("root_lineage_hash"),
            }
        ]
        bridge_payload["promotion_decisions_v2"] = [
            {
                "candidate_id": candidate_id,
                "run_id": run_id,
                "promotion_target": promotion_target,
                "recommended_mode": promotion_recommendation_payload.get(
                    "recommended_mode"
                ),
                "eligible": promotion_check.allowed,
                "artifact_ref": str(promotion_recommendation_path),
            }
        ]
        research_spec["bridge_persistence_v2"] = bridge_payload
        research_spec["artifacts"] = {
            **research_spec["artifacts"],
            **{
                key: str(artifact_path)
                for key, artifact_path in replay_artifacts.items()
                if artifact_path is not None
            },
            "promotion_recommendation": str(promotion_recommendation_path),
            _STAGE_PROFITABILITY: str(profitability_manifest_path),
            _STAGE_CANDIDATE_GENERATION: str(
                manifest_paths[_STAGE_CANDIDATE_GENERATION]
            ),
            _STAGE_EVALUATION: str(manifest_paths[_STAGE_EVALUATION]),
            _STAGE_RECOMMENDATION: str(manifest_paths[_STAGE_RECOMMENDATION]),
        }
        candidate_spec_path.write_text(
            json.dumps(research_spec, indent=2), encoding="utf-8"
        )

    def _run_actuation_persistence_phase() -> None:
        nonlocal actuation_intent_path
        if recommendation_trace_id is None or gate_report_trace_id is None:
            raise RuntimeError("autonomous_lane_trace_ids_missing")
        candidate_spec_replay_artifacts: dict[str, Path | None] = {
            key: value
            for key, value in replay_artifacts.items()
            if key != "profitability_stage_manifest"
        }
        replay_artifact_hashes = _artifact_hashes(candidate_spec_replay_artifacts)
        candidate_hash = _compute_candidate_hash(
            run_id=run_id,
            runtime_strategies=runtime_strategies,
            gate_report=gate_report,
            signals_path=signals_path,
            strategy_config_path=strategy_config_path,
            gate_policy_path=gate_policy_path,
            stage_lineage_payload=stage_lineage_payload,
            replay_artifact_hashes=replay_artifact_hashes,
        )
        research_spec["candidate_hash"] = candidate_hash
        research_spec["replay_artifact_hashes"] = replay_artifact_hashes
        candidate_spec_path.write_text(
            json.dumps(research_spec, indent=2), encoding="utf-8"
        )
        _write_profitability_manifest()
        _write_iteration_notes(
            artifact_root=notes_root,
            run_id=run_id,
            candidate_id=candidate_id,
            stage_records=stage_records,
            repository=cast(str, resolved_governance_repository),
            base=cast(str, resolved_governance_base),
            head=cast(str, resolved_governance_head),
            priority_id=cast(str, resolved_governance_priority_id)
            if resolved_governance_priority_id
            else None,
        )

        actuation_allowed = (
            bool(recommendation_trace_id)
            and promotion_recommendation.eligible
            and rollback_check.ready
        )
        actuation_intent_path = output_dir / _ACTUATION_INTENT_PATH
        actuation_intent_path.parent.mkdir(parents=True, exist_ok=True)
        actuation_intent_payload = _build_actuation_intent_payload(
            run_id=run_id,
            candidate_id=candidate_id,
            generated_at=now,
            recommendation_trace_id=recommendation_trace_id,
            gate_report_trace_id=gate_report_trace_id,
            promotion_target=promotion_target,
            recommended_mode=recommended_mode,
            actuation_allowed=actuation_allowed,
            promotion_check=promotion_check.to_payload(),
            rollback_check=rollback_check.to_payload(),
            candidate_state_payload=candidate_state_payload,
            gate_report_path=gate_report_path,
            rollback_check_path=rollback_check_path,
            candidate_spec_path=candidate_spec_path,
            candidate_generation_manifest_path=manifest_paths[
                _STAGE_CANDIDATE_GENERATION
            ],
            evaluation_manifest_path=manifest_paths[_STAGE_EVALUATION],
            recommendation_manifest_path=manifest_paths[_STAGE_RECOMMENDATION],
            profitability_manifest_path=profitability_manifest_path,
            promotion_recommendation_path=promotion_recommendation_path,
            evaluation_report_path=evaluation_report_path,
            walk_results_path=walk_results_path,
            paper_patch_path=patch_path,
            patch_required=bool(
                promotion_target in {"paper", "live"}
                and gate_report.recommended_mode == "paper"
            ),
            profitability_benchmark_path=profitability_benchmark_path,
            profitability_evidence_path=profitability_evidence_path,
            profitability_validation_path=profitability_validation_path,
            simulation_calibration_report_path=simulation_calibration_report_path,
            shadow_live_deviation_report_path=shadow_live_deviation_report_path,
            benchmark_parity_path=benchmark_parity_path,
            foundation_router_parity_path=foundation_router_parity_path,
            deeplob_bdlob_report_path=deeplob_bdlob_report_path,
            advisor_fallback_slo_report_path=advisor_fallback_slo_report_path,
            janus_event_car_path=janus_event_car_path,
            janus_hgrm_reward_path=janus_hgrm_reward_path,
            recalibration_report_path=recalibration_report_path,
            promotion_gate_path=promotion_gate_path,
            promotion_recommendation=promotion_recommendation,
            recommendations=promotion_reasons,
            governance_repository=cast(str, resolved_governance_repository),
            governance_base=cast(str, resolved_governance_base),
            governance_head=cast(str, resolved_governance_head),
            governance_artifact_path=(
                notes_artifact_root if notes_artifact_root else str(output_dir)
            ),
            priority_id=cast(str, resolved_governance_priority_id)
            if resolved_governance_priority_id
            else None,
            governance_change=governance_change,
            governance_reason=(
                governance_reason
                or f"Autonomous recommendation for {promotion_target} target."
            ),
            stage_lineage_payload=stage_lineage_payload,
            replay_artifact_hashes=replay_artifact_hashes,
            candidate_hash=candidate_hash,
        )
        actuation_intent_path.write_text(
            json.dumps(actuation_intent_payload, indent=2), encoding="utf-8"
        )

        phase_manifest_payload = _build_phase_manifest(
            run_id=run_id,
            candidate_id=candidate_id,
            evaluated_at=now,
            output_dir=output_dir,
            signals=signals,
            requested_promotion_target=promotion_target,
            gate_report=gate_report,
            gate_report_payload=gate_report_payload,
            gate_report_path=gate_report_path,
            promotion_check=promotion_check,
            rollback_check=rollback_check,
            drift_gate_check=drift_gate_check,
            patch_path=patch_path,
            recommended_mode=recommended_mode,
            promotion_reasons=promotion_reasons,
            governance_inputs=governance_context,
            drift_promotion_evidence=drift_promotion_evidence,
        )
        phase_manifest_path.write_text(
            json.dumps(phase_manifest_payload, indent=2), encoding="utf-8"
        )

        _persist_run_outputs_if_requested(
            persist_results=persist_results,
            session_factory=factory,
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
            stage_lineage_payload=(stage_lineage_payload),
            stage_manifest_refs=research_spec["stage_manifest_refs"],
            replay_artifact_hashes=replay_artifact_hashes,
            simulation_calibration_report_payload=simulation_calibration_report_payload,
            shadow_live_deviation_report_payload=shadow_live_deviation_report_payload,
        )
        _mark_run_passed_if_requested(
            persist_results=persist_results,
            session_factory=factory,
            run_id=run_id,
            run_row=run_row,
            now=now,
            gate_report_trace_id=gate_report_trace_id,
            recommendation_trace_id=recommendation_trace_id,
        )

    try:
        _run_candidate_generation_phase()
        _run_profitability_validation_phase()
        _run_gate_report_spec_phase()
        _run_promotion_recommendation_phase()
        _run_lineage_replay_phase()
        _run_actuation_persistence_phase()
        if gate_report_trace_id is None or recommendation_trace_id is None:
            raise RuntimeError("autonomous_lane_trace_ids_missing")
        return AutonomousLaneResult(
            run_id=run_id,
            candidate_id=candidate_id,
            output_dir=output_dir,
            gate_report_path=gate_report_path,
            actuation_intent_path=actuation_intent_path,
            paper_patch_path=patch_path,
            phase_manifest_path=phase_manifest_path,
            recommendation_artifact_path=promotion_recommendation_path,
            candidate_spec_path=candidate_spec_path,
            candidate_generation_manifest_path=manifest_paths[
                _STAGE_CANDIDATE_GENERATION
            ],
            evaluation_manifest_path=manifest_paths[_STAGE_EVALUATION],
            recommendation_manifest_path=manifest_paths[_STAGE_RECOMMENDATION],
            profitability_manifest_path=profitability_manifest_path,
            benchmark_parity_path=benchmark_parity_path,
            foundation_router_parity_path=foundation_router_parity_path,
            gate_report_trace_id=gate_report_trace_id,
            recommendation_trace_id=recommendation_trace_id,
            stage_trace_ids=stage_trace_ids,
            stage_lineage_root=(
                stage_lineage_payload["root_lineage_hash"] if stage_records else None
            ),
        )
    except Exception as exc:
        _mark_run_failed_if_requested(
            persist_results=persist_results,
            session_factory=factory,
            run_id=run_id,
            run_row=run_row,
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
