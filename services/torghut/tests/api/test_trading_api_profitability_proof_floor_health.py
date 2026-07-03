from __future__ import annotations

from tests.api.trading_api_support import (
    TradingApiTestCaseBase,
    TradingScheduler,
    app,
    datetime,
    patch,
    settings,
    timezone,
)


class TestTradingApiProfitabilityProofFloorHealth(TradingApiTestCaseBase):
    def test_trading_health_requires_profitability_proof_floor_in_live(self) -> None:
        original_enabled = settings.trading_enabled
        original_mode = settings.trading_mode
        original_source = settings.trading_universe_source
        original_empirical_required = settings.trading_empirical_jobs_health_required
        settings.trading_enabled = True
        settings.trading_mode = "live"
        settings.trading_universe_source = "static"
        settings.trading_empirical_jobs_health_required = False
        try:
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            app.state.trading_scheduler = scheduler

            with (
                patch(
                    "app.api.health_checks.check_alpaca_dependency",
                    return_value={"ok": True},
                ),
                patch(
                    "app.api.health_checks.check_clickhouse_dependency",
                    return_value={"ok": True},
                ),
                patch(
                    "app.api.health_checks.check_postgres_dependency",
                    return_value={"ok": True},
                ),
                patch(
                    "app.api.readiness_helpers.refresh_universe_state_for_readiness.check_account_scope_invariants_bounded",
                    return_value={
                        "account_scope_ready": True,
                        "account_scope_errors": [],
                    },
                ),
                patch(
                    "app.api.readiness_helpers.refresh_universe_state_for_readiness.check_schema_current",
                    return_value={
                        "schema_current": True,
                        "current_heads": ["0011_execution_tca_simulator_divergence"],
                        "expected_heads": ["0011_execution_tca_simulator_divergence"],
                        "schema_head_signature": "7f8e4d0",
                    },
                ),
                patch(
                    "app.api.trading_status._build_live_submission_gate_payload",
                    return_value={
                        "allowed": True,
                        "reason": "ready",
                        "blocked_reasons": [],
                        "capital_stage": "live",
                    },
                ),
                patch(
                    "app.api.trading_status._empirical_jobs_status",
                    return_value={"ready": False, "status": "degraded"},
                ),
                patch(
                    "app.api.trading_status.load_quant_evidence_status",
                    return_value={
                        "required": False,
                        "ok": True,
                        "status": "not_required",
                        "reason": "quant_health_not_configured",
                    },
                ),
                patch(
                    "app.api.trading_status._build_profitability_proof_floor_payload",
                    return_value={
                        "route_state": "repair_only",
                        "capital_state": "zero_notional",
                    },
                ),
            ):
                response = self.client.get("/trading/health")

            self.assertEqual(response.status_code, 503)
            dependency = response.json()["dependencies"]["profitability_proof_floor"]
            self.assertFalse(dependency["ok"])
            self.assertEqual(dependency["detail"], "repair_only")
            self.assertTrue(dependency["required"])
        finally:
            settings.trading_enabled = original_enabled
            settings.trading_mode = original_mode
            settings.trading_universe_source = original_source
            settings.trading_empirical_jobs_health_required = (
                original_empirical_required
            )
