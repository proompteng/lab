from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import cast

from sqlalchemy import Table, create_engine
from sqlalchemy.orm import Session

from app.models import Base, BrokerAccountActivityCursor
from app.trading.broker_account_activities import (
    ACCOUNT_ACTIVITIES_REST_SOURCE,
    ALPACA_PROVIDER,
    load_broker_account_activity_status,
)


_OBSERVED_AT = datetime(2026, 7, 20, 14, 0, tzinfo=timezone.utc)


def _status_for_completed_age(completed_age: timedelta) -> dict[str, object]:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(
        engine,
        tables=[cast(Table, BrokerAccountActivityCursor.__table__)],
    )
    try:
        with Session(engine) as session:
            completed_at = _OBSERVED_AT - completed_age
            session.add(
                BrokerAccountActivityCursor(
                    provider=ALPACA_PROVIDER,
                    source=ACCOUNT_ACTIVITIES_REST_SOURCE,
                    environment="paper",
                    account_label="paper-account",
                    endpoint_fingerprint="a" * 64,
                    status="scanning",
                    scan_after=completed_at - timedelta(days=2),
                    scan_until=_OBSERVED_AT + timedelta(minutes=1),
                    scan_started_at=_OBSERVED_AT - timedelta(seconds=5),
                    last_completed_at=completed_at,
                    last_completed_scan_until=completed_at,
                    updated_at=_OBSERVED_AT,
                )
            )
            session.commit()
            return load_broker_account_activity_status(
                session,
                account_label="paper-account",
                environment="paper",
                observed_at=_OBSERVED_AT,
            )
    finally:
        engine.dispose()


def test_overlap_scan_reuses_a_fresh_completed_watermark() -> None:
    status = _status_for_completed_age(timedelta(seconds=30))

    assert status["state"] == "current"
    assert status["current"] is True
    assert status["reason_codes"] == []
    assert status["age_seconds"] == 30


def test_overlap_scan_rejects_a_stale_completed_watermark() -> None:
    status = _status_for_completed_age(timedelta(hours=2))

    assert status["current"] is False
    assert status["reason_codes"] == ["broker_account_activity_cursor_stale"]
    assert status["age_seconds"] == 7200
