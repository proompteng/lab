from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Optional
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.models import Base, TradeCursor
from app.config import settings
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
        if "latest_signal_ts" in query:
            return [{"latest_signal_ts": self._latest_signal_ts.isoformat()}] if self._latest_signal_ts is not None else []
        return []


class FlakyLatestIngestor(ClickHouseSignalIngestor):
    def __init__(self, *args, responses: list[object], **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.responses = list(responses)

    def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
        if "latest_signal_ts" not in query:
            return []
        if not self.responses:
            return []
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


class SimulationWindowIngestor(ClickHouseSignalIngestor):
    def __init__(self, *args, latest_signal_ts: datetime, rows: list[dict[str, object]] | None = None, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._latest_signal_ts = latest_signal_ts
        self.rows = list(rows or [])
        self.queries: list[str] = []

    def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
        self.queries.append(query)
        if "latest_signal_ts" in query:
            return [{"latest_signal_ts": self._latest_signal_ts.isoformat()}]
        return list(self.rows)


class SimulationWindowNoLatestIngestor(ClickHouseSignalIngestor):
    def __init__(self, *args, rows: list[dict[str, object]] | None = None, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.rows = list(rows or [])
        self.queries: list[str] = []

    def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
        self.queries.append(query)
        if "latest_signal_ts" in query:
            raise RuntimeError("clickhouse probe unavailable")
        return list(self.rows)


class MetadataLatestIngestor(ClickHouseSignalIngestor):
    def __init__(self, *args, latest_signal_ts: datetime, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.latest_signal_ts = latest_signal_ts
        self.queries: list[str] = []

    def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
        self.queries.append(query)
        if "ORDER BY event_ts DESC, symbol DESC, seq DESC" in query:
            return [{"latest_signal_ts": self.latest_signal_ts.isoformat()}]
        if "SELECT max(" in query or "FROM system.parts" in query:
            raise AssertionError("expected descending latest-timestamp query to avoid aggregate freshness scans")
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

    def test_parse_flat_row_merges_deeplob_microstructure_signal_v1(self) -> None:
        ingestor = ClickHouseSignalIngestor(schema="flat", fast_forward_stale_cursor=False)
        row = {
            "ts": "2026-01-01T00:00:03Z",
            "symbol": "MSFT",
            "microstructure_signal_v1": json.dumps(
                {
                    "schema_version": "microstructure_signal_v1",
                    "symbol": "msft",
                    "horizon": "PT1S",
                    "direction_probabilities": {
                        "up": 0.7,
                        "flat": 0.1,
                        "down": 0.2,
                    },
                    "uncertainty_band": "high",
                    "expected_spread_impact_bps": 14.0,
                    "expected_slippage_bps": 9.2,
                    "feature_quality_status": "pass",
                    "artifact": {
                        "model_id": "deeplob-bdlob-v1",
                        "feature_schema_version": "microstructure_signal_v1",
                        "training_run_id": "run-abc-123",
                    },
                }
            ),
        }
        signal = ingestor.parse_row(row)
        self.assertIsNotNone(signal)
        assert signal is not None
        self.assertIn("microstructure_signal", signal.payload)
        microstructure = signal.payload.get("microstructure_signal")
        self.assertIsInstance(microstructure, dict)
        assert isinstance(microstructure, dict)
        self.assertEqual(microstructure.get("schema_version"), "microstructure_signal_v1")
        self.assertEqual(
            microstructure.get("artifact", {}).get("model_id"),
            "deeplob-bdlob-v1",
        )

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

    def test_parse_row_attaches_simulation_context_from_row_fields(self) -> None:
        ingestor = ClickHouseSignalIngestor(schema='envelope', fast_forward_stale_cursor=False)
        row = {
            'event_ts': datetime(2026, 1, 1, tzinfo=timezone.utc),
            'symbol': 'AAPL',
            'seq': 55,
            'payload': {
                'macd': {'macd': 0.5, 'signal': 0.2},
                'rsi14': 30,
            },
            'dataset_event_id': 'evt-55',
            'source_topic': 'torghut.trades.v1',
            'source_partition': 2,
            'source_offset': 900,
            'replay_topic': 'torghut.sim.trades.v1',
        }
        original_enabled = settings.trading_simulation_enabled
        original_run_id = settings.trading_simulation_run_id
        original_dataset_id = settings.trading_simulation_dataset_id
        try:
            settings.trading_simulation_enabled = True
            settings.trading_simulation_run_id = 'sim-2026-02-27-01'
            settings.trading_simulation_dataset_id = 'dataset-a'
            signal = ingestor.parse_row(row)
        finally:
            settings.trading_simulation_enabled = original_enabled
            settings.trading_simulation_run_id = original_run_id
            settings.trading_simulation_dataset_id = original_dataset_id

        self.assertIsNotNone(signal)
        assert signal is not None
        context = signal.payload.get('simulation_context')
        self.assertIsInstance(context, dict)
        assert isinstance(context, dict)
        self.assertEqual(context.get('simulation_run_id'), 'sim-2026-02-27-01')
        self.assertEqual(context.get('dataset_id'), 'dataset-a')
        self.assertEqual(context.get('dataset_event_id'), 'evt-55')
        self.assertEqual(context.get('source_topic'), 'torghut.trades.v1')
        self.assertEqual(context.get('signal_seq'), 55)

    def test_simulation_mode_disables_cursor_fast_forward_and_empty_batch_advance(self) -> None:
        original_enabled = settings.trading_simulation_enabled
        original_empty_batch_advance = settings.trading_signal_empty_batch_advance_seconds
        try:
            settings.trading_simulation_enabled = True
            settings.trading_signal_empty_batch_advance_seconds = 60
            ingestor = ClickHouseSignalIngestor(schema='envelope', url='http://example')
        finally:
            settings.trading_simulation_enabled = original_enabled
            settings.trading_signal_empty_batch_advance_seconds = original_empty_batch_advance

        self.assertFalse(ingestor.fast_forward_stale_cursor)
        self.assertEqual(ingestor.empty_batch_advance_seconds, 0)

    def test_simulation_mode_initial_cursor_uses_simulated_window_start(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        original_enabled = settings.trading_simulation_enabled
        try:
            settings.trading_simulation_enabled = True
            ingestor = ClickHouseSignalIngestor(schema='envelope', url='http://example')
            with session_local() as session, patch(
                "app.trading.ingest.trading_now",
                return_value=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
            ) as mocked_trading_now:
                cursor_at, cursor_seq, cursor_symbol = ingestor._get_cursor(session)
        finally:
            settings.trading_simulation_enabled = original_enabled

        mocked_trading_now.assert_called_once_with(account_label=ingestor.account_label)
        self.assertEqual(cursor_at, datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc))
        self.assertIsNone(cursor_seq)
        self.assertIsNone(cursor_symbol)

    def test_simulation_mode_baseline_cursor_reuses_simulated_window_start(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        original_enabled = settings.trading_simulation_enabled
        try:
            settings.trading_simulation_enabled = True
            ingestor = ClickHouseSignalIngestor(schema='envelope', url='http://example')
            with session_local() as session, patch(
                "app.trading.ingest.trading_now",
                return_value=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
            ) as mocked_trading_now:
                session.add(
                    TradeCursor(
                        source="clickhouse",
                        cursor_at=datetime(1970, 1, 1, tzinfo=timezone.utc),
                        cursor_seq=None,
                    )
                )
                session.commit()
                cursor_at, cursor_seq, cursor_symbol = ingestor._get_cursor(session)
        finally:
            settings.trading_simulation_enabled = original_enabled

        mocked_trading_now.assert_called_once_with(account_label=ingestor.account_label)
        self.assertEqual(cursor_at, datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc))
        self.assertIsNone(cursor_seq)
        self.assertIsNone(cursor_symbol)

    def test_simulation_mode_cursor_outside_window_resets_to_window_start(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        snapshot = {
            "enabled": settings.trading_simulation_enabled,
            "window_start": settings.trading_simulation_window_start,
            "window_end": settings.trading_simulation_window_end,
        }
        try:
            settings.trading_simulation_enabled = True
            settings.trading_simulation_window_start = "2026-03-06T14:30:00Z"
            settings.trading_simulation_window_end = "2026-03-06T14:45:00Z"
            ingestor = ClickHouseSignalIngestor(schema='envelope', url='http://example')
            with session_local() as session:
                session.add(
                    TradeCursor(
                        source="clickhouse",
                        account_label=ingestor.account_label,
                        cursor_at=datetime(2026, 3, 6, 20, 22, tzinfo=timezone.utc),
                        cursor_seq=11,
                        cursor_symbol="NVDA",
                    )
                )
                session.commit()
                cursor_at, cursor_seq, cursor_symbol = ingestor._get_cursor(session)
        finally:
            settings.trading_simulation_enabled = snapshot["enabled"]
            settings.trading_simulation_window_start = snapshot["window_start"]
            settings.trading_simulation_window_end = snapshot["window_end"]

        self.assertEqual(cursor_at, datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc))
        self.assertIsNone(cursor_seq)
        self.assertIsNone(cursor_symbol)

    def test_simulation_mode_fetch_uses_simulated_now_for_cursor_tail_lag(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        latest_signal = datetime(2026, 3, 6, 15, 30, 0, tzinfo=timezone.utc)

        class CursorIngestor(ClickHouseSignalIngestor):
            def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
                if "latest_signal_ts" in query:
                    return [{"latest_signal_ts": latest_signal.isoformat()}]
                return []

        original_enabled = settings.trading_simulation_enabled
        try:
            settings.trading_simulation_enabled = True
            ingestor = CursorIngestor(schema="envelope", url="http://example", fast_forward_stale_cursor=False)
            with session_local() as session, patch(
                "app.trading.ingest.trading_now",
                return_value=latest_signal,
            ) as mocked_trading_now:
                session.add(TradeCursor(source="clickhouse", cursor_at=latest_signal, cursor_seq=None))
                session.commit()

                batch = ingestor.fetch_signals(session)
        finally:
            settings.trading_simulation_enabled = original_enabled

        mocked_trading_now.assert_called_once_with(account_label=ingestor.account_label)
        self.assertEqual(batch.signals, [])
        self.assertEqual(batch.no_signal_reason, "cursor_tail_stable")
        self.assertEqual(batch.cursor_at, latest_signal)
        self.assertEqual(batch.query_end, latest_signal)
        self.assertEqual(batch.signal_lag_seconds, 0.0)

    def test_simulation_mode_fetch_uses_bounded_cursor_ordered_query(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        latest_signal = datetime(2026, 3, 6, 15, 30, 0, tzinfo=timezone.utc)

        original_enabled = settings.trading_simulation_enabled
        try:
            settings.trading_simulation_enabled = True
            ingestor = SimulationWindowIngestor(
                schema="envelope",
                url="http://example",
                latest_signal_ts=latest_signal,
                fast_forward_stale_cursor=False,
            )
            with session_local() as session, patch(
                "app.trading.ingest.trading_now",
                return_value=datetime(2026, 3, 6, 14, 30, 0, tzinfo=timezone.utc),
            ):
                batch = ingestor.fetch_signals(session)
        finally:
            settings.trading_simulation_enabled = original_enabled

        self.assertEqual(batch.signals, [])
        self.assertEqual(batch.no_signal_reason, "empty_batch_advanced")
        self.assertEqual(batch.cursor_at, datetime(2026, 3, 6, 14, 30, 10, tzinfo=timezone.utc))
        self.assertGreaterEqual(len(ingestor.queries), 2)
        replay_query = ingestor.queries[-1]
        self.assertIn("WHERE event_ts >= toDateTime64", replay_query)
        self.assertIn("AND event_ts <= toDateTime64", replay_query)
        self.assertIn("ORDER BY event_ts ASC, symbol ASC, seq ASC", replay_query)
        self.assertIn("LIMIT 500", replay_query)

    def test_simulation_mode_fetch_filters_cursor_boundary_rows_before_advancing(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        latest_signal = datetime(2026, 3, 6, 15, 30, 0, tzinfo=timezone.utc)
        row = {
            "event_ts": "2026-03-06T14:30:00Z",
            "ingest_ts": "2026-03-06T14:30:01Z",
            "symbol": "AAPL",
            "payload": {"price": 100, "macd": {"macd": 1.0, "signal": 0.5}, "rsi14": 30},
            "window_size": "PT1S",
            "window_step": "PT1S",
            "seq": 7,
            "source": "ta",
        }

        original_enabled = settings.trading_simulation_enabled
        try:
            settings.trading_simulation_enabled = True
            ingestor = SimulationWindowIngestor(
                schema="envelope",
                url="http://example",
                latest_signal_ts=latest_signal,
                rows=[row],
                fast_forward_stale_cursor=False,
            )
            with session_local() as session, patch(
                "app.trading.ingest.trading_now",
                return_value=latest_signal,
            ):
                session.add(
                    TradeCursor(
                        source="clickhouse",
                        account_label=ingestor.account_label,
                        cursor_at=datetime(2026, 3, 6, 14, 30, 0, tzinfo=timezone.utc),
                        cursor_seq=7,
                        cursor_symbol="AAPL",
                    )
                )
                session.commit()
                batch = ingestor.fetch_signals(session)
        finally:
            settings.trading_simulation_enabled = original_enabled

        self.assertEqual(batch.signals, [])
        self.assertEqual(batch.no_signal_reason, "empty_batch_advanced")
        self.assertEqual(batch.cursor_at, datetime(2026, 3, 6, 14, 30, 10, tzinfo=timezone.utc))

    def test_simulation_mode_fetch_queries_bounded_window_when_latest_probe_fails(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        row = {
            "event_ts": "2026-03-06T14:30:01Z",
            "ingest_ts": "2026-03-06T14:30:02Z",
            "symbol": "AAPL",
            "payload": {"price": 100, "macd": {"macd": 1.0, "signal": 0.5}, "rsi14": 30},
            "window_size": "PT1S",
            "window_step": "PT1S",
            "seq": 8,
            "source": "ta",
        }

        original_enabled = settings.trading_simulation_enabled
        try:
            settings.trading_simulation_enabled = True
            ingestor = SimulationWindowNoLatestIngestor(
                schema="envelope",
                url="http://example",
                rows=[row],
                fast_forward_stale_cursor=False,
            )
            with session_local() as session, patch(
                "app.trading.ingest.trading_now",
                return_value=datetime(2026, 3, 6, 14, 30, 0, tzinfo=timezone.utc),
            ):
                batch = ingestor.fetch_signals(session)
        finally:
            settings.trading_simulation_enabled = original_enabled

        self.assertEqual(batch.no_signal_reason, None)
        self.assertEqual(len(batch.signals), 1)
        self.assertEqual(batch.query_start, datetime(2026, 3, 6, 14, 30, 0, tzinfo=timezone.utc))
        self.assertEqual(batch.query_end, datetime(2026, 3, 6, 14, 30, 10, tzinfo=timezone.utc))
        replay_query = ingestor.queries[-1]
        self.assertIn("WHERE event_ts >=", replay_query)
        self.assertIn("AND event_ts <=", replay_query)

    def test_simulation_mode_empty_poll_without_in_window_signals_holds_cursor(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        snapshot = {
            "enabled": settings.trading_simulation_enabled,
            "window_start": settings.trading_simulation_window_start,
            "window_end": settings.trading_simulation_window_end,
        }
        try:
            settings.trading_simulation_enabled = True
            settings.trading_simulation_window_start = "2026-03-06T14:30:00Z"
            settings.trading_simulation_window_end = "2026-03-06T14:45:00Z"
            ingestor = SimulationWindowNoLatestIngestor(
                schema="envelope",
                url="http://example",
                rows=[],
                fast_forward_stale_cursor=False,
            )
            with session_local() as session, patch(
                "app.trading.ingest.trading_now",
                return_value=datetime(2026, 3, 6, 14, 30, 0, tzinfo=timezone.utc),
            ):
                batch = ingestor.fetch_signals(session)
        finally:
            settings.trading_simulation_enabled = snapshot["enabled"]
            settings.trading_simulation_window_start = snapshot["window_start"]
            settings.trading_simulation_window_end = snapshot["window_end"]

        self.assertEqual(batch.signals, [])
        self.assertEqual(batch.no_signal_reason, "no_signals_in_window")
        self.assertEqual(batch.cursor_at, datetime(2026, 3, 6, 14, 30, 0, tzinfo=timezone.utc))
        self.assertEqual(batch.query_end, datetime(2026, 3, 6, 14, 30, 10, tzinfo=timezone.utc))
        latest_query = next(query for query in ingestor.queries if "latest_signal_ts" in query)
        self.assertIn("WHERE event_ts >=", latest_query)
        self.assertIn("AND event_ts <=", latest_query)

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
        self.assertIn("microstructure_signal_v1", query)
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
        self.assertIn("microstructure_signal_v1", ingestor.last_query)
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

    def test_fetch_signals_between_dedupes_replay_duplicates_by_stable_identity(self) -> None:
        rows = [
            {
                "event_ts": "2026-03-06T14:50:00Z",
                "ingest_ts": "2026-03-08T01:33:32.461000Z",
                "symbol": "SIM-SPY",
                "payload": {
                    "rsi14": 30,
                    "simulation_context": {
                        "dataset_event_id": "evt-1",
                        "source_topic": "torghut.trades.v1",
                        "source_partition": 2,
                        "source_offset": 900,
                        "signal_seq": 100,
                        "simulation_run_id": "sim-old",
                    },
                },
                "seq": 100,
                "source": "ws",
                "window_size": "PT1S",
            },
            {
                "event_ts": "2026-03-06T14:50:00Z",
                "ingest_ts": "2026-03-06T14:51:00.316000Z",
                "symbol": "SIM-SPY",
                "payload": {
                    "rsi14": 30,
                    "simulation_context": {
                        "dataset_event_id": "evt-1",
                        "source_topic": "torghut.trades.v1",
                        "source_partition": 2,
                        "source_offset": 900,
                        "signal_seq": 100,
                        "simulation_run_id": "sim-current",
                    },
                },
                "seq": 100,
                "source": "ws",
                "window_size": "PT1S",
            },
            {
                "event_ts": "2026-03-06T14:50:01Z",
                "ingest_ts": "2026-03-06T14:51:01.316000Z",
                "symbol": "SIM-SPY",
                "payload": {
                    "rsi14": 31,
                    "simulation_context": {
                        "dataset_event_id": "evt-2",
                        "source_topic": "torghut.trades.v1",
                        "source_partition": 2,
                        "source_offset": 901,
                        "signal_seq": 101,
                        "simulation_run_id": "sim-current",
                    },
                },
                "seq": 101,
                "source": "ws",
                "window_size": "PT1S",
            },
        ]

        class DuplicateEnvelopeIngestor(ClickHouseSignalIngestor):
            def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
                return rows

        original_enabled = settings.trading_simulation_enabled
        original_run_id = settings.trading_simulation_run_id
        try:
            settings.trading_simulation_enabled = True
            settings.trading_simulation_run_id = "sim-current"
            ingestor = DuplicateEnvelopeIngestor(schema="envelope", table="torghut.ta_signals", url="http://example")
            signals = ingestor.fetch_signals_between(
                start=datetime(2026, 3, 6, 14, 50, tzinfo=timezone.utc),
                end=datetime(2026, 3, 6, 14, 51, tzinfo=timezone.utc),
            )
        finally:
            settings.trading_simulation_enabled = original_enabled
            settings.trading_simulation_run_id = original_run_id

        self.assertEqual(len(signals), 2)
        self.assertEqual(signals[0].event_ts, datetime(2026, 3, 6, 14, 50, tzinfo=timezone.utc))
        self.assertEqual(signals[0].seq, 100)
        self.assertEqual(signals[0].source, "ws")
        self.assertEqual(
            signals[0].payload.get("simulation_context", {}).get("simulation_run_id"),
            "sim-current",
        )
        self.assertEqual(signals[1].seq, 101)

    def test_fetch_signals_between_preserves_distinct_envelopes_sharing_timestamp(self) -> None:
        rows = [
            {
                "event_ts": "2026-03-06T14:50:00Z",
                "ingest_ts": "2026-03-08T01:33:32.461000Z",
                "symbol": "SIM-SPY",
                "payload": {
                    "rsi14": 30,
                    "simulation_context": {
                        "dataset_event_id": "evt-1",
                        "source_topic": "torghut.trades.v1",
                        "source_partition": 2,
                        "source_offset": 900,
                        "signal_seq": 100,
                    },
                },
                "seq": 100,
                "source": "ta",
                "window_size": "PT1S",
            },
            {
                "event_ts": "2026-03-06T14:50:00Z",
                "ingest_ts": "2026-03-06T14:51:00.316000Z",
                "symbol": "SIM-SPY",
                "payload": {
                    "rsi14": 31,
                    "simulation_context": {
                        "dataset_event_id": "evt-2",
                        "source_topic": "torghut.quotes.v1",
                        "source_partition": 5,
                        "source_offset": 1234,
                        "signal_seq": 200,
                    },
                },
                "seq": 200,
                "source": "ws",
                "window_size": "PT1S",
            },
        ]

        class DistinctEnvelopeIngestor(ClickHouseSignalIngestor):
            def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
                return rows

        ingestor = DistinctEnvelopeIngestor(schema="envelope", table="torghut.ta_signals", url="http://example")
        signals = ingestor.fetch_signals_between(
            start=datetime(2026, 3, 6, 14, 50, tzinfo=timezone.utc),
            end=datetime(2026, 3, 6, 14, 51, tzinfo=timezone.utc),
        )

        self.assertEqual(len(signals), 2)
        self.assertEqual([signal.seq for signal in signals], [100, 200])

    def test_fetch_signals_between_filters_disallowed_sources(self) -> None:
        rows = [
            {
                "event_ts": "2026-03-06T14:50:00Z",
                "ingest_ts": "2026-03-08T01:33:32.461000Z",
                "symbol": "AAPL",
                "payload": {"rsi14": 30},
                "seq": 100,
                "source": "ta",
                "window_size": "PT1S",
            },
            {
                "event_ts": "2026-03-06T14:50:00Z",
                "ingest_ts": "2026-03-06T14:51:00.316000Z",
                "symbol": "AAPL",
                "payload": {"rsi14": 30},
                "seq": 200,
                "source": "ws",
                "window_size": "PT1S",
            },
        ]

        class SourceFilteringIngestor(ClickHouseSignalIngestor):
            def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
                return rows

        original_allowed_sources = settings.trading_signal_allowed_sources_raw
        try:
            settings.trading_signal_allowed_sources_raw = "ws"
            ingestor = SourceFilteringIngestor(schema="envelope", table="torghut.ta_signals", url="http://example")
            signals = ingestor.fetch_signals_between(
                start=datetime(2026, 3, 6, 14, 50, tzinfo=timezone.utc),
                end=datetime(2026, 3, 6, 14, 51, tzinfo=timezone.utc),
            )
        finally:
            settings.trading_signal_allowed_sources_raw = original_allowed_sources

        self.assertEqual(len(signals), 1)
        self.assertEqual(signals[0].source, "ws")
        self.assertEqual(signals[0].symbol, "AAPL")

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
        self.assertIsNotNone(signals.signal_lag_seconds)
        self.assertGreater(signals.signal_lag_seconds, 0)

    def test_latest_signal_timestamp_uses_cache_within_ttl(self) -> None:
        latest = datetime(2026, 1, 1, tzinfo=timezone.utc)
        ingestor = FlakyLatestIngestor(
            schema="envelope",
            table="torghut.ta_signals",
            url="http://example",
            responses=[
                [{"latest_signal_ts": latest.isoformat()}],
                RuntimeError("unexpected refresh"),
            ],
        )

        first = ingestor._latest_signal_timestamp("event_ts")
        second = ingestor._latest_signal_timestamp("event_ts")

        self.assertEqual(first, latest)
        self.assertEqual(second, latest)

    def test_latest_signal_timestamp_prefers_descending_timestamp_probe_for_event_ts(self) -> None:
        latest = datetime(2026, 1, 1, tzinfo=timezone.utc)
        ingestor = MetadataLatestIngestor(
            schema="envelope",
            table="torghut.ta_signals",
            url="http://example",
            latest_signal_ts=latest,
        )

        resolved = ingestor._latest_signal_timestamp("event_ts")

        self.assertEqual(resolved, latest)
        self.assertGreaterEqual(len(ingestor.queries), 1)
        self.assertTrue(
            any(
                "ORDER BY event_ts DESC, symbol DESC, seq DESC" in query
                for query in ingestor.queries
            )
        )

    def test_latest_signal_timestamp_uses_cached_value_on_refresh_failure(self) -> None:
        latest = datetime(2026, 1, 1, tzinfo=timezone.utc)
        ingestor = FlakyLatestIngestor(
            schema="envelope",
            table="torghut.ta_signals",
            url="http://example",
            responses=[
                [{"latest_signal_ts": latest.isoformat()}],
                RuntimeError("system.parts unavailable"),
                RuntimeError("clickhouse unavailable"),
            ],
        )

        first = ingestor._latest_signal_timestamp("event_ts")
        ingestor._latest_signal_ts_checked_at = datetime.now(timezone.utc) - timedelta(seconds=31)
        second = ingestor._latest_signal_timestamp("event_ts")

        self.assertEqual(first, latest)
        self.assertEqual(second, latest)

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

    def test_fetch_signals_sorts_multi_symbol_batch_before_returning(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        rows = [
            {
                "event_ts": "2026-01-01T00:00:00Z",
                "symbol": "MSFT",
                "payload": {"feature_schema_version": "3.0.0"},
                "timeframe": "1Min",
                "seq": 2,
                "source": "ta",
            },
            {
                "event_ts": "2026-01-01T00:00:00Z",
                "symbol": "AAPL",
                "payload": {"feature_schema_version": "3.0.0"},
                "timeframe": "5Min",
                "seq": 3,
                "source": "ta",
            },
            {
                "event_ts": "2026-01-01T00:00:00Z",
                "symbol": "AAPL",
                "payload": {"feature_schema_version": "3.0.0"},
                "timeframe": "1Min",
                "seq": 1,
                "source": "ta",
            },
        ]

        class SortedCursorIngestor(ClickHouseSignalIngestor):
            def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
                _ = query
                return rows

        ingestor = SortedCursorIngestor(
            schema="envelope",
            table="torghut.ta_signals",
            url="http://example",
            fast_forward_stale_cursor=False,
        )

        with session_local() as session:
            batch = ingestor.fetch_signals(session)

        self.assertEqual(
            [(signal.symbol, signal.timeframe, signal.seq) for signal in batch.signals],
            [("AAPL", "1Min", 1), ("AAPL", "5Min", 3), ("MSFT", "1Min", 2)],
        )

    def test_simulation_cursor_keeps_later_symbols_with_lower_local_seq(self) -> None:
        rows = [
            {
                "event_ts": "2026-03-13T13:30:10Z",
                "symbol": "AAPL",
                "payload": {"feature_schema_version": "3.0.0"},
                "timeframe": "1Sec",
                "seq": 22888,
                "source": "ta",
            },
            {
                "event_ts": "2026-03-13T13:30:10Z",
                "symbol": "AMAT",
                "payload": {"feature_schema_version": "3.0.0"},
                "timeframe": "1Sec",
                "seq": 6651,
                "source": "ta",
            },
            {
                "event_ts": "2026-03-13T13:30:10Z",
                "symbol": "AMD",
                "payload": {"feature_schema_version": "3.0.0"},
                "timeframe": "1Sec",
                "seq": 18723,
                "source": "ta",
            },
            {
                "event_ts": "2026-03-13T13:30:10Z",
                "symbol": "AVGO",
                "payload": {"feature_schema_version": "3.0.0"},
                "timeframe": "1Sec",
                "seq": 22894,
                "source": "ta",
            },
        ]

        class CursorIngestor(ClickHouseSignalIngestor):
            def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
                _ = query
                return rows

        ingestor = CursorIngestor(
            schema="envelope",
            table="torghut.ta_signals",
            url="http://example",
            fast_forward_stale_cursor=False,
        )

        batch = ingestor._fetch_simulation_signals(
            cursor_at=datetime(2026, 3, 13, 13, 30, 10, tzinfo=timezone.utc),
            cursor_seq=22888,
            cursor_symbol="AAPL",
            latest_signal_at=datetime(2026, 3, 13, 13, 30, 20, tzinfo=timezone.utc),
            poll_started_at=datetime(2026, 3, 13, 13, 30, 11, tzinfo=timezone.utc),
            fast_forwarded=False,
        )

        self.assertEqual(
            [(signal.symbol, signal.seq) for signal in batch.signals],
            [("AMAT", 6651), ("AMD", 18723), ("AVGO", 22894)],
        )
        self.assertIsNone(batch.no_signal_reason)

    def test_simulation_fetch_query_is_cursor_ordered_limited_and_bounded(self) -> None:
        ingestor = SimulationWindowIngestor(
            schema='envelope',
            table='torghut.ta_signals',
            url='http://example',
            latest_signal_ts=datetime(2026, 3, 13, 13, 30, 20, tzinfo=timezone.utc),
            rows=[
                {
                    'event_ts': '2026-03-13T13:30:10Z',
                    'symbol': 'AVGO',
                    'payload': {'feature_schema_version': '3.0.0'},
                    'timeframe': '1Sec',
                    'seq': 22894,
                    'source': 'ta',
                },
            ],
            batch_size=64,
            fast_forward_stale_cursor=False,
        )

        batch = ingestor._fetch_simulation_signals(
            cursor_at=datetime(2026, 3, 13, 13, 30, 10, tzinfo=timezone.utc),
            cursor_seq=22888,
            cursor_symbol='AAPL',
            latest_signal_at=datetime(2026, 3, 13, 13, 30, 20, tzinfo=timezone.utc),
            poll_started_at=datetime(2026, 3, 13, 13, 30, 11, tzinfo=timezone.utc),
            fast_forwarded=False,
        )

        query = ingestor.queries[-1]
        self.assertIn('ORDER BY event_ts ASC, symbol ASC, seq ASC', query)
        self.assertIn('LIMIT 64', query)
        self.assertIn('event_ts <=', query)
        self.assertIn("symbol > 'AAPL' OR (symbol = 'AAPL' AND seq > 22888)", query)
        self.assertEqual([(signal.symbol, signal.seq) for signal in batch.signals], [('AVGO', 22894)])

    def test_simulation_fetch_query_keeps_equal_timestamp_without_tiebreakers(self) -> None:
        ingestor = SimulationWindowIngestor(
            schema='envelope',
            table='torghut.ta_signals',
            url='http://example',
            latest_signal_ts=datetime(2026, 3, 13, 13, 30, 20, tzinfo=timezone.utc),
            rows=[],
            batch_size=32,
            fast_forward_stale_cursor=False,
        )

        ingestor._fetch_simulation_signals(
            cursor_at=datetime(2026, 3, 13, 13, 30, 10, tzinfo=timezone.utc),
            cursor_seq=None,
            cursor_symbol=None,
            latest_signal_at=datetime(2026, 3, 13, 13, 30, 20, tzinfo=timezone.utc),
            poll_started_at=datetime(2026, 3, 13, 13, 30, 11, tzinfo=timezone.utc),
            fast_forwarded=False,
        )

        query = ingestor.queries[-1]
        self.assertIn('AND event_ts >= ', query)
        self.assertNotIn('AND (event_ts > ', query)

    def test_cursor_is_account_scoped(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        class CursorIngestor(ClickHouseSignalIngestor):
            def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
                return []

        ingestor_a = CursorIngestor(
            schema="envelope",
            table="torghut.ta_signals",
            url="http://example",
            account_label="paper-a",
            fast_forward_stale_cursor=False,
        )
        ingestor_b = CursorIngestor(
            schema="envelope",
            table="torghut.ta_signals",
            url="http://example",
            account_label="paper-b",
            fast_forward_stale_cursor=False,
        )

        with session_local() as session:
            ingestor_a._set_cursor(
                session,
                datetime(2026, 1, 1, 0, 0, 10, tzinfo=timezone.utc),
                10,
                "AAPL",
            )
            ingestor_b._set_cursor(
                session,
                datetime(2026, 1, 1, 0, 0, 20, tzinfo=timezone.utc),
                20,
                "MSFT",
            )
            rows = session.execute(select(TradeCursor).order_by(TradeCursor.account_label)).scalars().all()
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0].account_label, "paper-a")
            self.assertEqual(rows[0].cursor_seq, 10)
            self.assertEqual(rows[1].account_label, "paper-b")
            self.assertEqual(rows[1].cursor_seq, 20)

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
                if "latest_signal_ts" in query:
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
            self.assertIsNotNone(batch.signal_lag_seconds)
            self.assertGreater(batch.signal_lag_seconds, 0)

    def test_cursor_tail_held_when_no_progress_and_tail_reached(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        latest_signal = datetime(2026, 1, 1, 0, 10, 0, tzinfo=timezone.utc)
        cursor_time = latest_signal

        class CursorIngestor(ClickHouseSignalIngestor):
            def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
                if "latest_signal_ts" in query:
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
            self.assertIsNotNone(batch.signal_lag_seconds)
            self.assertGreater(batch.signal_lag_seconds, 0)

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

    def test_fetch_signals_between_dedupes_identical_flat_rows(self) -> None:
        base_ts = datetime(2026, 3, 13, 16, 34, 30, tzinfo=timezone.utc)
        rows = [
            {
                "ts": base_ts.isoformat(),
                "symbol": "META",
                "seq": 3545,
                "source": "ta",
                "macd": -0.0137,
                "macd_signal": 0.0135,
                "rsi14": 40.82,
                "price": 625.20,
            },
            {
                "ts": base_ts.isoformat(),
                "symbol": "META",
                "seq": 3545,
                "source": "ta",
                "macd": -0.0137,
                "macd_signal": 0.0135,
                "rsi14": 40.82,
                "price": 625.20,
            },
            {
                "ts": (base_ts + timedelta(seconds=1)).isoformat(),
                "symbol": "META",
                "seq": 3546,
                "source": "ta",
                "macd": -0.0101,
                "macd_signal": 0.0102,
                "rsi14": 41.10,
                "price": 625.50,
            },
        ]

        class FlatDuplicateIngestor(SchemaDiscoveringIngestor):
            def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
                if query.strip().startswith("SELECT name FROM system.columns"):
                    return super()._query_clickhouse(query)
                return rows

        ingestor = FlatDuplicateIngestor(
            schema="flat",
            table="torghut.ta_signals",
            url="http://example",
            columns={"ts", "symbol", "seq", "source", "macd", "macd_signal", "rsi14", "price"},
        )
        signals = ingestor.fetch_signals_between(
            start=base_ts,
            end=base_ts + timedelta(seconds=2),
            symbol="META",
        )

        self.assertEqual(len(signals), 2)
        self.assertEqual([signal.seq for signal in signals], [3545, 3546])

    def test_fetch_signals_between_rejects_invalid_symbol(self) -> None:
        ingestor = CapturingIngestor(schema="flat", table="torghut.ta_signals", url="http://example")
        signals = ingestor.fetch_signals_between(
            start=datetime(2026, 1, 1, tzinfo=timezone.utc),
            end=datetime(2026, 1, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL'; DROP",
        )
        self.assertEqual(signals, [])
        self.assertIsNone(ingestor.last_query)
