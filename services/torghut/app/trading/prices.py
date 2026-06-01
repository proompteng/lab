"""Price lookup helpers for trading decisions."""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from http.client import HTTPConnection, HTTPSConnection
from time import monotonic
from typing import Any, Optional, cast
from urllib.parse import urlencode, urlsplit

from ..config import settings
from .clickhouse import normalize_symbol, to_datetime64
from .market_session import market_session_is_open
from .models import SignalEnvelope

logger = logging.getLogger(__name__)


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
        resolved = _optional_decimal(candidate)
        if resolved is not None and resolved > 0:
            return resolved
    return None


class ClickHousePriceFetcher(PriceFetcher):
    """Fetch latest microbar close from ClickHouse."""

    def __init__(
        self,
        url: Optional[str] = None,
        username: Optional[str] = None,
        password: Optional[str] = None,
        table: Optional[str] = None,
        quote_table: Optional[str] = None,
        lookback_minutes: Optional[int] = None,
        quote_lookback_seconds: Optional[int] = None,
        quote_forward_seconds: Optional[int] = None,
        alpaca_quote_fallback_enabled: Optional[bool] = None,
        alpaca_data_api_base_url: Optional[str] = None,
        alpaca_api_key_id: Optional[str] = None,
        alpaca_api_secret_key: Optional[str] = None,
        alpaca_quote_feed: Optional[str] = None,
        alpaca_quote_timeout_seconds: Optional[float] = None,
        alpaca_quote_max_age_seconds: Optional[int] = None,
        alpaca_quote_fallback_market_session_required: Optional[bool] = None,
        alpaca_quote_fallback_backoff_seconds: Optional[int] = None,
    ) -> None:
        self.url = (url or settings.trading_clickhouse_url or "").rstrip("/")
        self.username = username or settings.trading_clickhouse_username
        self.password = password or settings.trading_clickhouse_password
        self.table = _qualified_table_name(table or settings.trading_price_table)
        self.quote_table = _qualified_table_name(
            quote_table or settings.trading_signal_table
        )
        self.lookback_minutes = (
            lookback_minutes or settings.trading_price_lookback_minutes
        )
        self.quote_lookback_seconds = max(
            1,
            quote_lookback_seconds
            or settings.trading_executable_quote_lookback_seconds,
        )
        configured_forward_seconds = (
            settings.trading_executable_quote_forward_seconds
            if quote_forward_seconds is None
            else quote_forward_seconds
        )
        self.quote_forward_seconds = max(0, configured_forward_seconds)
        self.alpaca_quote_fallback_enabled = (
            settings.trading_alpaca_quote_fallback_enabled
            if alpaca_quote_fallback_enabled is None
            else alpaca_quote_fallback_enabled
        )
        self.alpaca_data_api_base_url = (
            alpaca_data_api_base_url
            or settings.apca_data_api_base_url
            or "https://data.alpaca.markets"
        ).rstrip("/")
        self.alpaca_api_key_id = alpaca_api_key_id or settings.apca_api_key_id
        self.alpaca_api_secret_key = (
            alpaca_api_secret_key or settings.apca_api_secret_key
        )
        self.alpaca_quote_feed = (
            alpaca_quote_feed
            if alpaca_quote_feed is not None
            else settings.trading_alpaca_quote_feed
        ).strip()
        self.alpaca_quote_timeout_seconds = (
            alpaca_quote_timeout_seconds
            if alpaca_quote_timeout_seconds is not None
            else settings.trading_alpaca_quote_timeout_seconds
        )
        self.alpaca_quote_max_age_seconds = max(
            1,
            alpaca_quote_max_age_seconds
            if alpaca_quote_max_age_seconds is not None
            else settings.trading_alpaca_quote_max_age_seconds,
        )
        self.alpaca_quote_fallback_market_session_required = (
            settings.trading_alpaca_quote_fallback_market_session_required
            if alpaca_quote_fallback_market_session_required is None
            else alpaca_quote_fallback_market_session_required
        )
        self.alpaca_quote_fallback_backoff_seconds = max(
            0,
            alpaca_quote_fallback_backoff_seconds
            if alpaca_quote_fallback_backoff_seconds is not None
            else settings.trading_alpaca_quote_fallback_backoff_seconds,
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
                f"symbol = {_quote_literal(symbol)}",
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
        return _select_price(row)

    def fetch_market_snapshot(self, signal: SignalEnvelope) -> Optional[MarketSnapshot]:
        symbol = normalize_symbol(signal.symbol)
        if symbol is None:
            logger.warning("Invalid symbol for price snapshot: %s", signal.symbol)
            return None
        target_ts = signal.event_ts
        rows: list[dict[str, Any]] = []
        if self.url:
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
                    f"symbol = {_quote_literal(symbol)}",
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
        row = rows[0] if rows else {}
        quote_row = (
            self._fetch_recent_executable_quote_row(
                symbol=symbol,
                target_ts=target_ts,
            )
            if self.url
            else None
        )
        quote_source = "ta_signals_quote"
        if quote_row is None:
            quote_row = self._fetch_alpaca_latest_quote_row(symbol=symbol)
            quote_source = "alpaca_latest_quote"
        as_of = _snapshot_as_of(row, signal.event_ts)
        price = _select_price(row)
        spread = _optional_decimal(row.get("spread"))
        source = "ta_microbars"
        bid: Decimal | None = None
        ask: Decimal | None = None
        quote_as_of: datetime | None = None
        resolved_quote_source: str | None = None
        if quote_row is not None:
            quote_as_of = _snapshot_as_of(quote_row, signal.event_ts)
            bid = _optional_decimal(quote_row.get("imbalance_bid_px"))
            ask = _optional_decimal(quote_row.get("imbalance_ask_px"))
            quote_spread = _select_quote_spread(quote_row, bid=bid, ask=ask)
            price = price or _select_price(quote_row) or _midpoint(bid=bid, ask=ask)
            spread = spread or quote_spread
            as_of = quote_as_of if not row else as_of
            source = f"ta_microbars+{quote_source}" if row else quote_source
            resolved_quote_source = quote_source
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
            quote_source=resolved_quote_source,
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
                f"symbol = {_quote_literal(symbol)}",
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
                _quote_spread_bps_sql()
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
        return rows[0]

    def _fetch_alpaca_latest_quote_row(self, *, symbol: str) -> dict[str, Any] | None:
        if not self.alpaca_quote_fallback_enabled:
            return None
        if self._alpaca_quote_fallback_backoff_active(symbol=symbol):
            return None
        if (
            self.alpaca_quote_fallback_market_session_required
            and not market_session_is_open(None)
        ):
            self._backoff_alpaca_quote_fallback(
                symbol=symbol,
                reason="market_session_closed",
            )
            return None
        if not self.alpaca_api_key_id or not self.alpaca_api_secret_key:
            logger.warning(
                "Alpaca latest quote fallback disabled by missing credentials symbol=%s",
                symbol,
            )
            self._backoff_alpaca_quote_fallback(
                symbol=symbol,
                reason="missing_credentials",
            )
            return None
        quote = self._fetch_alpaca_latest_quote(symbol=symbol)
        if quote is None:
            self._backoff_alpaca_quote_fallback(
                symbol=symbol,
                reason="quote_unavailable",
            )
            return None
        bid = _optional_decimal(quote.get("bp") or quote.get("bid_price"))
        ask = _optional_decimal(quote.get("ap") or quote.get("ask_price"))
        if bid is None or ask is None or bid <= 0 or ask < bid:
            logger.info(
                "Alpaca latest quote fallback rejected invalid quote symbol=%s", symbol
            )
            self._backoff_alpaca_quote_fallback(
                symbol=symbol,
                reason="invalid_quote",
            )
            return None
        spread_bps = _quote_spread_bps(bid=bid, ask=ask)
        if spread_bps is None:
            self._backoff_alpaca_quote_fallback(
                symbol=symbol,
                reason="invalid_spread",
            )
            return None
        if spread_bps > settings.trading_signal_max_executable_spread_bps:
            logger.info(
                "Alpaca latest quote fallback rejected wide quote symbol=%s spread_bps=%s",
                symbol,
                spread_bps,
            )
            self._backoff_alpaca_quote_fallback(symbol=symbol, reason="wide_quote")
            return None
        quote_ts = _parse_ts(quote.get("t") or quote.get("timestamp"))
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
        if quote_age > self.alpaca_quote_max_age_seconds:
            logger.info(
                "Alpaca latest quote fallback rejected stale quote symbol=%s age_seconds=%.3f",
                symbol,
                quote_age,
            )
            self._backoff_alpaca_quote_fallback(symbol=symbol, reason="stale_quote")
            return None
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

    def _fetch_alpaca_latest_quote(self, *, symbol: str) -> Mapping[str, Any] | None:
        params: dict[str, str] = {}
        if self.alpaca_quote_feed:
            params["feed"] = self.alpaca_quote_feed
        query = urlencode(params)
        request_url = (
            f"{self.alpaca_data_api_base_url}/v2/stocks/{symbol}/quotes/latest"
        )
        if query:
            request_url = f"{request_url}?{query}"
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

        headers = {
            "Accept": "application/json",
            "APCA-API-KEY-ID": self.alpaca_api_key_id or "",
            "APCA-API-SECRET-KEY": self.alpaca_api_secret_key or "",
        }
        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"
        connection_class = HTTPSConnection if scheme == "https" else HTTPConnection
        connection = connection_class(
            parsed.hostname,
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
        if response.status < 200 or response.status >= 300:
            logger.warning(
                "Alpaca latest quote fallback HTTP failure symbol=%s status=%s body=%s",
                symbol,
                response.status,
                body[:200],
            )
            return None
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            logger.warning(
                "Alpaca latest quote fallback returned invalid JSON symbol=%s", symbol
            )
            return None
        if not isinstance(payload, Mapping):
            return None
        payload_mapping = cast(Mapping[str, Any], payload)
        quote = payload_mapping.get("quote")
        if not isinstance(quote, Mapping):
            return None
        return cast(Mapping[str, Any], quote)

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
        database, table = _split_table(self.table)
        query = " ".join(
            [
                "SELECT name FROM system.columns WHERE",
                f"database = {_quote_literal(database)}",
                "AND",
                f"table = {_quote_literal(table)}",
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


def _optional_decimal(value: Any) -> Optional[Decimal]:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


def _parse_ts(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    if isinstance(value, str):
        cleaned = value.replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(cleaned)
        except ValueError:
            return None
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed
    return None


def _snapshot_as_of(row: Mapping[str, Any], fallback: datetime) -> datetime:
    return _parse_ts(row.get("event_ts")) or _parse_ts(row.get("ts")) or fallback


def _select_price(row: dict[str, Any]) -> Optional[Decimal]:
    return (
        _optional_decimal(row.get("c"))
        or _optional_decimal(row.get("vwap"))
        or _optional_decimal(row.get("close"))
        or _optional_decimal(row.get("price"))
    )


def _select_quote_spread(
    row: Mapping[str, Any],
    *,
    bid: Decimal | None,
    ask: Decimal | None,
) -> Optional[Decimal]:
    spread = _optional_decimal(row.get("spread"))
    if spread is not None:
        return spread
    spread = _optional_decimal(row.get("imbalance_spread"))
    if spread is not None:
        return spread
    if bid is None or ask is None:
        return None
    return ask - bid


def _midpoint(*, bid: Decimal | None, ask: Decimal | None) -> Optional[Decimal]:
    if bid is None or ask is None:
        return None
    return (bid + ask) / Decimal("2")


def _quote_spread_bps(*, bid: Decimal, ask: Decimal) -> Optional[Decimal]:
    midpoint = _midpoint(bid=bid, ask=ask)
    if midpoint is None or midpoint <= 0:
        return None
    return ((ask - bid) / midpoint) * Decimal("10000")


def _quote_spread_bps_sql() -> str:
    return (
        "((imbalance_ask_px - imbalance_bid_px) / "
        "nullIf(((imbalance_ask_px + imbalance_bid_px) / 2), 0)) * 10000"
    )


def _split_table(table: str) -> tuple[str, str]:
    if "." in table:
        database, raw_table = table.split(".", 1)
        return database, raw_table
    return "default", table


_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _safe_identifier(value: str, *, kind: str) -> str:
    cleaned = value.strip()
    if not cleaned or not _IDENTIFIER_RE.fullmatch(cleaned):
        raise ValueError(f"invalid_{kind}_identifier:{value}")
    return cleaned


def _qualified_table_name(table: str) -> str:
    database, raw_table = _split_table(table)
    safe_database = _safe_identifier(database, kind="database")
    safe_table = _safe_identifier(raw_table, kind="table")
    return f"{safe_database}.{safe_table}"


def _quote_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


__all__ = ["ClickHousePriceFetcher", "MarketSnapshot", "PriceFetcher"]
