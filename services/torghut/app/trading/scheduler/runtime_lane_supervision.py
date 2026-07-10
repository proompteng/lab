"""Bounded, non-overlapping execution for synchronous trading account lanes."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from typing import TYPE_CHECKING, Protocol

from ...config import settings
from .state import TradingState

logger = logging.getLogger(__name__)


class _LaneWorkTimeoutError(TimeoutError):
    """Raised when a supervised lane exceeds its scheduler wait budget."""


if TYPE_CHECKING:

    class _TradingSchedulerLaneSupervisionContract(Protocol):
        state: TradingState
        _lane_tasks: dict[str, asyncio.Task[object]]
        _scheduler_last_error: str | None

    _TradingSchedulerLaneSupervisionBase = _TradingSchedulerLaneSupervisionContract
else:
    _TradingSchedulerLaneSupervisionBase = object


class TradingSchedulerLaneSupervisionMixin(
    _TradingSchedulerLaneSupervisionBase,
):
    """Supervise account-wide trading work without overlapping timed-out threads."""

    @staticmethod
    def _observe_lane_task(task: asyncio.Task[object]) -> None:
        """Retrieve a background task failure so asyncio does not report it as lost."""

        if not task.cancelled():
            task.exception()

    async def _run_lane_work(
        self,
        *,
        operation: str,
        account_label: str,
        work: Callable[[], object],
        timeout_seconds: float,
    ) -> object:
        """Bound one lane without ever overlapping work after a timeout."""

        key = account_label
        previous_task = self._lane_tasks.get(key)
        if previous_task is not None:
            if not previous_task.done():
                raise _LaneWorkTimeoutError(
                    f"account_lane_still_running_after_timeout:{account_label}:"
                    f"requested_operation={operation}"
                )
            self._lane_tasks.pop(key, None)
            previous_task.result()

        task = asyncio.create_task(
            asyncio.to_thread(work),
            name=f"torghut-{operation}-{account_label}",
        )
        task.add_done_callback(self._observe_lane_task)
        self._lane_tasks[key] = task
        try:
            return await asyncio.wait_for(
                asyncio.shield(task),
                timeout=max(0.001, timeout_seconds),
            )
        except TimeoutError as exc:
            raise _LaneWorkTimeoutError(
                f"{operation}_lane_timeout:{account_label}:{timeout_seconds:g}s"
            ) from exc
        finally:
            if task.done():
                self._lane_tasks.pop(key, None)

    async def _drain_lane_work(self) -> bool:
        """Bound shutdown drain and report whether lane resources are safe to close."""

        if not self._lane_tasks:
            return True
        tasks = tuple(self._lane_tasks.values())
        _done, pending = await asyncio.wait(
            tasks,
            timeout=max(0.001, settings.trading_lane_shutdown_timeout_seconds),
        )
        for key, task in tuple(self._lane_tasks.items()):
            if task.done():
                self._lane_tasks.pop(key, None)
        if not pending:
            return True

        pending_keys = sorted(
            f"{account_label}:{task.get_name()}"
            for account_label, task in self._lane_tasks.items()
            if task in pending
        )
        logger.error(
            "Timed out draining scheduler lane work timeout_seconds=%s pending=%s",
            settings.trading_lane_shutdown_timeout_seconds,
            ",".join(pending_keys),
        )
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        for key, task in tuple(self._lane_tasks.items()):
            if task in pending:
                self._lane_tasks.pop(key, None)
        return False

    def _refresh_lane_error_state(self) -> None:
        errors = tuple(
            error
            for error in (
                self.state.last_trading_error,
                self.state.last_reconcile_error,
                self.state.last_autonomy_error,
                self.state.last_evidence_error,
            )
            if error
        )
        scheduler_error = ";".join(errors) or None
        current_error = self.state.last_error
        component_error_active = bool(
            self.state.universe_fail_safe_blocked or self.state.emergency_stop_active
        )
        if (
            not component_error_active
            or current_error is None
            or current_error == self._scheduler_last_error
        ):
            self.state.last_error = scheduler_error
        self._scheduler_last_error = scheduler_error


__all__ = ["TradingSchedulerLaneSupervisionMixin"]
