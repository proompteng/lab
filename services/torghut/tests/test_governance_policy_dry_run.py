from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path
from unittest import TestCase


class TestGovernancePolicyDryRun(TestCase):
    def test_dry_run_blocks_progression_when_artifact_missing(self) -> None:
        output = self._run_harness('--simulate-missing-artifact')
        self.assertFalse(output['promotion_progression_allowed'])
        reasons = output['promotion_prerequisites']['reasons']
        self.assertIn('required_artifacts_missing', reasons)

    def test_dry_run_blocks_progression_when_rollback_stale(self) -> None:
        output = self._run_harness('--simulate-stale-rollback')
        self.assertFalse(output['promotion_progression_allowed'])
        reasons = output['rollback_readiness']['reasons']
        self.assertIn('rollback_dry_run_stale', reasons)

    def test_dry_run_allows_progression_when_checks_pass(self) -> None:
        output = self._run_harness()
        self.assertTrue(output['promotion_progression_allowed'])

    def _run_harness(self, *extra_args: str) -> dict[str, object]:
        repo_root = Path(__file__).resolve().parents[3]
        service_root = repo_root / 'services' / 'torghut'
        script = service_root / 'scripts' / 'run_governance_policy_dry_run.py'
        policy = service_root / 'config' / 'autonomy-gates-v3.json'

        gate_report = {
            'run_id': 'run-dry-run',
            'promotion_allowed': True,
            'recommended_mode': 'paper',
            'gates': [
                {'gate_id': 'gate0_data_integrity', 'status': 'pass'},
                {'gate_id': 'gate1_statistical_robustness', 'status': 'pass'},
                {'gate_id': 'gate2_risk_capacity', 'status': 'pass'},
            ],
        }

        with tempfile.TemporaryDirectory() as tmpdir:
            gate_report_path = Path(tmpdir) / 'gate-report.json'
            gate_report_path.write_text(json.dumps(gate_report, indent=2), encoding='utf-8')

            cmd = [
                'python',
                str(script),
                '--policy',
                str(policy),
                '--gate-report',
                str(gate_report_path),
                '--promotion-target',
                'paper',
                *extra_args,
            ]
            result = subprocess.run(
                cmd,
                cwd=service_root,
                check=True,
                capture_output=True,
                text=True,
            )
        return json.loads(result.stdout)
