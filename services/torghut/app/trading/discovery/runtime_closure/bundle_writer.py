"""Runtime-closure bundle helpers for MLX autoresearch outputs."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from app.trading.autonomy.policy_checks import (
    evaluate_promotion_prerequisites,
    evaluate_rollback_readiness,
)
from app.trading.discovery.autoresearch import StrategyAutoresearchProgram
from app.trading.discovery.mlx_snapshot import MlxSnapshotManifest
from app.trading.discovery.portfolio_candidates import PortfolioCandidateSpec

from .candidate_payloads import (
    RuntimeReplayRequest,
    default_replay_executor,
    materialize_candidate_configmap,
    portfolio_optimizer_evidence,
    portfolio_proof_receipt_payload,
    portfolio_runtime_strategy_names,
    run_runtime_replay,
    runtime_best_candidate_payload,
    runtime_closure_policy,
)
from .context import (
    RuntimeClosureExecutionContext,
    to_mapping,
    runtime_family,
    runtime_strategy_name,
    to_string,
    write_json,
)
from .delay_depth import delay_adjusted_depth_stress_report
from .market_impact import market_impact_stress_report
from .replay_analysis import (
    BacktestSummaryRequest,
    CandidateStateRequest,
    GateReportRequest,
    ReplayAnalysisRequest,
    backtest_summary,
    candidate_generation_manifest,
    candidate_spec,
    candidate_state,
    gate_report,
    replay_analysis,
    shadow_validation_artifact,
    summary_status_and_next_steps,
)
from .walkforward import (
    DoubleOosWalkforwardRequest,
    ProfitabilityStageManifestRequest,
    RuntimeClosureBundleSummary,
    double_oos_walkforward_report,
    profitability_stage_manifest,
    stress_metrics_payload,
)


@dataclass(frozen=True)
class RuntimeClosureBundleRequest:
    run_root: Path
    runner_run_id: str
    program: StrategyAutoresearchProgram
    best_candidate: Mapping[str, Any] | PortfolioCandidateSpec | None
    manifest: MlxSnapshotManifest
    execution_context: RuntimeClosureExecutionContext | None = None
    replay_executor: Any | None = None


@dataclass(frozen=True)
class RuntimeClosurePaths:
    closure_root: Path
    candidate_spec_path: Path
    candidate_generation_manifest_path: Path
    candidate_configmap_path: Path
    gate_report_path: Path
    parity_replay_path: Path
    parity_report_path: Path
    approval_replay_path: Path
    approval_report_path: Path
    shadow_validation_path: Path
    candidate_state_path: Path
    rollback_readiness_artifact_path: Path
    rollback_readiness_evaluation_path: Path
    policy_path: Path
    portfolio_optimizer_evidence_path: Path
    portfolio_proof_receipt_path: Path
    profitability_stage_manifest_path: Path
    promotion_prerequisites_path: Path
    replay_plan_path: Path
    walkforward_results_path: Path
    evaluation_report_path: Path
    market_impact_stress_report_path: Path
    delay_adjusted_depth_stress_report_path: Path
    double_oos_report_path: Path
    stress_metrics_path: Path
    summary_path: Path

    @classmethod
    def from_run_root(cls, run_root: Path) -> RuntimeClosurePaths:
        closure_root = run_root / "runtime-closure"
        return cls(
            closure_root=closure_root,
            candidate_spec_path=closure_root / "research" / "candidate-spec.json",
            candidate_generation_manifest_path=closure_root
            / "research"
            / "candidate-generation-manifest.json",
            candidate_configmap_path=closure_root
            / "replay"
            / "candidate-configmap.yaml",
            gate_report_path=closure_root / "gates" / "gate-evaluation.json",
            parity_replay_path=closure_root
            / "replay"
            / "scheduler-v3-parity-replay.json",
            parity_report_path=closure_root
            / "replay"
            / "scheduler-v3-parity-report.json",
            approval_replay_path=closure_root
            / "replay"
            / "scheduler-v3-approval-replay.json",
            approval_report_path=closure_root
            / "replay"
            / "scheduler-v3-approval-report.json",
            shadow_validation_path=closure_root
            / "replay"
            / "shadow-validation-plan.json",
            candidate_state_path=closure_root / "promotion" / "candidate-state.json",
            rollback_readiness_artifact_path=closure_root
            / "gates"
            / "rollback-readiness.json",
            rollback_readiness_evaluation_path=closure_root
            / "promotion"
            / "rollback-readiness-evaluation.json",
            policy_path=closure_root / "promotion" / "policy.json",
            portfolio_optimizer_evidence_path=closure_root
            / "promotion"
            / "portfolio-optimizer-evidence.json",
            portfolio_proof_receipt_path=closure_root
            / "promotion"
            / "portfolio-proof-receipt.json",
            profitability_stage_manifest_path=closure_root
            / "profitability"
            / "profitability-stage-manifest-v1.json",
            promotion_prerequisites_path=closure_root
            / "promotion"
            / "promotion-prerequisites.json",
            replay_plan_path=closure_root / "replay" / "runtime-replay-plan.json",
            walkforward_results_path=closure_root
            / "backtest"
            / "walkforward-results.json",
            evaluation_report_path=closure_root / "backtest" / "evaluation-report.json",
            market_impact_stress_report_path=closure_root
            / "backtest"
            / "market-impact-stress.json",
            delay_adjusted_depth_stress_report_path=closure_root
            / "backtest"
            / "delay-adjusted-depth-stress.json",
            double_oos_report_path=closure_root
            / "backtest"
            / "double-oos-walkforward.json",
            stress_metrics_path=closure_root / "promotion" / "stress-metrics.json",
            summary_path=closure_root / "summary.json",
        )


@dataclass(frozen=True)
class BundleContext:
    request: RuntimeClosureBundleRequest
    paths: RuntimeClosurePaths
    best_candidate: Mapping[str, Any]
    candidate_id: str


@dataclass(frozen=True)
class ResearchArtifacts:
    policy_payload: Mapping[str, Any]
    portfolio_optimizer_evidence: Mapping[str, Any]


@dataclass(frozen=True)
class ReplayArtifacts:
    parity_report: Mapping[str, Any] | None
    approval_report: Mapping[str, Any] | None


@dataclass(frozen=True)
class StressArtifacts:
    market_impact_stress_report: Mapping[str, Any] | None
    delay_adjusted_depth_stress_report: Mapping[str, Any] | None
    double_oos_report: Mapping[str, Any] | None
    stress_metrics: Mapping[str, Any] | None


@dataclass(frozen=True)
class PolicyEvaluations:
    rollback_readiness: Mapping[str, Any]
    promotion_prerequisites: Mapping[str, Any]


@dataclass(frozen=True)
class ReplayWindowRequest:
    strategy_configmap_path: Path
    window_name: str
    replay_executor: Any
    replay_path: Path
    report_path: Path


def write_runtime_closure_bundle(
    request: RuntimeClosureBundleRequest | None = None,
    **request_kwargs: Any,
) -> RuntimeClosureBundleSummary:
    if request is None:
        request = RuntimeClosureBundleRequest(**request_kwargs)
    elif request_kwargs:
        raise TypeError(
            "runtime closure bundle request cannot be mixed with keyword fields"
        )

    paths = RuntimeClosurePaths.from_run_root(request.run_root)
    if request.best_candidate is None:
        return write_missing_candidate_summary(paths)

    best_candidate = runtime_best_candidate_payload(request.best_candidate)
    context = BundleContext(
        request=request,
        paths=paths,
        best_candidate=best_candidate,
        candidate_id=to_string(best_candidate.get("candidate_id")),
    )
    research = write_research_artifacts(context)
    replay = write_replay_artifacts(context)
    stress = write_stress_artifacts(context, replay)
    shadow_plan = write_shadow_artifact(context)
    write_portfolio_proof_receipt(context, stress)
    gate_report = write_gate_report(
        context,
        research=research,
        replay=replay,
        stress=stress,
        shadow_plan=shadow_plan,
    )
    candidate_state = write_candidate_state(context, replay, shadow_plan)
    rollback_readiness = write_rollback_readiness(
        context,
        research=research,
        candidate_state=candidate_state,
    )
    write_backtest_artifacts(context, replay)
    write_profitability_manifest(context, replay, stress, shadow_plan)
    promotion_prerequisites = write_promotion_prerequisites(
        context,
        research=research,
        gate_report=gate_report,
        candidate_state=candidate_state,
    )
    evaluations = PolicyEvaluations(
        rollback_readiness=rollback_readiness,
        promotion_prerequisites=promotion_prerequisites,
    )
    return write_summary(
        context,
        replay=replay,
        stress=stress,
        shadow_plan=shadow_plan,
        evaluations=evaluations,
    )


def write_missing_candidate_summary(
    paths: RuntimeClosurePaths,
) -> RuntimeClosureBundleSummary:
    summary = RuntimeClosureBundleSummary(
        status="missing_candidate",
        candidate_id="",
        root=str(paths.closure_root),
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
    write_json(paths.summary_path, summary.to_payload())
    return summary


def write_research_artifacts(context: BundleContext) -> ResearchArtifacts:
    request = context.request
    candidate_spec_payload = candidate_spec(
        runner_run_id=request.runner_run_id,
        program=request.program,
        best_candidate=context.best_candidate,
        manifest=request.manifest,
    )
    generation_manifest_payload = candidate_generation_manifest(
        runner_run_id=request.runner_run_id,
        program=request.program,
        best_candidate=context.best_candidate,
        manifest=request.manifest,
    )
    optimizer_evidence_payload = portfolio_optimizer_evidence(context.best_candidate)
    policy_payload = runtime_closure_policy(best_candidate=context.best_candidate)

    write_json(context.paths.candidate_spec_path, candidate_spec_payload)
    write_json(
        context.paths.candidate_generation_manifest_path,
        generation_manifest_payload,
    )
    write_json(context.paths.policy_path, policy_payload)
    if optimizer_evidence_payload:
        write_json(
            context.paths.portfolio_optimizer_evidence_path,
            optimizer_evidence_payload,
        )
    write_json(context.paths.replay_plan_path, runtime_replay_plan(context))
    return ResearchArtifacts(
        policy_payload=policy_payload,
        portfolio_optimizer_evidence=optimizer_evidence_payload,
    )


def runtime_replay_plan(context: BundleContext) -> dict[str, Any]:
    request = context.request
    return {
        "schema_version": "torghut.runtime-closure-replay-plan.v1",
        "candidate_id": context.candidate_id,
        "dataset_snapshot_ref": request.manifest.snapshot_id,
        "source_window_start": request.manifest.source_window_start,
        "source_window_end": request.manifest.source_window_end,
        "runtime_family": runtime_family(context.best_candidate),
        "runtime_strategy_name": runtime_strategy_name(context.best_candidate),
        "runtime_strategy_names": list(
            portfolio_runtime_strategy_names(context.best_candidate)
        ),
        "approval_path": "scheduler_v3",
        "required_steps": [
            "checked_in_runtime_family",
            "scheduler_v3_parity_replay",
            "scheduler_v3_approval_replay",
            "live_shadow_validation",
        ],
        "runtime_closure_policy": request.program.runtime_closure_policy.to_payload(),
        "execution_context": request.execution_context.to_payload()
        if request.execution_context is not None
        else None,
        "recommended_commands": [
            "run scheduler-v3 parity replay for the mapped runtime family on the snapshot window",
            "run scheduler-v3 approval replay on the same candidate family and snapshot contract",
            "attach shadow validation evidence before requesting promotion",
        ],
    }


def write_replay_artifacts(context: BundleContext) -> ReplayArtifacts:
    request = context.request
    parity_report: dict[str, Any] | None = None
    approval_report: dict[str, Any] | None = None
    if not request.program.runtime_closure_policy.enabled:
        return ReplayArtifacts(parity_report=None, approval_report=None)
    if request.execution_context is None:
        return ReplayArtifacts(parity_report=None, approval_report=None)

    replay_runner = request.replay_executor or default_replay_executor
    rendered_configmap_path = materialize_candidate_configmap(
        best_candidate=context.best_candidate,
        execution_context=request.execution_context,
        output_path=context.paths.candidate_configmap_path,
    )
    if request.program.runtime_closure_policy.execute_parity_replay:
        parity_report = write_runtime_replay_window(
            context,
            ReplayWindowRequest(
                strategy_configmap_path=rendered_configmap_path,
                window_name=request.program.runtime_closure_policy.parity_window,
                replay_executor=replay_runner,
                replay_path=context.paths.parity_replay_path,
                report_path=context.paths.parity_report_path,
            ),
        )
    if request.program.runtime_closure_policy.execute_approval_replay:
        approval_report = write_runtime_replay_window(
            context,
            ReplayWindowRequest(
                strategy_configmap_path=rendered_configmap_path,
                window_name=request.program.runtime_closure_policy.approval_window,
                replay_executor=replay_runner,
                replay_path=context.paths.approval_replay_path,
                report_path=context.paths.approval_report_path,
            ),
        )
    return ReplayArtifacts(parity_report=parity_report, approval_report=approval_report)


def write_runtime_replay_window(
    context: BundleContext,
    replay_window: ReplayWindowRequest,
) -> dict[str, Any]:
    request = context.request
    if request.execution_context is None:
        raise ValueError("runtime_closure_execution_context_missing")
    replay_payload = run_runtime_replay(
        RuntimeReplayRequest(
            best_candidate=context.best_candidate,
            manifest=request.manifest,
            execution_context=request.execution_context,
            strategy_configmap_path=replay_window.strategy_configmap_path,
            window_name=replay_window.window_name,
            replay_executor=replay_window.replay_executor,
        )
    )
    write_json(replay_window.replay_path, replay_payload)
    report = replay_analysis(
        ReplayAnalysisRequest(
            window_name=replay_window.window_name,
            replay_payload=replay_payload,
            best_candidate=context.best_candidate,
            program=request.program,
        )
    )
    write_json(replay_window.report_path, report)
    return report


def write_stress_artifacts(
    context: BundleContext,
    replay: ReplayArtifacts,
) -> StressArtifacts:
    market_report: dict[str, Any] | None = None
    delay_report: dict[str, Any] | None = None
    double_oos_report: dict[str, Any] | None = None
    stress_metrics: dict[str, Any] | None = None
    if replay.approval_report is not None:
        market_report = market_impact_stress_report(
            runner_run_id=context.request.runner_run_id,
            best_candidate=context.best_candidate,
            approval_report=replay.approval_report,
            program=context.request.program,
        )
        write_json(context.paths.market_impact_stress_report_path, market_report)
        delay_report = delay_adjusted_depth_stress_report(
            runner_run_id=context.request.runner_run_id,
            best_candidate=context.best_candidate,
            approval_report=replay.approval_report,
            program=context.request.program,
        )
        write_json(context.paths.delay_adjusted_depth_stress_report_path, delay_report)
        stress_metrics = stress_metrics_payload(
            market_impact_report=market_report,
            market_impact_ref=relative(
                context, context.paths.market_impact_stress_report_path
            ),
            delay_depth_report=delay_report,
            delay_depth_ref=relative(
                context,
                context.paths.delay_adjusted_depth_stress_report_path,
            ),
        )
        write_json(context.paths.stress_metrics_path, stress_metrics)
    if replay.parity_report is not None or replay.approval_report is not None:
        double_oos_report = double_oos_walkforward_report(
            DoubleOosWalkforwardRequest(
                runner_run_id=context.request.runner_run_id,
                best_candidate=context.best_candidate,
                parity_report=replay.parity_report,
                approval_report=replay.approval_report,
                market_impact_report=market_report,
                delay_depth_report=delay_report,
                program=context.request.program,
            )
        )
        write_json(context.paths.double_oos_report_path, double_oos_report)
    return StressArtifacts(
        market_impact_stress_report=market_report,
        delay_adjusted_depth_stress_report=delay_report,
        double_oos_report=double_oos_report,
        stress_metrics=stress_metrics,
    )


def write_shadow_artifact(context: BundleContext) -> dict[str, Any]:
    shadow_plan = shadow_validation_artifact(
        best_candidate=context.best_candidate,
        program=context.request.program,
        execution_context=context.request.execution_context,
    )
    write_json(context.paths.shadow_validation_path, shadow_plan)
    return shadow_plan


def write_portfolio_proof_receipt(
    context: BundleContext,
    stress: StressArtifacts,
) -> dict[str, Any]:
    receipt = portfolio_proof_receipt_payload(
        best_candidate=context.best_candidate,
        manifest=context.request.manifest,
        target_net_pnl_per_day=context.request.program.objective.target_net_pnl_per_day,
        runtime_closure_artifact_refs=runtime_closure_artifact_refs(context, stress),
    )
    write_json(context.paths.portfolio_proof_receipt_path, receipt)
    return receipt


def runtime_closure_artifact_refs(
    context: BundleContext,
    stress: StressArtifacts,
) -> tuple[str, ...]:
    refs = [
        relative(context, context.paths.candidate_spec_path),
        relative(context, context.paths.candidate_generation_manifest_path),
        relative(context, context.paths.replay_plan_path),
        relative(context, context.paths.shadow_validation_path),
    ]
    optional_refs = (
        (
            stress.market_impact_stress_report,
            context.paths.market_impact_stress_report_path,
        ),
        (
            stress.delay_adjusted_depth_stress_report,
            context.paths.delay_adjusted_depth_stress_report_path,
        ),
        (stress.double_oos_report, context.paths.double_oos_report_path),
        (stress.stress_metrics, context.paths.stress_metrics_path),
    )
    refs.extend(relative(context, path) for payload, path in optional_refs if payload)
    return tuple(refs)


def write_gate_report(
    context: BundleContext,
    *,
    research: ResearchArtifacts,
    replay: ReplayArtifacts,
    stress: StressArtifacts,
    shadow_plan: Mapping[str, Any],
) -> dict[str, Any]:
    gate_payload = gate_report(
        GateReportRequest(
            runner_run_id=context.request.runner_run_id,
            best_candidate=context.best_candidate,
            promotion_target=context.request.program.runtime_closure_policy.promotion_target,
            parity_report=replay.parity_report,
            approval_report=replay.approval_report,
            shadow_plan=shadow_plan,
            portfolio_optimizer_evidence_ref=existing_relative(
                context,
                context.paths.portfolio_optimizer_evidence_path,
                enabled=bool(research.portfolio_optimizer_evidence),
            ),
            portfolio_proof_receipt_ref=relative(
                context, context.paths.portfolio_proof_receipt_path
            ),
            stress_metrics_ref=existing_relative(
                context,
                context.paths.stress_metrics_path,
                enabled=stress.stress_metrics is not None,
            ),
            stress_metrics_count=int(to_mapping(stress.stress_metrics).get("count", 0)),
        )
    )
    write_json(context.paths.gate_report_path, gate_payload)
    return gate_payload


def write_candidate_state(
    context: BundleContext,
    replay: ReplayArtifacts,
    shadow_plan: Mapping[str, Any],
) -> dict[str, Any]:
    candidate_state_payload = candidate_state(
        CandidateStateRequest(
            runner_run_id=context.request.runner_run_id,
            best_candidate=context.best_candidate,
            manifest=context.request.manifest,
            parity_report=replay.parity_report,
            approval_report=replay.approval_report,
            shadow_plan=shadow_plan,
        )
    )
    write_json(context.paths.candidate_state_path, candidate_state_payload)
    return candidate_state_payload


def write_backtest_artifacts(
    context: BundleContext,
    replay: ReplayArtifacts,
) -> None:
    walkforward_results, evaluation_report = backtest_summary(
        BacktestSummaryRequest(
            runner_run_id=context.request.runner_run_id,
            best_candidate=context.best_candidate,
            manifest=context.request.manifest,
            parity_report=replay.parity_report,
            approval_report=replay.approval_report,
            promotion_target=context.request.program.runtime_closure_policy.promotion_target,
        )
    )
    write_json(context.paths.walkforward_results_path, walkforward_results)
    write_json(context.paths.evaluation_report_path, evaluation_report)


def write_profitability_manifest(
    context: BundleContext,
    replay: ReplayArtifacts,
    stress: StressArtifacts,
    shadow_plan: Mapping[str, Any],
) -> None:
    manifest = profitability_stage_manifest(
        ProfitabilityStageManifestRequest(
            root=context.paths.closure_root,
            runner_run_id=context.request.runner_run_id,
            candidate_id=context.candidate_id,
            candidate_spec_path=context.paths.candidate_spec_path,
            candidate_generation_manifest_path=context.paths.candidate_generation_manifest_path,
            walkforward_results_path=context.paths.walkforward_results_path,
            evaluation_report_path=context.paths.evaluation_report_path,
            gate_report_path=context.paths.gate_report_path,
            rollback_readiness_path=context.paths.rollback_readiness_artifact_path,
            portfolio_optimizer_evidence_path=existing_path(
                context.paths.portfolio_optimizer_evidence_path
            ),
            portfolio_proof_receipt_path=existing_path(
                context.paths.portfolio_proof_receipt_path
            ),
            market_impact_stress_report_path=existing_path(
                context.paths.market_impact_stress_report_path
            ),
            delay_adjusted_depth_stress_report_path=existing_path(
                context.paths.delay_adjusted_depth_stress_report_path
            ),
            double_oos_report_path=existing_path(context.paths.double_oos_report_path),
            stress_metrics_path=existing_path(context.paths.stress_metrics_path),
            parity_replay_path=existing_path(context.paths.parity_replay_path),
            approval_replay_path=existing_path(context.paths.approval_replay_path),
            shadow_validation_path=existing_path(context.paths.shadow_validation_path),
            parity_pass=bool(to_mapping(replay.parity_report).get("objective_met")),
            approval_pass=bool(to_mapping(replay.approval_report).get("objective_met")),
            shadow_status=to_string(shadow_plan.get("status")),
        )
    )
    write_json(context.paths.profitability_stage_manifest_path, manifest)


def write_rollback_readiness(
    context: BundleContext,
    *,
    research: ResearchArtifacts,
    candidate_state: Mapping[str, Any],
) -> Mapping[str, Any]:
    rollback_result = evaluate_rollback_readiness(
        policy_payload=dict(research.policy_payload),
        candidate_state_payload=dict(candidate_state),
    )
    write_json(
        context.paths.rollback_readiness_artifact_path, rollback_result.to_payload()
    )
    write_json(
        context.paths.rollback_readiness_evaluation_path,
        rollback_result.to_payload(),
    )
    return rollback_result.to_payload()


def write_promotion_prerequisites(
    context: BundleContext,
    *,
    research: ResearchArtifacts,
    gate_report: Mapping[str, Any],
    candidate_state: Mapping[str, Any],
) -> Mapping[str, Any]:
    prerequisite_result = evaluate_promotion_prerequisites(
        policy_payload=dict(research.policy_payload),
        gate_report_payload=dict(gate_report),
        candidate_state_payload=dict(candidate_state),
        promotion_target=context.request.program.runtime_closure_policy.promotion_target,
        artifact_root=context.paths.closure_root,
    )
    write_json(
        context.paths.promotion_prerequisites_path,
        prerequisite_result.to_payload(),
    )
    return prerequisite_result.to_payload()


def write_summary(
    context: BundleContext,
    *,
    replay: ReplayArtifacts,
    stress: StressArtifacts,
    shadow_plan: Mapping[str, Any],
    evaluations: PolicyEvaluations,
) -> RuntimeClosureBundleSummary:
    summary_status, next_required_steps = summary_status_and_next_steps(
        parity_report=replay.parity_report,
        approval_report=replay.approval_report,
        shadow_plan=shadow_plan,
    )
    summary = RuntimeClosureBundleSummary(
        status=summary_status,
        candidate_id=context.candidate_id,
        root=str(context.paths.closure_root),
        candidate_spec_path=str(context.paths.candidate_spec_path),
        candidate_generation_manifest_path=str(
            context.paths.candidate_generation_manifest_path
        ),
        candidate_configmap_path=existing_string(
            context.paths.candidate_configmap_path
        ),
        gate_report_path=str(context.paths.gate_report_path),
        parity_replay_path=existing_string(context.paths.parity_replay_path),
        parity_report_path=existing_string(context.paths.parity_report_path),
        approval_replay_path=existing_string(context.paths.approval_replay_path),
        approval_report_path=existing_string(context.paths.approval_report_path),
        shadow_validation_path=str(context.paths.shadow_validation_path),
        candidate_state_path=str(context.paths.candidate_state_path),
        rollback_readiness_artifact_path=str(
            context.paths.rollback_readiness_artifact_path
        ),
        rollback_readiness_evaluation_path=str(
            context.paths.rollback_readiness_evaluation_path
        ),
        policy_path=str(context.paths.policy_path),
        portfolio_optimizer_evidence_path=existing_string(
            context.paths.portfolio_optimizer_evidence_path
        ),
        portfolio_proof_receipt_path=str(context.paths.portfolio_proof_receipt_path),
        market_impact_stress_report_path=existing_string(
            context.paths.market_impact_stress_report_path,
            enabled=stress.market_impact_stress_report is not None,
        ),
        delay_adjusted_depth_stress_report_path=existing_string(
            context.paths.delay_adjusted_depth_stress_report_path,
            enabled=stress.delay_adjusted_depth_stress_report is not None,
        ),
        double_oos_report_path=existing_string(
            context.paths.double_oos_report_path,
            enabled=stress.double_oos_report is not None,
        ),
        stress_metrics_path=existing_string(
            context.paths.stress_metrics_path,
            enabled=stress.stress_metrics is not None,
        ),
        profitability_stage_manifest_path=str(
            context.paths.profitability_stage_manifest_path
        ),
        promotion_prerequisites_path=str(context.paths.promotion_prerequisites_path),
        replay_plan_path=str(context.paths.replay_plan_path),
        next_required_steps=next_required_steps,
        promotion_prerequisites=evaluations.promotion_prerequisites,
        rollback_readiness=evaluations.rollback_readiness,
    )
    write_json(context.paths.summary_path, summary.to_payload())
    return summary


def relative(context: BundleContext, path: Path) -> str:
    return str(path.relative_to(context.paths.closure_root))


def existing_path(path: Path) -> Path | None:
    return path if path.exists() else None


def existing_string(path: Path, *, enabled: bool = True) -> str:
    return str(path) if enabled and path.exists() else ""


def existing_relative(
    context: BundleContext,
    path: Path,
    *,
    enabled: bool,
) -> str | None:
    return relative(context, path) if enabled and path.exists() else None
