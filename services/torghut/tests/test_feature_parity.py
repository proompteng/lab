from __future__ import annotations

import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from unittest import TestCase

from app.trading.models import SignalEnvelope
from app.trading.parity import (
    BENCHMARK_PARITY_CONTRACT_SCHEMA_VERSION,
    BENCHMARK_PARITY_REQUIRED_FAMILIES,
    BENCHMARK_PARITY_REQUIRED_RUN_FIELDS,
    BENCHMARK_PARITY_REQUIRED_SCORECARD_FIELDS,
    BENCHMARK_PARITY_REQUIRED_SCORECARDS,
    BENCHMARK_PARITY_RUN_SCHEMA_VERSION,
    DEEPLOB_BDLOB_CONTRACT_SCHEMA_VERSION,
    DEEPLOB_BDLOB_REQUIRED_SUMMARY_FIELDS,
    DEEPLOB_BDLOB_REQUIRED_SUPPORTING_ARTIFACTS,
    DEEPLOB_BDLOB_SCHEMA_VERSION,
    _benchmark_report_hash,
    _deeplob_bdlob_report_hash,
    build_benchmark_parity_report,
    build_deeplob_bdlob_report,
    run_feature_parity,
    write_feature_parity_report,
)


class TestFeatureParity(TestCase):
    def _signal(self, *, price: str, symbol: str = 'AAPL') -> SignalEnvelope:
        return SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol=symbol,
            timeframe='1Min',
            seq=1,
            source='fixture',
            payload={
                'feature_schema_version': '3.0.0',
                'macd': {'macd': '1.2', 'signal': '0.8'},
                'rsi14': '25',
                'price': price,
            },
        )

    def test_parity_report_detects_drift_and_is_machine_readable(self) -> None:
        online = [self._signal(price='100.00')]
        offline = [self._signal(price='101.00')]

        report = run_feature_parity(online, offline)

        self.assertFalse(report.accepted)
        self.assertIn('numeric_drift_exceeds_threshold', report.reasons)
        self.assertTrue(report.top_drift_fields)
        self.assertEqual(report.top_drift_fields[0]['field'], 'price')
        self.assertEqual(len(report.failing_windows), 1)

        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = write_feature_parity_report(report, Path(tmpdir) / 'parity.json')
            payload = json.loads(output_path.read_text(encoding='utf-8'))
            self.assertEqual(payload['accepted'], report.accepted)
            self.assertEqual(payload['checked_rows'], 1)
            self.assertEqual(payload['top_drift_fields'][0]['field'], 'price')

    def test_benchmark_parity_report_includes_standardized_contract(self) -> None:
        now = datetime(2026, 3, 3, tzinfo=timezone.utc)
        report = build_benchmark_parity_report(
            candidate_id='cand-test',
            baseline_candidate_id='base-test',
            now=now,
        )

        contract = report.get('contract')
        self.assertIsInstance(contract, dict)
        assert isinstance(contract, dict)
        self.assertEqual(
            contract.get('schema_version'),
            BENCHMARK_PARITY_CONTRACT_SCHEMA_VERSION,
        )
        self.assertEqual(
            contract.get('required_families'),
            list(BENCHMARK_PARITY_REQUIRED_FAMILIES),
        )
        self.assertEqual(
            contract.get('required_scorecards'),
            list(BENCHMARK_PARITY_REQUIRED_SCORECARDS),
        )
        self.assertEqual(
            contract.get('required_scorecard_fields'),
            {
                name: list(fields)
                for name, fields in BENCHMARK_PARITY_REQUIRED_SCORECARD_FIELDS.items()
            },
        )
        self.assertEqual(
            contract.get('required_run_fields'),
            list(BENCHMARK_PARITY_REQUIRED_RUN_FIELDS),
        )
        self.assertEqual(contract.get('hash_algorithm'), 'sha256')

        benchmark_runs = report.get('benchmark_runs')
        self.assertIsInstance(benchmark_runs, list)
        assert isinstance(benchmark_runs, list)
        self.assertGreater(len(benchmark_runs), 0)
        for run in benchmark_runs:
            self.assertIsInstance(run, dict)
            assert isinstance(run, dict)
            self.assertEqual(
                run.get('schema_version'),
                BENCHMARK_PARITY_RUN_SCHEMA_VERSION,
            )

        self.assertEqual(report.get('artifact_hash'), _benchmark_report_hash(report))

    def test_deeplob_bdlob_report_includes_standardized_contract(self) -> None:
        now = datetime(2026, 3, 3, tzinfo=timezone.utc)
        report = build_deeplob_bdlob_report(
            candidate_id='cand-test',
            feature_policy_version='3.0.0',
            now=now,
        )

        self.assertEqual(report.get('schema_version'), DEEPLOB_BDLOB_SCHEMA_VERSION)

        contract = report.get('contract')
        self.assertIsInstance(contract, dict)
        assert isinstance(contract, dict)
        self.assertEqual(
            contract.get('schema_version'),
            DEEPLOB_BDLOB_CONTRACT_SCHEMA_VERSION,
        )
        self.assertEqual(
            contract.get('required_supporting_artifacts'),
            list(DEEPLOB_BDLOB_REQUIRED_SUPPORTING_ARTIFACTS),
        )
        self.assertEqual(
            contract.get('required_summary_fields'),
            list(DEEPLOB_BDLOB_REQUIRED_SUMMARY_FIELDS),
        )
        self.assertEqual(contract.get('hash_algorithm'), 'sha256')

        self.assertEqual(
            report.get('supporting_artifacts'),
            list(DEEPLOB_BDLOB_REQUIRED_SUPPORTING_ARTIFACTS),
        )
        for field_name in DEEPLOB_BDLOB_REQUIRED_SUMMARY_FIELDS:
            self.assertIsInstance(report.get(field_name), dict)
        self.assertEqual(report.get('overall_status'), 'pass')
        self.assertEqual(
            report.get('artifact_hash'),
            _deeplob_bdlob_report_hash(report),
        )
