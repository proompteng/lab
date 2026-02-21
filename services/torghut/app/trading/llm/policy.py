"""Policy guard for LLM adjustments."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Optional

from ...config import settings
from ..models import StrategyDecision
from .schema import LLMReviewResponse

_ALLOWED_LIMIT_TYPES = {"market", "limit"}


@dataclass
class PolicyOutcome:
    verdict: str
    decision: StrategyDecision
    reason: Optional[str] = None
    guardrail_reasons: list[str] | None = None


def apply_policy(
    decision: StrategyDecision,
    review: LLMReviewResponse,
    adjustment_allowed: Optional[bool] = None,
) -> PolicyOutcome:
    """Apply policy constraints to the LLM review response."""

    guardrail_reasons = _deterministic_guardrail_reasons(review)
    if review.verdict == "abstain":
        return _fallback_outcome(
            decision,
            reason="llm_abstain",
            fail_mode=settings.llm_abstain_fail_mode,
            guardrail_reasons=guardrail_reasons,
        )
    if review.verdict == "escalate":
        return _fallback_outcome(
            decision,
            reason="llm_escalate",
            fail_mode=settings.llm_escalate_fail_mode,
            guardrail_reasons=guardrail_reasons,
        )

    if guardrail_reasons:
        return _fallback_outcome(
            decision,
            reason="llm_uncertainty_guardrail",
            fail_mode=settings.llm_quality_fail_mode,
            guardrail_reasons=guardrail_reasons,
        )

    min_confidence = settings.llm_min_confidence
    if review.confidence < min_confidence:
        return _fallback_outcome(
            decision,
            reason="llm_confidence_below_min",
            fail_mode=settings.llm_quality_fail_mode,
            guardrail_reasons=guardrail_reasons,
        )

    if review.verdict == "veto":
        return PolicyOutcome("veto", decision, "llm_veto")

    if review.verdict == "approve":
        return PolicyOutcome("approve", decision)

    if adjustment_allowed is None:
        adjustment_allowed = settings.llm_adjustment_allowed

    if not adjustment_allowed:
        return PolicyOutcome("veto", decision, "llm_adjustment_disallowed")

    adjusted_qty = review.adjusted_qty
    if adjusted_qty is None:
        return PolicyOutcome("veto", decision, "llm_adjustment_missing_qty")

    qty = Decimal(str(decision.qty))
    min_qty = qty * Decimal(str(settings.llm_min_qty_multiplier))
    max_qty = qty * Decimal(str(settings.llm_max_qty_multiplier))
    adjusted_qty_dec = Decimal(str(adjusted_qty))
    clamp_reason: Optional[str] = None

    if adjusted_qty_dec <= 0:
        return PolicyOutcome("veto", decision, "llm_adjustment_non_positive")

    if adjusted_qty_dec < min_qty:
        adjusted_qty_dec = min_qty
        clamp_reason = "llm_adjustment_clamped_min"
    elif adjusted_qty_dec > max_qty:
        adjusted_qty_dec = max_qty
        clamp_reason = "llm_adjustment_clamped_max"

    adjusted_order_type = review.adjusted_order_type
    if adjusted_order_type is None:
        adjusted_order_type = decision.order_type

    if adjusted_order_type not in allowed_order_types(decision.order_type):
        return PolicyOutcome("veto", decision, "llm_adjustment_order_type_not_allowed")

    limit_price = decision.limit_price
    if adjusted_order_type in {"limit", "stop_limit"}:
        if review.limit_price is not None:
            limit_price = Decimal(str(review.limit_price))
        elif adjusted_order_type != decision.order_type or limit_price is None:
            return PolicyOutcome("veto", decision, "llm_adjustment_missing_limit_price")

    updated = decision.model_copy(
        update={
            "qty": adjusted_qty_dec,
            "order_type": adjusted_order_type,
            "limit_price": limit_price,
        }
    )
    return PolicyOutcome("adjust", updated, clamp_reason)


def _fallback_outcome(
    decision: StrategyDecision,
    *,
    reason: str,
    fail_mode: str,
    guardrail_reasons: list[str],
) -> PolicyOutcome:
    effective_verdict = "veto" if fail_mode == "veto" else "approve"
    return PolicyOutcome(
        effective_verdict,
        decision,
        reason=f"{reason}_fallback_{fail_mode}",
        guardrail_reasons=guardrail_reasons,
    )


def _deterministic_guardrail_reasons(review: LLMReviewResponse) -> list[str]:
    reasons: list[str] = []
    calibrated = review.calibrated_probabilities.model_dump(mode="python")
    sorted_probabilities = sorted(float(value) for value in calibrated.values())
    top_probability = sorted_probabilities[-1]
    second_probability = sorted_probabilities[-2] if len(sorted_probabilities) > 1 else 0.0
    if top_probability < settings.llm_min_calibrated_top_probability:
        reasons.append("llm_calibrated_probability_below_min")
    if (top_probability - second_probability) < settings.llm_min_probability_margin:
        reasons.append("llm_calibrated_probability_margin_below_min")
    if review.uncertainty.score > settings.llm_max_uncertainty:
        reasons.append("llm_uncertainty_score_above_max")
    if _band_rank(review.uncertainty.band) > _band_rank(settings.llm_max_uncertainty_band):
        reasons.append("llm_uncertainty_band_above_max")
    quality_score = _parse_quality_score(review.calibration_metadata.get("quality_score"))
    if quality_score is not None and quality_score < settings.llm_min_calibration_quality_score:
        reasons.append("llm_calibration_quality_below_min")
    return reasons


def _parse_quality_score(value: object) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        score = float(value)
    else:
        raw = str(value).strip()
        if not raw:
            return None
        try:
            score = float(raw)
        except (TypeError, ValueError):
            return None
    if 0.0 <= score <= 1.0:
        return score
    return None


def _band_rank(band: str) -> int:
    if band == "low":
        return 0
    if band == "medium":
        return 1
    return 2


def allowed_order_types(current: str) -> set[str]:
    if current in _ALLOWED_LIMIT_TYPES:
        return set(_ALLOWED_LIMIT_TYPES)
    return {current}


__all__ = ["PolicyOutcome", "apply_policy", "allowed_order_types"]
