from __future__ import annotations

from urllib.error import URLError

from fastapi.responses import JSONResponse

from app.api.trading_status import configured_broker_environment
from app.config import settings
from tests.api.trading_api_support import (
    TradingApiTestCaseBase,
    TradingScheduler,
    patch,
)


class TestTradingApiStatusContract(TradingApiTestCaseBase):
    def test_broker_environment_comes_from_endpoint_not_execution_mode(self) -> None:
        with (
            patch.object(settings, "trading_mode", "live"),
            patch.object(
                settings,
                "apca_api_base_url",
                "https://paper-api.alpaca.markets/v2",
            ),
        ):
            self.assertEqual(configured_broker_environment(), "paper")

    def test_simulation_status_uses_process_local_scheduler_state(self) -> None:
        scheduler = TradingScheduler()
        scheduler.state.last_error = "scheduler_startup_failed:SchedulerLeadershipError"
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
            patch.object(settings, "process_role", "simulation"),
            patch(
                "app.api.trading_status.get_trading_scheduler",
                return_value=scheduler,
            ),
            patch(
                "app.api.trading_status.load_clickhouse_ta_status",
                return_value=freshness,
            ),
            patch(
                "app.api.trading_status.build_live_submission_gate_payload",
                return_value=gate,
            ),
            patch(
                "app.api.trading_status.scheduler_readiness_payload",
                return_value={"ok": True, "detail": "ok"},
            ),
            patch(
                "app.api.trading_status._read_with_session",
                side_effect=(
                    {
                        "schema_version": "torghut.broker-mutation-runtime-status.v1",
                        "runtime_wired": True,
                        "entry_fencing_proven": True,
                        "reduction_fencing_proven": False,
                        "recovery_worker_wired": False,
                        "recovery_degraded": True,
                        "database_status": "current",
                        "unresolved_receipt_count": 0,
                        "reason_codes": [
                            "broker_mutation_reduction_fencing_unproven",
                            "broker_mutation_recovery_unproven",
                        ],
                    },
                    {"ok": True},
                    {"status": "current"},
                    {
                        "schema_version": "torghut.strategy-capital-authority-status.v1",
                        "stage_counts": {
                            "shadow_allowed": 1,
                            "research_only": 1,
                        },
                        "strategies": [],
                    },
                    {
                        "schema_version": "torghut.broker-account-activity-status.v1",
                        "state": "current",
                        "current": True,
                        "reason_codes": [],
                    },
                    {
                        "schema_version": "torghut.broker-economic-ledger-status.v1",
                        "state": "residual",
                        "current": True,
                        "reconciled": False,
                        "diagnostic_only": True,
                        "capital_authority": False,
                        "reason_codes": ["ledger_position_missing_from_broker"],
                    },
                    {
                        "schema_version": "torghut.order-lineage-repair-status.v1",
                        "state": "closed",
                        "closed_census": True,
                        "current_version": True,
                        "receipt_count": 2,
                        "promotion_authority_eligible": False,
                        "reason_codes": ["order_lineage_incomplete_or_unproved"],
                    },
                    {"status": "current"},
                    None,
                ),
            ),
            patch(
                "app.api.trading_status.proxy_scheduler_response",
                side_effect=AssertionError(
                    "simulation status must not proxy to the live scheduler"
                ),
            ) as status_proxy,
        ):
            response = self.client.get("/trading/status")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(
            set(payload),
            {
                "service",
                "process_role",
                "runtime_owner",
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
                "action_authority",
                "broker_mutation_safety",
                "broker_economic_activities",
                "broker_economic_ledger",
                "order_lineage",
                "capital_controls",
                "economic_policy",
                "execution",
                "signal_continuity",
                "market_context",
                "shorting_metadata",
                "tigerbeetle_ledger",
                "runtime_ledger",
                "strategy_capital_authorities",
                "tca",
                "metrics",
                "llm",
            },
        )
        self.assertEqual(payload["accepted_source_freshness"], freshness)
        self.assertEqual(payload["process_role"], "simulation")
        self.assertEqual(payload["runtime_owner"], "torghut-sim")
        self.assertFalse(payload["running"])
        self.assertEqual(
            payload["last_error"],
            "scheduler_startup_failed:SchedulerLeadershipError",
        )
        self.assertEqual(payload["live_submission_gate"], gate)
        self.assertEqual(
            payload["strategy_capital_authorities"]["stage_counts"],
            {"shadow_allowed": 1, "research_only": 1},
        )
        self.assertFalse(payload["action_authority"]["entry_allowed"])
        self.assertFalse(payload["action_authority"]["reduce_only_allowed"])
        self.assertTrue(payload["broker_mutation_safety"]["runtime_wired"])
        self.assertTrue(payload["broker_mutation_safety"]["entry_fencing_proven"])
        self.assertTrue(payload["broker_economic_activities"]["current"])
        self.assertTrue(payload["broker_economic_ledger"]["diagnostic_only"])
        self.assertFalse(payload["broker_economic_ledger"]["capital_authority"])
        self.assertFalse(payload["broker_economic_ledger"]["reconciled"])
        self.assertTrue(payload["order_lineage"]["closed_census"])
        self.assertFalse(payload["order_lineage"]["promotion_authority_eligible"])
        self.assertFalse(payload["broker_mutation_safety"]["reduction_fencing_proven"])
        self.assertFalse(payload["broker_mutation_safety"]["recovery_worker_wired"])
        self.assertEqual(
            payload["broker_mutation_safety"]["database_status"], "current"
        )
        self.assertEqual(payload["capital_controls"]["gross_limit"], 1.0)
        self.assertEqual(payload["capital_controls"]["net_limit"], 0.5)
        self.assertEqual(payload["capital_controls"]["symbol_limit"], 0.5)
        status_proxy.assert_not_called()
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
        scheduler = TradingScheduler()
        with (
            patch.object(settings, "process_role", "scheduler"),
            patch(
                "app.api.metrics.get_trading_scheduler",
                return_value=scheduler,
            ),
        ):
            response = self.client.get("/metrics")

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers["content-type"].startswith("text/plain"))
        self.assertIn("torghut_trading_capital_new_exposure_allowed", response.text)
        self.assertIn('torghut_process_role_info{role="scheduler"} 1', response.text)
        self.assertIn(
            'torghut_trading_runtime_owner_info{owner="torghut-scheduler"} 1',
            response.text,
        )

    def test_simulation_metrics_report_local_role_and_owner(self) -> None:
        scheduler = TradingScheduler()
        with (
            patch.object(settings, "process_role", "simulation"),
            patch(
                "app.api.metrics.get_trading_scheduler",
                return_value=scheduler,
            ),
        ):
            response = self.client.get("/metrics")

        self.assertEqual(response.status_code, 200)
        self.assertIn(
            'torghut_process_role_info{role="simulation"} 1',
            response.text,
        )
        self.assertIn(
            'torghut_trading_runtime_owner_info{owner="torghut-sim"} 1',
            response.text,
        )
        self.assertNotIn("torghut_api_process_ready", response.text)

    def test_stateless_api_proxies_scheduler_status_but_keeps_local_metrics(
        self,
    ) -> None:
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
                "app.api.scheduler_proxy.urlopen",
                side_effect=URLError("scheduler has zero replicas"),
            ) as scheduler_open,
        ):
            status_response = self.client.get("/trading/status")
            metrics_response = self.client.get("/metrics")

        self.assertEqual(status_response.status_code, 200)
        self.assertTrue(status_response.json()["running"])
        self.assertEqual(metrics_response.status_code, 200)
        self.assertIn("torghut_api_process_ready 1", metrics_response.text)
        self.assertIn('torghut_process_role_info{role="api"} 1', metrics_response.text)
        self.assertIn(
            'torghut_trading_runtime_owner_info{owner="torghut-scheduler"} 1',
            metrics_response.text,
        )
        self.assertNotIn("torghut_scheduler_leadership_acquired", metrics_response.text)
        status_proxy.assert_called_once_with(
            path="/trading/status",
            accept="application/json",
        )
        scheduler_open.assert_not_called()

    def test_stateless_api_readyz_is_local_when_scheduler_is_unavailable(self) -> None:
        with (
            patch.object(settings, "process_role", "api"),
            patch(
                "app.api.readiness.readiness_helpers.evaluate_core_readiness_payload",
                side_effect=AssertionError(
                    "API readiness must not read scheduler state"
                ),
            ),
            patch(
                "app.api.scheduler_proxy.urlopen",
                side_effect=URLError("scheduler has zero replicas"),
            ) as scheduler_open,
        ):
            response = self.client.get("/readyz")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "status": "ok",
                "reason_codes": [],
                "process_role": "api",
                "runtime_owner": "torghut-scheduler",
                "scheduler": {
                    "ownership": "external",
                    "owner": "torghut-scheduler",
                    "availability": "not_evaluated",
                },
            },
        )
        scheduler_open.assert_not_called()

    def test_simulation_readyz_uses_fail_closed_local_readiness(self) -> None:
        local_payload = {
            "status": "not_ready",
            "reason_codes": ["trading loop not started"],
        }
        with (
            patch.object(settings, "process_role", "simulation"),
            patch(
                "app.api.readiness.readiness_helpers.evaluate_core_readiness_payload",
                return_value=(local_payload, 503),
            ) as evaluate_readiness,
        ):
            response = self.client.get("/readyz")

        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            response.json(),
            {
                **local_payload,
                "process_role": "simulation",
                "runtime_owner": "torghut-sim",
            },
        )
        evaluate_readiness.assert_called_once_with(
            include_database_contract=True,
            allow_stale_dependency_cache=True,
        )
