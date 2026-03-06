from __future__ import annotations

import json
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import TestCase

from scripts.verify_quant_readiness import (
    _evaluate_acceptance_window,
    _load_control_plane_contract,
    _load_gate_trace,
    _load_model_risk_evidence_package,
)


class TestVerifyQuantReadiness(TestCase):
    def test_load_gate_trace_reads_required_trace_ids(self) -> None:
        payload = {
            'provenance': {
                'gate_report_trace_id': 'abc123',
                'recommendation_trace_id': 'def456',
            }
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / 'gate.json'
            path.write_text(json.dumps(payload), encoding='utf-8')
            trace = _load_gate_trace(path)
        self.assertEqual(trace['gate_report_trace_id'], 'abc123')
        self.assertEqual(trace['recommendation_trace_id'], 'def456')

    def test_load_gate_trace_raises_when_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / 'gate.json'
            path.write_text(json.dumps({'provenance': {'gate_report_trace_id': 'abc123'}}), encoding='utf-8')
            with self.assertRaises(ValueError):
                _load_gate_trace(path)

    def test_acceptance_window_passes_when_thresholds_met(self) -> None:
        result = _evaluate_acceptance_window(
            non_skipped_runs=3,
            trade_decisions=18,
            executions=7,
            full_chain_runs=2,
            route_total=10,
            missing_route_rows=0,
            route_fallback_rows=0,
            advisor_eligible_rows=18,
            advisor_payload_rows=18,
            min_non_skipped_runs=1,
            min_trade_decisions=1,
            min_executions=1,
            min_full_chain_runs=1,
            min_route_coverage_ratio=0.95,
            min_execution_advisor_coverage_ratio=0.95,
            max_route_fallback_ratio=0.1,
        )
        self.assertTrue(result['passed'])
        lookback = result['lookback']
        self.assertEqual(lookback['route_coverage_ratio'], 1.0)
        self.assertEqual(lookback['execution_advisor_coverage_ratio'], 1.0)
        self.assertEqual(lookback['route_fallback_ratio'], 0.0)

    def test_acceptance_window_fails_when_route_coverage_too_low(self) -> None:
        result = _evaluate_acceptance_window(
            non_skipped_runs=2,
            trade_decisions=4,
            executions=4,
            full_chain_runs=1,
            route_total=4,
            missing_route_rows=1,
            route_fallback_rows=0,
            advisor_eligible_rows=4,
            advisor_payload_rows=4,
            min_non_skipped_runs=1,
            min_trade_decisions=1,
            min_executions=1,
            min_full_chain_runs=1,
            min_route_coverage_ratio=0.9,
            min_execution_advisor_coverage_ratio=0.9,
            max_route_fallback_ratio=0.2,
        )
        self.assertFalse(result['passed'])
        lookback = result['lookback']
        self.assertEqual(lookback['route_coverage_ratio'], 0.75)

    def test_acceptance_window_fails_when_execution_advisor_coverage_too_low(self) -> None:
        result = _evaluate_acceptance_window(
            non_skipped_runs=2,
            trade_decisions=10,
            executions=5,
            full_chain_runs=2,
            route_total=5,
            missing_route_rows=0,
            route_fallback_rows=0,
            advisor_eligible_rows=10,
            advisor_payload_rows=8,
            min_non_skipped_runs=1,
            min_trade_decisions=1,
            min_executions=1,
            min_full_chain_runs=1,
            min_route_coverage_ratio=0.9,
            min_execution_advisor_coverage_ratio=0.9,
            max_route_fallback_ratio=0.2,
        )
        self.assertFalse(result['passed'])
        lookback = result['lookback']
        self.assertEqual(lookback['execution_advisor_coverage_ratio'], 0.8)

    def test_acceptance_window_fails_when_route_fallback_ratio_too_high(self) -> None:
        result = _evaluate_acceptance_window(
            non_skipped_runs=2,
            trade_decisions=10,
            executions=5,
            full_chain_runs=2,
            route_total=5,
            missing_route_rows=0,
            route_fallback_rows=2,
            advisor_eligible_rows=10,
            advisor_payload_rows=10,
            min_non_skipped_runs=1,
            min_trade_decisions=1,
            min_executions=1,
            min_full_chain_runs=1,
            min_route_coverage_ratio=0.9,
            min_execution_advisor_coverage_ratio=0.9,
            max_route_fallback_ratio=0.2,
        )
        self.assertFalse(result['passed'])
        lookback = result['lookback']
        self.assertEqual(lookback['route_fallback_ratio'], 0.4)

    def test_load_control_plane_contract_requires_wave6_keys(self) -> None:
        payload = {
            'contract_version': 'torghut.quant-producer.v1',
            'signal_continuity_state': 'signals_present',
            'signal_continuity_alert_active': False,
            'signal_continuity_promotion_block_total': 0,
            'last_autonomy_recommendation_trace_id': 'trace-1',
            'domain_telemetry_event_total': {'torghut.autonomy.cycle_completed': 2},
            'domain_telemetry_dropped_total': {'disabled': 2},
            'alpha_readiness_hypotheses_total': 3,
            'alpha_readiness_shadow_total': 2,
            'alpha_readiness_blocked_total': 1,
            'alpha_readiness_dependency_quorum_decision': 'unknown',
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / 'control-plane-contract.json'
            path.write_text(json.dumps(payload), encoding='utf-8')
            loaded = _load_control_plane_contract(path)
        self.assertEqual(loaded['contract_version'], 'torghut.quant-producer.v1')

    def test_load_control_plane_contract_rejects_missing_keys(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / 'control-plane-contract.json'
            path.write_text(json.dumps({'contract_version': 'torghut.quant-producer.v1'}), encoding='utf-8')
            with self.assertRaises(ValueError):
                _load_control_plane_contract(path)

    def test_load_model_risk_evidence_package_passes_when_complete(self) -> None:
        now = datetime(2026, 3, 3, 20, 0, tzinfo=timezone.utc)
        payload = {
            'schema_version': 'torghut.model-risk-evidence.v1',
            'generated_at': now.isoformat(),
            'promotion': {
                'gate_report_trace_id': 'gate-trace-1',
                'recommendation_trace_id': 'rec-trace-1',
            },
            'rollback': {
                'incident_evidence_complete': True,
                'incident_evidence_path': '/tmp/rollback.json',
            },
            'drift': {
                'evidence_continuity_passed': True,
                'evidence_continuity_report_path': '/tmp/evidence.json',
            },
            'runbook_drill': {
                'emergency_stop_rehearsed': True,
                'rehearsal_at': now.isoformat(),
            },
            'legacy_gap_disposition': {
                'signed_disposition_complete': True,
                'mapping_path': 'docs/torghut/design-system/v6/14-legacy-gap-disposition-map-2026-03-03.md',
            },
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / 'model-risk-evidence.json'
            path.write_text(json.dumps(payload), encoding='utf-8')
            loaded = _load_model_risk_evidence_package(
                path,
                now=now,
                max_age_hours=24,
            )
        self.assertEqual(loaded['promotion_gate_report_trace_id'], 'gate-trace-1')
        self.assertEqual(
            loaded['legacy_mapping_path'],
            'docs/torghut/design-system/v6/14-legacy-gap-disposition-map-2026-03-03.md',
        )

    def test_load_model_risk_evidence_package_rejects_stale_payload(self) -> None:
        now = datetime(2026, 3, 3, 20, 0, tzinfo=timezone.utc)
        stale = now - timedelta(hours=72)
        payload = {
            'schema_version': 'torghut.model-risk-evidence.v1',
            'generated_at': stale.isoformat(),
            'promotion': {
                'gate_report_trace_id': 'gate-trace-1',
                'recommendation_trace_id': 'rec-trace-1',
            },
            'rollback': {
                'incident_evidence_complete': True,
                'incident_evidence_path': '/tmp/rollback.json',
            },
            'drift': {
                'evidence_continuity_passed': True,
                'evidence_continuity_report_path': '/tmp/evidence.json',
            },
            'runbook_drill': {
                'emergency_stop_rehearsed': True,
                'rehearsal_at': now.isoformat(),
            },
            'legacy_gap_disposition': {
                'signed_disposition_complete': True,
                'mapping_path': 'docs/torghut/design-system/v6/14-legacy-gap-disposition-map-2026-03-03.md',
            },
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / 'model-risk-evidence.json'
            path.write_text(json.dumps(payload), encoding='utf-8')
            with self.assertRaises(ValueError):
                _load_model_risk_evidence_package(path, now=now, max_age_hours=24)

    def test_load_model_risk_evidence_package_rejects_future_generated_at(self) -> None:
        now = datetime(2026, 3, 3, 20, 0, tzinfo=timezone.utc)
        future = now + timedelta(hours=2)
        payload = {
            'schema_version': 'torghut.model-risk-evidence.v1',
            'generated_at': future.isoformat(),
            'promotion': {
                'gate_report_trace_id': 'gate-trace-1',
                'recommendation_trace_id': 'rec-trace-1',
            },
            'rollback': {
                'incident_evidence_complete': True,
                'incident_evidence_path': '/tmp/rollback.json',
            },
            'drift': {
                'evidence_continuity_passed': True,
                'evidence_continuity_report_path': '/tmp/evidence.json',
            },
            'runbook_drill': {
                'emergency_stop_rehearsed': True,
                'rehearsal_at': now.isoformat(),
            },
            'legacy_gap_disposition': {
                'signed_disposition_complete': True,
                'mapping_path': 'docs/torghut/design-system/v6/14-legacy-gap-disposition-map-2026-03-03.md',
            },
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / 'model-risk-evidence.json'
            path.write_text(json.dumps(payload), encoding='utf-8')
            with self.assertRaises(ValueError):
                _load_model_risk_evidence_package(path, now=now, max_age_hours=24)

    def test_load_model_risk_evidence_package_rejects_invalid_schema_version(self) -> None:
        now = datetime(2026, 3, 3, 20, 0, tzinfo=timezone.utc)
        payload = {
            'schema_version': 'torghut.model-risk-evidence.v2',
            'generated_at': now.isoformat(),
            'promotion': {
                'gate_report_trace_id': 'gate-trace-1',
                'recommendation_trace_id': 'rec-trace-1',
            },
            'rollback': {
                'incident_evidence_complete': True,
                'incident_evidence_path': '/tmp/rollback.json',
            },
            'drift': {
                'evidence_continuity_passed': True,
                'evidence_continuity_report_path': '/tmp/evidence.json',
            },
            'runbook_drill': {
                'emergency_stop_rehearsed': True,
                'rehearsal_at': now.isoformat(),
            },
            'legacy_gap_disposition': {
                'signed_disposition_complete': True,
                'mapping_path': 'docs/torghut/design-system/v6/14-legacy-gap-disposition-map-2026-03-03.md',
            },
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / 'model-risk-evidence.json'
            path.write_text(json.dumps(payload), encoding='utf-8')
            with self.assertRaises(ValueError):
                _load_model_risk_evidence_package(path, now=now, max_age_hours=24)
