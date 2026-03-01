"""Deterministic autonomous lane: research -> gate evaluation -> paper candidate patch."""
# pyright: reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence, cast

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

import yaml

from ...config import settings
from ...db import SessionLocal
from ...models import (
    ResearchCandidate,
    ResearchFoldMetrics,
    ResearchPromotion,
    ResearchRun,
    ResearchStressMetrics,
    Strategy,
)
from ..evaluation import (
    FoldResult,
    ProfitabilityEvidenceThresholdsV4,
    WalkForwardDecision,
    WalkForwardFold,
    WalkForwardResults,
    build_profitability_evidence_v4,
    execute_profitability_benchmark_v4,
    validate_profitability_evidence_v4,
    write_walk_forward_results,
)
from ..features import (
    FeatureNormalizationError,
    extract_price,
    extract_rsi,
    extract_signal_features,
    normalize_feature_vector_v3,
)
from ..forecasting import build_default_forecast_router
from ..llm.evaluation import build_llm_evaluation_metrics
from ..models import SignalEnvelope
from ..reporting import (
    EvaluationReport,
    EvaluationReportConfig,
    PromotionRecommendation,
    build_promotion_recommendation,
    generate_evaluation_report,
    write_evaluation_report,
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
from .policy_checks import evaluate_promotion_prerequisites, evaluate_rollback_readiness
from .runtime import StrategyRuntime, StrategyRuntimeConfig, default_runtime_registry
from .phase_manifest_contract import (
    AUTONOMY_PHASE_ORDER,
    AUTONOMY_PHASE_SLO_GATES,
    build_ordered_phase_summaries,
    coerce_phase_status,
    normalize_phase_transitions,
)


_ACTUATION_INTENT_SCHEMA_VERSION = "torghut.autonomy.actuation-intent.v1"
_ACTUATION_CONFIRMATION_PHRASE = "ACTUATE_TORGHUT"
_ACTUATION_INTENT_PATH = "gates/actuation-intent.json"
_AUTONOMY_PHASE_MANIFEST_SCHEMA_VERSION = "torghut.autonomy.phase-manifest.v1"
_AUTONOMY_PHASE_MANIFEST_PATH = "phase-manifest.json"
_AUTONOMY_NOTES_DIR = "notes"
_AUTONOMY_NOTES_PREFIX = "iteration-"
_AUTONOMY_NOTE_PREFIX_PATTERN = re.compile(r"^iteration-(\d+)\.md$")
_AUTONOMY_PHASE_ORDER: tuple[str, ...] = AUTONOMY_PHASE_ORDER


def _stable_hash(payload: object) -> str:
    payload_json = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload_json.encode("utf-8")).hexdigest()


def _artifact_hashes(artifacts: Mapping[str, Path | None]) -> dict[str, str]:
    hashes: dict[str, str] = {}
    for key, artifact_path in artifacts.items():
        if artifact_path is None:
            continue
        if not artifact_path.exists():
            continue
        hashes[key] = _sha256_path(artifact_path)
    return hashes


def _as_mapping(value: object) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return cast(dict[str, Any], dict(value))


def _readable_iteration_number(notes_dir: Path) -> int:
    iteration = 0
    for item in notes_dir.glob(f"{_AUTONOMY_NOTES_PREFIX}*.md"):
        match = _AUTONOMY_NOTE_PREFIX_PATTERN.match(item.name)
        if not match:
            continue
        try:
            raw = int(match.group(1))
        except (TypeError, ValueError):
            continue
        if raw > iteration:
            iteration = raw
    return iteration + 1


@dataclass(frozen=True)
class AutonomousLaneResult:
    run_id: str
    candidate_id: str
    output_dir: Path
    gate_report_path: Path
    actuation_intent_path: Path | None
    paper_patch_path: Path | None
    phase_manifest_path: Path
    gate_report_trace_id: str
    recommendation_trace_id: str


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


def _ensure_utc(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _safe_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _as_object_dict(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        return {}
    return {str(key): item for key, item in value.items()}


def _extract_janus_q_metrics(summary: dict[str, object]) -> tuple[int, int, bool, list[str]]:
    event_car = _as_object_dict(summary.get("event_car"))
    hgrm_reward = _as_object_dict(summary.get("hgrm_reward"))
    reasons_raw = summary.get("reasons")
    reasons: list[str] = []
    if isinstance(reasons_raw, list):
        reasons = [str(reason).strip() for reason in reasons_raw if str(reason).strip()]
    return (
        _safe_int(event_car.get("event_count", 0)),
        _safe_int(hgrm_reward.get("reward_count", 0)),
        bool(summary.get("evidence_complete", False)),
        reasons,
    )


def run_autonomous_lane(
    *,
    signals_path: Path,
    strategy_config_path: Path,
    gate_policy_path: Path,
    output_dir: Path,
    promotion_target: PromotionTarget = "paper",
    strategy_configmap_path: Path | None = None,
    code_version: str = "local",
    approval_token: str | None = None,
    drift_promotion_evidence: dict[str, Any] | None = None,
    governance_inputs: Mapping[str, Any] | None = None,
    evaluated_at: datetime | None = None,
    persist_results: bool = False,
    session_factory: Callable[[], Session] | None = None,
    governance_repository: str = "proompteng/lab",
    governance_base: str = "main",
    governance_head: str | None = None,
    governance_artifact_path: str | None = None,
    priority_id: str | None = None,
    governance_change: str = "autonomous-promotion",
    governance_reason: str | None = None,
) -> AutonomousLaneResult:
    """Run deterministic phase-1/2 autonomous lane and emit artifacts."""

    signals = _load_signals(signals_path)
    runtime_strategies = load_runtime_strategy_config(strategy_config_path)
    if not signals:
        raise ValueError("signals fixture is empty")

    run_id = _deterministic_run_id(
        signals_path, strategy_config_path, gate_policy_path, promotion_target
    )
    candidate_id = f"cand-{run_id[:12]}"
    research_dir, backtest_dir, gates_dir, paper_dir, rollout_dir = (
        _prepare_lane_output_dirs(output_dir)
    )

    now = evaluated_at or datetime.now(timezone.utc)
    runtime = StrategyRuntime(default_runtime_registry())
    walk_decisions: list[WalkForwardDecision] = []
    baseline_walk_decisions: list[WalkForwardDecision] = []
    runtime_errors: list[str] = []
    baseline_runtime_errors: list[str] = []
    patch_path: Path | None = None
    walk_results: WalkForwardResults | None = None
    report: EvaluationReport | None = None
    gate_report: GateEvaluationReport | None = None
    gate_report_trace_id: str | None = None
    recommendation_trace_id: str | None = None
    promotion_recommendation: PromotionRecommendation | None = None
    gate_report_path = gates_dir / "gate-evaluation.json"
    promotion_check_path = gates_dir / "promotion-prerequisites.json"
    rollback_check_path = gates_dir / "rollback-readiness.json"
    phase_manifest_path = output_dir / _AUTONOMY_PHASE_MANIFEST_PATH
    baseline_report_path = backtest_dir / "baseline-evaluation-report.json"
    profitability_benchmark_path = gates_dir / "profitability-benchmark-v4.json"
    profitability_evidence_path = gates_dir / "profitability-evidence-v4.json"
    profitability_validation_path = gates_dir / "profitability-evidence-validation.json"
    janus_event_car_path = gates_dir / "janus-event-car-v1.json"
    janus_hgrm_reward_path = gates_dir / "janus-hgrm-reward-v1.json"
    recalibration_report_path = gates_dir / "recalibration-report.json"
    promotion_gate_path = gates_dir / "promotion-evidence-gate.json"
    phase_manifest_path = rollout_dir / "phase-manifest.json"
    run_row = None
    governance_context = _normalize_governance_inputs(governance_inputs)

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

    try:
        ordered_signals = sorted(
            signals, key=lambda item: (item.event_ts, item.symbol, item.seq or 0)
        )
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
                    fold=walk_fold, decisions=walk_decisions, signals_count=len(signals)
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

        report_config = EvaluationReportConfig(
            evaluation_start=signals[0].event_ts,
            evaluation_end=signals[-1].event_ts,
            signal_source=str(signals_path),
            strategies=_to_orm_strategies(runtime_strategies),
            run_id=run_id,
            strategy_config_path=str(strategy_config_path),
            git_sha=code_version,
        )
        report = generate_evaluation_report(
            walk_results, config=report_config, promotion_target=promotion_target
        )
        evaluation_report_path = backtest_dir / "evaluation-report.json"
        write_evaluation_report(report, evaluation_report_path)
        baseline_report = generate_evaluation_report(
            baseline_walk_results,
            config=EvaluationReportConfig(
                evaluation_start=signals[0].event_ts,
                evaluation_end=signals[-1].event_ts,
                signal_source=str(signals_path),
                strategies=_to_orm_strategies(baseline_runtime_strategies),
                run_id=f"{run_id}-baseline",
                strategy_config_path="baseline:legacy_macd_rsi@1.0.0",
                git_sha=code_version,
            ),
            promotion_target="shadow",
        )
        write_evaluation_report(baseline_report, baseline_report_path)
        janus_event_car = build_janus_event_car_artifact_v1(
            run_id=run_id,
            signals=ordered_signals,
            generated_at=now,
        )
        janus_event_car_path.write_text(
            json.dumps(janus_event_car.to_payload(), indent=2), encoding="utf-8"
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
            baseline_id="baseline-legacy-macd-rsi",
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

        confidence_values = _collect_confidence_values(walk_decisions)
        reproducibility_hashes = {
            "signals": _sha256_path(signals_path),
            "strategy_config": _sha256_path(strategy_config_path),
            "gate_policy": _sha256_path(gate_policy_path),
            "walkforward_results": _sha256_path(walk_results_path),
            "candidate_report": _sha256_path(evaluation_report_path),
            "baseline_report": _sha256_path(baseline_report_path),
            "janus_event_car": _sha256_path(janus_event_car_path),
            "janus_hgrm_reward": _sha256_path(janus_hgrm_reward_path),
        }
        profitability_evidence = build_profitability_evidence_v4(
            run_id=run_id,
            candidate_id=candidate_id,
            baseline_id="baseline-legacy-macd-rsi",
            candidate_report_payload=report.to_payload(),
            benchmark=benchmark,
            confidence_values=confidence_values,
            reproducibility_hashes=reproducibility_hashes,
            artifact_refs=[
                str(evaluation_report_path),
                str(baseline_report_path),
                str(walk_results_path),
                str(signals_path),
                str(strategy_config_path),
                str(gate_policy_path),
            ],
            generated_at=now,
        )
        profitability_evidence_payload = profitability_evidence.to_payload()
        profitability_evidence_payload["janus_q"] = janus_q_summary
        profitability_evidence_path.write_text(
            json.dumps(profitability_evidence_payload, indent=2), encoding="utf-8"
        )

        gate_policy_payload = json.loads(gate_policy_path.read_text(encoding="utf-8"))
        profitability_thresholds = ProfitabilityEvidenceThresholdsV4.from_payload(
            _profitability_threshold_payload(gate_policy_payload)
        )
        profitability_validation = validate_profitability_evidence_v4(
            profitability_evidence,
            thresholds=profitability_thresholds,
            checked_at=now,
        )
        profitability_validation_path.write_text(
            json.dumps(profitability_validation.to_payload(), indent=2),
            encoding="utf-8",
        )

        gate_policy = GatePolicyMatrix.from_path(gate_policy_path)
        profitability_evidence_payload["validation"] = (
            profitability_validation.to_payload()
        )
        metrics_payload = report.metrics.to_payload()
        (
            fragility_state,
            fragility_score,
            stability_mode_active,
            fragility_inputs_valid,
        ) = (
            _resolve_gate_fragility_inputs(
                metrics_payload=metrics_payload, decisions=walk_decisions
            )
        )
        forecast_gate_metrics = _resolve_gate_forecast_metrics(signals=ordered_signals)
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
                        set(
                            [
                                str(profitability_evidence_path),
                                str(profitability_validation_path),
                            ]
                        )
                    ),
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        gate_inputs = GateInputs(
            feature_schema_version="3.0.0",
            required_feature_null_rate=_required_feature_null_rate(signals),
            staleness_ms_p95=_resolve_gate_staleness_ms_p95(
                signals=ordered_signals,
            ),
            symbol_coverage=len({signal.symbol for signal in signals}),
            metrics=metrics_payload,
            robustness=report.robustness.to_payload(),
            tca_metrics=_load_tca_gate_inputs(factory),
            llm_metrics=_resolve_gate_llm_metrics(
                session_factory=factory,
                now=now,
            ),
            forecast_metrics=forecast_gate_metrics,
            profitability_evidence=profitability_evidence_payload,
            fragility_state=fragility_state,
            fragility_score=fragility_score,
            stability_mode_active=stability_mode_active,
            fragility_inputs_valid=fragility_inputs_valid,
            operational_ready=True,
            runbook_validated=True,
            kill_switch_dry_run_passed=True,
            rollback_dry_run_passed=True,
            approval_token=approval_token,
        )
        gate_report = evaluate_gate_matrix(
            gate_inputs,
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
            for stress_case in ("spread", "volatility", "liquidity", "halt")
        ]
        gate_report_payload = gate_report.to_payload()
        gate_report_payload["run_id"] = run_id
        gate_report_payload["throughput"] = {
            "signal_count": len(signals),
            "decision_count": report.metrics.decision_count,
            "trade_count": report.metrics.trade_count,
            "no_signal_window": False,
            "no_signal_reason": None,
            "fold_metrics_count": len(walk_results.folds),
            "stress_metrics_count": 4,
        }
        gate_report_payload["promotion_evidence"] = {
            "fold_metrics": {
                "count": len(fold_evidence),
                "items": fold_evidence,
                "artifact_ref": str(evaluation_report_path),
            },
            "stress_metrics": {
                "count": len(stress_evidence),
                "items": stress_evidence,
                "artifact_ref": "db:research_stress_metrics",
            },
            "janus_q": {
                "event_car": {
                    "count": janus_event_count,
                    "artifact_ref": str(janus_event_car_path),
                },
                "hgrm_reward": {
                    "count": janus_reward_count,
                    "artifact_ref": str(janus_hgrm_reward_path),
                },
                "evidence_complete": janus_evidence_complete,
                "reasons": janus_reasons,
            },
            "promotion_rationale": {
                "requested_target": promotion_target,
                "gate_recommended_mode": gate_report.recommended_mode,
                "gate_reasons": sorted(gate_report.reasons),
                "rationale_text": "Gate matrix recommendation captured from deterministic evaluation artifacts.",
            },
        }
        gate_report_trace_id = _trace_id(gate_report_payload)
        gate_report_payload["provenance"] = {
            "gate_report_trace_id": gate_report_trace_id,
        }
        gate_report_path.write_text(
            json.dumps(gate_report_payload, indent=2), encoding="utf-8"
        )

        candidate_hash = _compute_candidate_hash(
            run_id=run_id,
            runtime_strategies=runtime_strategies,
            gate_report=gate_report,
            signals_path=signals_path,
            strategy_config_path=strategy_config_path,
            gate_policy_path=gate_policy_path,
        )
        research_spec: dict[str, Any] = {
            "run_id": run_id,
            "candidate_id": candidate_id,
            "candidate_hash": candidate_hash,
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
                "profitability_benchmark": str(profitability_benchmark_path),
                "profitability_evidence": str(profitability_evidence_path),
                "profitability_validation": str(profitability_validation_path),
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
                    }
                    for strategy in runtime_strategies
                ],
            },
        }
        candidate_spec_path = research_dir / "candidate-spec.json"
        candidate_spec_path.write_text(
            json.dumps(research_spec, indent=2), encoding="utf-8"
        )

        patch_path: Path | None = None

        raw_gate_policy = gate_policy_payload
        candidate_state_payload = {
            "candidateId": candidate_id,
            "runId": run_id,
            "activeStage": "gate-evaluation",
            "paused": False,
            "datasetSnapshotRef": "signals_window",
            "noSignalReason": None,
            "rollbackReadiness": {
                "killSwitchDryRunPassed": True,
                "gitopsRevertDryRunPassed": (
                    promotion_target != "live" or bool(approval_token)
                ),
                "strategyDisableDryRunPassed": bool(runtime_strategies),
                "dryRunCompletedAt": now.isoformat(),
                "humanApproved": promotion_target != "live" or bool(approval_token),
                "rollbackTarget": f"{code_version or 'unknown'}",
            },
        }
        patch_path = _resolve_paper_patch_path(
            gate_report=gate_report,
            strategy_configmap_path=strategy_configmap_path,
            runtime_strategies=runtime_strategies,
            candidate_id=candidate_id,
            promotion_target=str(promotion_target),
            force_pre_prerequisite=promotion_target == "paper",
            paper_dir=paper_dir,
        )
        promotion_check = evaluate_promotion_prerequisites(
            policy_payload=raw_gate_policy,
            gate_report_payload=gate_report_payload,
            candidate_state_payload=candidate_state_payload,
            promotion_target=promotion_target,
            artifact_root=output_dir,
        )
        rollback_check = evaluate_rollback_readiness(
            policy_payload=raw_gate_policy,
            candidate_state_payload=candidate_state_payload,
            now=now,
        )
        promotion_check_path.write_text(
            json.dumps(promotion_check.to_payload(), indent=2), encoding="utf-8"
        )
        rollback_check_path.write_text(
            json.dumps(rollback_check.to_payload(), indent=2), encoding="utf-8"
        )
        drift_gate_check = _evaluate_drift_promotion_gate(
            promotion_target=promotion_target,
            drift_promotion_evidence=drift_promotion_evidence,
        )
        fold_metrics_count = len(walk_results.folds)
        stress_metrics_count = 4
        promotion_rationale = _build_promotion_rationale(
            gate_report=gate_report,
            promotion_check_reasons=promotion_check.reasons,
            rollback_check_reasons=rollback_check.reasons,
            promotion_target=promotion_target,
        )
        promotion_recommendation = build_promotion_recommendation(
            run_id=run_id,
            candidate_id=candidate_id,
            requested_mode=promotion_target,
            recommended_mode=gate_report.recommended_mode,
            gate_allowed=(
                gate_report.promotion_allowed and bool(drift_gate_check["allowed"])
            ),
            prerequisite_allowed=promotion_check.allowed,
            rollback_ready=rollback_check.ready,
            fold_metrics_count=fold_metrics_count,
            stress_metrics_count=stress_metrics_count,
            rationale=promotion_rationale,
            reasons=[
                *gate_report.reasons,
                *promotion_check.reasons,
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
        research_spec["promotion_recommendation"] = promotion_recommendation.to_payload()
        research_spec["promotion_evidence_requirements"] = {
            "fold_metrics_count": len(fold_evidence),
            "stress_case_count": len(stress_evidence),
            "rationale_required": True,
            "rationale_reason_codes": promotion_reasons,
        }
        candidate_spec_path.write_text(
            json.dumps(research_spec, indent=2), encoding="utf-8"
        )
        promotion_gate_payload = {
            "allowed": promotion_allowed,
            "recommended_mode": recommended_mode,
            "reasons": promotion_reasons,
            "checks": {
                "gate_matrix": {
                    "allowed": gate_report.promotion_allowed,
                    "reasons": gate_report.reasons,
                    "artifact_refs": [
                        str(gate_report_path),
                        str(profitability_evidence_path),
                        str(profitability_validation_path),
                        str(janus_event_car_path),
                        str(janus_hgrm_reward_path),
                        str(recalibration_report_path),
                    ],
                },
                "promotion_prerequisites": promotion_check.to_payload(),
                "rollback_readiness": rollback_check.to_payload(),
                "profitability_validation": profitability_validation.to_payload(),
                "janus_q": janus_q_summary,
                "drift_governance": drift_gate_check,
                "evidence_requirements": promotion_recommendation.evidence.to_payload(),
            },
            "recommendation": promotion_recommendation.to_payload(),
            "artifact_refs": sorted(
                set(
                    [
                        str(promotion_check_path),
                        str(rollback_check_path),
                        str(gate_report_path),
                        str(profitability_benchmark_path),
                        str(profitability_evidence_path),
                        str(profitability_validation_path),
                        str(janus_event_car_path),
                        str(janus_hgrm_reward_path),
                        *[
                            str(item)
                            for item in drift_gate_check.get("artifact_refs", [])
                            if str(item).strip()
                        ],
                        str(recalibration_report_path),
                    ]
                )
            ),
        }
        promotion_gate_path.write_text(
            json.dumps(promotion_gate_payload, indent=2), encoding="utf-8"
        )
        gate_report_payload["promotion_recommendation"] = (
            promotion_recommendation.to_payload()
        )
        gate_report_payload["promotion_evidence"] = {
            "fold_metrics": {
                "count": len(fold_evidence),
                "items": fold_evidence,
                "artifact_ref": str(evaluation_report_path),
            },
            "stress_metrics": {
                "count": len(stress_evidence),
                "items": stress_evidence,
                "artifact_ref": "db:research_stress_metrics",
            },
            "janus_q": {
                "event_car": {
                    "count": janus_event_count,
                    "artifact_ref": str(janus_event_car_path),
                },
                "hgrm_reward": {
                    "count": janus_reward_count,
                    "artifact_ref": str(janus_hgrm_reward_path),
                },
                "evidence_complete": janus_evidence_complete,
                "reasons": janus_reasons,
            },
            "promotion_rationale": {
                "requested_target": promotion_target,
                "gate_recommended_mode": gate_report.recommended_mode,
                "recommended_mode": recommended_mode,
                "promotion_allowed": promotion_allowed,
                "reason_codes": promotion_reasons,
                "recommendation_trace_id": recommendation_trace_id,
                "rationale_text": "Promotion decision derives from gate, prerequisite, and rollback checks.",
            },
        }
        gate_report_payload["promotion_decision"] = {
            "candidate_id": candidate_id,
            "promotion_target": promotion_target,
            "recommended_mode": recommended_mode,
            "promotion_allowed": promotion_allowed,
            "reason_codes": promotion_reasons,
            "promotion_gate_artifact": str(promotion_gate_path),
        }
        gate_report_payload["provenance"] = {
            "gate_report_trace_id": gate_report_trace_id,
            "recommendation_trace_id": recommendation_trace_id,
            "profitability_benchmark_artifact": str(profitability_benchmark_path),
            "profitability_evidence_artifact": str(profitability_evidence_path),
            "profitability_validation_artifact": str(profitability_validation_path),
            "janus_event_car_artifact": str(janus_event_car_path),
            "janus_hgrm_reward_artifact": str(janus_hgrm_reward_path),
            "recalibration_artifact": str(recalibration_report_path),
            "promotion_gate_artifact": str(promotion_gate_path),
        }
        gate_report_path.write_text(
            json.dumps(gate_report_payload, indent=2), encoding="utf-8"
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
            janus_event_car_path=janus_event_car_path,
            janus_hgrm_reward_path=janus_hgrm_reward_path,
            recalibration_report_path=recalibration_report_path,
            promotion_gate_path=promotion_gate_path,
            promotion_recommendation=promotion_recommendation,
            recommendations=promotion_reasons,
            phase_manifest_path=phase_manifest_path,
            governance_repository=governance_repository,
            governance_base=governance_base,
            governance_head=governance_head
            if governance_head
            else f"agentruns/torghut-autonomy-{now.strftime('%Y%m%dT%H%M%S')}",
            governance_artifact_path=(
                governance_artifact_path or str(output_dir)
            ).strip()
            or str(output_dir),
            priority_id=priority_id,
            governance_change=governance_change,
            governance_reason=(
                governance_reason
                or f"Autonomous recommendation for {promotion_target} target."
            ),
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
        _write_autonomy_iteration_notes(
            artifact_root=output_dir,
            run_id=run_id,
            candidate_id=candidate_id,
            phase_manifest_payload=phase_manifest_payload,
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

        return AutonomousLaneResult(
            run_id=run_id,
            candidate_id=candidate_id,
            output_dir=output_dir,
            gate_report_path=gate_report_path,
            actuation_intent_path=actuation_intent_path,
            paper_patch_path=patch_path,
            phase_manifest_path=phase_manifest_path,
            gate_report_trace_id=gate_report_trace_id,
            recommendation_trace_id=recommendation_trace_id,
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


def _prepare_lane_output_dirs(output_dir: Path) -> tuple[Path, Path, Path, Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    research_dir = output_dir / "research"
    backtest_dir = output_dir / "backtest"
    gates_dir = output_dir / "gates"
    paper_dir = output_dir / "paper-candidate"
    rollout_dir = output_dir / "rollout"
    for path in (research_dir, backtest_dir, gates_dir, paper_dir, rollout_dir):
        path.mkdir(parents=True, exist_ok=True)
    return research_dir, backtest_dir, gates_dir, paper_dir, rollout_dir


def _coerce_str(raw: Any, default: str = "") -> str:
    if not isinstance(raw, str):
        return default
    return raw.strip() or default


def _coerce_int(raw: Any, default: int = 0) -> int:
    if isinstance(raw, bool):
        return int(raw)
    if isinstance(raw, int):
        return raw
    if isinstance(raw, float):
        return int(raw)
    if isinstance(raw, str):
        try:
            return int(raw)
        except ValueError:
            return default
    return default


def _coerce_path_strings(values: Any) -> list[str]:
    if not isinstance(values, (list, tuple, set)):
        return []
    return sorted(
        {
            _coerce_str(value)
            for value in values
            if _coerce_str(value)
        }
    )


def _coerce_gate_phase_gates(raw_gates: Any) -> list[dict[str, Any]]:
    gates: list[dict[str, Any]] = []
    if not isinstance(raw_gates, list):
        return gates
    for item in raw_gates:
        if not isinstance(item, dict):
            continue
        payload = cast(dict[str, Any], item)
        gate_id = str(payload.get("gate_id", "")).strip()
        if not gate_id:
            continue
        status = str(payload.get("status", "fail")).strip()
        gates.append(
            {
                "id": gate_id,
                "status": status if status else "fail",
                "reasons": payload.get("reasons", []),
                "value": payload.get("value"),
                "threshold": payload.get("threshold"),
            }
        )
    return gates


def _build_actuation_intent_payload(
    *,
    run_id: str,
    candidate_id: str,
    generated_at: datetime,
    recommendation_trace_id: str,
    gate_report_trace_id: str,
    promotion_target: str,
    recommended_mode: str,
    actuation_allowed: bool,
    promotion_check: dict[str, Any],
    rollback_check: dict[str, object],
    candidate_state_payload: dict[str, Any],
    gate_report_path: Path,
    rollback_check_path: Path,
    candidate_spec_path: Path,
    evaluation_report_path: Path,
    walk_results_path: Path,
    paper_patch_path: Path | None,
    patch_required: bool,
    profitability_benchmark_path: Path,
    profitability_evidence_path: Path,
    profitability_validation_path: Path,
    janus_event_car_path: Path,
    janus_hgrm_reward_path: Path,
    recalibration_report_path: Path,
    promotion_gate_path: Path,
    promotion_recommendation: PromotionRecommendation,
    recommendations: list[str],
    phase_manifest_path: Path,
    governance_repository: str,
    governance_base: str,
    governance_head: str,
    governance_artifact_path: str,
    priority_id: str | None,
    governance_change: str,
    governance_reason: str,
) -> dict[str, Any]:
    raw_missing_checks = cast(object, rollback_check.get("missing_checks"))
    rollback_missing_checks = (
        list(cast(list[object], raw_missing_checks))
        if isinstance(raw_missing_checks, list)
        else []
    )
    rollback_evidence_links: list[str] = []
    rollback_evidence_links.extend(
        [
            str(candidate_spec_path),
            str(gate_report_path),
            str(evaluation_report_path),
            str(walk_results_path),
            str(promotion_gate_path),
            str(profitability_benchmark_path),
            str(profitability_evidence_path),
            str(profitability_validation_path),
            str(janus_event_car_path),
            str(janus_hgrm_reward_path),
            str(recalibration_report_path),
            str(rollback_check_path),
        ]
    )
    if paper_patch_path is not None:
        rollback_evidence_links.append(str(paper_patch_path))
    if phase_manifest_path.exists():
        rollback_evidence_links.append(str(phase_manifest_path))
    rollback_evidence_links.extend(
        [str(item) for item in promotion_check.get("artifact_refs", [])]
    )
    candidate_state_readiness = candidate_state_payload.get("rollbackReadiness", {})
    return {
        "schema_version": _ACTUATION_INTENT_SCHEMA_VERSION,
        "run_id": run_id,
        "candidate_id": candidate_id,
        "generated_at": generated_at.isoformat(),
        "generated_for": "autonomous-lane",
        "promotion_target": promotion_target,
        "recommended_mode": recommended_mode,
        "governance": {
            "repository": governance_repository,
            "base": governance_base,
            "head": governance_head,
            "artifact_path": governance_artifact_path,
            "change": governance_change,
            "reason": governance_reason,
            "priority_id": priority_id,
        },
        "actuation_allowed": actuation_allowed,
        "confirmation_phrase_required": promotion_target == "live",
        "confirmation_phrase": (
            _ACTUATION_CONFIRMATION_PHRASE
            if promotion_target == "live"
            else None
        ),
        "gates": {
            "recommendation_trace_id": recommendation_trace_id,
            "gate_report_trace_id": gate_report_trace_id,
            "promotion_allowed": promotion_recommendation.eligible,
            "promotion_action": promotion_recommendation.action,
            "recommendation_reasons": recommendations,
        },
        "artifact_refs": sorted(
            {item for item in rollback_evidence_links if item.strip()}
        ),
        "audit": {
            "candidate_state_payload": candidate_state_payload,
            "promotion_check": promotion_check,
            "rollback_check": rollback_check,
            "patch_required": patch_required,
            "patch_available": paper_patch_path is not None,
            "rollback_readiness_readout": {
                "kill_switch_dry_run_passed": bool(
                    candidate_state_readiness.get("killSwitchDryRunPassed")
                ),
                "gitops_revert_dry_run_passed": bool(
                    candidate_state_readiness.get("gitopsRevertDryRunPassed")
                ),
                "strategy_disable_dry_run_passed": bool(
                    candidate_state_readiness.get("strategyDisableDryRunPassed")
                ),
                "human_approved": bool(
                    candidate_state_readiness.get("humanApproved")
                ),
                "rollback_target": str(
                    candidate_state_readiness.get("rollbackTarget") or ""
                ),
                "dry_run_completed_at": str(
                    candidate_state_readiness.get("dryRunCompletedAt") or ""
                ),
            },
            "rollback_evidence_missing_checks": rollback_missing_checks,
        },
    }


def _build_phase_stage_payload(
    *,
    stage: str,
    stage_index: int,
    run_id: str,
    candidate_id: str,
    stage_status: str,
    stage_reasons: Sequence[str],
    stage_gate_refs: Sequence[dict[str, Any]],
    input_artifacts: Mapping[str, Path | None],
    output_artifacts: Mapping[str, Path | None],
    parent_lineage_hash: str | None,
    parent_stage: str | None,
    created_at: datetime,
    extra_inputs: Mapping[str, str] | None = None,
) -> tuple[dict[str, Any], str]:
    stage_payload: dict[str, Any] = {
        "stage": stage,
        "stage_index": stage_index,
        "run_id": run_id,
        "candidate_id": candidate_id,
        "status": stage_status,
        "status_reasons": list(stage_reasons),
        "gates": [dict(gate) for gate in stage_gate_refs],
        "created_at": created_at.isoformat(),
        "inputs": dict(extra_inputs or {}),
        "input_artifacts": {
            name: {
                "path": str(path),
                "sha256": _sha256_path(path),
            }
            for name, path in input_artifacts.items()
            if path is not None and path.exists()
        },
        "output_artifacts": {
            name: {
                "path": str(path),
                "sha256": _sha256_path(path),
            }
            for name, path in output_artifacts.items()
            if path is not None and path.exists()
        },
        "parent_lineage_hash": parent_lineage_hash,
        "parent_stage": parent_stage,
    }
    stage_payload_hash = _stable_hash(stage_payload)
    stage_trace_id = stage_payload_hash[:24]
    artifact_hashes = _artifact_hashes(output_artifacts)
    stage_payload["stage_trace_id"] = stage_trace_id
    stage_payload["lineage_hash"] = stage_payload_hash
    stage_payload["artifact_hashes"] = artifact_hashes
    stage_payload["artifact_count"] = len(artifact_hashes)
    return stage_payload, stage_payload_hash


def _coerce_mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    value_dict = cast(dict[str, Any], vars(value)) if hasattr(value, "__dict__") else {}
    return dict(value_dict)


def _normalize_governance_inputs(
    governance_inputs: Mapping[str, Any] | None,
    governance_inputs_override: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    base_payload = _coerce_mapping(governance_inputs)
    override_payload = _coerce_mapping(governance_inputs_override)
    execution_context = _coerce_mapping(base_payload.get("execution_context"))
    override_execution_context = _coerce_mapping(override_payload.get("execution_context"))
    runtime_governance = dict(
        {
            "governance_status": "skipped",
            "drift_status": "unknown",
            "rollback_triggered": False,
            "artifact_refs": [],
            "reasons": [],
        },
        **_coerce_mapping(base_payload.get("runtime_governance")),
        **_coerce_mapping(override_payload.get("runtime_governance")),
    )
    rollback_proof = dict(
        {
            "rollback_triggered": False,
            "rollback_incident_evidence": "",
            "rollback_incident_evidence_path": "",
            "artifact_refs": [],
            "reasons": [],
        },
        **_coerce_mapping(base_payload.get("rollback_proof")),
        **_coerce_mapping(override_payload.get("rollback_proof")),
    )
    return {
        "execution_context": {
            "repository": _coerce_str(
                override_execution_context.get("repository", execution_context.get("repository")),
                default="unknown",
            ),
            "base": _coerce_str(
                override_execution_context.get("base", execution_context.get("base")),
                default="unknown",
            ),
            "head": _coerce_str(
                override_execution_context.get("head", execution_context.get("head")),
                default="unknown",
            ),
            "artifactPath": _coerce_str(
                override_execution_context.get(
                    "artifactPath", execution_context.get("artifactPath")
                ),
                default="",
            ),
            "priorityId": _coerce_str(
                override_execution_context.get(
                    "priorityId", execution_context.get("priorityId")
                ),
                default="",
            ),
        },
        "runtime_governance": cast(Mapping[str, Any], runtime_governance),
        "rollback_proof": cast(Mapping[str, Any], rollback_proof),
    }


def _build_phase_manifest(
    *,
    run_id: str,
    candidate_id: str,
    evaluated_at: datetime,
    output_dir: Path,
    signals: list[SignalEnvelope],
    requested_promotion_target: PromotionTarget,
    gate_report: GateEvaluationReport,
    gate_report_path: Path,
    promotion_check: Mapping[str, Any] | Any,
    rollback_check: Mapping[str, Any] | Any,
    drift_gate_check: Mapping[str, Any],
    patch_path: Path | None,
    recommended_mode: str,
    gate_report_payload: Mapping[str, Any],
    promotion_reasons: list[str],
    governance_inputs: Mapping[str, Any] | None = None,
    governance_inputs_override: Mapping[str, Any] | None = None,
    drift_promotion_evidence: dict[str, Any] | None = None,
    actuation_payload: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    phase_timestamp = evaluated_at.isoformat()
    governance = _normalize_governance_inputs(
        governance_inputs=governance_inputs,
        governance_inputs_override=governance_inputs_override,
    )
    execution_context = governance["execution_context"]
    artifact_path = _coerce_str(
        execution_context.get("artifactPath"),
        default=str(output_dir),
    )
    phase_outputs = output_dir / "gates"
    candidate_spec_path = output_dir / "research" / "candidate-spec.json"
    evaluation_report_path = output_dir / "backtest" / "evaluation-report.json"
    walkforward_path = output_dir / "backtest" / "walkforward-results.json"
    phase_manifest_path = output_dir / _AUTONOMY_PHASE_MANIFEST_PATH
    promotion_check_path = output_dir / "gates" / "promotion-prerequisites.json"
    rollback_check_path = output_dir / "gates" / "rollback-readiness.json"
    promotion_gate_path = output_dir / "gates" / "promotion-evidence-gate.json"
    profitability_benchmark_path = output_dir / "gates" / "profitability-benchmark-v4.json"
    profitability_evidence_path = output_dir / "gates" / "profitability-evidence-v4.json"
    profitability_validation_path = output_dir / "gates" / "profitability-evidence-validation.json"
    janus_event_car_path = output_dir / "gates" / "janus-event-car-v1.json"
    janus_hgrm_reward_path = output_dir / "gates" / "janus-hgrm-reward-v1.json"
    recalibration_report_path = output_dir / "gates" / "recalibration-report.json"
    actuation_intent_path = output_dir / _ACTUATION_INTENT_PATH

    gates = gate_report_payload.get("gates")
    gate_entries = gates if isinstance(gates, list) else []
    gate_status = "pass" if gate_report.promotion_allowed else "fail"
    gate_output_paths = _coerce_path_strings(
        [str(gate_report_path), str(output_dir / "gates" / "promotion-evidence-gate.json")]
    )
    gate_payload_gates = _coerce_gate_phase_gates(gate_entries)
    throughput_payload = _coerce_mapping(gate_report_payload.get("throughput"))
    signal_count = _coerce_int(throughput_payload.get("signal_count"), default=0)
    decision_count = _coerce_int(throughput_payload.get("decision_count"), default=0)

    promotion_payload = _coerce_mapping(promotion_check)
    rollback_payload = _coerce_mapping(rollback_check)
    promotion_check_allowed = bool(promotion_payload.get("allowed"))
    rollback_ready = bool(rollback_payload.get("ready"))

    runtime_governance = _coerce_mapping(governance.get("runtime_governance"))
    rollback_proof = _coerce_mapping(governance.get("rollback_proof"))
    runtime_gate_status = coerce_phase_status(
        runtime_governance.get("governance_status", "skipped")
    )
    runtime_artifact_refs = _coerce_path_strings(
        runtime_governance.get("artifact_refs", [])
        if isinstance(runtime_governance.get("artifact_refs", []), list)
        else []
    )
    rollback_triggered = bool(
        runtime_governance.get("rollback_triggered", False)
        or rollback_proof.get("rollback_triggered", False)
    )
    rollback_proof_path = _coerce_str(
        rollback_proof.get("rollback_incident_evidence_path"), default=""
    ) or _coerce_str(rollback_proof.get("rollback_incident_evidence"), default="")
    rollback_proof_status = (
        "pass" if (not rollback_triggered) else ("pass" if rollback_proof_path else "fail")
    )
    drift_artifact_refs = _coerce_path_strings(
        drift_gate_check.get("artifact_refs")
        if isinstance(drift_gate_check.get("artifact_refs", []), list)
        else []
    )
    canary_status = "pass" if patch_path is not None else (
        "fail" if requested_promotion_target == "paper" else "skipped"
    )
    canary_slo_status = canary_status
    canary_artifact_path = str(patch_path) if patch_path is not None else None

    phase_summaries: list[dict[str, Any]] = [
        {
            "name": "gate-evaluation",
            "status": gate_status,
            "timestamp": phase_timestamp,
            "slo_gates": gate_payload_gates
            + [
                {
                    "id": "slo_signal_count_minimum",
                    "status": "pass" if signal_count >= 1 else "fail",
                    "threshold": 1,
                    "value": signal_count,
                },
                {
                    "id": "slo_decision_count_minimum",
                    "status": "pass" if decision_count >= 1 else "fail",
                    "threshold": 1,
                    "value": decision_count,
                },
            ],
            "observations": {
                "recommended_mode": recommended_mode,
                "promotion_reasons": list(promotion_reasons),
                "throughput": throughput_payload,
                "promotion_target": requested_promotion_target,
            },
            "required": {
                "signal_count": 1,
                "decision_count": 1,
                "trade_count": 0,
            },
            "artifact_refs": gate_output_paths,
        },
        {
            "name": "promotion-prerequisites",
            "status": "pass" if promotion_check_allowed else "fail",
            "timestamp": phase_timestamp,
            "slo_gates": [
                {
                    "id": "slo_required_artifacts_present",
                    "status": (
                        "pass"
                        if not promotion_payload.get("missing_artifacts")
                        else "fail"
                    ),
                    "threshold": len(promotion_payload.get("required_artifacts", [])),
                    "value": len(promotion_payload.get("artifact_refs", [])),
                }
            ],
            "observations": {
                "artifact_requirements": list(
                    promotion_payload.get("required_artifacts", [])
                ),
                "missing_artifacts": list(
                    promotion_payload.get("missing_artifacts", [])
                ),
                "throughput_required": dict(
                    promotion_payload.get("required_throughput", {})
                ),
                "throughput_observed": dict(
                    promotion_payload.get("observed_throughput", {})
                ),
            },
            "reasons": list(promotion_payload.get("reasons", [])),
            "artifact_refs": _coerce_path_strings(
                promotion_payload.get("artifact_refs", [])
                if isinstance(promotion_payload.get("artifact_refs", []), list)
                else []
            ),
            "artifact_paths": {
                "promotion_check": str(promotion_check_path),
                "promotion_gate": str(promotion_gate_path),
            },
        },
        {
            "name": "rollback-readiness",
            "status": "pass" if rollback_ready else "fail",
            "timestamp": phase_timestamp,
            "slo_gates": [
                {
                    "id": "slo_required_rollback_checks_present",
                    "status": (
                        "pass"
                        if not rollback_payload.get("missing_checks")
                        else "fail"
                    ),
                    "threshold": len(rollback_payload.get("required_checks", [])),
                    "value": len(rollback_payload.get("missing_checks", [])),
                }
            ],
            "observations": {
                "required_checks": list(rollback_payload.get("required_checks", [])),
                "missing_checks": list(rollback_payload.get("missing_checks", [])),
            },
            "reasons": list(rollback_payload.get("reasons", [])),
            "artifact_refs": [str(rollback_check_path)],
        },
        {
            "name": "drift-gate",
            "status": "pass"
            if bool(drift_gate_check.get("allowed", False))
            else "fail",
            "timestamp": phase_timestamp,
            "slo_gates": [
                {
                    "id": "slo_drift_gate_allowed",
                    "status": "pass"
                    if bool(drift_gate_check.get("allowed", False))
                    else "fail",
                    "threshold": True,
                    "value": bool(drift_gate_check.get("allowed", False)),
                }
            ],
            "observations": {
                "eligible_for_live_promotion": bool(
                    drift_gate_check.get("eligible_for_live_promotion", False)
                ),
                "drift_artifacts": _coerce_path_strings(
                    (drift_promotion_evidence or {}).get(
                        "evidence_artifact_refs", []
                    )
                    if isinstance(
                        (drift_promotion_evidence or {}).get("evidence_artifact_refs", []),
                        list,
                    )
                    else []
                ),
            },
            "artifact_refs": drift_artifact_refs,
            "reasons": list(drift_gate_check.get("reasons", [])),
        },
        {
            "name": "paper-canary",
            "status": canary_status,
            "timestamp": phase_timestamp,
            "slo_gates": [
                {
                    "id": "slo_paper_canary_patch_present",
                    "status": canary_slo_status,
                    "threshold": "patch exists for paper target",
                    "value": canary_artifact_path,
                }
            ],
            "observations": {
                "target": requested_promotion_target,
                "patch_path": canary_artifact_path,
            },
            "artifact_refs": ([canary_artifact_path] if canary_artifact_path else []),
        },
        {
            "name": "runtime-governance",
            "status": runtime_gate_status,
            "timestamp": phase_timestamp,
            "slo_gates": [
                {
                    "id": "slo_runtime_rollback_not_triggered",
                    "status": "pass" if not rollback_triggered else "fail",
                    "threshold": False,
                    "value": rollback_triggered,
                }
            ],
            "observations": {
                "requested_promotion_target": requested_promotion_target,
                "drift_status": str(runtime_governance.get("drift_status", "unknown")),
                "action_type": str(runtime_governance.get("action_type", "")) or None,
                "action_triggered": bool(
                    runtime_governance.get("action_triggered", False)
                ),
                "rollback_triggered": rollback_triggered,
            },
            "required": {"required_items": ["drift_status", "rollback_triggered"]},
            "artifact_refs": runtime_artifact_refs,
            "reasons": list(runtime_governance.get("reasons", [])),
        },
        {
            "name": "rollback-proof",
            "status": rollback_proof_status,
            "timestamp": phase_timestamp,
            "slo_gates": [
                {
                    "id": "slo_rollback_evidence_required_when_triggered",
                    "status": (
                        "pass" if rollback_proof_path and rollback_triggered else "pass"
                        if not rollback_triggered
                        else "fail"
                    ),
                    "threshold": True,
                    "value": bool(rollback_proof_path),
                }
            ],
            "observations": {
                "rollback_triggered": rollback_triggered,
                "rollback_incident_evidence_path": rollback_proof_path or None,
                "rollback_incident_evidence": rollback_proof_path or None,
            },
            "artifact_refs": [rollback_proof_path] if rollback_proof_path else [],
            "reasons": list(rollback_proof.get("reasons", [])),
        },
    ]

    ordered_phase_summaries = build_ordered_phase_summaries(
        phase_summaries,
        phase_timestamp=phase_timestamp,
        default_status="skip",
    )
    for phase_payload in ordered_phase_summaries:
        phase_payload["artifact_refs"] = _coerce_path_strings(
            phase_payload.get("artifact_refs", [])
        )
        phase_name = str(phase_payload.get("name", "")).strip()
        observed_gate_ids = {
            str(gate.get("id", "")).strip()
            for gate in (
                phase_payload.get("slo_gates", [])
                if isinstance(phase_payload.get("slo_gates"), list)
                else []
            )
        }
        for gate in AUTONOMY_PHASE_SLO_GATES.get(phase_name, ()):
            gate_id = str(gate.get("id", "")).strip()
            if not gate_id or gate_id in observed_gate_ids:
                continue
            observed_gate_ids.add(gate_id)
            phase_payload.setdefault("slo_gates", [])
            phase_payload["slo_gates"].append(
                {
                    "id": gate_id,
                    "status": str(
                        gate.get("status") or coerce_phase_status("skip")
                    ).strip()
                    or "skip",
                    "threshold": gate.get("threshold"),
                    "value": gate.get("value", None),
                }
            )

    phase_transitions = normalize_phase_transitions(ordered_phase_summaries)
    phase_artifact_refs: set[str] = set()
    for phase_payload in ordered_phase_summaries:
        phase_artifact_refs.update(
            _coerce_path_strings(phase_payload.get("artifact_refs", []))
        )
    manifest_candidate_artifacts = [
        str(gate_report_path),
        str(evaluation_report_path),
        str(candidate_spec_path),
        str(walkforward_path),
        str(phase_outputs / "promotion-evidence-gate.json"),
        str(phase_outputs / "promotion-prerequisites.json"),
        str(phase_outputs / "rollback-readiness.json"),
        str(phase_outputs / "profitability-benchmark-v4.json"),
        str(phase_outputs / "profitability-evidence-v4.json"),
        str(phase_outputs / "profitability-evidence-validation.json"),
        str(phase_outputs / "janus-event-car-v1.json"),
        str(phase_outputs / "janus-hgrm-reward-v1.json"),
        str(phase_manifest_path),
        str(actuation_intent_path),
    ]
    if patch_path is not None:
        manifest_candidate_artifacts.append(str(patch_path))
    manifest_artifact_refs = sorted(
        {
            item
            for item in (
                manifest_candidate_artifacts
                + list(sorted(phase_artifact_refs))
                + list(runtime_artifact_refs)
                + list(drift_artifact_refs)
            )
            if str(item).strip()
        }
    )
    manifest_payload: dict[str, Any] = {
        "schema_version": _AUTONOMY_PHASE_MANIFEST_SCHEMA_VERSION,
        "run_id": run_id,
        "candidate_id": candidate_id,
        "execution_context": {
            "repository": execution_context.get("repository", "unknown"),
            "base": execution_context.get("base", "unknown"),
            "head": execution_context.get("head", "unknown"),
            "artifactPath": artifact_path,
            "priorityId": execution_context.get("priorityId", ""),
        },
        "requested_promotion_target": requested_promotion_target,
        "generated_at": phase_timestamp,
        "updated_at": phase_timestamp,
        "phase_count": len(ordered_phase_summaries),
        "phase_transitions": phase_transitions,
        "status": (
            "pass"
            if all(
                coerce_phase_status(phase.get("status"), default="fail") in {"pass", "skipped", "skip"}
                for phase in ordered_phase_summaries
            )
            else "fail"
        ),
        "observation_summary": {
            "signal_count": len(signals),
            "has_signals": bool(signals),
            "paper_canary_targeted": requested_promotion_target == "paper",
            "live_targeted": requested_promotion_target == "live",
        },
        "phases": ordered_phase_summaries,
        "runtime_governance": {
            "requested_promotion_target": requested_promotion_target,
            "drift_status": str(runtime_governance.get("drift_status", "unknown")),
            "governance_status": runtime_governance.get("governance_status"),
            "rollback_triggered": rollback_triggered,
            "rollback_incident_evidence": rollback_proof_path,
            "rollback_incident_evidence_path": rollback_proof_path,
            "artifact_refs": runtime_artifact_refs,
            "reasons": list(runtime_governance.get("reasons", [])),
            "phase_count": len(_AUTONOMY_PHASE_ORDER),
            "action_type": str(runtime_governance.get("action_type", "")) or None,
            "action_triggered": bool(runtime_governance.get("action_triggered", False)),
        },
        "rollback_proof": {
            "requested_promotion_target": requested_promotion_target,
            "rollback_triggered": rollback_triggered,
            "rollback_incident_evidence": rollback_proof_path,
            "rollback_incident_evidence_path": rollback_proof_path,
            "artifact_refs": ([rollback_proof_path] if rollback_proof_path else []),
            "reasons": list(rollback_proof.get("reasons", [])),
            "status": rollback_proof_status,
        },
        "artifact_refs": manifest_artifact_refs,
        "slo_contract_version": "governance-slo-v1",
        "artifacts": {
            "candidate_spec": str(candidate_spec_path),
            "evaluation_report": str(evaluation_report_path),
            "walkforward_results": str(walkforward_path),
            "gate_report": str(gate_report_path),
            "promotion_check": str(promotion_check_path),
            "rollback_check": str(rollback_check_path),
            "promotion_gate": str(promotion_gate_path),
            "profitability_benchmark": str(profitability_benchmark_path),
            "profitability_evidence": str(profitability_evidence_path),
            "profitability_validation": str(profitability_validation_path),
            "janus_event_car": str(janus_event_car_path),
            "janus_hgrm_reward": str(janus_hgrm_reward_path),
            "recalibration_report": str(recalibration_report_path),
            "actuation_intent": str(actuation_intent_path),
        },
    }

    legacy_payload = _coerce_mapping(actuation_payload)
    actuation_allowed = bool(legacy_payload.get("actuation_allowed", False))
    stage_records: list[dict[str, Any]] = []
    stage_parent_hash: str | None = None
    stage_parent_stage: str | None = None

    candidate_payload, candidate_lineage_hash = _build_phase_stage_payload(
        stage="candidate-spec",
        stage_index=1,
        run_id=run_id,
        candidate_id=candidate_id,
        stage_status="pass",
        stage_reasons=["candidate_spec_generated"],
        stage_gate_refs=[],
        input_artifacts={"strategy_config": None, "gate_policy": None},
        output_artifacts={"candidate_spec": candidate_spec_path},
        parent_lineage_hash=stage_parent_hash,
        parent_stage=stage_parent_stage,
        created_at=evaluated_at,
        extra_inputs={"output_dir": str(output_dir)},
    )
    stage_records.append(candidate_payload)
    stage_parent_hash = candidate_lineage_hash
    stage_parent_stage = "candidate-spec"

    gate_payload, gate_lineage_hash = _build_phase_stage_payload(
        stage="gate-evaluation",
        stage_index=2,
        run_id=run_id,
        candidate_id=candidate_id,
        stage_status=coerce_phase_status(gate_status),
        stage_reasons=(
            [f"{gate.get('id')}:{gate.get('status')}" for gate in gate_payload_gates]
            if gate_payload_gates
            else ["status:{}".format(gate_status)]
        ),
        stage_gate_refs=gate_payload_gates,
        input_artifacts={"gate_definition": None},
        output_artifacts={
            "gate_report": gate_report_path,
            "evaluation_report": evaluation_report_path,
            "profitability_benchmark": profitability_benchmark_path,
            "profitability_evidence": profitability_evidence_path,
            "profitability_validation": profitability_validation_path,
            "janus_event_car": janus_event_car_path,
            "janus_hgrm_reward": janus_hgrm_reward_path,
            "recalibration_report": recalibration_report_path,
            "promotion_gate": promotion_gate_path,
        },
        parent_lineage_hash=stage_parent_hash,
        parent_stage=stage_parent_stage,
        created_at=evaluated_at,
        extra_inputs={
            "recommendation_trace_id": _coerce_str(
                _coerce_mapping(gate_report_payload).get("recommendation_trace_id")
            ),
            "gate_report_trace_id": _coerce_str(
                _coerce_mapping(gate_report_payload).get("gate_report_trace_id")
            ),
        },
    )
    stage_records.append(gate_payload)
    stage_parent_hash = gate_lineage_hash
    stage_parent_stage = "gate-evaluation"

    promotion_payload_stage, promotion_lineage_hash = _build_phase_stage_payload(
        stage="promotion-prerequisites",
        stage_index=3,
        run_id=run_id,
        candidate_id=candidate_id,
        stage_status="pass" if promotion_check_allowed else "fail",
        stage_reasons=list(
            map(str, _coerce_mapping(promotion_payload).get("reasons", []))
            if isinstance(_coerce_mapping(promotion_payload).get("reasons", []), list)
            else []
        )
        or ["missing_promotion_check"],
        stage_gate_refs=[promotion_payload],
        input_artifacts={"gate_evaluation": gate_report_path},
        output_artifacts={"promotion_check": promotion_check_path},
        parent_lineage_hash=stage_parent_hash,
        parent_stage=stage_parent_stage,
        created_at=evaluated_at,
        extra_inputs={
            "promotion_target": requested_promotion_target,
            "recommended_mode": recommended_mode,
        },
    )
    stage_records.append(promotion_payload_stage)
    stage_parent_hash = promotion_lineage_hash
    stage_parent_stage = "promotion-prerequisites"

    rollback_payload_stage, rollback_lineage_hash = _build_phase_stage_payload(
        stage="rollback-readiness",
        stage_index=4,
        run_id=run_id,
        candidate_id=candidate_id,
        stage_status="pass" if rollback_ready else "fail",
        stage_reasons=(
            [str(reason) for reason in _coerce_mapping(rollback_payload).get("reasons", [])]
            if isinstance(_coerce_mapping(rollback_payload).get("reasons", []), list)
            else []
        )
        or ["missing_rollback_readiness"],
        stage_gate_refs=[rollback_payload],
        input_artifacts={"promotion_check": promotion_check_path},
        output_artifacts={"rollback_check": rollback_check_path},
        parent_lineage_hash=stage_parent_hash,
        parent_stage=stage_parent_stage,
        created_at=evaluated_at,
    )
    stage_records.append(rollback_payload_stage)
    stage_parent_hash = rollback_lineage_hash
    stage_parent_stage = "rollback-readiness"

    actuation_payload_stage, actuation_lineage_hash = _build_phase_stage_payload(
        stage="actuation-intent",
        stage_index=5,
        run_id=run_id,
        candidate_id=candidate_id,
        stage_status="pass" if actuation_allowed else "fail",
        stage_reasons=(
            list(
                map(
                    str,
                    _coerce_mapping(legacy_payload.get("artifact_refs", [])),
                )
            )
            if isinstance(legacy_payload.get("artifact_refs"), list)
            else []
        )
        or ["actuation_artifact_recorded"],
        stage_gate_refs=[
            _coerce_mapping(legacy_payload.get("gates", {})),
            _coerce_mapping(legacy_payload.get("audit", {})),
        ],
        input_artifacts={"rollback_check": rollback_check_path},
        output_artifacts={"actuation_intent": actuation_intent_path},
        parent_lineage_hash=stage_parent_hash,
        parent_stage=stage_parent_stage,
        created_at=evaluated_at,
    )
    stage_records.append(actuation_payload_stage)
    stage_parent_hash = actuation_lineage_hash
    stage_parent_stage = "actuation-intent"

    if patch_path is not None:
        paper_payload, paper_lineage_hash = _build_phase_stage_payload(
            stage="paper-patch",
            stage_index=6,
            run_id=run_id,
            candidate_id=candidate_id,
            stage_status="pass",
            stage_reasons=["patch_artifact_emitted"],
            stage_gate_refs=[],
            input_artifacts={"actuation_intent": actuation_intent_path},
            output_artifacts={"paper_patch": patch_path},
            parent_lineage_hash=stage_parent_hash,
            parent_stage=stage_parent_stage,
            created_at=evaluated_at,
        )
        stage_records.append(paper_payload)
        stage_parent_hash = paper_lineage_hash

    stage_lineage_payload = {
        record["stage"]: {
            "stage_index": record["stage_index"],
            "stage_trace_id": record["stage_trace_id"],
            "lineage_hash": record["lineage_hash"],
            "status": record["status"],
            "parent_stage": record["parent_stage"],
            "parent_lineage_hash": record["parent_lineage_hash"],
            "artifact_count": record["artifact_count"],
            "status_reasons": record["status_reasons"],
        }
        for record in stage_records
    }
    stage_artifact_hashes = _artifact_hashes(
        {
            "candidate_spec": candidate_spec_path,
            "evaluation_report": evaluation_report_path,
            "walkforward_results": walkforward_path,
            "gate_report": gate_report_path,
            "promotion_check": promotion_check_path,
            "rollback_check": rollback_check_path,
            "promotion_gate": promotion_gate_path,
            "profitability_benchmark": profitability_benchmark_path,
            "profitability_evidence": profitability_evidence_path,
            "profitability_validation": profitability_validation_path,
            "janus_event_car": janus_event_car_path,
            "janus_hgrm_reward": janus_hgrm_reward_path,
            "recalibration_report": recalibration_report_path,
            "actuation_intent": actuation_intent_path,
        }
    )
    if patch_path is not None and patch_path.exists():
        stage_artifact_hashes["paper_patch"] = _sha256_path(patch_path)

    stage_ids = [record["stage_trace_id"] for record in stage_records]
    manifest_payload["phase_lineage"] = {
        "stage_count": len(stage_records),
        "stage_ids": stage_ids,
        "lineage_root": stage_records[0]["lineage_hash"] if stage_records else None,
        "lineage_tail": stage_records[-1]["lineage_hash"] if stage_records else None,
        "lineage_stages": stage_lineage_payload,
    }
    manifest_payload["artifact_hashes"] = stage_artifact_hashes
    manifest_payload["manifest_hash"] = _stable_hash(manifest_payload)
    manifest_payload["artifacts"] = dict(manifest_payload["artifacts"])
    manifest_payload["artifacts"]["walkforward_results"] = str(walkforward_path)
    return manifest_payload



def _write_autonomy_iteration_notes(
    *,
    artifact_root: Path,
    run_id: str,
    candidate_id: str,
    phase_manifest_payload: Mapping[str, Any],
) -> Path:
    notes_dir = artifact_root / _AUTONOMY_NOTES_DIR
    notes_dir.mkdir(parents=True, exist_ok=True)
    iteration = _readable_iteration_number(notes_dir)
    notes_path = notes_dir / f"{_AUTONOMY_NOTES_PREFIX}{iteration}.md"
    phase_lineage = phase_manifest_payload.get("phase_lineage", {})
    phase_lineage_map = _as_mapping(phase_lineage)

    lines = [
        f"# Autonomy phase iteration {iteration}",
        "",
        f"- run_id: {run_id}",
        f"- candidate_id: {candidate_id}",
        f"- generated_at: {phase_manifest_payload.get('generated_at', '')}",
        f"- manifest_schema: {phase_manifest_payload.get('schema_version', '')}",
        f"- artifact_hash_count: {len(_as_mapping(phase_manifest_payload.get('artifact_hashes')).keys())}",
        "",
        "## Stage lineage",
        f"- head: {phase_lineage_map.get('lineage_tail')}",
        f"- root: {phase_lineage_map.get('lineage_root')}",
    ]
    for stage in phase_lineage_map.get("lineage_stages", {}):
        stage_payload = phase_lineage_map["lineage_stages"].get(stage, {})
        if not isinstance(stage_payload, Mapping):
            continue
        lines.extend(
            [
                "",
                f"### {stage}",
                f"- index: {cast(dict[str, object], stage_payload).get('stage_index')}",
                f"- status: {cast(dict[str, object], stage_payload).get('status')}",
                f"- trace: {cast(dict[str, object], stage_payload).get('stage_trace_id')}",
                f"- parent: {cast(dict[str, object], stage_payload).get('parent_stage')}",
            ]
        )
    notes_path.write_text("\\n".join(lines), encoding="utf-8")
    return notes_path


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
        dict(confidence_calibration_raw)
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
    force_pre_prerequisite: bool = False,
) -> Path | None:
    requested_target = str(promotion_target or "").strip().lower()
    if force_pre_prerequisite:
        if requested_target != "paper":
            return None
    elif gate_report.recommended_mode != "paper":
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
) -> None:
    robustness_by_fold = {fold.fold_name: fold for fold in report.robustness.folds}
    effective_promotion_allowed = bool(promotion_allowed and actuation_allowed)

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
                delete(ResearchStressMetrics).where(
                    ResearchStressMetrics.candidate_id == candidate_id
                )
            )
            session.execute(
                delete(ResearchCandidate).where(
                    ResearchCandidate.candidate_id == candidate_id
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
                "existing_champion_candidate_id": (
                    existing_champion.candidate_id
                    if existing_champion is not None
                    else None
                ),
                "actuation_allowed": effective_promotion_allowed,
                "actuation_intent_artifact": (
                    str(actuation_intent_path) if actuation_intent_path else None
                ),
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

            evidence_bundle = {
                "fold_metrics_count": fold_metrics_count,
                "stress_metrics_count": stress_metrics_count,
                "rationale_present": bool(promotion_recommendation.rationale),
                "evidence_complete": promotion_recommendation.evidence.evidence_complete,
                "actuation_allowed": effective_promotion_allowed,
                "reasons": list(promotion_recommendation.evidence.reasons),
                "actuation_intent_artifact": (
                    str(actuation_intent_path) if actuation_intent_path else None
                ),
            }
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
                run.updated_at = now
                session.add(run)


def _compute_candidate_hash(
    *,
    run_id: str,
    runtime_strategies: list[StrategyRuntimeConfig],
    gate_report: GateEvaluationReport,
    signals_path: Path,
    strategy_config_path: Path,
    gate_policy_path: Path,
) -> str:
    hasher = hashlib.sha256()
    hasher.update(signals_path.read_bytes())
    hasher.update(strategy_config_path.read_bytes())
    hasher.update(gate_policy_path.read_bytes())
    hasher.update(run_id.encode("utf-8"))
    hasher.update(str(_strategy_parameter_set(runtime_strategies)).encode("utf-8"))
    hasher.update(gate_report.recommended_mode.encode("utf-8"))
    hasher.update(str(sorted(gate_report.reasons)).encode("utf-8"))
    return hasher.hexdigest()[:32]


def _build_promotion_rationale(
    *,
    gate_report: GateEvaluationReport,
    promotion_check_reasons: list[str],
    rollback_check_reasons: list[str],
    promotion_target: str,
) -> str:
    if (
        gate_report.promotion_allowed
        and not promotion_check_reasons
        and not rollback_check_reasons
    ):
        return (
            f"all_required_gates_passed_for_{promotion_target}_promotion_"
            f"recommended_mode_{gate_report.recommended_mode}"
        )
    reasons = sorted(
        set([*gate_report.reasons, *promotion_check_reasons, *rollback_check_reasons])
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
        payload = yaml.safe_load(raw)
    else:
        payload = json.loads(raw)

    if isinstance(payload, dict):
        payload = payload.get("strategies", payload)
    if not isinstance(payload, list):
        raise ValueError("strategy config must be a list or include strategies key")

    strategies: list[StrategyRuntimeConfig] = []
    for index, item in enumerate(payload):
        if not isinstance(item, dict):
            raise ValueError(f"invalid strategy entry at index {index}")
        strategy_id = str(
            item.get("strategy_id") or item.get("name") or f"strategy-{index + 1}"
        )
        strategy_type = str(item.get("strategy_type", "legacy_macd_rsi"))
        version = str(item.get("version", "1.0.0"))
        params = item.get("params")
        if params is None:
            params = {
                "buy_rsi_threshold": item.get("buy_rsi_threshold", 35),
                "sell_rsi_threshold": item.get("sell_rsi_threshold", 65),
                "qty": item.get("qty", 1),
            }
        if not isinstance(params, dict):
            raise ValueError(f"params for strategy {strategy_id} must be an object")
        strategies.append(
            StrategyRuntimeConfig(
                strategy_id=strategy_id,
                strategy_type=strategy_type,
                version=version,
                params=params,
                base_timeframe=str(item.get("base_timeframe", "1Min")),
                enabled=bool(item.get("enabled", True)),
                priority=int(item.get("priority", 100)),
            )
        )

    return sorted(strategies, key=lambda item: (item.priority, item.strategy_id))


def _load_signals(path: Path) -> list[SignalEnvelope]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise ValueError("signals payload must be a list")
    signals = [SignalEnvelope.model_validate(item) for item in payload]
    return sorted(signals, key=lambda item: (item.event_ts, item.symbol, item.seq or 0))


def _deterministic_run_id(
    signals_path: Path,
    strategy_config_path: Path,
    gate_policy_path: Path,
    promotion_target: PromotionTarget,
) -> str:
    hasher = hashlib.sha256()
    hasher.update(signals_path.read_bytes())
    hasher.update(strategy_config_path.read_bytes())
    hasher.update(gate_policy_path.read_bytes())
    hasher.update(promotion_target.encode("utf-8"))
    return hasher.hexdigest()[:24]


def _required_feature_null_rate(signals: list[SignalEnvelope]) -> Decimal:
    required_keys = ("macd", "rsi", "price")
    missing = 0
    total = 0
    for signal in signals:
        payload = signal.payload or {}
        for key in required_keys:
            total += 1
            if key == "macd":
                macd_block = payload.get("macd")
                if (
                    not isinstance(macd_block, dict)
                    or macd_block.get("macd") is None
                    or macd_block.get("signal") is None
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
    payload: dict[str, object]
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
            "stability_mode_active": metrics_payload.get(
                "stability_mode_active"
            ),
        }
    )

    selected_measurement: tuple[str, Decimal, bool] | None = None

    for item in decisions:
        params = item.decision.params
        allocator_payload = params.get("allocator")
        allocator = allocator_payload if isinstance(allocator_payload, dict) else {}
        snapshot_payload = params.get("fragility_snapshot")
        snapshot = snapshot_payload if isinstance(snapshot_payload, dict) else {}

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

        if route_result.contract.fallback.applied:
            fallback_total += 1
        latency_samples_ms.append(route_result.contract.inference_latency_ms)
        calibration_scores.append(route_result.contract.calibration_score)

    expected_samples = len(signals)
    if len(latency_samples_ms) != expected_samples or len(calibration_scores) != expected_samples:
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
            error_rate = _to_finite_float(metrics_payload.get("error_rate"))
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
            "avg_shortfall_notional": Decimal("0"),
            "avg_churn_ratio": Decimal("0"),
            "avg_divergence_bps": Decimal("0"),
            "avg_realized_shortfall_bps": Decimal("0"),
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


def _sha256_path(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


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
            if isinstance(runtime_payload, dict):
                raw_value = runtime_payload.get("confidence")
        if raw_value is None:
            continue
        try:
            values.append(Decimal(str(raw_value)))
        except (ArithmeticError, TypeError, ValueError):
            continue
    return values


def _default_strategy_configmap_path() -> Path:
    return (
        Path(__file__).resolve().parents[5]
        / "argocd"
        / "applications"
        / "torghut"
        / "strategy-configmap.yaml"
    )


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
        [str(item) for item in artifact_refs_raw if str(item).strip()]
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
        [str(item) for item in reasons_raw if str(item).strip()]
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
    configmap_payload = yaml.safe_load(configmap_path.read_text(encoding="utf-8"))
    if not isinstance(configmap_payload, dict):
        raise ValueError("invalid configmap payload")

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

    patch_payload = {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {
            "name": configmap_payload.get("metadata", {}).get(
                "name", "torghut-strategy-config"
            ),
            "namespace": configmap_payload.get("metadata", {}).get(
                "namespace", "torghut"
            ),
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
    "AutonomousLaneResult",
    "load_runtime_strategy_config",
    "run_autonomous_lane",
    "upsert_autonomy_no_signal_run",
]
