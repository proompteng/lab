"""Market-context client for Jangar decision-time context bundles."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Optional, cast
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from ..config import settings
from .llm.schema import MarketContextBundle

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class MarketContextStatus:
    allow_llm: bool
    reason: Optional[str]
    risk_flags: list[str]


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
        request = Request(f"{url}{delimiter}{query}", headers={"accept": "application/json"})
        with urlopen(request, timeout=self._timeout_seconds) as response:
            payload = response.read().decode("utf-8")
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

    risk_flags = list(bundle.risk_flags)
    if bundle.freshness_seconds > settings.trading_market_context_max_staleness_seconds:
        risk_flags.append("market_context_stale")
    if bundle.quality_score < settings.trading_market_context_min_quality:
        risk_flags.append("market_context_quality_low")

    if risk_flags:
        return MarketContextStatus(
            allow_llm=False,
            reason=risk_flags[0],
            risk_flags=sorted(set(risk_flags)),
        )
    return MarketContextStatus(allow_llm=True, reason=None, risk_flags=[])


__all__ = ["MarketContextClient", "MarketContextStatus", "evaluate_market_context"]
