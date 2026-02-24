"""LLM review engine for trading decisions."""

from __future__ import annotations

import json
import time
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
import hashlib
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
    MarketContextBundle,
    MarketSnapshot,
    PortfolioSnapshot,
    RecentDecisionSummary,
    LLMCommitteeMemberResponse,
    LLMCommitteeTrace,
    LLMReviewResponse,
)

_SYSTEM_PROMPT = (
    "You are an automated trading review agent. "
    "Respond ONLY with a JSON object matching the required schema. "
    "Decide whether to approve, veto, adjust, abstain, or escalate the decision. "
    "Always provide calibrated per-verdict probabilities that sum to 1.0. "
    "Always provide confidence and uncertainty bands. "
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
_COMMITTEE_ROLES = {
    "researcher",
    "risk_critic",
    "execution_critic",
    "policy_judge",
}
_MANDATORY_COMMITTEE_ROLES = {"risk_critic", "execution_critic", "policy_judge"}


@dataclass
class LLMReviewOutcome:
    request_json: dict[str, Any]
    response_json: dict[str, Any]
    response: LLMReviewResponse
    model: str
    prompt_version: str
    tokens_prompt: Optional[int]
    tokens_completion: Optional[int]
    request_hash: str
    response_hash: str


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
        market_context: Optional[MarketContextBundle] = None,
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
                market_context,
                recent_decisions,
            )
        request_json = request.model_dump(mode="json")
        if settings.llm_committee_enabled:
            response, tokens_prompt, tokens_completion = self._review_with_committee(
                request_json
            )
        else:
            response, tokens_prompt, tokens_completion = self._review_single(
                request_json
            )

        response_json = response.model_dump(mode="json")
        request_hash = _hash_payload(request_json)
        response_hash = _hash_payload(response_json)

        return LLMReviewOutcome(
            request_json=request_json,
            response_json=response_json,
            response=response,
            model=self.model,
            prompt_version=self.prompt_version,
            tokens_prompt=tokens_prompt,
            tokens_completion=tokens_completion,
            request_hash=request_hash,
            response_hash=response_hash,
        )

    def _review_single(
        self, request_json: dict[str, Any]
    ) -> tuple[LLMReviewResponse, Optional[int], Optional[int]]:
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
        return response, tokens_prompt, tokens_completion

    def _review_with_committee(
        self, request_json: dict[str, Any]
    ) -> tuple[LLMReviewResponse, Optional[int], Optional[int]]:
        role_outputs: dict[str, LLMCommitteeMemberResponse] = {}
        schema_error_count = 0
        tokens_prompt_total = 0
        tokens_completion_total = 0

        configured_roles = [
            role
            for role in settings.llm_committee_roles
            if role in _COMMITTEE_ROLES
        ]
        roles = configured_roles or [
            "researcher",
            "risk_critic",
            "execution_critic",
            "policy_judge",
        ]

        mandatory_roles = [
            role
            for role in settings.llm_committee_mandatory_roles
            if role in _MANDATORY_COMMITTEE_ROLES
        ]
        if not mandatory_roles:
            mandatory_roles = ["risk_critic", "execution_critic", "policy_judge"]

        for role in roles:
            started = time.monotonic()
            try:
                raw = self.client.request_review(
                    messages=[
                        {"role": "system", "content": _committee_system_prompt(role)},
                        {
                            "role": "user",
                            "content": (
                                "Review the following trade decision and respond with JSON "
                                "matching the schema described.\n\n"
                                + json.dumps(request_json, separators=(",", ":"))
                            ),
                        },
                    ],
                    temperature=self.temperature,
                    max_tokens=self.max_tokens,
                )
                parsed = _parse_json_object(raw.content or "")
                parsed["role"] = role
                member = LLMCommitteeMemberResponse.model_validate(parsed)
                member.latency_ms = int((time.monotonic() - started) * 1000)
                role_outputs[role] = member
                usage = raw.usage or {}
                tokens_prompt_total += _coerce_int(usage.get("prompt_tokens")) or 0
                tokens_completion_total += (
                    _coerce_int(usage.get("completion_tokens")) or 0
                )
            except Exception:
                schema_error_count += 1
                role_outputs[role] = LLMCommitteeMemberResponse(
                    role=cast(
                        Any,
                        role,
                    ),
                    verdict=settings.llm_committee_fail_closed_verdict,
                    confidence=0.0,
                    uncertainty="high",
                    rationale_short="committee_role_schema_error",
                    required_checks=[],
                    latency_ms=int((time.monotonic() - started) * 1000),
                    schema_error=True,
                )

        committee_trace = LLMCommitteeTrace(
            roles=cast(dict[Any, LLMCommitteeMemberResponse], role_outputs),
            mandatory_roles=cast(list[Any], mandatory_roles),
            fail_closed_verdict=settings.llm_committee_fail_closed_verdict,
            schema_error_count=schema_error_count,
        )

        aggregate = _aggregate_committee(
            role_outputs=role_outputs,
            mandatory_roles=mandatory_roles,
            fail_closed_verdict=settings.llm_committee_fail_closed_verdict,
        )
        aggregate["committee"] = committee_trace.model_dump(mode="json")
        response = LLMReviewResponse.model_validate(aggregate)
        return response, tokens_prompt_total, tokens_completion_total

    def build_request(
        self,
        decision: StrategyDecision,
        account: dict[str, str],
        positions: list[dict[str, Any]],
        portfolio: PortfolioSnapshot,
        market: Optional[MarketSnapshot],
        market_context: Optional[MarketContextBundle],
        recent_decisions: list[RecentDecisionSummary],
        adjustment_allowed: Optional[bool] = None,
    ) -> LLMReviewRequest:
        effective_adjustment_allowed = (
            settings.llm_adjustment_allowed if adjustment_allowed is None else adjustment_allowed
        )
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
            market_context=market_context,
            recent_decisions=recent_decisions,
            account=sanitized_account,
            positions=sanitized_positions,
            policy=LLMPolicyContext(
                adjustment_allowed=effective_adjustment_allowed,
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

    normalized = _normalize_response_verdict(payload)
    confidence = _clamp01(normalized.get("confidence"))
    normalized = _ensure_confidence_fields(normalized, confidence)
    confidence_band = _normalize_confidence_band(
        normalized.get("confidence_band"), confidence
    )
    normalized = _set_payload_value(normalized, "confidence_band", confidence_band)
    normalized = _ensure_uncertainty_fields(
        normalized,
        confidence=confidence,
        confidence_band=confidence_band,
    )
    normalized = _ensure_calibration_fields(normalized, confidence=confidence)
    normalized = _normalize_escalation_fields(normalized)
    normalized = _set_default_risk_flags(normalized)
    return _normalize_rationale_fields(normalized)


def _normalize_response_verdict(payload: dict[str, Any]) -> dict[str, Any]:
    normalized = payload
    if "verdict" not in normalized and "decision" in normalized:
        moved = dict(normalized)
        moved["verdict"] = moved.pop("decision")
        normalized = moved
    if "verdict" not in normalized:
        return normalized
    verdict = str(normalized["verdict"]).strip().lower()
    aliases = {
        "escalate_to_human": "escalate",
        "escalate_human": "escalate",
        "defer": "abstain",
        "hold": "abstain",
    }
    return _set_payload_value(normalized, "verdict", aliases.get(verdict, verdict))


def _ensure_confidence_fields(payload: dict[str, Any], confidence: float) -> dict[str, Any]:
    normalized = payload
    if "confidence" not in normalized:
        normalized = _set_payload_value(normalized, "confidence", 0.5)
    if "confidence_band" not in normalized:
        normalized = _set_payload_value(
            normalized,
            "confidence_band",
            _confidence_band_from_score(confidence),
        )
    return normalized


def _ensure_uncertainty_fields(
    payload: dict[str, Any],
    *,
    confidence: float,
    confidence_band: str,
) -> dict[str, Any]:
    if "uncertainty" in payload:
        return payload
    return _set_payload_value(
        payload,
        "uncertainty",
        {
            "score": round(1.0 - confidence, 4),
            "band": _uncertainty_band_from_confidence_band(confidence_band),
        },
    )


def _ensure_calibration_fields(payload: dict[str, Any], *, confidence: float) -> dict[str, Any]:
    normalized = payload
    if "calibrated_probabilities" not in normalized:
        normalized = _set_payload_value(
            normalized,
            "calibrated_probabilities",
            _default_calibrated_probabilities(
                str(normalized.get("verdict") or ""),
                confidence,
            ),
        )
    if "calibration_metadata" not in normalized:
        normalized = _set_payload_value(normalized, "calibration_metadata", {})
    return normalized


def _normalize_escalation_fields(payload: dict[str, Any]) -> dict[str, Any]:
    if "escalate_reason" in payload or "escalation_reason" not in payload:
        return payload
    return _set_payload_value(
        payload,
        "escalate_reason",
        payload.get("escalation_reason"),
    )


def _set_default_risk_flags(payload: dict[str, Any]) -> dict[str, Any]:
    if "risk_flags" in payload:
        return payload
    return _set_payload_value(payload, "risk_flags", [])


def _normalize_rationale_fields(payload: dict[str, Any]) -> dict[str, Any]:
    rationale = payload.get("rationale")
    rationale_short = payload.get("rationale_short")
    normalized = payload
    if not rationale and isinstance(rationale_short, str):
        normalized = _set_payload_value(normalized, "rationale", rationale_short)
    if not rationale_short and isinstance(rationale, str):
        normalized = _set_payload_value(normalized, "rationale_short", rationale)
    return normalized


def _set_payload_value(payload: dict[str, Any], key: str, value: Any) -> dict[str, Any]:
    if payload.get(key) == value:
        return payload
    updated = dict(payload)
    updated[key] = value
    return updated


def _committee_system_prompt(role: str) -> str:
    role_instructions: dict[str, str] = {
        "researcher": "Explain thesis quality and expected edge.",
        "risk_critic": "Stress-test downside and risk/policy violations.",
        "execution_critic": "Check feasibility under market microstructure and execution constraints.",
        "policy_judge": "Validate schema, confidence calibration, and required deterministic checks.",
    }
    role_instruction = role_instructions.get(role, "Provide bounded committee review.")
    return (
        "You are an automated trading committee member. "
        f"Role: {role}. {role_instruction} "
        "Output must be advisory-only and cannot directly execute trades. "
        "Respond ONLY with a JSON object containing exactly these keys: "
        "verdict, confidence, uncertainty, rationale_short, required_checks, adjusted_qty, adjusted_order_type, "
        "limit_price, risk_flags. "
        "verdict must be one of approve|adjust|veto|abstain|escalate. "
        "confidence must be between 0 and 1. uncertainty must be low|medium|high. "
        "rationale_short must be <= 280 chars. required_checks must list deterministic policy check IDs. "
        "Do not include chain-of-thought or extra keys."
    )


def _aggregate_committee(
    *,
    role_outputs: dict[str, LLMCommitteeMemberResponse],
    mandatory_roles: list[str],
    fail_closed_verdict: str,
) -> dict[str, Any]:
    aggregated_checks = _aggregate_committee_checks(role_outputs)
    aggregated_risk_flags = _aggregate_committee_risk_flags(role_outputs)
    if _committee_has_mandatory_veto(role_outputs, mandatory_roles):
        return _mandatory_committee_veto_payload(
            required_checks=aggregated_checks,
            risk_flags=aggregated_risk_flags,
        )

    verdict = _committee_verdict(role_outputs, fail_closed_verdict=fail_closed_verdict)
    confidence = _committee_confidence(role_outputs)
    uncertainty_band = _committee_uncertainty_band(role_outputs)
    adjusted_qty, adjusted_order_type, limit_price = _committee_adjustment_fields(
        role_outputs
    )
    verdict, adjusted_qty, adjusted_order_type, limit_price = _validate_adjustment_payload(
        verdict=verdict,
        adjusted_qty=adjusted_qty,
        adjusted_order_type=adjusted_order_type,
        limit_price=limit_price,
        fail_closed_verdict=fail_closed_verdict,
    )
    return _committee_payload(
        verdict=verdict,
        confidence=confidence,
        uncertainty_band=uncertainty_band,
        adjusted_qty=adjusted_qty,
        adjusted_order_type=adjusted_order_type,
        limit_price=limit_price,
        required_checks=aggregated_checks,
        risk_flags=aggregated_risk_flags,
    )


def _aggregate_committee_checks(
    role_outputs: dict[str, LLMCommitteeMemberResponse],
) -> list[str]:
    return sorted(
        {
            check
            for item in role_outputs.values()
            for check in item.required_checks
        }
    )


def _aggregate_committee_risk_flags(
    role_outputs: dict[str, LLMCommitteeMemberResponse],
) -> list[str]:
    return sorted(
        {
            flag
            for item in role_outputs.values()
            for flag in item.risk_flags
        }
    )


def _committee_has_mandatory_veto(
    role_outputs: dict[str, LLMCommitteeMemberResponse],
    mandatory_roles: list[str],
) -> bool:
    return any(
        role_outputs.get(role) is None or role_outputs[role].verdict == "veto"
        for role in mandatory_roles
    )


def _mandatory_committee_veto_payload(
    *,
    required_checks: list[str],
    risk_flags: list[str],
) -> dict[str, Any]:
    verdict = "veto"
    confidence = 1.0
    rationale = "mandatory_committee_veto"
    return {
        "verdict": verdict,
        "confidence": confidence,
        "confidence_band": "high",
        "calibrated_probabilities": _default_calibrated_probabilities(verdict, confidence),
        "uncertainty": {"score": 0.0, "band": "low"},
        "calibration_metadata": {},
        "rationale_short": rationale,
        "required_checks": required_checks,
        "rationale": rationale,
        "risk_flags": sorted([*risk_flags, "mandatory_committee_veto"]),
    }


def _committee_verdict(
    role_outputs: dict[str, LLMCommitteeMemberResponse],
    *,
    fail_closed_verdict: str,
) -> str:
    votes = [member.verdict for member in role_outputs.values()]
    if any(vote == "escalate" for vote in votes):
        return "escalate"
    if any(vote == "abstain" for vote in votes):
        return fail_closed_verdict
    if any(vote == "adjust" for vote in votes):
        return "adjust"
    if any(vote == "approve" for vote in votes):
        return "approve"
    return fail_closed_verdict


def _committee_confidence(role_outputs: dict[str, LLMCommitteeMemberResponse]) -> float:
    confidence_values = [member.confidence for member in role_outputs.values()]
    if not confidence_values:
        return 0.0
    return round(sum(confidence_values) / len(confidence_values), 4)


def _committee_uncertainty_band(
    role_outputs: dict[str, LLMCommitteeMemberResponse],
) -> str:
    uncertainty_rank = {"low": 1, "medium": 2, "high": 3}
    uncertainty = "low"
    for member in role_outputs.values():
        if uncertainty_rank[member.uncertainty] > uncertainty_rank[uncertainty]:
            uncertainty = member.uncertainty
    return uncertainty


def _committee_adjustment_fields(
    role_outputs: dict[str, LLMCommitteeMemberResponse],
) -> tuple[Decimal | None, str | None, Decimal | None]:
    adjusted_source = next(
        (member for member in role_outputs.values() if member.verdict == "adjust"),
        None,
    )
    if adjusted_source is None:
        return None, None, None
    return (
        adjusted_source.adjusted_qty,
        adjusted_source.adjusted_order_type,
        adjusted_source.limit_price,
    )


def _validate_adjustment_payload(
    *,
    verdict: str,
    adjusted_qty: Decimal | None,
    adjusted_order_type: str | None,
    limit_price: Decimal | None,
    fail_closed_verdict: str,
) -> tuple[str, Decimal | None, str | None, Decimal | None]:
    if verdict != "adjust":
        return verdict, adjusted_qty, adjusted_order_type, limit_price
    if adjusted_qty is None:
        return fail_closed_verdict, None, None, None
    if adjusted_order_type in {"limit", "stop_limit"} and limit_price is None:
        return fail_closed_verdict, None, None, None
    return verdict, adjusted_qty, adjusted_order_type, limit_price


def _committee_payload(
    *,
    verdict: str,
    confidence: float,
    uncertainty_band: str,
    adjusted_qty: Decimal | None,
    adjusted_order_type: str | None,
    limit_price: Decimal | None,
    required_checks: list[str],
    risk_flags: list[str],
) -> dict[str, Any]:
    rationale = f"committee_aggregate_{verdict}"
    payload: dict[str, Any] = {
        "verdict": verdict,
        "confidence": confidence,
        "confidence_band": _confidence_band_from_score(confidence),
        "calibrated_probabilities": _default_calibrated_probabilities(verdict, confidence),
        "uncertainty": {"score": round(1.0 - confidence, 4), "band": uncertainty_band},
        "calibration_metadata": {},
        "rationale_short": rationale,
        "required_checks": required_checks,
        "adjusted_qty": adjusted_qty,
        "adjusted_order_type": adjusted_order_type,
        "limit_price": limit_price,
        "rationale": rationale,
        "risk_flags": risk_flags,
    }
    if verdict == "escalate":
        payload["escalate_reason"] = "committee_requested_escalation"
    return payload


def _clamp01(value: Any) -> float:
    try:
        score = float(value)
    except (TypeError, ValueError):
        return 0.5
    return min(1.0, max(0.0, score))


def _confidence_band_from_score(confidence: float) -> str:
    if confidence >= 0.75:
        return "high"
    if confidence >= 0.5:
        return "medium"
    return "low"


def _normalize_confidence_band(confidence_band: Any, confidence: float) -> str:
    aliases = {
        "l": "low",
        "low-confidence": "low",
        "low_confidence": "low",
        "m": "medium",
        "med": "medium",
        "mid": "medium",
        "moderate": "medium",
        "medium-confidence": "medium",
        "medium_confidence": "medium",
        "h": "high",
        "high-confidence": "high",
        "high_confidence": "high",
    }
    normalized = aliases.get(str(confidence_band or "").strip().lower(), str(confidence_band or "").strip().lower())
    if normalized in {"low", "medium", "high"}:
        return normalized
    return _confidence_band_from_score(confidence)


def _uncertainty_band_from_confidence_band(confidence_band: str) -> str:
    if confidence_band == "high":
        return "low"
    if confidence_band == "medium":
        return "medium"
    return "high"


def _default_calibrated_probabilities(verdict: str, confidence: float) -> dict[str, float]:
    labels = ["approve", "veto", "adjust", "abstain", "escalate"]
    picked = verdict if verdict in labels else "abstain"
    remainder = max(0.0, 1.0 - confidence)
    background = remainder / 4.0
    probabilities = {label: background for label in labels}
    probabilities[picked] = confidence
    total = sum(probabilities.values())
    if total <= 0:
        return {label: 0.2 for label in labels}
    return {label: round(score / total, 6) for label, score in probabilities.items()}


def _hash_payload(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


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
        if key == "price_snapshot" and isinstance(value, Mapping):
            sanitized[key] = _sanitize_nested(cast(Mapping[str, Any], value), _ALLOWED_PRICE_SNAPSHOT_KEYS)
        elif key == "imbalance" and isinstance(value, Mapping):
            sanitized[key] = _sanitize_nested(cast(Mapping[str, Any], value), _ALLOWED_IMBALANCE_KEYS)
        elif key == "sizing" and isinstance(value, Mapping):
            sanitized[key] = _sanitize_nested(cast(Mapping[str, Any], value), _ALLOWED_SIZING_KEYS)
        else:
            sanitized[key] = value
    return sanitized


def _sanitize_nested(payload: Mapping[str, Any], allowed_keys: set[str]) -> dict[str, Any]:
    return {key: payload[key] for key in allowed_keys if key in payload and payload[key] is not None}
