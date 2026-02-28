"""LLM review engine for trading decisions."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Optional, cast

from ...config import settings
from ..models import StrategyDecision
from .circuit import LLMCircuitBreaker
from .dspy_programs import DSPyReviewRuntime, DSPyRuntimeError
from .policy import allowed_order_types
from .schema import (
    LLMDecisionContext,
    LLMRegimeHMMContext,
    LLMPolicyContext,
    LLMReviewRequest,
    LLMReviewResponse,
    MarketContextBundle,
    MarketSnapshot,
    PortfolioSnapshot,
    RecentDecisionSummary,
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
    "regime_hmm",
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
_ALLOWED_LLM_REGIME_HMM_KEYS = {
    "regime_id",
    "entropy_band",
    "predicted_next",
    "artifact_version",
    "guardrail_reason",
}
_LLM_REGIME_ENTROPY_BANDS = {"low", "medium", "high"}

_SAFE_FALLBACK_CHECKS = ["execution_policy", "order_firewall", "risk_engine"]


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
    """Build review payloads, execute DSPy runtime, and persist auditable outcomes."""

    def __init__(
        self,
        model: Optional[str] = None,
        prompt_version: Optional[str] = None,
        circuit_breaker: Optional[LLMCircuitBreaker] = None,
        dspy_runtime: Optional[DSPyReviewRuntime] = None,
    ) -> None:
        self.model = model or f"dspy:{settings.llm_dspy_program_name}"
        self.prompt_version = (
            prompt_version or f"dspy:{settings.llm_dspy_signature_version}"
        )
        self.circuit_breaker = circuit_breaker or LLMCircuitBreaker.from_settings()
        self.dspy_runtime = dspy_runtime or DSPyReviewRuntime.from_settings()

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
        used_model = self.model
        used_prompt_version = self.prompt_version

        try:
            response, metadata = self.dspy_runtime.review(request)
            response_json = response.model_dump(mode="json")
            response_json["dspy"] = metadata.to_payload()
            used_model = f"dspy:{metadata.program_name}"
            used_prompt_version = f"dspy:{metadata.signature_version}"
        except DSPyRuntimeError as exc:
            response, dspy_payload = _deterministic_fallback_response(
                runtime=self.dspy_runtime,
                error=str(exc),
            )
            response_json = response.model_dump(mode="json")
            response_json["dspy"] = dspy_payload
            used_model = f"dspy:{self.dspy_runtime.program_name}"
            used_prompt_version = f"dspy:{self.dspy_runtime.signature_version}"

        request_hash = _hash_payload(request_json)
        response_hash = _hash_payload(response_json)

        return LLMReviewOutcome(
            request_json=request_json,
            response_json=response_json,
            response=response,
            model=used_model,
            prompt_version=used_prompt_version,
            tokens_prompt=None,
            tokens_completion=None,
            request_hash=request_hash,
            response_hash=response_hash,
        )

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
            settings.llm_adjustment_allowed
            if adjustment_allowed is None
            else adjustment_allowed
        )
        sanitized_account = _sanitize_account(account)
        sanitized_positions = _sanitize_positions(positions)
        sanitized_params = _sanitize_decision_params(decision.params or {})
        regime_hmm = _extract_regime_hmm_context(sanitized_params.get("regime_hmm"))
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
                regime_hmm=regime_hmm,
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


__all__ = ["LLMReviewEngine", "LLMReviewOutcome"]


def _deterministic_fallback_response(
    *, runtime: DSPyReviewRuntime, error: str
) -> tuple[LLMReviewResponse, dict[str, Any]]:
    response = LLMReviewResponse.model_validate(
        {
            "verdict": "veto",
            "confidence": 1.0,
            "confidence_band": "high",
            "calibrated_probabilities": {
                "approve": 0.0,
                "veto": 1.0,
                "adjust": 0.0,
                "abstain": 0.0,
                "escalate": 0.0,
            },
            "uncertainty": {"score": 0.0, "band": "low"},
            "calibration_metadata": {
                "fallback": "deterministic",
                "reason": "dspy_runtime_error",
                "error": error,
            },
            "rationale": "dspy_runtime_fallback_veto",
            "rationale_short": "dspy_runtime_fallback_veto",
            "required_checks": list(_SAFE_FALLBACK_CHECKS),
            "risk_flags": ["dspy_runtime_fallback", error],
        }
    )
    dspy_payload: dict[str, Any] = {
        "mode": "active",
        "program_name": runtime.program_name,
        "signature_version": runtime.signature_version,
        "artifact_hash": runtime.artifact_hash,
        "artifact_source": "runtime_fallback",
        "executor": "heuristic",
        "latency_ms": 0,
        "advisory_only": True,
        "fallback": True,
        "error": error,
    }
    return response, dspy_payload


def _hash_payload(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


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
            sanitized[key] = _sanitize_nested(
                cast(Mapping[str, Any], value),
                _ALLOWED_PRICE_SNAPSHOT_KEYS,
            )
        elif key == "imbalance" and isinstance(value, Mapping):
            sanitized[key] = _sanitize_nested(
                cast(Mapping[str, Any], value),
                _ALLOWED_IMBALANCE_KEYS,
            )
        elif key == "sizing" and isinstance(value, Mapping):
            sanitized[key] = _sanitize_nested(
                cast(Mapping[str, Any], value),
                _ALLOWED_SIZING_KEYS,
            )
        elif key == "regime_hmm" and isinstance(value, Mapping):
            sanitized[key] = _sanitize_regime_hmm_context(
                cast(Mapping[str, Any], value)
            )
        else:
            sanitized[key] = value
    return sanitized


def _sanitize_regime_hmm_context(value: Mapping[str, Any]) -> dict[str, Any]:
    raw_regime_id = value.get("regime_id") or value.get("regimeId")
    regime_id = _coerce_text(raw_regime_id, default="unknown")
    raw_entropy_band = value.get("entropy_band") or value.get("entropyBand")
    entropy_band = _coerce_entropy_band(raw_entropy_band)
    raw_predicted_next = (
        value.get("predicted_next")
        or value.get("predictedNext")
        or value.get("hmm_predicted_next")
    )
    predicted_next = _coerce_text(raw_predicted_next, default="unknown")

    artifact_version = value.get("artifact_version")
    if artifact_version is None:
        artifact = value.get("artifact")
        if isinstance(artifact, Mapping):
            artifact_version = cast(Mapping[str, Any], artifact).get("model_id")
            if artifact_version is None:
                artifact_version = cast(
                    Mapping[str, Any], artifact
                ).get("artifact_version")
    artifact_version = _coerce_text(
        artifact_version,
        default="unknown",
    )

    guardrail_reason = value.get("guardrail_reason")
    if guardrail_reason is None:
        guardrail = value.get("guardrail")
        if isinstance(guardrail, Mapping):
            guardrail_reason = cast(Mapping[str, Any], guardrail).get("reason")
    guardrail_reason_text = (
        _coerce_text(guardrail_reason, default=None)
        if guardrail_reason is not None
        else None
    )
    sanitized: dict[str, Any] = _sanitize_nested(
        {
            "regime_id": regime_id,
            "entropy_band": entropy_band,
            "predicted_next": predicted_next,
            "artifact_version": artifact_version,
            "guardrail_reason": guardrail_reason_text,
        },
        _ALLOWED_LLM_REGIME_HMM_KEYS,
    )
    return sanitized


def _sanitize_nested(
    payload: Mapping[str, Any], allowed_keys: set[str]
) -> dict[str, Any]:
    return {
        key: payload[key]
        for key in allowed_keys
        if key in payload and payload[key] is not None
    }


def _coerce_text(value: object, *, default: str | None = None) -> str | None:
    if value is None:
        return default
    text = str(value).strip()
    return text or default


def _coerce_entropy_band(raw: object) -> str:
    raw_band = _coerce_text(raw, default="low")
    if raw_band is None:
        return "low"
    normalized = raw_band.lower()
    if normalized in _LLM_REGIME_ENTROPY_BANDS:
        return normalized
    return "low"


def _extract_regime_hmm_context(
    raw_regime_hmm: object,
) -> LLMRegimeHMMContext | None:
    if not isinstance(raw_regime_hmm, Mapping):
        return None
    if not raw_regime_hmm:
        return None
    payload = _sanitize_regime_hmm_context(cast(Mapping[str, Any], raw_regime_hmm))
    if not payload:
        return None
    return LLMRegimeHMMContext.model_validate(payload)
