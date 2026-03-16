from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from scripts.verify_historical_simulation_parity import build_historical_parity_report


class TestVerifyHistoricalSimulationParity(TestCase):
    def test_passes_when_runs_match(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            run_a = _write_run(root=root, run_name='run-a', trade_decisions=10, executions=4, net_pnl='12.5')
            run_b = _write_run(root=root, run_name='run-b', trade_decisions=10, executions=4, net_pnl='12.5')

            report = build_historical_parity_report(run_dirs=[run_a, run_b])

            self.assertTrue(report['passed'])
            self.assertEqual(report['failed_reasons'], [])

    def test_fails_when_metrics_drift(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            run_a = _write_run(root=root, run_name='run-a', trade_decisions=10, executions=4, net_pnl='12.5')
            run_b = _write_run(root=root, run_name='run-b', trade_decisions=11, executions=4, net_pnl='12.5')

            report = build_historical_parity_report(run_dirs=[run_a, run_b])

            self.assertFalse(report['passed'])
            self.assertIn('parity_hash_mismatch:run-b', report['failed_reasons'])


def _write_run(
    *,
    root: Path,
    run_name: str,
    trade_decisions: int,
    executions: int,
    net_pnl: str,
) -> Path:
    run_dir = root / run_name
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / 'run-full-lifecycle-manifest.json').write_text(
        json.dumps(
            {
                'run_id': run_name,
                'replay': {
                    'dump_sha256': 'dump-sha',
                },
                'monitor': {
                    'activity_classification': 'success',
                    'final_snapshot': {
                        'legacy_path_count': 0,
                        'fallback_count': 0,
                    },
                },
                'report': {
                    'funnel': {
                        'trade_decisions': trade_decisions,
                        'executions': executions,
                        'execution_tca_metrics': executions,
                        'execution_order_events': executions,
                    },
                    'pnl': {
                        'net_pnl_estimated': net_pnl,
                    },
                },
            }
        ),
        encoding='utf-8',
    )
    return run_dir
