# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Runtime-closure bundle helpers for MLX autoresearch outputs."""

from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence, cast

import yaml

from app.trading.autonomy.policy_checks import (
    evaluate_promotion_prerequisites,
    evaluate_rollback_readiness,
)
from app.trading.discovery.autoresearch import (
    StrategyAutoresearchProgram,
    candidate_meets_objective,
)
from app.trading.discovery.decomposition import (
    build_replay_decomposition,
    max_family_contribution_share,
    max_symbol_concentration_share,
    regime_slice_pass_rate,
)
from app.trading.discovery.mlx_snapshot import MlxSnapshotManifest
from app.trading.discovery.objectives import (
    ObjectiveVetoPolicy,
    build_scorecard,
    evaluate_vetoes,
)
from app.trading.discovery.portfolio_candidates import PortfolioCandidateSpec
from app.trading.evidence_receipts import build_portfolio_proof_receipt
from app.trading.costs import BPS_SCALE, CostModelConfig, participation_power
from app.trading.hypotheses import (
    hypothesis_registry_requires_dependency_capability,
    load_hypothesis_registry,
)
from app.trading.reporting import summarize_replay_profitability
import scripts.local_intraday_tsmom_replay as replay_mod
from scripts.search_consistent_profitability_frontier import (
    apply_candidate_to_configmap_with_overrides,
)

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_discover_runtime_root import *
from .part_02_portfolio_candidate_runtime_payload import *
from .part_03_replay_analysis import *
from .part_04_market_impact_stress_report import *
from .part_05_double_oos_walkforward_report import *


def write_runtime_closure_bundle(
    *,
    run_root: Path,
    runner_run_id: str,
    program: StrategyAutoresearchProgram,
    best_candidate: Mapping[str, Any] | PortfolioCandidateSpec | None,
    manifest: MlxSnapshotManifest,
    execution_context: RuntimeClosureExecutionContext | None = None,
    replay_executor: Any | None = None,
) -> RuntimeClosureBundleSummary:
    closure_root = run_root / "runtime-closure"
    if best_candidate is None:
        summary = RuntimeClosureBundleSummary(
            status="missing_candidate",
            candidate_id="",
            root=str(closure_root),
            candidate_spec_path="",
            candidate_generation_manifest_path="",
            candidate_configmap_path="",
            gate_report_path="",
            parity_replay_path="",
            parity_report_path="",
            approval_replay_path="",
            approval_report_path="",
            shadow_validation_path="",
            candidate_state_path="",
            rollback_readiness_artifact_path="",
            rollback_readiness_evaluation_path="",
            policy_path="",
            portfolio_optimizer_evidence_path="",
            portfolio_proof_receipt_path="",
            market_impact_stress_report_path="",
            delay_adjusted_depth_stress_report_path="",
            double_oos_report_path="",
            stress_metrics_path="",
            profitability_stage_manifest_path="",
            promotion_prerequisites_path="",
            replay_plan_path="",
            next_required_steps=(),
            promotion_prerequisites={},
            rollback_readiness={},
        )
        _write_json(closure_root / "summary.json", summary.to_payload())
        return summary

    best_candidate = _runtime_best_candidate_payload(best_candidate)
    candidate_id = _string(best_candidate.get("candidate_id"))
    candidate_spec_path = closure_root / "research" / "candidate-spec.json"
    candidate_generation_manifest_path = (
        closure_root / "research" / "candidate-generation-manifest.json"
    )
    candidate_configmap_path = closure_root / "replay" / "candidate-configmap.yaml"
    gate_report_path = closure_root / "gates" / "gate-evaluation.json"
    parity_replay_path = closure_root / "replay" / "scheduler-v3-parity-replay.json"
    parity_report_path = closure_root / "replay" / "scheduler-v3-parity-report.json"
    approval_replay_path = closure_root / "replay" / "scheduler-v3-approval-replay.json"
    approval_report_path = closure_root / "replay" / "scheduler-v3-approval-report.json"
    shadow_validation_path = closure_root / "replay" / "shadow-validation-plan.json"
    candidate_state_path = closure_root / "promotion" / "candidate-state.json"
    rollback_readiness_artifact_path = (
        closure_root / "gates" / "rollback-readiness.json"
    )
    rollback_readiness_evaluation_path = (
        closure_root / "promotion" / "rollback-readiness-evaluation.json"
    )
    policy_path = closure_root / "promotion" / "policy.json"
    portfolio_optimizer_evidence_path = (
        closure_root / "promotion" / "portfolio-optimizer-evidence.json"
    )
    portfolio_proof_receipt_path = (
        closure_root / "promotion" / "portfolio-proof-receipt.json"
    )
    profitability_stage_manifest_path = (
        closure_root / "profitability" / "profitability-stage-manifest-v1.json"
    )
    promotion_prerequisites_path = (
        closure_root / "promotion" / "promotion-prerequisites.json"
    )
    replay_plan_path = closure_root / "replay" / "runtime-replay-plan.json"
    walkforward_results_path = closure_root / "backtest" / "walkforward-results.json"
    evaluation_report_path = closure_root / "backtest" / "evaluation-report.json"
    market_impact_stress_report_path = (
        closure_root / "backtest" / "market-impact-stress.json"
    )
    delay_adjusted_depth_stress_report_path = (
        closure_root / "backtest" / "delay-adjusted-depth-stress.json"
    )
    double_oos_report_path = closure_root / "backtest" / "double-oos-walkforward.json"
    stress_metrics_path = closure_root / "promotion" / "stress-metrics.json"

    candidate_spec = _candidate_spec(
        runner_run_id=runner_run_id,
        program=program,
        best_candidate=best_candidate,
        manifest=manifest,
    )
    candidate_generation_manifest = _candidate_generation_manifest(
        runner_run_id=runner_run_id,
        program=program,
        best_candidate=best_candidate,
        manifest=manifest,
    )
    portfolio_optimizer_evidence = _portfolio_optimizer_evidence(best_candidate)
    policy_payload = _runtime_closure_policy(best_candidate=best_candidate)

    _write_json(candidate_spec_path, candidate_spec)
    _write_json(candidate_generation_manifest_path, candidate_generation_manifest)
    _write_json(policy_path, policy_payload)
    if portfolio_optimizer_evidence:
        _write_json(portfolio_optimizer_evidence_path, portfolio_optimizer_evidence)

    replay_plan = {
        "schema_version": "torghut.runtime-closure-replay-plan.v1",
        "candidate_id": candidate_id,
        "dataset_snapshot_ref": manifest.snapshot_id,
        "source_window_start": manifest.source_window_start,
        "source_window_end": manifest.source_window_end,
        "runtime_family": _runtime_family(best_candidate),
        "runtime_strategy_name": _runtime_strategy_name(best_candidate),
        "runtime_strategy_names": list(
            _portfolio_runtime_strategy_names(best_candidate)
        ),
        "approval_path": "scheduler_v3",
        "required_steps": [
            "checked_in_runtime_family",
            "scheduler_v3_parity_replay",
            "scheduler_v3_approval_replay",
            "live_shadow_validation",
        ],
        "runtime_closure_policy": program.runtime_closure_policy.to_payload(),
        "execution_context": execution_context.to_payload()
        if execution_context is not None
        else None,
        "recommended_commands": [
            "run scheduler-v3 parity replay for the mapped runtime family on the snapshot window",
            "run scheduler-v3 approval replay on the same candidate family and snapshot contract",
            "attach shadow validation evidence before requesting promotion",
        ],
    }
    _write_json(replay_plan_path, replay_plan)

    parity_report: dict[str, Any] | None = None
    approval_report: dict[str, Any] | None = None
    if program.runtime_closure_policy.enabled and execution_context is not None:
        replay_runner = replay_executor or _default_replay_executor
        rendered_configmap_path = _materialize_candidate_configmap(
            best_candidate=best_candidate,
            execution_context=execution_context,
            output_path=candidate_configmap_path,
        )
        if program.runtime_closure_policy.execute_parity_replay:
            parity_payload = _run_runtime_replay(
                best_candidate=best_candidate,
                manifest=manifest,
                execution_context=execution_context,
                strategy_configmap_path=rendered_configmap_path,
                window_name=program.runtime_closure_policy.parity_window,
                replay_executor=replay_runner,
            )
            _write_json(parity_replay_path, parity_payload)
            parity_report = _replay_analysis(
                window_name=program.runtime_closure_policy.parity_window,
                replay_payload=parity_payload,
                best_candidate=best_candidate,
                program=program,
            )
            _write_json(parity_report_path, parity_report)
        if program.runtime_closure_policy.execute_approval_replay:
            approval_payload = _run_runtime_replay(
                best_candidate=best_candidate,
                manifest=manifest,
                execution_context=execution_context,
                strategy_configmap_path=rendered_configmap_path,
                window_name=program.runtime_closure_policy.approval_window,
                replay_executor=replay_runner,
            )
            _write_json(approval_replay_path, approval_payload)
            approval_report = _replay_analysis(
                window_name=program.runtime_closure_policy.approval_window,
                replay_payload=approval_payload,
                best_candidate=best_candidate,
                program=program,
            )
            _write_json(approval_report_path, approval_report)

    market_impact_stress_report: dict[str, Any] | None = None
    delay_adjusted_depth_stress_report: dict[str, Any] | None = None
    double_oos_report: dict[str, Any] | None = None
    stress_metrics: dict[str, Any] | None = None
    if approval_report is not None:
        market_impact_stress_report = _market_impact_stress_report(
            runner_run_id=runner_run_id,
            best_candidate=best_candidate,
            approval_report=approval_report,
            program=program,
        )
        _write_json(market_impact_stress_report_path, market_impact_stress_report)
        delay_adjusted_depth_stress_report = _delay_adjusted_depth_stress_report(
            runner_run_id=runner_run_id,
            best_candidate=best_candidate,
            approval_report=approval_report,
            program=program,
        )
        _write_json(
            delay_adjusted_depth_stress_report_path,
            delay_adjusted_depth_stress_report,
        )
        stress_metrics = _stress_metrics_payload(
            market_impact_report=market_impact_stress_report,
            market_impact_ref=str(
                market_impact_stress_report_path.relative_to(closure_root)
            ),
            delay_depth_report=delay_adjusted_depth_stress_report,
            delay_depth_ref=str(
                delay_adjusted_depth_stress_report_path.relative_to(closure_root)
            ),
        )
        _write_json(stress_metrics_path, stress_metrics)
    if parity_report is not None or approval_report is not None:
        double_oos_report = _double_oos_walkforward_report(
            runner_run_id=runner_run_id,
            best_candidate=best_candidate,
            parity_report=parity_report,
            approval_report=approval_report,
            market_impact_report=market_impact_stress_report,
            delay_depth_report=delay_adjusted_depth_stress_report,
            program=program,
        )
        _write_json(double_oos_report_path, double_oos_report)

    shadow_plan = _shadow_validation_artifact(
        best_candidate=best_candidate,
        program=program,
        execution_context=execution_context,
    )
    _write_json(shadow_validation_path, shadow_plan)
    portfolio_proof_receipt = _portfolio_proof_receipt_payload(
        best_candidate=best_candidate,
        manifest=manifest,
        target_net_pnl_per_day=program.objective.target_net_pnl_per_day,
        runtime_closure_artifact_refs=(
            str(candidate_spec_path.relative_to(closure_root)),
            str(candidate_generation_manifest_path.relative_to(closure_root)),
            str(replay_plan_path.relative_to(closure_root)),
            str(shadow_validation_path.relative_to(closure_root)),
            *(
                (str(market_impact_stress_report_path.relative_to(closure_root)),)
                if market_impact_stress_report is not None
                else ()
            ),
            *(
                (
                    str(
                        delay_adjusted_depth_stress_report_path.relative_to(
                            closure_root
                        )
                    ),
                )
                if delay_adjusted_depth_stress_report is not None
                else ()
            ),
            *(
                (str(double_oos_report_path.relative_to(closure_root)),)
                if double_oos_report is not None
                else ()
            ),
            *(
                (str(stress_metrics_path.relative_to(closure_root)),)
                if stress_metrics is not None
                else ()
            ),
        ),
    )
    _write_json(portfolio_proof_receipt_path, portfolio_proof_receipt)
    gate_report = _gate_report(
        runner_run_id=runner_run_id,
        best_candidate=best_candidate,
        promotion_target=program.runtime_closure_policy.promotion_target,
        parity_report=parity_report,
        approval_report=approval_report,
        shadow_plan=shadow_plan,
        portfolio_optimizer_evidence_ref=(
            str(portfolio_optimizer_evidence_path.relative_to(closure_root))
            if portfolio_optimizer_evidence
            else None
        ),
        portfolio_proof_receipt_ref=str(
            portfolio_proof_receipt_path.relative_to(closure_root)
        ),
        stress_metrics_ref=(
            str(stress_metrics_path.relative_to(closure_root))
            if stress_metrics is not None
            else None
        ),
        stress_metrics_count=int(stress_metrics.get("count", 0))
        if stress_metrics is not None
        else 0,
    )
    _write_json(gate_report_path, gate_report)
    candidate_state = _candidate_state(
        runner_run_id=runner_run_id,
        best_candidate=best_candidate,
        manifest=manifest,
        parity_report=parity_report,
        approval_report=approval_report,
        shadow_plan=shadow_plan,
    )
    _write_json(candidate_state_path, candidate_state)

    rollback_readiness_result = evaluate_rollback_readiness(
        policy_payload=policy_payload,
        candidate_state_payload=candidate_state,
    )
    _write_json(
        rollback_readiness_artifact_path, rollback_readiness_result.to_payload()
    )
    _write_json(
        rollback_readiness_evaluation_path, rollback_readiness_result.to_payload()
    )

    walkforward_results, evaluation_report = _backtest_summary(
        runner_run_id=runner_run_id,
        best_candidate=best_candidate,
        manifest=manifest,
        parity_report=parity_report,
        approval_report=approval_report,
        promotion_target=program.runtime_closure_policy.promotion_target,
    )
    _write_json(walkforward_results_path, walkforward_results)
    _write_json(evaluation_report_path, evaluation_report)
    profitability_stage_manifest = _profitability_stage_manifest(
        root=closure_root,
        runner_run_id=runner_run_id,
        candidate_id=candidate_id,
        candidate_spec_path=candidate_spec_path,
        candidate_generation_manifest_path=candidate_generation_manifest_path,
        walkforward_results_path=walkforward_results_path,
        evaluation_report_path=evaluation_report_path,
        gate_report_path=gate_report_path,
        rollback_readiness_path=rollback_readiness_artifact_path,
        portfolio_optimizer_evidence_path=portfolio_optimizer_evidence_path
        if portfolio_optimizer_evidence_path.exists()
        else None,
        portfolio_proof_receipt_path=portfolio_proof_receipt_path
        if portfolio_proof_receipt_path.exists()
        else None,
        market_impact_stress_report_path=market_impact_stress_report_path
        if market_impact_stress_report_path.exists()
        else None,
        delay_adjusted_depth_stress_report_path=delay_adjusted_depth_stress_report_path
        if delay_adjusted_depth_stress_report_path.exists()
        else None,
        double_oos_report_path=double_oos_report_path
        if double_oos_report_path.exists()
        else None,
        stress_metrics_path=stress_metrics_path
        if stress_metrics_path.exists()
        else None,
        parity_replay_path=parity_replay_path if parity_replay_path.exists() else None,
        approval_replay_path=approval_replay_path
        if approval_replay_path.exists()
        else None,
        shadow_validation_path=shadow_validation_path
        if shadow_validation_path.exists()
        else None,
        parity_pass=bool(_mapping(parity_report).get("objective_met"))
        if parity_report is not None
        else False,
        approval_pass=bool(_mapping(approval_report).get("objective_met"))
        if approval_report is not None
        else False,
        shadow_status=_string(shadow_plan.get("status")),
    )
    _write_json(profitability_stage_manifest_path, profitability_stage_manifest)

    promotion_prerequisites_result = evaluate_promotion_prerequisites(
        policy_payload=policy_payload,
        gate_report_payload=gate_report,
        candidate_state_payload=candidate_state,
        promotion_target=program.runtime_closure_policy.promotion_target,
        artifact_root=closure_root,
    )
    _write_json(
        promotion_prerequisites_path, promotion_prerequisites_result.to_payload()
    )

    summary_status, next_required_steps = _summary_status_and_next_steps(
        parity_report=parity_report,
        approval_report=approval_report,
        shadow_plan=shadow_plan,
    )

    summary = RuntimeClosureBundleSummary(
        status=summary_status,
        candidate_id=candidate_id,
        root=str(closure_root),
        candidate_spec_path=str(candidate_spec_path),
        candidate_generation_manifest_path=str(candidate_generation_manifest_path),
        candidate_configmap_path=str(candidate_configmap_path)
        if candidate_configmap_path.exists()
        else "",
        gate_report_path=str(gate_report_path),
        parity_replay_path=str(parity_replay_path)
        if parity_replay_path.exists()
        else "",
        parity_report_path=str(parity_report_path)
        if parity_report_path.exists()
        else "",
        approval_replay_path=str(approval_replay_path)
        if approval_replay_path.exists()
        else "",
        approval_report_path=str(approval_report_path)
        if approval_report_path.exists()
        else "",
        shadow_validation_path=str(shadow_validation_path),
        candidate_state_path=str(candidate_state_path),
        rollback_readiness_artifact_path=str(rollback_readiness_artifact_path),
        rollback_readiness_evaluation_path=str(rollback_readiness_evaluation_path),
        policy_path=str(policy_path),
        portfolio_optimizer_evidence_path=str(portfolio_optimizer_evidence_path)
        if portfolio_optimizer_evidence_path.exists()
        else "",
        portfolio_proof_receipt_path=str(portfolio_proof_receipt_path),
        market_impact_stress_report_path=str(market_impact_stress_report_path)
        if market_impact_stress_report_path.exists()
        else "",
        delay_adjusted_depth_stress_report_path=str(
            delay_adjusted_depth_stress_report_path
        )
        if delay_adjusted_depth_stress_report_path.exists()
        else "",
        double_oos_report_path=str(double_oos_report_path)
        if double_oos_report_path.exists()
        else "",
        stress_metrics_path=str(stress_metrics_path)
        if stress_metrics_path.exists()
        else "",
        profitability_stage_manifest_path=str(profitability_stage_manifest_path),
        promotion_prerequisites_path=str(promotion_prerequisites_path),
        replay_plan_path=str(replay_plan_path),
        next_required_steps=next_required_steps,
        promotion_prerequisites=promotion_prerequisites_result.to_payload(),
        rollback_readiness=rollback_readiness_result.to_payload(),
    )
    _write_json(closure_root / "summary.json", summary.to_payload())
    return summary


__all__ = [name for name in globals() if not name.startswith("__")]
