from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any
from unittest import TestCase

from scripts.orchestration_guard import evaluate_failure, evaluate_transition, load_policy


class TestOrchestrationGuard(TestCase):
    def setUp(self) -> None:
        self.policy = load_policy()
        self.state: dict[str, Any] = {
            'candidateId': 'cand-abc123',
            'runId': 'run-abc123',
            'activeStage': 'gate-evaluation',
            'paused': False,
            'failureCounts': {},
        }

    def test_allows_valid_transition(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            artifact = Path(tmpdir) / 'report.json'
            artifact.write_text('{"ok":true}', encoding='utf-8')
            result = evaluate_transition(
                policy=self.policy,
                state=self.state,
                candidate_id='cand-abc123',
                run_id='run-abc123',
                from_stage='gate-evaluation',
                to_stage='promotion-prerequisites',
                previous_artifact=artifact,
                previous_gate_passed=True,
                risk_controls_passed=True,
                execution_controls_passed=True,
                mode='gitops',
                emergency_ticket=None,
            )
        self.assertTrue(result['allowed'])
        self.assertEqual(result['nextAction'], 'proceed')

    def test_blocks_mutable_stage_without_gitops_or_ticket(self) -> None:
        state: dict[str, Any] = {
            'candidateId': 'cand-abc123',
            'runId': 'run-abc123',
            'activeStage': 'rollback-readiness',
            'paused': False,
            'failureCounts': {},
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            artifact = Path(tmpdir) / 'report.json'
            artifact.write_text('{"ok":true}', encoding='utf-8')
            result = evaluate_transition(
                policy=self.policy,
                state=state,
                candidate_id='cand-abc123',
                run_id='run-abc123',
                from_stage='rollback-readiness',
                to_stage='shadow-paper',
                previous_artifact=artifact,
                previous_gate_passed=True,
                risk_controls_passed=True,
                execution_controls_passed=True,
                mode='emergency',
                emergency_ticket=None,
            )
        self.assertFalse(result['allowed'])
        self.assertEqual(result['nextAction'], 'halt')

    def test_blocks_illegal_transition_when_from_stage_omitted(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            artifact = Path(tmpdir) / 'report.json'
            artifact.write_text('{"ok":true}', encoding='utf-8')
            result = evaluate_transition(
                policy=self.policy,
                state=self.state,
                candidate_id='cand-abc123',
                run_id='run-abc123',
                from_stage=None,
                to_stage='live-ramp',
                previous_artifact=artifact,
                previous_gate_passed=True,
                risk_controls_passed=True,
                execution_controls_passed=True,
                mode='gitops',
                emergency_ticket=None,
            )
        self.assertFalse(result['allowed'])
        self.assertEqual(result['nextAction'], 'halt')
        self.assertEqual(result['reason'], 'illegal_transition:gate-evaluation->live-ramp')

    def test_blocks_transition_without_known_source_stage(self) -> None:
        state: dict[str, Any] = {
            'candidateId': 'cand-abc123',
            'runId': 'run-abc123',
            'paused': False,
            'failureCounts': {},
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            artifact = Path(tmpdir) / 'report.json'
            artifact.write_text('{"ok":true}', encoding='utf-8')
            result = evaluate_transition(
                policy=self.policy,
                state=state,
                candidate_id='cand-abc123',
                run_id='run-abc123',
                from_stage=None,
                to_stage='live-ramp',
                previous_artifact=artifact,
                previous_gate_passed=True,
                risk_controls_passed=True,
                execution_controls_passed=True,
                mode='gitops',
                emergency_ticket=None,
            )
        self.assertFalse(result['allowed'])
        self.assertEqual(result['nextAction'], 'halt')
        self.assertEqual(result['reason'], 'missing_source_stage')

    def test_blocks_transition_when_run_id_missing_in_state(self) -> None:
        state: dict[str, Any] = {
            'candidateId': 'cand-abc123',
            'activeStage': 'gate-evaluation',
            'paused': False,
            'failureCounts': {},
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            artifact = Path(tmpdir) / 'report.json'
            artifact.write_text('{"ok":true}', encoding='utf-8')
            result = evaluate_transition(
                policy=self.policy,
                state=state,
                candidate_id='cand-abc123',
                run_id='run-abc123',
                from_stage='gate-evaluation',
                to_stage='promotion-prerequisites',
                previous_artifact=artifact,
                previous_gate_passed=True,
                risk_controls_passed=True,
                execution_controls_passed=True,
                mode='gitops',
                emergency_ticket=None,
            )
        self.assertFalse(result['allowed'])
        self.assertEqual(result['nextAction'], 'halt')
        self.assertEqual(result['reason'], 'missing_run_id')

    def test_blocks_transition_when_run_id_mismatches_state(self) -> None:
        state: dict[str, Any] = {
            'candidateId': 'cand-abc123',
            'runId': 'run-stale-1',
            'activeStage': 'gate-evaluation',
            'paused': False,
            'failureCounts': {},
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            artifact = Path(tmpdir) / 'report.json'
            artifact.write_text('{"ok":true}', encoding='utf-8')
            result = evaluate_transition(
                policy=self.policy,
                state=state,
                candidate_id='cand-abc123',
                run_id='run-abc123',
                from_stage='gate-evaluation',
                to_stage='promotion-prerequisites',
                previous_artifact=artifact,
                previous_gate_passed=True,
                risk_controls_passed=True,
                execution_controls_passed=True,
                mode='gitops',
                emergency_ticket=None,
            )
        self.assertFalse(result['allowed'])
        self.assertEqual(result['nextAction'], 'halt')
        self.assertEqual(result['reason'], 'run_mismatch:run-stale-1')

    def test_allows_ticketed_emergency_transition(self) -> None:
        state: dict[str, Any] = {
            'candidateId': 'cand-abc123',
            'runId': 'run-abc123',
            'activeStage': 'live-ramp',
            'paused': False,
            'failureCounts': {},
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            artifact = Path(tmpdir) / 'monitor.json'
            artifact.write_text('{"drift":"detected"}', encoding='utf-8')
            result = evaluate_transition(
                policy=self.policy,
                state=state,
                candidate_id='cand-abc123',
                run_id='run-abc123',
                from_stage='live-ramp',
                to_stage='incident-recovery',
                previous_artifact=artifact,
                previous_gate_passed=True,
                risk_controls_passed=True,
                execution_controls_passed=True,
                mode='emergency',
                emergency_ticket='INC-2026-02-12-001',
            )
        self.assertTrue(result['allowed'])
        self.assertEqual(result['lane'], 'lane-f')

    def test_retries_transient_failure_with_backoff(self) -> None:
        result = evaluate_failure(
            policy=self.policy,
            state=self.state,
            stage='candidate-build',
            failure_class='transient',
            attempt=2,
        )
        self.assertEqual(result['action'], 'retry')
        self.assertGreaterEqual(result['nextBackoffSeconds'], 30)

    def test_autopauses_after_deterministic_failures(self) -> None:
        state: dict[str, Any] = {
            'candidateId': 'cand-abc123',
            'activeStage': 'candidate-build',
            'paused': False,
            'failureCounts': {'candidate-build': 1},
        }
        result = evaluate_failure(
            policy=self.policy,
            state=state,
            stage='candidate-build',
            failure_class='deterministic',
            attempt=1,
        )
        self.assertEqual(result['action'], 'pause_for_review')
