"""Market-context client for Jangar decision-time context bundles."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from http.client import HTTPConnection, HTTPSConnection
from typing import Any, Optional, cast
from urllib.parse import urlencode, urlsplit

from ..config import settings
from .llm.schema import MarketContextBundle

logger = logging.getLogger(__name__)

_BLOCKING_RISK_FLAGS = {
    "market_context_stale",
    "market_context_quality_low",
    "market_context_disabled",
    "fundamentals_error",
    "news_error",
    "technicals_error",
    "regime_error",
    "technicals_source_error",
    "regime_source_error",
    "market_context_domain_error",
}

_REASON_PRIORITY = [
    "market_context_required_missing",
    "market_context_fetch_error",
    "market_context_disabled",
    "market_context_domain_error",
    "market_context_stale",
    "market_context_quality_low",
]


@dataclass(frozen=True)
class MarketContextStatus:
    allow_llm: bool
    reason: Optional[str]
    risk_flags: list[str]


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
        raise RuntimeError(f'market_context_invalid_url_scheme:{scheme or "missing"}')
    if not parsed.hostname:
        raise RuntimeError('market_context_invalid_url_host')
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


class MarketContextClient:
    """HTTP client to fetch Jangar market-context bundles."""

    def __init__(self) -> None:
        self._base_url = (settings.trading_market_context_url or "").strip()
        self._timeout_seconds = max(settings.trading_market_context_timeout_seconds, 1)

    def fetch(self, symbol: str) -> Optional[MarketContextBundle]:
        if not self._base_url:
            return None

        query = urlencode({"symbol": symbol})
        url = self._base_url
        delimiter = "&" if "?" in url else "?"
        request_url = f'{url}{delimiter}{query}'
        request = _HttpRequest(
            full_url=request_url,
            method='GET',
            headers={'accept': 'application/json'},
        )
        payload = ''
        with urlopen(request, self._timeout_seconds) as response:
            raw_status = getattr(response, 'status', 200)
            status = raw_status if isinstance(raw_status, int) else 200
            if status < 200 or status >= 300:
                raise RuntimeError(f'market_context_http_{status}')
            payload = response.read().decode('utf-8')
        data = json.loads(payload)
        if not isinstance(data, dict):
            raise RuntimeError("market_context_invalid_payload")
        payload_dict = cast(dict[str, Any], data)
        if payload_dict.get("ok") is not True:
            message = payload_dict.get("message") or "market_context_request_failed"
            raise RuntimeError(str(message))
        context = payload_dict.get("context")
        if not isinstance(context, dict):
            raise RuntimeError("market_context_missing_context")
        return MarketContextBundle.model_validate(context)


def evaluate_market_context(bundle: Optional[MarketContextBundle]) -> MarketContextStatus:
    """Evaluate market context against deterministic quality/staleness policy."""

    if bundle is None:
        if settings.trading_market_context_required:
            return MarketContextStatus(allow_llm=False, reason="market_context_required_missing", risk_flags=[])
        return MarketContextStatus(allow_llm=True, reason=None, risk_flags=[])

    risk_flags = sorted(set(bundle.risk_flags))
    domain_states = {
        "technicals": bundle.domains.technicals.state,
        "fundamentals": bundle.domains.fundamentals.state,
        "news": bundle.domains.news.state,
        "regime": bundle.domains.regime.state,
    }
    blocking_flags = [flag for flag in risk_flags if flag in _BLOCKING_RISK_FLAGS]
    if any(state == "error" for state in domain_states.values()):
        risk_flags.append("market_context_domain_error")
        blocking_flags.append("market_context_domain_error")
    if bundle.freshness_seconds > settings.trading_market_context_max_staleness_seconds:
        risk_flags.append("market_context_stale")
        blocking_flags.append("market_context_stale")
    if bundle.quality_score < settings.trading_market_context_min_quality:
        risk_flags.append("market_context_quality_low")
        blocking_flags.append("market_context_quality_low")

    if blocking_flags:
        unique_blocking_flags = sorted(set(blocking_flags))
        reason = next(
            (candidate for candidate in _REASON_PRIORITY if candidate in unique_blocking_flags),
            unique_blocking_flags[0],
        )
        return MarketContextStatus(
            allow_llm=False,
            reason=reason,
            risk_flags=sorted(set(risk_flags)),
        )
    return MarketContextStatus(allow_llm=True, reason=None, risk_flags=sorted(set(risk_flags)))


__all__ = ["MarketContextClient", "MarketContextStatus", "evaluate_market_context"]
