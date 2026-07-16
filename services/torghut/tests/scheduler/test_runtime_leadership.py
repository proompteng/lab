from __future__ import annotations

import asyncio
import threading
from dataclasses import replace
from types import SimpleNamespace
from typing import cast
from unittest import IsolatedAsyncioTestCase
from unittest.mock import Mock, patch

from app.config import settings
from app.trading.scheduler.leadership import (
    SchedulerLeadershipError,
    SchedulerLeadershipStatus,
)
from app.trading.scheduler.runtime import TradingScheduler
from app.trading.broker_mutation_recovery_worker import (
    BrokerMutationRecoveryRunResult,
    BrokerMutationRecoveryWorker,
)


class _NoopRecoveryWorker:
    def run_once(self) -> BrokerMutationRecoveryRunResult:
        return BrokerMutationRecoveryRunResult(
            enabled=False,
            scanned=0,
            outcomes={"disabled": 1},
        )


class _FakeLeadership:
    def __init__(self, *, acquire_error: Exception | None = None) -> None:
        self.acquire_error = acquire_error
        self.status = SchedulerLeadershipStatus(required=True, lock_id=42)
        self.acquire_calls = 0
        self.check_calls = 0
        self.release_calls = 0
        self.check_result = True
        self.check_error: Exception | None = None

    def acquire(self) -> None:
        self.acquire_calls += 1
        if self.acquire_error is not None:
            raise self.acquire_error
        self.status = replace(self.status, acquired=True, healthy=True)

    def check(self) -> bool:
        self.check_calls += 1
        if self.check_error is not None:
            raise self.check_error
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


class _StoppedLoopScheduler(TradingScheduler):
    async def _run_loop(self) -> None:
        await self._stop_event.wait()

    def _assert_trading_shorts_startup_policy(self) -> None:
        return


class _BlockingBrokerScheduler(TradingScheduler):
    def _assert_trading_shorts_startup_policy(self) -> None:
        return

    def _evaluate_safety_controls(self) -> None:
        return


class _ReturningLoopScheduler(_StoppedLoopScheduler):
    async def _run_loop(self) -> None:
        return


class _FailingLoopScheduler(_StoppedLoopScheduler):
    async def _run_loop(self) -> None:
        raise RuntimeError("scheduler loop exploded")


class TradingSchedulerLeadershipTests(IsolatedAsyncioTestCase):
    @staticmethod
    def _prepared_scheduler(
        leadership: _FakeLeadership,
        *,
        fatal_exit: Mock | None = None,
    ) -> TradingScheduler:
        scheduler = _StoppedLoopScheduler(
            leadership=leadership,
            fatal_exit=fatal_exit or Mock(),
        )
        scheduler._pipelines = [
            SimpleNamespace(
                account_label="paper",
                order_feed_ingestor=SimpleNamespace(close=Mock()),
            )
        ]
        scheduler._pipeline = scheduler._pipelines[0]
        scheduler._broker_mutation_recovery_worker = cast(
            BrokerMutationRecoveryWorker,
            _NoopRecoveryWorker(),
        )
        return scheduler

    async def test_start_acquires_and_stop_releases_writer_fence(self) -> None:
        leadership = _FakeLeadership()
        fatal_exit = Mock()
        scheduler = self._prepared_scheduler(leadership, fatal_exit=fatal_exit)

        await scheduler.start()
        await scheduler.stop()

        self.assertEqual(leadership.acquire_calls, 1)
        self.assertEqual(leadership.release_calls, 1)
        self.assertFalse(scheduler.leadership_status.acquired)
        fatal_exit.assert_not_called()

    async def test_unexpected_loop_return_is_process_fatal(self) -> None:
        leadership = _FakeLeadership()
        fatal_called = asyncio.Event()
        fatal_exit = Mock(side_effect=lambda _code: fatal_called.set())
        scheduler = _ReturningLoopScheduler(
            leadership=leadership,
            fatal_exit=fatal_exit,
        )
        scheduler._pipelines = self._prepared_scheduler(leadership)._pipelines
        scheduler._pipeline = scheduler._pipelines[0]
        scheduler._broker_mutation_recovery_worker = cast(
            BrokerMutationRecoveryWorker,
            _NoopRecoveryWorker(),
        )

        await scheduler.start()
        await asyncio.wait_for(fatal_called.wait(), timeout=1.0)

        self.assertEqual(
            scheduler.state.last_error,
            "scheduler_loop_exited_unexpectedly:task_returned",
        )
        self.assertEqual(
            scheduler.state.emergency_stop_reason,
            "scheduler_loop_exited_unexpectedly",
        )
        fatal_exit.assert_called_once_with(70)
        await scheduler.stop()

    async def test_unexpected_loop_exception_is_process_fatal(self) -> None:
        leadership = _FakeLeadership()
        fatal_called = asyncio.Event()
        fatal_exit = Mock(side_effect=lambda _code: fatal_called.set())
        scheduler = _FailingLoopScheduler(
            leadership=leadership,
            fatal_exit=fatal_exit,
        )
        scheduler._pipelines = self._prepared_scheduler(leadership)._pipelines
        scheduler._pipeline = scheduler._pipelines[0]
        scheduler._broker_mutation_recovery_worker = cast(
            BrokerMutationRecoveryWorker,
            _NoopRecoveryWorker(),
        )

        await scheduler.start()
        await asyncio.wait_for(fatal_called.wait(), timeout=1.0)

        self.assertEqual(
            scheduler.state.last_error,
            "scheduler_loop_failed:RuntimeError",
        )
        self.assertEqual(
            scheduler.state.emergency_stop_reason,
            "scheduler_loop_failed",
        )
        fatal_exit.assert_called_once_with(70)
        await scheduler.stop()

    async def test_unexpected_loop_cancellation_is_process_fatal(self) -> None:
        leadership = _FakeLeadership()
        fatal_called = asyncio.Event()
        fatal_exit = Mock(side_effect=lambda _code: fatal_called.set())
        scheduler = self._prepared_scheduler(leadership, fatal_exit=fatal_exit)

        await scheduler.start()
        scheduler_task = scheduler._task
        self.assertIsNotNone(scheduler_task)
        assert scheduler_task is not None
        scheduler_task.cancel()
        await asyncio.wait_for(fatal_called.wait(), timeout=1.0)

        self.assertEqual(
            scheduler.state.last_error,
            "scheduler_loop_cancelled_unexpectedly:task_cancelled",
        )
        self.assertEqual(
            scheduler.state.emergency_stop_reason,
            "scheduler_loop_cancelled_unexpectedly",
        )
        fatal_exit.assert_called_once_with(70)
        await scheduler.stop()

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

    async def test_successful_leadership_retry_clears_only_startup_failure(
        self,
    ) -> None:
        leadership = _FakeLeadership(
            acquire_error=SchedulerLeadershipError("leadership contended")
        )
        scheduler = self._prepared_scheduler(leadership)
        scheduler.state.last_trading_error = "preserve-latest-trading-error"

        with self.assertRaisesRegex(SchedulerLeadershipError, "contended"):
            await scheduler.start()

        leadership.acquire_error = None
        await scheduler.start()

        self.assertIsNone(scheduler.state.last_error)
        self.assertEqual(
            scheduler.state.last_trading_error,
            "preserve-latest-trading-error",
        )
        await scheduler.stop()

    async def test_post_acquire_startup_failure_releases_writer_fence(self) -> None:
        leadership = _FakeLeadership()
        scheduler = self._prepared_scheduler(leadership)
        scheduler._assert_trading_shorts_startup_policy = Mock(
            side_effect=RuntimeError("startup policy failed")
        )

        with self.assertRaisesRegex(RuntimeError, "startup policy failed"):
            await scheduler.start()

        self.assertIsNone(scheduler._task)
        self.assertEqual(leadership.acquire_calls, 1)
        self.assertEqual(leadership.release_calls, 1)

    async def test_leadership_loss_cancels_loop_and_latches_emergency_stop(
        self,
    ) -> None:
        leadership = _FakeLeadership()
        leadership.check_result = False
        fatal_called = asyncio.Event()
        fatal_exit = Mock(side_effect=lambda _code: fatal_called.set())
        scheduler = self._prepared_scheduler(leadership, fatal_exit=fatal_exit)

        with patch.object(
            settings,
            "trading_scheduler_leadership_check_seconds",
            0.001,
        ):
            await scheduler.start()
            await asyncio.wait_for(fatal_called.wait(), timeout=1.0)

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
        fatal_exit.assert_called_once_with(70)

        await scheduler.stop()

    async def test_monitor_crash_cancels_loop_and_fails_closed(self) -> None:
        leadership = _FakeLeadership()
        leadership.check_error = RuntimeError("monitor exploded")
        fatal_called = asyncio.Event()
        fatal_exit = Mock(side_effect=lambda _code: fatal_called.set())
        scheduler = self._prepared_scheduler(leadership, fatal_exit=fatal_exit)

        with patch.object(
            settings,
            "trading_scheduler_leadership_check_seconds",
            0.001,
        ):
            await scheduler.start()
            await asyncio.wait_for(fatal_called.wait(), timeout=1.0)

        self.assertTrue(scheduler.state.emergency_stop_active)
        self.assertEqual(
            scheduler.state.emergency_stop_reason,
            "scheduler_leadership_monitor_failed",
        )
        self.assertEqual(
            scheduler.state.last_error,
            "scheduler_leadership_monitor_failed:RuntimeError",
        )
        self.assertTrue(scheduler._task is not None and scheduler._task.cancelled())
        fatal_exit.assert_called_once_with(70)

        await scheduler.stop()

    async def test_shutdown_timeout_keeps_writer_fence_until_broker_work_drains(
        self,
    ) -> None:
        leadership = _FakeLeadership()
        fatal_exit = Mock()
        scheduler = _BlockingBrokerScheduler(
            leadership=leadership,
            fatal_exit=fatal_exit,
        )
        run_once_started = threading.Event()
        allow_run_once_to_finish = threading.Event()

        def blocking_run_once() -> None:
            run_once_started.set()
            allow_run_once_to_finish.wait(timeout=2.0)

        pipeline = SimpleNamespace(
            account_label="paper",
            order_feed_ingestor=SimpleNamespace(close=Mock()),
            run_once=blocking_run_once,
        )
        scheduler._pipelines = [pipeline]
        scheduler._pipeline = pipeline
        scheduler._broker_mutation_recovery_worker = cast(
            BrokerMutationRecoveryWorker,
            _NoopRecoveryWorker(),
        )

        with (
            patch.object(settings, "trading_scheduler_shutdown_drain_seconds", 0.01),
            patch.object(settings, "trading_scheduler_leadership_check_seconds", 0.01),
        ):
            await scheduler.start()
            self.assertTrue(
                await asyncio.to_thread(run_once_started.wait, 1.0),
                "run_once did not start",
            )
            scheduler_task = scheduler._task
            await scheduler.stop()

        fatal_exit.assert_called_once_with(70)
        self.assertEqual(leadership.release_calls, 0)
        self.assertTrue(leadership.status.acquired)
        self.assertIs(scheduler._task, scheduler_task)

        allow_run_once_to_finish.set()
        if scheduler_task is not None:
            await asyncio.wait_for(scheduler_task, timeout=1.0)
        await scheduler.stop()
        self.assertEqual(leadership.release_calls, 1)

    async def test_read_only_activity_backfill_does_not_block_trading_or_shutdown(
        self,
    ) -> None:
        leadership = _FakeLeadership()
        fatal_exit = Mock()
        scheduler = _BlockingBrokerScheduler(
            leadership=leadership,
            fatal_exit=fatal_exit,
        )
        activity_started = threading.Event()
        allow_activity_to_finish = threading.Event()
        second_trading_iteration = threading.Event()
        trading_calls = 0

        def run_once() -> None:
            nonlocal trading_calls
            trading_calls += 1
            if trading_calls >= 2:
                second_trading_iteration.set()

        def ingest_broker_account_activities() -> None:
            activity_started.set()
            allow_activity_to_finish.wait(timeout=2.0)

        pipeline = SimpleNamespace(
            account_label="paper",
            order_feed_ingestor=SimpleNamespace(close=Mock()),
            run_once=run_once,
            ingest_broker_account_activities=ingest_broker_account_activities,
        )
        scheduler._pipelines = [pipeline]
        scheduler._pipeline = pipeline
        scheduler._broker_mutation_recovery_worker = cast(
            BrokerMutationRecoveryWorker,
            _NoopRecoveryWorker(),
        )

        try:
            with (
                patch.object(settings, "trading_poll_ms", 1),
                patch.object(settings, "trading_reconcile_ms", 60_000),
                patch.object(
                    settings,
                    "trading_scheduler_shutdown_drain_seconds",
                    0.1,
                ),
                patch.object(
                    settings,
                    "trading_scheduler_leadership_check_seconds",
                    0.01,
                ),
            ):
                await scheduler.start()
                self.assertTrue(
                    await asyncio.to_thread(activity_started.wait, 1.0),
                    "account-activity backfill did not start",
                )
                self.assertTrue(
                    await asyncio.to_thread(second_trading_iteration.wait, 1.0),
                    "trading stalled behind account-activity backfill",
                )
                await scheduler.stop()
        finally:
            allow_activity_to_finish.set()

        fatal_exit.assert_not_called()
        self.assertEqual(leadership.release_calls, 1)
        self.assertFalse(scheduler.state.running)


__all__ = ["TradingSchedulerLeadershipTests"]
