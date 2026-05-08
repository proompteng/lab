from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from app.config import settings
from app.trading.hypotheses import (
    _JANGAR_QUORUM_CACHE,
    JangarDependencyQuorumStatus,
    compile_hypothesis_runtime_statuses,
    hypothesis_registry_requires_dependency_capability,
    load_hypothesis_registry,
    load_jangar_dependency_quorum,
    resolve_hypothesis_dependency_quorum,
    summarize_hypothesis_runtime_statuses,
)


def _state(
    *,
    feature_rows: int = 0,
    drift_checks: int = 0,
    evidence_checks: int = 0,
    signal_lag_seconds: int | None = None,
    autonomy_no_signal_streak: int = 0,
    signal_continuity_alert_active: bool = False,
    evidence_report: dict[str, object] | None = None,
) -> SimpleNamespace:
    metrics = SimpleNamespace(
        feature_batch_rows_total=feature_rows,
        drift_detection_checks_total=drift_checks,
        evidence_continuity_checks_total=evidence_checks,
        signal_lag_seconds=signal_lag_seconds,
    )
    return SimpleNamespace(
        metrics=metrics,
        autonomy_no_signal_streak=autonomy_no_signal_streak,
        signal_continuity_alert_active=signal_continuity_alert_active,
        last_evidence_continuity_report=evidence_report,
    )


def _hypothesis_manifest_payload(
    *,
    hypothesis_id: str,
    lane_id: str,
    strategy_family: str,
    required_dependency_capabilities: list[str],
    initial_state: str = "shadow",
    required_feature_rows: bool = True,
    require_drift_checks: bool = True,
    require_evidence_continuity: bool = True,
    max_market_context_freshness_seconds: int | None = None,
) -> dict[str, object]:
    return {
        "schema_version": "torghut.hypothesis-manifest.v1",
        "hypothesis_id": hypothesis_id,
        "lane_id": lane_id,
        "strategy_family": strategy_family,
        "initial_state": initial_state,
        "required_feature_sets": ["signal_feed", "tca"],
        "required_dependency_capabilities": required_dependency_capabilities,
        "expected_gross_edge_bps": "6",
        "max_allowed_slippage_bps": "12",
        "min_sample_count_for_live_canary": 40,
        "min_sample_count_for_scale_up": 80,
        "max_rolling_drawdown_bps": "150",
        "entry_requirements": {
            "max_signal_lag_seconds": 90,
            "max_market_context_freshness_seconds": max_market_context_freshness_seconds,
            "max_evidence_age_minutes": 30,
            "min_feature_batch_rows": 1,
            "require_feature_rows": required_feature_rows,
            "require_drift_checks": require_drift_checks,
            "require_evidence_continuity": require_evidence_continuity,
            "required_dependency_quorum": "allow",
        },
    }


class _FakeHttpResponse:
    def __init__(self, payload: dict[str, object], status: int = 200) -> None:
        self.status = status
        self._payload = payload

    def read(self) -> bytes:
        return json.dumps(self._payload).encode("utf-8")

    def close(self) -> None:
        return None

    def __enter__(self) -> "_FakeHttpResponse":
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> bool:
        return False


class TestHypothesisReadiness(TestCase):
    def setUp(self) -> None:
        self._settings_snapshot = {
            "trading_hypothesis_registry_path": settings.trading_hypothesis_registry_path,
            "trading_jangar_control_plane_status_url": settings.trading_jangar_control_plane_status_url,
            "trading_jangar_control_plane_cache_ttl_seconds": settings.trading_jangar_control_plane_cache_ttl_seconds,
            "trading_jangar_control_plane_timeout_seconds": settings.trading_jangar_control_plane_timeout_seconds,
        }

    def tearDown(self) -> None:
        settings.trading_hypothesis_registry_path = self._settings_snapshot[
            "trading_hypothesis_registry_path"
        ]
        settings.trading_jangar_control_plane_status_url = self._settings_snapshot[
            "trading_jangar_control_plane_status_url"
        ]
        settings.trading_jangar_control_plane_cache_ttl_seconds = (
            self._settings_snapshot["trading_jangar_control_plane_cache_ttl_seconds"]
        )
        settings.trading_jangar_control_plane_timeout_seconds = self._settings_snapshot[
            "trading_jangar_control_plane_timeout_seconds"
        ]
        _JANGAR_QUORUM_CACHE.clear()

    def test_load_hypothesis_registry_reads_directory_payloads(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "h-cont-01.json").write_text(
                json.dumps(
                    {
                        "schema_version": "torghut.hypothesis-manifest.v1",
                        "hypothesis_id": "H-CONT-01",
                        "lane_id": "continuation",
                        "strategy_family": "intraday_continuation",
                        "initial_state": "shadow",
                        "expected_gross_edge_bps": "6",
                        "max_allowed_slippage_bps": "12",
                        "min_sample_count_for_live_canary": 40,
                        "min_sample_count_for_scale_up": 80,
                        "max_rolling_drawdown_bps": "150",
                    }
                ),
                encoding="utf-8",
            )
            settings.trading_hypothesis_registry_path = str(root)

            result = load_hypothesis_registry()

        self.assertTrue(result.loaded)
        self.assertEqual(len(result.items), 1)
        self.assertEqual(result.items[0].hypothesis_id, "H-CONT-01")
        self.assertEqual(result.errors, [])

    def test_compile_hypothesis_runtime_statuses_stays_shadow_without_feature_and_evidence(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=_state(),
            tca_summary={
                "order_count": 0,
                "avg_abs_slippage_bps": 0,
                "avg_realized_shortfall_bps": 0,
            },
            market_context_status={"last_freshness_seconds": None},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        micro = next(item for item in statuses if item["hypothesis_id"] == "H-MICRO-01")
        self.assertEqual(cont["state"], "shadow")
        self.assertIn("signal_lag_exceeded", cont["reasons"])
        self.assertNotIn("feature_rows_missing", cont["reasons"])
        self.assertNotIn("evidence_continuity_missing", cont["reasons"])
        self.assertNotIn("drift_checks_missing", cont["reasons"])
        self.assertEqual(micro["state"], "blocked")
        self.assertIn("required_feature_set_unavailable", micro["reasons"])

    def test_compile_hypothesis_runtime_statuses_promotes_canary_when_thresholds_are_met(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 45,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -8,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
            },
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        rev = next(item for item in statuses if item["hypothesis_id"] == "H-REV-01")
        self.assertEqual(cont["state"], "canary_live")
        self.assertEqual(cont["capital_stage"], "0.25x canary")
        self.assertEqual(cont["capital_multiplier"], "0.25")
        self.assertTrue(cont["promotion_eligible"])
        self.assertEqual(rev["state"], "canary_live")
        self.assertEqual(cont["observed"]["tca_age_minutes"], 10)

    def test_compile_hypothesis_runtime_statuses_blocks_stale_tca_evidence(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 45,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -8,
                "last_computed_at": "2026-03-06T15:00:00+00:00",
            },
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertEqual(cont["state"], "shadow")
        self.assertFalse(cont["promotion_eligible"])
        self.assertTrue(cont["rollback_required"])
        self.assertIn("tca_evidence_stale", cont["reasons"])
        self.assertEqual(cont["observed"]["tca_age_minutes"], 60)

    def test_compile_hypothesis_runtime_statuses_demotes_closed_session_freshness_holds(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=9_900,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 120,
                "avg_abs_slippage_bps": 20,
                "avg_realized_shortfall_bps": -12,
                "last_computed_at": "2026-03-06T15:00:00+00:00",
            },
            market_context_status={"last_freshness_seconds": 10_000},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 23, 0, tzinfo=timezone.utc),
            market_session_open=False,
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        rev = next(item for item in statuses if item["hypothesis_id"] == "H-REV-01")
        self.assertNotIn("signal_lag_exceeded", cont["reasons"])
        self.assertNotIn("tca_evidence_stale", cont["reasons"])
        self.assertIn("slippage_budget_exceeded", cont["reasons"])
        self.assertIn("closed_session_signal_hold", cont["informational_reasons"])
        self.assertIn("closed_session_tca_evidence_hold", cont["informational_reasons"])
        self.assertNotIn("market_context_stale", rev["reasons"])
        self.assertIn(
            "closed_session_market_context_hold", rev["informational_reasons"]
        )
        self.assertEqual(cont["observed"]["market_session_open"], False)

        summary = summarize_hypothesis_runtime_statuses(
            statuses,
            registry=registry,
            dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
        )
        self.assertEqual(summary["reason_totals"]["slippage_budget_exceeded"], 3)
        self.assertEqual(
            summary["informational_reason_totals"]["closed_session_signal_hold"], 3
        )

    def test_compile_hypothesis_runtime_statuses_isolates_dependency_capabilities_between_hypotheses(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "h-a.json").write_text(
                json.dumps(
                    _hypothesis_manifest_payload(
                        hypothesis_id="H-A-01",
                        lane_id="lane-a",
                        strategy_family="lanes-scope-a",
                        required_dependency_capabilities=[
                            "jangar_dependency_quorum",
                            "signal_continuity",
                        ],
                        required_feature_rows=True,
                    ),
                ),
                encoding="utf-8",
            )
            (root / "h-b.json").write_text(
                json.dumps(
                    _hypothesis_manifest_payload(
                        hypothesis_id="H-B-01",
                        lane_id="lane-b",
                        strategy_family="lanes-scope-b",
                        required_dependency_capabilities=["feature_coverage"],
                        required_feature_rows=True,
                        initial_state="blocked",
                    ),
                ),
                encoding="utf-8",
            )
            settings.trading_hypothesis_registry_path = str(root)

            registry = load_hypothesis_registry()
            self.assertTrue(registry.loaded)
            self.assertEqual(len(registry.items), 2)
            self.assertEqual(len(registry.errors), 0)

            statuses = compile_hypothesis_runtime_statuses(
                registry=registry,
                state=_state(
                    feature_rows=5,
                    drift_checks=3,
                    evidence_checks=2,
                    signal_lag_seconds=15,
                    signal_continuity_alert_active=True,
                    evidence_report={
                        "ok": True,
                        "checked_at": "2026-03-06T15:45:00+00:00",
                    },
                ),
                tca_summary={
                    "order_count": 45,
                    "avg_abs_slippage_bps": 4,
                    "avg_realized_shortfall_bps": -8,
                    "last_computed_at": "2026-03-06T15:50:00+00:00",
                },
                market_context_status={"last_freshness_seconds": 60},
                jangar_dependency_quorum=JangarDependencyQuorumStatus(
                    decision="delay",
                    reasons=["workflow_backoff_warning"],
                    message="degraded",
                ),
                now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
            )

        status_a = next(item for item in statuses if item["hypothesis_id"] == "H-A-01")
        status_b = next(item for item in statuses if item["hypothesis_id"] == "H-B-01")
        self.assertIn("jangar_dependency_delay", status_a["reasons"])
        self.assertIn("signal_continuity_alert_active", status_a["reasons"])
        self.assertNotIn("jangar_dependency_delay", status_b["reasons"])
        self.assertNotIn("signal_continuity_alert_active", status_b["reasons"])
        self.assertIn("dependency_capabilities", status_a)
        self.assertIn("required", status_a["dependency_capabilities"])
        self.assertEqual(
            status_a["dependency_capabilities"]["required"],
            ["jangar_dependency_quorum", "signal_continuity"],
        )

    def test_summarize_hypothesis_runtime_statuses_reports_state_totals(self) -> None:
        registry = load_hypothesis_registry()
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=_state(),
            tca_summary={
                "order_count": 0,
                "avg_abs_slippage_bps": 0,
                "avg_realized_shortfall_bps": 0,
            },
            market_context_status={"last_freshness_seconds": None},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="unknown",
                reasons=["jangar_control_plane_status_url_missing"],
                message="not configured",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        summary = summarize_hypothesis_runtime_statuses(
            statuses,
            registry=registry,
            dependency_quorum=JangarDependencyQuorumStatus(
                decision="unknown",
                reasons=["jangar_control_plane_status_url_missing"],
                message="not configured",
            ),
        )

        self.assertEqual(summary["hypotheses_total"], 3)
        self.assertEqual(summary["state_totals"], {"blocked": 1, "shadow": 2})
        self.assertEqual(summary["capital_stage_totals"], {"shadow": 3})
        self.assertEqual(summary["promotion_eligible_total"], 0)
        self.assertEqual(summary["rollback_required_total"], 0)
        self.assertEqual(
            summary["dependency_quorum"],
            {
                "decision": "unknown",
                "reasons": ["jangar_control_plane_status_url_missing"],
                "message": "not configured",
            },
        )

    def test_load_hypothesis_registry_fails_closed_on_duplicate_ids(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            duplicate_payload = {
                "schema_version": "torghut.hypothesis-manifest.v1",
                "hypothesis_id": "H-CONT-01",
                "lane_id": "continuation",
                "strategy_family": "intraday_continuation",
                "initial_state": "shadow",
                "expected_gross_edge_bps": "6",
                "max_allowed_slippage_bps": "12",
                "min_sample_count_for_live_canary": 40,
                "min_sample_count_for_scale_up": 80,
                "max_rolling_drawdown_bps": "150",
            }
            (root / "one.json").write_text(
                json.dumps(duplicate_payload), encoding="utf-8"
            )
            (root / "two.json").write_text(
                json.dumps(duplicate_payload), encoding="utf-8"
            )
            settings.trading_hypothesis_registry_path = str(root)

            result = load_hypothesis_registry()

        self.assertFalse(result.loaded)
        self.assertEqual(result.items, [])
        self.assertEqual(len(result.errors), 1)
        self.assertIn("duplicate hypothesis_id H-CONT-01", result.errors[0])

    def test_default_hypothesis_registry_self_governs_without_jangar_quorum(
        self,
    ) -> None:
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/status"
        )
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0
        registry = load_hypothesis_registry()

        self.assertTrue(registry.loaded)
        self.assertFalse(
            hypothesis_registry_requires_dependency_capability(
                registry,
                "jangar_dependency_quorum",
            )
        )
        with patch("app.trading.hypotheses.urlopen") as urlopen_mock:
            status = resolve_hypothesis_dependency_quorum(registry)

        urlopen_mock.assert_not_called()
        self.assertEqual(status.decision, "allow")
        self.assertEqual(status.reasons, ["jangar_dependency_quorum_not_required"])

    def test_hypothesis_registry_dependency_check_rejects_blank_capability(
        self,
    ) -> None:
        registry = load_hypothesis_registry()

        self.assertFalse(
            hypothesis_registry_requires_dependency_capability(registry, "")
        )

    def test_resolve_hypothesis_dependency_quorum_fetches_when_manifest_requires_it(
        self,
    ) -> None:
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/status"
        )
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0
        settings.trading_jangar_control_plane_timeout_seconds = 1.0
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "h-cont-01.json").write_text(
                json.dumps(
                    _hypothesis_manifest_payload(
                        hypothesis_id="H-CONT-01",
                        lane_id="continuation",
                        strategy_family="intraday_continuation",
                        required_dependency_capabilities=[
                            "jangar_dependency_quorum",
                            "signal_continuity",
                        ],
                    )
                ),
                encoding="utf-8",
            )
            settings.trading_hypothesis_registry_path = str(root)
            registry = load_hypothesis_registry()

        self.assertTrue(
            hypothesis_registry_requires_dependency_capability(
                registry,
                "jangar_dependency_quorum",
            )
        )
        with patch(
            "app.trading.hypotheses.urlopen",
            return_value=_FakeHttpResponse(
                {
                    "dependency_quorum": {
                        "decision": "delay",
                        "reasons": ["workflow_backoff_warning"],
                        "message": "degraded",
                    }
                }
            ),
        ) as urlopen_mock:
            status = resolve_hypothesis_dependency_quorum(registry)

        urlopen_mock.assert_called_once()
        self.assertEqual(status.decision, "delay")
        self.assertEqual(status.reasons, ["workflow_backoff_warning"])

    def test_load_jangar_dependency_quorum_prefers_dependency_quorum_contract(
        self,
    ) -> None:
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/status"
        )
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0
        settings.trading_jangar_control_plane_timeout_seconds = 1.0
        with patch(
            "app.trading.hypotheses.urlopen",
            return_value=_FakeHttpResponse(
                {
                    "dependency_quorum": {
                        "decision": "delay",
                        "reasons": ["workflow_backoff_warning"],
                        "message": "degraded",
                    },
                    "stage_trust": {
                        "stages": [
                            {
                                "stage": "implement",
                                "state": "renewing",
                                "reason_codes": ["agentrun_active"],
                            }
                        ]
                    },
                    "stage_renewal_bonds": [
                        {
                            "bond_id": "bond-implement-1",
                            "stage": "implement",
                            "state": "renewing",
                        }
                    ],
                    "controller_ingestion_settlement": {
                        "decision": "current",
                        "settlement_id": "ingest-1",
                    },
                    "generated_at": "2026-05-07T12:00:00Z",
                }
            ),
        ):
            status = load_jangar_dependency_quorum()

        self.assertEqual(status.decision, "delay")
        self.assertEqual(status.reasons, ["workflow_backoff_warning"])
        self.assertEqual(status.message, "degraded")
        self.assertEqual(
            status.stage_trust["stages"],
            [
                {
                    "stage": "implement",
                    "state": "renewing",
                    "reason_codes": ["agentrun_active"],
                }
            ],
        )
        self.assertEqual(status.stage_renewal_bonds[0]["bond_id"], "bond-implement-1")
        self.assertEqual(status.controller_ingestion_settlement["decision"], "current")
        self.assertEqual(status.as_payload()["generated_at"], "2026-05-07T12:00:00Z")

    def test_load_jangar_dependency_quorum_falls_back_to_legacy_status_when_needed(
        self,
    ) -> None:
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/status"
        )
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0
        with patch(
            "app.trading.hypotheses.urlopen",
            return_value=_FakeHttpResponse(
                {
                    "workflows": {
                        "data_confidence": "unknown",
                        "backoff_limit_exceeded_jobs": 0,
                    }
                }
            ),
        ):
            status = load_jangar_dependency_quorum()

        self.assertEqual(status.decision, "block")
        self.assertEqual(status.reasons, ["workflows_data_unknown"])

    def test_load_jangar_dependency_quorum_handles_malformed_url(self) -> None:
        settings.trading_jangar_control_plane_status_url = "jangar.example/status"
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0

        status = load_jangar_dependency_quorum()

        self.assertEqual(status.decision, "unknown")
        self.assertEqual(status.reasons, ["jangar_status_fetch_failed"])
        self.assertIn("fetch failed", status.message)
