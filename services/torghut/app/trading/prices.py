"""Price lookup helpers for trading decisions."""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from http.client import HTTPConnection, HTTPSConnection
from time import monotonic
from typing import Any, Optional, cast
from urllib.parse import SplitResult, urlencode, urlsplit

from ..config import settings
from .clickhouse import normalize_symbol, to_datetime64
from .market_session import market_session_is_open
from .models import SignalEnvelope
from .prices_helpers import (
    midpoint,
    optional_decimal,
    parse_ts,
    qualified_table_name,
    quote_literal,
    quote_spread_bps,
    quote_spread_bps_sql,
    quote_spread_reject_reason,
    select_price,
    select_quote_spread,
    snapshot_as_of,
    split_table,
)

logger = logging.getLogger(__name__)

_midpoint = midpoint
_quote_spread_bps = quote_spread_bps


@dataclass
class MarketSnapshot:
    symbol: str
    as_of: datetime
    price: Optional[Decimal]
    spread: Optional[Decimal]
    source: str
    bid: Optional[Decimal] = None
    ask: Optional[Decimal] = None
    quote_as_of: Optional[datetime] = None
    quote_source: Optional[str] = None
    quote_lookup_diagnostics: Optional[dict[str, object]] = None


@dataclass(frozen=True)
class _ResolvedQuoteRow:
    row: dict[str, Any] | None
    source: str
    diagnostics: dict[str, object] | None


_CLICKHOUSE_PRICE_FETCHER_OPTION_NAMES: tuple[str, ...] = (
    "url",
    "username",
    "password",
    "table",
    "quote_table",
    "lookback_minutes",
    "quote_lookback_seconds",
    "quote_forward_seconds",
    "alpaca_quote_fallback_enabled",
    "alpaca_data_api_base_url",
    "alpaca_api_key_id",
    "alpaca_api_secret_key",
    "alpaca_quote_feed",
    "alpaca_quote_timeout_seconds",
    "alpaca_quote_max_age_seconds",
    "alpaca_quote_fallback_market_session_required",
    "alpaca_quote_fallback_backoff_seconds",
)


def _price_fetcher_options_from_args(
    args: tuple[Any, ...],
    overrides: Mapping[str, Any],
) -> dict[str, Any]:
    if len(args) > len(_CLICKHOUSE_PRICE_FETCHER_OPTION_NAMES):
        raise TypeError("too many positional arguments for ClickHousePriceFetcher")
    options = dict(overrides)
    for name, value in zip(_CLICKHOUSE_PRICE_FETCHER_OPTION_NAMES, args):
        if name in options:
            raise TypeError(f"multiple values for argument '{name}'")
        options[name] = value
    unknown = sorted(set(options) - set(_CLICKHOUSE_PRICE_FETCHER_OPTION_NAMES))
    if unknown:
        raise TypeError(f"unexpected ClickHousePriceFetcher option: {unknown[0]}")
    return options


class PriceFetcher:
    """Base price fetcher interface."""

    def fetch_price(self, signal: SignalEnvelope) -> Optional[Decimal]:
        raise NotImplementedError

    def fetch_market_snapshot(self, signal: SignalEnvelope) -> Optional[MarketSnapshot]:
        price = self.fetch_price(signal)
        if price is None:
            return None
        return MarketSnapshot(
            symbol=signal.symbol,
            as_of=signal.event_ts,
            price=price,
            spread=None,
            source="price_fetcher",
        )


def _quote_row_reject_reason(row: Mapping[str, Any]) -> str | None:
    bid = optional_decimal(row.get("imbalance_bid_px"))
    ask = optional_decimal(row.get("imbalance_ask_px"))
    for failed, reason in (
        (bid is None and ask is None, "missing_executable_quote"),
        (bid is None, "missing_bid"),
        (ask is None, "missing_ask"),
        (bid is not None and bid <= 0, "non_positive_bid"),
        (ask is not None and ask <= 0, "non_positive_ask"),
        (bid is not None and ask is not None and ask < bid, "crossed_quote"),
    ):
        if failed:
            return reason
    if bid is None or ask is None:
        return "missing_executable_quote"
    spread_bps = _quote_spread_bps(bid=bid, ask=ask)
    return quote_spread_reject_reason(spread_bps)


def resolve_execution_reference_price(
    *,
    params: Mapping[str, Any] | None = None,
    limit_price: Any = None,
    stop_price: Any = None,
    market_snapshot: MarketSnapshot | None = None,
    fallback_price: Any = None,
) -> Decimal | None:
    """Resolve the price used for execution sizing, impact, and TCA.

    Signal payloads can carry both a strategy feature price and a fetched market
    snapshot. The snapshot is the executable reference; the raw signal price is a
    fallback so stale feature values cannot silently distort notional or TCA.
    """

    params_payload: Mapping[str, Any] = params or {}
    price_snapshot = params_payload.get("price_snapshot")
    snapshot_price = None
    if isinstance(price_snapshot, Mapping):
        snapshot_price = cast(Mapping[str, Any], price_snapshot).get("price")

    market_snapshot_price = (
        market_snapshot.price if market_snapshot is not None else None
    )
    for candidate in (
        params_payload.get("arrival_price"),
        params_payload.get("reference_price"),
        params_payload.get("simulated_fill_price"),
        params_payload.get("fill_price"),
        snapshot_price,
        limit_price,
        stop_price,
        market_snapshot_price,
        fallback_price,
        params_payload.get("price"),
    ):
        resolved = optional_decimal(candidate)
        if resolved is not None and resolved > 0:
            return resolved
    return None


class ClickHousePriceFetcher(PriceFetcher):
    """Fetch latest microbar close from ClickHouse."""

    def __init__(
        self,
        *args: Any,
        **overrides: Any,
    ) -> None:
        options = _price_fetcher_options_from_args(args, overrides)
        self.url = (options.get("url") or settings.trading_clickhouse_url or "").rstrip(
            "/"
        )
        self.username = options.get("username") or settings.trading_clickhouse_username
        self.password = options.get("password") or settings.trading_clickhouse_password
        self.table = qualified_table_name(
            options.get("table") or settings.trading_price_table
        )
        self.quote_table = qualified_table_name(
            options.get("quote_table") or settings.trading_signal_table
        )
        self.lookback_minutes = (
            options.get("lookback_minutes") or settings.trading_price_lookback_minutes
        )
        self.quote_lookback_seconds = max(
            1,
            int(
                options.get("quote_lookback_seconds")
                or settings.trading_executable_quote_lookback_seconds
                or 0
            ),
        )
        configured_forward_seconds = (
            settings.trading_executable_quote_forward_seconds
            if options.get("quote_forward_seconds") is None
            else options.get("quote_forward_seconds")
        )
        self.quote_forward_seconds = max(0, int(configured_forward_seconds or 0))
        self.alpaca_quote_fallback_enabled = (
            settings.trading_alpaca_quote_fallback_enabled
            if options.get("alpaca_quote_fallback_enabled") is None
            else options.get("alpaca_quote_fallback_enabled")
        )
        self.alpaca_data_api_base_url = (
            options.get("alpaca_data_api_base_url")
            or settings.apca_data_api_base_url
            or "https://data.alpaca.markets"
        ).rstrip("/")
        self.alpaca_api_key_id = (
            options.get("alpaca_api_key_id") or settings.apca_api_key_id
        )
        self.alpaca_api_secret_key = (
            options.get("alpaca_api_secret_key") or settings.apca_api_secret_key
        )
        self.alpaca_quote_feed = str(
            options.get("alpaca_quote_feed")
            if options.get("alpaca_quote_feed") is not None
            else settings.trading_alpaca_quote_feed
        ).strip()
        self.alpaca_quote_timeout_seconds = (
            options.get("alpaca_quote_timeout_seconds")
            if options.get("alpaca_quote_timeout_seconds") is not None
            else settings.trading_alpaca_quote_timeout_seconds
        )
        raw_alpaca_quote_max_age_seconds = (
            options.get("alpaca_quote_max_age_seconds")
            if options.get("alpaca_quote_max_age_seconds") is not None
            else settings.trading_alpaca_quote_max_age_seconds
        )
        self.alpaca_quote_max_age_seconds = max(
            1,
            int(raw_alpaca_quote_max_age_seconds or 0),
        )
        self.alpaca_quote_fallback_market_session_required = (
            settings.trading_alpaca_quote_fallback_market_session_required
            if options.get("alpaca_quote_fallback_market_session_required") is None
            else options.get("alpaca_quote_fallback_market_session_required")
        )
        raw_alpaca_quote_fallback_backoff_seconds = (
            options.get("alpaca_quote_fallback_backoff_seconds")
            if options.get("alpaca_quote_fallback_backoff_seconds") is not None
            else settings.trading_alpaca_quote_fallback_backoff_seconds
        )
        self.alpaca_quote_fallback_backoff_seconds = max(
            0,
            int(raw_alpaca_quote_fallback_backoff_seconds or 0),
        )
        self._columns: Optional[set[str]] = None
        self._alpaca_quote_fallback_backoff: dict[str, tuple[float, str]] = {}

    def fetch_price(self, signal: SignalEnvelope) -> Optional[Decimal]:
        if not self.url:
            return None
        symbol = normalize_symbol(signal.symbol)
        if symbol is None:
            logger.warning("Invalid symbol for price lookup: %s", signal.symbol)
            return None
        target_ts = signal.event_ts
        lookback = target_ts - timedelta(minutes=self.lookback_minutes)
        order_clause = "event_ts DESC"
        if self._supports_seq():
            order_clause = "event_ts DESC, seq DESC"
        query = " ".join(
            [
                "SELECT event_ts, c, vwap",
                "FROM",
                self.table,
                "WHERE",
                f"symbol = {quote_literal(symbol)}",
                "AND",
                f"event_ts >= {to_datetime64(lookback)}",
                "AND",
                f"event_ts <= {to_datetime64(target_ts)}",
                "ORDER BY",
                order_clause,
                "LIMIT 1",
                "FORMAT JSONEachRow",
            ]
        )
        rows = self._query_clickhouse(query)
        if not rows:
            return None
        row = rows[0]
        return select_price(row)

    def _fetch_microbar_price_row(
        self,
        *,
        symbol: str,
        target_ts: datetime,
    ) -> dict[str, Any]:
        if not self.url:
            return {}
        lookback = target_ts - timedelta(minutes=self.lookback_minutes)
        order_clause = "event_ts DESC"
        if self._supports_seq():
            order_clause = "event_ts DESC, seq DESC"
        query = " ".join(
            [
                "SELECT event_ts, c, vwap",
                "FROM",
                self.table,
                "WHERE",
                f"symbol = {quote_literal(symbol)}",
                "AND",
                f"event_ts >= {to_datetime64(lookback)}",
                "AND",
                f"event_ts <= {to_datetime64(target_ts)}",
                "ORDER BY",
                order_clause,
                "LIMIT 1",
                "FORMAT JSONEachRow",
            ]
        )
        rows = self._query_clickhouse(query)
        return rows[0] if rows else {}

    def _resolve_quote_row(
        self,
        *,
        symbol: str,
        target_ts: datetime,
    ) -> _ResolvedQuoteRow:
        quote_source = "ta_signals_quote"
        quote_row = (
            self._fetch_recent_executable_quote_row(
                symbol=symbol,
                target_ts=target_ts,
            )
            if self.url
            else None
        )
        diagnostics = self._quote_row_diagnostics(
            symbol=symbol,
            target_ts=target_ts,
            quote_row=quote_row,
            quote_source=quote_source,
        )
        if quote_row is not None:
            return _ResolvedQuoteRow(
                row=quote_row,
                source=quote_source,
                diagnostics=diagnostics,
            )

        alpaca_row = self._fetch_alpaca_latest_quote_row(symbol=symbol)
        if alpaca_row is not None:
            return _ResolvedQuoteRow(
                row=alpaca_row,
                source="alpaca_latest_quote",
                diagnostics=self._quote_lookup_diagnostics(
                    symbol=symbol,
                    target_ts=target_ts,
                    source="alpaca_latest_quote",
                    row=alpaca_row,
                    accepted=True,
                ),
            )
        if diagnostics is not None:
            diagnostics["alpaca_quote_fallback_attempted"] = (
                self.alpaca_quote_fallback_enabled
            )
        return _ResolvedQuoteRow(
            row=None, source="alpaca_latest_quote", diagnostics=diagnostics
        )

    def _quote_row_diagnostics(
        self,
        *,
        symbol: str,
        target_ts: datetime,
        quote_row: dict[str, Any] | None,
        quote_source: str,
    ) -> dict[str, object] | None:
        if not self.url:
            return None
        if quote_row is not None:
            return self._quote_lookup_diagnostics(
                symbol=symbol,
                target_ts=target_ts,
                source=quote_source,
                row=quote_row,
                accepted=True,
            )
        return self._quote_lookup_diagnostics(
            symbol=symbol,
            target_ts=target_ts,
            source=quote_source,
            row=self._fetch_latest_quote_diagnostic_row(
                symbol=symbol,
                target_ts=target_ts,
            ),
            accepted=False,
        )

    @staticmethod
    def _snapshot_from_rows(
        *,
        signal: SignalEnvelope,
        symbol: str,
        row: Mapping[str, Any],
        resolved_quote: _ResolvedQuoteRow,
    ) -> MarketSnapshot | None:
        as_of = snapshot_as_of(row, signal.event_ts)
        price = select_price(dict(row))
        spread = optional_decimal(row.get("spread"))
        source = "ta_microbars"
        bid: Decimal | None = None
        ask: Decimal | None = None
        quote_as_of: datetime | None = None
        quote_row = resolved_quote.row
        if quote_row is not None:
            quote_as_of = snapshot_as_of(quote_row, signal.event_ts)
            bid = optional_decimal(quote_row.get("imbalance_bid_px"))
            ask = optional_decimal(quote_row.get("imbalance_ask_px"))
            quote_spread = select_quote_spread(quote_row, bid=bid, ask=ask)
            price = price or select_price(quote_row) or midpoint(bid=bid, ask=ask)
            spread = spread or quote_spread
            as_of = quote_as_of if not row else as_of
            source = (
                f"ta_microbars+{resolved_quote.source}"
                if row
                else resolved_quote.source
            )
        if price is None and bid is None and ask is None:
            return None
        return MarketSnapshot(
            symbol=symbol,
            as_of=as_of,
            price=price,
            spread=spread,
            source=source,
            bid=bid,
            ask=ask,
            quote_as_of=quote_as_of,
            quote_source=resolved_quote.source if quote_row is not None else None,
            quote_lookup_diagnostics=resolved_quote.diagnostics,
        )

    def fetch_market_snapshot(self, signal: SignalEnvelope) -> Optional[MarketSnapshot]:
        symbol = normalize_symbol(signal.symbol)
        if symbol is None:
            logger.warning("Invalid symbol for price snapshot: %s", signal.symbol)
            return None
        target_ts = signal.event_ts
        row = self._fetch_microbar_price_row(symbol=symbol, target_ts=target_ts)
        resolved_quote = self._resolve_quote_row(symbol=symbol, target_ts=target_ts)
        return self._snapshot_from_rows(
            signal=signal,
            symbol=symbol,
            row=row,
            resolved_quote=resolved_quote,
        )

    def _fetch_recent_executable_quote_row(
        self,
        *,
        symbol: str,
        target_ts: datetime,
    ) -> dict[str, Any] | None:
        lookback = target_ts - timedelta(seconds=self.quote_lookback_seconds)
        quote_window_end = target_ts
        if self.quote_forward_seconds > 0:
            forward_end = target_ts + timedelta(seconds=self.quote_forward_seconds)
            now = datetime.now(timezone.utc)
            if target_ts.tzinfo is None:
                now = now.replace(tzinfo=None)
            quote_window_end = min(forward_end, now)
        order_clause = "event_ts DESC"
        query = " ".join(
            [
                "SELECT event_ts, imbalance_bid_px, imbalance_ask_px, imbalance_spread",
                "FROM",
                self.quote_table,
                "WHERE",
                f"symbol = {quote_literal(symbol)}",
                "AND",
                f"event_ts >= {to_datetime64(lookback)}",
                "AND",
                f"event_ts <= {to_datetime64(quote_window_end)}",
                "AND",
                "imbalance_bid_px IS NOT NULL",
                "AND",
                "imbalance_ask_px IS NOT NULL",
                "AND",
                "imbalance_bid_px > 0",
                "AND",
                "imbalance_ask_px >= imbalance_bid_px",
                "AND",
                quote_spread_bps_sql()
                + f" <= {settings.trading_signal_max_executable_spread_bps}",
                "ORDER BY",
                order_clause,
                "LIMIT 1",
                "FORMAT JSONEachRow",
            ]
        )
        try:
            rows = self._query_clickhouse(query)
        except Exception as exc:
            logger.warning("Failed to fetch recent executable quote: %s", exc)
            return None
        if not rows:
            return None
        for row in rows:
            if _quote_row_reject_reason(row) is None:
                return row
        return None

    def _fetch_latest_quote_diagnostic_row(
        self,
        *,
        symbol: str,
        target_ts: datetime,
    ) -> dict[str, Any] | None:
        lookback = target_ts - timedelta(seconds=self.quote_lookback_seconds)
        quote_window_end = target_ts
        if self.quote_forward_seconds > 0:
            forward_end = target_ts + timedelta(seconds=self.quote_forward_seconds)
            now = datetime.now(timezone.utc)
            if target_ts.tzinfo is None:
                now = now.replace(tzinfo=None)
            quote_window_end = min(forward_end, now)
        query = " ".join(
            [
                "SELECT event_ts, imbalance_bid_px, imbalance_ask_px, imbalance_spread",
                "FROM",
                self.quote_table,
                "WHERE",
                f"symbol = {quote_literal(symbol)}",
                "AND",
                f"event_ts >= {to_datetime64(lookback)}",
                "AND",
                f"event_ts <= {to_datetime64(quote_window_end)}",
                "ORDER BY",
                "event_ts DESC",
                "LIMIT 1",
                "FORMAT JSONEachRow",
            ]
        )
        try:
            rows = self._query_clickhouse(query)
        except Exception as exc:
            logger.warning("Failed to fetch recent quote diagnostics: %s", exc)
            return None
        if not rows:
            return None
        return rows[0]

    def _quote_lookup_diagnostics(
        self,
        *,
        symbol: str,
        target_ts: datetime,
        source: str,
        row: Mapping[str, Any] | None,
        accepted: bool,
    ) -> dict[str, object]:
        rejected_reason = None if accepted else "no_recent_quote"
        bid: Decimal | None = None
        ask: Decimal | None = None
        spread: Decimal | None = None
        spread_bps: Decimal | None = None
        quote_as_of: datetime | None = None
        if row is not None:
            rejected_reason = None if accepted else _quote_row_reject_reason(row)
            bid = optional_decimal(row.get("imbalance_bid_px"))
            ask = optional_decimal(row.get("imbalance_ask_px"))
            spread = select_quote_spread(row, bid=bid, ask=ask)
            if bid is not None and ask is not None:
                spread_bps = _quote_spread_bps(bid=bid, ask=ask)
            quote_as_of = snapshot_as_of(row, target_ts)
        return {
            "schema_version": "torghut.quote-lookup-diagnostics.v1",
            "symbol": symbol,
            "target_ts": target_ts.isoformat(),
            "source": source,
            "latest_quote_present": row is not None,
            "latest_quote_accepted": accepted,
            "latest_quote_rejected_reason": rejected_reason,
            "latest_quote_as_of": quote_as_of.isoformat()
            if quote_as_of is not None
            else None,
            "latest_quote_bid": str(bid) if bid is not None else None,
            "latest_quote_ask": str(ask) if ask is not None else None,
            "latest_quote_spread": str(spread) if spread is not None else None,
            "latestquote_spread_bps": str(spread_bps)
            if spread_bps is not None
            else None,
            "max_spread_bps": str(settings.trading_signal_max_executable_spread_bps),
            "lookback_seconds": self.quote_lookback_seconds,
            "forward_seconds": self.quote_forward_seconds,
        }

    def _alpaca_quote_fallback_preflight(self, *, symbol: str) -> bool:
        if not self.alpaca_quote_fallback_enabled:
            return False
        if self._alpaca_quote_fallback_backoff_active(symbol=symbol):
            return False
        if (
            self.alpaca_quote_fallback_market_session_required
            and not market_session_is_open(None)
        ):
            self._backoff_alpaca_quote_fallback(
                symbol=symbol,
                reason="market_session_closed",
            )
            return False
        if self.alpaca_api_key_id and self.alpaca_api_secret_key:
            return True
        logger.warning(
            "Alpaca latest quote fallback disabled by missing credentials symbol=%s",
            symbol,
        )
        self._backoff_alpaca_quote_fallback(
            symbol=symbol,
            reason="missing_credentials",
        )
        return False

    def _validated_alpaca_quote_prices(
        self,
        *,
        symbol: str,
        quote: Mapping[str, Any],
    ) -> tuple[Decimal, Decimal] | None:
        bid = optional_decimal(quote.get("bp") or quote.get("bid_price"))
        ask = optional_decimal(quote.get("ap") or quote.get("ask_price"))
        if bid is None or ask is None or bid <= 0 or ask < bid:
            logger.info(
                "Alpaca latest quote fallback rejected invalid quote symbol=%s", symbol
            )
            self._backoff_alpaca_quote_fallback(symbol=symbol, reason="invalid_quote")
            return None
        spread_bps = _quote_spread_bps(bid=bid, ask=ask)
        if spread_bps is None:
            self._backoff_alpaca_quote_fallback(symbol=symbol, reason="invalid_spread")
            return None
        if spread_bps > settings.trading_signal_max_executable_spread_bps:
            logger.info(
                "Alpaca latest quote fallback rejected wide quote symbol=%s spread_bps=%s",
                symbol,
                spread_bps,
            )
            self._backoff_alpaca_quote_fallback(symbol=symbol, reason="wide_quote")
            return None
        return bid, ask

    def _validated_alpaca_quote_timestamp(
        self,
        *,
        symbol: str,
        quote: Mapping[str, Any],
    ) -> datetime | None:
        quote_ts = parse_ts(quote.get("t") or quote.get("timestamp"))
        if quote_ts is None:
            logger.info(
                "Alpaca latest quote fallback rejected missing timestamp symbol=%s",
                symbol,
            )
            self._backoff_alpaca_quote_fallback(
                symbol=symbol,
                reason="missing_timestamp",
            )
            return None
        if quote_ts.tzinfo is None:
            quote_ts = quote_ts.replace(tzinfo=timezone.utc)
        quote_age = max(
            0.0,
            (
                datetime.now(timezone.utc) - quote_ts.astimezone(timezone.utc)
            ).total_seconds(),
        )
        if quote_age <= self.alpaca_quote_max_age_seconds:
            return quote_ts
        logger.info(
            "Alpaca latest quote fallback rejected stale quote symbol=%s age_seconds=%.3f",
            symbol,
            quote_age,
        )
        self._backoff_alpaca_quote_fallback(symbol=symbol, reason="stale_quote")
        return None

    def _fetch_alpaca_latest_quote_row(self, *, symbol: str) -> dict[str, Any] | None:
        if not self._alpaca_quote_fallback_preflight(symbol=symbol):
            return None
        quote = self._fetch_alpaca_latest_quote(symbol=symbol)
        if quote is None:
            self._backoff_alpaca_quote_fallback(
                symbol=symbol,
                reason="quote_unavailable",
            )
            return None
        prices = self._validated_alpaca_quote_prices(symbol=symbol, quote=quote)
        if prices is None:
            return None
        quote_ts = self._validated_alpaca_quote_timestamp(symbol=symbol, quote=quote)
        if quote_ts is None:
            return None
        bid, ask = prices
        return {
            "event_ts": quote_ts.isoformat(),
            "imbalance_bid_px": bid,
            "imbalance_ask_px": ask,
            "imbalance_spread": ask - bid,
        }

    def _alpaca_quote_fallback_backoff_active(self, *, symbol: str) -> bool:
        backoff = self._alpaca_quote_fallback_backoff.get(symbol)
        if backoff is None:
            return False
        expires_at, _reason = backoff
        if monotonic() < expires_at:
            return True
        self._alpaca_quote_fallback_backoff.pop(symbol, None)
        return False

    def _backoff_alpaca_quote_fallback(self, *, symbol: str, reason: str) -> None:
        if self.alpaca_quote_fallback_backoff_seconds <= 0:
            return
        now = monotonic()
        previous = self._alpaca_quote_fallback_backoff.get(symbol)
        self._alpaca_quote_fallback_backoff[symbol] = (
            now + self.alpaca_quote_fallback_backoff_seconds,
            reason,
        )
        if previous is not None and previous[0] > now:
            return
        logger.info(
            "Alpaca latest quote fallback backoff symbol=%s reason=%s seconds=%s",
            symbol,
            reason,
            self.alpaca_quote_fallback_backoff_seconds,
        )

    def _alpaca_latest_quote_url(self, *, symbol: str) -> str:
        params: dict[str, str] = {}
        if self.alpaca_quote_feed:
            params["feed"] = self.alpaca_quote_feed
        request_url = (
            f"{self.alpaca_data_api_base_url}/v2/stocks/{symbol}/quotes/latest"
        )
        query = urlencode(params)
        if query:
            return f"{request_url}?{query}"
        return request_url

    @staticmethod
    def _validated_alpaca_data_url(request_url: str) -> SplitResult | None:
        parsed = urlsplit(request_url)
        scheme = parsed.scheme.lower()
        if scheme not in {"http", "https"}:
            logger.warning(
                "Unsupported Alpaca data API URL scheme: %s", scheme or "missing"
            )
            return None
        if not parsed.hostname:
            logger.warning("Invalid Alpaca data API URL host")
            return None
        return parsed

    def _fetch_alpaca_latest_quote_body(
        self,
        *,
        symbol: str,
        parsed: SplitResult,
    ) -> str | None:
        headers = {
            "Accept": "application/json",
            "APCA-API-KEY-ID": self.alpaca_api_key_id or "",
            "APCA-API-SECRET-KEY": self.alpaca_api_secret_key or "",
        }
        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"
        connection_class = (
            HTTPSConnection if parsed.scheme.lower() == "https" else HTTPConnection
        )
        host = parsed.hostname
        if not host:
            logger.warning("Invalid Alpaca data API URL host")
            return None
        connection = connection_class(
            host,
            parsed.port,
            timeout=self.alpaca_quote_timeout_seconds,
        )
        try:
            connection.request("GET", path, headers=headers)
            response = connection.getresponse()
            body = response.read().decode("utf-8", errors="replace")
        except Exception as exc:
            logger.warning(
                "Alpaca latest quote fallback request failed symbol=%s error=%s",
                symbol,
                exc,
            )
            return None
        finally:
            connection.close()
        if 200 <= response.status < 300:
            return body
        logger.warning(
            "Alpaca latest quote fallback HTTP failure symbol=%s status=%s body=%s",
            symbol,
            response.status,
            body[:200],
        )
        return None

    @staticmethod
    def _decode_alpaca_latest_quote(
        *,
        symbol: str,
        body: str,
    ) -> Mapping[str, Any] | None:
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            logger.warning(
                "Alpaca latest quote fallback returned invalid JSON symbol=%s", symbol
            )
            return None
        if not isinstance(payload, Mapping):
            return None
        quote = cast(Mapping[str, Any], payload).get("quote")
        if isinstance(quote, Mapping):
            return cast(Mapping[str, Any], quote)
        return None

    def _fetch_alpaca_latest_quote(self, *, symbol: str) -> Mapping[str, Any] | None:
        parsed = self._validated_alpaca_data_url(
            self._alpaca_latest_quote_url(symbol=symbol)
        )
        if parsed is None:
            return None
        body = self._fetch_alpaca_latest_quote_body(symbol=symbol, parsed=parsed)
        if body is None:
            return None
        return self._decode_alpaca_latest_quote(symbol=symbol, body=body)

    def _query_clickhouse(self, query: str) -> list[dict[str, Any]]:
        params = {"query": query}
        request_url = f"{self.url}/?{urlencode(params)}"
        parsed = urlsplit(request_url)
        scheme = parsed.scheme.lower()
        if scheme not in {"http", "https"}:
            raise RuntimeError(
                f"unsupported_clickhouse_url_scheme:{scheme or 'missing'}"
            )
        if not parsed.hostname:
            raise RuntimeError("invalid_clickhouse_url_host")

        headers = {"Content-Type": "text/plain"}
        if self.username:
            headers["X-ClickHouse-User"] = self.username
        if self.password:
            headers["X-ClickHouse-Key"] = self.password

        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"
        connection_class = HTTPSConnection if scheme == "https" else HTTPConnection
        connection = connection_class(
            parsed.hostname,
            parsed.port,
            timeout=settings.trading_clickhouse_timeout_seconds,
        )

        rows: list[dict[str, Any]] = []
        try:
            connection.request("GET", path, headers=headers)
            response = connection.getresponse()
            if response.status < 200 or response.status >= 300:
                detail = response.read().decode("utf-8", errors="replace")
                raise RuntimeError(f"clickhouse_http_{response.status}:{detail[:200]}")
            payload = response.read().decode("utf-8")
        finally:
            connection.close()

        for line in payload.splitlines():
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                logger.warning("Failed to decode ClickHouse price row")
        return rows

    def _supports_seq(self) -> bool:
        columns = self._resolve_columns()
        if columns is None:
            return False
        return "seq" in columns

    def _resolve_columns(self) -> Optional[set[str]]:
        if self._columns is not None:
            return self._columns
        database, table = split_table(self.table)
        query = " ".join(
            [
                "SELECT name FROM system.columns WHERE",
                f"database = {quote_literal(database)}",
                "AND",
                f"table = {quote_literal(table)}",
                "FORMAT JSONEachRow",
            ]
        )
        try:
            rows = self._query_clickhouse(query)
        except Exception as exc:
            logger.warning("Failed to detect ClickHouse price schema: %s", exc)
            self._columns = None
            return None
        if not rows:
            self._columns = None
            return None
        self._columns = {str(row.get("name")) for row in rows if row.get("name")}
        if not self._columns:
            self._columns = None
            return None
        return self._columns


__all__ = ["ClickHousePriceFetcher", "MarketSnapshot", "PriceFetcher"]
