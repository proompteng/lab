from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI

from app import bootstrap, scheduler_main
from app.config import Settings, settings


class _FakeScheduler:
    def __init__(self) -> None:
        self.state = SimpleNamespace(
            running=False,
            last_run_at=None,
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
            process_settings.trading_scheduler_leadership_check_seconds, 5.0
        )

        with self.assertRaisesRegex(ValueError, "TORGHUT_PROCESS_ROLE"):
            Settings(_env_file=None, TORGHUT_PROCESS_ROLE="worker")
        with self.assertRaisesRegex(
            ValueError, "TRADING_SCHEDULER_LEADERSHIP_CHECK_SECONDS"
        ):
            Settings(
                _env_file=None,
                TRADING_SCHEDULER_LEADERSHIP_CHECK_SECONDS=0,
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
    def test_readiness_requires_running_error_free_completed_cycle(self) -> None:
        scheduler = _FakeScheduler()
        with patch.object(settings, "process_role", "scheduler"):
            self.assertFalse(
                scheduler_main.scheduler_readiness_payload(scheduler)["ok"]
            )

            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            ready = scheduler_main.scheduler_readiness_payload(scheduler)

        self.assertTrue(ready["ok"])
        self.assertEqual(ready["detail"], "ok")
        self.assertIn("last_run_at", ready)

    def test_readiness_fails_closed_when_latest_cycle_failed(self) -> None:
        scheduler = _FakeScheduler()
        scheduler.state.running = True
        scheduler.state.last_run_at = datetime.now(timezone.utc)
        scheduler.state.last_error = "broker unavailable"

        with patch.object(settings, "process_role", "scheduler"):
            payload = scheduler_main.scheduler_readiness_payload(scheduler)

        self.assertFalse(payload["ok"])
        self.assertEqual(payload["last_error"], "broker unavailable")


class SchedulerLivenessTests(TestCase):
    def test_liveness_requires_healthy_acquired_leadership(self) -> None:
        scheduler = _FakeScheduler()
        with patch.object(settings, "process_role", "scheduler"):
            payload = scheduler_main.scheduler_liveness_payload(scheduler)

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["detail"], "ok")

    def test_liveness_fails_closed_when_leadership_is_unavailable(self) -> None:
        scheduler = _FakeScheduler()
        scheduler.leadership_status.healthy = False

        with patch.object(settings, "process_role", "scheduler"):
            payload = scheduler_main.scheduler_liveness_payload(scheduler)

        self.assertFalse(payload["ok"])
        self.assertEqual(payload["detail"], "scheduler_leadership_unhealthy")
