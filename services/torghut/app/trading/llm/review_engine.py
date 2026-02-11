"""LLM review engine for trading decisions."""

from __future__ import annotations

import json
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any, Optional, cast

from openai.types.chat import ChatCompletionMessageParam
from pydantic import ValidationError

from ...config import settings
from ..models import StrategyDecision
from .client import LLMClient
from .circuit import LLMCircuitBreaker
from .policy import allowed_order_types
from .schema import (
    LLMDecisionContext,
    LLMPolicyContext,
    LLMReviewRequest,
    MarketSnapshot,
    PortfolioSnapshot,
    RecentDecisionSummary,
    LLMReviewResponse,
)

_SYSTEM_PROMPT = (
    "You are an automated trading review agent. "
    "Respond ONLY with a JSON object matching the required schema. "
    "Decide whether to approve, veto, or adjust the decision. "
    "If adjusting, propose qty and optionally order_type within policy bounds. "
    "If adjusting order_type to limit or stop_limit, include limit_price. "
    "Provide a concise rationale (<= 280 chars). "
    "Do not include chain-of-thought or extra keys."
)

_ALLOWED_DECISION_PARAMS = {
    "macd",
    "macd_signal",
    "rsi",
    "price",
    "volatility",
    "spread",
    "price_snapshot",
    "imbalance",
    "sizing",
}
_ALLOWED_PRICE_SNAPSHOT_KEYS = {"as_of", "price", "spread", "source"}
_ALLOWED_IMBALANCE_KEYS = {"spread"}
_ALLOWED_SIZING_KEYS = {"method", "notional_budget", "price", "reason"}
_ALLOWED_ACCOUNT_KEYS = {"equity", "cash", "buying_power"}
_ALLOWED_POSITION_KEYS = {
    "symbol",
    "qty",
    "side",
    "market_value",
    "avg_entry_price",
    "current_price",
    "unrealized_pl",
    "unrealized_plpc",
    "cost_basis",
}


@dataclass
class LLMReviewOutcome:
    request_json: dict[str, Any]
    response_json: dict[str, Any]
    response: LLMReviewResponse
    model: str
    prompt_version: str
    tokens_prompt: Optional[int]
    tokens_completion: Optional[int]


class LLMReviewEngine:
    """Build the LLM prompt, call the client, and validate the response."""

    def __init__(
        self,
        client: Optional[LLMClient] = None,
        model: Optional[str] = None,
        prompt_version: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        circuit_breaker: Optional[LLMCircuitBreaker] = None,
    ) -> None:
        self.model = model or settings.llm_model
        self.prompt_version = prompt_version or settings.llm_prompt_version
        self.temperature = temperature if temperature is not None else settings.llm_temperature
        self.max_tokens = max_tokens if max_tokens is not None else settings.llm_max_tokens
        self.client = client or LLMClient(self.model, settings.llm_timeout_seconds)
        self.circuit_breaker = circuit_breaker or LLMCircuitBreaker.from_settings()
        self.system_prompt = load_prompt_template(self.prompt_version)

    def review(
        self,
        decision: StrategyDecision,
        account: dict[str, str],
        positions: list[dict[str, Any]],
        request: Optional[LLMReviewRequest] = None,
        portfolio: Optional[PortfolioSnapshot] = None,
        market: Optional[MarketSnapshot] = None,
        recent_decisions: Optional[list[RecentDecisionSummary]] = None,
    ) -> LLMReviewOutcome:
        if request is None:
            if portfolio is None:
                raise ValueError("llm_request_missing_portfolio")
            if recent_decisions is None:
                recent_decisions = []
            request = self.build_request(
                decision,
                account,
                positions,
                portfolio,
                market,
                recent_decisions,
            )
        request_json = request.model_dump(mode="json")
        messages: list[ChatCompletionMessageParam] = [
            {"role": "system", "content": self.system_prompt},
            {
                "role": "user",
                "content": (
                    "Review the following trade decision and respond with JSON "
                    "matching the schema described.\n\n" + json.dumps(request_json, separators=(",", ":"))
                ),
            },
        ]

        raw = self.client.request_review(
            messages=messages,
            temperature=self.temperature,
            max_tokens=self.max_tokens,
        )

        content = raw.content or ""
        try:
            parsed = _parse_json_object(content)
        except json.JSONDecodeError as exc:
            raise ValueError("llm_response_not_json") from exc

        try:
            response = LLMReviewResponse.model_validate(parsed)
        except ValidationError as exc:
            raise ValueError("llm_response_invalid") from exc

        usage = raw.usage or {}
        tokens_prompt = _coerce_int(usage.get("prompt_tokens"))
        tokens_completion = _coerce_int(usage.get("completion_tokens"))

        return LLMReviewOutcome(
            request_json=request_json,
            response_json=response.model_dump(mode="json"),
            response=response,
            model=self.model,
            prompt_version=self.prompt_version,
            tokens_prompt=tokens_prompt,
            tokens_completion=tokens_completion,
        )

    def build_request(
        self,
        decision: StrategyDecision,
        account: dict[str, str],
        positions: list[dict[str, Any]],
        portfolio: PortfolioSnapshot,
        market: Optional[MarketSnapshot],
        recent_decisions: list[RecentDecisionSummary],
    ) -> LLMReviewRequest:
        sanitized_account = _sanitize_account(account)
        sanitized_positions = _sanitize_positions(positions)
        sanitized_params = _sanitize_decision_params(decision.params or {})
        return LLMReviewRequest(
            decision=LLMDecisionContext(
                strategy_id=decision.strategy_id,
                symbol=decision.symbol,
                action=decision.action,
                qty=decision.qty,
                order_type=decision.order_type,
                time_in_force=decision.time_in_force,
                event_ts=decision.event_ts,
                timeframe=decision.timeframe,
                rationale=decision.rationale,
                params=sanitized_params,
            ),
            portfolio=portfolio,
            market=market,
            recent_decisions=recent_decisions,
            account=sanitized_account,
            positions=sanitized_positions,
            policy=LLMPolicyContext(
                adjustment_allowed=settings.llm_adjustment_allowed,
                min_qty_multiplier=Decimal(str(settings.llm_min_qty_multiplier)),
                max_qty_multiplier=Decimal(str(settings.llm_max_qty_multiplier)),
                allowed_order_types=sorted(allowed_order_types(decision.order_type)),
            ),
            trading_mode=settings.trading_mode,
            prompt_version=self.prompt_version,
        )


def _coerce_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


__all__ = ["LLMReviewEngine", "LLMReviewOutcome"]


def _parse_json_object(content: str) -> dict[str, Any]:
    """Parse the first JSON object from an LLM response.

    Jangar streams may include gateway-injected preambles (e.g. rate limit notes)
    before the JSON payload. We accept that and decode the first `{...}` block.
    """

    content = content.strip()
    if not content:
        raise json.JSONDecodeError("empty", content, 0)

    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        decoder = json.JSONDecoder()
        start = content.find("{")
        if start < 0:
            raise
        parsed, _ = decoder.raw_decode(content[start:])

    if not isinstance(parsed, dict):
        raise json.JSONDecodeError("expected_object", content, 0)

    return _normalize_llm_response_payload(cast(dict[str, Any], parsed))


def _normalize_llm_response_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Normalize common model mistakes into the expected response shape."""

    if "verdict" not in payload and "decision" in payload:
        payload = dict(payload)
        payload["verdict"] = payload.pop("decision")

    # Provide defaults for optional-ish fields; schema validation will still enforce
    # correct verdict and rationale.
    if "confidence" not in payload:
        payload = dict(payload)
        payload["confidence"] = 0.5
    if "risk_flags" not in payload:
        payload = dict(payload)
        payload["risk_flags"] = []

    return payload


def load_prompt_template(version: str) -> str:
    templates_dir = Path(__file__).resolve().parent / "prompt_templates"
    candidate = templates_dir / f"system_{version}.txt"
    if candidate.exists():
        return candidate.read_text(encoding="utf-8")
    return _SYSTEM_PROMPT


def _sanitize_account(account: dict[str, Any]) -> dict[str, str]:
    sanitized: dict[str, str] = {}
    for key in _ALLOWED_ACCOUNT_KEYS:
        value = account.get(key)
        if value is None:
            continue
        sanitized[key] = str(value)
    return sanitized


def _sanitize_positions(positions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    sanitized: list[dict[str, Any]] = []
    for position in positions:
        if not isinstance(position, dict):
            continue
        symbol = position.get("symbol")
        if not symbol:
            continue
        cleaned: dict[str, Any] = {"symbol": str(symbol)}
        for key in _ALLOWED_POSITION_KEYS:
            if key == "symbol":
                continue
            value = position.get(key)
            if value is None:
                continue
            cleaned[key] = value
        sanitized.append(cleaned)
    sanitized.sort(key=lambda item: item.get("symbol", ""))
    return sanitized


def _sanitize_decision_params(params: dict[str, Any]) -> dict[str, Any]:
    sanitized: dict[str, Any] = {}
    for key in _ALLOWED_DECISION_PARAMS:
        value = params.get(key)
        if value is None:
            continue
        if key == "price_snapshot" and isinstance(value, dict):
            sanitized[key] = _sanitize_nested(value, _ALLOWED_PRICE_SNAPSHOT_KEYS)
        elif key == "imbalance" and isinstance(value, dict):
            sanitized[key] = _sanitize_nested(value, _ALLOWED_IMBALANCE_KEYS)
        elif key == "sizing" and isinstance(value, dict):
            sanitized[key] = _sanitize_nested(value, _ALLOWED_SIZING_KEYS)
        else:
            sanitized[key] = value
    return sanitized


def _sanitize_nested(payload: dict[str, Any], allowed_keys: set[str]) -> dict[str, Any]:
    return {key: payload[key] for key in allowed_keys if key in payload and payload[key] is not None}
