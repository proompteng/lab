from __future__ import annotations

import tempfile
from datetime import datetime, timezone
from pathlib import Path
from unittest import TestCase

from app.trading.autonomy.policy_checks import evaluate_promotion_prerequisites, evaluate_rollback_readiness


class TestPolicyChecks(TestCase):
    def test_promotion_prerequisites_fail_when_patch_missing_for_paper(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / 'research').mkdir(parents=True, exist_ok=True)
            (root / 'backtest').mkdir(parents=True, exist_ok=True)
            (root / 'gates').mkdir(parents=True, exist_ok=True)
            (root / 'research' / 'candidate-spec.json').write_text('{}', encoding='utf-8')
            (root / 'backtest' / 'evaluation-report.json').write_text('{}', encoding='utf-8')
            (root / 'gates' / 'gate-evaluation.json').write_text('{}', encoding='utf-8')

            result = evaluate_promotion_prerequisites(
                policy_payload={},
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target='paper',
                artifact_root=root,
            )

        self.assertFalse(result.allowed)
        self.assertIn('required_artifacts_missing', result.reasons)
        self.assertIn('paper-candidate/strategy-configmap-patch.yaml', result.missing_artifacts)

    def test_rollback_readiness_fails_when_dry_run_stale(self) -> None:
        state = _candidate_state()
        state['rollbackReadiness'] = {
            'killSwitchDryRunPassed': True,
            'gitopsRevertDryRunPassed': True,
            'strategyDisableDryRunPassed': True,
            'dryRunCompletedAt': '2025-01-01T00:00:00+00:00',
            'humanApproved': True,
            'rollbackTarget': 'main@deadbeef',
        }
        result = evaluate_rollback_readiness(
            policy_payload={'rollback_dry_run_max_age_hours': 1},
            candidate_state_payload=state,
            now=datetime(2026, 2, 1, tzinfo=timezone.utc),
        )
        self.assertFalse(result.ready)
        self.assertIn('rollback_dry_run_stale', result.reasons)

    def test_allows_progression_when_artifacts_and_rollback_are_ready(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / 'research').mkdir(parents=True, exist_ok=True)
            (root / 'backtest').mkdir(parents=True, exist_ok=True)
            (root / 'gates').mkdir(parents=True, exist_ok=True)
            (root / 'paper-candidate').mkdir(parents=True, exist_ok=True)
            (root / 'research' / 'candidate-spec.json').write_text('{}', encoding='utf-8')
            (root / 'backtest' / 'evaluation-report.json').write_text('{}', encoding='utf-8')
            (root / 'gates' / 'gate-evaluation.json').write_text('{}', encoding='utf-8')
            (root / 'paper-candidate' / 'strategy-configmap-patch.yaml').write_text('kind: ConfigMap', encoding='utf-8')

            promotion = evaluate_promotion_prerequisites(
                policy_payload={},
                gate_report_payload=_gate_report(),
                candidate_state_payload=_candidate_state(),
                promotion_target='paper',
                artifact_root=root,
            )
            rollback = evaluate_rollback_readiness(
                policy_payload={},
                candidate_state_payload=_candidate_state(),
                now=datetime.now(timezone.utc),
            )

        self.assertTrue(promotion.allowed)
        self.assertTrue(rollback.ready)


def _candidate_state() -> dict[str, object]:
    return {
        'candidateId': 'cand-test',
        'runId': 'run-test',
        'activeStage': 'gate-evaluation',
        'paused': False,
        'rollbackReadiness': {
            'killSwitchDryRunPassed': True,
            'gitopsRevertDryRunPassed': True,
            'strategyDisableDryRunPassed': True,
            'dryRunCompletedAt': datetime.now(timezone.utc).isoformat(),
            'humanApproved': True,
            'rollbackTarget': 'main@a1b2c3d',
        },
    }


def _gate_report() -> dict[str, object]:
    return {
        'run_id': 'run-test',
        'promotion_allowed': True,
        'recommended_mode': 'paper',
        'gates': [
            {'gate_id': 'gate0_data_integrity', 'status': 'pass'},
            {'gate_id': 'gate1_statistical_robustness', 'status': 'pass'},
            {'gate_id': 'gate2_risk_capacity', 'status': 'pass'},
        ],
    }
