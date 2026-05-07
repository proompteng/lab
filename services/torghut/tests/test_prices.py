from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase
from unittest.mock import patch

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

    def _resolve_columns(self) -> set[str] | None:
        return None

    def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
        self.last_query = query
        return []


class SeqAwarePriceFetcher(CapturingPriceFetcher):
    def _resolve_columns(self) -> set[str] | None:
        return {"event_ts", "seq", "symbol"}


class FakeHTTPResponse:
    def __init__(self, status: int, payload: str) -> None:
        self.status = status
        self._payload = payload

    def read(self) -> bytes:
        return self._payload.encode("utf-8")


class CapturingHTTPConnection:
    instances: list[CapturingHTTPConnection] = []
    response = FakeHTTPResponse(200, '{"c": "123.45"}\n')

    def __init__(self, host: str, port: int | None, timeout: float) -> None:
        self.host = host
        self.port = port
        self.timeout = timeout
        self.requests: list[tuple[str, str, dict[str, str]]] = []
        self.closed = False
        self.__class__.instances.append(self)

    def request(self, method: str, path: str, *, headers: dict[str, str]) -> None:
        self.requests.append((method, path, dict(headers)))

    def getresponse(self) -> FakeHTTPResponse:
        return self.response

    def close(self) -> None:
        self.closed = True


class TestClickHousePriceFetcher(TestCase):
    def setUp(self) -> None:
        CapturingHTTPConnection.instances = []
        CapturingHTTPConnection.response = FakeHTTPResponse(200, '{"c": "123.45"}\n')

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

    def test_fetch_price_orders_by_seq_when_available(self) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={},
        )
        fetcher = SeqAwarePriceFetcher()
        fetcher.fetch_price(signal)
        assert fetcher.last_query is not None
        self.assertIn("ORDER BY event_ts DESC, seq DESC", fetcher.last_query)

    def test_query_clickhouse_sends_http_request_with_auth_headers(self) -> None:
        fetcher = ClickHousePriceFetcher(
            url="http://clickhouse.example",
            username="reader",
            password="secret",
            table="torghut.ta_microbars",
        )
        CapturingHTTPConnection.response = FakeHTTPResponse(
            200,
            '{"c": "123.45"}\n\n{"vwap": "122.10"}\nnot-json\n',
        )

        with patch("app.trading.prices.HTTPConnection", CapturingHTTPConnection):
            rows = fetcher._query_clickhouse("SELECT 1")

        self.assertEqual(rows, [{"c": "123.45"}, {"vwap": "122.10"}])
        self.assertEqual(len(CapturingHTTPConnection.instances), 1)
        connection = CapturingHTTPConnection.instances[0]
        self.assertEqual(connection.host, "clickhouse.example")
        self.assertIsNone(connection.port)
        self.assertTrue(connection.closed)
        self.assertEqual(len(connection.requests), 1)
        method, path, headers = connection.requests[0]
        self.assertEqual(method, "GET")
        self.assertEqual(path, "/?query=SELECT+1")
        self.assertEqual(headers["Content-Type"], "text/plain")
        self.assertEqual(headers["X-ClickHouse-User"], "reader")
        self.assertEqual(headers["X-ClickHouse-Key"], "secret")

    def test_query_clickhouse_raises_for_non_success_status(self) -> None:
        fetcher = ClickHousePriceFetcher(
            url="http://clickhouse.example",
            table="torghut.ta_microbars",
        )
        CapturingHTTPConnection.response = FakeHTTPResponse(503, "temporarily down")

        with patch("app.trading.prices.HTTPConnection", CapturingHTTPConnection):
            with self.assertRaisesRegex(
                RuntimeError, "clickhouse_http_503:temporarily down"
            ):
                fetcher._query_clickhouse("SELECT 1")

        self.assertTrue(CapturingHTTPConnection.instances[0].closed)

    def test_query_clickhouse_rejects_unsupported_url_scheme(self) -> None:
        fetcher = ClickHousePriceFetcher(
            url="ftp://clickhouse.example",
            table="torghut.ta_microbars",
        )

        with self.assertRaisesRegex(
            RuntimeError, "unsupported_clickhouse_url_scheme:ftp"
        ):
            fetcher._query_clickhouse("SELECT 1")

    def test_query_clickhouse_rejects_missing_url_host(self) -> None:
        fetcher = ClickHousePriceFetcher(
            url="http://",
            table="torghut.ta_microbars",
        )

        with self.assertRaisesRegex(RuntimeError, "invalid_clickhouse_url_host"):
            fetcher._query_clickhouse("SELECT 1")

    def test_rejects_invalid_price_table_identifier(self) -> None:
        with self.assertRaisesRegex(ValueError, "invalid_table_identifier:bad-table"):
            ClickHousePriceFetcher(
                url="http://clickhouse.example",
                table="torghut.bad-table",
            )
