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


@dataclass(frozen=True)
class UniverseResolution:
    symbols: set[str]
    source: str
    status: str
    reason: str
    fetched_at: datetime | None
    cache_age_seconds: int | None


class UniverseResolver:
    """Resolve symbols from Jangar or static config."""

    def __init__(self) -> None:
        self._cache: Optional[UniverseCache] = None
        self._last_resolution: UniverseResolution = UniverseResolution(
            symbols=set(),
            source=settings.trading_universe_source,
            status='unknown',
            reason='not_evaluated',
            fetched_at=None,
            cache_age_seconds=None,
        )

    def get_symbols(self) -> set[str]:
        return self.get_resolution().symbols

    def get_resolution(self) -> UniverseResolution:
        if (
            settings.trading_universe_source != "jangar"
            and (
                settings.trading_enabled
                or settings.trading_autonomy_enabled
                or settings.trading_live_enabled
            )
        ):
            logger.error(
                "Invalid universe source for active trading/autonomy: source=%s",
                settings.trading_universe_source,
            )
            resolution = UniverseResolution(
                symbols=set(),
                source=str(settings.trading_universe_source),
                status='error',
                reason='invalid_universe_source_for_active_trading',
                fetched_at=None,
                cache_age_seconds=None,
            )
            self._last_resolution = resolution
            return resolution
        if settings.trading_universe_source == "static":
            symbols = set(settings.trading_static_symbols)
            filtered = _filter_symbols(symbols)
            resolution = UniverseResolution(
                symbols=filtered,
                source='static',
                status='ok' if filtered else 'empty',
                reason='static_symbols_loaded' if filtered else 'static_symbols_empty',
                fetched_at=None,
                cache_age_seconds=None,
            )
            self._last_resolution = resolution
            return resolution
        if settings.trading_universe_source == "jangar":
            resolution = self._resolve_from_jangar()
            self._last_resolution = resolution
            return resolution
        logger.warning("Unknown trading universe source: %s", settings.trading_universe_source)
        resolution = UniverseResolution(
            symbols=set(),
            source=str(settings.trading_universe_source),
            status='error',
            reason='unknown_universe_source',
            fetched_at=None,
            cache_age_seconds=None,
        )
        self._last_resolution = resolution
        return resolution

    def _resolve_from_jangar(self) -> UniverseResolution:
        now = datetime.now(timezone.utc)
        url = settings.trading_jangar_symbols_url
        if not url:
            logger.warning("JANGAR_SYMBOLS_URL not set; skipping universe fetch")
            return self._fallback_from_cache(
                now=now,
                reason='jangar_url_missing',
            )

        cache_ttl = timedelta(seconds=settings.trading_universe_cache_seconds)
        if self._cache and now - self._cache.fetched_at < cache_ttl:
            return UniverseResolution(
                symbols=set(self._cache.symbols),
                source='jangar',
                status='ok',
                reason='jangar_cache_hit',
                fetched_at=self._cache.fetched_at,
                cache_age_seconds=int((now - self._cache.fetched_at).total_seconds()),
            )

        request = Request(url)
        try:
            with urlopen(request, timeout=settings.trading_universe_timeout_seconds) as response:
                payload = response.read().decode("utf-8")
        except Exception as exc:
            logger.warning("Failed to fetch Jangar symbols: %s", exc)
            return self._fallback_from_cache(
                now=now,
                reason='jangar_fetch_failed',
            )
        try:
            data = json.loads(payload)
        except json.JSONDecodeError as exc:
            logger.warning("Failed to decode Jangar symbols payload: %s", exc)
            return self._fallback_from_cache(
                now=now,
                reason='jangar_payload_decode_failed',
            )

        symbols = _filter_symbols(_parse_symbols(data))
        if not symbols:
            return self._fallback_from_cache(
                now=now,
                reason='jangar_payload_empty',
            )
        self._cache = UniverseCache(symbols=symbols, fetched_at=now)
        return UniverseResolution(
            symbols=symbols,
            source='jangar',
            status='ok',
            reason='jangar_fetch_ok',
            fetched_at=now,
            cache_age_seconds=0,
        )

    def _fallback_from_cache(self, *, now: datetime, reason: str) -> UniverseResolution:
        if self._cache is None:
            return UniverseResolution(
                symbols=set(),
                source='jangar',
                status='error',
                reason=reason,
                fetched_at=None,
                cache_age_seconds=None,
            )
        age_seconds = int((now - self._cache.fetched_at).total_seconds())
        max_stale_seconds = max(1, settings.trading_universe_max_stale_seconds)
        if age_seconds <= max_stale_seconds:
            logger.warning(
                "Reusing cached Jangar universe after fetch failure reason=%s age_seconds=%s symbols=%s",
                reason,
                age_seconds,
                len(self._cache.symbols),
            )
            return UniverseResolution(
                symbols=set(self._cache.symbols),
                source='jangar',
                status='degraded',
                reason=f'{reason}_using_stale_cache',
                fetched_at=self._cache.fetched_at,
                cache_age_seconds=age_seconds,
            )
        logger.error(
            "Jangar universe cache is stale; refusing stale symbols reason=%s age_seconds=%s max_stale_seconds=%s",
            reason,
            age_seconds,
            max_stale_seconds,
        )
        return UniverseResolution(
            symbols=set(),
            source='jangar',
            status='error',
            reason=f'{reason}_cache_stale',
            fetched_at=self._cache.fetched_at,
            cache_age_seconds=age_seconds,
        )


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
            if "/" in normalized and not settings.trading_universe_crypto_enabled:
                continue
            cleaned.add(normalized)
    return cleaned


__all__ = ["UniverseResolver", "UniverseResolution"]
