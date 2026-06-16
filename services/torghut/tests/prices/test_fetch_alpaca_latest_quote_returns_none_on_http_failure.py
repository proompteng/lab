from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.prices.support import (
    CapturingHTTPConnection,
    CapturingPriceFetcher,
    ClickHousePriceFetcher,
    FakeHTTPResponse,
    SeqAwarePriceFetcher,
    SignalEnvelope,
    _TestClickHousePriceFetcherBase,
    datetime,
    patch,
    timezone,
)


class TestFetchAlpacaLatestQuoteReturnsNoneOnHttpFailure(
    _TestClickHousePriceFetcherBase
):
    def test_fetch_alpaca_latest_quote_returns_none_on_http_failure(self) -> None:
        fetcher = ClickHousePriceFetcher(
            url="http://clickhouse.example",
            table="torghut.ta_microbars",
            alpaca_quote_fallback_enabled=True,
            alpaca_data_api_base_url="https://data.example",
            alpaca_api_key_id="key",
            alpaca_api_secret_key="secret",
        )
        CapturingHTTPConnection.response = FakeHTTPResponse(403, "forbidden")

        with patch("app.trading.prices.HTTPSConnection", CapturingHTTPConnection):
            quote = fetcher._fetch_alpaca_latest_quote(symbol="AAPL")

        self.assertIsNone(quote)
        self.assertTrue(CapturingHTTPConnection.instances[0].closed)

    def test_fetch_alpaca_latest_quote_returns_none_on_invalid_json(self) -> None:
        fetcher = ClickHousePriceFetcher(
            url="http://clickhouse.example",
            table="torghut.ta_microbars",
            alpaca_quote_fallback_enabled=True,
            alpaca_data_api_base_url="https://data.example",
            alpaca_api_key_id="key",
            alpaca_api_secret_key="secret",
        )
        CapturingHTTPConnection.response = FakeHTTPResponse(200, "not-json")

        with patch("app.trading.prices.HTTPSConnection", CapturingHTTPConnection):
            quote = fetcher._fetch_alpaca_latest_quote(symbol="AAPL")

        self.assertIsNone(quote)

    def test_fetch_alpaca_latest_quote_returns_none_without_quote_object(self) -> None:
        fetcher = ClickHousePriceFetcher(
            url="http://clickhouse.example",
            table="torghut.ta_microbars",
            alpaca_quote_fallback_enabled=True,
            alpaca_data_api_base_url="https://data.example",
            alpaca_api_key_id="key",
            alpaca_api_secret_key="secret",
        )
        CapturingHTTPConnection.response = FakeHTTPResponse(200, '{"quote": null}')

        with patch("app.trading.prices.HTTPSConnection", CapturingHTTPConnection):
            quote = fetcher._fetch_alpaca_latest_quote(symbol="AAPL")

        self.assertIsNone(quote)

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
