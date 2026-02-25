"""Adapters between DSPy scaffold contracts and Torghut LLM schemas."""

from __future__ import annotations

from decimal import Decimal
from typing import Any, cast

from ..schema import (
    LLMCalibratedProbabilities,
    LLMCommitteeMemberResponse,
    LLMCommitteeTrace,
    LLMReviewRequest,
    LLMReviewResponse,
    LLMUncertainty,
)
from .signatures import DSPyCommitteeMemberOutput, DSPyTradeReviewInput, DSPyTradeReviewOutput


def review_request_to_dspy_input(
    request: LLMReviewRequest,
    *,
    artifact_hash: str,
    program_name: str,
    signature_version: str,
) -> DSPyTradeReviewInput:
    request_json = request.model_dump(mode="json")
    market = cast(dict[str, Any], request_json.get("market") or {})
    market_session = str(market.get("source") or "").strip() or None
    return DSPyTradeReviewInput.model_validate(
        {
            "schemaVersion": "torghut.dspy.trade-review.v1",
            "requestJson": request_json,
            "advisoryOnly": True,
            "programName": program_name,
            "signatureVersion": signature_version,
            "artifactHash": artifact_hash,
            "marketSession": market_session,
        }
    )


def dspy_output_to_llm_response(output: DSPyTradeReviewOutput) -> LLMReviewResponse:
    confidence = float(output.confidence)
    probabilities = _default_calibrated_probabilities(output.verdict, confidence)
    uncertainty = _uncertainty_from_band(output.uncertainty_band, confidence=confidence)

    committee_trace = _build_committee_trace(output.committee)

    payload: dict[str, Any] = {
        "verdict": output.verdict,
        "confidence": confidence,
        "confidence_band": _confidence_band_from_score(confidence),
        "calibrated_probabilities": probabilities.model_dump(mode="python"),
        "uncertainty": uncertainty.model_dump(mode="python"),
        "calibration_metadata": output.calibration_metadata,
        "adjusted_qty": _decimal_or_none(output.adjusted_qty),
        "adjusted_order_type": output.adjusted_order_type,
        "limit_price": _decimal_or_none(output.limit_price),
        "escalate_reason": output.escalate_reason,
        "rationale": output.rationale,
        "rationale_short": output.rationale_short or output.rationale,
        "required_checks": sorted(set(output.required_checks)),
        "risk_flags": sorted(set(output.risk_flags)),
        "committee": committee_trace.model_dump(mode="python") if committee_trace is not None else None,
    }
    return LLMReviewResponse.model_validate(payload)


def _build_committee_trace(committee: list[DSPyCommitteeMemberOutput]) -> LLMCommitteeTrace | None:
    if not committee:
        return None
    roles: dict[str, LLMCommitteeMemberResponse] = {}
    for item in committee:
        roles[item.role] = LLMCommitteeMemberResponse.model_validate(
            {
                "role": item.role,
                "verdict": item.verdict,
                "confidence": item.confidence,
                "uncertainty": item.uncertainty_band,
                "rationale_short": item.rationale_short,
                "required_checks": item.required_checks,
                "adjusted_qty": _decimal_or_none(item.adjusted_qty),
                "adjusted_order_type": item.adjusted_order_type,
                "limit_price": _decimal_or_none(item.limit_price),
                "risk_flags": item.risk_flags,
                "schema_error": False,
            }
        )
    return LLMCommitteeTrace.model_validate(
        {
            "roles": roles,
            "mandatory_roles": ["risk_critic", "execution_critic", "policy_judge"],
            "fail_closed_verdict": "veto",
            "schema_error_count": 0,
        }
    )


def _default_calibrated_probabilities(verdict: str, confidence: float) -> LLMCalibratedProbabilities:
    labels = ["approve", "veto", "adjust", "abstain", "escalate"]
    selected = verdict if verdict in labels else "abstain"
    remainder = max(0.0, 1.0 - confidence)
    background = remainder / 4.0
    distribution = {label: background for label in labels}
    distribution[selected] = confidence
    total = sum(distribution.values())
    normalized = {
        key: round((value / total) if total > 0 else 0.2, 6)
        for key, value in distribution.items()
    }
    return LLMCalibratedProbabilities.model_validate(normalized)


def _uncertainty_from_band(band: str, *, confidence: float) -> LLMUncertainty:
    normalized = band.strip().lower()
    if normalized not in {"low", "medium", "high"}:
        normalized = "medium"
    return LLMUncertainty.model_validate(
        {
            "score": round(1.0 - confidence, 4),
            "band": normalized,
        }
    )


def _confidence_band_from_score(confidence: float) -> str:
    if confidence >= 0.75:
        return "high"
    if confidence >= 0.5:
        return "medium"
    return "low"


def _decimal_or_none(raw: str | None) -> Decimal | None:
    if raw is None:
        return None
    try:
        return Decimal(raw)
    except Exception:
        return None


__all__ = ["review_request_to_dspy_input", "dspy_output_to_llm_response"]
