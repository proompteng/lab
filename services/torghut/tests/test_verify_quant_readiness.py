from __future__ import annotations

import argparse
import io
import json
import tempfile
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from scripts.verify_quant_readiness import (
    AcceptanceWindowThresholds,
    ReadinessCounts,
    ReadinessThresholds,
    _add_optional_artifact_checks,
    _build_core_checks,
    _build_readiness_payload,
    _emit_readiness_payload,
    _evaluate_acceptance_window,
    _load_control_plane_contract,
    _load_gate_trace,
    _load_incident_evidence,
    _load_readiness_counts,
    _load_model_risk_evidence_package,
    _load_profitability_proof,
    main,
)
from scripts.quant_readiness_artifacts import _parse_iso8601_timestamp


class _FakeExecuteResult:
    def __init__(
        self,
        *,
        scalar: int | None = None,
        row: tuple[int, int] | None = None,
    ) -> None:
        self._scalar = scalar
        self._row = row

    def scalar_one(self) -> int:
        if self._scalar is None:
            raise AssertionError("fake scalar result was not configured")
        return self._scalar

    def one(self) -> tuple[int, int]:
        if self._row is None:
            raise AssertionError("fake row result was not configured")
        return self._row


class _FakeSession:
    def __init__(self, results: list[_FakeExecuteResult]) -> None:
        self.results = results
        self.queries: list[object] = []

    def execute(self, query: object) -> _FakeExecuteResult:
        self.queries.append(query)
        if not self.results:
            raise AssertionError("unexpected extra query")
        return self.results.pop(0)


class _FakeSessionContext:
    def __init__(self, session: _FakeSession) -> None:
        self.session = session

    def __enter__(self) -> _FakeSession:
        return self.session

    def __exit__(self, *args: object) -> None:
        return None


def _readiness_thresholds() -> ReadinessThresholds:
    return ReadinessThresholds(
        max_missing_provenance=0,
        max_invalid_fallback_reason=0,
        max_missing_research_traces=0,
        max_model_risk_evidence_age_hours=24,
        acceptance=AcceptanceWindowThresholds(
            min_non_skipped_runs=1,
            min_trade_decisions=1,
            min_executions=1,
            min_full_chain_runs=1,
            min_route_coverage_ratio=0.95,
            min_execution_advisor_coverage_ratio=0.85,
            max_route_fallback_ratio=0.25,
        ),
    )


def _model_risk_payload(now: datetime) -> dict[str, object]:
    return {
        "schema_version": "torghut.model-risk-evidence.v1",
        "generated_at": now.isoformat(),
        "promotion": {
            "gate_report_trace_id": "gate-trace-1",
            "recommendation_trace_id": "rec-trace-1",
        },
        "rollback": {
            "incident_evidence_complete": True,
            "incident_evidence_path": "/tmp/rollback.json",
        },
        "drift": {
            "evidence_continuity_passed": True,
            "evidence_continuity_report_path": "/tmp/evidence.json",
        },
        "runbook_drill": {
            "emergency_stop_rehearsed": True,
            "rehearsal_at": now.isoformat(),
        },
        "legacy_gap_disposition": {
            "signed_disposition_complete": True,
            "mapping_path": "docs/torghut/design-system/v6/14-legacy-gap-disposition-map-2026-03-03.md",
        },
    }


def _control_plane_payload() -> dict[str, object]:
    return {
        "contract_version": "torghut.quant-producer.v1",
        "signal_continuity_state": "signals_present",
        "signal_continuity_alert_active": False,
        "signal_continuity_promotion_block_total": 0,
        "last_autonomy_recommendation_trace_id": "trace-1",
        "domain_telemetry_event_total": {"torghut.autonomy.cycle_completed": 2},
        "domain_telemetry_dropped_total": {"disabled": 2},
        "alpha_readiness_hypotheses_total": 3,
        "alpha_readiness_shadow_total": 2,
        "alpha_readiness_blocked_total": 1,
        "alpha_readiness_dependency_quorum_decision": "unknown",
    }


def _profitability_payload() -> dict[str, object]:
    return {
        "hypothesis": "alpha proof",
        "sample_size": 12,
        "window_days": 30,
        "statistics": {"effect_size": 1.2, "p_value": 0.04},
        "risk_controls": {"max_drawdown_delta": 0.1},
    }


def _incident_payload(now: datetime) -> dict[str, object]:
    return {
        "triggered_at": now.isoformat(),
        "reasons": ["manual-stop"],
        "rollback_hooks": {"order_submission_blocked": True},
        "safety_snapshot": {},
        "provenance": {},
        "verification": {"incident_evidence_complete": True},
    }


class TestVerifyQuantReadiness(TestCase):
    def _assert_loader_rejects(
        self,
        loader: Callable[[Path], object],
        payload: object,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "payload.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaises(ValueError):
                loader(path)

    def test_load_gate_trace_reads_required_trace_ids(self) -> None:
        payload = {
            "provenance": {
                "gate_report_trace_id": "abc123",
                "recommendation_trace_id": "def456",
            }
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "gate.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            trace = _load_gate_trace(path)
        self.assertEqual(trace["gate_report_trace_id"], "abc123")
        self.assertEqual(trace["recommendation_trace_id"], "def456")

    def test_load_gate_trace_raises_when_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "gate.json"
            path.write_text(
                json.dumps({"provenance": {"gate_report_trace_id": "abc123"}}),
                encoding="utf-8",
            )
            with self.assertRaises(ValueError):
                _load_gate_trace(path)

    def test_parse_iso8601_rejects_invalid_timestamp_shapes(self) -> None:
        self.assertEqual(
            _parse_iso8601_timestamp("2026-03-03T20:00:00Z", field_name="field"),
            datetime(2026, 3, 3, 20, 0, tzinfo=timezone.utc),
        )
        for raw in ("", "not-a-time", "2026-03-03T20:00:00"):
            with self.assertRaises(ValueError):
                _parse_iso8601_timestamp(raw, field_name="field")

    def test_load_gate_trace_rejects_invalid_payload_shapes(self) -> None:
        self._assert_loader_rejects(_load_gate_trace, [])
        self._assert_loader_rejects(_load_gate_trace, {"provenance": []})
        self._assert_loader_rejects(
            _load_gate_trace,
            {"provenance": {"recommendation_trace_id": "rec-1"}},
        )

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
        self.assertTrue(result["passed"])
        lookback = result["lookback"]
        self.assertEqual(lookback["route_coverage_ratio"], 1.0)
        self.assertEqual(lookback["execution_advisor_coverage_ratio"], 1.0)
        self.assertEqual(lookback["route_fallback_ratio"], 0.0)

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
        self.assertFalse(result["passed"])
        lookback = result["lookback"]
        self.assertEqual(lookback["route_coverage_ratio"], 0.75)

    def test_acceptance_window_fails_when_execution_advisor_coverage_too_low(
        self,
    ) -> None:
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
        self.assertFalse(result["passed"])
        lookback = result["lookback"]
        self.assertEqual(lookback["execution_advisor_coverage_ratio"], 0.8)

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
        self.assertFalse(result["passed"])
        lookback = result["lookback"]
        self.assertEqual(lookback["route_fallback_ratio"], 0.4)

    def test_load_readiness_counts_wires_query_results(self) -> None:
        fake_session = _FakeSession(
            [
                _FakeExecuteResult(row=(8, 7)),
                _FakeExecuteResult(scalar=1),
                _FakeExecuteResult(scalar=10),
                _FakeExecuteResult(scalar=2),
                _FakeExecuteResult(scalar=0),
                _FakeExecuteResult(scalar=0),
                _FakeExecuteResult(scalar=3),
                _FakeExecuteResult(scalar=6),
                _FakeExecuteResult(scalar=5),
                _FakeExecuteResult(scalar=2),
            ]
        )
        with patch(
            "scripts.verify_quant_readiness.SessionLocal",
            return_value=_FakeSessionContext(fake_session),
        ):
            counts = _load_readiness_counts(datetime(2026, 3, 3, tzinfo=timezone.utc))

        self.assertEqual(counts.missing_route_count, 1)
        self.assertEqual(counts.total_route_count, 10)
        self.assertEqual(counts.advisor_eligible_rows, 8)
        self.assertEqual(counts.full_chain_runs, 2)
        self.assertEqual(len(fake_session.queries), 10)

    def test_core_checks_and_payload_preserve_readiness_shape(self) -> None:
        counts = ReadinessCounts(
            missing_route_count=0,
            total_route_count=10,
            fallback_route_count=2,
            invalid_fallback_reason_count=0,
            missing_research_trace_count=0,
            non_skipped_runs=3,
            trade_decisions=6,
            advisor_eligible_rows=8,
            advisor_payload_rows=7,
            executions=5,
            full_chain_runs=2,
        )
        checks = _build_core_checks(counts, _readiness_thresholds())
        now = datetime(2026, 3, 3, 20, 0, tzinfo=timezone.utc)
        payload = _build_readiness_payload(
            now=now,
            lookback_start=now - timedelta(hours=24),
            lookback_hours=24,
            checks=checks,
        )

        self.assertTrue(payload["ok"])
        self.assertTrue(checks["acceptance_window"]["passed"])
        self.assertEqual(checks["execution_route_fallback_ratio"]["ratio"], 0.2)
        self.assertEqual(
            checks["execution_advisor_provenance"]["coverage_ratio"],
            0.875,
        )

    def test_main_emits_default_readiness_payload(self) -> None:
        counts = ReadinessCounts(
            missing_route_count=0,
            total_route_count=10,
            fallback_route_count=0,
            invalid_fallback_reason_count=0,
            missing_research_trace_count=0,
            non_skipped_runs=2,
            trade_decisions=2,
            advisor_eligible_rows=2,
            advisor_payload_rows=2,
            executions=2,
            full_chain_runs=1,
        )
        with (
            patch(
                "scripts.verify_quant_readiness._load_readiness_counts",
                return_value=counts,
            ),
            patch("sys.argv", ["verify_quant_readiness.py"]),
            patch("sys.stdout", new_callable=io.StringIO) as stdout,
        ):
            main()

        payload = json.loads(stdout.getvalue())
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["lookback_hours"], 24)

    def test_emit_readiness_payload_exits_when_checks_fail(self) -> None:
        with (
            patch("sys.stdout", new_callable=io.StringIO),
            self.assertRaises(SystemExit),
        ):
            _emit_readiness_payload({"ok": False, "checks": {}})

    def test_load_control_plane_contract_requires_wave6_keys(self) -> None:
        payload = _control_plane_payload()
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "control-plane-contract.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            loaded = _load_control_plane_contract(path)
        self.assertEqual(loaded["contract_version"], "torghut.quant-producer.v1")

    def test_load_control_plane_contract_rejects_missing_keys(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "control-plane-contract.json"
            path.write_text(
                json.dumps({"contract_version": "torghut.quant-producer.v1"}),
                encoding="utf-8",
            )
            with self.assertRaises(ValueError):
                _load_control_plane_contract(path)

    def test_load_control_plane_contract_rejects_invalid_shapes(self) -> None:
        valid = _control_plane_payload()
        invalid_cases: list[object] = [
            [],
            valid | {"contract_version": "bad"},
            valid | {"domain_telemetry_event_total": []},
            valid | {"domain_telemetry_dropped_total": []},
            valid | {"alpha_readiness_dependency_quorum_decision": "bad"},
        ]
        for payload in invalid_cases:
            with self.subTest(payload=payload):
                self._assert_loader_rejects(_load_control_plane_contract, payload)

    def test_load_profitability_proof_rejects_invalid_shapes(self) -> None:
        valid = _profitability_payload()
        invalid_cases: list[object] = [
            [],
            {"hypothesis": "alpha proof"},
            valid | {"statistics": []},
            valid | {"statistics": {"effect_size": "bad", "p_value": 0.04}},
            valid | {"sample_size": 0},
            valid | {"statistics": {"effect_size": 1.2, "p_value": 2}},
            valid | {"risk_controls": []},
            valid | {"risk_controls": {"max_drawdown_delta": "bad"}},
            valid | {"window_days": 0},
            valid | {"hypothesis": ""},
        ]
        for payload in invalid_cases:
            with self.subTest(payload=payload):
                self._assert_loader_rejects(_load_profitability_proof, payload)

    def test_load_incident_evidence_rejects_invalid_shapes(self) -> None:
        now = datetime(2026, 3, 3, 20, 0, tzinfo=timezone.utc)
        valid = _incident_payload(now)
        invalid_cases: list[object] = [
            [],
            {"triggered_at": now.isoformat()},
            valid | {"rollback_hooks": []},
            valid | {"reasons": []},
            valid | {"rollback_hooks": {"order_submission_blocked": False}},
            valid | {"verification": []},
            valid | {"verification": {"incident_evidence_complete": False}},
        ]
        for payload in invalid_cases:
            with self.subTest(payload=payload):
                self._assert_loader_rejects(_load_incident_evidence, payload)

    def test_load_model_risk_evidence_package_passes_when_complete(self) -> None:
        now = datetime(2026, 3, 3, 20, 0, tzinfo=timezone.utc)
        payload = _model_risk_payload(now)
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "model-risk-evidence.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            loaded = _load_model_risk_evidence_package(
                path,
                now=now,
                max_age_hours=24,
            )
        self.assertEqual(loaded["promotion_gate_report_trace_id"], "gate-trace-1")
        self.assertEqual(
            loaded["legacy_mapping_path"],
            "docs/torghut/design-system/v6/14-legacy-gap-disposition-map-2026-03-03.md",
        )

    def test_load_model_risk_evidence_package_rejects_stale_payload(self) -> None:
        now = datetime(2026, 3, 3, 20, 0, tzinfo=timezone.utc)
        stale = now - timedelta(hours=72)
        payload = _model_risk_payload(now) | {"generated_at": stale.isoformat()}
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "model-risk-evidence.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaises(ValueError):
                _load_model_risk_evidence_package(path, now=now, max_age_hours=24)

    def test_load_model_risk_evidence_package_rejects_future_generated_at(self) -> None:
        now = datetime(2026, 3, 3, 20, 0, tzinfo=timezone.utc)
        future = now + timedelta(hours=2)
        payload = _model_risk_payload(now) | {"generated_at": future.isoformat()}
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "model-risk-evidence.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaises(ValueError):
                _load_model_risk_evidence_package(path, now=now, max_age_hours=24)

    def test_load_model_risk_evidence_package_rejects_invalid_schema_version(
        self,
    ) -> None:
        now = datetime(2026, 3, 3, 20, 0, tzinfo=timezone.utc)
        payload = _model_risk_payload(now) | {
            "schema_version": "torghut.model-risk-evidence.v2"
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "model-risk-evidence.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaises(ValueError):
                _load_model_risk_evidence_package(path, now=now, max_age_hours=24)

    def test_load_model_risk_evidence_package_rejects_invalid_nested_shapes(
        self,
    ) -> None:
        now = datetime(2026, 3, 3, 20, 0, tzinfo=timezone.utc)
        valid = _model_risk_payload(now)
        invalid_cases: list[object] = [
            [],
            {"schema_version": "torghut.model-risk-evidence.v1"},
            valid | {"generated_at": 123},
            valid | {"promotion": []},
            valid | {"promotion": {"gate_report_trace_id": ""}},
            valid | {"rollback": {"incident_evidence_path": "/tmp/rollback.json"}},
            valid | {"drift": {"evidence_continuity_passed": False}},
            valid | {"runbook_drill": {"rehearsal_at": ""}},
            valid | {"legacy_gap_disposition": {"signed_disposition_complete": False}},
        ]
        with tempfile.TemporaryDirectory() as tmpdir:
            base = Path(tmpdir)
            for index, payload in enumerate(invalid_cases):
                path = base / f"model-risk-{index}.json"
                path.write_text(json.dumps(payload), encoding="utf-8")
                with self.subTest(payload=payload), self.assertRaises(ValueError):
                    _load_model_risk_evidence_package(
                        path,
                        now=now,
                        max_age_hours=24,
                    )

    def test_optional_artifact_checks_add_passed_summaries(self) -> None:
        now = datetime(2026, 3, 3, 20, 0, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as tmpdir:
            base = Path(tmpdir)
            gate_path = base / "gate.json"
            gate_path.write_text(
                json.dumps(
                    {
                        "provenance": {
                            "gate_report_trace_id": "gate-1",
                            "recommendation_trace_id": "rec-1",
                        }
                    }
                ),
                encoding="utf-8",
            )
            incident_path = base / "incident.json"
            incident_path.write_text(
                json.dumps(
                    {
                        "triggered_at": now.isoformat(),
                        "reasons": ["manual-stop"],
                        "rollback_hooks": {"order_submission_blocked": True},
                        "safety_snapshot": {},
                        "provenance": {},
                        "verification": {"incident_evidence_complete": True},
                    }
                ),
                encoding="utf-8",
            )
            proof_path = base / "proof.json"
            proof_path.write_text(
                json.dumps(_profitability_payload()),
                encoding="utf-8",
            )
            contract_path = base / "contract.json"
            contract_path.write_text(
                json.dumps(_control_plane_payload()),
                encoding="utf-8",
            )
            model_risk_path = base / "model-risk.json"
            model_risk_path.write_text(
                json.dumps(_model_risk_payload(now)),
                encoding="utf-8",
            )

            checks: dict[str, object] = {}
            args = argparse.Namespace(
                gate_report=gate_path,
                incident_evidence=incident_path,
                profitability_proof=proof_path,
                control_plane_contract=contract_path,
                model_risk_evidence_package=model_risk_path,
            )
            _add_optional_artifact_checks(
                checks,
                args,
                now=now,
                thresholds=_readiness_thresholds(),
            )

        self.assertEqual(
            set(checks),
            {
                "governance_trace",
                "rollback_incident_evidence",
                "profitability_evidence",
                "control_plane_contract",
                "model_risk_evidence_package",
            },
        )
        self.assertTrue(all(bool(item["passed"]) for item in checks.values()))
