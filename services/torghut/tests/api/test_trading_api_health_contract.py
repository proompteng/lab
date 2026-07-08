from __future__ import annotations

from tests.api.trading_api_support import (
    TradingApiTestCaseBase,
    datetime,
    patch,
    timezone,
)


class TestTradingApiHealthContract(TradingApiTestCaseBase):
    def test_readyz_does_not_evaluate_trading_health_proof_lane(self) -> None:
        with patch(
            "app.api.readiness_helpers.status_dependencies.build_profitability_proof_floor_payload"
        ) as proof_floor:
            response = self.client.get("/readyz")

        self.assertIn(response.status_code, {200, 503})
        payload = response.json()
        self.assertEqual(
            payload["readiness_surface"],
            "core_dependencies_and_live_submission_gate",
        )
        self.assertIn("live_submission_gate", payload["dependencies"])
        proof_floor.assert_not_called()

    def test_trading_health_runtime_degradation_strips_live_gate_authority(
        self,
    ) -> None:
        checked_at = datetime.now(timezone.utc)
        live_submission_gate = {
            "allowed": True,
            "reason": "ready",
            "blocked_reasons": [],
            "read_model_unavailable": False,
            "promotion_authority": True,
            "promotion_authority_ok": True,
            "final_authority_ok": True,
            "final_promotion_allowed": True,
            "final_promotion_authorized": True,
            "capital_stage": "live",
        }

        def _dependency_snapshot(
            *_args: object, **_kwargs: object
        ) -> tuple[
            dict[str, object],
            datetime,
            bool,
        ]:
            return (
                {
                    "postgres": {"ok": False, "detail": "down"},
                    "clickhouse": {"ok": True, "detail": "ok"},
                    "alpaca": {"ok": True, "detail": "ok"},
                    "tigerbeetle": {"ok": True, "detail": "ok"},
                },
                checked_at,
                False,
            )

        with (
            patch(
                "app.api.readiness_helpers.evaluate_trading_health_payload._readiness_dependency_snapshot",
                side_effect=_dependency_snapshot,
            ),
            patch(
                "app.api.readiness_helpers.status_dependencies.build_api_live_submission_gate_payload",
                return_value=live_submission_gate,
            ),
        ):
            response = self.client.get("/trading/health")

        self.assertEqual(response.status_code, 503)
        payload = response.json()
        self.assertEqual(payload["runtime"]["status"], "degraded")
        self.assertFalse(payload["runtime"]["ok"])
        self.assertFalse(payload["proof_lane"]["required_for_runtime_health"])
        gate = payload["live_submission_gate"]
        self.assertFalse(gate["allowed"])
        self.assertFalse(gate["promotion_authority"])
        self.assertFalse(gate["final_authority_ok"])
        self.assertFalse(gate["final_promotion_allowed"])
        self.assertTrue(gate["readiness_dependency_guard_active"])
