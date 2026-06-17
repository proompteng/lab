# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Deterministic offline alpha discovery lane."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Iterable, Literal, Mapping, Sequence, cast

import pandas as pd
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ....models import (
    ResearchAttempt,
    ResearchCandidate,
    ResearchCostCalibration,
    ResearchFoldMetrics,
    ResearchPromotion,
    ResearchRun,
    ResearchSequentialTrial,
    ResearchStressMetrics,
    ResearchValidationTest,
)
from ...discovery import (
    build_sequential_trial_summary,
    build_strategy_factory_evaluation,
)
from ..metrics import summarize_equity_curve, to_jsonable
from ..search import SearchResult, candidate_to_jsonable, run_tsmom_grid_search
from ..tsmom import TSMOMConfig, backtest_tsmom
from ...reporting import (
    PromotionEvidenceSummary,
    build_promotion_recommendation,
)

# ruff: noqa: F401,F403,F405,F811,F821

from .alpha_lane_result import (
    AlphaLaneResult,
    _ALPHA_LANE_SCHEMA_VERSION,
    _STAGE_CANDIDATE_GENERATION,
    _STAGE_EVALUATION,
    _STAGE_RECOMMENDATION,
    _StageManifestRecord,
    _artifact_hashes,
    _build_stage_lineage_payload,
    _coalesce_alpha_inputs,
    _coerce_jsonable,
    _coerce_promotion_target,
    _coerce_str,
    _decimal_or_none,
    _evaluate_candidate,
    _frame_signature,
    _normalize_prices,
    _persist_prices,
    _read_policy_payload,
    _readable_iteration_number,
    _sha256_path,
    _stable_hash,
    _to_decimal,
    _write_iteration_notes,
    _write_json,
    _write_stage_manifest,
)
from .persist_strategy_factory_results import _persist_strategy_factory_results


def run_alpha_discovery_lane(
    *,
    artifact_path: Path,
    train_prices: pd.DataFrame,
    test_prices: pd.DataFrame,
    repository: str | None = None,
    base: str | None = None,
    head: str | None = None,
    priority_id: str | None = None,
    priorityId: str | None = None,
    notes_artifact_path: str | None = None,
    artifactPath: str | None = None,
    lookback_days: Iterable[int] = (20, 40, 60),
    vol_lookback_days: Iterable[int] = (10, 20, 40),
    target_daily_vols: Iterable[float] = (0.0075, 0.01, 0.0125),
    max_gross_leverages: Iterable[float] = (0.75, 1.0),
    long_only: bool = True,
    cost_bps_per_turnover: float = 5.0,
    gate_policy_path: Path | None = None,
    promotion_target: str = "paper",
    evaluated_at: datetime | None = None,
    execution_context: Mapping[str, Any] | None = None,
    persist_results: bool = False,
    session_factory: Callable[[], Session] | None = None,
    challenge_lane: bool = False,
    economic_rationale: str | None = None,
) -> AlphaLaneResult:
    """Run deterministic alpha candidate generation, evaluation, and recommendation."""

    train = _normalize_prices(train_prices, label="train")
    test = _normalize_prices(test_prices, label="test")
    if train.empty or test.empty:
        raise ValueError("train and test prices must be non-empty")
    if persist_results and session_factory is None:
        raise ValueError("session_factory is required when persist_results is true")

    now = evaluated_at or datetime.now(timezone.utc)
    output_dir = artifact_path
    (
        resolved_repository,
        resolved_base,
        resolved_head,
        resolved_priority_id,
        notes_artifact_root,
    ) = _coalesce_alpha_inputs(
        repository=repository,
        base=base,
        head=head,
        priority_id=priority_id,
        priorityId=priorityId,
        notes_artifact_path=notes_artifact_path,
        artifactPath=artifactPath,
        execution_context=execution_context,
    )
    research_dir = output_dir / "research"
    stages_output_dir = output_dir / "stages"
    notes_root = notes_artifact_root or output_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    research_dir.mkdir(parents=True, exist_ok=True)
    stages_output_dir.mkdir(parents=True, exist_ok=True)

    requested_mode = _coerce_promotion_target(promotion_target)
    lookback_values = list(lookback_days)
    vol_lookback_values = list(vol_lookback_days)
    target_daily_vol_values = list(target_daily_vols)
    max_gross_leverage_values = list(max_gross_leverages)
    if not (
        lookback_values
        and vol_lookback_values
        and target_daily_vol_values
        and max_gross_leverage_values
    ):
        raise ValueError("search grid must contain at least one value each")

    policy_payload = _read_policy_payload(gate_policy_path)
    run_signature = {
        "repository": resolved_repository or "",
        "base": resolved_base or "",
        "head": resolved_head or "",
        "priority_id": resolved_priority_id or "",
        "train_signature": _frame_signature(train),
        "test_signature": _frame_signature(test),
        "lookback_days": lookback_values,
        "vol_lookback_days": vol_lookback_values,
        "target_daily_vols": target_daily_vol_values,
        "max_gross_leverages": max_gross_leverage_values,
        "long_only": bool(long_only),
        "cost_bps_per_turnover": float(cost_bps_per_turnover),
        "challenge_lane": bool(challenge_lane),
        "economic_rationale": (economic_rationale or "").strip(),
        "policy": policy_payload,
    }
    run_id = _stable_hash(run_signature)[:24]
    candidate_id = f"cand-{run_id[:12]}"

    train_snapshot_path = _persist_prices(
        train,
        research_dir,
        name=f"train-prices-{candidate_id}",
    )
    test_snapshot_path = _persist_prices(
        test,
        research_dir,
        name=f"test-prices-{candidate_id}",
    )

    search_result = run_tsmom_grid_search(
        train,
        test,
        lookback_days=lookback_values,
        vol_lookback_days=vol_lookback_values,
        target_daily_vols=target_daily_vol_values,
        max_gross_leverages=max_gross_leverage_values,
        long_only=bool(long_only),
        cost_bps_per_turnover=float(cost_bps_per_turnover),
    )

    search_result_path = research_dir / "search-result.json"
    best_candidate_path = research_dir / "best-candidate.json"
    evaluation_report_path = research_dir / "evaluation-report.json"
    recommendation_artifact_path = research_dir / "recommendation.json"
    candidate_spec_path = research_dir / "candidate-spec.json"
    attempt_ledger_path = research_dir / "attempt-ledger.json"
    sequential_trial_path = research_dir / "sequential-trial.json"
    validation_dir = research_dir / "validation"
    cost_calibration_path = validation_dir / "cost-calibration-report-v1.json"

    search_payload = {
        "schema_version": "alpha-search-result-v1",
        "run_id": run_id,
        "candidate_id": candidate_id,
        "accepted": search_result.accepted,
        "reason": search_result.reason,
        "search_space": {
            "lookback_days": lookback_values,
            "vol_lookback_days": vol_lookback_values,
            "target_daily_vols": target_daily_vol_values,
            "max_gross_leverages": max_gross_leverage_values,
            "long_only": bool(long_only),
            "cost_bps_per_turnover": float(cost_bps_per_turnover),
        },
        "best": candidate_to_jsonable(search_result.best),
        "candidates_top": [
            candidate_to_jsonable(item) for item in search_result.candidates[:5]
        ],
    }
    search_result_path.write_text(
        json.dumps(search_payload, indent=2), encoding="utf-8"
    )
    best_candidate_path.write_text(
        json.dumps(candidate_to_jsonable(search_result.best), indent=2),
        encoding="utf-8",
    )

    best_cfg = TSMOMConfig(
        lookback_days=search_result.best.config.lookback_days,
        vol_lookback_days=search_result.best.config.vol_lookback_days,
        target_daily_vol=search_result.best.config.target_daily_vol,
        max_gross_leverage=search_result.best.config.max_gross_leverage,
        long_only=bool(long_only),
        cost_bps_per_turnover=float(cost_bps_per_turnover),
    )
    train_equity, train_debug = backtest_tsmom(train, best_cfg)
    test_equity, test_debug = backtest_tsmom(test, best_cfg)
    incumbent_cfg = TSMOMConfig(
        lookback_days=60,
        vol_lookback_days=20,
        target_daily_vol=0.01,
        max_gross_leverage=1.0,
        long_only=bool(long_only),
        cost_bps_per_turnover=float(cost_bps_per_turnover),
    )
    incumbent_equity, _incumbent_debug = backtest_tsmom(test, incumbent_cfg)
    strategy_factory = build_strategy_factory_evaluation(
        run_id=run_id,
        candidate_id=candidate_id,
        best_candidate=search_result.best,
        all_candidates=search_result.candidates,
        train_debug=train_debug,
        test_debug=test_debug,
        train_summary=search_result.best.train,
        test_summary=search_result.best.test,
        incumbent_summary=summarize_equity_curve(incumbent_equity),
        cost_bps_per_turnover=float(cost_bps_per_turnover),
        evaluated_at=now,
        challenge_lane=bool(challenge_lane),
        economic_rationale=economic_rationale,
    )

    validation_artifact_paths: dict[str, Path] = {}
    validation_payloads: dict[str, dict[str, Any]] = {}
    for validation_test in strategy_factory.validation_tests:
        payload = {
            "schema_version": "strategy-factory-validation-v1",
            "run_id": run_id,
            "candidate_id": candidate_id,
            **validation_test.to_payload(),
        }
        artifact_path = validation_dir / validation_test.artifact_name
        _write_json(artifact_path, payload)
        validation_artifact_paths[validation_test.test_name] = artifact_path
        validation_payloads[validation_test.test_name] = payload

    attempt_payload = {
        "schema_version": "research-attempt-ledger-v1",
        "run_id": run_id,
        "candidate_id": candidate_id,
        "attempts": strategy_factory.attempts,
    }
    _write_json(attempt_ledger_path, attempt_payload)

    cost_calibration_payload = {
        "schema_version": "cost-calibration-report-v1",
        **strategy_factory.cost_calibration.to_payload(),
    }
    _write_json(cost_calibration_path, cost_calibration_payload)

    sequential_trial = build_sequential_trial_summary(
        net_returns=test_debug["port_ret_net"],
        started_at=(
            test.index.min().to_pydatetime()
            if isinstance(test.index, pd.DatetimeIndex) and len(test.index) > 0
            else now
        ),
        updated_at=now,
        cost_calibration_status=strategy_factory.cost_calibration.status,
        baseline_outperformed=bool(
            strategy_factory.null_comparator_summary.get("baseline_outperformed")
        ),
    )
    sequential_trial_payload = {
        "schema_version": "sequential-trial-state-v1",
        **sequential_trial.to_payload(),
    }
    _write_json(sequential_trial_path, sequential_trial_payload)

    stage_records: list[_StageManifestRecord] = []
    manifest_paths: dict[str, Path] = {}
    stage_trace_ids: dict[str, str] = {}

    candidate_generation_stage_record = _write_stage_manifest(
        stage=_STAGE_CANDIDATE_GENERATION,
        stage_index=1,
        stage_output_dir=stages_output_dir,
        run_id=run_id,
        candidate_id=candidate_id,
        lineage_parent_hash=None,
        lineage_parent_stage=None,
        inputs={
            "run_id": run_id,
            "candidate_id": candidate_id,
            "repository": resolved_repository or "",
            "base": resolved_base or "",
            "head": resolved_head or "",
            "priority_id": resolved_priority_id or "",
        },
        input_artifacts={
            "train_prices": train_snapshot_path,
            "test_prices": test_snapshot_path,
            "gate_policy": gate_policy_path,
        },
        output_artifacts={
            "search_result": search_result_path,
            "best_candidate": best_candidate_path,
            "attempt_ledger": attempt_ledger_path,
        },
        created_at=now,
    )
    stage_records.append(candidate_generation_stage_record)
    manifest_paths[_STAGE_CANDIDATE_GENERATION] = (
        stages_output_dir / f"{_STAGE_CANDIDATE_GENERATION}-manifest.json"
    )
    stage_trace_ids[_STAGE_CANDIDATE_GENERATION] = (
        candidate_generation_stage_record.stage_trace_id
    )

    evaluation_passed, checks, reasons, evaluation_context = _evaluate_candidate(
        search_result,
        policy_payload,
    )
    validation_failures = [
        f"validation_{item.test_name}_failed"
        for item in strategy_factory.validation_tests
        if item.status != "pass"
    ]
    gate_allowed = evaluation_passed and not validation_failures
    prerequisite_reasons: list[str] = []
    if requested_mode == "live":
        if strategy_factory.cost_calibration.status != "calibrated":
            prerequisite_reasons.append("cost_calibration_not_calibrated")
        if sequential_trial.status != "paper_ready":
            prerequisite_reasons.append("sequential_trial_not_live_ready")
    elif requested_mode == "paper":
        if sequential_trial.status not in {"paper_ready", "paper_only"}:
            prerequisite_reasons.append("sequential_trial_not_paper_ready")
    prerequisite_allowed = len(prerequisite_reasons) == 0
    combined_reasons = sorted(set(reasons + validation_failures + prerequisite_reasons))
    evidence_summary = PromotionEvidenceSummary(
        fold_metrics_count=1,
        stress_metrics_count=len(strategy_factory.stress_results),
        rationale_present=True,
        evidence_complete=gate_allowed and prerequisite_allowed,
        reasons=combined_reasons,
    )
    recommendation = build_promotion_recommendation(
        run_id=run_id,
        candidate_id=candidate_id,
        requested_mode=requested_mode,
        recommended_mode=requested_mode,
        gate_allowed=gate_allowed,
        prerequisite_allowed=prerequisite_allowed,
        rollback_ready=True,
        fold_metrics_count=1,
        stress_metrics_count=len(strategy_factory.stress_results),
        rationale="strategy factory alpha recommendation",
        reasons=combined_reasons,
    )
    recommendation_trace_id = recommendation.trace_id

    evaluation_payload = {
        "schema_version": "alpha-evaluation-v2",
        "run_id": run_id,
        "candidate_id": candidate_id,
        "policy": _coerce_jsonable(policy_payload),
        "search_accepted": search_result.accepted,
        "search_reason": search_result.reason,
        "checks": checks,
        "evaluation_passed": evaluation_passed,
        "gate_allowed": gate_allowed,
        "validation_failures": validation_failures,
        "recommendation": recommendation.to_payload(),
        "evidence": {
            "best_total_return": search_result.best.test.total_return,
            "best_sharpe": search_result.best.test.sharpe,
            "best_train_total_return": search_result.best.train.total_return,
            "best_train_sharpe": search_result.best.train.sharpe,
            "best_test_max_drawdown": search_result.best.test.max_drawdown,
            "top_n": 5,
        },
        "evidence_summary": evidence_summary.to_payload(),
        "evaluation_context": _coerce_jsonable(evaluation_context),
        "summary": {
            "train": {
                "rows": int(train.shape[0]),
                "symbols": int(train.shape[1]),
                "columns": [str(column) for column in train.columns],
            },
            "test": {
                "rows": int(test.shape[0]),
                "symbols": int(test.shape[1]),
                "columns": [str(column) for column in test.columns],
            },
        },
        "evidence_detail": {
            "best_train": to_jsonable(search_result.best.train),
            "best_test": to_jsonable(search_result.best.test),
            "train_equity": {
                "start": float(train_equity.iloc[0]),
                "end": float(train_equity.iloc[-1]),
            },
            "test_equity": {
                "start": float(test_equity.iloc[0]),
                "end": float(test_equity.iloc[-1]),
            },
        },
        "strategy_factory": {
            "candidate_family": strategy_factory.candidate_family,
            "canonical_spec": strategy_factory.canonical_spec,
            "semantic_hash": strategy_factory.semantic_hash,
            "economic_rationale": strategy_factory.economic_rationale,
            "complexity_score": strategy_factory.complexity_score,
            "discovery_rank": strategy_factory.discovery_rank,
            "posterior_edge_summary": strategy_factory.posterior_edge_summary,
            "economic_validity_card": strategy_factory.economic_validity_card,
            "valid_regime_envelope": strategy_factory.valid_regime_envelope,
            "invalidation_clauses": strategy_factory.invalidation_clauses,
            "null_comparator_summary": strategy_factory.null_comparator_summary,
            "fold_stat_bundle": strategy_factory.fold_stat_bundle,
            "validation_tests": [
                item.to_payload() for item in strategy_factory.validation_tests
            ],
            "cost_calibration": cost_calibration_payload,
            "sequential_trial_seed": sequential_trial_payload,
        },
    }
    _write_json(evaluation_report_path, evaluation_payload)

    evaluation_output_artifacts: dict[str, Path | None] = {
        "evaluation_report": evaluation_report_path,
        "attempt_ledger": attempt_ledger_path,
        "cost_calibration": cost_calibration_path,
    }
    for test_name, artifact_path in validation_artifact_paths.items():
        evaluation_output_artifacts[f"validation_{test_name}"] = artifact_path

    evaluation_stage_record = _write_stage_manifest(
        stage=_STAGE_EVALUATION,
        stage_index=2,
        stage_output_dir=stages_output_dir,
        run_id=run_id,
        candidate_id=candidate_id,
        lineage_parent_hash=candidate_generation_stage_record.lineage_hash,
        lineage_parent_stage=candidate_generation_stage_record.stage,
        inputs={
            "run_id": run_id,
            "candidate_id": candidate_id,
            "recommendation_trace_id": recommendation_trace_id,
        },
        input_artifacts={
            "search_result": search_result_path,
            "best_candidate": best_candidate_path,
        },
        output_artifacts=evaluation_output_artifacts,
        created_at=now,
    )
    stage_records.append(evaluation_stage_record)
    manifest_paths[_STAGE_EVALUATION] = (
        stages_output_dir / f"{_STAGE_EVALUATION}-manifest.json"
    )
    stage_trace_ids[_STAGE_EVALUATION] = evaluation_stage_record.stage_trace_id

    recommendation_payload: dict[str, Any] = {
        "schema_version": "alpha-promotion-recommendation-v2",
        "run_id": run_id,
        "candidate_id": candidate_id,
        "promotion_target": requested_mode,
        "recommendation": recommendation.to_payload(),
        "checks": {
            "policy": _coerce_jsonable(policy_payload),
            "evaluation_checks": checks,
            "validation_tests": [
                item.to_payload() for item in strategy_factory.validation_tests
            ],
            "prerequisite_reasons": prerequisite_reasons,
        },
        "evaluation_passed": evaluation_passed,
        "gate_allowed": gate_allowed,
        "prerequisite_allowed": prerequisite_allowed,
        "evidence": evidence_summary.to_payload(),
        "strategy_factory": {
            "cost_calibration": cost_calibration_payload,
            "sequential_trial": sequential_trial_payload,
            "null_comparator_summary": strategy_factory.null_comparator_summary,
        },
        "recommendation_trace_id": recommendation_trace_id,
    }
    _write_json(recommendation_artifact_path, recommendation_payload)

    recommendation_stage_record = _write_stage_manifest(
        stage=_STAGE_RECOMMENDATION,
        stage_index=3,
        stage_output_dir=stages_output_dir,
        run_id=run_id,
        candidate_id=candidate_id,
        lineage_parent_hash=evaluation_stage_record.lineage_hash,
        lineage_parent_stage=evaluation_stage_record.stage,
        inputs={
            "run_id": run_id,
            "candidate_id": candidate_id,
            "recommendation_trace_id": recommendation_trace_id,
        },
        input_artifacts={
            "evaluation_report": evaluation_report_path,
            "cost_calibration": cost_calibration_path,
        },
        output_artifacts={
            "recommendation": recommendation_artifact_path,
            "sequential_trial": sequential_trial_path,
        },
        created_at=now,
    )
    stage_records.append(recommendation_stage_record)
    manifest_paths[_STAGE_RECOMMENDATION] = (
        stages_output_dir / f"{_STAGE_RECOMMENDATION}-manifest.json"
    )
    stage_trace_ids[_STAGE_RECOMMENDATION] = recommendation_stage_record.stage_trace_id

    stage_lineage_payload = _build_stage_lineage_payload(
        stage_records=stage_records,
        manifest_paths=manifest_paths,
    )
    replay_artifacts: dict[str, Path | None] = {
        "train_prices": train_snapshot_path,
        "test_prices": test_snapshot_path,
        "search_result": search_result_path,
        "best_candidate": best_candidate_path,
        "attempt_ledger": attempt_ledger_path,
        "evaluation_report": evaluation_report_path,
        "recommendation_artifact": recommendation_artifact_path,
        "sequential_trial": sequential_trial_path,
        "cost_calibration": cost_calibration_path,
        "candidate_generation_manifest": manifest_paths[_STAGE_CANDIDATE_GENERATION],
        "evaluation_manifest": manifest_paths[_STAGE_EVALUATION],
        "recommendation_manifest": manifest_paths[_STAGE_RECOMMENDATION],
    }
    for test_name, artifact_path in validation_artifact_paths.items():
        replay_artifacts[f"validation_{test_name}"] = artifact_path
    replay_artifact_hashes = _artifact_hashes(replay_artifacts)
    candidate_spec_payload = {
        "schema_version": "alpha-candidate-spec-v2",
        "run_id": run_id,
        "candidate_id": candidate_id,
        "generated_at": now.isoformat(),
        "train_prices": {
            "path": str(train_snapshot_path),
            "sha256": _sha256_path(train_snapshot_path),
        },
        "test_prices": {
            "path": str(test_snapshot_path),
            "sha256": _sha256_path(test_snapshot_path),
        },
        "search": {
            "params": {
                "lookback_days": lookback_values,
                "vol_lookback_days": vol_lookback_values,
                "target_daily_vols": target_daily_vol_values,
                "max_gross_leverages": max_gross_leverage_values,
                "long_only": bool(long_only),
                "cost_bps_per_turnover": float(cost_bps_per_turnover),
            },
            "best_total_return": search_result.best.test.total_return,
            "best_sharpe": search_result.best.test.sharpe,
            "best_train_total_return": search_result.best.train.total_return,
            "best_train_sharpe": search_result.best.train.sharpe,
        },
        "strategy_factory": {
            "candidate_family": strategy_factory.candidate_family,
            "canonical_spec": strategy_factory.canonical_spec,
            "semantic_hash": strategy_factory.semantic_hash,
            "economic_rationale": strategy_factory.economic_rationale,
            "complexity_score": strategy_factory.complexity_score,
            "discovery_rank": strategy_factory.discovery_rank,
            "posterior_edge_summary": strategy_factory.posterior_edge_summary,
            "economic_validity_card": strategy_factory.economic_validity_card,
            "valid_regime_envelope": strategy_factory.valid_regime_envelope,
            "invalidation_clauses": strategy_factory.invalidation_clauses,
            "null_comparator_summary": strategy_factory.null_comparator_summary,
            "fold_stat_bundle": strategy_factory.fold_stat_bundle,
            "challenge_lane": bool(challenge_lane),
            "attempt_count": len(strategy_factory.attempts),
        },
        "artifacts": {
            key: str(value)
            for key, value in replay_artifacts.items()
            if value is not None
        },
        "replay_artifact_hashes": replay_artifact_hashes,
        "recommendation": recommendation.to_payload(),
        "evidence_summary": evidence_summary.to_payload(),
        "stage_manifest_refs": {
            _STAGE_CANDIDATE_GENERATION: str(
                manifest_paths[_STAGE_CANDIDATE_GENERATION]
            ),
            _STAGE_EVALUATION: str(manifest_paths[_STAGE_EVALUATION]),
            _STAGE_RECOMMENDATION: str(manifest_paths[_STAGE_RECOMMENDATION]),
        },
        "stage_trace_ids": {
            _STAGE_CANDIDATE_GENERATION: candidate_generation_stage_record.stage_trace_id,
            _STAGE_EVALUATION: evaluation_stage_record.stage_trace_id,
            _STAGE_RECOMMENDATION: recommendation_stage_record.stage_trace_id,
        },
        "stage_lineage": stage_lineage_payload,
        "input_context": {
            "repository": resolved_repository,
            "base": resolved_base,
            "head": resolved_head,
            "priority_id": resolved_priority_id,
        },
        "policy": _coerce_jsonable(policy_payload),
    }
    _write_json(candidate_spec_path, candidate_spec_payload)

    if persist_results and session_factory is not None:
        _persist_strategy_factory_results(
            session_factory=session_factory,
            run_id=run_id,
            candidate_id=candidate_id,
            now=now,
            requested_mode=requested_mode,
            resolved_repository=resolved_repository,
            resolved_head=resolved_head,
            train=train,
            test=test,
            search_result=search_result,
            stage_lineage_payload=stage_lineage_payload,
            stage_trace_ids=stage_trace_ids,
            manifest_paths=manifest_paths,
            replay_artifact_hashes=replay_artifact_hashes,
            recommendation_trace_id=recommendation_trace_id,
            strategy_factory_summary={
                "candidate_family": strategy_factory.candidate_family,
                "canonical_spec": strategy_factory.canonical_spec,
                "semantic_hash": strategy_factory.semantic_hash,
                "economic_rationale": strategy_factory.economic_rationale,
                "complexity_score": strategy_factory.complexity_score,
                "discovery_rank": strategy_factory.discovery_rank,
                "posterior_edge_summary": strategy_factory.posterior_edge_summary,
                "economic_validity_card": strategy_factory.economic_validity_card,
                "valid_regime_envelope": strategy_factory.valid_regime_envelope,
                "invalidation_clauses": strategy_factory.invalidation_clauses,
                "null_comparator_summary": strategy_factory.null_comparator_summary,
                "fold_stat_bundle": strategy_factory.fold_stat_bundle,
                "stress_results": strategy_factory.stress_results,
            },
            validation_payloads=validation_payloads,
            attempt_payload=attempt_payload,
            cost_calibration_payload=cost_calibration_payload,
            sequential_trial_payload=sequential_trial_payload,
            evaluation_passed=evaluation_passed,
            promotion_allowed=bool(recommendation.eligible),
            recommendation_payload=recommendation_payload,
            recommendation_rationale="strategy factory alpha recommendation",
        )

    _write_iteration_notes(
        artifact_root=notes_root,
        run_id=run_id,
        candidate_id=candidate_id,
        stage_records=stage_records,
        repository=resolved_repository,
        base=resolved_base,
        head=resolved_head,
        priority_id=resolved_priority_id,
    )

    return AlphaLaneResult(
        run_id=run_id,
        candidate_id=candidate_id,
        output_dir=output_dir,
        train_prices_path=train_snapshot_path,
        test_prices_path=test_snapshot_path,
        search_result_path=search_result_path,
        best_candidate_path=best_candidate_path,
        evaluation_report_path=evaluation_report_path,
        recommendation_artifact_path=recommendation_artifact_path,
        candidate_spec_path=candidate_spec_path,
        candidate_generation_manifest_path=manifest_paths[_STAGE_CANDIDATE_GENERATION],
        evaluation_manifest_path=manifest_paths[_STAGE_EVALUATION],
        recommendation_manifest_path=manifest_paths[_STAGE_RECOMMENDATION],
        attempt_ledger_path=attempt_ledger_path,
        validation_artifact_paths=validation_artifact_paths,
        sequential_trial_path=sequential_trial_path,
        cost_calibration_path=cost_calibration_path,
        recommendation_trace_id=recommendation_trace_id,
        stage_trace_ids=stage_trace_ids,
        stage_lineage_root=stage_records[0].lineage_hash if stage_records else None,
        paper_patch_path=None,
    )


__all__ = [name for name in globals() if not name.startswith("__")]
