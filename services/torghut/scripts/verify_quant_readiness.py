#!/usr/bin/env python
"""Verify Torghut quant readiness controls for provenance and rollback evidence."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, cast

from sqlalchemy import and_, func, or_, select

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


def _load_gate_trace(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(payload, dict):
        raise ValueError('gate_report_payload_invalid')
    payload_map = cast(dict[str, Any], payload)
    provenance = payload_map.get('provenance')
    if not isinstance(provenance, dict):
        raise ValueError('gate_report_missing_provenance')
    provenance_map = cast(dict[str, Any], provenance)
    gate_trace = str(provenance_map.get('gate_report_trace_id', '')).strip()
    recommendation_trace = str(provenance_map.get('recommendation_trace_id', '')).strip()
    if not gate_trace:
        raise ValueError('gate_report_trace_id_missing')
    if not recommendation_trace:
        raise ValueError('recommendation_trace_id_missing')
    return {
        'gate_report_trace_id': gate_trace,
        'recommendation_trace_id': recommendation_trace,
    }


def _load_incident_evidence(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(payload, dict):
        raise ValueError('incident_payload_invalid')
    payload_map = cast(dict[str, Any], payload)
    required_keys = (
        'triggered_at',
        'reasons',
        'rollback_hooks',
        'safety_snapshot',
        'provenance',
        'verification',
    )
    missing = [key for key in required_keys if key not in payload_map]
    if missing:
        raise ValueError(f'incident_payload_missing_keys:{",".join(missing)}')
    rollback_hooks = payload_map.get('rollback_hooks')
    if not isinstance(rollback_hooks, dict):
        raise ValueError('incident_payload_rollback_hooks_invalid')
    reasons = payload_map.get('reasons')
    if not isinstance(reasons, list) or not reasons:
        raise ValueError('incident_payload_reasons_invalid')
    if not bool(rollback_hooks.get('order_submission_blocked', False)):
        raise ValueError('incident_payload_order_block_missing')
    verification = payload_map.get('verification')
    if not isinstance(verification, dict):
        raise ValueError('incident_payload_verification_invalid')
    if not bool(verification.get('incident_evidence_complete', False)):
        raise ValueError('incident_payload_verification_failed')
    return payload_map


def _evaluate_acceptance_window(
    *,
    non_skipped_runs: int,
    trade_decisions: int,
    executions: int,
    full_chain_runs: int,
    route_total: int,
    missing_route_rows: int,
    min_non_skipped_runs: int,
    min_trade_decisions: int,
    min_executions: int,
    min_full_chain_runs: int,
    min_route_coverage_ratio: float,
) -> dict[str, Any]:
    route_coverage_ratio = (
        max(0.0, (route_total - missing_route_rows) / route_total)
        if route_total > 0
        else 0.0
    )
    passed = (
        non_skipped_runs >= min_non_skipped_runs
        and trade_decisions >= min_trade_decisions
        and executions >= min_executions
        and full_chain_runs >= min_full_chain_runs
        and route_coverage_ratio >= min_route_coverage_ratio
    )
    return {
        'passed': passed,
        'lookback': {
            'non_skipped_runs': non_skipped_runs,
            'trade_decisions': trade_decisions,
            'executions': executions,
            'full_chain_runs': full_chain_runs,
            'route_total': route_total,
            'missing_route_rows': missing_route_rows,
            'route_coverage_ratio': round(route_coverage_ratio, 6),
        },
        'thresholds': {
            'min_non_skipped_runs': min_non_skipped_runs,
            'min_trade_decisions': min_trade_decisions,
            'min_executions': min_executions,
            'min_full_chain_runs': min_full_chain_runs,
            'min_route_coverage_ratio': min_route_coverage_ratio,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description='Verify Torghut autonomous quant readiness controls.')
    parser.add_argument(
        '--gate-report',
        type=Path,
        help='Optional gate-evaluation artifact path to validate governance trace IDs.',
    )
    parser.add_argument(
        '--max-missing-provenance',
        type=int,
        default=0,
        help='Allowed number of execution rows missing expected/actual adapter metadata.',
    )
    parser.add_argument(
        '--max-invalid-fallback-reason',
        type=int,
        default=0,
        help='Allowed number of fallback rows missing fallback reason when fallback_count > 0.',
    )
    parser.add_argument(
        '--max-missing-research-traces',
        type=int,
        default=0,
        help='Allowed number of non-skipped research runs missing gate/recommendation trace IDs.',
    )
    parser.add_argument(
        '--incident-evidence',
        type=Path,
        help='Optional rollback incident evidence path to validate emergency-stop evidence package.',
    )
    parser.add_argument(
        '--lookback-hours',
        type=int,
        default=24,
        help='Hours to evaluate for acceptance-window continuity checks.',
    )
    parser.add_argument(
        '--min-non-skipped-runs',
        type=int,
        default=1,
        help='Minimum non-skipped autonomous runs required in lookback window.',
    )
    parser.add_argument(
        '--min-trade-decisions',
        type=int,
        default=1,
        help='Minimum trade decisions required in lookback window.',
    )
    parser.add_argument(
        '--min-executions',
        type=int,
        default=1,
        help='Minimum executions required in lookback window.',
    )
    parser.add_argument(
        '--min-full-chain-runs',
        type=int,
        default=1,
        help='Minimum research runs with complete candidate/fold/stress/promotion chain in lookback window.',
    )
    parser.add_argument(
        '--min-route-coverage-ratio',
        type=float,
        default=0.99,
        help='Minimum route provenance coverage ratio in lookback window.',
    )
    args = parser.parse_args()

    now = datetime.now(timezone.utc)
    lookback_hours = max(1, int(args.lookback_hours))
    lookback_start = now - timedelta(hours=lookback_hours)

    with SessionLocal() as session:
        missing_route_query = select(func.count(Execution.id)).where(
            and_(
                Execution.created_at >= lookback_start,
                or_(
                    Execution.execution_expected_adapter.is_(None),
                    and_(
                        Execution.execution_expected_adapter.is_not(None),
                        func.btrim(Execution.execution_expected_adapter) == '',
                    ),
                    Execution.execution_actual_adapter.is_(None),
                    and_(
                        Execution.execution_actual_adapter.is_not(None),
                        func.btrim(Execution.execution_actual_adapter) == '',
                    ),
                ),
            )
        )
        missing_route_count = session.execute(missing_route_query).scalar_one()

        total_route_count = session.execute(
            select(func.count(Execution.id)).where(Execution.created_at >= lookback_start)
        ).scalar_one()

        invalid_fallback_reason_count = session.execute(
            select(func.count(Execution.id)).where(
                and_(
                    Execution.created_at >= lookback_start,
                    Execution.execution_fallback_count > 0,
                    or_(
                        Execution.execution_fallback_reason.is_(None),
                        and_(
                            Execution.execution_fallback_reason.is_not(None),
                            func.btrim(Execution.execution_fallback_reason) == '',
                        ),
                    ),
                )
            )
        ).scalar_one()

        missing_research_trace_count = session.execute(
            select(func.count(ResearchRun.id)).where(
                and_(
                    ResearchRun.created_at >= lookback_start,
                    ResearchRun.status != 'skipped',
                    or_(
                        ResearchRun.gate_report_trace_id.is_(None),
                        and_(
                            ResearchRun.gate_report_trace_id.is_not(None),
                            func.btrim(ResearchRun.gate_report_trace_id) == '',
                        ),
                        ResearchRun.recommendation_trace_id.is_(None),
                        and_(
                            ResearchRun.recommendation_trace_id.is_not(None),
                            func.btrim(ResearchRun.recommendation_trace_id) == '',
                        ),
                    ),
                )
            )
        ).scalar_one()

        non_skipped_runs = session.execute(
            select(func.count(ResearchRun.id)).where(
                and_(
                    ResearchRun.created_at >= lookback_start,
                    ResearchRun.status != 'skipped',
                )
            )
        ).scalar_one()

        trade_decisions = session.execute(
            select(func.count(TradeDecision.id)).where(
                TradeDecision.created_at >= lookback_start
            )
        ).scalar_one()

        executions = session.execute(
            select(func.count(Execution.id)).where(Execution.created_at >= lookback_start)
        ).scalar_one()

        full_chain_runs = session.execute(
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
                    ResearchRun.status != 'skipped',
                )
            )
        ).scalar_one()

    checks: dict[str, Any] = {
        'acceptance_window': _evaluate_acceptance_window(
            non_skipped_runs=int(non_skipped_runs),
            trade_decisions=int(trade_decisions),
            executions=int(executions),
            full_chain_runs=int(full_chain_runs),
            route_total=int(total_route_count),
            missing_route_rows=int(missing_route_count),
            min_non_skipped_runs=max(1, int(args.min_non_skipped_runs)),
            min_trade_decisions=max(1, int(args.min_trade_decisions)),
            min_executions=max(1, int(args.min_executions)),
            min_full_chain_runs=max(1, int(args.min_full_chain_runs)),
            min_route_coverage_ratio=max(0.0, float(args.min_route_coverage_ratio)),
        ),
        'execution_route_provenance': {
            'missing_rows': int(missing_route_count),
            'threshold': args.max_missing_provenance,
            'passed': int(missing_route_count) <= args.max_missing_provenance,
        },
        'execution_fallback_reason': {
            'missing_rows': int(invalid_fallback_reason_count),
            'threshold': args.max_invalid_fallback_reason,
            'passed': int(invalid_fallback_reason_count) <= args.max_invalid_fallback_reason,
        },
        'research_trace_provenance': {
            'missing_rows': int(missing_research_trace_count),
            'threshold': args.max_missing_research_traces,
            'passed': int(missing_research_trace_count) <= args.max_missing_research_traces,
        },
    }

    if args.gate_report:
        checks['governance_trace'] = {
            'artifact': str(args.gate_report),
            'passed': False,
        }
        trace_payload = _load_gate_trace(args.gate_report)
        checks['governance_trace'] = {
            'artifact': str(args.gate_report),
            'gate_report_trace_id': trace_payload['gate_report_trace_id'],
            'recommendation_trace_id': trace_payload['recommendation_trace_id'],
            'passed': True,
        }

    if args.incident_evidence:
        checks['rollback_incident_evidence'] = {
            'artifact': str(args.incident_evidence),
            'passed': False,
        }
        incident_payload = _load_incident_evidence(args.incident_evidence)
        checks['rollback_incident_evidence'] = {
            'artifact': str(args.incident_evidence),
            'triggered_at': incident_payload.get('triggered_at'),
            'reason_count': len(cast(list[Any], incident_payload.get('reasons', []))),
            'passed': True,
        }

    all_passed = all(bool(item.get('passed')) for item in checks.values())
    payload = {
        'ok': all_passed,
        'evaluated_at': now.isoformat(),
        'lookback_start': lookback_start.isoformat(),
        'lookback_hours': lookback_hours,
        'checks': checks,
    }
    print(json.dumps(payload, indent=2))
    if not all_passed:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
