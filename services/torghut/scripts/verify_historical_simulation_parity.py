#!/usr/bin/env python3
"""Verify deterministic parity across historical simulation run directories."""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping


@dataclass(frozen=True)
class ParitySnapshot:
    run_dir: Path
    run_id: str
    activity_classification: str
    trade_decisions: int
    executions: int
    execution_tca_metrics: int
    execution_order_events: int
    legacy_path_count: int
    fallback_count: int
    net_pnl_estimated: str
    dump_sha256: str
    parity_hash: str


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-dir', action='append', required=True, help='Historical simulation run directory.')
    parser.add_argument('--json', action='store_true')
    return parser.parse_args()


def _load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(payload, Mapping):
        raise RuntimeError(f'json_mapping_required:{path}')
    return {str(key): value for key, value in payload.items()}


def _as_dict(value: Any) -> dict[str, Any]:
    return {str(key): item for key, item in value.items()} if isinstance(value, Mapping) else {}


def _as_text(value: Any) -> str:
    return str(value).strip() if value is not None else ''


def _as_int(value: Any) -> int:
    try:
        return int(value)
    except Exception:
        return 0


def _stable_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(dict(payload), sort_keys=True, separators=(',', ':'), default=str).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


def _load_snapshot(run_dir: Path) -> ParitySnapshot:
    lifecycle = _load_json(run_dir / 'run-full-lifecycle-manifest.json')
    report = _as_dict(lifecycle.get('report'))
    replay = _as_dict(lifecycle.get('replay'))
    monitor = _as_dict(lifecycle.get('monitor'))
    final_snapshot = _as_dict(monitor.get('final_snapshot'))
    funnel = _as_dict(report.get('funnel'))
    pnl = _as_dict(report.get('pnl'))

    canonical_payload = {
        'activity_classification': _as_text(monitor.get('activity_classification')),
        'trade_decisions': _as_int(funnel.get('trade_decisions')),
        'executions': _as_int(funnel.get('executions')),
        'execution_tca_metrics': _as_int(funnel.get('execution_tca_metrics')),
        'execution_order_events': _as_int(funnel.get('execution_order_events')),
        'legacy_path_count': _as_int(final_snapshot.get('legacy_path_count')),
        'fallback_count': _as_int(final_snapshot.get('fallback_count')),
        'net_pnl_estimated': _as_text(pnl.get('net_pnl_estimated')),
        'dump_sha256': _as_text(replay.get('dump_sha256')),
    }

    return ParitySnapshot(
        run_dir=run_dir,
        run_id=_as_text(lifecycle.get('run_id')) or run_dir.name,
        activity_classification=canonical_payload['activity_classification'],
        trade_decisions=canonical_payload['trade_decisions'],
        executions=canonical_payload['executions'],
        execution_tca_metrics=canonical_payload['execution_tca_metrics'],
        execution_order_events=canonical_payload['execution_order_events'],
        legacy_path_count=canonical_payload['legacy_path_count'],
        fallback_count=canonical_payload['fallback_count'],
        net_pnl_estimated=canonical_payload['net_pnl_estimated'],
        dump_sha256=canonical_payload['dump_sha256'],
        parity_hash=_stable_hash(canonical_payload),
    )


def build_historical_parity_report(*, run_dirs: list[Path]) -> dict[str, Any]:
    snapshots = [_load_snapshot(path) for path in run_dirs]
    if len(snapshots) < 2:
        raise RuntimeError('historical_parity_requires_at_least_two_runs')
    baseline = snapshots[0]
    failed_reasons: list[str] = []
    for snapshot in snapshots:
        if snapshot.activity_classification != 'success':
            failed_reasons.append(f'activity_not_success:{snapshot.run_id}')
        if snapshot.legacy_path_count != 0:
            failed_reasons.append(f'legacy_path_count_nonzero:{snapshot.run_id}')
        if snapshot.fallback_count != 0:
            failed_reasons.append(f'fallback_count_nonzero:{snapshot.run_id}')
        if snapshot.parity_hash != baseline.parity_hash:
            failed_reasons.append(f'parity_hash_mismatch:{snapshot.run_id}')
        if snapshot.dump_sha256 != baseline.dump_sha256:
            failed_reasons.append(f'dump_sha256_mismatch:{snapshot.run_id}')
    return {
        'schema_version': 'torghut.historical-simulation-parity.v1',
        'passed': not failed_reasons,
        'failed_reasons': failed_reasons,
        'baseline_run_id': baseline.run_id,
        'baseline_parity_hash': baseline.parity_hash,
        'baseline_dump_sha256': baseline.dump_sha256,
        'runs': [
            {
                'run_id': item.run_id,
                'run_dir': str(item.run_dir),
                'activity_classification': item.activity_classification,
                'trade_decisions': item.trade_decisions,
                'executions': item.executions,
                'execution_tca_metrics': item.execution_tca_metrics,
                'execution_order_events': item.execution_order_events,
                'legacy_path_count': item.legacy_path_count,
                'fallback_count': item.fallback_count,
                'net_pnl_estimated': item.net_pnl_estimated,
                'dump_sha256': item.dump_sha256,
                'parity_hash': item.parity_hash,
            }
            for item in snapshots
        ],
    }


def main() -> int:
    args = _parse_args()
    report = build_historical_parity_report(run_dirs=[Path(path) for path in args.run_dir])
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(json.dumps(report))
    if not report.get('passed'):
        raise SystemExit(1)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
