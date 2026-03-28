from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Sequence

import yaml

from app.trading.profitability_archive import ArchivedTradingDayBundle


def iter_trading_days(*, start_day: date, count: int) -> list[str]:
    trading_days: list[str] = []
    cursor = start_day
    while len(trading_days) < count:
        if cursor.weekday() < 5:
            trading_days.append(cursor.isoformat())
        cursor += timedelta(days=1)
    return trading_days


def default_postgres_counts() -> dict[str, int]:
    return {
        'trade_decisions': 12,
        'executions': 6,
        'position_snapshots': 4,
        'execution_order_events': 6,
        'execution_tca_metrics': 6,
    }


def write_historical_run(
    *,
    root: Path,
    run_name: str,
    trading_day: str,
    candidate_id: str,
    baseline_candidate_id: str = 'cash-flat@baseline',
    net_pnl: str,
    avg_abs_slippage_bps: float = 6.0,
    p95_abs_slippage_bps: float = 12.0,
    strict_coverage_ratio: float = 0.95,
    coverage_ratio: float = 1.0,
    dump_records: int = 500,
    symbols: Sequence[str] = ('AAPL', 'MSFT'),
) -> tuple[Path, Path]:
    run_dir = root / run_name
    report_dir = run_dir / 'report'
    report_dir.mkdir(parents=True, exist_ok=True)

    manifest_path = root / f'{run_name}.yaml'
    manifest_path.write_text(
        yaml.safe_dump(
            {
                'dataset_id': f'dataset-{run_name}',
                'dataset_snapshot_ref': f'snapshot-{run_name}',
                'candidate_id': candidate_id,
                'baseline_candidate_id': baseline_candidate_id,
                'strategy_spec_ref': 'strategy-specs/intraday-proof-v1.json',
                'model_refs': [f'rules/{candidate_id}'],
                'runtime_version_refs': ['services/torghut@sha256:test'],
                'window': {
                    'trading_day': trading_day,
                    'timezone': 'America/New_York',
                    'start': f'{trading_day}T13:30:00Z',
                    'end': f'{trading_day}T20:00:00Z',
                    'strict_coverage_ratio': strict_coverage_ratio,
                },
                'clickhouse': {
                    'simulation_database': f'torghut_sim_{run_name}',
                },
            },
            sort_keys=False,
        ),
        encoding='utf-8',
    )

    (run_dir / 'run-manifest.json').write_text(
        json.dumps(
            {
                'run_id': run_name,
                'dataset_id': f'dataset-{run_name}',
                'window_policy': {
                    'strict_coverage_ratio': strict_coverage_ratio,
                },
                'dump': {
                    'records': dump_records,
                    'records_by_topic': {
                        'torghut.trades.v1': dump_records,
                        'torghut.quotes.v1': dump_records,
                        'torghut.bars.1m.v1': dump_records,
                        'torghut.status.v1': 1,
                    },
                    'sha256': f'dump-{run_name}',
                },
                'dump_coverage': {
                    'coverage_ratio': coverage_ratio,
                },
                'evidence_lineage': {
                    'candidate_id': candidate_id,
                    'baseline_candidate_id': baseline_candidate_id,
                    'strategy_spec_ref': 'strategy-specs/intraday-proof-v1.json',
                    'model_refs': [f'rules/{candidate_id}'],
                    'runtime_version_refs': ['services/torghut@sha256:test'],
                },
            }
        ),
        encoding='utf-8',
    )
    (run_dir / 'replay-report.json').write_text(
        json.dumps(
            {
                'dump_sha256': f'dump-{run_name}',
            }
        ),
        encoding='utf-8',
    )
    (run_dir / 'source-dump.jsonl.zst').write_bytes(b'synthetic-dump')
    (run_dir / 'source-dump.jsonl.zst.manifest.json').write_text(
        json.dumps(
            {
                'chunks': [
                    {
                        'payload_sha256': f'dump-{run_name}',
                    }
                ]
            }
        ),
        encoding='utf-8',
    )
    (report_dir / 'trade-pnl.csv').write_text(
        'avg_fill_price,created_at,execution_id,filled_qty,realized_pnl_contribution,side,symbol,trade_decision_id\n'
        f'100,{trading_day}T14:00:00Z,exec-1,1,0,buy,{symbols[0]},td-1\n'
        f'101,{trading_day}T15:00:00Z,exec-2,1,{net_pnl},sell,{symbols[0]},td-2\n',
        encoding='utf-8',
    )
    (report_dir / 'simulation-report.json').write_text(
        json.dumps(
            {
                'run_metadata': {
                    'run_id': run_name,
                    'manifest_path': str(manifest_path),
                },
                'coverage': {
                    'window_start': f'{trading_day}T13:30:00+00:00',
                    'window_coverage_ratio_from_dump': coverage_ratio,
                    'decision_signal_min_ts': f'{trading_day}T13:30:00+00:00',
                    'decision_signal_max_ts': f'{trading_day}T20:00:00+00:00',
                    'dump_signal_min_ts': f'{trading_day}T13:30:00+00:00',
                    'dump_signal_max_ts': f'{trading_day}T20:00:00+00:00',
                },
                'funnel': {
                    'trade_decisions': 12,
                    'executions': 6,
                    'execution_order_events_total': 6,
                    'execution_tca_metrics': 6,
                    'decision_status_counts': {
                        'filled': 6,
                    },
                },
                'execution_quality': {
                    'slippage_bps': {
                        'avg_abs': avg_abs_slippage_bps,
                        'p95_abs': p95_abs_slippage_bps,
                    },
                    'fallback_reason_counts': {},
                },
                'pnl': {
                    'net_pnl_estimated': net_pnl,
                    'estimated_cost_total': '5',
                    'execution_notional_total': '1000',
                },
                'stability': {
                    'clickhouse': {
                        'symbols': list(symbols),
                    }
                },
                'llm': {
                    'avg_confidence': '0.8',
                },
                'verdict': {
                    'status': 'PASS',
                },
            }
        ),
        encoding='utf-8',
    )
    return run_dir, manifest_path


def make_archived_bundle(
    *,
    trading_day: str,
    candidate_id: str,
    net_pnl: str,
    replayable_market_day: bool = True,
    execution_day_eligible: bool = True,
) -> ArchivedTradingDayBundle:
    return ArchivedTradingDayBundle(
        trading_day=trading_day,
        candidate_id=candidate_id,
        run_id=f'{candidate_id}-{trading_day}',
        archived_run_dir=Path(f'/tmp/{candidate_id}/{trading_day}'),
        original_run_dir=Path(f'/source/{candidate_id}/{trading_day}'),
        market_day_inventory={
            'trading_day': trading_day,
            'replayable_market_day': replayable_market_day,
            'symbols': ['AAPL'],
            'reconstruction_source_provenance': 'historical_market_replay',
            'source_topic_retention_ms_by_topic': {'torghut.trades.v1': 14 * 86_400_000},
        },
        execution_day_inventory={
            'trading_day': trading_day,
            'execution_day_eligible': execution_day_eligible,
            'net_pnl_estimated': net_pnl,
            'estimated_cost_total': '5',
            'avg_abs_slippage_bps': 4.0,
        },
        replay_day_manifest={
            'trading_day': trading_day,
            'candidate_id': candidate_id,
            'run_id': f'{candidate_id}-{trading_day}',
            'dataset_snapshot_ref': f'snapshot-{candidate_id}-{trading_day}',
            'baseline_candidate_id': 'cash-flat@baseline',
        },
    )


def utc_now() -> datetime:
    return datetime.now(timezone.utc)
