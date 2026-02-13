from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional
from unittest import TestCase

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.models import Base, TradeCursor
from app.trading.ingest import ClickHouseSignalIngestor


class CapturingIngestor(ClickHouseSignalIngestor):
    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.last_query: str | None = None

    def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
        self.last_query = query
        return []


class SchemaDiscoveringIngestor(CapturingIngestor):
    def __init__(self, *args, columns: set[str], **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._columns = columns

    def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
        if query.strip().startswith("SELECT name FROM system.columns"):
            return [{"name": column} for column in self._columns]
        return super()._query_clickhouse(query)


class StaticLatestIngestor(ClickHouseSignalIngestor):
    def __init__(self, *args, latest_signal_ts: Optional[datetime] = None, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._latest_signal_ts = latest_signal_ts

    def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
        if "SELECT max(" in query:
            return [{"latest_signal_ts": self._latest_signal_ts.isoformat()}] if self._latest_signal_ts is not None else []
        return []


class TestSignalIngest(TestCase):
    def test_parse_envelope_row(self) -> None:
        ingestor = ClickHouseSignalIngestor(schema="envelope", fast_forward_stale_cursor=False)
        row = {
            "event_ts": datetime(2026, 1, 1, tzinfo=timezone.utc),
            "ingest_ts": datetime(2026, 1, 1, tzinfo=timezone.utc),
            "symbol": "AAPL",
            "payload": {"macd": {"macd": 0.5, "signal": 0.2}, "rsi14": 22},
            "window": {"size": "PT1M"},
            "seq": 10,
            "source": "ta",
        }
        signal = ingestor.parse_row(row)
        self.assertIsNotNone(signal)
        assert signal is not None
        self.assertEqual(signal.symbol, "AAPL")
        self.assertEqual(signal.payload.get("rsi14"), 22)
        self.assertEqual(signal.timeframe, "1Min")

    def test_parse_flat_row(self) -> None:
        ingestor = ClickHouseSignalIngestor(schema="flat", fast_forward_stale_cursor=False)
        row = {
            "ts": "2026-01-01T00:00:01Z",
            "symbol": "MSFT",
            "macd": 0.8,
            "signal": 0.4,
            "rsi": 55.0,
            "ema12": 351.2,
            "ema26": 349.9,
            "vol_realized_w60s": 0.009,
            "signal_json": '{"vwap": 350.1}',
        }
        signal = ingestor.parse_row(row)
        self.assertIsNotNone(signal)
        assert signal is not None
        self.assertEqual(signal.symbol, "MSFT")
        self.assertIn("macd", signal.payload)
        self.assertEqual(signal.payload.get("rsi"), 55.0)
        self.assertEqual(signal.payload.get("vwap"), 350.1)
        self.assertEqual(signal.payload.get("ema12"), 351.2)
        self.assertEqual(signal.payload.get("ema26"), 349.9)
        self.assertEqual(signal.payload.get("vol_realized_w60s"), 0.009)

    def test_parse_flat_row_uses_vwap_as_price_fallback(self) -> None:
        ingestor = ClickHouseSignalIngestor(schema="flat", fast_forward_stale_cursor=False)
        row = {
            "ts": "2026-01-01T00:00:02Z",
            "symbol": "NVDA",
            "macd": 0.4,
            "signal": 0.2,
            "rsi14": 44,
            "vwap_session": 125.75,
            "spread": 0.08,
            "imbalance_bid_px": 125.70,
            "imbalance_ask_px": 125.80,
            "imbalance_spread": 0.08,
        }
        signal = ingestor.parse_row(row)
        self.assertIsNotNone(signal)
        assert signal is not None
        self.assertEqual(signal.payload.get("price"), 125.75)
        self.assertEqual(signal.payload.get("imbalance", {}).get("bid_px"), 125.70)
        self.assertEqual(signal.payload.get("imbalance", {}).get("ask_px"), 125.80)
        self.assertEqual(signal.payload.get("imbalance", {}).get("spread"), 0.08)

    def test_build_query_flat_schema(self) -> None:
        ingestor = ClickHouseSignalIngestor(schema="flat", table="torghut.ta_signals", fast_forward_stale_cursor=False)
        query = ingestor._build_query(datetime(2026, 1, 1, tzinfo=timezone.utc), None, None)
        self.assertIn(
            "SELECT event_ts, ts, symbol, macd, macd_signal, macd_hist, signal, rsi, rsi14, ema, ema12, ema26",
            query,
        )
        self.assertIn("signal_json, timeframe, price, close, spread", query)
        self.assertIn("ema12, ema26", query)
        self.assertIn("vol_realized_w60s", query)
        self.assertIn("FROM torghut.ta_signals", query)
        self.assertIn("WHERE event_ts > toDateTime64", query)
        self.assertNotIn("payload", query)
        self.assertIn("ORDER BY event_ts ASC", query)

    def test_build_query_envelope_schema(self) -> None:
        ingestor = ClickHouseSignalIngestor(
            schema="envelope",
            table="torghut.ta_signals",
            fast_forward_stale_cursor=False,
        )
        query = ingestor._build_query(datetime(2026, 1, 1, tzinfo=timezone.utc), None, None)
        self.assertIn("SELECT event_ts, ingest_ts, symbol, payload, window_size, window_step, seq, source", query)
        self.assertIn("FROM torghut.ta_signals", query)
        self.assertIn("WHERE event_ts > toDateTime64", query)
        self.assertIn("ORDER BY event_ts ASC, symbol ASC, seq ASC", query)
        self.assertNotIn("signal_json", query)

    def test_build_query_envelope_schema_with_cursor_seq(self) -> None:
        ingestor = ClickHouseSignalIngestor(
            schema="envelope",
            table="torghut.ta_signals",
            fast_forward_stale_cursor=False,
        )
        query = ingestor._build_query(datetime(2026, 1, 1, tzinfo=timezone.utc), 42, None)
        self.assertIn("event_ts = toDateTime64", query)
        self.assertIn("seq > 42", query)
        self.assertIn("ORDER BY event_ts ASC, symbol ASC, seq ASC", query)

    def test_build_query_flat_schema_overlaps_window(self) -> None:
        ingestor = ClickHouseSignalIngestor(schema="flat", table="torghut.ta_signals", fast_forward_stale_cursor=False)
        query = ingestor._build_query(datetime(2026, 1, 1, 0, 0, 5, tzinfo=timezone.utc), None, None)
        self.assertIn("WHERE event_ts > toDateTime64", query)
        self.assertIn("2026-01-01 00:00:05.000", query)

    def test_resolve_flat_time_column_prefers_event_ts(self) -> None:
        ingestor = SchemaDiscoveringIngestor(
            schema="flat",
            table="torghut.ta_signals",
            url="http://example",
            fast_forward_stale_cursor=False,
            columns={"ts", "event_ts", "symbol"},
        )
        query = ingestor._build_query(datetime(2026, 1, 1, tzinfo=timezone.utc), None, None)
        self.assertIn("WHERE event_ts > toDateTime64", query)
        self.assertIn("ORDER BY event_ts ASC", query)
        self.assertNotIn("WHERE ts >= toDateTime64", query)

    def test_resolve_flat_time_column_falls_back_to_ts(self) -> None:
        ingestor = SchemaDiscoveringIngestor(
            schema="flat",
            table="torghut.ta_signals",
            url="http://example",
            fast_forward_stale_cursor=False,
            columns={"ts", "symbol"},
        )
        query = ingestor._build_query(datetime(2026, 1, 1, tzinfo=timezone.utc), None, None)
        self.assertIn("WHERE ts >= toDateTime64", query)
        self.assertIn("ORDER BY ts ASC, symbol ASC", query)
        self.assertNotIn("WHERE event_ts >", query)

    def test_fetch_signals_between_respects_schema(self) -> None:
        ingestor = CapturingIngestor(schema="flat", table="torghut.ta_signals", url="http://example")
        ingestor.fetch_signals_between(
            start=datetime(2026, 1, 1, tzinfo=timezone.utc),
            end=datetime(2026, 1, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL",
        )
        assert ingestor.last_query is not None
        self.assertIn(
            "SELECT event_ts, ts, symbol, macd, macd_signal, macd_hist, signal, rsi, rsi14, ema, ema12, ema26",
            ingestor.last_query,
        )
        self.assertIn("signal_json, timeframe, price, close, spread", ingestor.last_query)
        self.assertIn("ema12, ema26", ingestor.last_query)
        self.assertIn("vol_realized_w60s", ingestor.last_query)
        self.assertIn("WHERE event_ts >= toDateTime64", ingestor.last_query)
        self.assertIn("AND event_ts <= toDateTime64", ingestor.last_query)

        envelope_ingestor = CapturingIngestor(schema="envelope", table="torghut.ta_signals", url="http://example")
        envelope_ingestor.fetch_signals_between(
            start=datetime(2026, 1, 1, tzinfo=timezone.utc),
            end=datetime(2026, 1, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL",
        )
        assert envelope_ingestor.last_query is not None
        self.assertIn(
            "SELECT event_ts, ingest_ts, symbol, payload, window_size, window_step, seq, source",
            envelope_ingestor.last_query,
        )
        self.assertIn("WHERE event_ts >= toDateTime64", envelope_ingestor.last_query)
        self.assertIn("AND event_ts <= toDateTime64", envelope_ingestor.last_query)
        self.assertIn("ORDER BY event_ts ASC, seq ASC", envelope_ingestor.last_query)

    def test_fetch_signals_with_reason_reports_missing_cursor_reason(self) -> None:
        ingestor = CapturingIngestor(schema="envelope", table="torghut.ta_signals", url="http://example", batch_size=2)
        signals = ingestor.fetch_signals_with_reason(
            start=datetime(2026, 1, 1, tzinfo=timezone.utc),
            end=datetime(2026, 1, 1, 1, tzinfo=timezone.utc),
        )
        self.assertEqual(signals.signals, [])
        self.assertIsNotNone(signals.no_signal_reason)

    def test_fetch_signals_with_reason_reports_cursor_ahead(self) -> None:
        ingestor = StaticLatestIngestor(
            schema="envelope",
            table="torghut.ta_signals",
            url="http://example",
            batch_size=2,
            latest_signal_ts=datetime(2025, 12, 31, tzinfo=timezone.utc),
        )
        signals = ingestor.fetch_signals_with_reason(
            start=datetime(2026, 1, 2, tzinfo=timezone.utc),
            end=datetime(2026, 1, 2, 0, 5, tzinfo=timezone.utc),
        )
        self.assertEqual(signals.signals, [])
        self.assertEqual(signals.no_signal_reason, "cursor_ahead_of_stream")

    def test_parse_window_size_timeframe(self) -> None:
        ingestor = ClickHouseSignalIngestor(schema="envelope", fast_forward_stale_cursor=False)
        row = {
            "event_ts": datetime(2026, 1, 1, tzinfo=timezone.utc),
            "symbol": "AAPL",
            "payload": {"rsi14": 22},
            "window_size": "PT1M",
            "seq": 10,
            "source": "ta",
        }
        signal = ingestor.parse_row(row)
        self.assertIsNotNone(signal)
        assert signal is not None
        self.assertEqual(signal.timeframe, "1Min")

    def test_cursor_updates_with_seq(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        rows = [
            {"event_ts": "2026-01-01T00:00:00Z", "symbol": "AAPL", "payload": {}, "seq": 1},
            {"event_ts": "2026-01-01T00:00:00Z", "symbol": "AAPL", "payload": {}, "seq": 3},
            {"event_ts": "2026-01-01T00:00:10Z", "symbol": "AAPL", "payload": {}, "seq": 2},
        ]

        class CursorIngestor(ClickHouseSignalIngestor):
            def __init__(self, *args, **kwargs) -> None:
                super().__init__(*args, **kwargs)
                self._rows = rows

            def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
                return self._rows

        ingestor = CursorIngestor(
            schema="envelope",
            table="torghut.ta_signals",
            url="http://example",
            fast_forward_stale_cursor=False,
        )
        with session_local() as session:
            batch = ingestor.fetch_signals(session)
            cursor = session.execute(select(TradeCursor)).scalar_one_or_none()
            self.assertIsNone(cursor)
            ingestor.commit_cursor(session, batch)
            cursor = session.execute(select(TradeCursor)).scalar_one()
            self.assertEqual(cursor.cursor_at, datetime(2026, 1, 1, 0, 0, 10))
            self.assertEqual(cursor.cursor_seq, 2)
            self.assertEqual(cursor.cursor_symbol, "AAPL")

    def test_cursor_tracks_symbol_tiebreak(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        rows = [
            {"event_ts": "2026-01-01T00:00:00Z", "symbol": "AAPL", "payload": {}, "seq": 1},
            {"event_ts": "2026-01-01T00:00:00Z", "symbol": "MSFT", "payload": {}, "seq": 1},
            {"event_ts": "2026-01-01T00:00:00Z", "symbol": "GOOG", "payload": {}, "seq": 1},
        ]

        class CursorIngestor(ClickHouseSignalIngestor):
            def __init__(self, *args, **kwargs) -> None:
                super().__init__(*args, **kwargs)
                self._rows = rows

            def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
                return self._rows

        ingestor = CursorIngestor(
            schema="envelope",
            table="torghut.ta_signals",
            url="http://example",
            fast_forward_stale_cursor=False,
        )
        with session_local() as session:
            batch = ingestor.fetch_signals(session)
            ingestor.commit_cursor(session, batch)
            cursor = session.execute(select(TradeCursor)).scalar_one()
            self.assertEqual(cursor.cursor_at, datetime(2026, 1, 1, 0, 0, 0))
            self.assertEqual(cursor.cursor_seq, 1)
            self.assertEqual(cursor.cursor_symbol, "MSFT")

    def test_empty_fetch_advances_cursor_to_recent_window(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        stale_cursor = datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc)

        class CursorIngestor(ClickHouseSignalIngestor):
            def __init__(self, *args, **kwargs) -> None:
                super().__init__(*args, **kwargs)
                self.rows = []

            def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
                return self.rows

        ingestor = CursorIngestor(
            schema="envelope",
            table="torghut.ta_signals",
            url="http://example",
            fast_forward_stale_cursor=False,
        )
        with session_local() as session:
            session.add(TradeCursor(source="clickhouse", cursor_at=stale_cursor, cursor_seq=None))
            session.commit()

            before = datetime.now(timezone.utc)
            batch = ingestor.fetch_signals(session)
            after = datetime.now(timezone.utc)

            self.assertEqual(batch.signals, [])
            self.assertIsNotNone(batch.cursor_at)
            self.assertIsNone(batch.cursor_seq)
            self.assertIsNone(batch.cursor_symbol)
            self.assertEqual(batch.no_signal_reason, "empty_batch_advanced")
            assert batch.cursor_at is not None
            self.assertLess(before - batch.cursor_at, timedelta(seconds=90))
            self.assertLess(after - batch.cursor_at, timedelta(seconds=90))
            self.assertLess(batch.cursor_at, datetime.now(timezone.utc))

    def test_cursor_ahead_of_signal_stream_rewinds_and_reasons(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        latest_signal = datetime(2026, 1, 1, 0, 10, 0, tzinfo=timezone.utc)
        cursor_time = datetime(2026, 1, 1, 1, 0, 0, tzinfo=timezone.utc)

        class CursorIngestor(ClickHouseSignalIngestor):
            def __init__(self, *args, **kwargs) -> None:
                super().__init__(*args, **kwargs)

            def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
                if query.startswith("SELECT max("):
                    return [{"latest_signal_ts": latest_signal.isoformat()}]
                return []

        ingestor = CursorIngestor(schema="envelope", url="http://example", fast_forward_stale_cursor=False)
        with session_local() as session:
            session.add(TradeCursor(source="clickhouse", cursor_at=cursor_time, cursor_seq=None))
            session.commit()

            batch = ingestor.fetch_signals(session)

            self.assertEqual(batch.signals, [])
            self.assertEqual(batch.no_signal_reason, "cursor_ahead_of_stream")
            self.assertEqual(batch.cursor_at, latest_signal)

    def test_cursor_tail_held_when_no_progress_and_tail_reached(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        latest_signal = datetime(2026, 1, 1, 0, 10, 0, tzinfo=timezone.utc)
        cursor_time = latest_signal

        class CursorIngestor(ClickHouseSignalIngestor):
            def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
                if query.strip().startswith("SELECT max("):
                    return [{"latest_signal_ts": latest_signal.isoformat()}]
                return []

        ingestor = CursorIngestor(schema="envelope", url="http://example", fast_forward_stale_cursor=False)
        with session_local() as session:
            session.add(TradeCursor(source="clickhouse", cursor_at=cursor_time, cursor_seq=None))
            session.commit()

            batch = ingestor.fetch_signals(session)

            self.assertEqual(batch.signals, [])
            self.assertEqual(batch.no_signal_reason, "cursor_tail_stable")
            self.assertEqual(batch.cursor_at, latest_signal)

    def test_flat_cursor_overlap_dedupes_older_rows(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        base_ts = datetime(2026, 1, 1, tzinfo=timezone.utc)
        rows = [
            {"ts": (base_ts - timedelta(seconds=1)).isoformat(), "symbol": "AAPL"},
            {"ts": base_ts.isoformat(), "symbol": "AAPL"},
            {"ts": (base_ts + timedelta(seconds=1)).isoformat(), "symbol": "AAPL"},
        ]

        class CursorIngestor(SchemaDiscoveringIngestor):
            def __init__(self, *args, **kwargs) -> None:
                super().__init__(*args, **kwargs)
                self._rows = rows

            def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
                if query.strip().startswith("SELECT name FROM system.columns"):
                    return [{"name": "ts"}, {"name": "symbol"}]
                return self._rows

        ingestor = CursorIngestor(
            schema="flat",
            table="torghut.ta_signals",
            url="http://example",
            columns={"ts", "symbol"},
            fast_forward_stale_cursor=False,
        )
        with session_local() as session:
            cursor = TradeCursor(source="clickhouse", cursor_at=base_ts, cursor_seq=None)
            session.add(cursor)
            session.commit()
            batch = ingestor.fetch_signals(session)
            self.assertEqual(len(batch.signals), 2)
            self.assertEqual(batch.cursor_at, base_ts + timedelta(seconds=1))

    def test_fetch_signals_between_rejects_invalid_symbol(self) -> None:
        ingestor = CapturingIngestor(schema="flat", table="torghut.ta_signals", url="http://example")
        signals = ingestor.fetch_signals_between(
            start=datetime(2026, 1, 1, tzinfo=timezone.utc),
            end=datetime(2026, 1, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL'; DROP",
        )
        self.assertEqual(signals, [])
        self.assertIsNone(ingestor.last_query)
