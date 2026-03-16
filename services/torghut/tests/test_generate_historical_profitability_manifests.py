from __future__ import annotations

import json
from datetime import date, datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

import yaml

from scripts.generate_historical_profitability_manifests import (
    generate_profitability_manifests,
)


class TestGenerateHistoricalProfitabilityManifests(TestCase):
    def test_generates_business_day_manifests_for_frozen_digest(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir)

            summary = generate_profitability_manifests(
                start_day=date(2026, 3, 2),
                end_day=date(2026, 3, 8),
                digest='sha256:a9c60e5ed5ddd06253e3126d363d4f6c82c1ef4fc5ea809e21c012ee39d438a5',
                output_dir=output_dir,
                cache_policy='refresh',
                candidate_id='intraday_tsmom_v1@prod',
                baseline_candidate_id='intraday_tsmom_v1@baseline',
                strategy_spec_ref='strategy-specs/intraday_tsmom_v1@1.1.0.json',
                model_refs=['rules/intraday_tsmom_v1'],
                generated_at=datetime(2026, 3, 16, 12, 0, 0),
            )

            manifests = summary['manifests']
            self.assertEqual(len(manifests), 5)
            self.assertEqual(
                [item['trading_day'] for item in manifests],
                ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06'],
            )

            first_manifest_path = Path(manifests[0]['manifest_path'])
            payload = yaml.safe_load(first_manifest_path.read_text(encoding='utf-8'))
            self.assertEqual(payload['dataset_id'], 'torghut-full-day-20260302-a9c60e5e')
            self.assertEqual(payload['cachePolicy'], 'refresh')
            self.assertEqual(
                payload['runtime_version_refs'],
                [
                    'services/torghut@sha256:a9c60e5ed5ddd06253e3126d363d4f6c82c1ef4fc5ea809e21c012ee39d438a5',
                    'services/torghut-forecast@sha256:a9c60e5ed5ddd06253e3126d363d4f6c82c1ef4fc5ea809e21c012ee39d438a5',
                ],
            )
            self.assertEqual(payload['window']['start'], '2026-03-02T13:30:00Z')
            self.assertEqual(payload['window']['end'], '2026-03-02T20:00:00Z')
            self.assertEqual(
                payload['clickhouse']['simulation_database'],
                'torghut_sim_2026_03_02_full_day_a9c60e5e',
            )

            index_payload = json.loads((output_dir / 'manifest-index.json').read_text(encoding='utf-8'))
            self.assertEqual(index_payload['schema_version'], 'torghut.historical-profitability-manifest-index.v1')
            self.assertEqual(index_payload['cache_policy'], 'refresh')
