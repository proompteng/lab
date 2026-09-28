#!/usr/bin/env python
"""Verify Torghut quant readiness controls for provenance and rollback evidence."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, cast

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.models import (
    Execution,
    ResearchCandidate,
    ResearchFoldMetrics,
    ResearchPromotion,
    ResearchRun,
    ResearchStressMetrics,
    TradeDecision,
)
from scripts.quant_readiness_artifacts import (
    _load_control_plane_contract,
    _load_gate_trace,
    _load_incident_evidence,
    _load_model_risk_evidence_package,
    _load_profitability_proof,
)


@dataclass(frozen=True)
class AcceptanceWindowCounts:
    non_skipped_runs: int
    trade_decisions: int
    executions: int
    full_chain_runs: int
    route_total: int
    missing_route_rows: int
    route_fallback_rows: int
    advisor_eligible_rows: int
    advisor_payload_rows: int


@dataclass(frozen=True)
class AcceptanceWindowThresholds:
    min_non_skipped_runs: int
    min_trade_decisions: int
    min_executions: int
    min_full_chain_runs: int
    min_route_coverage_ratio: float
    min_execution_advisor_coverage_ratio: float
    max_route_fallback_ratio: float


@dataclass(frozen=True)
class ReadinessCounts:
    missing_route_count: int
    total_route_count: int
    fallback_route_count: int
    invalid_fallback_reason_count: int
    missing_research_trace_count: int
    non_skipped_runs: int
    trade_decisions: int
    advisor_eligible_rows: int
    advisor_payload_rows: int
    executions: int
    full_chain_runs: int


@dataclass(frozen=True)
class ReadinessThresholds:
    max_missing_provenance: int
    max_invalid_fallback_reason: int
    max_missing_research_traces: int
    max_model_risk_evidence_age_hours: int
    acceptance: AcceptanceWindowThresholds


def _safe_ratio(numerator: int, denominator: int, *, default: float = 0.0) -> float:
    if denominator <= 0:
        return default
    return max(0.0, numerator / denominator)


def _acceptance_counts_from_values(values: Mapping[str, Any]) -> AcceptanceWindowCounts:
    return AcceptanceWindowCounts(
        non_skipped_runs=int(values["non_skipped_runs"]),
        trade_decisions=int(values["trade_decisions"]),
        executions=int(values["executions"]),
        full_chain_runs=int(values["full_chain_runs"]),
        route_total=int(values["route_total"]),
        missing_route_rows=int(values["missing_route_rows"]),
        route_fallback_rows=int(values["route_fallback_rows"]),
        advisor_eligible_rows=int(values["advisor_eligible_rows"]),
        advisor_payload_rows=int(values["advisor_payload_rows"]),
    )


def _acceptance_thresholds_from_values(
    values: Mapping[str, Any],
) -> AcceptanceWindowThresholds:
    return AcceptanceWindowThresholds(
        min_non_skipped_runs=int(values["min_non_skipped_runs"]),
        min_trade_decisions=int(values["min_trade_decisions"]),
        min_executions=int(values["min_executions"]),
        min_full_chain_runs=int(values["min_full_chain_runs"]),
        min_route_coverage_ratio=float(values["min_route_coverage_ratio"]),
        min_execution_advisor_coverage_ratio=float(
            values["min_execution_advisor_coverage_ratio"]
        ),
        max_route_fallback_ratio=float(values["max_route_fallback_ratio"]),
    )


def _acceptance_counts_from_readiness(
    counts: ReadinessCounts,
) -> AcceptanceWindowCounts:
    return AcceptanceWindowCounts(
        non_skipped_runs=counts.non_skipped_runs,
        trade_decisions=counts.trade_decisions,
        executions=counts.executions,
        full_chain_runs=counts.full_chain_runs,
        route_total=counts.total_route_count,
        missing_route_rows=counts.missing_route_count,
        route_fallback_rows=counts.fallback_route_count,
        advisor_eligible_rows=counts.advisor_eligible_rows,
        advisor_payload_rows=counts.advisor_payload_rows,
    )


def _acceptance_window_passed(
    counts: AcceptanceWindowCounts,
    thresholds: AcceptanceWindowThresholds,
    *,
    route_coverage_ratio: float,
    route_fallback_ratio: float,
    execution_advisor_coverage_ratio: float,
) -> bool:
    return (
        counts.non_skipped_runs >= thresholds.min_non_skipped_runs
        and counts.trade_decisions >= thresholds.min_trade_decisions
        and counts.executions >= thresholds.min_executions
        and counts.full_chain_runs >= thresholds.min_full_chain_runs
        and route_coverage_ratio >= thresholds.min_route_coverage_ratio
        and route_fallback_ratio <= thresholds.max_route_fallback_ratio
        and execution_advisor_coverage_ratio
        >= thresholds.min_execution_advisor_coverage_ratio
    )


def _format_acceptance_window(
    counts: AcceptanceWindowCounts,
    thresholds: AcceptanceWindowThresholds,
) -> dict[str, Any]:
    route_coverage_ratio = _safe_ratio(
        counts.route_total - counts.missing_route_rows,
        counts.route_total,
    )
    route_fallback_ratio = _safe_ratio(
        counts.route_fallback_rows,
        counts.route_total,
    )
    execution_advisor_coverage_ratio = _safe_ratio(
        counts.advisor_payload_rows,
        counts.advisor_eligible_rows,
        default=1.0,
    )
    return {
        "passed": _acceptance_window_passed(
            counts,
            thresholds,
            route_coverage_ratio=route_coverage_ratio,
            route_fallback_ratio=route_fallback_ratio,
            execution_advisor_coverage_ratio=execution_advisor_coverage_ratio,
        ),
        "lookback": {
            "non_skipped_runs": counts.non_skipped_runs,
            "trade_decisions": counts.trade_decisions,
            "executions": counts.executions,
            "full_chain_runs": counts.full_chain_runs,
            "route_total": counts.route_total,
            "missing_route_rows": counts.missing_route_rows,
            "route_coverage_ratio": round(route_coverage_ratio, 6),
            "route_fallback_rows": counts.route_fallback_rows,
            "route_fallback_ratio": round(route_fallback_ratio, 6),
            "execution_advisor_eligible_rows": counts.advisor_eligible_rows,
            "execution_advisor_payload_rows": counts.advisor_payload_rows,
            "execution_advisor_coverage_ratio": round(
                execution_advisor_coverage_ratio, 6
            ),
        },
        "thresholds": {
            "min_non_skipped_runs": thresholds.min_non_skipped_runs,
            "min_trade_decisions": thresholds.min_trade_decisions,
            "min_executions": thresholds.min_executions,
            "min_full_chain_runs": thresholds.min_full_chain_runs,
            "min_route_coverage_ratio": thresholds.min_route_coverage_ratio,
            "max_route_fallback_ratio": thresholds.max_route_fallback_ratio,
            "min_execution_advisor_coverage_ratio": thresholds.min_execution_advisor_coverage_ratio,
        },
    }


def _evaluate_acceptance_window(**values: Any) -> dict[str, Any]:
    return _format_acceptance_window(
        _acceptance_counts_from_values(values),
        _acceptance_thresholds_from_values(values),
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Verify Torghut autonomous quant readiness controls."
    )
    parser.add_argument(
        "--gate-report",
        type=Path,
        help="Optional gate-evaluation artifact path to validate governance trace IDs.",
    )
    parser.add_argument(
        "--max-missing-provenance",
        type=int,
        default=0,
        help="Allowed number of execution rows missing expected/actual adapter metadata.",
    )
    parser.add_argument(
        "--max-invalid-fallback-reason",
        type=int,
        default=0,
        help="Allowed number of fallback rows missing fallback reason when fallback_count > 0.",
    )
    parser.add_argument(
        "--max-missing-research-traces",
        type=int,
        default=0,
        help="Allowed number of non-skipped research runs missing gate/recommendation trace IDs.",
    )
    parser.add_argument(
        "--incident-evidence",
        type=Path,
        help="Optional rollback incident evidence path to validate emergency-stop evidence package.",
    )
    parser.add_argument(
        "--profitability-proof",
        type=Path,
        help="Optional profitability proof manifest path with scientific evidence details.",
    )
    parser.add_argument(
        "--control-plane-contract",
        type=Path,
        help="Optional control-plane contract artifact to verify drift/promotion/telemetry continuity fields.",
    )
    parser.add_argument(
        "--model-risk-evidence-package",
        type=Path,
        help="Optional model-risk evidence package artifact enforcing Wave-6 audit completeness.",
    )
    parser.add_argument(
        "--max-model-risk-evidence-age-hours",
        type=int,
        default=48,
        help="Maximum allowed age (hours) for model-risk evidence package generated_at timestamp.",
    )
    parser.add_argument(
        "--lookback-hours",
        type=int,
        default=24,
        help="Hours to evaluate for acceptance-window continuity checks.",
    )
    parser.add_argument(
        "--min-non-skipped-runs",
        type=int,
        default=1,
        help="Minimum non-skipped autonomous runs required in lookback window.",
    )
    parser.add_argument(
        "--min-trade-decisions",
        type=int,
        default=1,
        help="Minimum trade decisions required in lookback window.",
    )
    parser.add_argument(
        "--min-executions",
        type=int,
        default=1,
        help="Minimum executions required in lookback window.",
    )
    parser.add_argument(
        "--min-full-chain-runs",
        type=int,
        default=1,
        help="Minimum research runs with complete candidate/fold/stress/promotion chain in lookback window.",
    )
    parser.add_argument(
        "--min-route-coverage-ratio",
        type=float,
        default=0.99,
        help="Minimum route provenance coverage ratio in lookback window.",
    )
    parser.add_argument(
        "--max-route-fallback-ratio",
        type=float,
        default=0.05,
        help="Maximum allowed route fallback ratio in lookback window.",
    )
    parser.add_argument(
        "--min-execution-advisor-coverage-ratio",
        type=float,
        default=0.99,
        help="Minimum execution_advisor payload coverage ratio on rows that include microstructure_state.",
    )
    return parser


def _readiness_thresholds_from_args(args: argparse.Namespace) -> ReadinessThresholds:
    return ReadinessThresholds(
        max_missing_provenance=int(args.max_missing_provenance),
        max_invalid_fallback_reason=int(args.max_invalid_fallback_reason),
        max_missing_research_traces=int(args.max_missing_research_traces),
        max_model_risk_evidence_age_hours=max(
            1,
            int(args.max_model_risk_evidence_age_hours),
        ),
        acceptance=AcceptanceWindowThresholds(
            min_non_skipped_runs=max(1, int(args.min_non_skipped_runs)),
            min_trade_decisions=max(1, int(args.min_trade_decisions)),
            min_executions=max(1, int(args.min_executions)),
            min_full_chain_runs=max(1, int(args.min_full_chain_runs)),
            min_route_coverage_ratio=max(0.0, float(args.min_route_coverage_ratio)),
            max_route_fallback_ratio=max(0.0, float(args.max_route_fallback_ratio)),
            min_execution_advisor_coverage_ratio=max(
                0.0,
                float(args.min_execution_advisor_coverage_ratio),
            ),
        ),
    )


def _missing_text(column: Any) -> Any:
    return or_(column.is_(None), and_(column.is_not(None), func.btrim(column) == ""))


def _count_rows(session: Session, query: Any) -> int:
    return int(session.execute(query).scalar_one())


def _count_missing_route_rows(session: Session, lookback_start: datetime) -> int:
    return _count_rows(
        session,
        select(func.count(Execution.id)).where(
            and_(
                Execution.created_at >= lookback_start,
                or_(
                    _missing_text(Execution.execution_expected_adapter),
                    _missing_text(Execution.execution_actual_adapter),
                ),
            )
        ),
    )


def _count_total_route_rows(session: Session, lookback_start: datetime) -> int:
    return _count_rows(
        session,
        select(func.count(Execution.id)).where(Execution.created_at >= lookback_start),
    )


def _count_fallback_route_rows(session: Session, lookback_start: datetime) -> int:
    return _count_rows(
        session,
        select(func.count(Execution.id)).where(
            and_(
                Execution.created_at >= lookback_start,
                Execution.execution_fallback_count > 0,
            )
        ),
    )


def _count_invalid_fallback_reason_rows(
    session: Session,
    lookback_start: datetime,
) -> int:
    return _count_rows(
        session,
        select(func.count(Execution.id)).where(
            and_(
                Execution.created_at >= lookback_start,
                Execution.execution_fallback_count > 0,
                _missing_text(Execution.execution_fallback_reason),
            )
        ),
    )


def _count_missing_research_trace_rows(
    session: Session,
    lookback_start: datetime,
) -> int:
    return _count_rows(
        session,
        select(func.count(ResearchRun.id)).where(
            and_(
                ResearchRun.created_at >= lookback_start,
                ResearchRun.status != "skipped",
                or_(
                    _missing_text(ResearchRun.gate_report_trace_id),
                    _missing_text(ResearchRun.recommendation_trace_id),
                ),
            )
        ),
    )


def _count_non_skipped_runs(session: Session, lookback_start: datetime) -> int:
    return _count_rows(
        session,
        select(func.count(ResearchRun.id)).where(
            and_(
                ResearchRun.created_at >= lookback_start,
                ResearchRun.status != "skipped",
            )
        ),
    )


def _count_trade_decisions(session: Session, lookback_start: datetime) -> int:
    return _count_rows(
        session,
        select(func.count(TradeDecision.id)).where(
            TradeDecision.created_at >= lookback_start
        ),
    )


def _load_execution_advisor_coverage(
    session: Session,
    lookback_start: datetime,
) -> tuple[int, int]:
    advisor_coverage = session.execute(
        select(
            func.count(TradeDecision.id).filter(
                func.jsonb_typeof(
                    TradeDecision.decision_json["params"]["microstructure_state"]
                )
                == "object"
            ),
            func.count(TradeDecision.id).filter(
                and_(
                    func.jsonb_typeof(
                        TradeDecision.decision_json["params"]["microstructure_state"]
                    )
                    == "object",
                    func.jsonb_typeof(
                        TradeDecision.decision_json["params"]["execution_advisor"]
                    )
                    == "object",
                )
            ),
        ).where(TradeDecision.created_at >= lookback_start)
    ).one()
    return int(advisor_coverage[0] or 0), int(advisor_coverage[1] or 0)


def _count_executions(session: Session, lookback_start: datetime) -> int:
    return _count_rows(
        session,
        select(func.count(Execution.id)).where(Execution.created_at >= lookback_start),
    )


def _count_full_chain_runs(session: Session, lookback_start: datetime) -> int:
    return _count_rows(
        session,
        select(func.count(func.distinct(ResearchRun.run_id)))
        .select_from(ResearchRun)
        .join(ResearchCandidate, ResearchCandidate.run_id == ResearchRun.run_id)
        .join(
            ResearchFoldMetrics,
            ResearchFoldMetrics.candidate_id == ResearchCandidate.candidate_id,
        )
        .join(
            ResearchStressMetrics,
            ResearchStressMetrics.candidate_id == ResearchCandidate.candidate_id,
        )
        .join(
            ResearchPromotion,
            ResearchPromotion.candidate_id == ResearchCandidate.candidate_id,
        )
        .where(
            and_(
                ResearchRun.created_at >= lookback_start,
                ResearchRun.status != "skipped",
            )
        ),
    )


def _load_readiness_counts(lookback_start: datetime) -> ReadinessCounts:
    with SessionLocal() as session:
        advisor_eligible_rows, advisor_payload_rows = _load_execution_advisor_coverage(
            session,
            lookback_start,
        )
        return ReadinessCounts(
            missing_route_count=_count_missing_route_rows(session, lookback_start),
            total_route_count=_count_total_route_rows(session, lookback_start),
            fallback_route_count=_count_fallback_route_rows(session, lookback_start),
            invalid_fallback_reason_count=_count_invalid_fallback_reason_rows(
                session,
                lookback_start,
            ),
            missing_research_trace_count=_count_missing_research_trace_rows(
                session,
                lookback_start,
            ),
            non_skipped_runs=_count_non_skipped_runs(session, lookback_start),
            trade_decisions=_count_trade_decisions(session, lookback_start),
            advisor_eligible_rows=advisor_eligible_rows,
            advisor_payload_rows=advisor_payload_rows,
            executions=_count_executions(session, lookback_start),
            full_chain_runs=_count_full_chain_runs(session, lookback_start),
        )


def _count_threshold_check(missing_rows: int, threshold: int) -> dict[str, Any]:
    return {
        "missing_rows": missing_rows,
        "threshold": threshold,
        "passed": missing_rows <= threshold,
    }


def _route_fallback_ratio_check(
    counts: ReadinessCounts,
    thresholds: ReadinessThresholds,
) -> dict[str, Any]:
    ratio = _safe_ratio(counts.fallback_route_count, counts.total_route_count)
    return {
        "fallback_rows": counts.fallback_route_count,
        "route_total": counts.total_route_count,
        "ratio": round(ratio, 6),
        "threshold": thresholds.acceptance.max_route_fallback_ratio,
        "passed": ratio <= thresholds.acceptance.max_route_fallback_ratio,
    }


def _execution_advisor_provenance_check(
    counts: ReadinessCounts,
    thresholds: ReadinessThresholds,
) -> dict[str, Any]:
    coverage_ratio = _safe_ratio(
        counts.advisor_payload_rows,
        counts.advisor_eligible_rows,
        default=1.0,
    )
    return {
        "microstructure_rows": counts.advisor_eligible_rows,
        "execution_advisor_rows": counts.advisor_payload_rows,
        "coverage_ratio": round(coverage_ratio, 6),
        "threshold": thresholds.acceptance.min_execution_advisor_coverage_ratio,
        "passed": coverage_ratio
        >= thresholds.acceptance.min_execution_advisor_coverage_ratio,
    }


def _build_core_checks(
    counts: ReadinessCounts,
    thresholds: ReadinessThresholds,
) -> dict[str, Any]:
    return {
        "acceptance_window": _format_acceptance_window(
            _acceptance_counts_from_readiness(counts),
            thresholds.acceptance,
        ),
        "execution_route_provenance": _count_threshold_check(
            counts.missing_route_count,
            thresholds.max_missing_provenance,
        ),
        "execution_route_fallback_ratio": _route_fallback_ratio_check(
            counts,
            thresholds,
        ),
        "execution_advisor_provenance": _execution_advisor_provenance_check(
            counts,
            thresholds,
        ),
        "execution_fallback_reason": _count_threshold_check(
            counts.invalid_fallback_reason_count,
            thresholds.max_invalid_fallback_reason,
        ),
        "research_trace_provenance": _count_threshold_check(
            counts.missing_research_trace_count,
            thresholds.max_missing_research_traces,
        ),
    }


def _add_governance_trace_check(checks: dict[str, Any], path: Path) -> None:
    trace_payload = _load_gate_trace(path)
    checks["governance_trace"] = {
        "artifact": str(path),
        "gate_report_trace_id": trace_payload["gate_report_trace_id"],
        "recommendation_trace_id": trace_payload["recommendation_trace_id"],
        "passed": True,
    }


def _add_rollback_incident_check(checks: dict[str, Any], path: Path) -> None:
    incident_payload = _load_incident_evidence(path)
    checks["rollback_incident_evidence"] = {
        "artifact": str(path),
        "triggered_at": incident_payload.get("triggered_at"),
        "reason_count": len(cast(list[Any], incident_payload.get("reasons", []))),
        "passed": True,
    }


def _add_profitability_evidence_check(checks: dict[str, Any], path: Path) -> None:
    proof_payload = _load_profitability_proof(path)
    checks["profitability_evidence"] = {
        "artifact": str(path),
        "hypothesis": proof_payload.get("hypothesis"),
        "sample_size": proof_payload.get("sample_size"),
        "window_days": proof_payload.get("window_days"),
        "effect_size": proof_payload.get("effect_size"),
        "p_value": proof_payload.get("p_value"),
        "drawdown_delta": proof_payload.get("drawdown_delta"),
        "passed": True,
    }


def _add_control_plane_contract_check(checks: dict[str, Any], path: Path) -> None:
    contract_payload = _load_control_plane_contract(path)
    checks["control_plane_contract"] = {
        "artifact": str(path),
        "contract_version": contract_payload.get("contract_version"),
        "last_autonomy_recommendation_trace_id": contract_payload.get(
            "last_autonomy_recommendation_trace_id"
        ),
        "domain_telemetry_event_total": contract_payload.get(
            "domain_telemetry_event_total"
        ),
        "domain_telemetry_dropped_total": contract_payload.get(
            "domain_telemetry_dropped_total"
        ),
        "passed": True,
    }


def _add_model_risk_evidence_check(
    checks: dict[str, Any],
    path: Path,
    *,
    now: datetime,
    max_age_hours: int,
) -> None:
    package_payload = _load_model_risk_evidence_package(
        path,
        now=now,
        max_age_hours=max_age_hours,
    )
    checks["model_risk_evidence_package"] = {
        "artifact": str(path),
        **package_payload,
        "passed": True,
    }


def _add_optional_artifact_checks(
    checks: dict[str, Any],
    args: argparse.Namespace,
    *,
    now: datetime,
    thresholds: ReadinessThresholds,
) -> None:
    if args.gate_report:
        _add_governance_trace_check(checks, args.gate_report)
    if args.incident_evidence:
        _add_rollback_incident_check(checks, args.incident_evidence)
    if args.profitability_proof:
        _add_profitability_evidence_check(checks, args.profitability_proof)
    if args.control_plane_contract:
        _add_control_plane_contract_check(checks, args.control_plane_contract)
    if args.model_risk_evidence_package:
        _add_model_risk_evidence_check(
            checks,
            args.model_risk_evidence_package,
            now=now,
            max_age_hours=thresholds.max_model_risk_evidence_age_hours,
        )


def _build_readiness_payload(
    *,
    now: datetime,
    lookback_start: datetime,
    lookback_hours: int,
    checks: Mapping[str, Any],
) -> dict[str, Any]:
    all_passed = all(bool(item.get("passed")) for item in checks.values())
    return {
        "ok": all_passed,
        "evaluated_at": now.isoformat(),
        "lookback_start": lookback_start.isoformat(),
        "lookback_hours": lookback_hours,
        "checks": checks,
    }


def _emit_readiness_payload(payload: Mapping[str, Any]) -> None:
    print(json.dumps(payload, indent=2))
    if not bool(payload.get("ok")):
        raise SystemExit(1)


def main() -> None:
    args = _build_parser().parse_args()
    now = datetime.now(timezone.utc)
    lookback_hours = max(1, int(args.lookback_hours))
    lookback_start = now - timedelta(hours=lookback_hours)
    thresholds = _readiness_thresholds_from_args(args)
    checks = _build_core_checks(_load_readiness_counts(lookback_start), thresholds)
    _add_optional_artifact_checks(
        checks,
        args,
        now=now,
        thresholds=thresholds,
    )
    _emit_readiness_payload(
        _build_readiness_payload(
            now=now,
            lookback_start=lookback_start,
            lookback_hours=lookback_hours,
            checks=checks,
        )
    )


if __name__ == "__main__":
    main()
