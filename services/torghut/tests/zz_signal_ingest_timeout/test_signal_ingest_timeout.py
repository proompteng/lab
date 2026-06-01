from __future__ import annotations

from datetime import datetime, timezone
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app.models import Base, TradeCursor
from app.trading.ingest import ClickHouseSignalIngestor


class TimeoutAfterLatestIngestor(ClickHouseSignalIngestor):
    def __init__(self, *args, latest_signal_ts: datetime, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._latest_signal_ts = latest_signal_ts

    def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
        if "latest_signal_ts" in query:
            return [{"latest_signal_ts": self._latest_signal_ts.isoformat()}]
        raise TimeoutError("timed out")


class TestSignalIngestTimeout(TestCase):
    def test_fetch_signals_returns_empty_batch_on_clickhouse_timeout(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        latest_signal = datetime(2026, 1, 1, 0, 10, 0, tzinfo=timezone.utc)
        ingestor = TimeoutAfterLatestIngestor(
            schema="envelope",
            table="torghut.ta_signals",
            url="http://example",
            latest_signal_ts=latest_signal,
            fast_forward_stale_cursor=False,
        )
        with session_local() as session:
            batch = ingestor.fetch_signals(session)
            ingestor.commit_cursor(session, batch)
            cursor = session.execute(select(TradeCursor)).scalar_one_or_none()

        self.assertEqual(batch.signals, [])
        self.assertEqual(batch.no_signal_reason, "clickhouse_signal_query_timeout")
        self.assertIsNone(batch.cursor_at)
        self.assertIsNone(batch.cursor_seq)
        self.assertIsNone(batch.cursor_symbol)
        self.assertIsNotNone(batch.query_start)
        self.assertIsNotNone(batch.query_end)
        self.assertIsNone(cursor)

    def test_simulation_fetch_returns_empty_batch_on_clickhouse_timeout(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        snapshot = {
            "enabled": settings.trading_simulation_enabled,
            "window_start": settings.trading_simulation_window_start,
            "window_end": settings.trading_simulation_window_end,
        }
        latest_signal = datetime(2026, 3, 6, 14, 35, 0, tzinfo=timezone.utc)
        try:
            settings.trading_simulation_enabled = True
            settings.trading_simulation_window_start = "2026-03-06T14:30:00Z"
            settings.trading_simulation_window_end = "2026-03-06T14:45:00Z"
            ingestor = TimeoutAfterLatestIngestor(
                schema="envelope",
                table="torghut.ta_signals",
                url="http://example",
                latest_signal_ts=latest_signal,
                fast_forward_stale_cursor=False,
            )
            with (
                session_local() as session,
                patch(
                    "app.trading.ingest.trading_now",
                    return_value=datetime(2026, 3, 6, 14, 30, 0, tzinfo=timezone.utc),
                ),
            ):
                batch = ingestor.fetch_signals(session)
                ingestor.commit_cursor(session, batch)
                cursor = session.execute(select(TradeCursor)).scalar_one_or_none()

            self.assertEqual(batch.signals, [])
            self.assertEqual(batch.no_signal_reason, "clickhouse_signal_query_timeout")
            self.assertIsNone(batch.cursor_at)
            self.assertIsNone(batch.cursor_seq)
            self.assertIsNone(batch.cursor_symbol)
            self.assertIsNotNone(batch.query_start)
            self.assertIsNotNone(batch.query_end)
            self.assertIsNone(cursor)
        finally:
            settings.trading_simulation_enabled = snapshot["enabled"]
            settings.trading_simulation_window_start = snapshot["window_start"]
            settings.trading_simulation_window_end = snapshot["window_end"]
