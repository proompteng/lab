#!/usr/bin/env python
"""Emit a read-only JSON H-PAIRS runtime authority proof report."""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone

from sqlalchemy.exc import SQLAlchemyError

from app.db import SessionLocal
from app.trading.runtime_authority_verifier import (
    DEFAULT_HPAIRS_ACCOUNT_LABEL,
    DEFAULT_HPAIRS_CANDIDATE_ID,
    DEFAULT_HPAIRS_HYPOTHESIS_ID,
    DEFAULT_HPAIRS_RUNTIME_STRATEGY,
    build_runtime_authority_report,
    load_runtime_authority_rows,
    runtime_authority_report_json,
)
from app.trading.runtime_ledger_proof_policy import RUNTIME_LEDGER_PROOF_MODES


def _parse_timestamp(value: str | None) -> datetime | None:
    if value is None or not value.strip():
        return None
    normalized = value.strip().replace('Z', '+00:00')
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=RUNTIME_LEDGER_PROOF_MODES, default='authority')
    parser.add_argument('--hypothesis-id', default=DEFAULT_HPAIRS_HYPOTHESIS_ID)
    parser.add_argument('--candidate-id', default=DEFAULT_HPAIRS_CANDIDATE_ID)
    parser.add_argument('--runtime-strategy-name', default=DEFAULT_HPAIRS_RUNTIME_STRATEGY)
    parser.add_argument('--account-label', default=DEFAULT_HPAIRS_ACCOUNT_LABEL)
    parser.add_argument('--observed-stage')
    parser.add_argument('--start', dest='started_at')
    parser.add_argument('--end', dest='ended_at')
    parser.add_argument(
        '--fail-on-blockers',
        action='store_true',
        help='exit non-zero when final authority blockers are present',
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    started_at = _parse_timestamp(args.started_at)
    ended_at = _parse_timestamp(args.ended_at)
    evidence_read_error = None
    try:
        with SessionLocal() as session:
            rows = load_runtime_authority_rows(
                session,
                hypothesis_id=args.hypothesis_id,
                candidate_id=args.candidate_id,
                runtime_strategy_name=args.runtime_strategy_name,
                account_label=args.account_label,
                observed_stage=args.observed_stage,
                started_at=started_at,
                ended_at=ended_at,
            )
    except SQLAlchemyError as exc:
        rows = []
        evidence_read_error = str(exc)
    report = build_runtime_authority_report(
        rows,
        mode=args.mode,
        hypothesis_id=args.hypothesis_id,
        candidate_id=args.candidate_id,
        runtime_strategy_name=args.runtime_strategy_name,
        account_label=args.account_label,
        observed_stage=args.observed_stage,
        started_at=started_at,
        ended_at=ended_at,
        evidence_read_error=evidence_read_error,
    )
    sys.stdout.write(runtime_authority_report_json(report))
    return 1 if args.fail_on_blockers and report.get('final_authority_ok') is not True else 0


if __name__ == '__main__':  # pragma: no cover
    raise SystemExit(main())
