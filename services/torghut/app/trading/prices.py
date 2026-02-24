"""Price lookup helpers for trading decisions."""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from http.client import HTTPConnection, HTTPSConnection
from typing import Any, Optional
from urllib.parse import urlencode, urlsplit

from ..config import settings
from .clickhouse import normalize_symbol, to_datetime64
from .models import SignalEnvelope

logger = logging.getLogger(__name__)


@dataclass
class MarketSnapshot:
    symbol: str
    as_of: datetime
    price: Optional[Decimal]
    spread: Optional[Decimal]
    source: str


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


class ClickHousePriceFetcher(PriceFetcher):
    """Fetch latest microbar close from ClickHouse."""

    def __init__(
        self,
        url: Optional[str] = None,
        username: Optional[str] = None,
        password: Optional[str] = None,
        table: Optional[str] = None,
        lookback_minutes: Optional[int] = None,
    ) -> None:
        self.url = (url or settings.trading_clickhouse_url or "").rstrip("/")
        self.username = username or settings.trading_clickhouse_username
        self.password = password or settings.trading_clickhouse_password
        self.table = _qualified_table_name(table or settings.trading_price_table)
        self.lookback_minutes = lookback_minutes or settings.trading_price_lookback_minutes
        self._columns: Optional[set[str]] = None

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
        query = ' '.join(
            [
                'SELECT event_ts, c, vwap',
                'FROM',
                self.table,
                'WHERE',
                f'symbol = {_quote_literal(symbol)}',
                'AND',
                f'event_ts >= {to_datetime64(lookback)}',
                'AND',
                f'event_ts <= {to_datetime64(target_ts)}',
                'ORDER BY',
                order_clause,
                'LIMIT 1',
                'FORMAT JSONEachRow',
            ]
        )
        rows = self._query_clickhouse(query)
        if not rows:
            return None
        row = rows[0]
        return _select_price(row)

    def fetch_market_snapshot(self, signal: SignalEnvelope) -> Optional[MarketSnapshot]:
        if not self.url:
            return None
        symbol = normalize_symbol(signal.symbol)
        if symbol is None:
            logger.warning("Invalid symbol for price snapshot: %s", signal.symbol)
            return None
        target_ts = signal.event_ts
        lookback = target_ts - timedelta(minutes=self.lookback_minutes)
        order_clause = "event_ts DESC"
        if self._supports_seq():
            order_clause = "event_ts DESC, seq DESC"
        query = ' '.join(
            [
                'SELECT event_ts, c, vwap',
                'FROM',
                self.table,
                'WHERE',
                f'symbol = {_quote_literal(symbol)}',
                'AND',
                f'event_ts >= {to_datetime64(lookback)}',
                'AND',
                f'event_ts <= {to_datetime64(target_ts)}',
                'ORDER BY',
                order_clause,
                'LIMIT 1',
                'FORMAT JSONEachRow',
            ]
        )
        rows = self._query_clickhouse(query)
        if not rows:
            return None
        row = rows[0]
        as_of = _parse_ts(row.get("event_ts")) or _parse_ts(row.get("ts")) or signal.event_ts
        price = _select_price(row)
        spread = _optional_decimal(row.get("spread"))
        return MarketSnapshot(
            symbol=symbol,
            as_of=as_of,
            price=price,
            spread=spread,
            source="ta_microbars",
        )

    def _query_clickhouse(self, query: str) -> list[dict[str, Any]]:
        params = {"query": query}
        request_url = f"{self.url}/?{urlencode(params)}"
        parsed = urlsplit(request_url)
        scheme = parsed.scheme.lower()
        if scheme not in {'http', 'https'}:
            raise RuntimeError(f'unsupported_clickhouse_url_scheme:{scheme or "missing"}')
        if not parsed.hostname:
            raise RuntimeError('invalid_clickhouse_url_host')

        headers = {"Content-Type": "text/plain"}
        if self.username:
            headers["X-ClickHouse-User"] = self.username
        if self.password:
            headers["X-ClickHouse-Key"] = self.password

        path = parsed.path or '/'
        if parsed.query:
            path = f'{path}?{parsed.query}'
        connection_class = HTTPSConnection if scheme == 'https' else HTTPConnection
        connection = connection_class(
            parsed.hostname,
            parsed.port,
            timeout=settings.trading_clickhouse_timeout_seconds,
        )

        rows: list[dict[str, Any]] = []
        try:
            connection.request('GET', path, headers=headers)
            response = connection.getresponse()
            if response.status < 200 or response.status >= 300:
                detail = response.read().decode('utf-8', errors='replace')
                raise RuntimeError(f'clickhouse_http_{response.status}:{detail[:200]}')
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
        query = ' '.join(
            [
                'SELECT name FROM system.columns WHERE',
                f"database = {_quote_literal(database)}",
                'AND',
                f"table = {_quote_literal(table)}",
                'FORMAT JSONEachRow',
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


def _select_price(row: dict[str, Any]) -> Optional[Decimal]:
    return (
        _optional_decimal(row.get("c"))
        or _optional_decimal(row.get("vwap"))
        or _optional_decimal(row.get("close"))
        or _optional_decimal(row.get("price"))
    )


def _split_table(table: str) -> tuple[str, str]:
    if "." in table:
        database, raw_table = table.split(".", 1)
        return database, raw_table
    return "default", table


_IDENTIFIER_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')


def _safe_identifier(value: str, *, kind: str) -> str:
    cleaned = value.strip()
    if not cleaned or not _IDENTIFIER_RE.fullmatch(cleaned):
        raise ValueError(f'invalid_{kind}_identifier:{value}')
    return cleaned


def _qualified_table_name(table: str) -> str:
    database, raw_table = _split_table(table)
    safe_database = _safe_identifier(database, kind='database')
    safe_table = _safe_identifier(raw_table, kind='table')
    return f'{safe_database}.{safe_table}'


def _quote_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


__all__ = ["ClickHousePriceFetcher", "MarketSnapshot", "PriceFetcher"]
