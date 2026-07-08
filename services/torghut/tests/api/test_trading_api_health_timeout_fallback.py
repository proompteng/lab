from __future__ import annotations

from app.api import health_cache_state
from app.api.readiness_helpers import readiness_surface as readiness_surface_helpers

from tests.api.trading_api_support import (
    TradingApiTestCaseBase,
    TradingScheduler,
    datetime,
    patch,
    timezone,
)


class TestTradingApiHealthTimeoutFallback(TradingApiTestCaseBase):
    def test_health_timeout_core_readiness_falls_back_to_dependency_placeholders(
        self,
    ) -> None:
        scheduler = TradingScheduler()

        with patch(
            "app.api.readiness_helpers.readiness_surface._core_readiness_dependencies",
            side_effect=RuntimeError("core readiness unavailable"),
        ):
            dependencies, reasons = (
                readiness_surface_helpers._health_surface_timeout_core_dependencies(
                    scheduler=scheduler,
                    scheduler_ok=True,
                    include_database_contract=False,
                    reason_code="trading_health_evaluation_timeout",
                )
            )

        self.assertFalse(dependencies["postgres"]["ok"])
        self.assertIn("postgres_degraded", reasons)
        self.assertIn("clickhouse_degraded", reasons)

    def test_health_timeout_cached_payload_preserves_existing_live_gate(self) -> None:
        cache_key = "test-health-timeout-preserves-live-gate"
        checked_at = datetime.now(timezone.utc)
        live_submission_gate = {
            "allowed": True,
            "reason": "operational_submission_ready",
            "reason_codes": [],
            "blocked_reasons": [],
        }
        with health_cache_state.TRADING_HEALTH_SURFACE_EVALUATION_LOCK:
            health_cache_state.TRADING_HEALTH_SURFACE_PAYLOAD_CACHE[cache_key] = {
                "payload": {
                    "status": "ok",
                    "dependencies": {},
                    "live_submission_gate": live_submission_gate,
                },
                "status_code": 200,
                "checked_at": checked_at,
            }
        try:
            payload = readiness_surface_helpers.health_surface_timeout_fallback_payload(
                cache_key=cache_key,
                include_database_contract=False,
                reason_code="trading_health_evaluation_timeout",
                detail="trading health evaluation exceeded timeout",
            )
        finally:
            with health_cache_state.TRADING_HEALTH_SURFACE_EVALUATION_LOCK:
                health_cache_state.TRADING_HEALTH_SURFACE_PAYLOAD_CACHE.pop(
                    cache_key,
                    None,
                )

        self.assertEqual(payload["live_submission_gate"], live_submission_gate)
        self.assertEqual(payload["status"], "degraded")
        self.assertEqual(
            payload["dependencies"]["health_evaluation"]["reason_codes"],
            ["trading_health_evaluation_timeout"],
        )
