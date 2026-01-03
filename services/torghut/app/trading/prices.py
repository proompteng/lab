"""Price lookup helpers for trading decisions."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Optional
from urllib.parse import urlencode
from urllib.request import Request, urlopen

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
        self.table = table or settings.trading_price_table
        self.lookback_minutes = lookback_minutes or settings.trading_price_lookback_minutes

    def fetch_price(self, signal: SignalEnvelope) -> Optional[Decimal]:
        if not self.url:
            return None
        symbol = normalize_symbol(signal.symbol)
        if symbol is None:
            logger.warning("Invalid symbol for price lookup: %s", signal.symbol)
            return None
        target_ts = signal.event_ts
        lookback = target_ts - timedelta(minutes=self.lookback_minutes)
        query = (
            "SELECT event_ts, c, vwap "
            f"FROM {self.table} "
            f"WHERE symbol = '{symbol}' "
            f"AND event_ts >= {to_datetime64(lookback)} "
            f"AND event_ts <= {to_datetime64(target_ts)} "
            "ORDER BY event_ts DESC "
            "LIMIT 1 "
            "FORMAT JSONEachRow"
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
        query = (
            "SELECT event_ts, c, vwap "
            f"FROM {self.table} "
            f"WHERE symbol = '{symbol}' "
            f"AND event_ts >= {to_datetime64(lookback)} "
            f"AND event_ts <= {to_datetime64(target_ts)} "
            "ORDER BY event_ts DESC "
            "LIMIT 1 "
            "FORMAT JSONEachRow"
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
        request = Request(
            f"{self.url}/?{urlencode(params)}",
            headers={"Content-Type": "text/plain"},
        )
        if self.username:
            request.add_header("X-ClickHouse-User", self.username)
        if self.password:
            request.add_header("X-ClickHouse-Key", self.password)

        rows: list[dict[str, Any]] = []
        with urlopen(request, timeout=settings.trading_clickhouse_timeout_seconds) as response:
            payload = response.read().decode("utf-8")
        for line in payload.splitlines():
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                logger.warning("Failed to decode ClickHouse price row")
        return rows


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


__all__ = ["ClickHousePriceFetcher", "MarketSnapshot", "PriceFetcher"]
