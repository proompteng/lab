"""Resolve tradable universe for strategies."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional, cast
from urllib.request import Request, urlopen

from ..config import settings
from .clickhouse import normalize_symbol

logger = logging.getLogger(__name__)


@dataclass
class UniverseCache:
    symbols: set[str]
    fetched_at: datetime


class UniverseResolver:
    """Resolve symbols from Jangar or static config."""

    def __init__(self) -> None:
        self._cache: Optional[UniverseCache] = None

    def get_symbols(self) -> set[str]:
        if settings.trading_universe_source == "static":
            symbols = set(settings.trading_static_symbols)
            return _filter_symbols(symbols)
        if settings.trading_universe_source == "jangar":
            symbols = self._fetch_from_jangar()
            if symbols:
                return symbols
            if self._cache:
                logger.warning(
                    "Jangar fetch returned no symbols; reusing cached universe with %d symbols",
                    len(self._cache.symbols),
                )
                return self._cache.symbols
            return set()
        logger.warning("Unknown trading universe source: %s", settings.trading_universe_source)
        return set()

    def _fetch_from_jangar(self) -> set[str]:
        url = settings.trading_jangar_symbols_url
        if not url:
            logger.warning("JANGAR_SYMBOLS_URL not set; skipping universe fetch")
            return set()

        cache_ttl = timedelta(seconds=settings.trading_universe_cache_seconds)
        if self._cache and datetime.now(timezone.utc) - self._cache.fetched_at < cache_ttl:
            return self._cache.symbols

        request = Request(url)
        try:
            with urlopen(request, timeout=settings.trading_universe_timeout_seconds) as response:
                payload = response.read().decode("utf-8")
        except Exception as exc:
            logger.warning("Failed to fetch Jangar symbols: %s", exc)
            return set()
        try:
            data = json.loads(payload)
        except json.JSONDecodeError as exc:
            logger.warning("Failed to decode Jangar symbols payload: %s", exc)
            return set()

        symbols = _filter_symbols(_parse_symbols(data))
        if not symbols:
            return set()
        self._cache = UniverseCache(symbols=symbols, fetched_at=datetime.now(timezone.utc))
        return symbols


def _parse_symbols(payload: object) -> set[str]:
    if isinstance(payload, dict):
        payload_dict = cast(dict[str, Any], payload)
        maybe_symbols = payload_dict.get("symbols")
        if isinstance(maybe_symbols, list):
            symbols: set[str] = set()
            for symbol in cast(list[Any], maybe_symbols):
                cleaned = str(symbol).strip()
                if cleaned:
                    symbols.add(cleaned)
            return symbols
    if isinstance(payload, list):
        symbols: set[str] = set()
        for symbol in cast(list[Any], payload):
            cleaned = str(symbol).strip()
            if cleaned:
                symbols.add(cleaned)
        return symbols
    return set()


def _filter_symbols(symbols: set[str]) -> set[str]:
    cleaned: set[str] = set()
    for symbol in symbols:
        normalized = normalize_symbol(symbol)
        if normalized:
            cleaned.add(normalized)
    return cleaned


__all__ = ["UniverseResolver"]
