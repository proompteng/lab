"""Resolve tradable universe for strategies."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from http.client import HTTPConnection, HTTPSConnection
from typing import Any, Optional, cast
from urllib.parse import urlsplit

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


class _HttpRequest:
    def __init__(
        self,
        *,
        full_url: str,
        method: str,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.full_url = full_url
        self.method = method
        self.data: bytes | None = None
        self._headers = dict(headers or {})

    @property
    def headers(self) -> dict[str, str]:
        return dict(self._headers)


class _HttpResponseHandle:
    def __init__(self, connection: HTTPConnection | HTTPSConnection, response: Any) -> None:
        self._connection = connection
        self._response = response
        self.status = int(getattr(response, 'status', 200))

    def read(self) -> bytes:
        return cast(bytes, self._response.read())

    def close(self) -> None:
        self._connection.close()

    def __enter__(self) -> "_HttpResponseHandle":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        self.close()
        return False


def urlopen(request: _HttpRequest, timeout: int) -> _HttpResponseHandle:
    parsed = urlsplit(request.full_url)
    scheme = parsed.scheme.lower()
    if scheme not in {'http', 'https'}:
        raise ValueError(f'unsupported_url_scheme:{scheme or "missing"}')
    if not parsed.hostname:
        raise ValueError('missing_url_host')
    request_path = parsed.path or '/'
    if parsed.query:
        request_path = f'{request_path}?{parsed.query}'
    connection_class = HTTPSConnection if scheme == 'https' else HTTPConnection
    connection = connection_class(parsed.hostname, parsed.port, timeout=max(timeout, 1))
    try:
        connection.request(request.method, request_path, headers=request.headers)
        response = connection.getresponse()
    except Exception:
        connection.close()
        raise
    return _HttpResponseHandle(connection, response)


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

        request = _HttpRequest(
            full_url=url,
            method='GET',
            headers={'accept': 'application/json'},
        )
        payload = ''
        try:
            with urlopen(request, settings.trading_universe_timeout_seconds) as response:
                raw_status = getattr(response, 'status', 200)
                status = raw_status if isinstance(raw_status, int) else 200
                if status < 200 or status >= 300:
                    logger.warning('Jangar symbols request failed with status=%s', status)
                    return self._fallback_from_cache(
                        now=now,
                        reason='jangar_http_error',
                    )
                payload = response.read().decode("utf-8")
        except ValueError as exc:
            message = str(exc)
            reason = 'jangar_url_invalid_scheme'
            if message == 'missing_url_host':
                reason = 'jangar_url_invalid_host'
            logger.warning('Invalid Jangar symbols URL: %s', message)
            return self._fallback_from_cache(
                now=now,
                reason=reason,
            )
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
