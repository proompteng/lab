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


def apply_policy(
    decision: StrategyDecision,
    review: LLMReviewResponse,
    adjustment_allowed: Optional[bool] = None,
) -> PolicyOutcome:
    """Apply policy constraints to the LLM review response."""

    min_confidence = settings.llm_min_confidence
    if review.confidence < min_confidence:
        return _policy_from_fail_mode(
            settings.llm_quality_fail_mode,
            decision,
            fail_reason="llm_confidence_below_min",
        )

    quality_reason = _quality_guardrail_reason(review)
    if quality_reason is not None:
        return _policy_from_fail_mode(
            settings.llm_quality_fail_mode,
            decision,
            fail_reason=quality_reason,
        )

    if review.verdict == "veto":
        return PolicyOutcome("veto", decision, "llm_veto")

    if review.verdict == "approve":
        return PolicyOutcome("approve", decision)

    if review.verdict == "abstain":
        return _policy_from_fail_mode(
            settings.llm_abstain_fail_mode,
            decision,
            fail_reason="llm_abstain",
        )

    if review.verdict == "escalate":
        if not settings.llm_allow_escalate:
            return PolicyOutcome("veto", decision, "llm_escalate_disabled")
        return _policy_from_fail_mode(
            settings.llm_escalate_fail_mode,
            decision,
            fail_reason="llm_escalate",
        )

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


def _quality_guardrail_reason(review: LLMReviewResponse) -> Optional[str]:
    probabilities_payload = review.calibrated_probabilities
    if probabilities_payload is None:
        return "llm_calibrated_probabilities_missing"
    probabilities = {
        "approve": probabilities_payload.approve,
        "veto": probabilities_payload.veto,
        "adjust": probabilities_payload.adjust,
        "abstain": probabilities_payload.abstain,
        "escalate": probabilities_payload.escalate,
    }
    ranking = sorted(probabilities.items(), key=lambda item: item[1], reverse=True)
    top_verdict, top_probability = ranking[0]
    second_probability = ranking[1][1] if len(ranking) > 1 else 0.0
    margin = top_probability - second_probability

    if review.uncertainty > settings.llm_max_uncertainty:
        return "llm_uncertainty_above_max"
    if review.verdict in {"approve", "veto", "adjust"}:
        selected_probability = probabilities.get(review.verdict, 0.0)
        if selected_probability < settings.llm_min_calibrated_top_probability:
            return "llm_calibrated_probability_below_min"
    if margin < settings.llm_min_probability_margin:
        return "llm_probability_margin_below_min"
    if review.verdict in {"approve", "veto", "adjust"} and top_verdict != review.verdict:
        return "llm_selected_verdict_not_top_probability"
    return None


def _policy_from_fail_mode(
    fail_mode: str,
    decision: StrategyDecision,
    *,
    fail_reason: str,
) -> PolicyOutcome:
    if fail_mode == "pass_through":
        return PolicyOutcome("approve", decision, f"{fail_reason}_pass_through")
    return PolicyOutcome("veto", decision, fail_reason)


def allowed_order_types(current: str) -> set[str]:
    if current in _ALLOWED_LIMIT_TYPES:
        return set(_ALLOWED_LIMIT_TYPES)
    return {current}


__all__ = ["PolicyOutcome", "apply_policy", "allowed_order_types"]
