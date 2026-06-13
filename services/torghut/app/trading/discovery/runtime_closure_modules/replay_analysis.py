"""Runtime-closure bundle helpers for MLX autoresearch outputs."""

from __future__ import annotations

import json
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Mapping, cast


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
    build_scorecard,
    evaluate_vetoes,
)
from app.trading.reporting import summarize_replay_profitability


from .context import (
    to_string,
    to_mapping,
    to_int,
    to_float,
    now_iso,
    RuntimeClosureExecutionContext,
    daily_filled_notional,
    daily_liquidity_notional,
    runtime_execution_realism_summary,
    max_drawdown_from_daily_net,
    rolling_lower_bound,
    max_best_day_share_of_total_pnl,
    objective_veto_policy,
    runtime_family,
    runtime_strategy_name,
    candidate_params,
    candidate_strategy_overrides,
    disable_other_strategies,
)
from .candidate_payloads import (
    portfolio_optimizer_evidence,
    portfolio_runtime_strategy_names,
    portfolio_promotion_v2,
)


@dataclass(frozen=True)
class ReplayAnalysisRequest:
    window_name: str
    replay_payload: Mapping[str, Any]
    best_candidate: Mapping[str, Any]
    program: StrategyAutoresearchProgram


@dataclass(frozen=True)
class GateReportRequest:
    runner_run_id: str
    best_candidate: Mapping[str, Any]
    promotion_target: str
    parity_report: Mapping[str, Any] | None
    approval_report: Mapping[str, Any] | None
    shadow_plan: Mapping[str, Any]
    portfolio_optimizer_evidence_ref: str | None = None
    portfolio_proof_receipt_ref: str | None = None
    stress_metrics_ref: str | None = None
    stress_metrics_count: int = 0


@dataclass(frozen=True)
class CandidateStateRequest:
    runner_run_id: str
    best_candidate: Mapping[str, Any]
    manifest: MlxSnapshotManifest
    parity_report: Mapping[str, Any] | None
    approval_report: Mapping[str, Any] | None
    shadow_plan: Mapping[str, Any]


@dataclass(frozen=True)
class BacktestSummaryRequest:
    runner_run_id: str
    best_candidate: Mapping[str, Any]
    manifest: MlxSnapshotManifest
    parity_report: Mapping[str, Any] | None
    approval_report: Mapping[str, Any] | None
    promotion_target: str


@dataclass(frozen=True)
class ReplayDecompositionMetrics:
    payload: dict[str, Any] | None
    error: str
    regime_pass_rate: Decimal
    symbol_concentration: Decimal
    family_contribution: Decimal


def replay_decomposition_metrics(
    best_candidate: Mapping[str, Any],
    replay_payload: Mapping[str, Any],
) -> ReplayDecompositionMetrics:
    family_template_id = to_string(best_candidate.get("family_template_id"))
    normalization_regime = to_string(best_candidate.get("normalization_regime"))
    try:
        decomposition = build_replay_decomposition(
            replay_payload=replay_payload,
            family_id=family_template_id,
            normalization_regime=normalization_regime or None,
        )
        return ReplayDecompositionMetrics(
            payload=decomposition.to_payload(),
            error="",
            regime_pass_rate=regime_slice_pass_rate(decomposition),
            symbol_concentration=max_symbol_concentration_share(decomposition),
            family_contribution=max_family_contribution_share(decomposition),
        )
    except Exception as exc:
        return ReplayDecompositionMetrics(
            payload=None,
            error=str(exc),
            regime_pass_rate=Decimal("0"),
            symbol_concentration=Decimal("1"),
            family_contribution=Decimal("1"),
        )


def replay_analysis(
    request: ReplayAnalysisRequest,
) -> dict[str, Any]:
    summary = summarize_replay_profitability(request.replay_payload)
    total_filled_notional = sum(
        daily_filled_notional(request.replay_payload).values(), Decimal("0")
    )
    positive_days = sum(1 for value in summary.daily_net.values() if value > 0)
    negative_days = sum(1 for value in summary.daily_net.values() if value < 0)
    decomposition = replay_decomposition_metrics(
        best_candidate=request.best_candidate,
        replay_payload=request.replay_payload,
    )

    scorecard = build_scorecard(
        candidate_id=to_string(request.best_candidate.get("candidate_id")),
        trading_day_count=summary.trading_day_count,
        net_pnl_per_day=summary.net_per_day,
        active_days=summary.active_days,
        positive_days=positive_days,
        avg_filled_notional_per_day=(
            total_filled_notional / Decimal(summary.trading_day_count)
            if summary.trading_day_count > 0
            else Decimal("0")
        ),
        avg_filled_notional_per_active_day=(
            total_filled_notional / Decimal(summary.active_days)
            if summary.active_days > 0
            else Decimal("0")
        ),
        worst_day_loss=abs(summary.worst_day_net)
        if summary.worst_day_net < 0
        else Decimal("0"),
        max_drawdown=max_drawdown_from_daily_net(summary.daily_net),
        best_day_share=max_best_day_share_of_total_pnl(
            daily_net=summary.daily_net,
            total_net_pnl=summary.net_pnl,
        ),
        negative_day_count=negative_days,
        rolling_3d_lower_bound=rolling_lower_bound(summary.daily_net, window=3),
        rolling_5d_lower_bound=rolling_lower_bound(summary.daily_net, window=5),
        regime_slice_pass_rate=decomposition.regime_pass_rate,
        symbol_concentration_share=decomposition.symbol_concentration,
        entry_family_contribution_share=decomposition.family_contribution,
    )
    hard_vetoes = list(
        evaluate_vetoes(
            scorecard,
            policy=objective_veto_policy(request.program),
            is_fresh=True,
        )
    )
    replay_candidate = {
        "candidate_id": to_string(request.best_candidate.get("candidate_id")),
        "objective_scorecard": scorecard.to_payload(),
        "full_window": {
            "trading_day_count": summary.trading_day_count,
            "active_days": summary.active_days,
        },
        "hard_vetoes": hard_vetoes,
    }
    objective_met = candidate_meets_objective(
        replay_candidate, objective=request.program.objective
    )
    return {
        "schema_version": "torghut.runtime-closure-replay-report.v1",
        "window_name": request.window_name,
        "candidate_id": to_string(request.best_candidate.get("candidate_id")),
        "runtime_family": runtime_family(request.best_candidate),
        "runtime_strategy_name": runtime_strategy_name(request.best_candidate),
        "runtime_strategy_names": list(
            portfolio_runtime_strategy_names(request.best_candidate)
        ),
        "objective_met": objective_met,
        "hard_vetoes": hard_vetoes,
        "scorecard": scorecard.to_payload(),
        "summary": {
            "start_date": summary.start_date,
            "end_date": summary.end_date,
            "trading_day_count": summary.trading_day_count,
            "net_pnl": str(summary.net_pnl),
            "net_per_day": str(summary.net_per_day),
            "active_days": summary.active_days,
            "decision_count": summary.decision_count,
            "filled_count": summary.filled_count,
            "wins": summary.wins,
            "losses": summary.losses,
            "worst_day_net": str(summary.worst_day_net),
            "profit_factor": str(summary.profit_factor)
            if summary.profit_factor is not None
            else None,
            "positive_days": positive_days,
            "negative_days": negative_days,
            "daily_net": {day: str(value) for day, value in summary.daily_net.items()},
            "daily_filled_notional": {
                day: str(value)
                for day, value in daily_filled_notional(request.replay_payload).items()
            },
            "daily_liquidity_notional": {
                day: str(value)
                for day, value in daily_liquidity_notional(
                    request.replay_payload
                ).items()
            },
            **runtime_execution_realism_summary(request.replay_payload),
        },
        "decomposition": decomposition.payload,
        "decomposition_error": decomposition.error or None,
    }


def shadow_validation_artifact(
    *,
    best_candidate: Mapping[str, Any],
    program: StrategyAutoresearchProgram,
    execution_context: RuntimeClosureExecutionContext | None,
) -> dict[str, Any]:
    mode = program.runtime_closure_policy.shadow_validation_mode
    if mode != "require_live_evidence":
        return {
            "schema_version": "torghut.runtime-closure-shadow-validation-plan.v1",
            "candidate_id": to_string(best_candidate.get("candidate_id")),
            "mode": mode,
            "status": "skipped",
            "required": False,
            "reasons": [],
            "evidence_loaded": False,
            "source_artifact_path": None,
            "source_schema_version": None,
        }

    artifact_path = (
        execution_context.shadow_validation_artifact_path
        if execution_context is not None
        else None
    )
    if artifact_path is None:
        return {
            "schema_version": "torghut.runtime-closure-shadow-validation-plan.v1",
            "candidate_id": to_string(best_candidate.get("candidate_id")),
            "mode": mode,
            "status": "pending_live_evidence",
            "required": True,
            "reasons": ["live_shadow_evidence_not_available_from_local_autoresearch"],
            "evidence_loaded": False,
            "source_artifact_path": None,
            "source_schema_version": None,
        }

    try:
        payload = json.loads(artifact_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {
            "schema_version": "torghut.runtime-closure-shadow-validation-plan.v1",
            "candidate_id": to_string(best_candidate.get("candidate_id")),
            "mode": mode,
            "status": "invalid_artifact",
            "required": True,
            "reasons": ["shadow_validation_artifact_invalid_json"],
            "evidence_loaded": False,
            "source_artifact_path": str(artifact_path),
            "source_schema_version": None,
        }

    source_payload = to_mapping(payload)
    source_schema_version = to_string(source_payload.get("schema_version"))
    status = to_string(source_payload.get("status")) or "invalid_artifact"
    reasons: list[str] = []
    if source_schema_version != "shadow-live-deviation-report-v1":
        reasons.append("shadow_validation_schema_version_invalid")
        status = "invalid_artifact"
    elif status == "within_budget":
        pass
    elif status in {"pending_live_evidence", "pending"}:
        reasons.append("shadow_validation_pending")
    else:
        reasons.append("shadow_validation_status_not_within_budget")

    return {
        "schema_version": "torghut.runtime-closure-shadow-validation-plan.v1",
        "candidate_id": to_string(best_candidate.get("candidate_id")),
        "mode": mode,
        "status": status,
        "required": True,
        "reasons": reasons,
        "evidence_loaded": source_schema_version == "shadow-live-deviation-report-v1",
        "source_artifact_path": str(artifact_path),
        "source_schema_version": source_schema_version,
        "order_count": to_int(source_payload.get("order_count")),
        "coverage_error": source_payload.get("coverage_error"),
    }


def summary_status_and_next_steps(
    *,
    parity_report: Mapping[str, Any] | None,
    approval_report: Mapping[str, Any] | None,
    shadow_plan: Mapping[str, Any],
) -> tuple[str, tuple[str, ...]]:
    parity_pass = (
        bool(to_mapping(parity_report).get("objective_met"))
        if parity_report is not None
        else False
    )
    approval_pass = (
        bool(to_mapping(approval_report).get("objective_met"))
        if approval_report is not None
        else False
    )
    shadow_required = bool(shadow_plan.get("required"))
    shadow_status = to_string(shadow_plan.get("status"))
    shadow_ready = shadow_status == "within_budget"

    if parity_report is None:
        status = "pending_runtime_parity"
        next_steps = (
            "scheduler_v3_parity_replay",
            "scheduler_v3_approval_replay",
            *(() if not shadow_required else ("live_shadow_validation",)),
        )
    elif not parity_pass:
        status = "runtime_parity_failed"
        next_steps = ("scheduler_v3_parity_replay",)
    elif approval_report is None:
        status = "pending_approval_replay"
        next_steps = (
            "scheduler_v3_approval_replay",
            *(() if not shadow_required else ("live_shadow_validation",)),
        )
    elif not approval_pass:
        status = "approval_replay_failed"
        next_steps = ("scheduler_v3_approval_replay",)
    elif shadow_required and shadow_status in {"pending_live_evidence", "pending", ""}:
        status = "pending_shadow_validation"
        next_steps = ("live_shadow_validation", "promotion_review")
    elif shadow_required and not shadow_ready:
        status = "shadow_validation_failed"
        next_steps = ("live_shadow_validation",)
    else:
        status = "ready_for_promotion_review"
        next_steps = ("promotion_review",)
    return status, next_steps


def candidate_spec(
    *,
    runner_run_id: str,
    program: StrategyAutoresearchProgram,
    best_candidate: Mapping[str, Any],
    manifest: MlxSnapshotManifest,
) -> dict[str, Any]:
    replay_config = to_mapping(best_candidate.get("replay_config"))
    promotion_payload = portfolio_promotion_v2(best_candidate)
    optimizer_evidence_payload = portfolio_optimizer_evidence(best_candidate)
    return {
        "schema_version": "torghut.runtime-closure-candidate-spec.v1",
        "candidate_id": to_string(best_candidate.get("candidate_id")),
        "runner_run_id": runner_run_id,
        "program_id": program.program_id,
        "family_template_id": to_string(best_candidate.get("family_template_id")),
        "runtime_family": runtime_family(best_candidate),
        "runtime_strategy_name": runtime_strategy_name(best_candidate),
        "runtime_strategy_names": list(
            portfolio_runtime_strategy_names(best_candidate)
        ),
        "dataset_snapshot_ref": manifest.snapshot_id,
        "source_window_start": manifest.source_window_start,
        "source_window_end": manifest.source_window_end,
        "objective_scope": to_string(best_candidate.get("objective_scope"))
        or "research_only",
        "objective_met": bool(best_candidate.get("objective_met")),
        "status": to_string(best_candidate.get("status")),
        "mutation_label": to_string(best_candidate.get("mutation_label")),
        "parent_candidate_id": to_string(best_candidate.get("parent_candidate_id")),
        "candidate_params": candidate_params(best_candidate),
        "candidate_strategy_overrides": candidate_strategy_overrides(best_candidate),
        "disable_other_strategies": disable_other_strategies(best_candidate),
        "train_start_date": to_string(best_candidate.get("train_start_date"))
        or to_string(replay_config.get("train_start_date")),
        "train_end_date": to_string(best_candidate.get("train_end_date"))
        or to_string(replay_config.get("train_end_date")),
        "holdout_start_date": to_string(best_candidate.get("holdout_start_date"))
        or to_string(replay_config.get("holdout_start_date")),
        "holdout_end_date": to_string(best_candidate.get("holdout_end_date"))
        or to_string(replay_config.get("holdout_end_date")),
        "full_window_start_date": to_string(
            best_candidate.get("full_window_start_date")
        )
        or to_string(replay_config.get("full_window_start_date"))
        or manifest.source_window_start,
        "full_window_end_date": to_string(best_candidate.get("full_window_end_date"))
        or to_string(replay_config.get("full_window_end_date"))
        or manifest.source_window_end,
        "normalization_regime": to_string(best_candidate.get("normalization_regime")),
        "descriptor": {
            "descriptor_id": to_string(best_candidate.get("descriptor_id")),
            "entry_window_start_minute": to_int(
                best_candidate.get("entry_window_start_minute")
            ),
            "entry_window_end_minute": to_int(
                best_candidate.get("entry_window_end_minute")
            ),
            "max_hold_minutes": to_int(best_candidate.get("max_hold_minutes")),
            "rank_count": to_int(best_candidate.get("rank_count")),
            "requires_prev_day_features": bool(
                best_candidate.get("requires_prev_day_features")
            ),
            "requires_cross_sectional_features": bool(
                best_candidate.get("requires_cross_sectional_features")
            ),
            "requires_quote_quality_gate": bool(
                best_candidate.get("requires_quote_quality_gate")
            ),
        },
        "metrics": {
            "net_pnl_per_day": to_string(best_candidate.get("net_pnl_per_day")),
            "active_day_ratio": to_string(best_candidate.get("active_day_ratio")),
            "positive_day_ratio": to_string(best_candidate.get("positive_day_ratio")),
            "best_day_share": to_string(best_candidate.get("best_day_share")),
            "worst_day_loss": to_string(best_candidate.get("worst_day_loss")),
            "max_drawdown": to_string(best_candidate.get("max_drawdown")),
            "proposal_score": to_float(best_candidate.get("proposal_score")),
            "proposal_rank": to_int(best_candidate.get("proposal_rank")),
        },
        "promotion_contract": {
            "status": to_string(best_candidate.get("promotion_status")),
            "stage": to_string(best_candidate.get("promotion_stage")),
            "reason": to_string(best_candidate.get("promotion_reason")),
            "blockers": list(
                cast(list[str], best_candidate.get("promotion_blockers") or [])
            ),
            "required_evidence": list(
                cast(list[str], best_candidate.get("promotion_required_evidence") or [])
            ),
        },
        **(
            {"portfolio_optimizer_evidence": optimizer_evidence_payload}
            if optimizer_evidence_payload
            else {}
        ),
        **({"portfolio_promotion_v2": promotion_payload} if promotion_payload else {}),
    }


def candidate_generation_manifest(
    *,
    runner_run_id: str,
    program: StrategyAutoresearchProgram,
    best_candidate: Mapping[str, Any],
    manifest: MlxSnapshotManifest,
) -> dict[str, Any]:
    return {
        "schema_version": "torghut.runtime-closure-generation-manifest.v1",
        "runner_run_id": runner_run_id,
        "program_id": program.program_id,
        "candidate_id": to_string(best_candidate.get("candidate_id")),
        "dataset_snapshot_ref": manifest.snapshot_id,
        "proposal_score": to_float(best_candidate.get("proposal_score")),
        "proposal_rank": to_int(best_candidate.get("proposal_rank")),
        "proposal_selected": bool(best_candidate.get("proposal_selected")),
        "proposal_selection_reason": to_string(
            best_candidate.get("proposal_selection_reason")
        ),
        "mutation_label": to_string(best_candidate.get("mutation_label")),
        "status": to_string(best_candidate.get("status")),
        "runtime_strategy_names": list(
            portfolio_runtime_strategy_names(best_candidate)
        ),
        "runtime_closure_policy": program.runtime_closure_policy.to_payload(),
    }


def gate_report(request: GateReportRequest) -> dict[str, Any]:
    candidate_runtime_family = runtime_family(request.best_candidate) or "unknown"
    parity_pass = (
        bool(to_mapping(request.parity_report).get("objective_met"))
        if request.parity_report is not None
        else False
    )
    approval_pass = (
        bool(to_mapping(request.approval_report).get("objective_met"))
        if request.approval_report is not None
        else False
    )
    shadow_required = bool(request.shadow_plan.get("required"))
    shadow_status = to_string(request.shadow_plan.get("status"))
    shadow_ready = shadow_status == "within_budget"
    promotion_payload = portfolio_promotion_v2(request.best_candidate)
    optimizer_evidence_payload = portfolio_optimizer_evidence(request.best_candidate)
    promotion_reasons: list[str] = []
    if request.parity_report is None:
        promotion_reasons.append("research_candidate_pending_scheduler_v3_parity")
    elif not parity_pass:
        promotion_reasons.append("scheduler_v3_parity_failed")
    if request.approval_report is None:
        promotion_reasons.append("research_candidate_pending_scheduler_v3_approval")
    elif not approval_pass:
        promotion_reasons.append("scheduler_v3_approval_failed")
    if shadow_required and shadow_status in {"pending_live_evidence", "pending", ""}:
        promotion_reasons.append("research_candidate_pending_shadow_validation")
    elif shadow_required and not shadow_ready:
        promotion_reasons.append("shadow_validation_failed")
    throughput_source = request.approval_report or request.parity_report
    throughput_summary = (
        to_mapping(to_mapping(throughput_source).get("summary"))
        if throughput_source is not None
        else {}
    )
    return {
        "run_id": request.runner_run_id,
        "promotion_allowed": False,
        "recommended_mode": request.promotion_target,
        "dependency_quorum": {
            "decision": "allow",
            "reasons": [],
            "message": "Autoresearch runtime closure artifacts are local-only and do not require live actuation.",
        },
        "alpha_readiness": {
            "mode": "candidate_alignment_v1",
            "registry_loaded": True,
            "registry_path": "runtime_harness",
            "registry_errors": [],
            "strategy_families": [candidate_runtime_family],
            "matched_hypothesis_ids": [
                to_string(request.best_candidate.get("family_template_id"))
            ],
            "missing_strategy_families": [],
            "promotion_eligible": False,
            "reasons": list(promotion_reasons),
        },
        "throughput": {
            "signal_count": int(throughput_summary.get("decision_count") or 0),
            "decision_count": int(throughput_summary.get("decision_count") or 0),
            "trade_count": int(throughput_summary.get("filled_count") or 0),
            "no_signal_window": int(throughput_summary.get("filled_count") or 0) <= 0,
            "no_signal_reason": "no_runtime_fills_in_closure_window"
            if int(throughput_summary.get("filled_count") or 0) <= 0
            else None,
        },
        "gates": [
            {"gate_id": "gate0_data_integrity", "status": "pass"},
            {
                "gate_id": "gate1_scheduler_v3_parity_replay",
                "status": "pass"
                if parity_pass
                else ("fail" if request.parity_report is not None else "pending"),
            },
            {
                "gate_id": "gate2_scheduler_v3_approval_replay",
                "status": "pass"
                if approval_pass
                else ("fail" if request.approval_report is not None else "pending"),
            },
            {
                "gate_id": "gate3_shadow_validation",
                "status": (
                    "pass"
                    if shadow_ready
                    else (
                        "pending"
                        if shadow_required
                        and shadow_status in {"pending_live_evidence", "pending", ""}
                        else ("fail" if shadow_required else "skip")
                    )
                ),
            },
        ],
        "promotion_evidence": {
            "promotion_rationale": {
                "requested_target": request.promotion_target,
                "gate_recommended_mode": request.promotion_target,
                "gate_reasons": list(promotion_reasons),
                "shadow_validation_status": shadow_status,
                "rationale_text": "Runtime closure replays executed, but promotion stays blocked until parity, approval, and shadow requirements are satisfied.",
            },
            **(
                {
                    "portfolio_proof": {
                        "artifact_ref": request.portfolio_proof_receipt_ref,
                    },
                }
                if request.portfolio_proof_receipt_ref
                else {}
            ),
            **(
                {
                    "portfolio_optimizer": {
                        "artifact_ref": request.portfolio_optimizer_evidence_ref,
                        "schema_version": optimizer_evidence_payload["schema_version"],
                        "portfolio_candidate_id": optimizer_evidence_payload[
                            "portfolio_candidate_id"
                        ],
                        "target_met": optimizer_evidence_payload["target_met"],
                        "oracle_passed": optimizer_evidence_payload["oracle_passed"],
                        "sleeve_count": optimizer_evidence_payload["sleeve_count"],
                    }
                }
                if optimizer_evidence_payload
                and request.portfolio_optimizer_evidence_ref
                else {}
            ),
            **(
                {
                    "stress_metrics": {
                        "artifact_ref": request.stress_metrics_ref,
                        "count": request.stress_metrics_count,
                    }
                }
                if request.stress_metrics_ref
                else {}
            ),
        },
        "uncertainty_gate_action": "abstain",
        "coverage_error": (
            "0.0"
            if parity_pass and approval_pass and (not shadow_required or shadow_ready)
            else "1.0"
        ),
        "recalibration_run_id": None,
        **(
            {"vnext": {"portfolio_promotion": promotion_payload}}
            if promotion_payload
            else {}
        ),
    }


def candidate_state(request: CandidateStateRequest) -> dict[str, Any]:
    dependency_quorum: dict[str, Any] = {
        "decision": "allow",
        "reasons": [],
        "message": "Local runtime-closure planning is allowed.",
    }
    reasons: list[str] = []
    if request.parity_report is None:
        reasons.append("runtime_parity_not_completed")
    elif not bool(to_mapping(request.parity_report).get("objective_met")):
        reasons.append("runtime_parity_failed")
    if request.approval_report is None:
        reasons.append("approval_replay_not_completed")
    elif not bool(to_mapping(request.approval_report).get("objective_met")):
        reasons.append("approval_replay_failed")
    if bool(request.shadow_plan.get("required")):
        shadow_status = to_string(request.shadow_plan.get("status"))
        if shadow_status in {"pending_live_evidence", "pending", ""}:
            reasons.append("shadow_validation_pending")
        elif shadow_status != "within_budget":
            reasons.append("shadow_validation_failed")
    return {
        "candidateId": to_string(request.best_candidate.get("candidate_id")),
        "runId": request.runner_run_id,
        "activeStage": "runtime-closure",
        "paused": False,
        "datasetSnapshotRef": request.manifest.snapshot_id,
        "noSignalReason": None,
        "dependencyQuorum": dependency_quorum,
        "alphaReadiness": {
            "mode": "candidate_alignment_v1",
            "registry_loaded": True,
            "registry_path": "runtime_harness",
            "registry_errors": [],
            "strategy_families": [runtime_family(request.best_candidate)],
            "matched_hypothesis_ids": [
                to_string(request.best_candidate.get("family_template_id"))
            ],
            "missing_strategy_families": [],
            "promotion_eligible": False,
            "reasons": reasons,
            "dependency_quorum": dependency_quorum,
        },
        "rollbackReadiness": {
            "killSwitchDryRunPassed": False,
            "gitopsRevertDryRunPassed": False,
            "strategyDisableDryRunPassed": False,
            "dryRunCompletedAt": "",
            "humanApproved": False,
            "rollbackTarget": "",
        },
    }


def backtest_summary(
    request: BacktestSummaryRequest,
) -> tuple[dict[str, Any], dict[str, Any]]:
    walkforward = {
        "schema_version": "torghut.runtime-closure-walkforward-results.v1",
        "run_id": request.runner_run_id,
        "candidate_id": to_string(request.best_candidate.get("candidate_id")),
        "dataset_snapshot_ref": request.manifest.snapshot_id,
        "status": "research_only",
        "runtime_family": runtime_family(request.best_candidate),
        "runtime_strategy_name": runtime_strategy_name(request.best_candidate),
        "runtime_strategy_names": list(
            portfolio_runtime_strategy_names(request.best_candidate)
        ),
        "parity_replay": dict(request.parity_report or {}),
        "approval_replay": dict(request.approval_report or {}),
    }
    approval_metrics = (
        to_mapping(to_mapping(request.approval_report).get("scorecard"))
        if request.approval_report is not None
        else {}
    )
    evaluation = {
        "report_version": "torghut.runtime-closure-evaluation-report.v1",
        "generated_at": now_iso(),
        "run_id": request.runner_run_id,
        "candidate_id": to_string(request.best_candidate.get("candidate_id")),
        "promotion_target": request.promotion_target,
        "recommended_mode": request.promotion_target,
        "promotion_allowed": False,
        "objective_met": bool(to_mapping(request.approval_report).get("objective_met"))
        if request.approval_report is not None
        else False,
        "metrics": approval_metrics,
        "parity_replay": dict(request.parity_report or {}),
        "approval_replay": dict(request.approval_report or {}),
    }
    return walkforward, evaluation
