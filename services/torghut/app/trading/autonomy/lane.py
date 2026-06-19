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


def upsert_autonomy_no_signal_run(
    *,
    session_factory: Callable[[], Session],
    query_start: datetime,
    query_end: datetime,
    strategy_config_path: Path,
    gate_policy_path: Path,
    no_signal_reason: str | None,
    now: datetime,
    code_version: str = "live",
) -> str:
    """Persist a zero-signal window as a skipped research run."""

    strategy: StrategyRuntimeConfig | None = None
    try:
        runtime_strategies = load_runtime_strategy_config(strategy_config_path)
        strategy = runtime_strategies[0] if runtime_strategies else None
    except Exception:
        strategy = None

    strategy_id = strategy.strategy_id if strategy else None
    strategy_type = strategy.strategy_type if strategy else None
    strategy_version = strategy.version if strategy else None

    reason_label = (no_signal_reason or "no_signal").strip()
    query_start_utc = _ensure_utc(query_start)
    query_end_utc = _ensure_utc(query_end)

    run_signature = {
        "query_start": query_start_utc.isoformat() if query_start_utc else None,
        "query_end": query_end_utc.isoformat() if query_end_utc else None,
        "strategy_config_path": str(strategy_config_path),
        "reason": reason_label,
    }
    run_signature_bytes = json.dumps(run_signature, sort_keys=True).encode("utf-8")
    run_id = hashlib.sha256(run_signature_bytes).hexdigest()[:24]

    feature_spec_hash = _compute_no_signal_feature_spec_hash(
        strategy_config_path=strategy_config_path,
        gate_policy_path=gate_policy_path,
        reason=reason_label,
        query_start=query_start_utc,
        query_end=query_end_utc,
    )
    dataset_version = _compute_no_signal_dataset_version_hash(
        query_start=query_start_utc,
        query_end=query_end_utc,
        no_signal_reason=reason_label,
    )

    with session_factory() as session:
        existing_run = session.execute(
            select(ResearchRun).where(ResearchRun.run_id == run_id)
        ).scalar_one_or_none()

        if existing_run is None:
            run = ResearchRun(
                run_id=run_id,
                status="skipped",
                strategy_id=strategy_id,
                strategy_name=strategy_id,
                strategy_type=strategy_type,
                strategy_version=strategy_version,
                code_commit=code_version,
                feature_version=settings.trading_feature_normalization_version,
                feature_schema_version=settings.trading_feature_schema_version,
                feature_spec_hash=feature_spec_hash,
                signal_source="autonomy-signals",
                dataset_version=dataset_version,
                dataset_from=query_start_utc,
                dataset_to=query_end_utc,
                dataset_snapshot_ref="no_signal_window",
                runner_version="run_autonomous_lane_no_signals",
                runner_binary_hash=hashlib.sha256(run_id.encode("utf-8")).hexdigest(),
                updated_at=now,
            )
            session.add(run)
        else:
            existing_run.status = "skipped"
            existing_run.strategy_id = strategy_id
            existing_run.strategy_name = strategy_id
            existing_run.strategy_type = strategy_type
            existing_run.strategy_version = strategy_version
            existing_run.code_commit = code_version
            existing_run.feature_version = (
                settings.trading_feature_normalization_version
            )
            existing_run.feature_spec_hash = feature_spec_hash
            existing_run.feature_schema_version = (
                settings.trading_feature_schema_version
            )
            existing_run.signal_source = "autonomy-signals"
            existing_run.dataset_version = dataset_version
            existing_run.dataset_from = query_start_utc
            existing_run.dataset_to = query_end_utc
            existing_run.dataset_snapshot_ref = "no_signal_window"
            existing_run.runner_version = "run_autonomous_lane_no_signals"
            existing_run.runner_binary_hash = hashlib.sha256(
                run_id.encode("utf-8")
            ).hexdigest()
            existing_run.updated_at = now
            session.add(existing_run)
        session.commit()
        return run_id


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


def _collect_walk_decisions_for_runtime(
    *,
    runtime: StrategyRuntime,
    ordered_signals: list[SignalEnvelope],
    runtime_strategies: list[StrategyRuntimeConfig],
) -> tuple[list[WalkForwardDecision], list[str]]:
    walk_decisions: list[WalkForwardDecision] = []
    runtime_errors: list[str] = []
    for signal in ordered_signals:
        result = runtime.evaluate(signal, runtime_strategies)
        runtime_errors.extend(result.errors)
        features = extract_signal_features(signal)
        for decision in result.decisions:
            walk_decisions.append(
                WalkForwardDecision(decision=decision, features=features)
            )
    return walk_decisions, runtime_errors


def _resolve_confidence_calibration(
    *,
    profitability_evidence_payload: dict[str, Any],
    run_id: str,
    recalibration_report_path: Path,
) -> tuple[dict[str, Any], str, str | None]:
    confidence_calibration_raw = profitability_evidence_payload.get(
        "confidence_calibration"
    )
    confidence_calibration = (
        dict(cast(Mapping[str, Any], confidence_calibration_raw))
        if isinstance(confidence_calibration_raw, dict)
        else {}
    )
    uncertainty_action = str(
        confidence_calibration.get("gate_action", "abstain")
    ).strip()
    recalibration_run_id: str | None = None
    if uncertainty_action != "pass":
        recalibration_run_id = f"recal-{run_id[:12]}"
        confidence_calibration["recalibration_run_id"] = recalibration_run_id
        confidence_calibration["recalibration_artifact_ref"] = str(
            recalibration_report_path
        )
    profitability_evidence_payload["confidence_calibration"] = confidence_calibration
    return confidence_calibration, uncertainty_action, recalibration_run_id


def _resolve_paper_patch_path(
    *,
    gate_report: GateEvaluationReport,
    strategy_configmap_path: Path | None,
    runtime_strategies: list[StrategyRuntimeConfig],
    candidate_id: str,
    promotion_target: str,
    paper_dir: Path,
) -> Path | None:
    if not gate_report.promotion_allowed:
        return None
    if gate_report.recommended_mode != "paper":
        return None
    resolved_configmap = strategy_configmap_path or _default_strategy_configmap_path()
    return _write_paper_candidate_patch(
        configmap_path=resolved_configmap,
        runtime_strategies=runtime_strategies,
        candidate_id=candidate_id,
        output_path=paper_dir / "strategy-configmap-patch.yaml",
    )


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


def _mark_run_passed_if_requested(
    *,
    persist_results: bool,
    session_factory: Callable[[], Session],
    run_id: str,
    run_row: ResearchRun | None,
    now: datetime,
    gate_report_trace_id: str | None,
    recommendation_trace_id: str | None,
) -> None:
    if not persist_results:
        return
    _mark_run_passed(
        session_factory=session_factory,
        run_id=run_id,
        run_row=run_row,
        now=now,
        gate_report_trace_id=gate_report_trace_id,
        recommendation_trace_id=recommendation_trace_id,
    )


def _mark_run_failed_if_requested(
    *,
    persist_results: bool,
    session_factory: Callable[[], Session],
    run_id: str,
    run_row: ResearchRun | None,
    now: datetime,
) -> None:
    if not persist_results:
        return
    _mark_run_failed(
        session_factory=session_factory,
        run_id=run_id,
        run_row=run_row,
        now=now,
    )


def _upsert_research_run(
    *,
    session_factory: Callable[[], Session],
    run_id: str,
    strategy: StrategyRuntimeConfig | None,
    signals: list[SignalEnvelope],
    strategy_config_path: Path,
    signals_path: Path,
    gate_policy_path: Path,
    code_version: str,
    now: datetime,
) -> ResearchRun:
    with session_factory() as session:
        existing_run = session.execute(
            select(ResearchRun).where(ResearchRun.run_id == run_id)
        ).scalar_one_or_none()

        dataset_from = signals[0].event_ts if signals else None
        dataset_to = signals[-1].event_ts if signals else None

        strategy_id = strategy.strategy_id if strategy else None
        strategy_type = strategy.strategy_type if strategy else None
        strategy_version = strategy.version if strategy else None

        if existing_run is None:
            run = ResearchRun(
                run_id=run_id,
                status="running",
                strategy_id=strategy_id,
                strategy_name=strategy_id,
                strategy_type=strategy_type,
                strategy_version=strategy_version,
                code_commit=code_version,
                feature_version=settings.trading_feature_normalization_version,
                feature_schema_version=settings.trading_feature_schema_version,
                feature_spec_hash=_compute_feature_spec_hash(
                    strategy_config_path=strategy_config_path,
                    gate_policy_path=gate_policy_path,
                    signals_path=signals_path,
                ),
                signal_source="autonomy-signals",
                dataset_version=_compute_dataset_version_hash(
                    signals_path=signals_path
                ),
                dataset_from=dataset_from,
                dataset_to=dataset_to,
                dataset_snapshot_ref=str(strategy_config_path),
                runner_version="run_autonomous_lane",
                runner_binary_hash=hashlib.sha256(run_id.encode("utf-8")).hexdigest(),
                gate_report_trace_id=None,
                recommendation_trace_id=None,
                updated_at=now,
            )
            session.add(run)
            session.commit()
            session.refresh(run)
            return run

        existing_run.status = "running"
        existing_run.strategy_id = strategy_id
        existing_run.strategy_name = strategy_id
        existing_run.strategy_type = strategy_type
        existing_run.strategy_version = strategy_version
        existing_run.code_commit = code_version
        existing_run.feature_version = settings.trading_feature_normalization_version
        existing_run.feature_schema_version = settings.trading_feature_schema_version
        existing_run.feature_spec_hash = _compute_feature_spec_hash(
            strategy_config_path=strategy_config_path,
            gate_policy_path=gate_policy_path,
            signals_path=signals_path,
        )
        existing_run.signal_source = "autonomy-signals"
        existing_run.dataset_from = dataset_from
        existing_run.dataset_to = dataset_to
        existing_run.dataset_version = _compute_dataset_version_hash(
            signals_path=signals_path
        )
        existing_run.dataset_snapshot_ref = str(strategy_config_path)
        existing_run.runner_version = "run_autonomous_lane"
        existing_run.runner_binary_hash = hashlib.sha256(
            run_id.encode("utf-8")
        ).hexdigest()
        existing_run.gate_report_trace_id = None
        existing_run.recommendation_trace_id = None
        existing_run.updated_at = now
        session.add(existing_run)
        session.commit()
        session.refresh(existing_run)
        return existing_run


def _mark_run_failed(
    *,
    session_factory: Callable[[], Session],
    run_id: str,
    run_row: ResearchRun | None,
    now: datetime,
) -> None:
    if run_row is None:
        return
    with session_factory() as session:
        existing_run = session.execute(
            select(ResearchRun).where(ResearchRun.run_id == run_id)
        ).scalar_one_or_none()
        if existing_run is None:
            return
        existing_run.status = "failed"
        existing_run.updated_at = now
        session.add(existing_run)
        session.commit()


def _mark_run_passed(
    *,
    session_factory: Callable[[], Session],
    run_id: str,
    run_row: ResearchRun | None,
    now: datetime,
    gate_report_trace_id: str | None,
    recommendation_trace_id: str | None,
) -> None:
    if run_row is None:
        return
    with session_factory() as session:
        existing_run = session.execute(
            select(ResearchRun).where(ResearchRun.run_id == run_id)
        ).scalar_one_or_none()
        if existing_run is None:
            return
        existing_run.status = "passed"
        existing_run.gate_report_trace_id = gate_report_trace_id
        existing_run.recommendation_trace_id = recommendation_trace_id
        existing_run.updated_at = now
        session.add(existing_run)
        session.commit()


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


def _persist_strategy_spec_lineage_trace(
    *,
    session: Session,
    run_id: str,
    candidate_id: str,
    runtime_strategies: Sequence[StrategyRuntimeConfig],
    candidate_spec_payload: Mapping[str, Any],
    experiment_payload: Mapping[str, Any],
) -> None:
    gate_id = "strategy_spec_v2_runtime_lineage"
    artifacts_payload = (
        cast(dict[str, Any], candidate_spec_payload.get("artifacts"))
        if isinstance(candidate_spec_payload.get("artifacts"), dict)
        else {}
    )
    walkforward_results_ref = (
        _coerce_str(artifacts_payload.get("walkforward_results")) or None
    )
    evaluation_report_ref = (
        _coerce_str(artifacts_payload.get("evaluation_report")) or None
    )
    gate_evaluation_ref = _coerce_str(artifacts_payload.get("gate_evaluation")) or None
    strategy_items = [
        {
            "strategy_id": strategy.strategy_id,
            "compiler_source": strategy.compiler_source,
            "spec_compiled": bool(strategy.strategy_spec)
            and bool(strategy.compiled_targets),
        }
        for strategy in runtime_strategies
    ]
    spec_compiled_count = sum(1 for item in strategy_items if item["spec_compiled"])
    satisfied = bool(strategy_items) and spec_compiled_count == len(strategy_items)
    blocked_reason = None if satisfied else "strategy_spec_v2_lineage_incomplete"
    trace_payload = build_completion_trace(
        doc_id="doc29",
        gate_ids_attempted=[gate_id],
        run_id=run_id,
        dataset_snapshot_ref=walkforward_results_ref,
        candidate_id=candidate_id,
        workflow_name="torghut-autonomy-lane",
        analysis_run_names=[],
        artifact_refs=[
            str(item)
            for item in [
                walkforward_results_ref,
                evaluation_report_ref,
                gate_evaluation_ref,
            ]
            if item is not None
        ],
        db_row_refs={},
        status_snapshot={
            "strategy_migration_state": {
                "total_strategies": len(strategy_items),
                "spec_compiled_count": spec_compiled_count,
                "experiment_spec_present": bool(experiment_payload),
                "strategies": strategy_items,
            }
        },
        result_by_gate={
            gate_id: {
                "status": "satisfied" if satisfied else "blocked",
                "blocked_reason": blocked_reason,
                "artifact_ref": walkforward_results_ref,
                "acceptance_snapshot": {
                    "strategy_migration_state": {
                        "total_strategies": len(strategy_items),
                        "spec_compiled_count": spec_compiled_count,
                        "experiment_spec_present": bool(experiment_payload),
                    }
                },
            }
        },
        blocked_reasons={gate_id: blocked_reason} if blocked_reason else {},
    )
    persist_completion_trace(session=session, trace_payload=trace_payload)


def _runtime_observation_contract_payload(
    candidate_spec_payload: Mapping[str, Any],
) -> dict[str, Any]:
    payload = candidate_spec_payload.get("runtime_observation")
    if isinstance(payload, dict):
        return cast(dict[str, Any], payload)
    return {}


def _runtime_observation_has_ledger_profit_proof(
    runtime_observation_payload: Mapping[str, Any],
) -> bool:
    return bool(runtime_observation_payload.get("runtime_ledger_profit_proof_present"))


def _resolve_hypothesis_window_evidence(
    *,
    promotion_target: str,
    runtime_observation_payload: Mapping[str, Any],
    effective_promotion_allowed: bool,
    order_count: int,
    min_sample_count_for_scale_up: int,
) -> tuple[str, str, str, dict[str, Any]]:
    observed_stage = "paper" if promotion_target == "paper" else "live"
    expected_provenance = (
        "paper_runtime_observed"
        if observed_stage == "paper"
        else "live_runtime_observed"
    )
    runtime_observation_stage = _coerce_str(
        runtime_observation_payload.get("observed_stage")
    )
    runtime_observation_provenance = _coerce_str(
        runtime_observation_payload.get("evidence_provenance")
    )
    runtime_observation_authoritative = bool(
        runtime_observation_payload.get("authoritative")
    )
    runtime_observation_source_kind = _coerce_str(
        runtime_observation_payload.get("source_kind")
    )
    runtime_observation_has_runtime_ledger_profit_proof = (
        _runtime_observation_has_ledger_profit_proof(runtime_observation_payload)
    )
    simulation_observation = runtime_observation_source_kind.startswith("simulation_")
    qualified_runtime_observation = (
        runtime_observation_authoritative
        and runtime_observation_stage == observed_stage
        and runtime_observation_provenance == expected_provenance
        and not simulation_observation
    )
    if qualified_runtime_observation:
        evidence_provenance = expected_provenance
        evidence_maturity = (
            "empirically_validated"
            if order_count > 0 and effective_promotion_allowed
            else "uncalibrated"
        )
        if observed_stage == "paper":
            capital_stage = "shadow"
        elif (
            effective_promotion_allowed and order_count >= min_sample_count_for_scale_up
        ):
            capital_stage = "0.50x live"
        elif effective_promotion_allowed:
            capital_stage = "0.10x canary"
        else:
            capital_stage = "shadow"
        qualification_reason = "runtime_observation_contract_qualified"
    else:
        evidence_provenance = "historical_market_replay"
        evidence_maturity = (
            "calibrated"
            if order_count > 0 and effective_promotion_allowed
            else "uncalibrated"
        )
        capital_stage = "shadow"
        qualification_reason = (
            "simulation_source_replay_only"
            if simulation_observation
            else "runtime_observation_contract_missing_or_ineligible"
        )
    return (
        evidence_provenance,
        evidence_maturity,
        capital_stage,
        {
            "requested_promotion_target": promotion_target,
            "runtime_observation_present": bool(runtime_observation_payload),
            "runtime_observation_authoritative": runtime_observation_authoritative,
            "runtime_observation_stage": runtime_observation_stage,
            "runtime_observation_provenance": runtime_observation_provenance,
            "runtime_observation_source_kind": runtime_observation_source_kind,
            "runtime_observation_has_runtime_ledger_profit_proof": (
                runtime_observation_has_runtime_ledger_profit_proof
            ),
            "qualified_runtime_observation": qualified_runtime_observation,
            "qualification_reason": qualification_reason,
        },
    )


def _persist_hypothesis_governance_rows(
    *,
    session: Session,
    run_id: str,
    candidate_id: str,
    candidate_spec_payload: Mapping[str, Any],
    signals: Sequence[SignalEnvelope],
    report: EvaluationReport,
    promotion_target: str,
    effective_promotion_allowed: bool,
    promotion_recommendation: PromotionRecommendation,
    simulation_calibration_report_payload: Mapping[str, Any],
    shadow_live_deviation_report_payload: Mapping[str, Any],
    now: datetime,
) -> None:
    alpha_readiness_payload = (
        cast(dict[str, Any], candidate_spec_payload.get("alpha_readiness"))
        if isinstance(candidate_spec_payload.get("alpha_readiness"), dict)
        else {}
    )
    dependency_quorum_payload = (
        cast(dict[str, Any], candidate_spec_payload.get("dependency_quorum"))
        if isinstance(candidate_spec_payload.get("dependency_quorum"), dict)
        else {}
    )
    strategy_factory_payload = (
        cast(dict[str, Any], candidate_spec_payload.get("strategy_factory"))
        if isinstance(candidate_spec_payload.get("strategy_factory"), dict)
        else {}
    )
    matched_hypothesis_values = (
        cast(list[Any], alpha_readiness_payload.get("matched_hypothesis_ids"))
        if isinstance(alpha_readiness_payload.get("matched_hypothesis_ids"), list)
        else []
    )
    matched_hypothesis_ids = [
        str(item) for item in matched_hypothesis_values if str(item).strip()
    ]
    if not matched_hypothesis_ids:
        return
    registry = load_hypothesis_registry()
    manifest_by_id = {item.hypothesis_id: item for item in registry.items}
    source_manifest_ref = str(registry.path)
    runtime_observation_payload = _runtime_observation_contract_payload(
        candidate_spec_payload
    )
    shadow_authority = contract_from_artifact_payload(
        shadow_live_deviation_report_payload
    )
    simulation_authority = contract_from_artifact_payload(
        simulation_calibration_report_payload
    )
    order_count = max(
        _metric_counter_int(shadow_live_deviation_report_payload.get("order_count")),
        _metric_counter_int(simulation_calibration_report_payload.get("order_count")),
    )
    decision_count = max(0, int(report.metrics.decision_count))
    trade_count = max(0, int(report.metrics.trade_count))
    decision_alignment_ratio = (
        Decimal(trade_count) / Decimal(decision_count)
        if decision_count > 0
        else Decimal("0")
    )
    post_cost_expectancy_bps = -_decimal_or_zero(
        simulation_calibration_report_payload.get("avg_realized_shortfall_bps")
    )
    observed_stage = "paper" if promotion_target == "paper" else "live"
    dependency_decision = _coerce_str(
        dependency_quorum_payload.get("decision"), "unknown"
    )
    drift_ok = not any(
        "drift" in str(reason) for reason in promotion_recommendation.reasons
    )
    continuity_ok = dependency_decision == "allow"
    for hypothesis_id in matched_hypothesis_ids:
        manifest = manifest_by_id.get(hypothesis_id)
        if manifest is None:
            continue
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
                    source_manifest_ref=source_manifest_ref,
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
                    source_manifest_ref=source_manifest_ref,
                    active=True,
                    payload_json=manifest.model_dump(mode="json"),
                )
            )
        (
            evidence_provenance,
            evidence_maturity,
            capital_stage,
            qualification_payload,
        ) = _resolve_hypothesis_window_evidence(
            promotion_target=promotion_target,
            runtime_observation_payload=runtime_observation_payload,
            effective_promotion_allowed=effective_promotion_allowed,
            order_count=order_count,
            min_sample_count_for_scale_up=manifest.min_sample_count_for_scale_up,
        )
        session.add(
            StrategyHypothesisMetricWindow(
                run_id=run_id,
                candidate_id=candidate_id,
                hypothesis_id=hypothesis_id,
                observed_stage=observed_stage,
                window_started_at=signals[0].event_ts if signals else now,
                window_ended_at=signals[-1].event_ts if signals else now,
                market_session_count=1,
                decision_count=decision_count,
                trade_count=trade_count,
                order_count=order_count,
                evidence_provenance=evidence_provenance,
                evidence_maturity=evidence_maturity,
                decision_alignment_ratio=str(decision_alignment_ratio),
                avg_abs_slippage_bps=str(
                    shadow_live_deviation_report_payload.get("avg_abs_slippage_bps")
                    or "0"
                ),
                slippage_budget_bps=str(manifest.max_allowed_slippage_bps),
                post_cost_expectancy_bps=str(post_cost_expectancy_bps),
                continuity_ok=continuity_ok,
                drift_ok=drift_ok,
                dependency_quorum_decision=dependency_decision,
                capital_stage=capital_stage,
                payload_json={
                    "alpha_readiness": alpha_readiness_payload,
                    "dependency_quorum": dependency_quorum_payload,
                    "strategy_factory": strategy_factory_payload,
                    "runtime_observation": dict(runtime_observation_payload),
                    "runtime_observation_qualification": qualification_payload,
                    "shadow_live_deviation": dict(shadow_live_deviation_report_payload),
                    "simulation_calibration": dict(
                        simulation_calibration_report_payload
                    ),
                    "shadow_live_authority": shadow_authority,
                    "simulation_authority": simulation_authority,
                },
            )
        )
        session.add(
            StrategyCapitalAllocation(
                run_id=run_id,
                candidate_id=candidate_id,
                hypothesis_id=hypothesis_id,
                prior_stage="shadow",
                stage=capital_stage,
                capital_multiplier={
                    "shadow": "0",
                    "0.10x canary": "0.10",
                    "0.25x canary": "0.25",
                    "0.50x live": "0.50",
                    "1.00x live": "1.00",
                }.get(capital_stage, "0"),
                rollback_target_stage="shadow",
                payload_json={
                    "effective_promotion_allowed": effective_promotion_allowed,
                    "promotion_target": promotion_target,
                    "promotion_recommendation": promotion_recommendation.to_payload(),
                    "strategy_factory": strategy_factory_payload,
                },
            )
        )
        session.add(
            StrategyPromotionDecision(
                run_id=run_id,
                candidate_id=candidate_id,
                hypothesis_id=hypothesis_id,
                promotion_target=promotion_target,
                state=capital_stage,
                allowed=effective_promotion_allowed,
                reason_summary=",".join(sorted(set(promotion_recommendation.reasons)))[
                    :255
                ]
                or None,
                payload_json={
                    "promotion_recommendation": promotion_recommendation.to_payload(),
                    "alpha_readiness": alpha_readiness_payload,
                    "dependency_quorum": dependency_quorum_payload,
                    "strategy_factory": strategy_factory_payload,
                },
            )
        )


def _persist_vnext_objects(
    *,
    session: Session,
    run_id: str,
    candidate_id: str,
    runtime_strategies: Sequence[StrategyRuntimeConfig],
    candidate_spec_payload: dict[str, Any],
    signals: Sequence[SignalEnvelope],
    walk_results: WalkForwardResults,
    report: EvaluationReport,
    promotion_target: str,
    promotion_recommendation: PromotionRecommendation,
    effective_promotion_allowed: bool,
    gate_report_trace_id: str,
    recommendation_trace_id: str,
    now: datetime,
    simulation_calibration_report_payload: dict[str, Any],
    shadow_live_deviation_report_payload: dict[str, Any],
) -> None:
    _persist_strategy_spec_lineage_trace(
        session=session,
        run_id=run_id,
        candidate_id=candidate_id,
        runtime_strategies=runtime_strategies,
        candidate_spec_payload=candidate_spec_payload,
        experiment_payload=(
            cast(dict[str, Any], candidate_spec_payload.get("experiment_spec"))
            if isinstance(candidate_spec_payload.get("experiment_spec"), dict)
            else {}
        ),
    )
    experiment_payload = (
        cast(dict[str, Any], candidate_spec_payload.get("experiment_spec"))
        if isinstance(candidate_spec_payload.get("experiment_spec"), dict)
        else {}
    )
    bridge_payload = (
        cast(dict[str, Any], candidate_spec_payload.get("bridge_persistence_v2"))
        if isinstance(candidate_spec_payload.get("bridge_persistence_v2"), dict)
        else {}
    )
    dependency_quorum_payload = (
        cast(dict[str, Any], candidate_spec_payload.get("dependency_quorum"))
        if isinstance(candidate_spec_payload.get("dependency_quorum"), dict)
        else {}
    )
    alpha_readiness_payload = (
        cast(dict[str, Any], candidate_spec_payload.get("alpha_readiness"))
        if isinstance(candidate_spec_payload.get("alpha_readiness"), dict)
        else {}
    )
    portfolio_payload = (
        cast(dict[str, Any], candidate_spec_payload.get("portfolio_promotion_v2"))
        if isinstance(candidate_spec_payload.get("portfolio_promotion_v2"), dict)
        else {}
    )
    strategy_factory_payload = (
        cast(dict[str, Any], candidate_spec_payload.get("strategy_factory"))
        if isinstance(candidate_spec_payload.get("strategy_factory"), dict)
        else {}
    )

    dataset_snapshot_ref = (
        str(
            candidate_spec_payload.get("artifacts", {}).get("walkforward_results", "")
        ).strip()
        if isinstance(candidate_spec_payload.get("artifacts"), dict)
        else ""
    )
    ordered_signals = sorted(signals, key=lambda item: item.event_ts)
    dataset_from = ordered_signals[0].event_ts if ordered_signals else None
    dataset_to = ordered_signals[-1].event_ts if ordered_signals else None
    session.add(
        VNextDatasetSnapshot(
            run_id=run_id,
            candidate_id=candidate_id,
            dataset_id=f"dataset-{run_id}",
            source="historical_market_replay",
            dataset_version=str(candidate_spec_payload.get("run_id") or run_id),
            dataset_from=dataset_from,
            dataset_to=dataset_to,
            artifact_ref=dataset_snapshot_ref or None,
            payload_json=bridge_payload.get("dataset_snapshots")
            if isinstance(bridge_payload.get("dataset_snapshots"), list)
            else candidate_spec_payload,
        )
    )

    for strategy in runtime_strategies:
        strategy_spec = dict(strategy.strategy_spec)
        if not strategy_spec:
            continue
        feature_view_spec_ref = str(
            strategy_spec.get("feature_view_spec_ref") or ""
        ).strip()
        if feature_view_spec_ref:
            session.add(
                VNextFeatureViewSpec(
                    run_id=run_id,
                    candidate_id=candidate_id,
                    strategy_id=strategy.strategy_id,
                    feature_view_spec_ref=feature_view_spec_ref,
                    payload_json=strategy_spec,
                )
            )
        artifact_ref = str(
            strategy_spec.get("model_ref")
            or strategy_spec.get("deterministic_rule_ref")
            or ""
        ).strip()
        if artifact_ref:
            session.add(
                VNextModelArtifact(
                    run_id=run_id,
                    candidate_id=candidate_id,
                    strategy_id=strategy.strategy_id,
                    artifact_ref=artifact_ref,
                    artifact_kind="model"
                    if str(strategy_spec.get("model_ref") or "").strip()
                    else "deterministic_rule",
                    payload_json={
                        "strategy_spec_v2": strategy_spec,
                        "compiled_targets": strategy.compiled_targets,
                    },
                )
            )

    if experiment_payload:
        experiment_id = str(
            experiment_payload.get("experiment_id") or f"exp-{run_id}"
        ).strip()
        session.add(
            VNextExperimentSpec(
                run_id=run_id,
                candidate_id=candidate_id,
                experiment_id=experiment_id,
                payload_json=experiment_payload,
            )
        )
        session.add(
            VNextExperimentRun(
                run_id=run_id,
                candidate_id=candidate_id,
                experiment_id=experiment_id,
                stage_lineage_root=str(
                    cast(dict[str, Any], experiment_payload.get("lineage", {})).get(
                        "stage_lineage_root", ""
                    )
                ).strip()
                or None,
                payload_json={
                    "bridge_experiment_runs": bridge_payload.get("experiment_runs"),
                    "created_at": now.isoformat(),
                },
            )
        )

    simulation_artifact_ref = (
        str(
            candidate_spec_payload.get("artifacts", {}).get(
                "simulation_calibration", ""
            )
        ).strip()
        if isinstance(candidate_spec_payload.get("artifacts"), dict)
        else ""
    )
    if simulation_artifact_ref:
        session.add(
            VNextSimulationCalibration(
                run_id=run_id,
                candidate_id=candidate_id,
                artifact_ref=simulation_artifact_ref,
                status=str(
                    simulation_calibration_report_payload.get("status") or ""
                ).strip()
                or None,
                order_count=_metric_counter_int(
                    simulation_calibration_report_payload.get("order_count")
                ),
                payload_json=simulation_calibration_report_payload,
            )
        )

    shadow_artifact_ref = (
        str(
            candidate_spec_payload.get("artifacts", {}).get("shadow_live_deviation", "")
        ).strip()
        if isinstance(candidate_spec_payload.get("artifacts"), dict)
        else ""
    )
    if shadow_artifact_ref:
        session.add(
            VNextShadowLiveDeviation(
                run_id=run_id,
                candidate_id=candidate_id,
                artifact_ref=shadow_artifact_ref,
                status=str(
                    shadow_live_deviation_report_payload.get("status") or ""
                ).strip()
                or None,
                order_count=_metric_counter_int(
                    shadow_live_deviation_report_payload.get("order_count")
                ),
                payload_json=shadow_live_deviation_report_payload,
            )
        )

    session.add(
        VNextPromotionDecision(
            run_id=run_id,
            candidate_id=candidate_id,
            promotion_target=promotion_target,
            recommended_mode=promotion_recommendation.recommended_mode,
            decision_action=promotion_recommendation.action,
            allowed=effective_promotion_allowed,
            gate_report_trace_id=gate_report_trace_id,
            recommendation_trace_id=recommendation_trace_id,
            payload_json={
                "promotion_rationale": promotion_recommendation.rationale,
                "portfolio_promotion_v2": portfolio_payload,
                "dependency_quorum": dependency_quorum_payload,
                "alpha_readiness": alpha_readiness_payload,
                "strategy_factory": strategy_factory_payload,
                "experiment_spec_ref": str(
                    experiment_payload.get("experiment_id") or ""
                ).strip()
                or None,
                "decision_count": report.metrics.decision_count,
                "trade_count": report.metrics.trade_count,
            },
        )
    )
    _persist_hypothesis_governance_rows(
        session=session,
        run_id=run_id,
        candidate_id=candidate_id,
        candidate_spec_payload=candidate_spec_payload,
        signals=signals,
        report=report,
        promotion_target=promotion_target,
        effective_promotion_allowed=effective_promotion_allowed,
        promotion_recommendation=promotion_recommendation,
        simulation_calibration_report_payload=simulation_calibration_report_payload,
        shadow_live_deviation_report_payload=shadow_live_deviation_report_payload,
        now=now,
    )


def _compute_candidate_hash(
    *,
    run_id: str,
    runtime_strategies: list[StrategyRuntimeConfig],
    gate_report: GateEvaluationReport,
    signals_path: Path,
    strategy_config_path: Path,
    gate_policy_path: Path,
    stage_lineage_payload: dict[str, Any],
    replay_artifact_hashes: dict[str, str],
) -> str:
    hasher = hashlib.sha256()
    hasher.update(signals_path.read_bytes())
    hasher.update(strategy_config_path.read_bytes())
    hasher.update(gate_policy_path.read_bytes())
    hasher.update(run_id.encode("utf-8"))
    hasher.update(str(_strategy_parameter_set(runtime_strategies)).encode("utf-8"))
    hasher.update(gate_report.recommended_mode.encode("utf-8"))
    hasher.update(str(sorted(gate_report.reasons)).encode("utf-8"))
    hasher.update(
        json.dumps(
            stage_lineage_payload,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    )
    hasher.update(
        json.dumps(
            replay_artifact_hashes,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    )
    return hasher.hexdigest()[:32]


def _build_promotion_rationale(
    *,
    gate_report: GateEvaluationReport,
    promotion_check_reasons: list[str],
    rollback_check_reasons: list[str],
    promotion_target: str,
    additional_reasons: Sequence[str] = (),
) -> str:
    if (
        gate_report.promotion_allowed
        and not promotion_check_reasons
        and not rollback_check_reasons
        and not additional_reasons
    ):
        return (
            f"all_required_gates_passed_for_{promotion_target}_promotion_"
            f"recommended_mode_{gate_report.recommended_mode}"
        )
    reasons = sorted(
        set(
            [
                *gate_report.reasons,
                *promotion_check_reasons,
                *rollback_check_reasons,
                *additional_reasons,
            ]
        )
    )
    if not reasons:
        return f"promotion_target_{promotion_target}_held_without_additional_reasons"
    return f"promotion_blocked_or_held:{','.join(reasons)}"


def _trace_id(payload: object) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:24]


def _compute_no_signal_feature_spec_hash(
    *,
    strategy_config_path: Path,
    gate_policy_path: Path,
    reason: str,
    query_start: datetime,
    query_end: datetime,
) -> str:
    hasher = hashlib.sha256()
    hasher.update(reason.encode("utf-8"))
    hasher.update(strategy_config_path.read_bytes())
    hasher.update(gate_policy_path.read_bytes())
    hasher.update(str(query_start).encode("utf-8"))
    hasher.update(str(query_end).encode("utf-8"))
    return hasher.hexdigest()[:128]


def _compute_no_signal_dataset_version_hash(
    *,
    query_start: datetime,
    query_end: datetime,
    no_signal_reason: str,
) -> str:
    hasher = hashlib.sha256()
    hasher.update(str(query_start).encode("utf-8"))
    hasher.update(str(query_end).encode("utf-8"))
    hasher.update(no_signal_reason.encode("utf-8"))
    return hasher.hexdigest()[:64]


def _compute_feature_spec_hash(
    *,
    strategy_config_path: Path,
    gate_policy_path: Path,
    signals_path: Path,
) -> str:
    hasher = hashlib.sha256()
    hasher.update(strategy_config_path.read_bytes())
    hasher.update(gate_policy_path.read_bytes())
    hasher.update(signals_path.read_bytes())
    return hasher.hexdigest()[:128]


def _compute_dataset_version_hash(*, signals_path: Path) -> str:
    hasher = hashlib.sha256()
    try:
        payload = json.loads(signals_path.read_text(encoding="utf-8"))
    except Exception:
        payload = []
    payload_json = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    hasher.update(payload_json.encode("utf-8"))
    return hasher.hexdigest()[:64]


def _strategy_parameter_set(
    runtime_strategies: list[StrategyRuntimeConfig],
) -> list[dict[str, Any]]:
    return [
        {
            "strategy_id": strategy.strategy_id,
            "strategy_type": strategy.strategy_type,
            "version": strategy.version,
            "priority": strategy.priority,
            "base_timeframe": strategy.base_timeframe,
            "enabled": strategy.enabled,
            "params": strategy.params,
        }
        for strategy in sorted(
            runtime_strategies, key=lambda item: (item.priority, item.strategy_id)
        )
    ]


def _strategy_universe_definition(
    runtime_strategies: list[StrategyRuntimeConfig],
    *,
    lifecycle_payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not runtime_strategies:
        return {
            "autonomy_lifecycle": lifecycle_payload or {},
        }
    payload: dict[str, Any] = {
        "strategies": [
            {
                "strategy_id": item.strategy_id,
                "strategy_type": item.strategy_type,
                "universe_type": _strategy_universe_type(item.strategy_type),
            }
            for item in runtime_strategies
        ],
        "count": len(runtime_strategies),
    }
    payload["autonomy_lifecycle"] = lifecycle_payload or {}
    return payload


def _metric_counter_int(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    return 0


def _build_stress_bundle(report: EvaluationReport, stress_case: str) -> dict[str, Any]:
    return {
        "case": stress_case,
        "max_drawdown": str(report.metrics.max_drawdown),
        "cost_bps": str(report.metrics.cost_bps),
        "turnover_ratio": str(report.metrics.turnover_ratio),
        "net_pnl": str(report.metrics.net_pnl),
        "gross_pnl": str(report.metrics.gross_pnl),
        "decision_count": report.metrics.decision_count,
        "trade_count": report.metrics.trade_count,
    }


def load_runtime_strategy_config(path: Path) -> list[StrategyRuntimeConfig]:
    raw = path.read_text(encoding="utf-8")
    if path.suffix.lower() in {".yaml", ".yml"}:
        payload_raw: object = yaml.safe_load(raw)
    else:
        payload_raw = json.loads(raw)

    if isinstance(payload_raw, Mapping):
        payload_mapping = cast(Mapping[str, Any], payload_raw)
        payload: object = payload_mapping.get("strategies", payload_raw)
    else:
        payload = payload_raw
    if not isinstance(payload, list):
        raise ValueError("strategy config must be a list or include strategies key")

    strategies: list[StrategyRuntimeConfig] = []
    for index, item_raw in enumerate(cast(list[object], payload)):
        if not isinstance(item_raw, Mapping):
            raise ValueError(f"invalid strategy entry at index {index}")
        item = cast(Mapping[str, Any], item_raw)
        strategy_id = str(
            item.get("strategy_id") or item.get("name") or f"strategy-{index + 1}"
        )
        strategy_spec_raw = item.get("strategy_spec_v2")
        if isinstance(strategy_spec_raw, Mapping):
            strategy_spec = load_strategy_spec_v2_payload(
                dict(cast(Mapping[str, Any], strategy_spec_raw))
            )
            strategy_params_raw = item.get("params", {})
            if isinstance(strategy_params_raw, Mapping) and strategy_params_raw:
                strategy_spec_payload = strategy_spec.to_payload()
                strategy_spec_payload["runtime_parameters"] = {
                    **dict(strategy_spec.runtime_parameters),
                    **dict(cast(Mapping[str, Any], strategy_params_raw)),
                }
                strategy_spec = load_strategy_spec_v2_payload(strategy_spec_payload)
            compiled = compile_strategy_spec_v2(strategy_spec)
            strategies.append(
                StrategyRuntimeConfig(
                    strategy_id=strategy_spec.strategy_id or strategy_id,
                    strategy_type=str(
                        compiled.shadow_runtime_config.get(
                            "strategy_type", "legacy_macd_rsi"
                        )
                    ),
                    version=str(compiled.shadow_runtime_config.get("version", "1.0.0")),
                    params=cast(
                        dict[str, Any], compiled.shadow_runtime_config.get("params", {})
                    )
                    if isinstance(
                        compiled.shadow_runtime_config.get("params", {}), dict
                    )
                    else {},
                    base_timeframe=str(
                        compiled.shadow_runtime_config.get("base_timeframe", "1Min")
                    ),
                    enabled=bool(item.get("enabled", True)),
                    priority=int(item.get("priority", 100)),
                    compiler_source="spec_v2",
                    strategy_spec=compiled.strategy_spec.to_payload(),
                    compiled_targets={
                        "evaluator_config": compiled.evaluator_config,
                        "shadow_runtime_config": compiled.shadow_runtime_config,
                        "live_runtime_config": compiled.live_runtime_config,
                        "promotion_metadata": compiled.promotion_metadata,
                    },
                )
            )
            continue

        strategy_type = str(item.get("strategy_type", "legacy_macd_rsi"))
        version = str(item.get("version", "1.0.0"))
        params_raw = item.get("params")
        if params_raw is None:
            params = {
                "buy_rsi_threshold": item.get("buy_rsi_threshold", 35),
                "sell_rsi_threshold": item.get("sell_rsi_threshold", 65),
                "qty": item.get("qty", 1),
            }
        elif isinstance(params_raw, Mapping):
            params = dict(cast(Mapping[str, Any], params_raw))
        else:
            raise ValueError(f"params for strategy {strategy_id} must be an object")
        config = StrategyRuntimeConfig(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            version=version,
            params=params,
            base_timeframe=str(item.get("base_timeframe", "1Min")),
            enabled=bool(item.get("enabled", True)),
            priority=int(item.get("priority", 100)),
        )
        if strategy_type_supports_spec_v2(strategy_type):
            config = compile_runtime_config(config)
        strategies.append(config)

    return sorted(strategies, key=lambda item: (item.priority, item.strategy_id))


def _load_signals(path: Path) -> list[SignalEnvelope]:
    payload: object = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise ValueError("signals payload must be a list")
    signals = [
        SignalEnvelope.model_validate(item) for item in cast(list[object], payload)
    ]
    return sorted(signals, key=lambda item: (item.event_ts, item.symbol, item.seq or 0))


def _deterministic_run_id(
    signals_path: Path,
    strategy_config_path: Path,
    gate_policy_path: Path,
    promotion_target: PromotionTarget,
    alpha_train_prices_path: Path | None = None,
    alpha_test_prices_path: Path | None = None,
    alpha_gate_policy_path: Path | None = None,
) -> str:
    hasher = hashlib.sha256()
    hasher.update(signals_path.read_bytes())
    hasher.update(strategy_config_path.read_bytes())
    hasher.update(gate_policy_path.read_bytes())
    hasher.update(promotion_target.encode("utf-8"))
    for optional_path in (
        alpha_train_prices_path,
        alpha_test_prices_path,
        alpha_gate_policy_path,
    ):
        if optional_path is None:
            hasher.update(b"\x00")
            continue
        hasher.update(optional_path.read_bytes())
    return hasher.hexdigest()[:24]


def _required_feature_null_rate(signals: list[SignalEnvelope]) -> Decimal:
    required_keys = ("macd", "rsi", "price")
    missing = 0
    total = 0
    for signal in signals:
        payload = dict(signal.payload or {})
        for key in required_keys:
            total += 1
            if key == "macd":
                macd_block = payload.get("macd")
                macd_payload: dict[str, Any] = (
                    dict(cast(Mapping[str, Any], macd_block))
                    if isinstance(macd_block, Mapping)
                    else {}
                )
                if (
                    not macd_payload
                    or macd_payload.get("macd") is None
                    or macd_payload.get("signal") is None
                ):
                    missing += 1
            elif key == "rsi":
                if extract_rsi(payload) is None:
                    missing += 1
            elif key == "price":
                if extract_price(payload) is None:
                    missing += 1
            else:
                missing += 1
    if total == 0:
        return Decimal("1")
    return Decimal(missing) / Decimal(total)


def _coerce_fragility_state(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    if normalized in {"normal", "elevated", "stress", "crisis"}:
        return normalized
    return None


def _fragility_state_rank(state: str) -> int:
    normalized = state.strip().lower()
    if normalized == "normal":
        return 0
    if normalized == "elevated":
        return 1
    if normalized == "stress":
        return 2
    return 3


def _coerce_fragility_bool(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float, Decimal)):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off", ""}:
            return False
    return None


def _coerce_fragility_score(value: object) -> Decimal | None:
    try:
        parsed = Decimal(str(value))
    except (ArithmeticError, TypeError, ValueError):
        return None
    if not parsed.is_finite():
        return None
    return parsed


def _coerce_fragility_measurement(
    payload: dict[str, object],
) -> tuple[str, Decimal, bool] | None:
    state = _coerce_fragility_state(payload.get("fragility_state"))
    score = _coerce_fragility_score(payload.get("fragility_score"))
    stability = _coerce_fragility_bool(payload.get("stability_mode_active"))
    if state is None or score is None or stability is None:
        return None
    return (state, score, stability)


def _is_more_worse_fragility(
    candidate: tuple[str, Decimal, bool], current: tuple[str, Decimal, bool]
) -> bool:
    candidate_rank = _fragility_state_rank(candidate[0])
    current_rank = _fragility_state_rank(current[0])
    if candidate_rank != current_rank:
        return candidate_rank > current_rank
    if candidate[1] != current[1]:
        return candidate[1] > current[1]
    return not candidate[2] and current[2]


def _resolve_gate_fragility_inputs(
    *,
    metrics_payload: dict[str, object],
    decisions: list[WalkForwardDecision],
) -> tuple[str, Decimal, bool, bool]:
    fallback_measurement = _coerce_fragility_measurement(
        {
            "fragility_state": metrics_payload.get("fragility_state"),
            "fragility_score": metrics_payload.get("fragility_score"),
            "stability_mode_active": metrics_payload.get("stability_mode_active"),
        }
    )
    selected_measurement: tuple[str, Decimal, bool] | None = None

    for item in decisions:
        params = item.decision.params
        allocator_payload = params.get("allocator")
        allocator: dict[str, Any] = (
            dict(cast(Mapping[str, Any], allocator_payload))
            if isinstance(allocator_payload, Mapping)
            else {}
        )
        snapshot_payload = params.get("fragility_snapshot")
        snapshot: dict[str, Any] = (
            dict(cast(Mapping[str, Any], snapshot_payload))
            if isinstance(snapshot_payload, Mapping)
            else {}
        )

        raw_state = allocator.get("fragility_state")
        if raw_state is None:
            raw_state = snapshot.get("fragility_state")
        if raw_state is None:
            raw_state = params.get("fragility_state")

        raw_score = allocator.get("fragility_score")
        if raw_score is None:
            raw_score = snapshot.get("fragility_score")
        if raw_score is None:
            raw_score = params.get("fragility_score")

        raw_stability = allocator.get("stability_mode_active")
        if raw_stability is None:
            raw_stability = params.get("stability_mode_active")

        candidate = _coerce_fragility_measurement(
            {
                "fragility_state": raw_state,
                "fragility_score": raw_score,
                "stability_mode_active": raw_stability,
            }
        )
        if candidate is None:
            continue

        if selected_measurement is None or _is_more_worse_fragility(
            candidate, selected_measurement
        ):
            selected_measurement = candidate

    if selected_measurement is None:
        if fallback_measurement is None:
            return ("crisis", Decimal("1"), False, False)
        selected_measurement = fallback_measurement

    selected_state, selected_score, selected_stability = selected_measurement
    return selected_state, selected_score, selected_stability, True


def _resolve_gate_forecast_metrics(
    *,
    signals: list[SignalEnvelope],
) -> dict[str, str]:
    if not signals or not settings.trading_forecast_router_enabled:
        return {}

    try:
        router = build_default_forecast_router(
            policy_path=settings.trading_forecast_router_policy_path,
            refinement_enabled=settings.trading_forecast_router_refinement_enabled,
        )
    except Exception:
        return {}

    fallback_total = 0
    latency_samples_ms: list[int] = []
    calibration_scores: list[Decimal] = []

    for signal in signals:
        try:
            feature_vector = normalize_feature_vector_v3(signal)
        except FeatureNormalizationError:
            return {}

        try:
            route_result = router.route_and_forecast(
                feature_vector=feature_vector,
                horizon=signal.timeframe or "1Min",
                event_ts=signal.event_ts,
            )
        except Exception:
            return {}

        contract_payload = route_result.contract.to_payload()
        authority = contract_from_artifact_payload(contract_payload)
        if (
            not authority
            or not bool(authority.get("authoritative", False))
            or bool(authority.get("placeholder", False))
            or not bool(route_result.contract.promotion_authority_eligible)
        ):
            return {}

        if route_result.contract.fallback.applied:
            fallback_total += 1
        latency_samples_ms.append(route_result.contract.inference_latency_ms)
        calibration_scores.append(route_result.contract.calibration_score)

    expected_samples = len(signals)
    if (
        len(latency_samples_ms) != expected_samples
        or len(calibration_scores) != expected_samples
    ):
        return {}

    fallback_rate = (Decimal(fallback_total) / Decimal(expected_samples)).quantize(
        Decimal("0.0001")
    )
    calibration_score_min = min(calibration_scores).quantize(Decimal("0.0001"))
    latency_ms_p95 = _nearest_rank_percentile(latency_samples_ms, 95)

    return {
        "fallback_rate": str(fallback_rate),
        "inference_latency_ms_p95": str(latency_ms_p95),
        "calibration_score_min": str(calibration_score_min),
    }


def _resolve_gate_staleness_ms_p95(
    *,
    signals: list[SignalEnvelope],
) -> int | None:
    if not signals:
        return None
    staleness_values_ms: list[int] = []
    for signal in signals:
        if signal.ingest_ts is None:
            return None
        event_ts = signal.event_ts.astimezone(timezone.utc)
        ingest_ts = signal.ingest_ts.astimezone(timezone.utc)
        age_ms = int((ingest_ts - event_ts).total_seconds() * 1000)
        if age_ms < 0:
            age_ms = 0
        staleness_values_ms.append(age_ms)
    return _nearest_rank_percentile(staleness_values_ms, 95)


def _to_finite_float(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float, Decimal)):
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return None
    elif isinstance(value, str):
        value = value.strip()
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return None
    else:
        return None
    if not math.isfinite(parsed):
        return None
    return parsed


def _resolve_gate_llm_metrics(
    *,
    session_factory: Callable[[], Session],
    now: datetime,
) -> dict[str, str]:
    try:
        with session_factory() as session:
            payload = build_llm_evaluation_metrics(session=session, now=now)
            metrics_payload = payload.get("metrics")
            if not isinstance(metrics_payload, dict):
                return {}
            metrics = cast(Mapping[str, Any], metrics_payload)
            error_rate = _to_finite_float(metrics.get("error_rate"))
            if error_rate is None or error_rate < 0 or error_rate > 1:
                return {}
            return {"error_ratio": str(Decimal(str(error_rate)))}
    except Exception:
        return {}


def _nearest_rank_percentile(values: list[int], percentile: int) -> int:
    if not values:
        return 0
    bounded = max(1, min(100, percentile))
    ordered = sorted(values)
    index = ((len(ordered) * bounded) + 99) // 100 - 1
    if index < 0:
        index = 0
    return ordered[index]


def _load_tca_gate_inputs(
    session_factory: Callable[[], Session],
) -> dict[str, object]:
    try:
        with session_factory() as session:
            return build_tca_gate_inputs(session)
    except Exception:
        return {
            "order_count": 0,
            "avg_slippage_bps": Decimal("0"),
            "avg_abs_slippage_bps": Decimal("0"),
            "avg_shortfall_notional": Decimal("0"),
            "avg_shortfall_notional_abs": Decimal("0"),
            "avg_churn_ratio": Decimal("0"),
            "avg_divergence_bps": Decimal("0"),
            "avg_divergence_bps_abs": Decimal("0"),
            "avg_realized_shortfall_bps": Decimal("0"),
            "avg_realized_shortfall_bps_abs": Decimal("0"),
            "avg_calibration_error_bps": Decimal("0"),
            "expected_shortfall_coverage": Decimal("0"),
            "expected_shortfall_sample_count": 0,
            "avg_expected_shortfall_bps_p50": Decimal("0"),
            "avg_expected_shortfall_bps_p95": Decimal("0"),
        }


def _baseline_runtime_strategies() -> list[StrategyRuntimeConfig]:
    return [
        StrategyRuntimeConfig(
            strategy_id="baseline-legacy-macd-rsi",
            strategy_type="legacy_macd_rsi",
            version="1.0.0",
            params={"buy_rsi_threshold": 35, "sell_rsi_threshold": 65, "qty": 1},
            base_timeframe="1Min",
            enabled=True,
            priority=0,
        )
    ]


def _profitability_threshold_payload(
    policy_payload: dict[str, Any],
) -> dict[str, object]:
    return {
        "min_market_net_pnl_delta": str(
            policy_payload.get("gate6_min_market_net_pnl_delta", "0")
        ),
        "min_risk_adjusted_return_over_drawdown": str(
            policy_payload.get("gate6_min_return_over_drawdown", "0")
        ),
        "min_regime_slice_pass_ratio": str(
            policy_payload.get("gate6_min_regime_slice_pass_ratio", "0.50")
        ),
        "max_cost_bps": str(policy_payload.get("gate6_max_cost_bps", "35")),
        "max_calibration_error": str(
            policy_payload.get("gate6_max_calibration_error", "0.45")
        ),
        "min_confidence_samples": int(
            policy_payload.get("gate6_min_confidence_samples", 1)
        ),
        "min_reproducibility_hashes": int(
            policy_payload.get("gate6_min_reproducibility_hashes", 5)
        ),
    }


def _collect_confidence_values(decisions: list[WalkForwardDecision]) -> list[Decimal]:
    values: list[Decimal] = []
    for item in decisions:
        raw_value = item.decision.params.get("confidence")
        if raw_value is None:
            runtime_payload = item.decision.params.get("runtime")
            if isinstance(runtime_payload, Mapping):
                raw_value = cast(Mapping[str, Any], runtime_payload).get("confidence")
        if raw_value is None:
            continue
        try:
            values.append(Decimal(str(raw_value)))
        except (ArithmeticError, TypeError, ValueError):
            continue
    return values


def _to_orm_strategies(
    runtime_strategies: list[StrategyRuntimeConfig],
) -> list[Strategy]:
    strategies: list[Strategy] = []
    for item in runtime_strategies:
        strategies.append(
            Strategy(
                name=item.strategy_id,
                description=f"{item.strategy_type}@{item.version}",
                enabled=item.enabled,
                base_timeframe=item.base_timeframe,
                universe_type=_strategy_universe_type(item.strategy_type),
                universe_symbols=None,
                max_position_pct_equity=None,
                max_notional_per_trade=None,
            )
        )
    return strategies


def _strategy_universe_type(strategy_type: str) -> str:
    normalized = strategy_type.strip().lower()
    if normalized in {"static", "legacy_macd_rsi"}:
        return "static"
    if normalized in {"intraday_tsmom", "intraday_tsmom_v1", "tsmom_intraday"}:
        return "intraday_tsmom_v1"
    return strategy_type


def _evaluate_drift_promotion_gate(
    *,
    promotion_target: PromotionTarget,
    drift_promotion_evidence: dict[str, Any] | None,
) -> dict[str, Any]:
    evidence = drift_promotion_evidence or {}
    artifact_refs_raw = evidence.get("evidence_artifact_refs")
    artifact_refs = (
        [
            str(item)
            for item in cast(list[object], artifact_refs_raw)
            if str(item).strip()
        ]
        if isinstance(artifact_refs_raw, list)
        else []
    )
    if promotion_target != "live":
        return {
            "allowed": True,
            "reasons": [],
            "eligible_for_live_promotion": bool(
                evidence.get("eligible_for_live_promotion", False)
            ),
            "artifact_refs": sorted(set(artifact_refs)),
        }

    if not evidence:
        return {
            "allowed": False,
            "reasons": ["drift_promotion_evidence_missing"],
            "eligible_for_live_promotion": False,
            "artifact_refs": [],
        }

    reasons_raw = evidence.get("reasons")
    reasons = (
        [str(item) for item in cast(list[object], reasons_raw) if str(item).strip()]
        if isinstance(reasons_raw, list)
        else []
    )
    eligible = bool(evidence.get("eligible_for_live_promotion", False))
    if not eligible:
        if not reasons:
            reasons.append("drift_promotion_evidence_not_eligible")
        return {
            "allowed": False,
            "reasons": sorted(set(reasons)),
            "eligible_for_live_promotion": False,
            "artifact_refs": sorted(set(artifact_refs)),
        }
    return {
        "allowed": True,
        "reasons": [],
        "eligible_for_live_promotion": True,
        "artifact_refs": sorted(set(artifact_refs)),
    }


def _write_paper_candidate_patch(
    *,
    configmap_path: Path,
    runtime_strategies: list[StrategyRuntimeConfig],
    candidate_id: str,
    output_path: Path,
) -> Path:
    configmap_payload_raw: object = yaml.safe_load(
        configmap_path.read_text(encoding="utf-8")
    )
    if not isinstance(configmap_payload_raw, Mapping):
        raise ValueError("invalid configmap payload")
    configmap_payload = cast(Mapping[str, Any], configmap_payload_raw)

    candidate_strategies: list[dict[str, Any]] = []
    for strategy in runtime_strategies:
        if not strategy.enabled:
            continue
        candidate_strategies.append(
            {
                "name": strategy.strategy_id,
                "description": f"Autonomous candidate {candidate_id} ({strategy.strategy_type}@{strategy.version})",
                "enabled": True,
                "base_timeframe": strategy.base_timeframe,
                "universe_type": _strategy_universe_type(strategy.strategy_type),
                "max_notional_per_trade": 250,
                "max_position_pct_equity": 0.025,
            }
        )

    candidate_strategies.sort(key=lambda item: str(item["name"]))

    metadata_raw = configmap_payload.get("metadata", {})
    metadata: dict[str, Any] = (
        dict(cast(Mapping[str, Any], metadata_raw))
        if isinstance(metadata_raw, Mapping)
        else {}
    )
    patch_payload: dict[str, Any] = {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {
            "name": metadata.get("name", "torghut-strategy-config"),
            "namespace": metadata.get("namespace", "torghut"),
            "annotations": {
                "torghut.proompteng.ai/candidate-id": candidate_id,
                "torghut.proompteng.ai/recommended-mode": "paper",
            },
        },
        "data": {
            "strategies.yaml": yaml.safe_dump(
                {"strategies": candidate_strategies}, sort_keys=False
            ),
        },
    }
    output_path.write_text(
        yaml.safe_dump(patch_payload, sort_keys=False), encoding="utf-8"
    )
    return output_path


__all__ = [
    "annotations",
    "hashlib",
    "json",
    "math",
    "re",
    "dataclass",
    "field",
    "datetime",
    "timezone",
    "Decimal",
    "Path",
    "Any",
    "Callable",
    "Mapping",
    "Sequence",
    "cast",
    "delete",
    "select",
    "Session",
    "pd",
    "yaml",
    "settings",
    "SessionLocal",
    "ResearchAttempt",
    "ResearchCandidate",
    "ResearchCostCalibration",
    "ResearchFoldMetrics",
    "ResearchPromotion",
    "ResearchRun",
    "ResearchSequentialTrial",
    "ResearchStressMetrics",
    "ResearchValidationTest",
    "StrategyCapitalAllocation",
    "StrategyHypothesis",
    "StrategyHypothesisMetricWindow",
    "StrategyHypothesisVersion",
    "StrategyPromotionDecision",
    "Strategy",
    "VNextDatasetSnapshot",
    "VNextExperimentRun",
    "VNextExperimentSpec",
    "VNextFeatureViewSpec",
    "VNextModelArtifact",
    "VNextPromotionDecision",
    "VNextShadowLiveDeviation",
    "VNextSimulationCalibration",
    "AlphaLaneResult",
    "run_alpha_discovery_lane",
    "build_completion_trace",
    "persist_completion_trace",
    "FoldResult",
    "ProfitabilityEvidenceThresholdsV4",
    "WalkForwardDecision",
    "WalkForwardFold",
    "WalkForwardResults",
    "build_profitability_evidence_v4",
    "build_shadow_live_deviation_report_v1",
    "build_simulation_calibration_report_v1",
    "execute_profitability_benchmark_v4",
    "validate_profitability_evidence_v4",
    "write_walk_forward_results",
    "ArtifactProvenance",
    "EvidenceMaturity",
    "contract_from_artifact_payload",
    "evidence_contract_payload",
    "FeatureNormalizationError",
    "extract_price",
    "extract_rsi",
    "extract_signal_features",
    "normalize_feature_vector_v3",
    "build_default_forecast_router",
    "hypothesis_registry_requires_dependency_capability",
    "load_hypothesis_registry",
    "resolve_hypothesis_dependency_quorum",
    "build_llm_evaluation_metrics",
    "SignalEnvelope",
    "build_advisor_fallback_slo_report",
    "build_benchmark_parity_report",
    "build_deeplob_bdlob_report",
    "build_foundation_router_parity_report",
    "write_advisor_fallback_slo_report",
    "write_benchmark_parity_report",
    "write_deeplob_bdlob_report",
    "write_foundation_router_parity_report",
    "HMM_UNKNOWN_REGIME_ID",
    "resolve_hmm_context",
    "EvaluationReport",
    "EvaluationReportConfig",
    "PromotionRecommendation",
    "build_promotion_recommendation",
    "generate_evaluation_report",
    "write_evaluation_report",
    "build_compiled_strategy_artifacts",
    "build_experiment_spec_from_strategy",
    "compile_strategy_spec_v2",
    "load_strategy_spec_v2_payload",
    "strategy_type_supports_spec_v2",
    "build_tca_gate_inputs",
    "GateEvaluationReport",
    "GateInputs",
    "GatePolicyMatrix",
    "PromotionTarget",
    "evaluate_gate_matrix",
    "build_janus_event_car_artifact_v1",
    "build_janus_hgrm_reward_artifact_v1",
    "build_janus_q_evidence_summary_v1",
    "RollbackReadinessResult",
    "evaluate_promotion_prerequisites",
    "evaluate_rollback_readiness",
    "StrategyRuntime",
    "StrategyRuntimeConfig",
    "compile_runtime_config",
    "default_runtime_registry",
    "AUTONOMY_PHASE_ORDER",
    "coerce_phase_status",
    "normalize_phase_transitions",
    "_AUTONOMY_PHASE_ORDER",
    "_ACTUATION_INTENT_SCHEMA_VERSION",
    "_ACTUATION_CONFIRMATION_PHRASE",
    "_ACTUATION_INTENT_PATH",
    "_AUTONOMY_LANE_SCHEMA_VERSION",
    "_PROFITABILITY_STAGE_MANIFEST_SCHEMA_VERSION",
    "_PROFITABILITY_STAGE_MANIFEST_PATH",
    "_STAGE_CANDIDATE_GENERATION",
    "_STAGE_EVALUATION",
    "_STAGE_RECOMMENDATION",
    "_STRESS_METRICS_ARTIFACT_PATH",
    "_CONTAMINATION_REGISTRY_ARTIFACT_PATH",
    "_HMM_STATE_POSTERIOR_ARTIFACT_PATH",
    "_EXPERT_ROUTER_REGISTRY_ARTIFACT_PATH",
    "_FOLD_METRICS_ARTIFACT_PATH",
    "_STRESS_METRICS_CASES",
    "_BENCHMARK_PARITY_REPORT_PATH",
    "_FOUNDATION_ROUTER_PARITY_REPORT_PATH",
    "_DEEPLOB_BDLOB_REPORT_PATH",
    "_ADVISOR_FALLBACK_SLO_REPORT_PATH",
    "_STAGE_PROFITABILITY",
    "_V6_08_GOVERNING_DESIGN_DOC",
    "_StageManifestRecord",
    "_coerce_evidence_bool",
    "_normalize_strategy_artifacts",
    "_is_runbook_valid",
    "_build_candidate_state_payload",
    "_build_candidate_alpha_readiness_payload",
    "AutonomousLaneResult",
    "_StrategyFactoryBridge",
    "_load_price_frame",
    "_build_strategy_factory_bridge",
    "_strategy_factory_gate_summary",
    "_strategy_factory_artifact_refs",
    "upsert_autonomy_no_signal_run",
    "_ensure_utc",
    "_safe_int",
    "_as_object_dict",
    "_stable_hash",
    "_artifact_hashes",
    "_readable_notes_iteration_number",
    "_write_stage_manifest",
    "_build_stage_lineage_payload",
    "_manifest_relative_path",
    "_artifact_authority_for_check",
    "_artifact_authority_for_evidence",
    "_empirical_artifact_authority",
    "_resolve_optional_service_path",
    "_load_configured_empirical_payload",
    "_build_janus_q_summary_from_payloads",
    "_build_bridge_evidence_payload",
    "_build_vnext_gate_summary",
    "_build_portfolio_promotion_summary",
    "_manifest_artifact_payload",
    "_load_json_if_exists",
    "_build_contamination_registry_payload",
    "_normalize_hmm_regime_id",
    "_build_hmm_state_posterior_payload",
    "_decimal_or_zero",
    "_decimal_or_none",
    "_normalize_expert_weights",
    "_build_expert_router_weights",
    "_build_expert_router_registry_payload",
    "_build_profitability_stage_manifest",
    "_write_iteration_notes",
    "_extract_janus_q_metrics",
    "run_autonomous_lane",
    "_prepare_lane_output_dirs",
    "_normalize_governance_inputs",
    "_coalesce_governance_context",
    "_build_phase_manifest",
    "_coerce_str",
    "_coerce_int",
    "_coerce_path_strings",
    "_coerce_gate_phase_gates",
    "_build_actuation_intent_payload",
    "_collect_walk_decisions_for_runtime",
    "_resolve_confidence_calibration",
    "_resolve_paper_patch_path",
    "_persist_run_outputs_if_requested",
    "_mark_run_passed_if_requested",
    "_mark_run_failed_if_requested",
    "_upsert_research_run",
    "_mark_run_failed",
    "_mark_run_passed",
    "_persist_run_outputs",
    "_persist_strategy_spec_lineage_trace",
    "_runtime_observation_contract_payload",
    "_runtime_observation_has_ledger_profit_proof",
    "_resolve_hypothesis_window_evidence",
    "_persist_hypothesis_governance_rows",
    "_persist_vnext_objects",
    "_compute_candidate_hash",
    "_build_promotion_rationale",
    "_trace_id",
    "_compute_no_signal_feature_spec_hash",
    "_compute_no_signal_dataset_version_hash",
    "_compute_feature_spec_hash",
    "_compute_dataset_version_hash",
    "_strategy_parameter_set",
    "_strategy_universe_definition",
    "_metric_counter_int",
    "_build_stress_bundle",
    "load_runtime_strategy_config",
    "_load_signals",
    "_deterministic_run_id",
    "_required_feature_null_rate",
    "_coerce_fragility_state",
    "_fragility_state_rank",
    "_coerce_fragility_bool",
    "_coerce_fragility_score",
    "_coerce_fragility_measurement",
    "_is_more_worse_fragility",
    "_resolve_gate_fragility_inputs",
    "_resolve_gate_forecast_metrics",
    "_resolve_gate_staleness_ms_p95",
    "_to_finite_float",
    "_resolve_gate_llm_metrics",
    "_nearest_rank_percentile",
    "_load_tca_gate_inputs",
    "_baseline_runtime_strategies",
    "_sha256_path",
    "_profitability_threshold_payload",
    "_collect_confidence_values",
    "_default_strategy_configmap_path",
    "_to_orm_strategies",
    "_strategy_universe_type",
    "_evaluate_drift_promotion_gate",
    "_write_paper_candidate_patch",
]
