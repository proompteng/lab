"""PostgreSQL-backed leadership for the singleton trading scheduler."""

from __future__ import annotations

import hashlib
import threading
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Callable, Protocol

from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import SQLAlchemyError


def scheduler_advisory_lock_id(name: str = "torghut:trading-scheduler") -> int:
    """Return a stable signed 64-bit advisory-lock identifier."""

    digest = hashlib.sha256(name.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], byteorder="big", signed=True)


DEFAULT_SCHEDULER_ADVISORY_LOCK_ID = scheduler_advisory_lock_id()


@dataclass(frozen=True, slots=True)
class SchedulerLeadershipStatus:
    """Current scheduler-leadership state for readiness and telemetry."""

    required: bool
    lock_id: int
    acquired: bool = False
    healthy: bool = False
    acquired_at: datetime | None = None
    last_checked_at: datetime | None = None
    failure_reason: str | None = None


class SchedulerLeadershipError(RuntimeError):
    """Raised when required scheduler leadership cannot be established."""


class SchedulerLeadership(Protocol):
    """Structural writer-fence contract used by the scheduler runtime."""

    @property
    def status(self) -> SchedulerLeadershipStatus: ...

    def acquire(self) -> None: ...

    def check(self) -> bool: ...

    def release(self) -> None: ...


class PostgresSchedulerLeadership:
    """Hold a PostgreSQL session advisory lock for scheduler lifetime.

    PostgreSQL releases the lock if the owning connection disappears. Callers must
    stop broker-affecting work immediately when :meth:`check` returns ``False``.
    """

    def __init__(
        self,
        *,
        engine: Engine,
        required: bool,
        lock_id: int = DEFAULT_SCHEDULER_ADVISORY_LOCK_ID,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._engine = engine
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._connection: Connection | None = None
        self._mutex = threading.Lock()
        self._status = SchedulerLeadershipStatus(
            required=required,
            lock_id=lock_id,
            healthy=not required,
        )

    @property
    def status(self) -> SchedulerLeadershipStatus:
        with self._mutex:
            return self._status

    def acquire(self) -> None:
        """Acquire required leadership or raise without starting the scheduler."""

        with self._mutex:
            if not self._status.required:
                self._status = replace(
                    self._status,
                    healthy=True,
                    last_checked_at=self._now(),
                    failure_reason=None,
                )
                return
            if self._connection is not None and self._status.acquired:
                return

            connection: Connection | None = None
            try:
                connection = self._engine.connect()
                acquired = bool(
                    connection.execute(
                        text("SELECT pg_try_advisory_lock(:lock_id)"),
                        {"lock_id": self._status.lock_id},
                    ).scalar_one()
                )
                connection.commit()
            except SQLAlchemyError as exc:
                if connection is not None:
                    connection.close()
                self._mark_failed_locked(
                    f"leadership_probe_failed:{type(exc).__name__}"
                )
                raise SchedulerLeadershipError(
                    "required scheduler leadership probe failed"
                ) from exc

            if not acquired:
                connection.close()
                self._mark_failed_locked("leadership_contended")
                raise SchedulerLeadershipError(
                    "required scheduler leadership is held by another process"
                )

            acquired_at = self._now()
            self._connection = connection
            self._status = replace(
                self._status,
                acquired=True,
                healthy=True,
                acquired_at=acquired_at,
                last_checked_at=acquired_at,
                failure_reason=None,
            )

    def check(self) -> bool:
        """Verify that the lock-owning database session is still usable."""

        with self._mutex:
            if not self._status.required:
                self._status = replace(
                    self._status,
                    healthy=True,
                    last_checked_at=self._now(),
                    failure_reason=None,
                )
                return True
            connection = self._connection
            if connection is None or not self._status.acquired:
                self._mark_failed_locked("leadership_not_acquired")
                return False

            try:
                connection.execute(text("SELECT 1")).scalar_one()
                connection.commit()
            except SQLAlchemyError as exc:
                connection.close()
                self._connection = None
                self._mark_failed_locked(
                    f"leadership_connection_lost:{type(exc).__name__}"
                )
                return False

            self._status = replace(
                self._status,
                healthy=True,
                last_checked_at=self._now(),
                failure_reason=None,
            )
            return True

    def release(self) -> None:
        """Release leadership and close the dedicated database session."""

        with self._mutex:
            connection = self._connection
            self._connection = None
            if connection is not None:
                try:
                    if self._status.acquired:
                        connection.execute(
                            text("SELECT pg_advisory_unlock(:lock_id)"),
                            {"lock_id": self._status.lock_id},
                        ).scalar_one()
                        connection.commit()
                except SQLAlchemyError:
                    # Closing the session is the authoritative release fallback.
                    pass
                finally:
                    connection.close()
            self._status = replace(
                self._status,
                acquired=False,
                healthy=not self._status.required,
                acquired_at=None,
                last_checked_at=self._now(),
                failure_reason=(
                    None if not self._status.required else "leadership_released"
                ),
            )

    def _mark_failed_locked(self, reason: str) -> None:
        self._status = replace(
            self._status,
            acquired=False,
            healthy=False,
            acquired_at=None,
            last_checked_at=self._now(),
            failure_reason=reason,
        )


__all__ = [
    "DEFAULT_SCHEDULER_ADVISORY_LOCK_ID",
    "PostgresSchedulerLeadership",
    "SchedulerLeadership",
    "SchedulerLeadershipError",
    "SchedulerLeadershipStatus",
    "scheduler_advisory_lock_id",
]
