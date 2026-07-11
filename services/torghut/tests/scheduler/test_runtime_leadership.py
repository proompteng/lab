from __future__ import annotations

import asyncio
from dataclasses import replace
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import Mock, patch

from app.config import settings
from app.trading.scheduler.leadership import (
    SchedulerLeadershipError,
    SchedulerLeadershipStatus,
)
from app.trading.scheduler.runtime import TradingScheduler


class _FakeLeadership:
    def __init__(self, *, acquire_error: Exception | None = None) -> None:
        self.acquire_error = acquire_error
        self.status = SchedulerLeadershipStatus(required=True, lock_id=42)
        self.acquire_calls = 0
        self.check_calls = 0
        self.release_calls = 0
        self.check_result = True

    def acquire(self) -> None:
        self.acquire_calls += 1
        if self.acquire_error is not None:
            raise self.acquire_error
        self.status = replace(self.status, acquired=True, healthy=True)

    def check(self) -> bool:
        self.check_calls += 1
        if not self.check_result:
            self.status = replace(
                self.status,
                acquired=False,
                healthy=False,
                failure_reason="leadership_connection_lost:OperationalError",
            )
        return self.check_result

    def release(self) -> None:
        self.release_calls += 1
        self.status = replace(
            self.status,
            acquired=False,
            healthy=False,
            failure_reason="leadership_released",
        )


class TradingSchedulerLeadershipTests(IsolatedAsyncioTestCase):
    @staticmethod
    def _prepared_scheduler(leadership: _FakeLeadership) -> TradingScheduler:
        async def block_until_cancelled() -> None:
            await asyncio.Event().wait()

        scheduler = TradingScheduler(leadership=leadership)  # type: ignore[arg-type]
        scheduler._pipelines = [
            SimpleNamespace(
                account_label="paper",
                order_feed_ingestor=SimpleNamespace(close=Mock()),
            )
        ]
        scheduler._pipeline = scheduler._pipelines[0]
        scheduler._assert_trading_shorts_startup_policy = Mock()  # type: ignore[method-assign]
        scheduler._run_loop = block_until_cancelled  # type: ignore[method-assign]
        return scheduler

    async def test_start_acquires_and_stop_releases_writer_fence(self) -> None:
        leadership = _FakeLeadership()
        scheduler = self._prepared_scheduler(leadership)

        await scheduler.start()
        await scheduler.stop()

        self.assertEqual(leadership.acquire_calls, 1)
        self.assertEqual(leadership.release_calls, 1)
        self.assertFalse(scheduler.leadership_status.acquired)

    async def test_startup_failure_releases_fence_without_starting_loop(self) -> None:
        leadership = _FakeLeadership(
            acquire_error=SchedulerLeadershipError("leadership contended")
        )
        scheduler = self._prepared_scheduler(leadership)

        with self.assertRaisesRegex(SchedulerLeadershipError, "contended"):
            await scheduler.start()

        self.assertIsNone(scheduler._task)
        self.assertEqual(leadership.release_calls, 0)
        self.assertEqual(
            scheduler.state.last_error,
            "scheduler_startup_failed:SchedulerLeadershipError",
        )

    async def test_leadership_loss_cancels_loop_and_latches_emergency_stop(
        self,
    ) -> None:
        leadership = _FakeLeadership()
        leadership.check_result = False
        scheduler = self._prepared_scheduler(leadership)

        with patch.object(
            settings,
            "trading_scheduler_leadership_check_seconds",
            0.001,
        ):
            await scheduler.start()
            for _ in range(100):
                if scheduler.state.emergency_stop_active:
                    break
                await asyncio.sleep(0.001)
            await asyncio.sleep(0)

        self.assertTrue(scheduler.state.emergency_stop_active)
        self.assertEqual(
            scheduler.state.emergency_stop_reason,
            "scheduler_leadership_lost",
        )
        self.assertEqual(
            scheduler.state.last_error,
            "scheduler_leadership_lost:leadership_connection_lost:OperationalError",
        )
        self.assertTrue(scheduler._stop_event.is_set())
        self.assertTrue(scheduler._task is not None and scheduler._task.cancelled())

        await scheduler.stop()


__all__ = ["TradingSchedulerLeadershipTests"]
