"""Shared configuration helpers for the Torghut service."""

import json
import logging
from dataclasses import dataclass
from functools import lru_cache
from http.client import HTTPConnection, HTTPSConnection
from typing import Any, Literal, Optional, cast
from urllib.parse import urlsplit

from pydantic import BaseModel

from ..logging_config import configure_logging

configure_logging()

logger = logging.getLogger(__name__)

FEATURE_FLAG_BOOLEAN_KEY_BY_FIELD: dict[str, str] = {
    "trading_enabled": "torghut_trading_enabled",
    "trading_crypto_enabled": "torghut_trading_crypto_enabled",
    "trading_crypto_live_enabled": "torghut_trading_crypto_live_enabled",
    "trading_order_feed_enabled": "torghut_trading_order_feed_enabled",
    "trading_multi_account_enabled": "torghut_trading_multi_account_enabled",
    "trading_strategy_scheduler_enabled": "torghut_trading_strategy_scheduler_enabled",
    "trading_feature_quality_enabled": "torghut_trading_feature_quality_enabled",
    "trading_autonomy_enabled": "torghut_trading_autonomy_enabled",
    "trading_autonomy_allow_live_promotion": "torghut_trading_autonomy_allow_live_promotion",
    "trading_evidence_continuity_enabled": "torghut_trading_evidence_continuity_enabled",
    "trading_universe_require_non_empty_jangar": "torghut_trading_universe_require_non_empty_jangar",
    "trading_universe_static_fallback_enabled": "torghut_trading_universe_static_fallback_enabled",
    "trading_readiness_dependency_cache_enabled": (
        "torghut_trading_readiness_dependency_cache_enabled"
    ),
    "trading_db_schema_graph_allow_divergence_roots": (
        "torghut_trading_db_schema_graph_allow_divergence_roots"
    ),
    "trading_execution_prefer_limit": "torghut_trading_execution_prefer_limit",
    "trading_allocator_enabled": "torghut_trading_allocator_enabled",
    "trading_forecast_router_enabled": "torghut_trading_forecast_router_enabled",
    "trading_forecast_router_refinement_enabled": "torghut_trading_forecast_router_refinement_enabled",
    "trading_drift_governance_enabled": "torghut_trading_drift_governance_enabled",
    "trading_drift_live_promotion_requires_evidence": "torghut_trading_drift_live_promotion_requires_evidence",
    "trading_drift_rollback_on_performance": "torghut_trading_drift_rollback_on_performance",
    "trading_execution_advisor_enabled": "torghut_trading_execution_advisor_enabled",
    "trading_execution_advisor_live_apply_enabled": "torghut_trading_execution_advisor_live_apply_enabled",
    "trading_alpaca_quote_fallback_enabled": "torghut_trading_alpaca_quote_fallback_enabled",
    "trading_alpaca_quote_fallback_market_session_required": (
        "torghut_trading_alpaca_quote_fallback_market_session_required"
    ),
    "trading_simulation_enabled": "torghut_trading_simulation_enabled",
    "trading_allow_shorts": "torghut_trading_allow_shorts",
    "trading_fractional_equities_enabled": "torghut_trading_fractional_equities_enabled",
    "trading_kill_switch_enabled": "torghut_trading_kill_switch_enabled",
    "trading_emergency_stop_enabled": "torghut_trading_emergency_stop_enabled",
    "trading_market_context_required": "torghut_trading_market_context_required",
    "llm_enabled": "torghut_llm_enabled",
    "llm_fail_open_live_approved": "torghut_llm_fail_open_live_approved",
    "llm_adjustment_allowed": "torghut_llm_adjustment_allowed",
    "llm_shadow_mode": "torghut_llm_shadow_mode",
    "llm_committee_enabled": "torghut_llm_committee_enabled",
    "llm_adjustment_approved": "torghut_llm_adjustment_approved",
    "posthog_enabled": "torghut_posthog_enabled",
}

LLM_COMMITTEE_ROLES = {
    "researcher",
    "risk_critic",
    "execution_critic",
    "policy_judge",
}


class TradingAccountLane(BaseModel):
    """Runtime trading-account lane configuration."""

    label: str
    mode: Literal["paper", "live"] = "paper"
    api_key: Optional[str] = None
    secret_key: Optional[str] = None
    base_url: Optional[str] = None
    enabled: bool = True


@dataclass(frozen=True)
class BooleanFeatureFlagRequest:
    endpoint: str
    namespace_key: str
    entity_id: str
    flag_key: str
    default_value: bool
    timeout_ms: int


@lru_cache(maxsize=1)
def dspy_bootstrap_artifact_hash() -> str | None:
    try:
        from ..trading.llm.dspy_programs.runtime import DSPyReviewRuntime
    except Exception:
        return None
    try:
        return DSPyReviewRuntime.bootstrap_artifact_hash()
    except Exception:
        return None


def _http_connection_for_url(
    url: str, *, timeout_seconds: float
) -> tuple[HTTPConnection | HTTPSConnection, str]:
    parsed = urlsplit(url)
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        raise ValueError(f"unsupported_url_scheme:{scheme or 'missing'}")
    if not parsed.hostname:
        raise ValueError("missing_url_host")
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    connection_class = HTTPSConnection if scheme == "https" else HTTPConnection
    return connection_class(parsed.hostname, parsed.port, timeout=timeout_seconds), path


class _HttpRequest:
    def __init__(
        self,
        *,
        full_url: str,
        method: str,
        data: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.full_url = full_url
        self.method = method
        self.data = data
        self._headers = dict(headers or {})

    def header_items(self) -> list[tuple[str, str]]:
        return list(self._headers.items())

    @property
    def headers(self) -> dict[str, str]:
        return dict(self._headers)


class _HttpResponseHandle:
    def __init__(
        self, connection: HTTPConnection | HTTPSConnection, response: Any
    ) -> None:
        self._connection = connection
        self._response = response
        self.status = int(getattr(response, "status", 200))

    def read(self) -> bytes:
        return cast(bytes, self._response.read())

    def close(self) -> None:
        self._connection.close()

    def __enter__(self) -> "_HttpResponseHandle":
        return self

    def __exit__(self, _exc_type: Any, _exc: Any, _tb: Any) -> bool:
        self.close()
        return False


def urlopen(request: _HttpRequest, timeout: float) -> _HttpResponseHandle:
    connection, request_path = _http_connection_for_url(
        request.full_url,
        timeout_seconds=max(timeout, 0.001),
    )
    try:
        connection.request(
            request.method, request_path, body=request.data, headers=request.headers
        )
        response = connection.getresponse()
    except Exception:
        connection.close()
        raise
    return _HttpResponseHandle(connection, response)


def _build_boolean_feature_flag_request(
    request: BooleanFeatureFlagRequest,
) -> tuple[_HttpRequest, float]:
    payload = json.dumps(
        {
            "namespaceKey": request.namespace_key,
            "flagKey": request.flag_key,
            "entityId": request.entity_id,
            "context": {},
        }
    ).encode("utf-8")
    request_url = f"{request.endpoint.rstrip('/')}/evaluate/v1/boolean"
    timeout_seconds = max(request.timeout_ms, 1) / 1000.0
    return (
        _HttpRequest(
            full_url=request_url,
            method="POST",
            data=payload,
            headers={
                "accept": "application/json",
                "content-type": "application/json",
            },
        ),
        timeout_seconds,
    )


def _feature_flag_default(request: BooleanFeatureFlagRequest) -> tuple[bool, bool]:
    return request.default_value, False


def _parse_boolean_feature_flag_response(
    *,
    request: BooleanFeatureFlagRequest,
    status: int,
    body_bytes: bytes,
) -> tuple[bool, bool]:
    if status < 200 or status >= 300:
        logger.warning(
            "Feature flag resolve HTTP failure for key=%s status=%s; using default.",
            request.flag_key,
            status,
        )
        return _feature_flag_default(request)
    raw_body = json.loads(body_bytes.decode("utf-8"))
    if not isinstance(raw_body, dict):
        logger.warning(
            "Feature flag resolve invalid response for key=%s; using default.",
            request.flag_key,
        )
        return _feature_flag_default(request)
    body = cast(dict[str, object], raw_body)
    enabled = body.get("enabled")
    if not isinstance(enabled, bool):
        logger.warning(
            "Feature flag resolve missing boolean `enabled` for key=%s; using default.",
            request.flag_key,
        )
        return _feature_flag_default(request)
    return enabled, True


def resolve_boolean_feature_flag(
    request: BooleanFeatureFlagRequest,
) -> tuple[bool, bool]:
    http_request, timeout_seconds = _build_boolean_feature_flag_request(request)
    try:
        with urlopen(http_request, timeout_seconds) as response:
            return _parse_boolean_feature_flag_response(
                request=request,
                status=int(getattr(response, "status", 200)),
                body_bytes=response.read(),
            )
    except ValueError:
        logger.warning(
            "Feature flag resolve invalid endpoint for key=%s endpoint=%s; using default.",
            request.flag_key,
            request.endpoint,
        )
        return _feature_flag_default(request)
    except Exception:
        logger.warning(
            "Feature flag resolve failed for key=%s; using default.", request.flag_key
        )
        return _feature_flag_default(request)
    return _feature_flag_default(request)


__all__ = [
    "FEATURE_FLAG_BOOLEAN_KEY_BY_FIELD",
    "LLM_COMMITTEE_ROLES",
    "BooleanFeatureFlagRequest",
    "TradingAccountLane",
    "dspy_bootstrap_artifact_hash",
    "logger",
    "resolve_boolean_feature_flag",
    "urlopen",
]
