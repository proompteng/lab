from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI

from app import bootstrap, scheduler_main
from app.config import Settings, settings
from app.trading.scheduler.leadership import SchedulerLeadershipError


class _FakeScheduler:
    def __init__(self) -> None:
        self.state = SimpleNamespace(
            running=False,
            last_run_at=None,
            last_reconcile_at=None,
            last_trading_error=None,
            last_reconcile_error=None,
            last_autonomy_error=None,
            last_evidence_error=None,
            last_error=None,
        )
        self.start = AsyncMock()
        self.stop = AsyncMock()
        self._leadership_status = SimpleNamespace(
            required=True,
            acquired=True,
            healthy=True,
            failure_reason=None,
        )

    @property
    def leadership_status(self) -> SimpleNamespace:
        return self._leadership_status


class _FakeWhitepaperWorker:
    def __init__(self, **_kwargs: object) -> None:
        self.start = AsyncMock()
        self.stop = AsyncMock()


class ProcessRoleSettingsTests(TestCase):
    def test_process_role_defaults_to_api_and_rejects_unknown_roles(self) -> None:
        process_settings = Settings(_env_file=None)
        self.assertEqual(process_settings.process_role, "api")
        self.assertFalse(process_settings.trading_scheduler_leadership_required)
        self.assertEqual(
            process_settings.trading_scheduler_leadership_lock_name,
            "torghut:trading-scheduler",
        )
        self.assertEqual(
            process_settings.trading_scheduler_leadership_check_seconds, 5.0
        )
        self.assertEqual(
            process_settings.trading_scheduler_shutdown_drain_seconds, 45.0
        )
        self.assertEqual(
            process_settings.trading_scheduler_success_max_age_seconds, 30.0
        )
        self.assertEqual(process_settings.trading_reconcile_ms, 15000)
        self.assertEqual(
            process_settings.trading_scheduler_runtime_base_url,
            "http://torghut-scheduler.torghut.svc.cluster.local:8183",
        )
        self.assertEqual(
            process_settings.trading_scheduler_runtime_timeout_seconds,
            2.0,
        )
        simulation_settings = Settings(
            _env_file=None,
            TORGHUT_PROCESS_ROLE="simulation",
            TRADING_MODE="paper",
        )
        self.assertEqual(simulation_settings.process_role, "simulation")

        with self.assertRaisesRegex(ValueError, "TORGHUT_PROCESS_ROLE"):
            Settings(_env_file=None, TORGHUT_PROCESS_ROLE="worker")
        with self.assertRaisesRegex(
            ValueError, "TRADING_SCHEDULER_LEADERSHIP_CHECK_SECONDS"
        ):
            Settings(
                _env_file=None,
                TRADING_SCHEDULER_LEADERSHIP_CHECK_SECONDS=0,
            )
        with self.assertRaisesRegex(
            ValueError, "TRADING_SCHEDULER_RUNTIME_TIMEOUT_SECONDS"
        ):
            Settings(
                _env_file=None,
                TRADING_SCHEDULER_RUNTIME_TIMEOUT_SECONDS=0,
            )
        with self.assertRaisesRegex(
            ValueError, "TRADING_SCHEDULER_SHUTDOWN_DRAIN_SECONDS"
        ):
            Settings(
                _env_file=None,
                TRADING_SCHEDULER_SHUTDOWN_DRAIN_SECONDS=0,
            )
        with self.assertRaisesRegex(
            ValueError, "TRADING_SCHEDULER_SUCCESS_MAX_AGE_SECONDS"
        ):
            Settings(
                _env_file=None,
                TRADING_SCHEDULER_SUCCESS_MAX_AGE_SECONDS=0,
            )

    def test_reconcile_interval_must_fit_inside_success_freshness_window(
        self,
    ) -> None:
        message = (
            "TRADING_RECONCILE_MS must be strictly less than "
            "TRADING_SCHEDULER_SUCCESS_MAX_AGE_SECONDS"
        )
        for reconcile_ms in (30000, 30001):
            with self.subTest(reconcile_ms=reconcile_ms):
                with self.assertRaisesRegex(ValueError, message):
                    Settings(
                        _env_file=None,
                        TRADING_RECONCILE_MS=reconcile_ms,
                        TRADING_SCHEDULER_SUCCESS_MAX_AGE_SECONDS=30,
                    )


class ApiProcessRoleTests(IsolatedAsyncioTestCase):
    async def test_api_lifespan_never_starts_trading_scheduler(self) -> None:
        scheduler = _FakeScheduler()
        app = FastAPI()
        with (
            patch.object(settings, "process_role", "api"),
            patch.object(settings, "trading_enabled", True),
            patch.object(bootstrap, "TradingScheduler", return_value=scheduler),
            patch.object(bootstrap, "ensure_schema"),
        ):
            async with bootstrap.lifespan(app):
                self.assertIs(app.state.trading_scheduler, scheduler)
                self.assertFalse(hasattr(app.state, "whitepaper_worker"))

        scheduler.start.assert_not_awaited()
        scheduler.stop.assert_awaited_once()

    async def test_api_lifespan_fails_closed_on_scheduler_role(self) -> None:
        with patch.object(settings, "process_role", "scheduler"):
            with self.assertRaisesRegex(RuntimeError, "expected=api"):
                async with bootstrap.lifespan(FastAPI()):
                    pass

    def test_api_scheduler_status_declares_external_owner(self) -> None:
        with patch.object(settings, "process_role", "api"):
            ok, payload = bootstrap.evaluate_scheduler_status(_FakeScheduler())

        self.assertTrue(ok)
        self.assertEqual(payload["detail"], "external_scheduler")
        self.assertEqual(payload["owner"], "torghut-scheduler")
        self.assertFalse(payload["running"])


class SimulationProcessRoleTests(IsolatedAsyncioTestCase):
    async def test_simulation_lifespan_starts_local_scheduler_and_worker(self) -> None:
        scheduler = _FakeScheduler()
        whitepaper_worker = _FakeWhitepaperWorker()
        app = FastAPI()
        with (
            patch.object(settings, "process_role", "simulation"),
            patch.object(settings, "trading_mode", "paper"),
            patch.object(settings, "trading_enabled", True),
            patch.object(settings, "trading_scheduler_leadership_required", True),
            patch.object(
                settings,
                "trading_scheduler_leadership_lock_name",
                "torghut:simulation-scheduler",
            ),
            patch.object(settings, "trading_autonomy_enabled", False),
            patch.object(bootstrap, "TradingScheduler", return_value=scheduler),
            patch.object(
                bootstrap,
                "WhitepaperKafkaWorker",
                return_value=whitepaper_worker,
            ),
            patch.object(bootstrap, "whitepaper_workflow_enabled", return_value=True),
            patch.object(bootstrap, "ensure_schema") as ensure_schema,
            patch.object(bootstrap, "_assert_dspy_cutover_migration_guard"),
        ):
            async with bootstrap.lifespan(app):
                self.assertIs(app.state.trading_scheduler, scheduler)
                self.assertIs(app.state.whitepaper_worker, whitepaper_worker)
                await app.state.trading_scheduler_supervisor

        ensure_schema.assert_called_once_with()
        scheduler.start.assert_awaited_once()
        scheduler.stop.assert_awaited_once()
        whitepaper_worker.start.assert_awaited_once()
        whitepaper_worker.stop.assert_awaited_once()

    async def test_simulation_lifespan_stands_by_then_acquires_leadership(
        self,
    ) -> None:
        scheduler = _FakeScheduler()
        first_attempt_failed = asyncio.Event()
        allow_acquisition = asyncio.Event()
        attempts = 0

        async def start_scheduler() -> None:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                scheduler.state.last_error = (
                    "scheduler_startup_failed:SchedulerLeadershipError"
                )
                first_attempt_failed.set()
                raise SchedulerLeadershipError("leadership contended")
            await allow_acquisition.wait()
            scheduler.state.last_error = None
            scheduler.state.running = True

        scheduler.start.side_effect = start_scheduler
        app = FastAPI()
        with (
            patch.object(settings, "process_role", "simulation"),
            patch.object(settings, "trading_mode", "paper"),
            patch.object(settings, "trading_enabled", True),
            patch.object(settings, "trading_scheduler_leadership_required", True),
            patch.object(
                settings,
                "trading_scheduler_leadership_lock_name",
                "torghut:simulation-scheduler",
            ),
            patch.object(settings, "trading_scheduler_leadership_check_seconds", 0.001),
            patch.object(settings, "trading_autonomy_enabled", False),
            patch.object(bootstrap, "TradingScheduler", return_value=scheduler),
            patch.object(bootstrap, "whitepaper_workflow_enabled", return_value=False),
            patch.object(bootstrap, "ensure_schema"),
            patch.object(bootstrap, "_assert_dspy_cutover_migration_guard"),
        ):
            async with bootstrap.lifespan(app):
                await asyncio.wait_for(first_attempt_failed.wait(), timeout=1)
                self.assertFalse(scheduler.state.running)
                self.assertFalse(
                    bootstrap.evaluate_scheduler_status(scheduler)[0],
                    "standby simulation must remain fail-closed",
                )
                allow_acquisition.set()
                await asyncio.wait_for(
                    app.state.trading_scheduler_supervisor,
                    timeout=1,
                )
                self.assertTrue(scheduler.state.running)

        self.assertEqual(attempts, 2)
        scheduler.stop.assert_awaited_once()

    async def test_simulation_supervisor_latches_non_retryable_startup_failure(
        self,
    ) -> None:
        scheduler = _FakeScheduler()
        scheduler.start.side_effect = ValueError("invalid scheduler configuration")
        app = FastAPI()
        with (
            patch.object(settings, "process_role", "simulation"),
            patch.object(settings, "trading_mode", "paper"),
            patch.object(settings, "trading_enabled", True),
            patch.object(settings, "trading_scheduler_leadership_required", True),
            patch.object(
                settings,
                "trading_scheduler_leadership_lock_name",
                "torghut:simulation-scheduler",
            ),
            patch.object(settings, "trading_autonomy_enabled", False),
            patch.object(bootstrap, "TradingScheduler", return_value=scheduler),
            patch.object(bootstrap, "whitepaper_workflow_enabled", return_value=False),
            patch.object(bootstrap, "ensure_schema"),
            patch.object(bootstrap, "_assert_dspy_cutover_migration_guard"),
        ):
            async with bootstrap.lifespan(app):
                with self.assertRaisesRegex(
                    ValueError,
                    "invalid scheduler configuration",
                ):
                    await app.state.trading_scheduler_supervisor
                await asyncio.sleep(0)
                self.assertEqual(
                    scheduler.state.last_error,
                    "scheduler_startup_supervisor_failed:ValueError",
                )

        scheduler.start.assert_awaited_once()
        scheduler.stop.assert_awaited_once()

    async def test_disabled_simulation_serves_without_starting_scheduler(self) -> None:
        scheduler = _FakeScheduler()
        app = FastAPI()
        with (
            patch.object(settings, "process_role", "simulation"),
            patch.object(settings, "trading_mode", "paper"),
            patch.object(settings, "trading_enabled", False),
            patch.object(bootstrap, "TradingScheduler", return_value=scheduler),
            patch.object(bootstrap, "whitepaper_workflow_enabled", return_value=False),
            patch.object(bootstrap, "ensure_schema"),
        ):
            async with bootstrap.lifespan(app):
                self.assertIs(app.state.trading_scheduler, scheduler)
                self.assertFalse(hasattr(app.state, "trading_scheduler_supervisor"))

        scheduler.start.assert_not_awaited()
        scheduler.stop.assert_awaited_once()

    async def test_simulation_lifespan_rejects_live_mode(self) -> None:
        with (
            patch.object(settings, "process_role", "simulation"),
            patch.object(settings, "trading_mode", "live"),
            patch.object(settings, "trading_scheduler_leadership_required", True),
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "torghut_simulation_process_mode_mismatch",
            ):
                async with bootstrap.lifespan(FastAPI()):
                    pass

    async def test_simulation_lifespan_requires_single_writer_leadership(self) -> None:
        with (
            patch.object(settings, "process_role", "simulation"),
            patch.object(settings, "trading_mode", "paper"),
            patch.object(settings, "trading_enabled", True),
            patch.object(settings, "trading_scheduler_leadership_required", False),
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "torghut_simulation_scheduler_leadership_required",
            ):
                async with bootstrap.lifespan(FastAPI()):
                    pass

    async def test_simulation_lifespan_requires_isolated_leadership_lock(self) -> None:
        with (
            patch.object(settings, "process_role", "simulation"),
            patch.object(settings, "trading_mode", "paper"),
            patch.object(settings, "trading_enabled", True),
            patch.object(settings, "trading_scheduler_leadership_required", True),
            patch.object(
                settings,
                "trading_scheduler_leadership_lock_name",
                "torghut:trading-scheduler",
            ),
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "torghut_simulation_scheduler_lock_must_be_isolated",
            ):
                async with bootstrap.lifespan(FastAPI()):
                    pass

    def test_simulation_scheduler_status_is_process_local(self) -> None:
        scheduler = _FakeScheduler()
        scheduler.state.running = True
        with patch.object(settings, "process_role", "simulation"):
            ok, payload = bootstrap.evaluate_scheduler_status(scheduler)

        self.assertTrue(ok)
        self.assertEqual(payload["detail"], "ok")
        self.assertTrue(payload["running"])
        self.assertNotIn("owner", payload)


class SchedulerProcessRoleTests(IsolatedAsyncioTestCase):
    async def test_scheduler_lifespan_is_the_only_role_that_starts_loop(self) -> None:
        scheduler = _FakeScheduler()
        whitepaper_worker = _FakeWhitepaperWorker()
        app = FastAPI()
        with (
            patch.object(settings, "process_role", "scheduler"),
            patch.object(settings, "trading_enabled", True),
            patch.object(settings, "trading_autonomy_enabled", False),
            patch.object(
                scheduler_main,
                "TradingScheduler",
                return_value=scheduler,
            ),
            patch.object(
                scheduler_main,
                "WhitepaperKafkaWorker",
                return_value=whitepaper_worker,
            ),
            patch.object(
                scheduler_main, "whitepaper_workflow_enabled", return_value=True
            ),
            patch.object(scheduler_main, "ensure_schema") as ensure_schema,
            patch.object(scheduler_main, "assert_dspy_cutover_migration_guard"),
        ):
            async with scheduler_main.scheduler_lifespan(app):
                self.assertIs(app.state.trading_scheduler, scheduler)

        ensure_schema.assert_called_once_with()
        scheduler.start.assert_awaited_once()
        scheduler.stop.assert_awaited_once()
        whitepaper_worker.start.assert_awaited_once()
        whitepaper_worker.stop.assert_awaited_once()

    async def test_scheduler_lifespan_fails_closed_on_api_role(self) -> None:
        with patch.object(settings, "process_role", "api"):
            with self.assertRaisesRegex(RuntimeError, "expected=scheduler"):
                async with scheduler_main.scheduler_lifespan(FastAPI()):
                    pass


class SchedulerReadinessTests(TestCase):
    def setUp(self) -> None:
        trading_enabled = patch.object(settings, "trading_enabled", True)
        trading_enabled.start()
        self.addCleanup(trading_enabled.stop)

    def test_readiness_requires_running_error_free_completed_cycles(self) -> None:
        scheduler = _FakeScheduler()
        with patch.object(settings, "process_role", "scheduler"):
            self.assertFalse(
                scheduler_main.scheduler_readiness_payload(scheduler)["ok"]
            )

            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            scheduler.state.last_reconcile_at = datetime.now(timezone.utc)
            ready = scheduler_main.scheduler_readiness_payload(scheduler)

        self.assertTrue(ready["ok"])
        self.assertEqual(ready["detail"], "ok")
        self.assertIn("last_run_at", ready)
        self.assertIn("last_reconcile_at", ready)

    def test_readiness_fails_closed_when_latest_cycle_failed(self) -> None:
        scheduler = _FakeScheduler()
        scheduler.state.running = True
        scheduler.state.last_run_at = datetime.now(timezone.utc)
        scheduler.state.last_reconcile_at = datetime.now(timezone.utc)
        scheduler.state.last_error = "broker unavailable"

        with patch.object(settings, "process_role", "scheduler"):
            payload = scheduler_main.scheduler_readiness_payload(scheduler)

        self.assertFalse(payload["ok"])
        self.assertEqual(payload["last_error"], "broker unavailable")
        self.assertEqual(payload["detail"], "scheduler_cycle_failed")

    def test_readiness_fails_closed_when_last_success_is_stale(self) -> None:
        scheduler = _FakeScheduler()
        scheduler.state.running = True
        scheduler.state.last_run_at = datetime.now(timezone.utc) - timedelta(seconds=31)
        scheduler.state.last_reconcile_at = datetime.now(timezone.utc)

        with (
            patch.object(settings, "process_role", "scheduler"),
            patch.object(settings, "trading_scheduler_success_max_age_seconds", 30.0),
        ):
            payload = scheduler_main.scheduler_readiness_payload(scheduler)

        self.assertFalse(payload["ok"])
        self.assertEqual(payload["detail"], "scheduler_success_stale")
        self.assertGreater(payload["success_age_seconds"], 30.0)

    def test_readiness_requires_healthy_writer_leadership(self) -> None:
        scheduler = _FakeScheduler()
        scheduler.state.running = True
        scheduler.state.last_run_at = datetime.now(timezone.utc)
        scheduler.state.last_reconcile_at = datetime.now(timezone.utc)
        scheduler.leadership_status.healthy = False

        with patch.object(settings, "process_role", "scheduler"):
            payload = scheduler_main.scheduler_readiness_payload(scheduler)

        self.assertFalse(payload["ok"])
        self.assertEqual(payload["detail"], "scheduler_leadership_unhealthy")

    def test_readiness_cannot_mask_latest_trading_failure_with_shared_error_clear(
        self,
    ) -> None:
        scheduler = _FakeScheduler()
        scheduler.state.running = True
        scheduler.state.last_run_at = datetime.now(timezone.utc)
        scheduler.state.last_reconcile_at = datetime.now(timezone.utc)
        scheduler.state.last_error = None
        scheduler.state.last_trading_error = "trading_lane_failures:paper-a"

        with patch.object(settings, "process_role", "scheduler"):
            payload = scheduler_main.scheduler_readiness_payload(scheduler)

        self.assertFalse(payload["ok"])
        self.assertEqual(payload["detail"], "scheduler_cycle_failed")
        self.assertEqual(
            payload["last_trading_error"],
            "trading_lane_failures:paper-a",
        )

    def test_readiness_exposes_autonomy_error_when_shared_error_is_clear(self) -> None:
        scheduler = _FakeScheduler()
        scheduler.state.running = True
        scheduler.state.last_run_at = datetime.now(timezone.utc)
        scheduler.state.last_reconcile_at = datetime.now(timezone.utc)
        scheduler.state.last_autonomy_error = "autonomy unavailable"

        with patch.object(settings, "process_role", "scheduler"):
            payload = scheduler_main.scheduler_readiness_payload(scheduler)

        self.assertFalse(payload["ok"])
        self.assertEqual(payload["detail"], "scheduler_cycle_failed")
        self.assertEqual(payload["last_autonomy_error"], "autonomy unavailable")

    def test_readiness_requires_completed_reconcile_cycle(self) -> None:
        scheduler = _FakeScheduler()
        scheduler.state.running = True
        scheduler.state.last_run_at = datetime.now(timezone.utc)

        with patch.object(settings, "process_role", "scheduler"):
            payload = scheduler_main.scheduler_readiness_payload(scheduler)

        self.assertFalse(payload["ok"])
        self.assertEqual(payload["detail"], "scheduler_reconcile_success_missing")
        self.assertTrue(payload["trading_success_is_fresh"])
        self.assertFalse(payload["reconcile_success_is_fresh"])
        self.assertNotIn("last_reconcile_at", payload)

    def test_readiness_fails_closed_when_reconcile_success_is_stale(self) -> None:
        scheduler = _FakeScheduler()
        scheduler.state.running = True
        scheduler.state.last_run_at = datetime.now(timezone.utc)
        scheduler.state.last_reconcile_at = datetime.now(timezone.utc) - timedelta(
            seconds=31
        )

        with (
            patch.object(settings, "process_role", "scheduler"),
            patch.object(settings, "trading_scheduler_success_max_age_seconds", 30.0),
        ):
            payload = scheduler_main.scheduler_readiness_payload(scheduler)

        self.assertFalse(payload["ok"])
        self.assertEqual(payload["detail"], "scheduler_reconcile_success_stale")
        self.assertTrue(payload["trading_success_is_fresh"])
        self.assertFalse(payload["reconcile_success_is_fresh"])
        self.assertIn("last_reconcile_at", payload)
        self.assertGreater(payload["reconcile_success_age_seconds"], 30.0)


class SchedulerLivenessTests(TestCase):
    def test_liveness_requires_healthy_acquired_leadership(self) -> None:
        scheduler = _FakeScheduler()
        scheduler.state.running = True
        with (
            patch.object(settings, "process_role", "scheduler"),
            patch.object(settings, "trading_enabled", True),
        ):
            payload = scheduler_main.scheduler_liveness_payload(scheduler)

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["detail"], "ok")
        self.assertEqual(
            payload["trading"],
            {"enabled": True, "loop_required": True, "running": True},
        )

    def test_liveness_fails_closed_when_leadership_is_unavailable(self) -> None:
        scheduler = _FakeScheduler()
        scheduler.state.running = True
        scheduler.leadership_status.healthy = False

        with (
            patch.object(settings, "process_role", "scheduler"),
            patch.object(settings, "trading_enabled", True),
        ):
            payload = scheduler_main.scheduler_liveness_payload(scheduler)

        self.assertFalse(payload["ok"])
        self.assertEqual(payload["detail"], "scheduler_leadership_unhealthy")

    def test_liveness_fails_closed_when_required_trading_loop_is_not_running(
        self,
    ) -> None:
        scheduler = _FakeScheduler()

        with (
            patch.object(settings, "process_role", "scheduler"),
            patch.object(settings, "trading_enabled", True),
        ):
            payload = scheduler_main.scheduler_liveness_payload(scheduler)

        self.assertFalse(payload["ok"])
        self.assertEqual(payload["detail"], "scheduler_loop_not_running")
        self.assertEqual(
            payload["trading"],
            {"enabled": True, "loop_required": True, "running": False},
        )

    def test_liveness_permits_stopped_loop_when_trading_is_disabled(self) -> None:
        scheduler = _FakeScheduler()
        scheduler.leadership_status.healthy = False
        scheduler.leadership_status.acquired = False

        with (
            patch.object(settings, "process_role", "scheduler"),
            patch.object(settings, "trading_enabled", False),
        ):
            payload = scheduler_main.scheduler_liveness_payload(scheduler)

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["detail"], "trading_disabled")
        self.assertEqual(
            payload["trading"],
            {"enabled": False, "loop_required": False, "running": False},
        )
