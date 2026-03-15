from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from scripts import assemble_production_readiness_bundle


class TestAssembleProductionReadinessBundle(TestCase):
    def test_bundle_assembly_copies_artifacts_and_injects_identity(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            input_dir = root / 'inputs'
            input_dir.mkdir(parents=True, exist_ok=True)

            for name in (
                'simulation.json',
                'broker.json',
                'profitability.json',
                'model-risk.json',
                'session-ready.json',
                'performance.json',
            ):
                (input_dir / name).write_text(json.dumps({'ok': True}), encoding='utf-8')

            output_dir = root / 'bundle'
            assemble_production_readiness_bundle.main(
                [
                    '--output-dir',
                    str(output_dir),
                    '--image-digest',
                    'registry.example/torghut@sha256:abc123',
                    '--proof-timestamp',
                    '2026-03-14T18:00:00+00:00',
                    '--run-id',
                    'sim-proof-1',
                    '--workflow-name',
                    'torghut-historical-simulation-abc',
                    '--proof-id',
                    'proof-20260314',
                    '--broker-mode',
                    'paper',
                    '--simulation-proof',
                    str(input_dir / 'simulation.json'),
                    '--broker-proof',
                    str(input_dir / 'broker.json'),
                    '--profitability-proof',
                    str(input_dir / 'profitability.json'),
                    '--model-risk-evidence',
                    str(input_dir / 'model-risk.json'),
                    '--session-ready',
                    str(input_dir / 'session-ready.json'),
                    '--performance',
                    str(input_dir / 'performance.json'),
                ]
            )

            simulation_payload = json.loads(
                (output_dir / 'simulation-proof.json').read_text(encoding='utf-8')
            )
            self.assertEqual(simulation_payload['image_digest'], 'registry.example/torghut@sha256:abc123')
            self.assertEqual(simulation_payload['proof_timestamp'], '2026-03-14T18:00:00+00:00')
            self.assertEqual(simulation_payload['run_id'], 'sim-proof-1')
            self.assertEqual(simulation_payload['workflow_name'], 'torghut-historical-simulation-abc')
            self.assertEqual(simulation_payload['proof_id'], 'proof-20260314')
            self.assertEqual(simulation_payload['broker_mode'], 'paper')

            bundle_manifest = json.loads(
                (output_dir / 'bundle-manifest.json').read_text(encoding='utf-8')
            )
            self.assertEqual(
                bundle_manifest['schema_version'],
                'torghut.production-readiness-bundle.v1',
            )
            self.assertIn('simulation-proof.json', bundle_manifest['artifacts'])
            self.assertIn('performance.json', bundle_manifest['artifacts'])
