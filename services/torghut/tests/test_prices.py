from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase
from unittest.mock import patch

from app.trading.models import SignalEnvelope
from app.trading.prices import ClickHousePriceFetcher, _midpoint, _quote_spread_bps


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


class RoutingClickHousePriceFetcher(ClickHousePriceFetcher):
    def __init__(
        self,
        *,
        price_rows: list[dict[str, object]],
        quote_rows: list[dict[str, object]],
        fail_quote_query: bool = False,
        quote_forward_seconds: int = 0,
        alpaca_quote: dict[str, object] | None = None,
        alpaca_quote_fallback_enabled: bool | None = None,
        alpaca_quote_fallback_market_session_required: bool = False,
        alpaca_quote_fallback_backoff_seconds: int = 60,
    ) -> None:
        alpaca_credentials_enabled = (
            alpaca_quote is not None or alpaca_quote_fallback_enabled is True
        )
        super().__init__(
            url="http://example",
            table="torghut.ta_microbars",
            quote_table="torghut.ta_signals",
            quote_lookback_seconds=60,
            quote_forward_seconds=quote_forward_seconds,
            alpaca_quote_fallback_enabled=(
                alpaca_quote is not None
                if alpaca_quote_fallback_enabled is None
                else alpaca_quote_fallback_enabled
            ),
            alpaca_data_api_base_url="https://data.example",
            alpaca_api_key_id="key" if alpaca_credentials_enabled else None,
            alpaca_api_secret_key="secret" if alpaca_credentials_enabled else None,
            alpaca_quote_max_age_seconds=120,
            alpaca_quote_fallback_market_session_required=(
                alpaca_quote_fallback_market_session_required
            ),
            alpaca_quote_fallback_backoff_seconds=(
                alpaca_quote_fallback_backoff_seconds
            ),
        )
        self.price_rows = price_rows
        self.quote_rows = quote_rows
        self.fail_quote_query = fail_quote_query
        self.alpaca_quote = alpaca_quote
        self.alpaca_quote_calls = 0
        self.queries: list[str] = []

    def _resolve_columns(self) -> set[str] | None:
        return None

    def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
        self.queries.append(query)
        if "FROM torghut.ta_signals" in query:
            if self.fail_quote_query:
                raise RuntimeError("quote query failed")
            return self.quote_rows
        return self.price_rows

    def _fetch_alpaca_latest_quote(self, *, symbol: str) -> dict[str, object] | None:
        _ = symbol
        self.alpaca_quote_calls += 1
        return self.alpaca_quote


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

    def test_fetch_market_snapshot_backfills_recent_executable_quote(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 12, 0, 30, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={},
        )
        fetcher = RoutingClickHousePriceFetcher(
            price_rows=[
                {"event_ts": "2026-01-01T12:00:29Z", "c": "125.75", "vwap": "125.70"}
            ],
            quote_rows=[
                {
                    "event_ts": "2026-01-01T12:00:28Z",
                    "imbalance_bid_px": "125.70",
                    "imbalance_ask_px": "125.80",
                    "imbalance_spread": "0.10",
                }
            ],
        )

        snapshot = fetcher.fetch_market_snapshot(signal)

        self.assertIsNotNone(snapshot)
        assert snapshot is not None
        self.assertEqual(snapshot.price, Decimal("125.75"))
        self.assertEqual(snapshot.bid, Decimal("125.70"))
        self.assertEqual(snapshot.ask, Decimal("125.80"))
        self.assertEqual(snapshot.spread, Decimal("0.10"))
        self.assertEqual(snapshot.source, "ta_microbars+ta_signals_quote")
        self.assertEqual(len(fetcher.queries), 2)
        self.assertIn("FROM torghut.ta_signals", fetcher.queries[1])
        self.assertIn("imbalance_bid_px IS NOT NULL", fetcher.queries[1])
        self.assertIn("imbalance_ask_px >= imbalance_bid_px", fetcher.queries[1])

    def test_fetch_market_snapshot_uses_recent_quote_midpoint_without_price_row(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 12, 0, 30, tzinfo=timezone.utc),
            symbol="NVDA",
            payload={},
        )
        fetcher = RoutingClickHousePriceFetcher(
            price_rows=[],
            quote_rows=[
                {
                    "event_ts": "2026-01-01T12:00:28Z",
                    "imbalance_bid_px": "200.10",
                    "imbalance_ask_px": "200.30",
                }
            ],
        )

        snapshot = fetcher.fetch_market_snapshot(signal)

        self.assertIsNotNone(snapshot)
        assert snapshot is not None
        self.assertEqual(snapshot.price, Decimal("200.20"))
        self.assertEqual(snapshot.spread, Decimal("0.20"))
        self.assertEqual(snapshot.source, "ta_signals_quote")

    def test_fetch_market_snapshot_can_use_runtime_forward_quote_window(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 12, 0, 30, tzinfo=timezone.utc),
            symbol="NVDA",
            payload={},
        )
        fetcher = RoutingClickHousePriceFetcher(
            price_rows=[],
            quote_rows=[
                {
                    "event_ts": "2026-01-01T12:00:45Z",
                    "imbalance_bid_px": "200.10",
                    "imbalance_ask_px": "200.30",
                }
            ],
            quote_forward_seconds=30,
        )

        snapshot = fetcher.fetch_market_snapshot(signal)

        self.assertIsNotNone(snapshot)
        assert snapshot is not None
        self.assertEqual(snapshot.price, Decimal("200.20"))
        self.assertEqual(snapshot.bid, Decimal("200.10"))
        self.assertEqual(snapshot.ask, Decimal("200.30"))
        self.assertEqual(
            snapshot.as_of, datetime(2026, 1, 1, 12, 0, 45, tzinfo=timezone.utc)
        )
        self.assertEqual(snapshot.source, "ta_signals_quote")
        self.assertIn(
            "event_ts <= toDateTime64('2026-01-01 12:01:00", fetcher.queries[1]
        )

    def test_fetch_market_snapshot_returns_none_without_price_or_quote(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 12, 0, 30, tzinfo=timezone.utc),
            symbol="NVDA",
            payload={},
        )
        fetcher = RoutingClickHousePriceFetcher(price_rows=[], quote_rows=[])

        snapshot = fetcher.fetch_market_snapshot(signal)

        self.assertIsNone(snapshot)

    def test_fetch_market_snapshot_uses_alpaca_latest_quote_when_signal_quote_missing(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 12, 0, 30, tzinfo=timezone.utc),
            symbol="AMZN",
            payload={},
        )
        quote_ts = datetime.now(timezone.utc)
        fetcher = RoutingClickHousePriceFetcher(
            price_rows=[],
            quote_rows=[],
            alpaca_quote={
                "t": quote_ts.isoformat(),
                "bp": "185.10",
                "ap": "185.14",
            },
        )

        snapshot = fetcher.fetch_market_snapshot(signal)

        self.assertIsNotNone(snapshot)
        assert snapshot is not None
        self.assertEqual(snapshot.price, Decimal("185.12"))
        self.assertEqual(snapshot.bid, Decimal("185.10"))
        self.assertEqual(snapshot.ask, Decimal("185.14"))
        self.assertEqual(snapshot.spread, Decimal("0.04"))
        self.assertEqual(snapshot.as_of, quote_ts)
        self.assertEqual(snapshot.source, "alpaca_latest_quote")

    def test_fetch_market_snapshot_rejects_wide_alpaca_latest_quote(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 12, 0, 30, tzinfo=timezone.utc),
            symbol="AMZN",
            payload={},
        )
        fetcher = RoutingClickHousePriceFetcher(
            price_rows=[],
            quote_rows=[],
            alpaca_quote={
                "t": datetime.now(timezone.utc).isoformat(),
                "bp": "100.00",
                "ap": "101.00",
            },
        )

        snapshot = fetcher.fetch_market_snapshot(signal)

        self.assertIsNone(snapshot)

    def test_fetch_market_snapshot_disables_alpaca_latest_quote_without_credentials(
        self,
    ) -> None:
        fetcher = ClickHousePriceFetcher(
            url="http://example",
            table="torghut.ta_microbars",
            alpaca_quote_fallback_enabled=True,
        )
        fetcher.alpaca_api_key_id = None
        fetcher.alpaca_api_secret_key = None

        quote = fetcher._fetch_alpaca_latest_quote_row(symbol="AMZN")

        self.assertIsNone(quote)

    def test_fetch_market_snapshot_backs_off_missing_alpaca_credentials(
        self,
    ) -> None:
        fetcher = ClickHousePriceFetcher(
            url="http://example",
            table="torghut.ta_microbars",
            alpaca_quote_fallback_enabled=True,
            alpaca_quote_fallback_backoff_seconds=60,
        )
        fetcher.alpaca_api_key_id = None
        fetcher.alpaca_api_secret_key = None

        quote = fetcher._fetch_alpaca_latest_quote_row(symbol="AMZN")

        self.assertIsNone(quote)
        self.assertTrue(fetcher._alpaca_quote_fallback_backoff_active(symbol="AMZN"))

    def test_fetch_market_snapshot_ignores_empty_alpaca_latest_quote(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 12, 0, 30, tzinfo=timezone.utc),
            symbol="AMZN",
            payload={},
        )
        fetcher = RoutingClickHousePriceFetcher(
            price_rows=[],
            quote_rows=[],
            alpaca_quote=None,
            alpaca_quote_fallback_enabled=True,
        )

        snapshot = fetcher.fetch_market_snapshot(signal)

        self.assertIsNone(snapshot)
        self.assertEqual(fetcher.alpaca_quote_calls, 1)

    def test_fetch_market_snapshot_backs_off_empty_alpaca_latest_quote(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 12, 0, 30, tzinfo=timezone.utc),
            symbol="AMZN",
            payload={},
        )
        fetcher = RoutingClickHousePriceFetcher(
            price_rows=[],
            quote_rows=[],
            alpaca_quote=None,
            alpaca_quote_fallback_enabled=True,
            alpaca_quote_fallback_backoff_seconds=60,
        )

        self.assertIsNone(fetcher.fetch_market_snapshot(signal))
        self.assertIsNone(fetcher.fetch_market_snapshot(signal))

        self.assertEqual(fetcher.alpaca_quote_calls, 1)

    def test_fetch_market_snapshot_skips_alpaca_latest_quote_when_market_closed(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 12, 0, 30, tzinfo=timezone.utc),
            symbol="AMZN",
            payload={},
        )
        fetcher = RoutingClickHousePriceFetcher(
            price_rows=[],
            quote_rows=[],
            alpaca_quote={
                "t": datetime.now(timezone.utc).isoformat(),
                "bp": "185.10",
                "ap": "185.14",
            },
            alpaca_quote_fallback_market_session_required=True,
        )

        with patch("app.trading.prices.market_session_is_open", return_value=False):
            snapshot = fetcher.fetch_market_snapshot(signal)

        self.assertIsNone(snapshot)
        self.assertEqual(fetcher.alpaca_quote_calls, 0)

    def test_fetch_market_snapshot_reuses_active_market_closed_backoff(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 12, 0, 30, tzinfo=timezone.utc),
            symbol="AMZN",
            payload={},
        )
        fetcher = RoutingClickHousePriceFetcher(
            price_rows=[],
            quote_rows=[],
            alpaca_quote={
                "t": datetime.now(timezone.utc).isoformat(),
                "bp": "185.10",
                "ap": "185.14",
            },
            alpaca_quote_fallback_market_session_required=True,
        )

        with patch("app.trading.prices.market_session_is_open", return_value=False):
            self.assertIsNone(fetcher.fetch_market_snapshot(signal))
            self.assertIsNone(fetcher.fetch_market_snapshot(signal))

        self.assertEqual(fetcher.alpaca_quote_calls, 0)
        self.assertTrue(fetcher._alpaca_quote_fallback_backoff_active(symbol="AMZN"))

    def test_fetch_market_snapshot_rejects_invalid_alpaca_latest_quote(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 12, 0, 30, tzinfo=timezone.utc),
            symbol="AMZN",
            payload={},
        )
        fetcher = RoutingClickHousePriceFetcher(
            price_rows=[],
            quote_rows=[],
            alpaca_quote={
                "t": datetime.now(timezone.utc).isoformat(),
                "bp": "185.14",
                "ap": "185.10",
            },
        )

        snapshot = fetcher.fetch_market_snapshot(signal)

        self.assertIsNone(snapshot)

    def test_fetch_market_snapshot_rejects_invalid_alpaca_quote_spread(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 12, 0, 30, tzinfo=timezone.utc),
            symbol="AMZN",
            payload={},
        )
        fetcher = RoutingClickHousePriceFetcher(
            price_rows=[],
            quote_rows=[],
            alpaca_quote={
                "t": datetime.now(timezone.utc).isoformat(),
                "bp": "185.10",
                "ap": "185.14",
            },
        )

        with patch("app.trading.prices._quote_spread_bps", return_value=None):
            snapshot = fetcher.fetch_market_snapshot(signal)

        self.assertIsNone(snapshot)
        self.assertTrue(fetcher._alpaca_quote_fallback_backoff_active(symbol="AMZN"))

    def test_alpaca_quote_fallback_backoff_expires_and_can_be_disabled(
        self,
    ) -> None:
        fetcher = RoutingClickHousePriceFetcher(
            price_rows=[],
            quote_rows=[],
            alpaca_quote=None,
            alpaca_quote_fallback_enabled=True,
            alpaca_quote_fallback_backoff_seconds=60,
        )
        fetcher._alpaca_quote_fallback_backoff["AMZN"] = (0.0, "expired")

        self.assertFalse(fetcher._alpaca_quote_fallback_backoff_active(symbol="AMZN"))
        self.assertNotIn("AMZN", fetcher._alpaca_quote_fallback_backoff)

        disabled_fetcher = RoutingClickHousePriceFetcher(
            price_rows=[],
            quote_rows=[],
            alpaca_quote=None,
            alpaca_quote_fallback_enabled=True,
            alpaca_quote_fallback_backoff_seconds=0,
        )
        disabled_fetcher._backoff_alpaca_quote_fallback(
            symbol="AMZN",
            reason="quote_unavailable",
        )

        self.assertNotIn("AMZN", disabled_fetcher._alpaca_quote_fallback_backoff)

    def test_alpaca_quote_fallback_backoff_refreshes_active_entry_quietly(
        self,
    ) -> None:
        fetcher = RoutingClickHousePriceFetcher(
            price_rows=[],
            quote_rows=[],
            alpaca_quote=None,
            alpaca_quote_fallback_enabled=True,
            alpaca_quote_fallback_backoff_seconds=60,
        )

        fetcher._backoff_alpaca_quote_fallback(
            symbol="AMZN",
            reason="quote_unavailable",
        )
        first_expires_at, _first_reason = fetcher._alpaca_quote_fallback_backoff["AMZN"]
        fetcher._backoff_alpaca_quote_fallback(
            symbol="AMZN",
            reason="wide_quote",
        )
        second_expires_at, second_reason = fetcher._alpaca_quote_fallback_backoff[
            "AMZN"
        ]

        self.assertGreaterEqual(second_expires_at, first_expires_at)
        self.assertEqual(second_reason, "wide_quote")

    def test_fetch_market_snapshot_rejects_alpaca_latest_quote_without_timestamp(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 12, 0, 30, tzinfo=timezone.utc),
            symbol="AMZN",
            payload={},
        )
        fetcher = RoutingClickHousePriceFetcher(
            price_rows=[],
            quote_rows=[],
            alpaca_quote={
                "bp": "185.10",
                "ap": "185.14",
            },
        )

        snapshot = fetcher.fetch_market_snapshot(signal)

        self.assertIsNone(snapshot)

    def test_fetch_market_snapshot_accepts_naive_alpaca_latest_quote_timestamp(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 12, 0, 30, tzinfo=timezone.utc),
            symbol="AMZN",
            payload={},
        )
        quote_ts = datetime.now(timezone.utc).replace(tzinfo=None)
        fetcher = RoutingClickHousePriceFetcher(
            price_rows=[],
            quote_rows=[],
            alpaca_quote={
                "timestamp": quote_ts.isoformat(),
                "bid_price": "185.10",
                "ask_price": "185.14",
            },
        )

        snapshot = fetcher.fetch_market_snapshot(signal)

        self.assertIsNotNone(snapshot)
        assert snapshot is not None
        self.assertEqual(snapshot.as_of, quote_ts.replace(tzinfo=timezone.utc))

    def test_fetch_market_snapshot_rejects_stale_alpaca_latest_quote(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 12, 0, 30, tzinfo=timezone.utc),
            symbol="AMZN",
            payload={},
        )
        fetcher = RoutingClickHousePriceFetcher(
            price_rows=[],
            quote_rows=[],
            alpaca_quote={
                "t": "2020-01-01T00:00:00Z",
                "bp": "185.10",
                "ap": "185.14",
            },
        )

        snapshot = fetcher.fetch_market_snapshot(signal)

        self.assertIsNone(snapshot)

    def test_fetch_market_snapshot_keeps_price_when_quote_lookup_empty(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 12, 0, 30, tzinfo=timezone.utc),
            symbol="NVDA",
            payload={},
        )
        fetcher = RoutingClickHousePriceFetcher(
            price_rows=[
                {"event_ts": "2026-01-01T12:00:29Z", "c": "200.25", "spread": "0.03"}
            ],
            quote_rows=[],
        )

        snapshot = fetcher.fetch_market_snapshot(signal)

        self.assertIsNotNone(snapshot)
        assert snapshot is not None
        self.assertEqual(snapshot.price, Decimal("200.25"))
        self.assertEqual(snapshot.spread, Decimal("0.03"))
        self.assertEqual(snapshot.source, "ta_microbars")

    def test_fetch_market_snapshot_keeps_price_when_quote_lookup_fails(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 12, 0, 30, tzinfo=timezone.utc),
            symbol="NVDA",
            payload={},
        )
        fetcher = RoutingClickHousePriceFetcher(
            price_rows=[{"event_ts": "2026-01-01T12:00:29Z", "c": "200.25"}],
            quote_rows=[],
            fail_quote_query=True,
        )

        snapshot = fetcher.fetch_market_snapshot(signal)

        self.assertIsNotNone(snapshot)
        assert snapshot is not None
        self.assertEqual(snapshot.price, Decimal("200.25"))
        self.assertEqual(snapshot.source, "ta_microbars")

    def test_fetch_market_snapshot_prefers_explicit_quote_spread(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 12, 0, 30, tzinfo=timezone.utc),
            symbol="NVDA",
            payload={},
        )
        fetcher = RoutingClickHousePriceFetcher(
            price_rows=[],
            quote_rows=[
                {
                    "event_ts": "2026-01-01T12:00:28Z",
                    "imbalance_bid_px": "200.10",
                    "imbalance_ask_px": "200.30",
                    "spread": "0.01",
                    "imbalance_spread": "0.20",
                }
            ],
        )

        snapshot = fetcher.fetch_market_snapshot(signal)

        self.assertIsNotNone(snapshot)
        assert snapshot is not None
        self.assertEqual(snapshot.spread, Decimal("0.01"))

    def test_quote_midpoint_requires_complete_quote(self) -> None:
        self.assertIsNone(_midpoint(bid=None, ask=Decimal("100.20")))

    def test_quote_spread_bps_rejects_zero_midpoint(self) -> None:
        self.assertIsNone(_quote_spread_bps(bid=Decimal("0"), ask=Decimal("0")))

    def test_fetch_alpaca_latest_quote_sends_data_api_request(self) -> None:
        fetcher = ClickHousePriceFetcher(
            url="http://clickhouse.example",
            table="torghut.ta_microbars",
            alpaca_quote_fallback_enabled=True,
            alpaca_data_api_base_url="https://data.example:8443",
            alpaca_api_key_id="key",
            alpaca_api_secret_key="secret",
            alpaca_quote_feed="iex",
            alpaca_quote_timeout_seconds=1.5,
        )
        CapturingHTTPConnection.response = FakeHTTPResponse(
            200,
            '{"quote": {"t": "2026-01-01T00:00:00Z", "bp": "100.10", "ap": "100.20"}}',
        )

        with patch("app.trading.prices.HTTPSConnection", CapturingHTTPConnection):
            quote = fetcher._fetch_alpaca_latest_quote(symbol="AAPL")

        self.assertEqual(
            quote,
            {"t": "2026-01-01T00:00:00Z", "bp": "100.10", "ap": "100.20"},
        )
        self.assertEqual(len(CapturingHTTPConnection.instances), 1)
        connection = CapturingHTTPConnection.instances[0]
        self.assertEqual(connection.host, "data.example")
        self.assertEqual(connection.port, 8443)
        self.assertEqual(connection.timeout, 1.5)
        self.assertTrue(connection.closed)
        self.assertEqual(len(connection.requests), 1)
        method, path, headers = connection.requests[0]
        self.assertEqual(method, "GET")
        self.assertEqual(path, "/v2/stocks/AAPL/quotes/latest?feed=iex")
        self.assertEqual(headers["APCA-API-KEY-ID"], "key")
        self.assertEqual(headers["APCA-API-SECRET-KEY"], "secret")

    def test_fetch_alpaca_latest_quote_rejects_bad_url(self) -> None:
        fetcher = ClickHousePriceFetcher(
            url="http://clickhouse.example",
            table="torghut.ta_microbars",
            alpaca_quote_fallback_enabled=True,
            alpaca_data_api_base_url="ftp://data.example",
            alpaca_api_key_id="key",
            alpaca_api_secret_key="secret",
        )

        self.assertIsNone(fetcher._fetch_alpaca_latest_quote(symbol="AAPL"))

    def test_fetch_alpaca_latest_quote_rejects_missing_host(self) -> None:
        fetcher = ClickHousePriceFetcher(
            url="http://clickhouse.example",
            table="torghut.ta_microbars",
            alpaca_quote_fallback_enabled=True,
            alpaca_data_api_base_url="https://",
            alpaca_api_key_id="key",
            alpaca_api_secret_key="secret",
        )

        self.assertIsNone(fetcher._fetch_alpaca_latest_quote(symbol="AAPL"))

    def test_fetch_alpaca_latest_quote_returns_none_on_request_failure(
        self,
    ) -> None:
        class FailingHTTPConnection(CapturingHTTPConnection):
            def request(
                self, method: str, path: str, *, headers: dict[str, str]
            ) -> None:
                super().request(method, path, headers=headers)
                raise TimeoutError("timeout")

        fetcher = ClickHousePriceFetcher(
            url="http://clickhouse.example",
            table="torghut.ta_microbars",
            alpaca_quote_fallback_enabled=True,
            alpaca_data_api_base_url="https://data.example",
            alpaca_api_key_id="key",
            alpaca_api_secret_key="secret",
        )

        with patch("app.trading.prices.HTTPSConnection", FailingHTTPConnection):
            quote = fetcher._fetch_alpaca_latest_quote(symbol="AAPL")

        self.assertIsNone(quote)
        self.assertTrue(FailingHTTPConnection.instances[0].closed)

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
