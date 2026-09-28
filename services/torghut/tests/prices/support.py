from __future__ import annotations


from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase
from unittest.mock import patch

from app.trading.models import SignalEnvelope
from app.trading.prices import (
    ClickHousePriceFetcher,
    _midpoint,
    _quote_row_reject_reason,
    _quote_spread_bps,
)


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


class _TestClickHousePriceFetcherBase(TestCase):
    def setUp(self) -> None:
        CapturingHTTPConnection.instances = []
        CapturingHTTPConnection.response = FakeHTTPResponse(200, '{"c": "123.45"}\n')


__all__: tuple[str, ...] = (
    "CapturingHTTPConnection",
    "CapturingPriceFetcher",
    "ClickHousePriceFetcher",
    "Decimal",
    "FakeClickHousePriceFetcher",
    "FakeHTTPResponse",
    "RoutingClickHousePriceFetcher",
    "SeqAwarePriceFetcher",
    "SignalEnvelope",
    "TestCase",
    "_TestClickHousePriceFetcherBase",
    "_midpoint",
    "_quote_row_reject_reason",
    "_quote_spread_bps",
    "datetime",
    "patch",
    "timezone",
)
