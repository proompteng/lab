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


def _double_oos_walkforward_report(
    *,
    runner_run_id: str,
    best_candidate: Mapping[str, Any],
    parity_report: Mapping[str, Any] | None,
    approval_report: Mapping[str, Any] | None,
    market_impact_report: Mapping[str, Any] | None,
    delay_depth_report: Mapping[str, Any] | None,
    program: StrategyAutoresearchProgram,
) -> dict[str, Any]:
    target = program.objective.target_net_pnl_per_day
    windows = [
        _double_oos_window_row(
            window_id="parity",
            report=parity_report,
            target_net_pnl_per_day=target,
        ),
        _double_oos_window_row(
            window_id="approval",
            report=approval_report,
            target_net_pnl_per_day=target,
        ),
    ]
    observed_windows = [
        row
        for row in windows
        if _int(row.get("trading_day_count")) > 0 and row.get("status") != "missing"
    ]
    passed_windows = [row for row in observed_windows if bool(row.get("passed"))]
    independent_window_count = len(observed_windows)
    pass_rate = (
        Decimal(len(passed_windows)) / Decimal(independent_window_count)
        if independent_window_count > 0
        else Decimal("0")
    )
    double_oos_net = min(
        (_decimal(row.get("post_cost_net_pnl_per_day")) for row in observed_windows),
        default=Decimal("0"),
    )
    cost_shock_net = _double_oos_cost_shock_net_pnl_per_day(
        double_oos_net_pnl_per_day=double_oos_net,
        market_impact_report=market_impact_report,
        delay_depth_report=delay_depth_report,
    )
    reasons: list[str] = []
    if independent_window_count < 2:
        reasons.append("double_oos_independent_window_count_below_minimum")
    if pass_rate < Decimal("1"):
        reasons.append("double_oos_pass_rate_below_required")
    if double_oos_net < target:
        reasons.append("double_oos_net_pnl_below_target")
    if market_impact_report is None:
        reasons.append("market_impact_stress_missing")
    elif not bool(market_impact_report.get("objective_met")):
        reasons.append("market_impact_stress_failed")
    if delay_depth_report is None:
        reasons.append("delay_adjusted_depth_stress_missing")
    elif not bool(delay_depth_report.get("objective_met")):
        reasons.append("delay_adjusted_depth_stress_failed")
    if cost_shock_net < target:
        reasons.append("double_oos_cost_shock_net_pnl_below_target")
    objective_met = not reasons
    generated_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    return {
        "schema_version": "torghut.double-oos-walkforward-report.v1",
        "run_id": runner_run_id,
        "candidate_id": _string(best_candidate.get("candidate_id")),
        "report_id": f"{runner_run_id}:{_string(best_candidate.get('candidate_id'))}:double-oos",
        "generated_at": generated_at,
        "checked_at": generated_at,
        "runtime_family": _runtime_family(best_candidate),
        "runtime_strategy_name": _runtime_strategy_name(best_candidate),
        "runtime_strategy_names": list(
            _portfolio_runtime_strategy_names(best_candidate)
        ),
        "source_markers": [
            "double_oos_walkforward_arxiv_2602_10785_2026",
            "double_oos_cost_sensitivity_arxiv_2602_10785_2026",
            "realistic_market_impact_arxiv_2603_29086_2026",
        ],
        "objective_met": objective_met,
        "passed": objective_met,
        "reasons": reasons,
        "target_net_pnl_per_day": _decimal_string(target),
        "independent_window_count": independent_window_count,
        "window_count": independent_window_count,
        "fold_count": independent_window_count,
        "pass_rate": _decimal_string(pass_rate),
        "net_pnl_per_day": _decimal_string(double_oos_net),
        "post_double_oos_net_pnl_per_day": _decimal_string(double_oos_net),
        "cost_shock_net_pnl_per_day": _decimal_string(cost_shock_net),
        "post_cost_shock_net_pnl_per_day": _decimal_string(cost_shock_net),
        "market_impact_stress_passed": bool(
            _mapping(market_impact_report).get("objective_met")
        ),
        "delay_adjusted_depth_stress_passed": bool(
            _mapping(delay_depth_report).get("objective_met")
        ),
        "fold_metrics": windows,
    }


def _stress_metrics_payload(
    *,
    market_impact_report: Mapping[str, Any] | None,
    market_impact_ref: str | None,
    delay_depth_report: Mapping[str, Any] | None,
    delay_depth_ref: str | None,
) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    if market_impact_report is not None and market_impact_ref:
        for row_mapping in _list_of_mappings(market_impact_report.get("daily")):
            items.append(
                {
                    "case_id": f"market_impact:{_string(row_mapping.get('day'))}",
                    "stress_type": "market_impact",
                    "artifact_ref": market_impact_ref,
                    "day": _string(row_mapping.get("day")),
                    "passed": bool(market_impact_report.get("passed")),
                    "participation_rate": _string(
                        row_mapping.get("participation_rate_proxy")
                    ),
                    "impact_cost_bps": _string(row_mapping.get("impact_cost_bps")),
                    "impact_cost": _string(row_mapping.get("impact_cost")),
                    "post_impact_net_pnl": _string(
                        row_mapping.get("post_impact_net_pnl")
                    ),
                    "liquidity_evidence_source": _string(
                        row_mapping.get("liquidity_evidence_source")
                    ),
                    "liquidity_notional": _string(
                        row_mapping.get("liquidity_notional")
                    ),
                }
            )
    if delay_depth_report is not None and delay_depth_ref:
        for row_mapping in _list_of_mappings(delay_depth_report.get("daily")):
            items.append(
                {
                    "case_id": f"delay_adjusted_depth:{_string(row_mapping.get('day'))}",
                    "stress_type": "delay_adjusted_depth",
                    "artifact_ref": delay_depth_ref,
                    "day": _string(row_mapping.get("day")),
                    "passed": bool(delay_depth_report.get("passed")),
                }
            )
    return {
        "schema_version": "stress-metrics-v1",
        "generated_at": _now_iso(),
        "count": len(items),
        "items": items,
    }


def _profitability_stage_manifest(
    *,
    root: Path,
    runner_run_id: str,
    candidate_id: str,
    candidate_spec_path: Path,
    candidate_generation_manifest_path: Path,
    walkforward_results_path: Path,
    evaluation_report_path: Path,
    gate_report_path: Path,
    rollback_readiness_path: Path,
    portfolio_optimizer_evidence_path: Path | None,
    portfolio_proof_receipt_path: Path | None,
    market_impact_stress_report_path: Path | None,
    delay_adjusted_depth_stress_report_path: Path | None,
    double_oos_report_path: Path | None,
    stress_metrics_path: Path | None,
    parity_replay_path: Path | None,
    approval_replay_path: Path | None,
    shadow_validation_path: Path | None,
    parity_pass: bool,
    approval_pass: bool,
    shadow_status: str,
) -> dict[str, Any]:
    def _artifact(path: Path, *, stage: str, check: str) -> dict[str, Any]:
        return {
            "path": str(path.relative_to(root)),
            "sha256": _sha256_path(path),
            "stage": stage,
            "check": check,
        }

    artifact_hashes = {
        str(candidate_spec_path.relative_to(root)): _sha256_path(candidate_spec_path),
        str(candidate_generation_manifest_path.relative_to(root)): _sha256_path(
            candidate_generation_manifest_path
        ),
        str(walkforward_results_path.relative_to(root)): _sha256_path(
            walkforward_results_path
        ),
        str(evaluation_report_path.relative_to(root)): _sha256_path(
            evaluation_report_path
        ),
        str(gate_report_path.relative_to(root)): _sha256_path(gate_report_path),
        str(rollback_readiness_path.relative_to(root)): _sha256_path(
            rollback_readiness_path
        ),
    }
    if parity_replay_path is not None and parity_replay_path.exists():
        artifact_hashes[str(parity_replay_path.relative_to(root))] = _sha256_path(
            parity_replay_path
        )
    if approval_replay_path is not None and approval_replay_path.exists():
        artifact_hashes[str(approval_replay_path.relative_to(root))] = _sha256_path(
            approval_replay_path
        )
    if shadow_validation_path is not None and shadow_validation_path.exists():
        artifact_hashes[str(shadow_validation_path.relative_to(root))] = _sha256_path(
            shadow_validation_path
        )
    if (
        portfolio_optimizer_evidence_path is not None
        and portfolio_optimizer_evidence_path.exists()
    ):
        artifact_hashes[str(portfolio_optimizer_evidence_path.relative_to(root))] = (
            _sha256_path(portfolio_optimizer_evidence_path)
        )
    if (
        portfolio_proof_receipt_path is not None
        and portfolio_proof_receipt_path.exists()
    ):
        artifact_hashes[str(portfolio_proof_receipt_path.relative_to(root))] = (
            _sha256_path(portfolio_proof_receipt_path)
        )
    if (
        market_impact_stress_report_path is not None
        and market_impact_stress_report_path.exists()
    ):
        artifact_hashes[str(market_impact_stress_report_path.relative_to(root))] = (
            _sha256_path(market_impact_stress_report_path)
        )
    if (
        delay_adjusted_depth_stress_report_path is not None
        and delay_adjusted_depth_stress_report_path.exists()
    ):
        artifact_hashes[
            str(delay_adjusted_depth_stress_report_path.relative_to(root))
        ] = _sha256_path(delay_adjusted_depth_stress_report_path)
    if double_oos_report_path is not None and double_oos_report_path.exists():
        artifact_hashes[str(double_oos_report_path.relative_to(root))] = _sha256_path(
            double_oos_report_path
        )
    if stress_metrics_path is not None and stress_metrics_path.exists():
        artifact_hashes[str(stress_metrics_path.relative_to(root))] = _sha256_path(
            stress_metrics_path
        )
    payload = {
        "schema_version": "profitability-stage-manifest-v1",
        "candidate_id": candidate_id,
        "strategy_family": "autoresearch_runtime_closure",
        "llm_artifact_ref": None,
        "router_artifact_ref": "runtime_harness",
        "run_context": _runtime_run_context(root=root, runner_run_id=runner_run_id),
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
                        if portfolio_optimizer_evidence_path is not None
                        and portfolio_optimizer_evidence_path.exists()
                        else []
                    ),
                    *(
                        [
                            {
                                "check": "portfolio_proof_receipt_present",
                                "status": "pass",
                            }
                        ]
                        if portfolio_proof_receipt_path is not None
                        and portfolio_proof_receipt_path.exists()
                        else []
                    ),
                ],
                "artifacts": {
                    "candidate_spec": _artifact(
                        candidate_spec_path,
                        stage="research",
                        check="candidate_spec_present",
                    ),
                    "candidate_generation_manifest": _artifact(
                        candidate_generation_manifest_path,
                        stage="research",
                        check="candidate_generation_manifest_present",
                    ),
                    "walkforward_results": _artifact(
                        walkforward_results_path,
                        stage="research",
                        check="walkforward_results_present",
                    ),
                    "baseline_evaluation_report": _artifact(
                        evaluation_report_path,
                        stage="research",
                        check="baseline_evaluation_report_present",
                    ),
                    **(
                        {
                            "portfolio_optimizer_evidence": _artifact(
                                portfolio_optimizer_evidence_path,
                                stage="research",
                                check="portfolio_optimizer_evidence_present",
                            )
                        }
                        if portfolio_optimizer_evidence_path is not None
                        and portfolio_optimizer_evidence_path.exists()
                        else {}
                    ),
                    **(
                        {
                            "portfolio_proof_receipt": _artifact(
                                portfolio_proof_receipt_path,
                                stage="research",
                                check="portfolio_proof_receipt_present",
                            )
                        }
                        if portfolio_proof_receipt_path is not None
                        and portfolio_proof_receipt_path.exists()
                        else {}
                    ),
                },
                "owner": "autoresearch-loop",
                "completed_at_utc": _now_iso(),
            },
            "validation": {
                "status": "pass"
                if approval_replay_path is not None
                and approval_pass
                and market_impact_stress_report_path is not None
                and market_impact_stress_report_path.exists()
                and delay_adjusted_depth_stress_report_path is not None
                and delay_adjusted_depth_stress_report_path.exists()
                and double_oos_report_path is not None
                and double_oos_report_path.exists()
                else "fail",
                "checks": [
                    {"check": "evaluation_report_present", "status": "pass"},
                    {
                        "check": "profitability_benchmark_present",
                        "status": "pass"
                        if approval_replay_path is not None
                        else "fail",
                    },
                    {
                        "check": "profitability_evidence_present",
                        "status": "pass"
                        if approval_replay_path is not None
                        else "fail",
                    },
                    {
                        "check": "profitability_validation_present",
                        "status": "pass" if approval_pass else "fail",
                    },
                    {
                        "check": "market_impact_stress_present",
                        "status": "pass"
                        if market_impact_stress_report_path is not None
                        and market_impact_stress_report_path.exists()
                        else "fail",
                    },
                    {
                        "check": "delay_adjusted_depth_stress_present",
                        "status": "pass"
                        if delay_adjusted_depth_stress_report_path is not None
                        and delay_adjusted_depth_stress_report_path.exists()
                        else "fail",
                    },
                    {
                        "check": "double_oos_walkforward_present",
                        "status": "pass"
                        if double_oos_report_path is not None
                        and double_oos_report_path.exists()
                        else "fail",
                    },
                    {
                        "check": "stress_metrics_present",
                        "status": "pass"
                        if stress_metrics_path is not None
                        and stress_metrics_path.exists()
                        else "fail",
                    },
                ],
                "artifacts": {
                    "evaluation_report": _artifact(
                        evaluation_report_path,
                        stage="validation",
                        check="evaluation_report_present",
                    ),
                    **(
                        {
                            "approval_replay": _artifact(
                                approval_replay_path,
                                stage="validation",
                                check="profitability_benchmark_present",
                            )
                        }
                        if approval_replay_path is not None
                        and approval_replay_path.exists()
                        else {}
                    ),
                    **(
                        {
                            "market_impact_stress": _artifact(
                                market_impact_stress_report_path,
                                stage="validation",
                                check="market_impact_stress_present",
                            )
                        }
                        if market_impact_stress_report_path is not None
                        and market_impact_stress_report_path.exists()
                        else {}
                    ),
                    **(
                        {
                            "delay_adjusted_depth_stress": _artifact(
                                delay_adjusted_depth_stress_report_path,
                                stage="validation",
                                check="delay_adjusted_depth_stress_present",
                            )
                        }
                        if delay_adjusted_depth_stress_report_path is not None
                        and delay_adjusted_depth_stress_report_path.exists()
                        else {}
                    ),
                    **(
                        {
                            "double_oos_walkforward": _artifact(
                                double_oos_report_path,
                                stage="validation",
                                check="double_oos_walkforward_present",
                            )
                        }
                        if double_oos_report_path is not None
                        and double_oos_report_path.exists()
                        else {}
                    ),
                    **(
                        {
                            "stress_metrics": _artifact(
                                stress_metrics_path,
                                stage="validation",
                                check="stress_metrics_present",
                            )
                        }
                        if stress_metrics_path is not None
                        and stress_metrics_path.exists()
                        else {}
                    ),
                },
                "owner": "autoresearch-loop",
                "completed_at_utc": _now_iso(),
            },
            "execution": {
                "status": (
                    "pass"
                    if parity_pass
                    and approval_pass
                    and shadow_status in {"within_budget", "skipped"}
                    else "fail"
                ),
                "checks": [
                    {"check": "gate_evaluation_present", "status": "pass"},
                    {
                        "check": "gate_matrix_approval",
                        "status": "pass" if parity_pass and approval_pass else "fail",
                    },
                    {
                        "check": "drift_gate_approval",
                        "status": "pass"
                        if shadow_status in {"within_budget", "skipped"}
                        else "fail",
                    },
                ],
                "artifacts": {
                    "gate_evaluation": _artifact(
                        gate_report_path,
                        stage="execution",
                        check="gate_evaluation_present",
                    ),
                    **(
                        {
                            "parity_replay": _artifact(
                                parity_replay_path,
                                stage="execution",
                                check="gate_matrix_approval",
                            )
                        }
                        if parity_replay_path is not None
                        and parity_replay_path.exists()
                        else {}
                    ),
                    **(
                        {
                            "shadow_validation": _artifact(
                                shadow_validation_path,
                                stage="execution",
                                check="drift_gate_approval",
                            )
                        }
                        if shadow_validation_path is not None
                        and shadow_validation_path.exists()
                        else {}
                    ),
                },
                "owner": "autoresearch-loop",
                "completed_at_utc": _now_iso(),
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
                    "candidate_spec": _artifact(
                        candidate_spec_path,
                        stage="governance",
                        check="candidate_spec_present",
                    ),
                    "gate_evaluation": _artifact(
                        gate_report_path,
                        stage="governance",
                        check="gate_report_present",
                    ),
                    "rollback_readiness": _artifact(
                        rollback_readiness_path,
                        stage="governance",
                        check="rollback_readiness_present",
                    ),
                },
                "owner": "autoresearch-loop",
                "completed_at_utc": _now_iso(),
            },
        },
        "overall_status": "fail",
        "failure_reasons": list(
            dict.fromkeys(
                [
                    *([] if approval_pass else ["validation_stage_incomplete"]),
                    *(
                        []
                        if parity_pass
                        and approval_pass
                        and shadow_status in {"within_budget", "skipped"}
                        else ["execution_stage_incomplete"]
                    ),
                    "governance_stage_incomplete",
                ]
            )
        ),
        "replay_contract": {
            "artifact_hashes": artifact_hashes,
            "contract_hash": _sha256_json({"artifact_hashes": artifact_hashes}),
            "hash_algorithm": "sha256",
        },
        "rollback_contract_ref": str(rollback_readiness_path.relative_to(root)),
        "created_at_utc": _now_iso(),
    }
    payload["content_hash"] = _sha256_json(
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


__all__ = [name for name in globals() if not name.startswith("__")]
