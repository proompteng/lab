"""Policy guard for LLM adjustments."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Optional

from ...config import settings
from ..models import StrategyDecision
from .schema import LLMReviewResponse

_ALLOWED_LIMIT_TYPES = {"market", "limit"}
_DETERMINISTIC_CHECK_ALLOWLIST = {
    "execution_policy",
    "risk_engine",
    "order_firewall",
    "portfolio_sizing",
    "market_context",
    "autonomy_policy_checks",
}


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
        return PolicyOutcome("veto", decision, "llm_confidence_below_min")

    unknown_checks = sorted(
        {
            check
            for check in review.required_checks
            if check not in _DETERMINISTIC_CHECK_ALLOWLIST
        }
    )
    if unknown_checks:
        return PolicyOutcome("veto", decision, "llm_required_checks_invalid")

    committee = review.committee
    if committee is not None:
        for role in committee.mandatory_roles:
            role_review = committee.roles.get(role)
            if role_review is None or role_review.verdict == "veto":
                return PolicyOutcome("veto", decision, "llm_committee_mandatory_veto")

    if review.verdict == "veto":
        return PolicyOutcome("veto", decision, "llm_veto")

    if review.verdict == "abstain":
        return PolicyOutcome("veto", decision, "llm_abstain")

    if review.verdict == "escalate":
        return PolicyOutcome("veto", decision, "llm_escalate")

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


def allowed_order_types(current: str) -> set[str]:
    if current in _ALLOWED_LIMIT_TYPES:
        return set(_ALLOWED_LIMIT_TYPES)
    return {current}


__all__ = ["PolicyOutcome", "apply_policy", "allowed_order_types"]
