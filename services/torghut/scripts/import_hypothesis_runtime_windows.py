#!/usr/bin/env python3
"""Import observed paper/live runtime windows into doc29 governance tables."""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping

import psycopg

from app.db import SessionLocal
from app.trading.runtime_window_import import (
    build_observed_runtime_buckets,
    build_regular_session_buckets,
    persist_observed_runtime_windows,
    resolve_hypothesis_manifest,
)

EXECUTION_ELIGIBLE_DECISION_STATUSES = (
    'submitted',
    'filled',
    'partially_filled',
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Import observed runtime windows into strategy hypothesis governance tables.',
    )
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--candidate-id', default='')
    parser.add_argument('--hypothesis-id', required=True)
    parser.add_argument('--observed-stage', required=True, choices=('paper', 'live'))
    parser.add_argument('--strategy-family', default='')
    parser.add_argument('--source-dsn', default='')
    parser.add_argument('--source-dsn-env', default='DB_DSN')
    parser.add_argument('--strategy-name', required=True)
    parser.add_argument('--account-label', required=True)
    parser.add_argument('--window-start', required=True)
    parser.add_argument('--window-end', required=True)
    parser.add_argument('--bucket-minutes', type=int, default=30)
    parser.add_argument('--sample-minutes', type=int, default=5)
    parser.add_argument('--source-manifest-ref', default='')
    parser.add_argument('--source-kind', default='')
    parser.add_argument('--artifact-ref', action='append', default=[])
    parser.add_argument('--dependency-quorum-decision', default='allow')
    parser.add_argument('--continuity-ok', default='true')
    parser.add_argument('--drift-ok', default='true')
    parser.add_argument('--json', action='store_true')
    return parser.parse_args()


def _flag(value: str) -> bool:
    return value.strip().lower() not in {'', '0', 'false', 'no', 'off'}


def _parse_dt(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _as_mapping(value: Any) -> dict[str, Any]:
    return (
        {str(key): item for key, item in value.items()}
        if isinstance(value, Mapping)
        else {}
    )


def _decimal_or_none(value: Any) -> Decimal | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return Decimal(text)
    except Exception:
        return None


def _load_report_post_cost_expectancy_bps(artifact_refs: list[str]) -> Decimal | None:
    for ref in artifact_refs:
        path = Path(ref)
        if path.name not in {'simulation-report.json', 'evaluation-report.json'} or not path.exists():
            continue
        try:
            payload = json.loads(path.read_text(encoding='utf-8'))
        except Exception:
            continue
        pnl_payload = _as_mapping(payload.get('pnl'))
        metrics_payload = _as_mapping(payload.get('metrics'))
        net_pnl = _decimal_or_none(
            pnl_payload.get('net_pnl_estimated')
            or metrics_payload.get('net_pnl')
            or pnl_payload.get('gross_pnl')
        )
        execution_notional = _decimal_or_none(
            pnl_payload.get('execution_notional_total')
            or metrics_payload.get('turnover_notional')
        )
        if net_pnl is None or execution_notional is None or execution_notional <= 0:
            continue
        return (net_pnl / execution_notional) * Decimal('10000')
    return None


def _query_timestamps(
    *,
    dsn: str,
    strategy_name: str,
    account_label: str,
    window_start: datetime,
    window_end: datetime,
) -> tuple[list[datetime], list[datetime], list[dict[str, object]]]:
    decisions: list[datetime] = []
    executions: list[datetime] = []
    tca_rows: list[dict[str, object]] = []
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select d.created_at
                from trade_decisions d
                join strategies s on s.id = d.strategy_id
                where s.name = %s
                  and d.alpaca_account_label = %s
                  and d.status = any(%s)
                  and d.created_at >= %s
                  and d.created_at < %s
                order by d.created_at
                """,
                (
                    strategy_name,
                    account_label,
                    list(EXECUTION_ELIGIBLE_DECISION_STATUSES),
                    window_start,
                    window_end,
                ),
            )
            decisions = [row[0] for row in cur.fetchall() if row[0] is not None]
            cur.execute(
                """
                select d.created_at
                from executions e
                join trade_decisions d on d.id = e.trade_decision_id
                join strategies s on s.id = d.strategy_id
                where s.name = %s
                  and d.alpaca_account_label = %s
                  and d.created_at >= %s
                  and d.created_at < %s
                order by d.created_at
                """,
                (strategy_name, account_label, window_start, window_end),
            )
            executions = [row[0] for row in cur.fetchall() if row[0] is not None]
            cur.execute(
                """
                select
                    d.created_at,
                    abs(coalesce(t.realized_shortfall_bps, t.slippage_bps)) as abs_slippage_bps,
                    (-coalesce(t.realized_shortfall_bps, t.slippage_bps)) as post_cost_expectancy_bps
                from execution_tca_metrics t
                join executions e on e.id = t.execution_id
                join trade_decisions d on d.id = e.trade_decision_id
                join strategies s on s.id = d.strategy_id
                where s.name = %s
                  and d.alpaca_account_label = %s
                  and d.created_at >= %s
                  and d.created_at < %s
                order by d.created_at
                """,
                (strategy_name, account_label, window_start, window_end),
            )
            tca_rows = [
                {
                    'computed_at': row[0],
                    'abs_slippage_bps': row[1] or Decimal('0'),
                    'post_cost_expectancy_bps': row[2] or Decimal('0'),
                }
                for row in cur.fetchall()
                if row[0] is not None
            ]
    return decisions, executions, tca_rows


def main() -> int:
    args = _parse_args()
    source_dsn = args.source_dsn.strip() or os.getenv(args.source_dsn_env, '').strip()
    if not source_dsn:
        raise RuntimeError('source_dsn_not_configured')
    window_start = _parse_dt(args.window_start)
    window_end = _parse_dt(args.window_end)
    _, manifest = resolve_hypothesis_manifest(
        hypothesis_id=args.hypothesis_id,
        strategy_family=args.strategy_family.strip() or None,
    )
    decisions, executions, tca_rows = _query_timestamps(
        dsn=source_dsn,
        strategy_name=args.strategy_name,
        account_label=args.account_label,
        window_start=window_start,
        window_end=window_end,
    )
    artifact_refs = [str(item).strip() for item in args.artifact_ref if str(item).strip()]
    report_post_cost_expectancy_bps = _load_report_post_cost_expectancy_bps(artifact_refs)
    if report_post_cost_expectancy_bps is not None and args.source_kind.strip().startswith('simulation_'):
        tca_rows = [
            {
                **row,
                'post_cost_expectancy_bps': report_post_cost_expectancy_bps,
            }
            for row in tca_rows
        ]
    bucket_ranges = build_regular_session_buckets(
        window_start=window_start,
        window_end=window_end,
        bucket_minutes=args.bucket_minutes,
        sample_minutes=args.sample_minutes,
    )
    buckets = build_observed_runtime_buckets(
        bucket_ranges=bucket_ranges,
        decision_times=decisions,
        execution_times=executions,
        tca_rows=tca_rows,
        continuity_ok=_flag(args.continuity_ok),
        drift_ok=_flag(args.drift_ok),
        dependency_quorum_decision=args.dependency_quorum_decision.strip() or 'allow',
    )
    evidence_provenance = (
        'paper_runtime_observed'
        if args.observed_stage == 'paper'
        else 'live_runtime_observed'
    )
    source_kind = args.source_kind.strip() or (
        'simulation_paper_runtime'
        if args.observed_stage == 'paper'
        else 'live_runtime'
    )
    runtime_observation_payload = {
        'authoritative': True,
        'observed_stage': args.observed_stage,
        'evidence_provenance': evidence_provenance,
        'source_kind': source_kind,
        'source_manifest_ref': args.source_manifest_ref.strip() or None,
        'strategy_name': args.strategy_name,
        'account_label': args.account_label,
        'window_start': window_start.isoformat(),
        'window_end': window_end.isoformat(),
        'artifact_refs': artifact_refs,
        'report_post_cost_expectancy_bps': (
            str(report_post_cost_expectancy_bps)
            if report_post_cost_expectancy_bps is not None
            else None
        ),
    }
    with SessionLocal() as session:
        summary = persist_observed_runtime_windows(
            session=session,
            run_id=args.run_id,
            candidate_id=args.candidate_id.strip() or None,
            hypothesis_id=args.hypothesis_id,
            observed_stage=args.observed_stage,
            strategy_family=args.strategy_family.strip() or manifest.strategy_family,
            source_manifest_ref=args.source_manifest_ref.strip() or str(Path(manifest.hypothesis_id)),
            buckets=buckets,
            slippage_budget_bps=manifest.max_allowed_slippage_bps,
            runtime_observation_payload=runtime_observation_payload,
        )
        session.commit()
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print(summary)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
