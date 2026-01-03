from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.models import SignalEnvelope
from app.trading.prices import ClickHousePriceFetcher


class FakeClickHousePriceFetcher(ClickHousePriceFetcher):
    def __init__(self, rows: list[dict[str, object]]) -> None:
        super().__init__(url="http://example", table="torghut.ta_microbars")
        self._rows = rows

    def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
        return self._rows


class CapturingPriceFetcher(ClickHousePriceFetcher):
    def __init__(self) -> None:
        super().__init__(url="http://example", table="torghut.ta_microbars")
        self.last_query: str | None = None

    def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
        self.last_query = query
        return []


class TestClickHousePriceFetcher(TestCase):
    def test_fetch_price_prefers_close_c(self) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={},
        )
        fetcher = FakeClickHousePriceFetcher(
            [{"event_ts": "2026-01-01T00:00:00Z", "c": "101.25", "vwap": "99.9"}]
        )
        price = fetcher.fetch_price(signal)
        self.assertEqual(price, Decimal("101.25"))

    def test_fetch_market_snapshot_prefers_close_c(self) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={},
        )
        fetcher = FakeClickHousePriceFetcher(
            [{"event_ts": "2026-01-01T00:00:00Z", "c": 102.5, "price": 100}]
        )
        snapshot = fetcher.fetch_market_snapshot(signal)
        self.assertIsNotNone(snapshot)
        assert snapshot is not None
        self.assertEqual(snapshot.price, Decimal("102.5"))

    def test_fetch_price_query_uses_schema_columns(self) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 12, 0, 1, 123000, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={},
        )
        fetcher = CapturingPriceFetcher()
        fetcher.fetch_price(signal)
        assert fetcher.last_query is not None
        self.assertIn("SELECT event_ts, c, vwap", fetcher.last_query)
        self.assertNotIn("close", fetcher.last_query)
        self.assertNotIn("price", fetcher.last_query)
        self.assertNotIn("spread", fetcher.last_query)
        self.assertIn("toDateTime64", fetcher.last_query)

    def test_fetch_price_rejects_invalid_symbol(self) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL; DROP TABLE",
            payload={},
        )
        fetcher = CapturingPriceFetcher()
        price = fetcher.fetch_price(signal)
        self.assertIsNone(price)
        self.assertIsNone(fetcher.last_query)
