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


class TestLiveSubmissionGateClickHouseFreshness(SubmissionCouncilTestCase):
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
            hypothesis_summary={
                "promotion_eligible_total": 0,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status=self._healthy_quant_status(),
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
        self.assertEqual(result["continuity_source"], "clickhouse_ta_status")
        self.assertEqual(result["continuity_reason"], "accepted_ta_signal_stale")
        self.assertEqual(
            result["clickhouse_ta_freshness"]["accepted_source_state"],
            "stale",
        )

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
