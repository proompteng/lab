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
    guardrail_reasons: list[str] | None = None


def apply_policy(
    decision: StrategyDecision,
    review: LLMReviewResponse,
    adjustment_allowed: Optional[bool] = None,
) -> PolicyOutcome:
    """Apply policy constraints to the LLM review response."""

    guardrail_reasons = _deterministic_guardrail_reasons(review)
    fallback_outcome = _fallback_verdict_outcome(
        decision,
        verdict=review.verdict,
        guardrail_reasons=guardrail_reasons,
    )
    if fallback_outcome is not None:
        return fallback_outcome

    quality_outcome = _quality_gate_outcome(
        decision,
        review=review,
        guardrail_reasons=guardrail_reasons,
    )
    if quality_outcome is not None:
        return quality_outcome

    required_checks_outcome = _required_checks_outcome(decision, review=review)
    if required_checks_outcome is not None:
        return required_checks_outcome

    committee_outcome = _committee_guard_outcome(decision, review=review)
    if committee_outcome is not None:
        return committee_outcome

    if review.verdict == "veto":
        return PolicyOutcome("veto", decision, "llm_veto")
    if review.verdict == "approve":
        return PolicyOutcome("approve", decision)

    effective_adjustment_allowed = (
        settings.llm_adjustment_allowed
        if adjustment_allowed is None
        else adjustment_allowed
    )
    if not effective_adjustment_allowed:
        return PolicyOutcome("veto", decision, "llm_adjustment_disallowed")
    return _apply_adjustment_outcome(decision, review=review)


def _fallback_verdict_outcome(
    decision: StrategyDecision,
    *,
    verdict: str,
    guardrail_reasons: list[str],
) -> PolicyOutcome | None:
    if verdict == "abstain":
        return _fallback_outcome(
            decision,
            reason="llm_abstain",
            fail_mode=settings.llm_abstain_fail_mode,
            guardrail_reasons=guardrail_reasons,
        )
    if verdict == "escalate":
        return _fallback_outcome(
            decision,
            reason="llm_escalate",
            fail_mode=settings.llm_escalate_fail_mode,
            guardrail_reasons=guardrail_reasons,
        )
    return None


def _quality_gate_outcome(
    decision: StrategyDecision,
    *,
    review: LLMReviewResponse,
    guardrail_reasons: list[str],
) -> PolicyOutcome | None:
    if guardrail_reasons:
        return _fallback_outcome(
            decision,
            reason="llm_uncertainty_guardrail",
            fail_mode=settings.llm_quality_fail_mode,
            guardrail_reasons=guardrail_reasons,
        )
    if review.confidence < settings.llm_min_confidence:
        return _fallback_outcome(
            decision,
            reason="llm_confidence_below_min",
            fail_mode=settings.llm_quality_fail_mode,
            guardrail_reasons=guardrail_reasons,
        )
    return None


def _required_checks_outcome(
    decision: StrategyDecision,
    *,
    review: LLMReviewResponse,
) -> PolicyOutcome | None:
    unknown_checks = sorted(
        {
            check
            for check in review.required_checks
            if check not in _DETERMINISTIC_CHECK_ALLOWLIST
        }
    )
    if unknown_checks:
        return PolicyOutcome("veto", decision, "llm_required_checks_invalid")
    return None


def _committee_guard_outcome(
    decision: StrategyDecision,
    *,
    review: LLMReviewResponse,
) -> PolicyOutcome | None:
    committee = review.committee
    if committee is None:
        return None
    for role in committee.mandatory_roles:
        role_review = committee.roles.get(role)
        if role_review is None or role_review.verdict == "veto":
            return PolicyOutcome("veto", decision, "llm_committee_mandatory_veto")
    return None


def _apply_adjustment_outcome(
    decision: StrategyDecision,
    *,
    review: LLMReviewResponse,
) -> PolicyOutcome:
    adjusted_qty_dec, clamp_reason, qty_error = _resolve_adjusted_qty(
        decision, review=review
    )
    if qty_error is not None:
        return qty_error

    adjusted_order_type = review.adjusted_order_type or decision.order_type
    if adjusted_order_type not in allowed_order_types(decision.order_type):
        return PolicyOutcome("veto", decision, "llm_adjustment_order_type_not_allowed")

    limit_price = _resolve_limit_price(
        decision,
        review=review,
        adjusted_order_type=adjusted_order_type,
    )
    if isinstance(limit_price, PolicyOutcome):
        return limit_price

    updated = decision.model_copy(
        update={
            "qty": adjusted_qty_dec,
            "order_type": adjusted_order_type,
            "limit_price": limit_price,
        }
    )
    return PolicyOutcome("adjust", updated, clamp_reason)


def _resolve_adjusted_qty(
    decision: StrategyDecision,
    *,
    review: LLMReviewResponse,
) -> tuple[Decimal, Optional[str], PolicyOutcome | None]:
    adjusted_qty = review.adjusted_qty
    if adjusted_qty is None:
        return Decimal("0"), None, PolicyOutcome(
            "veto", decision, "llm_adjustment_missing_qty"
        )

    qty = Decimal(str(decision.qty))
    min_qty = qty * Decimal(str(settings.llm_min_qty_multiplier))
    max_qty = qty * Decimal(str(settings.llm_max_qty_multiplier))
    adjusted_qty_dec = Decimal(str(adjusted_qty))
    if adjusted_qty_dec <= 0:
        return Decimal("0"), None, PolicyOutcome(
            "veto", decision, "llm_adjustment_non_positive"
        )

    clamp_reason: Optional[str] = None
    if adjusted_qty_dec < min_qty:
        adjusted_qty_dec = min_qty
        clamp_reason = "llm_adjustment_clamped_min"
    elif adjusted_qty_dec > max_qty:
        adjusted_qty_dec = max_qty
        clamp_reason = "llm_adjustment_clamped_max"
    return adjusted_qty_dec, clamp_reason, None


def _resolve_limit_price(
    decision: StrategyDecision,
    *,
    review: LLMReviewResponse,
    adjusted_order_type: str,
) -> Decimal | None | PolicyOutcome:
    if adjusted_order_type not in {"limit", "stop_limit"}:
        return decision.limit_price
    if review.limit_price is not None:
        return Decimal(str(review.limit_price))
    if adjusted_order_type != decision.order_type or decision.limit_price is None:
        return PolicyOutcome("veto", decision, "llm_adjustment_missing_limit_price")
    return decision.limit_price


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
