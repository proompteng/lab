from __future__ import annotations

from app.trading.submission_council.quant_health import (
    runtime_window_import_continuity_signal,
)
from tests.submission_council.support import (
    SimpleNamespace,
    SubmissionCouncilTestCase,
    build_live_submission_gate_payload,
    datetime,
    timezone,
)


_ACCEPTED_SOURCE_GATE_FIELDS = (
    "accepted_sources",
    "latest_accepted_event_at",
    "accepted_lag_seconds",
    "accepted_max_lag_seconds",
    "accepted_source_state",
    "blocking_reason",
    "fresh_until",
    "freshness_reason_codes",
    "excluded_fresher_sources",
    "per_symbol_coverage",
    "stale_symbol_coverage",
    "market_session_state",
    "regular_session_open",
    "regular_session_open_at",
    "regular_session_close_at",
)


class TestLiveSubmissionGateClickHouseFreshness(SubmissionCouncilTestCase):
    def _assert_accepted_source_freshness_mirrored(
        self,
        result: dict[str, object],
    ) -> None:
        freshness = result["clickhouse_ta_freshness"]
        self.assertIsInstance(freshness, dict)
        for field in _ACCEPTED_SOURCE_GATE_FIELDS:
            self.assertIn(field, result)
            self.assertEqual(result[field], freshness[field])

    def test_build_live_submission_gate_payload_blocks_missing_accepted_clickhouse_ta_status(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                market_session_open=True,
                last_autonomy_promotion_eligible=False,
                last_autonomy_promotion_action=None,
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=45,
                metrics=SimpleNamespace(
                    feature_batch_rows_total=0,
                    feature_null_rate={},
                    feature_staleness_ms_p95=0,
                    feature_duplicate_ratio=0.0,
                    decision_state_total={},
                ),
            ),
            clickhouse_ta_status={
                "state": "missing",
                "reason_codes": ["clickhouse_ta_latest_signal_missing"],
                "accepted_sources": ["ta"],
                "latest_accepted_event_at": None,
                "accepted_lag_seconds": None,
                "accepted_max_lag_seconds": 300,
                "accepted_source_state": "missing",
                "blocking_reason": "accepted_ta_signal_missing",
                "fresh_until": None,
                "freshness_reason_codes": ["clickhouse_ta_latest_signal_missing"],
                "excluded_fresher_sources": [],
                "per_symbol_coverage": [],
                "stale_symbol_coverage": [],
                "market_session_state": "regular_open",
                "regular_session_open": True,
            },
        )

        self.assertFalse(result["allowed"])
        self.assertIn("accepted_ta_signal_missing", result["blocked_reasons"])
        freshness = result["clickhouse_ta_freshness"]
        self.assertEqual(freshness["accepted_source_state"], "missing")
        self.assertEqual(freshness["blocking_reason"], "accepted_ta_signal_missing")
        self.assertEqual(
            freshness["freshness_reason_codes"],
            ["clickhouse_ta_latest_signal_missing"],
        )
        self.assertEqual(freshness["market_session_state"], "regular_open")
        self._assert_accepted_source_freshness_mirrored(result)

    def test_build_live_submission_gate_payload_blocks_stale_accepted_clickhouse_ta_status(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                market_session_open=True,
                last_autonomy_promotion_eligible=False,
                last_autonomy_promotion_action=None,
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=45,
                metrics=SimpleNamespace(
                    feature_batch_rows_total=9,
                    feature_null_rate={"price": 0.0},
                    feature_staleness_ms_p95=250,
                    feature_duplicate_ratio=0.0,
                    decision_state_total={},
                ),
            ),
            clickhouse_ta_status={
                "state": "current",
                "latest_signal_at": datetime.now(timezone.utc).isoformat(),
                "accepted_sources": ["ta"],
                "accepted_source_state": "stale",
                "accepted_lag_seconds": 608_000,
                "accepted_max_lag_seconds": 120,
                "blocking_reason": "accepted_ta_signal_stale",
                "excluded_fresher_sources": [
                    {
                        "source": "rest",
                        "excluded_reason": "source_not_allowed_for_live_runtime",
                    }
                ],
                "per_symbol_coverage": [],
                "source_ref": "clickhouse:ta_signals",
            },
        )

        self.assertFalse(result["allowed"])
        self.assertIn("accepted_ta_signal_stale", result["blocked_reasons"])
        self.assertEqual(
            result["clickhouse_ta_freshness"]["accepted_source_state"],
            "stale",
        )
        self._assert_accepted_source_freshness_mirrored(result)

    def test_deferred_clickhouse_ta_status_blocks_live_submission(self) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                market_session_open=True,
                last_autonomy_promotion_eligible=False,
                last_autonomy_promotion_action=None,
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=45,
                metrics=SimpleNamespace(
                    feature_batch_rows_total=9,
                    feature_null_rate={"price": 0.0},
                    feature_staleness_ms_p95=250,
                    feature_duplicate_ratio=0.0,
                    decision_state_total={},
                ),
            ),
            clickhouse_ta_status={
                "state": "deferred",
                "read_model_unavailable": True,
                "accepted_sources": ["ta"],
                "accepted_source_state": "current",
                "blocking_reason": None,
                "freshness_reason_codes": [],
            },
        )

        self.assertFalse(result["allowed"])
        self.assertIn("accepted_ta_signal_unavailable", result["blocked_reasons"])

    def test_simulation_ta_freshness_diagnostic_does_not_block_live_submission(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                market_session_open=True,
                last_autonomy_promotion_eligible=False,
                last_autonomy_promotion_action=None,
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=45,
                metrics=SimpleNamespace(
                    feature_batch_rows_total=9,
                    feature_null_rate={"price": 0.0},
                    feature_staleness_ms_p95=250,
                    feature_duplicate_ratio=0.0,
                    decision_state_total={},
                ),
            ),
            clickhouse_ta_status={
                "state": "current",
                "accepted_sources": ["ta"],
                "accepted_source_state": "missing",
                "accepted_source_diagnostic_only": True,
                "blocking_reason": None,
                "freshness_reason_codes": ["clickhouse_ta_latest_signal_missing"],
            },
        )

        self.assertNotIn("accepted_ta_signal_missing", result["blocked_reasons"])
        self.assertNotIn("accepted_ta_signal_unavailable", result["blocked_reasons"])

    def test_clickhouse_stale_status_overrides_cached_runtime_ready_state(self) -> None:
        result = runtime_window_import_continuity_signal(
            SimpleNamespace(
                last_signal_continuity_state="signals_present",
                last_signal_continuity_reason="signals_present",
                last_signal_continuity_actionable=False,
                signal_continuity_alert_active=False,
            ),
            clickhouse_ta_status={
                "state": "current",
                "latest_signal_at": datetime.now(timezone.utc).isoformat(),
                "accepted_source_state": "stale",
                "blocking_reason": None,
            },
        )

        self.assertEqual(
            result,
            ("false", "clickhouse_ta_status", "accepted_ta_signal_stale"),
        )

    def test_clickhouse_after_hours_accepted_lag_does_not_emit_stale_blocker(
        self,
    ) -> None:
        result = runtime_window_import_continuity_signal(
            SimpleNamespace(
                last_signal_continuity_state="signals_present",
                last_signal_continuity_reason="signals_present",
                last_signal_continuity_actionable=False,
                signal_continuity_alert_active=False,
            ),
            clickhouse_ta_status={
                "state": "current",
                "latest_signal_at": "2026-07-07T20:47:05+00:00",
                "accepted_source_state": "outside_regular_session",
                "blocking_reason": None,
                "market_session_state": "after_market_close",
            },
        )

        self.assertEqual(
            result,
            (
                "true",
                "clickhouse_ta_status",
                "accepted_ta_signal_after_market_close",
            ),
        )
