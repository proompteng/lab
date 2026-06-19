"""Deterministic autonomous lane: research -> gate evaluation -> paper candidate patch."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence, cast

from sqlalchemy import select
from sqlalchemy.orm import Session


from ...config import settings
from ...models import (
    ResearchRun,
    StrategyCapitalAllocation,
    StrategyHypothesis,
    StrategyHypothesisMetricWindow,
    StrategyHypothesisVersion,
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
from ..completion import build_completion_trace, persist_completion_trace
from ..evaluation import (
    WalkForwardDecision,
    WalkForwardResults,
)
from ..evidence_contracts import (
    contract_from_artifact_payload,
)
from ..features import (
    extract_signal_features,
)
from ..hypotheses import (
    load_hypothesis_registry,
)
from ..models import SignalEnvelope
from ..reporting import (
    EvaluationReport,
    PromotionRecommendation,
)
from .gates import (
    GateEvaluationReport,
)
from .runtime import (
    StrategyRuntime,
    StrategyRuntimeConfig,
)
from .lane_common import (
    default_strategy_configmap_path as _default_strategy_configmap_path,
    ensure_utc as _ensure_utc,
)
from .lane_phase_payloads import (
    coerce_str as _coerce_str,
)

from .lane_config_loading import (
    compute_dataset_version_hash as _compute_dataset_version_hash,
    compute_feature_spec_hash as _compute_feature_spec_hash,
    compute_no_signal_dataset_version_hash as _compute_no_signal_dataset_version_hash,
    compute_no_signal_feature_spec_hash as _compute_no_signal_feature_spec_hash,
    metric_counter_int as _metric_counter_int,
    load_runtime_strategy_config,
)
from .lane_governance import (
    resolve_hypothesis_window_evidence as _resolve_hypothesis_window_evidence,
    runtime_observation_contract_payload as _runtime_observation_contract_payload,
)
from .lane_run_summary import (
    write_paper_candidate_patch as _write_paper_candidate_patch,
)
from .lane_regime_artifacts import (
    decimal_or_zero as _decimal_or_zero,
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


def _trace_id(payload: object) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:24]


collect_walk_decisions_for_runtime = _collect_walk_decisions_for_runtime
resolve_confidence_calibration = _resolve_confidence_calibration
resolve_paper_patch_path = _resolve_paper_patch_path
mark_run_passed_if_requested = _mark_run_passed_if_requested
mark_run_failed_if_requested = _mark_run_failed_if_requested
upsert_research_run = _upsert_research_run
mark_run_failed = _mark_run_failed
mark_run_passed = _mark_run_passed
persist_strategy_spec_lineage_trace = _persist_strategy_spec_lineage_trace
persist_hypothesis_governance_rows = _persist_hypothesis_governance_rows
persist_vnext_objects = _persist_vnext_objects
trace_id = _trace_id

__all__ = [
    "upsert_autonomy_no_signal_run",
    "_collect_walk_decisions_for_runtime",
    "_resolve_confidence_calibration",
    "_resolve_paper_patch_path",
    "_mark_run_passed_if_requested",
    "_mark_run_failed_if_requested",
    "_upsert_research_run",
    "_mark_run_failed",
    "_mark_run_passed",
    "_persist_strategy_spec_lineage_trace",
    "_persist_hypothesis_governance_rows",
    "_persist_vnext_objects",
    "_trace_id",
]
