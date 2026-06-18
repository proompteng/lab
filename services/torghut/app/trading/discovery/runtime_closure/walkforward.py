"""Runtime-closure bundle helpers for MLX autoresearch outputs."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping


from app.trading.discovery.autoresearch import (
    StrategyAutoresearchProgram,
)


from .context import (
    to_string,
    to_mapping,
    to_mapping_list,
    to_int,
    to_decimal,
    decimal_to_string,
    sha256_path,
    sha256_json,
    now_iso,
    runtime_run_context,
    runtime_family,
    runtime_strategy_name,
)
from .candidate_payloads import (
    portfolio_runtime_strategy_names,
)
from .market_impact import (
    double_oos_window_row,
    double_oos_cost_shock_net_pnl_per_day,
)


@dataclass(frozen=True)
class DoubleOosWalkforwardRequest:
    runner_run_id: str
    best_candidate: Mapping[str, Any]
    parity_report: Mapping[str, Any] | None
    approval_report: Mapping[str, Any] | None
    market_impact_report: Mapping[str, Any] | None
    delay_depth_report: Mapping[str, Any] | None
    program: StrategyAutoresearchProgram


@dataclass(frozen=True)
class ProfitabilityStageManifestRequest:
    root: Path
    runner_run_id: str
    candidate_id: str
    candidate_spec_path: Path
    candidate_generation_manifest_path: Path
    walkforward_results_path: Path
    evaluation_report_path: Path
    gate_report_path: Path
    rollback_readiness_path: Path
    portfolio_optimizer_evidence_path: Path | None
    portfolio_proof_receipt_path: Path | None
    market_impact_stress_report_path: Path | None
    delay_adjusted_depth_stress_report_path: Path | None
    double_oos_report_path: Path | None
    stress_metrics_path: Path | None
    parity_replay_path: Path | None
    approval_replay_path: Path | None
    shadow_validation_path: Path | None
    parity_pass: bool
    approval_pass: bool
    shadow_status: str


def double_oos_walkforward_report(
    request: DoubleOosWalkforwardRequest,
) -> dict[str, Any]:
    target = request.program.objective.target_net_pnl_per_day
    windows = [
        double_oos_window_row(
            window_id="parity",
            report=request.parity_report,
            target_net_pnl_per_day=target,
        ),
        double_oos_window_row(
            window_id="approval",
            report=request.approval_report,
            target_net_pnl_per_day=target,
        ),
    ]
    observed_windows = [
        row
        for row in windows
        if to_int(row.get("trading_day_count")) > 0 and row.get("status") != "missing"
    ]
    passed_windows = [row for row in observed_windows if bool(row.get("passed"))]
    independent_window_count = len(observed_windows)
    pass_rate = (
        Decimal(len(passed_windows)) / Decimal(independent_window_count)
        if independent_window_count > 0
        else Decimal("0")
    )
    double_oos_net = min(
        (to_decimal(row.get("post_cost_net_pnl_per_day")) for row in observed_windows),
        default=Decimal("0"),
    )
    cost_shock_net = double_oos_cost_shock_net_pnl_per_day(
        double_oos_net_pnl_per_day=double_oos_net,
        market_impact_report=request.market_impact_report,
        delay_depth_report=request.delay_depth_report,
    )
    reasons: list[str] = []
    if independent_window_count < 2:
        reasons.append("double_oos_independent_window_count_below_minimum")
    if pass_rate < Decimal("1"):
        reasons.append("double_oos_pass_rate_below_required")
    if double_oos_net < target:
        reasons.append("double_oos_net_pnl_below_target")
    if request.market_impact_report is None:
        reasons.append("market_impact_stress_missing")
    elif not bool(request.market_impact_report.get("objective_met")):
        reasons.append("market_impact_stress_failed")
    if request.delay_depth_report is None:
        reasons.append("delay_adjusted_depth_stress_missing")
    elif not bool(request.delay_depth_report.get("objective_met")):
        reasons.append("delay_adjusted_depth_stress_failed")
    if cost_shock_net < target:
        reasons.append("double_oos_cost_shock_net_pnl_below_target")
    objective_met = not reasons
    generated_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    return {
        "schema_version": "torghut.double-oos-walkforward-report.v1",
        "run_id": request.runner_run_id,
        "candidate_id": to_string(request.best_candidate.get("candidate_id")),
        "report_id": f"{request.runner_run_id}:{to_string(request.best_candidate.get('candidate_id'))}:double-oos",
        "generated_at": generated_at,
        "checked_at": generated_at,
        "runtime_family": runtime_family(request.best_candidate),
        "runtime_strategy_name": runtime_strategy_name(request.best_candidate),
        "runtime_strategy_names": list(
            portfolio_runtime_strategy_names(request.best_candidate)
        ),
        "source_markers": [
            "double_oos_walkforward_arxiv_2602_10785_2026",
            "double_oos_cost_sensitivity_arxiv_2602_10785_2026",
            "realistic_market_impact_arxiv_2603_29086_2026",
        ],
        "objective_met": objective_met,
        "passed": objective_met,
        "reasons": reasons,
        "target_net_pnl_per_day": decimal_to_string(target),
        "independent_window_count": independent_window_count,
        "window_count": independent_window_count,
        "fold_count": independent_window_count,
        "pass_rate": decimal_to_string(pass_rate),
        "net_pnl_per_day": decimal_to_string(double_oos_net),
        "post_double_oos_net_pnl_per_day": decimal_to_string(double_oos_net),
        "cost_shock_net_pnl_per_day": decimal_to_string(cost_shock_net),
        "post_cost_shock_net_pnl_per_day": decimal_to_string(cost_shock_net),
        "market_impact_stress_passed": bool(
            to_mapping(request.market_impact_report).get("objective_met")
        ),
        "delay_adjusted_depth_stress_passed": bool(
            to_mapping(request.delay_depth_report).get("objective_met")
        ),
        "fold_metrics": windows,
    }


def stress_metrics_payload(
    *,
    market_impact_report: Mapping[str, Any] | None,
    market_impact_ref: str | None,
    delay_depth_report: Mapping[str, Any] | None,
    delay_depth_ref: str | None,
) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    if market_impact_report is not None and market_impact_ref:
        for row_mapping in to_mapping_list(market_impact_report.get("daily")):
            items.append(
                {
                    "case_id": f"market_impact:{to_string(row_mapping.get('day'))}",
                    "stress_type": "market_impact",
                    "artifact_ref": market_impact_ref,
                    "day": to_string(row_mapping.get("day")),
                    "passed": bool(market_impact_report.get("passed")),
                    "participation_rate": to_string(
                        row_mapping.get("participation_rate_proxy")
                    ),
                    "impact_cost_bps": to_string(row_mapping.get("impact_cost_bps")),
                    "impact_cost": to_string(row_mapping.get("impact_cost")),
                    "post_impact_net_pnl": to_string(
                        row_mapping.get("post_impact_net_pnl")
                    ),
                    "liquidity_evidence_source": to_string(
                        row_mapping.get("liquidity_evidence_source")
                    ),
                    "liquidity_notional": to_string(
                        row_mapping.get("liquidity_notional")
                    ),
                }
            )
    if delay_depth_report is not None and delay_depth_ref:
        for row_mapping in to_mapping_list(delay_depth_report.get("daily")):
            items.append(
                {
                    "case_id": f"delay_adjusted_depth:{to_string(row_mapping.get('day'))}",
                    "stress_type": "delay_adjusted_depth",
                    "artifact_ref": delay_depth_ref,
                    "day": to_string(row_mapping.get("day")),
                    "passed": bool(delay_depth_report.get("passed")),
                }
            )
    return {
        "schema_version": "stress-metrics-v1",
        "generated_at": now_iso(),
        "count": len(items),
        "items": items,
    }


def profitability_stage_manifest(
    request: ProfitabilityStageManifestRequest,
) -> dict[str, Any]:
    root = request.root

    def artifact(path: Path, *, stage: str, check: str) -> dict[str, Any]:
        return {
            "path": str(path.relative_to(root)),
            "sha256": sha256_path(path),
            "stage": stage,
            "check": check,
        }

    artifact_hashes = {
        str(request.candidate_spec_path.relative_to(root)): sha256_path(
            request.candidate_spec_path
        ),
        str(request.candidate_generation_manifest_path.relative_to(root)): sha256_path(
            request.candidate_generation_manifest_path
        ),
        str(request.walkforward_results_path.relative_to(root)): sha256_path(
            request.walkforward_results_path
        ),
        str(request.evaluation_report_path.relative_to(root)): sha256_path(
            request.evaluation_report_path
        ),
        str(request.gate_report_path.relative_to(root)): sha256_path(
            request.gate_report_path
        ),
        str(request.rollback_readiness_path.relative_to(root)): sha256_path(
            request.rollback_readiness_path
        ),
    }
    if request.parity_replay_path is not None and request.parity_replay_path.exists():
        artifact_hashes[str(request.parity_replay_path.relative_to(root))] = (
            sha256_path(request.parity_replay_path)
        )
    if (
        request.approval_replay_path is not None
        and request.approval_replay_path.exists()
    ):
        artifact_hashes[str(request.approval_replay_path.relative_to(root))] = (
            sha256_path(request.approval_replay_path)
        )
    if (
        request.shadow_validation_path is not None
        and request.shadow_validation_path.exists()
    ):
        artifact_hashes[str(request.shadow_validation_path.relative_to(root))] = (
            sha256_path(request.shadow_validation_path)
        )
    if (
        request.portfolio_optimizer_evidence_path is not None
        and request.portfolio_optimizer_evidence_path.exists()
    ):
        artifact_hashes[
            str(request.portfolio_optimizer_evidence_path.relative_to(root))
        ] = sha256_path(request.portfolio_optimizer_evidence_path)
    if (
        request.portfolio_proof_receipt_path is not None
        and request.portfolio_proof_receipt_path.exists()
    ):
        artifact_hashes[str(request.portfolio_proof_receipt_path.relative_to(root))] = (
            sha256_path(request.portfolio_proof_receipt_path)
        )
    if (
        request.market_impact_stress_report_path is not None
        and request.market_impact_stress_report_path.exists()
    ):
        artifact_hashes[
            str(request.market_impact_stress_report_path.relative_to(root))
        ] = sha256_path(request.market_impact_stress_report_path)
    if (
        request.delay_adjusted_depth_stress_report_path is not None
        and request.delay_adjusted_depth_stress_report_path.exists()
    ):
        artifact_hashes[
            str(request.delay_adjusted_depth_stress_report_path.relative_to(root))
        ] = sha256_path(request.delay_adjusted_depth_stress_report_path)
    if (
        request.double_oos_report_path is not None
        and request.double_oos_report_path.exists()
    ):
        artifact_hashes[str(request.double_oos_report_path.relative_to(root))] = (
            sha256_path(request.double_oos_report_path)
        )
    if request.stress_metrics_path is not None and request.stress_metrics_path.exists():
        artifact_hashes[str(request.stress_metrics_path.relative_to(root))] = (
            sha256_path(request.stress_metrics_path)
        )
    payload = {
        "schema_version": "profitability-stage-manifest-v1",
        "candidate_id": request.candidate_id,
        "strategy_family": "autoresearch_runtime_closure",
        "llm_artifact_ref": None,
        "router_artifact_ref": "runtime_harness",
        "run_context": runtime_run_context(
            root=root, runner_run_id=request.runner_run_id
        ),
        "stages": {
            "research": {
                "status": "pass",
                "checks": [
                    {"check": "candidate_spec_present", "status": "pass"},
                    {
                        "check": "candidate_generation_manifest_present",
                        "status": "pass",
                    },
                    {"check": "walkforward_results_present", "status": "pass"},
                    {"check": "baseline_evaluation_report_present", "status": "pass"},
                    *(
                        [
                            {
                                "check": "portfolio_optimizer_evidence_present",
                                "status": "pass",
                            }
                        ]
                        if request.portfolio_optimizer_evidence_path is not None
                        and request.portfolio_optimizer_evidence_path.exists()
                        else []
                    ),
                    *(
                        [
                            {
                                "check": "portfolio_proof_receipt_present",
                                "status": "pass",
                            }
                        ]
                        if request.portfolio_proof_receipt_path is not None
                        and request.portfolio_proof_receipt_path.exists()
                        else []
                    ),
                ],
                "artifacts": {
                    "candidate_spec": artifact(
                        request.candidate_spec_path,
                        stage="research",
                        check="candidate_spec_present",
                    ),
                    "candidate_generation_manifest": artifact(
                        request.candidate_generation_manifest_path,
                        stage="research",
                        check="candidate_generation_manifest_present",
                    ),
                    "walkforward_results": artifact(
                        request.walkforward_results_path,
                        stage="research",
                        check="walkforward_results_present",
                    ),
                    "baseline_evaluation_report": artifact(
                        request.evaluation_report_path,
                        stage="research",
                        check="baseline_evaluation_report_present",
                    ),
                    **(
                        {
                            "portfolio_optimizer_evidence": artifact(
                                request.portfolio_optimizer_evidence_path,
                                stage="research",
                                check="portfolio_optimizer_evidence_present",
                            )
                        }
                        if request.portfolio_optimizer_evidence_path is not None
                        and request.portfolio_optimizer_evidence_path.exists()
                        else {}
                    ),
                    **(
                        {
                            "portfolio_proof_receipt": artifact(
                                request.portfolio_proof_receipt_path,
                                stage="research",
                                check="portfolio_proof_receipt_present",
                            )
                        }
                        if request.portfolio_proof_receipt_path is not None
                        and request.portfolio_proof_receipt_path.exists()
                        else {}
                    ),
                },
                "owner": "autoresearch-loop",
                "completed_at_utc": now_iso(),
            },
            "validation": {
                "status": "pass"
                if request.approval_replay_path is not None
                and request.approval_pass
                and request.market_impact_stress_report_path is not None
                and request.market_impact_stress_report_path.exists()
                and request.delay_adjusted_depth_stress_report_path is not None
                and request.delay_adjusted_depth_stress_report_path.exists()
                and request.double_oos_report_path is not None
                and request.double_oos_report_path.exists()
                else "fail",
                "checks": [
                    {"check": "evaluation_report_present", "status": "pass"},
                    {
                        "check": "profitability_benchmark_present",
                        "status": "pass"
                        if request.approval_replay_path is not None
                        else "fail",
                    },
                    {
                        "check": "profitability_evidence_present",
                        "status": "pass"
                        if request.approval_replay_path is not None
                        else "fail",
                    },
                    {
                        "check": "profitability_validation_present",
                        "status": "pass" if request.approval_pass else "fail",
                    },
                    {
                        "check": "market_impact_stress_present",
                        "status": "pass"
                        if request.market_impact_stress_report_path is not None
                        and request.market_impact_stress_report_path.exists()
                        else "fail",
                    },
                    {
                        "check": "delay_adjusted_depth_stress_present",
                        "status": "pass"
                        if request.delay_adjusted_depth_stress_report_path is not None
                        and request.delay_adjusted_depth_stress_report_path.exists()
                        else "fail",
                    },
                    {
                        "check": "double_oos_walkforward_present",
                        "status": "pass"
                        if request.double_oos_report_path is not None
                        and request.double_oos_report_path.exists()
                        else "fail",
                    },
                    {
                        "check": "stress_metrics_present",
                        "status": "pass"
                        if request.stress_metrics_path is not None
                        and request.stress_metrics_path.exists()
                        else "fail",
                    },
                ],
                "artifacts": {
                    "evaluation_report": artifact(
                        request.evaluation_report_path,
                        stage="validation",
                        check="evaluation_report_present",
                    ),
                    **(
                        {
                            "approval_replay": artifact(
                                request.approval_replay_path,
                                stage="validation",
                                check="profitability_benchmark_present",
                            )
                        }
                        if request.approval_replay_path is not None
                        and request.approval_replay_path.exists()
                        else {}
                    ),
                    **(
                        {
                            "market_impact_stress": artifact(
                                request.market_impact_stress_report_path,
                                stage="validation",
                                check="market_impact_stress_present",
                            )
                        }
                        if request.market_impact_stress_report_path is not None
                        and request.market_impact_stress_report_path.exists()
                        else {}
                    ),
                    **(
                        {
                            "delay_adjusted_depth_stress": artifact(
                                request.delay_adjusted_depth_stress_report_path,
                                stage="validation",
                                check="delay_adjusted_depth_stress_present",
                            )
                        }
                        if request.delay_adjusted_depth_stress_report_path is not None
                        and request.delay_adjusted_depth_stress_report_path.exists()
                        else {}
                    ),
                    **(
                        {
                            "double_oos_walkforward": artifact(
                                request.double_oos_report_path,
                                stage="validation",
                                check="double_oos_walkforward_present",
                            )
                        }
                        if request.double_oos_report_path is not None
                        and request.double_oos_report_path.exists()
                        else {}
                    ),
                    **(
                        {
                            "stress_metrics": artifact(
                                request.stress_metrics_path,
                                stage="validation",
                                check="stress_metrics_present",
                            )
                        }
                        if request.stress_metrics_path is not None
                        and request.stress_metrics_path.exists()
                        else {}
                    ),
                },
                "owner": "autoresearch-loop",
                "completed_at_utc": now_iso(),
            },
            "execution": {
                "status": (
                    "pass"
                    if request.parity_pass
                    and request.approval_pass
                    and request.shadow_status in {"within_budget", "skipped"}
                    else "fail"
                ),
                "checks": [
                    {"check": "gate_evaluation_present", "status": "pass"},
                    {
                        "check": "gate_matrix_approval",
                        "status": "pass"
                        if request.parity_pass and request.approval_pass
                        else "fail",
                    },
                    {
                        "check": "drift_gate_approval",
                        "status": "pass"
                        if request.shadow_status in {"within_budget", "skipped"}
                        else "fail",
                    },
                ],
                "artifacts": {
                    "gate_evaluation": artifact(
                        request.gate_report_path,
                        stage="execution",
                        check="gate_evaluation_present",
                    ),
                    **(
                        {
                            "parity_replay": artifact(
                                request.parity_replay_path,
                                stage="execution",
                                check="gate_matrix_approval",
                            )
                        }
                        if request.parity_replay_path is not None
                        and request.parity_replay_path.exists()
                        else {}
                    ),
                    **(
                        {
                            "shadow_validation": artifact(
                                request.shadow_validation_path,
                                stage="execution",
                                check="drift_gate_approval",
                            )
                        }
                        if request.shadow_validation_path is not None
                        and request.shadow_validation_path.exists()
                        else {}
                    ),
                },
                "owner": "autoresearch-loop",
                "completed_at_utc": now_iso(),
            },
            "governance": {
                "status": "fail",
                "checks": [
                    {"check": "rollback_ready", "status": "fail"},
                    {"check": "gate_report_present", "status": "pass"},
                    {"check": "candidate_spec_present", "status": "pass"},
                    {"check": "rollback_readiness_present", "status": "pass"},
                    {"check": "risk_controls_attestable", "status": "pass"},
                ],
                "artifacts": {
                    "candidate_spec": artifact(
                        request.candidate_spec_path,
                        stage="governance",
                        check="candidate_spec_present",
                    ),
                    "gate_evaluation": artifact(
                        request.gate_report_path,
                        stage="governance",
                        check="gate_report_present",
                    ),
                    "rollback_readiness": artifact(
                        request.rollback_readiness_path,
                        stage="governance",
                        check="rollback_readiness_present",
                    ),
                },
                "owner": "autoresearch-loop",
                "completed_at_utc": now_iso(),
            },
        },
        "overall_status": "fail",
        "failure_reasons": list(
            dict.fromkeys(
                [
                    *([] if request.approval_pass else ["validation_stage_incomplete"]),
                    *(
                        []
                        if request.parity_pass
                        and request.approval_pass
                        and request.shadow_status in {"within_budget", "skipped"}
                        else ["execution_stage_incomplete"]
                    ),
                    "governance_stage_incomplete",
                ]
            )
        ),
        "replay_contract": {
            "artifact_hashes": artifact_hashes,
            "contract_hash": sha256_json({"artifact_hashes": artifact_hashes}),
            "hash_algorithm": "sha256",
        },
        "rollback_contract_ref": str(request.rollback_readiness_path.relative_to(root)),
        "created_at_utc": now_iso(),
    }
    payload["content_hash"] = sha256_json(
        {key: value for key, value in payload.items() if key != "content_hash"}
    )
    return payload


@dataclass(frozen=True)
class RuntimeClosureBundleSummary:
    status: str
    candidate_id: str
    root: str
    candidate_spec_path: str
    candidate_generation_manifest_path: str
    candidate_configmap_path: str
    gate_report_path: str
    parity_replay_path: str
    parity_report_path: str
    approval_replay_path: str
    approval_report_path: str
    shadow_validation_path: str
    candidate_state_path: str
    rollback_readiness_artifact_path: str
    rollback_readiness_evaluation_path: str
    policy_path: str
    portfolio_optimizer_evidence_path: str
    portfolio_proof_receipt_path: str
    market_impact_stress_report_path: str
    delay_adjusted_depth_stress_report_path: str
    double_oos_report_path: str
    stress_metrics_path: str
    profitability_stage_manifest_path: str
    promotion_prerequisites_path: str
    replay_plan_path: str
    next_required_steps: tuple[str, ...]
    promotion_prerequisites: Mapping[str, Any]
    rollback_readiness: Mapping[str, Any]

    def to_payload(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "candidate_id": self.candidate_id,
            "root": self.root,
            "candidate_spec_path": self.candidate_spec_path,
            "candidate_generation_manifest_path": self.candidate_generation_manifest_path,
            "candidate_configmap_path": self.candidate_configmap_path,
            "gate_report_path": self.gate_report_path,
            "parity_replay_path": self.parity_replay_path,
            "parity_report_path": self.parity_report_path,
            "approval_replay_path": self.approval_replay_path,
            "approval_report_path": self.approval_report_path,
            "shadow_validation_path": self.shadow_validation_path,
            "candidate_state_path": self.candidate_state_path,
            "rollback_readiness_artifact_path": self.rollback_readiness_artifact_path,
            "rollback_readiness_evaluation_path": self.rollback_readiness_evaluation_path,
            "policy_path": self.policy_path,
            "portfolio_optimizer_evidence_path": self.portfolio_optimizer_evidence_path,
            "portfolio_proof_receipt_path": self.portfolio_proof_receipt_path,
            "market_impact_stress_report_path": self.market_impact_stress_report_path,
            "delay_adjusted_depth_stress_report_path": self.delay_adjusted_depth_stress_report_path,
            "double_oos_report_path": self.double_oos_report_path,
            "stress_metrics_path": self.stress_metrics_path,
            "profitability_stage_manifest_path": self.profitability_stage_manifest_path,
            "promotion_prerequisites_path": self.promotion_prerequisites_path,
            "replay_plan_path": self.replay_plan_path,
            "next_required_steps": list(self.next_required_steps),
            "promotion_prerequisites": dict(self.promotion_prerequisites),
            "rollback_readiness": dict(self.rollback_readiness),
        }
