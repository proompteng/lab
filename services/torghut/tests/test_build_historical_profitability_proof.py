from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

import yaml

from scripts.build_historical_profitability_proof import (
    build_historical_profitability_bundle,
)


class TestBuildHistoricalProfitabilityProof(TestCase):
    def test_builds_profitable_bundle_from_historical_runs(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            run_a = _write_run(
                root=root,
                run_name='sim-a',
                trading_day='2026-03-02',
                net_pnl='10',
                decision_count=8,
                execution_count=4,
                avg_confidence='0.9',
                dump_hash='dump-a',
            )
            run_b = _write_run(
                root=root,
                run_name='sim-b',
                trading_day='2026-03-03',
                net_pnl='5',
                decision_count=7,
                execution_count=3,
                avg_confidence='0.85',
                dump_hash='dump-b',
            )
            output_dir = root / 'out'

            summary = build_historical_profitability_bundle(
                run_dirs=[run_a, run_b],
                output_dir=output_dir,
                hypothesis='intraday_tsmom_v1 is profitable over the OOS replay window',
            )

            self.assertTrue(summary['passed'])
            proof_payload = json.loads((output_dir / 'profitability-proof.json').read_text(encoding='utf-8'))
            self.assertTrue(proof_payload['passed'])
            self.assertEqual(proof_payload['sample_size'], 2)
            self.assertEqual(proof_payload['window_days'], 2)

            candidate_report = json.loads((output_dir / 'candidate-report.json').read_text(encoding='utf-8'))
            self.assertEqual(candidate_report['metrics']['net_pnl'], '15')
            self.assertEqual(candidate_report['metrics']['trade_count'], 7)
            self.assertEqual(len(candidate_report['robustness']['folds']), 2)

            validation_payload = json.loads(
                (output_dir / 'profitability-evidence-validation.json').read_text(encoding='utf-8')
            )
            self.assertTrue(validation_payload['passed'])

    def test_rejects_inconsistent_candidate_lineage(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            run_a = _write_run(
                root=root,
                run_name='sim-a',
                trading_day='2026-03-02',
                net_pnl='10',
                decision_count=8,
                execution_count=4,
                avg_confidence='0.9',
                dump_hash='dump-a',
                candidate_id='intraday_tsmom_v1@prod',
            )
            run_b = _write_run(
                root=root,
                run_name='sim-b',
                trading_day='2026-03-03',
                net_pnl='5',
                decision_count=7,
                execution_count=3,
                avg_confidence='0.85',
                dump_hash='dump-b',
                candidate_id='other_candidate@prod',
            )

            with self.assertRaises(RuntimeError):
                build_historical_profitability_bundle(
                    run_dirs=[run_a, run_b],
                    output_dir=root / 'out',
                )

    def test_rejects_duplicate_trading_days(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            run_a = _write_run(
                root=root,
                run_name='sim-a',
                trading_day='2026-03-02',
                net_pnl='10',
                decision_count=8,
                execution_count=4,
                avg_confidence='0.9',
                dump_hash='dump-a',
            )
            run_b = _write_run(
                root=root,
                run_name='sim-b',
                trading_day='2026-03-02',
                net_pnl='5',
                decision_count=7,
                execution_count=3,
                avg_confidence='0.85',
                dump_hash='dump-b',
            )

            with self.assertRaises(RuntimeError):
                build_historical_profitability_bundle(
                    run_dirs=[run_a, run_b],
                    output_dir=root / 'out',
                )


def _write_run(
    *,
    root: Path,
    run_name: str,
    trading_day: str,
    net_pnl: str,
    decision_count: int,
    execution_count: int,
    avg_confidence: str,
    dump_hash: str,
    candidate_id: str = 'intraday_tsmom_v1@prod',
) -> Path:
    run_dir = root / run_name
    report_dir = run_dir / 'report'
    report_dir.mkdir(parents=True, exist_ok=True)

    manifest_path = root / f'{run_name}.yaml'
    manifest_path.write_text(
        yaml.safe_dump(
            {
                'window': {
                    'trading_day': trading_day,
                },
                'candidate_id': candidate_id,
                'baseline_candidate_id': 'cash-flat@baseline',
                'strategy_spec_ref': 'strategy-specs/intraday_tsmom_v1@1.1.0.json',
                'model_refs': ['rules/intraday_tsmom_v1'],
                'runtime_version_refs': ['services/torghut@sha256:test'],
                'monitor': {
                    'min_trade_decisions': 1,
                    'min_executions': 1,
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
                'evidence_lineage': {
                    'candidate_id': candidate_id,
                    'baseline_candidate_id': 'cash-flat@baseline',
                    'strategy_spec_ref': 'strategy-specs/intraday_tsmom_v1@1.1.0.json',
                    'model_refs': ['rules/intraday_tsmom_v1'],
                    'runtime_version_refs': ['services/torghut@sha256:test'],
                },
            }
        ),
        encoding='utf-8',
    )
    (run_dir / 'replay-report.json').write_text(
        json.dumps(
            {
                'dump_sha256': dump_hash,
            }
        ),
        encoding='utf-8',
    )
    (report_dir / 'trade-pnl.csv').write_text(
        'avg_fill_price,created_at,execution_id,filled_qty,realized_pnl_contribution,side,symbol,trade_decision_id\n'
        f'100,2026-03-16T12:00:00Z,exec-1,1,0,buy,AAPL,td-1\n'
        f'100,2026-03-16T12:01:00Z,exec-2,1,{net_pnl},sell,AAPL,td-2\n',
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
                },
                'funnel': {
                    'trade_decisions': decision_count,
                    'executions': execution_count,
                },
                'pnl': {
                    'net_pnl_estimated': net_pnl,
                    'estimated_cost_total': '0',
                    'execution_notional_total': '1000',
                },
                'llm': {
                    'avg_confidence': avg_confidence,
                },
                'verdict': {
                    'status': 'PASS',
                },
            }
        ),
        encoding='utf-8',
    )
    return run_dir
