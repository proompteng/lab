"""Resolve tradable universe for strategies."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.request import Request, urlopen

from ..config import settings

logger = logging.getLogger(__name__)


@dataclass
class UniverseCache:
    symbols: set[str]
    fetched_at: datetime


class UniverseResolver:
    """Resolve symbols from Jangar or static config."""

    def __init__(self) -> None:
        self._cache: Optional[UniverseCache] = None

    def get_symbols(self) -> Optional[set[str]]:
        if settings.trading_universe_source == "static":
            symbols = set(settings.trading_static_symbols)
            return symbols or None
        if settings.trading_universe_source == "jangar":
            return self._fetch_from_jangar()
        return None

    def _fetch_from_jangar(self) -> Optional[set[str]]:
        url = settings.trading_jangar_symbols_url
        if not url:
            logger.warning("JANGAR_SYMBOLS_URL not set; skipping universe fetch")
            return None

        cache_ttl = timedelta(seconds=settings.trading_universe_cache_seconds)
        if self._cache and datetime.now(timezone.utc) - self._cache.fetched_at < cache_ttl:
            return self._cache.symbols

        request = Request(url)
        with urlopen(request, timeout=settings.trading_universe_timeout_seconds) as response:
            payload = response.read().decode("utf-8")
        try:
            data = json.loads(payload)
        except json.JSONDecodeError as exc:
            logger.warning("Failed to decode Jangar symbols payload: %s", exc)
            return None

        symbols = _parse_symbols(data)
        if symbols:
            self._cache = UniverseCache(symbols=symbols, fetched_at=datetime.now(timezone.utc))
        return symbols


def _parse_symbols(payload: object) -> set[str]:
    if isinstance(payload, dict):
        maybe_symbols = payload.get("symbols")
        if isinstance(maybe_symbols, list):
            return {str(symbol).strip() for symbol in maybe_symbols if str(symbol).strip()}
    if isinstance(payload, list):
        return {str(symbol).strip() for symbol in payload if str(symbol).strip()}
    return set()


__all__ = ["UniverseResolver"]
