from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest import TestCase

from app.trading.autonomy.lane import run_autonomous_lane


class TestAutonomousLane(TestCase):
    def test_lane_emits_gate_report_and_paper_patch(self) -> None:
        fixture_path = Path(__file__).parent / 'fixtures' / 'walkforward_signals.json'
        strategy_config_path = Path(__file__).parent.parent / 'config' / 'autonomous-strategy-sample.yaml'
        gate_policy_path = Path(__file__).parent.parent / 'config' / 'autonomous-gate-policy.json'
        strategy_configmap_path = (
            Path(__file__).parent.parent.parent.parent / 'argocd' / 'applications' / 'torghut' / 'strategy-configmap.yaml'
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / 'lane'
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target='paper',
                strategy_configmap_path=strategy_configmap_path,
                code_version='test-sha',
            )

            gate_payload = json.loads(result.gate_report_path.read_text(encoding='utf-8'))
            self.assertIn('gates', gate_payload)
            self.assertEqual(gate_payload['recommended_mode'], 'paper')
            self.assertIsNotNone(result.paper_patch_path)
            self.assertTrue(result.paper_patch_path.exists())

    def test_lane_blocks_live_without_policy_enablement(self) -> None:
        fixture_path = Path(__file__).parent / 'fixtures' / 'walkforward_signals.json'
        strategy_config_path = Path(__file__).parent.parent / 'config' / 'autonomous-strategy-sample.yaml'
        gate_policy_path = Path(__file__).parent.parent / 'config' / 'autonomous-gate-policy.json'

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / 'lane-live'
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target='live',
                code_version='test-sha',
            )

            gate_payload = json.loads(result.gate_report_path.read_text(encoding='utf-8'))
            self.assertFalse(gate_payload['promotion_allowed'])
            self.assertIn('live_rollout_disabled_by_policy', gate_payload['reasons'])
            self.assertIsNone(result.paper_patch_path)
