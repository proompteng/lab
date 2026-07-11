from __future__ import annotations

from fastapi.responses import JSONResponse, Response

from app.config import settings
from tests.api.trading_api_support import TradingApiTestCaseBase, patch


class TestTradingApiStatusContract(TradingApiTestCaseBase):
    def test_trading_status_exposes_only_operational_runtime_state(self) -> None:
        freshness = {
            "state": "current",
            "accepted_sources": ["ta"],
            "accepted_source_state": "current",
            "accepted_lag_seconds": 2,
            "blocking_reason": None,
        }
        gate = {
            "schema_version": "torghut.operational-submission-gate.v2",
            "allowed": True,
            "reason": "operational_submission_ready",
            "blocked_reasons": [],
            "reason_codes": ["operational_submission_ready"],
            "execution_route": {"route": "alpaca"},
        }
        with (
            patch.object(settings, "process_role", "scheduler"),
            patch(
                "app.api.trading_status.load_clickhouse_ta_status",
                return_value=freshness,
            ),
            patch(
                "app.api.trading_status.build_api_live_submission_gate_payload",
                return_value=gate,
            ),
            patch(
                "app.api.trading_status._read_with_session",
                side_effect=(
                    {"ok": True},
                    {"status": "current"},
                    {"status": "current"},
                    None,
                ),
            ),
        ):
            response = self.client.get("/trading/status")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(
            set(payload),
            {
                "service",
                "build",
                "mode",
                "pipeline_mode",
                "enabled",
                "running",
                "last_run_at",
                "last_reconcile_at",
                "last_decision_at",
                "last_error",
                "accepted_source_freshness",
                "live_submission_gate",
                "capital_controls",
                "execution",
                "signal_continuity",
                "market_context",
                "shorting_metadata",
                "tigerbeetle_ledger",
                "runtime_ledger",
                "tca",
                "metrics",
                "llm",
            },
        )
        self.assertEqual(payload["accepted_source_freshness"], freshness)
        self.assertEqual(payload["live_submission_gate"], gate)
        self.assertEqual(payload["capital_controls"]["gross_limit"], 4.0)
        self.assertEqual(payload["capital_controls"]["net_limit"], 0.5)
        self.assertEqual(payload["capital_controls"]["symbol_limit"], 0.5)
        for retired_key in (
            "autonomy",
            "control_plane_contract",
            "empirical_jobs",
            "hypotheses",
            "profit_lease_projection",
            "proof_floor",
            "quant_evidence",
            "shadow_first",
            "submission_authority",
        ):
            self.assertNotIn(retired_key, payload)

    def test_metrics_endpoint_is_prometheus_text(self) -> None:
        with patch.object(settings, "process_role", "scheduler"):
            response = self.client.get("/metrics")

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers["content-type"].startswith("text/plain"))
        self.assertIn("torghut_trading_capital_new_exposure_allowed", response.text)

    def test_stateless_api_proxies_scheduler_runtime_surfaces(self) -> None:
        with (
            patch.object(settings, "process_role", "api"),
            patch(
                "app.api.trading_status.proxy_scheduler_response",
                return_value=JSONResponse(
                    status_code=200,
                    content={"service": "torghut", "running": True},
                ),
            ) as status_proxy,
            patch(
                "app.api.metrics.proxy_scheduler_response",
                return_value=Response(
                    content="torghut_scheduler_leadership_acquired 1\n",
                    media_type="text/plain",
                ),
            ) as metrics_proxy,
        ):
            status_response = self.client.get("/trading/status")
            metrics_response = self.client.get("/metrics")

        self.assertEqual(status_response.status_code, 200)
        self.assertTrue(status_response.json()["running"])
        self.assertIn(
            "torghut_scheduler_leadership_acquired 1",
            metrics_response.text,
        )
        status_proxy.assert_called_once_with(
            path="/trading/status",
            accept="application/json",
        )
        metrics_proxy.assert_called_once_with(
            path="/metrics",
            accept="text/plain; version=0.0.4",
        )
