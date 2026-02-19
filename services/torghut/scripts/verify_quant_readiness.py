#!/usr/bin/env python
"""Verify Torghut quant readiness controls for provenance and rollback evidence."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, cast

from sqlalchemy import and_, func, or_, select

from app.db import SessionLocal
from app.models import Execution


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
    args = parser.parse_args()

    with SessionLocal() as session:
        missing_route_count = session.execute(
            select(func.count(Execution.id)).where(
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
                )
            )
        ).scalar_one()

        invalid_fallback_reason_count = session.execute(
            select(func.count(Execution.id)).where(
                and_(
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

    checks: dict[str, Any] = {
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

    all_passed = all(bool(item.get('passed')) for item in checks.values())
    payload = {
        'ok': all_passed,
        'checks': checks,
    }
    print(json.dumps(payload, indent=2))
    if not all_passed:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
