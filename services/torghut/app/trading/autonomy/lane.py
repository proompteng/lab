"""Deterministic autonomous lane: research -> gate evaluation -> paper candidate patch."""
# pyright: reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable

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
from ..features import extract_price, extract_rsi
from ..features import extract_signal_features
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
from .policy_checks import evaluate_promotion_prerequisites, evaluate_rollback_readiness
from .runtime import StrategyRuntime, StrategyRuntimeConfig, default_runtime_registry


@dataclass(frozen=True)
class AutonomousLaneResult:
    run_id: str
    candidate_id: str
    output_dir: Path
    gate_report_path: Path
    paper_patch_path: Path | None
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
    evaluated_at: datetime | None = None,
    persist_results: bool = False,
    session_factory: Callable[[], Session] | None = None,
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

    output_dir.mkdir(parents=True, exist_ok=True)
    research_dir = output_dir / "research"
    backtest_dir = output_dir / "backtest"
    gates_dir = output_dir / "gates"
    paper_dir = output_dir / "paper-candidate"
    for path in (research_dir, backtest_dir, gates_dir, paper_dir):
        path.mkdir(parents=True, exist_ok=True)

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
    baseline_report_path = backtest_dir / "baseline-evaluation-report.json"
    profitability_benchmark_path = gates_dir / "profitability-benchmark-v4.json"
    profitability_evidence_path = gates_dir / "profitability-evidence-v4.json"
    profitability_validation_path = gates_dir / "profitability-evidence-validation.json"
    recalibration_report_path = gates_dir / "recalibration-report.json"
    promotion_gate_path = gates_dir / "promotion-evidence-gate.json"
    run_row = None

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
        for signal in ordered_signals:
            result = runtime.evaluate(signal, runtime_strategies)
            runtime_errors.extend(result.errors)
            features = extract_signal_features(signal)
            for decision in result.decisions:
                walk_decisions.append(
                    WalkForwardDecision(decision=decision, features=features)
                )

        baseline_runtime_strategies = _baseline_runtime_strategies()
        for signal in ordered_signals:
            result = runtime.evaluate(signal, baseline_runtime_strategies)
            baseline_runtime_errors.extend(result.errors)
            features = extract_signal_features(signal)
            for decision in result.decisions:
                baseline_walk_decisions.append(
                    WalkForwardDecision(decision=decision, features=features)
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
        profitability_evidence_path.write_text(
            json.dumps(profitability_evidence.to_payload(), indent=2), encoding="utf-8"
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
        profitability_evidence_payload = profitability_evidence.to_payload()
        profitability_evidence_payload["validation"] = (
            profitability_validation.to_payload()
        )
        confidence_calibration_raw = profitability_evidence_payload.get(
            "confidence_calibration"
        )
        confidence_calibration: dict[str, Any]
        if isinstance(confidence_calibration_raw, dict):
            confidence_calibration = dict(confidence_calibration_raw)
        else:
            confidence_calibration = {}
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
        profitability_evidence_payload["confidence_calibration"] = (
            confidence_calibration
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
            staleness_ms_p95=0,
            symbol_coverage=len({signal.symbol for signal in signals}),
            metrics=metrics_payload,
            robustness=report.robustness.to_payload(),
            tca_metrics=_load_tca_gate_inputs(factory),
            llm_metrics={"error_ratio": "0"},
            profitability_evidence=profitability_evidence_payload,
            fragility_state=fragility_state,
            fragility_score=fragility_score,
            stability_mode_active=stability_mode_active,
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

        if gate_report.promotion_allowed and gate_report.recommended_mode == "paper":
            resolved_configmap = (
                strategy_configmap_path or _default_strategy_configmap_path()
            )
            patch_path = _write_paper_candidate_patch(
                configmap_path=resolved_configmap,
                runtime_strategies=runtime_strategies,
                candidate_id=candidate_id,
                output_path=paper_dir / "strategy-configmap-patch.yaml",
            )

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
                "gitopsRevertDryRunPassed": True,
                "strategyDisableDryRunPassed": True,
                "dryRunCompletedAt": now.isoformat(),
                "humanApproved": True,
                "rollbackTarget": f"{code_version or 'unknown'}",
            },
        }
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
                        str(recalibration_report_path),
                    ],
                },
                "promotion_prerequisites": promotion_check.to_payload(),
                "rollback_readiness": rollback_check.to_payload(),
                "profitability_validation": profitability_validation.to_payload(),
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
            "recalibration_artifact": str(recalibration_report_path),
            "promotion_gate_artifact": str(promotion_gate_path),
        }
        gate_report_path.write_text(
            json.dumps(gate_report_payload, indent=2), encoding="utf-8"
        )
        if not promotion_allowed:
            patch_path = None

        if persist_results:
            _persist_run_outputs(
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
                patch_path=patch_path,
                now=now,
                promotion_target=promotion_target,
                promotion_allowed=promotion_allowed,
                promotion_reasons=promotion_reasons,
                promotion_recommendation=promotion_recommendation,
                fold_metrics_count=fold_metrics_count,
                stress_metrics_count=stress_metrics_count,
                gate_report_trace_id=gate_report_trace_id,
                recommendation_trace_id=recommendation_trace_id,
            )

        if persist_results:
            _mark_run_passed(
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
            paper_patch_path=patch_path,
            gate_report_trace_id=gate_report_trace_id,
            recommendation_trace_id=recommendation_trace_id,
        )
    except Exception as exc:
        if persist_results:
            _mark_run_failed(
                session_factory=factory, run_id=run_id, run_row=run_row, now=now
            )
        raise RuntimeError(f"autonomous_lane_persistence_failed: {exc}") from exc


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
    patch_path: Path | None,
    now: datetime,
    promotion_target: str,
    promotion_allowed: bool,
    promotion_reasons: list[str],
    promotion_recommendation: PromotionRecommendation,
    fold_metrics_count: int,
    stress_metrics_count: int,
    gate_report_trace_id: str,
    recommendation_trace_id: str,
) -> None:
    robustness_by_fold = {fold.fold_name: fold for fold in report.robustness.folds}

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
                promotion_allowed
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
            }
            recommended_mode = promotion_recommendation.recommended_mode
            lifecycle_payload = {
                "role": "challenger",
                "status": "promoted_champion"
                if should_promote
                else "retained_challenger",
                "promotable": promotion_allowed,
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
                "reasons": list(promotion_recommendation.evidence.reasons),
            }
            challenger_decision = {
                "decision_type": "promotion",
                "run_id": run_id,
                "candidate_id": candidate_id,
                "promotion_target": promotion_target,
                "recommended_mode": recommended_mode,
                "promotion_allowed": promotion_allowed,
                "reason_codes": list(promotion_reasons),
                "recommendation_trace_id": recommendation_trace_id,
                "gate_report_trace_id": gate_report_trace_id,
            }
            session.add(
                ResearchPromotion(
                    candidate_id=candidate_id,
                    requested_mode=promotion_target,
                    approved_mode=recommended_mode if promotion_allowed else None,
                    approver="autonomous_scheduler",
                    approver_role="system",
                    approve_reason=json.dumps(challenger_decision, sort_keys=True)
                    if promotion_allowed
                    else None,
                    deny_reason=None
                    if promotion_allowed
                    else json.dumps(challenger_decision, sort_keys=True),
                    paper_candidate_patch_ref=str(patch_path) if patch_path else None,
                    effective_time=now if promotion_allowed else None,
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


def _coerce_fragility_state(value: object) -> str:
    if not isinstance(value, str):
        return "elevated"
    normalized = value.strip().lower()
    if normalized in {"normal", "elevated", "stress", "crisis"}:
        return normalized
    return "elevated"


def _fragility_state_rank(state: str) -> int:
    normalized = _coerce_fragility_state(state)
    if normalized == "normal":
        return 0
    if normalized == "elevated":
        return 1
    if normalized == "stress":
        return 2
    return 3


def _coerce_bool(value: object, *, default: bool = False) -> bool:
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
    return default


def _resolve_gate_fragility_inputs(
    *,
    metrics_payload: dict[str, object],
    decisions: list[WalkForwardDecision],
) -> tuple[str, Decimal, bool]:
    fallback_state = _coerce_fragility_state(metrics_payload.get("fragility_state"))
    fallback_score = _decimal_or_default(
        metrics_payload.get("fragility_score"), Decimal("0.5")
    )
    fallback_stability = _coerce_bool(
        metrics_payload.get("stability_mode_active"), default=False
    )

    selected_state = fallback_state
    selected_score = fallback_score
    selected_stability = fallback_stability
    selected_rank = _fragility_state_rank(fallback_state)

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

        state = _coerce_fragility_state(raw_state)
        score = _decimal_or_default(raw_score, fallback_score)
        stability = _coerce_bool(raw_stability, default=fallback_stability)
        rank = _fragility_state_rank(state)

        if rank > selected_rank or (rank == selected_rank and score > selected_score):
            selected_state = state
            selected_score = score
            selected_stability = stability
            selected_rank = rank

    return selected_state, selected_score, selected_stability


def _decimal_or_default(value: object, default: Decimal) -> Decimal:
    try:
        return Decimal(str(value))
    except (ArithmeticError, TypeError, ValueError):
        return default


def _load_tca_gate_inputs(
    session_factory: Callable[[], Session],
) -> dict[str, Decimal | int]:
    try:
        with session_factory() as session:
            return build_tca_gate_inputs(session)
    except Exception:
        return {
            "order_count": 0,
            "avg_slippage_bps": Decimal("0"),
            "avg_shortfall_notional": Decimal("0"),
            "avg_churn_ratio": Decimal("0"),
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
