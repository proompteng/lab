from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import Mock, patch

import pytest
from sqlalchemy.exc import OperationalError

from app.config import settings
from app.trading.scheduler import runtime
from app.trading.scheduler.leadership import (
    DEFAULT_SCHEDULER_ADVISORY_LOCK_ID,
    DEFAULT_SCHEDULER_ADVISORY_LOCK_NAME,
    PostgresSchedulerLeadership,
    SchedulerLeadershipError,
    scheduler_advisory_lock_id,
)


NOW = datetime(2026, 7, 11, tzinfo=timezone.utc)


def _engine_with_results(*values: object) -> tuple[Mock, Mock]:
    connection = Mock()
    connection.execute.side_effect = [
        Mock(scalar_one=Mock(return_value=value)) for value in values
    ]
    engine = Mock()
    engine.connect.return_value = connection
    return engine, connection


def test_lock_identifier_is_stable_signed_bigint() -> None:
    assert scheduler_advisory_lock_id() == DEFAULT_SCHEDULER_ADVISORY_LOCK_ID
    assert scheduler_advisory_lock_id() == scheduler_advisory_lock_id()
    assert -(2**63) <= DEFAULT_SCHEDULER_ADVISORY_LOCK_ID < 2**63
    assert scheduler_advisory_lock_id(
        "torghut:simulation-scheduler"
    ) != scheduler_advisory_lock_id(DEFAULT_SCHEDULER_ADVISORY_LOCK_NAME)


def test_scheduler_uses_configured_advisory_lock_namespace() -> None:
    lock_name = "torghut:simulation-scheduler"
    with (
        patch.object(settings, "trading_scheduler_leadership_required", True),
        patch.object(settings, "trading_scheduler_leadership_lock_name", lock_name),
        patch.object(runtime, "PostgresSchedulerLeadership") as leadership_class,
    ):
        runtime.TradingScheduler()

    leadership_class.assert_called_once_with(
        engine=runtime.database_engine,
        required=True,
        lock_id=scheduler_advisory_lock_id(lock_name),
    )


def test_disabled_leadership_never_opens_database_connection() -> None:
    engine = Mock()
    leadership = PostgresSchedulerLeadership(
        engine=engine,
        required=False,
        now=lambda: NOW,
    )

    leadership.acquire()

    assert leadership.check() is True
    assert leadership.status.healthy is True
    assert leadership.status.acquired is False
    engine.connect.assert_not_called()


def test_required_leadership_holds_dedicated_session_until_release() -> None:
    engine, connection = _engine_with_results(True, 1, True)
    leadership = PostgresSchedulerLeadership(
        engine=engine,
        required=True,
        now=lambda: NOW,
    )

    leadership.acquire()

    assert leadership.status.acquired is True
    assert leadership.status.healthy is True
    assert leadership.check() is True
    assert leadership.status.last_checked_at == NOW

    leadership.release()

    assert leadership.status.acquired is False
    assert leadership.status.healthy is False
    assert leadership.status.failure_reason == "leadership_released"
    connection.close.assert_called_once()


def test_contended_leadership_fails_closed_and_closes_session() -> None:
    engine, connection = _engine_with_results(False)
    leadership = PostgresSchedulerLeadership(
        engine=engine,
        required=True,
        now=lambda: NOW,
    )

    with pytest.raises(SchedulerLeadershipError, match="held by another process"):
        leadership.acquire()

    assert leadership.status.failure_reason == "leadership_contended"
    assert leadership.status.healthy is False
    connection.close.assert_called_once()


def test_connection_loss_revokes_local_leadership() -> None:
    engine, connection = _engine_with_results(True)
    connection.execute.side_effect = [
        Mock(scalar_one=Mock(return_value=True)),
        OperationalError("SELECT 1", {}, RuntimeError("connection lost")),
    ]
    leadership = PostgresSchedulerLeadership(
        engine=engine,
        required=True,
        now=lambda: NOW,
    )
    leadership.acquire()

    assert leadership.check() is False
    assert leadership.status.acquired is False
    assert (
        leadership.status.failure_reason
        == "leadership_connection_lost:OperationalError"
    )
    connection.close.assert_called_once()
