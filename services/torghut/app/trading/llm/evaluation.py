"""LLM evaluation metrics derived from Postgres audit tables."""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, cast
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...models import LLMDecisionReview, TradeDecision

DEFAULT_TIMEZONE = "America/New_York"
TOP_RISK_FLAGS_LIMIT = 5


def build_llm_evaluation_metrics(session: Session, now: datetime | None = None) -> dict[str, object]:
    start_local, end_local, start_utc, end_utc = _resolve_today_window(now)
    metrics = _query_llm_metrics(session, start_utc, end_utc)
    return {
        "ok": True,
        "window": {
            "timezone": DEFAULT_TIMEZONE,
            "start": start_local.isoformat(),
            "end": end_local.isoformat(),
            "start_utc": start_utc.isoformat(),
            "end_utc": end_utc.isoformat(),
        },
        "metrics": metrics,
    }


def _resolve_today_window(now: datetime | None) -> tuple[datetime, datetime, datetime, datetime]:
    tz = ZoneInfo(DEFAULT_TIMEZONE)
    if now is None:
        now_local = datetime.now(tz)
    elif now.tzinfo is None:
        now_local = now.replace(tzinfo=tz)
    else:
        now_local = now.astimezone(tz)
    start_local = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
    end_local = start_local + timedelta(days=1)
    start_utc = start_local.astimezone(timezone.utc)
    end_utc = end_local.astimezone(timezone.utc)
    return start_local, end_local, start_utc, end_utc


def _query_llm_metrics(session: Session, start_utc: datetime, end_utc: datetime) -> dict[str, object]:
    filter_clause = [
        TradeDecision.created_at >= start_utc,
        TradeDecision.created_at < end_utc,
    ]
    total_reviews = _as_int(
        session.execute(
            select(func.count(LLMDecisionReview.id))
            .join(TradeDecision, TradeDecision.id == LLMDecisionReview.trade_decision_id)
            .where(*filter_clause)
        ).scalar_one()
    )
    verdict_rows = session.execute(
        select(LLMDecisionReview.verdict, func.count(LLMDecisionReview.id))
        .join(TradeDecision, TradeDecision.id == LLMDecisionReview.trade_decision_id)
        .where(*filter_clause)
        .group_by(LLMDecisionReview.verdict)
    ).all()
    verdict_counts: dict[str, int] = {
        "approve": 0,
        "veto": 0,
        "adjust": 0,
        "abstain": 0,
        "escalate": 0,
        "error": 0,
    }
    for verdict, count in verdict_rows:
        key = str(verdict)
        verdict_counts[key] = _as_int(count)

    error_count = verdict_counts.get("error", 0)
    error_rate = error_count / total_reviews if total_reviews else 0.0

    avg_confidence = session.execute(
        select(func.avg(LLMDecisionReview.confidence))
        .join(TradeDecision, TradeDecision.id == LLMDecisionReview.trade_decision_id)
        .where(*filter_clause)
    ).scalar_one()
    avg_confidence_value = float(avg_confidence) if avg_confidence is not None else None

    tokens_prompt = _as_int(
        session.execute(
            select(func.coalesce(func.sum(LLMDecisionReview.tokens_prompt), 0))
            .join(TradeDecision, TradeDecision.id == LLMDecisionReview.trade_decision_id)
            .where(*filter_clause)
        ).scalar_one()
    )
    tokens_completion = _as_int(
        session.execute(
            select(func.coalesce(func.sum(LLMDecisionReview.tokens_completion), 0))
            .join(TradeDecision, TradeDecision.id == LLMDecisionReview.trade_decision_id)
            .where(*filter_clause)
        ).scalar_one()
    )

    risk_flags_rows = session.execute(
        select(LLMDecisionReview.risk_flags)
        .join(TradeDecision, TradeDecision.id == LLMDecisionReview.trade_decision_id)
        .where(*filter_clause)
    ).all()
    counter: Counter[str] = Counter()
    for (raw_flags,) in risk_flags_rows:
        for flag in _normalize_risk_flags(raw_flags):
            counter[flag] += 1
    top_risk_flags = [
        {"flag": flag, "count": count}
        for flag, count in sorted(counter.items(), key=lambda item: (-item[1], item[0]))[:TOP_RISK_FLAGS_LIMIT]
    ]

    calibration_quality = _compute_calibration_quality(
        session=session,
        filter_clause=filter_clause,
    )
    decision_contribution = _compute_decision_contribution(
        total_reviews=total_reviews,
        verdict_counts=verdict_counts,
        session=session,
        filter_clause=filter_clause,
    )

    return {
        "total_reviews": total_reviews,
        "verdict_counts": verdict_counts,
        "error_rate": error_rate,
        "avg_confidence": avg_confidence_value,
        "decision_contribution": decision_contribution,
        "tokens": {
            "prompt": tokens_prompt,
            "completion": tokens_completion,
            "total": tokens_prompt + tokens_completion,
        },
        "top_risk_flags": top_risk_flags,
        "calibration_quality": calibration_quality,
    }


def _compute_calibration_quality(
    *,
    session: Session,
    filter_clause: list[Any],
) -> dict[str, object]:
    rows = session.execute(
        select(
            LLMDecisionReview.confidence,
            LLMDecisionReview.response_json,
        )
        .join(TradeDecision, TradeDecision.id == LLMDecisionReview.trade_decision_id)
        .where(*filter_clause)
    ).all()

    confidence_gap_total = 0.0
    uncertainty_alignment_total = 0.0
    quality_score_total = 0.0
    confidence_gap_count = 0
    uncertainty_alignment_count = 0
    quality_score_count = 0
    high_uncertainty_count = 0

    for confidence_raw, response_raw in rows:
        confidence = _safe_float(confidence_raw)
        response = _as_mapping(response_raw)
        calibrated = _as_mapping(response.get("calibrated_probabilities"))
        uncertainty = _as_mapping(response.get("uncertainty"))
        calibration_metadata = _as_mapping(response.get("calibration_metadata"))

        if calibrated:
            top_probability: float | None = None
            for value in calibrated.values():
                candidate = _safe_float(value)
                if candidate is None:
                    continue
                if top_probability is None or candidate > top_probability:
                    top_probability = candidate
            if top_probability is not None and confidence is not None:
                confidence_gap_total += abs(float(top_probability) - confidence)
                confidence_gap_count += 1

        uncertainty_score = _safe_float(uncertainty.get("score"))
        if confidence is not None and uncertainty_score is not None:
            uncertainty_alignment_total += abs((1.0 - confidence) - uncertainty_score)
            uncertainty_alignment_count += 1
        if str(uncertainty.get("band") or "").strip().lower() == "high":
            high_uncertainty_count += 1

        quality_score = _safe_float(calibration_metadata.get("quality_score"))
        if quality_score is not None:
            quality_score_total += quality_score
            quality_score_count += 1

    return {
        "mean_confidence_gap": (
            confidence_gap_total / confidence_gap_count if confidence_gap_count else None
        ),
        "mean_uncertainty_alignment_error": (
            uncertainty_alignment_total / uncertainty_alignment_count
            if uncertainty_alignment_count
            else None
        ),
        "mean_calibration_quality_score": (
            quality_score_total / quality_score_count if quality_score_count else None
        ),
        "high_uncertainty_rate": (
            high_uncertainty_count / len(rows) if rows else 0.0
        ),
        "samples": len(rows),
    }


def _compute_decision_contribution(
    *,
    total_reviews: int,
    verdict_counts: dict[str, int],
    session: Session,
    filter_clause: list[Any],
) -> dict[str, object]:
    response_rows = session.execute(
        select(LLMDecisionReview.response_json)
        .join(TradeDecision, TradeDecision.id == LLMDecisionReview.trade_decision_id)
        .where(*filter_clause)
    ).all()
    fallback_total = 0
    deterministic_guardrail_total = 0
    for (response_raw,) in response_rows:
        response = _as_mapping(response_raw)
        policy_override = str(response.get("policy_override") or "")
        if "_fallback_" in policy_override or response.get("fallback") in {"veto", "pass_through"}:
            fallback_total += 1
        if isinstance(response.get("deterministic_guardrails"), list):
            deterministic_guardrail_total += 1

    actionable_total = max(total_reviews - verdict_counts.get("error", 0), 0)
    contribution_events = (
        verdict_counts.get("adjust", 0)
        + verdict_counts.get("veto", 0)
        + verdict_counts.get("abstain", 0)
        + verdict_counts.get("escalate", 0)
    )
    return {
        "actionable_reviews": actionable_total,
        "contribution_events": contribution_events,
        "contribution_rate": (
            contribution_events / actionable_total if actionable_total else 0.0
        ),
        "fallback_total": fallback_total,
        "fallback_rate": (fallback_total / total_reviews if total_reviews else 0.0),
        "deterministic_guardrail_total": deterministic_guardrail_total,
        "deterministic_guardrail_rate": (
            deterministic_guardrail_total / total_reviews if total_reviews else 0.0
        ),
    }


def _normalize_risk_flags(value: object) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        flag = value.strip()
        return [flag] if flag else []
    if isinstance(value, list):
        flags: list[str] = []
        for item in cast(list[Any], value):
            if item is None:
                continue
            flag = str(item).strip()
            if flag:
                flags.append(flag)
        return flags
    if isinstance(value, dict):
        return [str(key).strip() for key in cast(dict[Any, Any], value).keys() if str(key).strip()]
    return [str(value)]


def _as_int(value: object) -> int:
    if value is None:
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, Decimal):
        return int(value)
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return 0


def _safe_float(value: object) -> float | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value))
    except (TypeError, ValueError):
        return None


def _as_mapping(value: object) -> dict[str, Any]:
    if isinstance(value, dict):
        return cast(dict[str, Any], value)
    return {}
