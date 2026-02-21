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
        select(
            LLMDecisionReview.risk_flags,
            LLMDecisionReview.response_json,
            LLMDecisionReview.verdict,
        )
        .join(TradeDecision, TradeDecision.id == LLMDecisionReview.trade_decision_id)
        .where(*filter_clause)
    ).all()
    counter: Counter[str] = Counter()
    calibration_rows: list[dict[str, Any]] = []
    model_verdict_counts: dict[str, int] = {
        "approve": 0,
        "veto": 0,
        "adjust": 0,
        "abstain": 0,
        "escalate": 0,
        "unknown": 0,
    }
    policy_override_total = 0
    llm_influence_total = 0
    for raw_flags, response_json, effective_verdict in risk_flags_rows:
        for flag in _normalize_risk_flags(raw_flags):
            counter[flag] += 1
        payload = _as_dict(response_json)
        model_verdict = str(payload.get("verdict") or "").strip().lower()
        if model_verdict not in model_verdict_counts:
            model_verdict = "unknown"
        model_verdict_counts[model_verdict] += 1
        if payload.get("policy_override"):
            policy_override_total += 1
        if str(effective_verdict).lower() in {"veto", "adjust"}:
            llm_influence_total += 1
        calibration_rows.append(payload)

    decision_contribution: dict[str, object] = {
        "policy_override_total": policy_override_total,
        "policy_override_rate": policy_override_total / total_reviews if total_reviews else 0.0,
        "llm_influence_total": llm_influence_total,
        "llm_influence_rate": llm_influence_total / total_reviews if total_reviews else 0.0,
        "model_verdict_counts": model_verdict_counts,
    }
    top_risk_flags = [
        {"flag": flag, "count": count}
        for flag, count in sorted(counter.items(), key=lambda item: (-item[1], item[0]))[:TOP_RISK_FLAGS_LIMIT]
    ]

    return {
        "total_reviews": total_reviews,
        "verdict_counts": verdict_counts,
        "error_rate": error_rate,
        "avg_confidence": avg_confidence_value,
        "calibration_quality": _summarize_calibration_quality(calibration_rows),
        "decision_contribution": decision_contribution,
        "tokens": {
            "prompt": tokens_prompt,
            "completion": tokens_completion,
            "total": tokens_prompt + tokens_completion,
        },
        "top_risk_flags": top_risk_flags,
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


def _as_dict(value: object) -> dict[str, Any]:
    if isinstance(value, dict):
        raw = cast(dict[Any, Any], value)
        return {str(key): item for key, item in raw.items()}
    return {}


def _summarize_calibration_quality(rows: list[dict[str, Any]]) -> dict[str, object]:
    if not rows:
        return {
            "count": 0,
            "avg_uncertainty": None,
            "avg_top_probability": None,
            "avg_probability_margin": None,
            "verdict_probability_alignment_rate": 0.0,
        }

    uncertainty_total = 0.0
    top_probability_total = 0.0
    margin_total = 0.0
    aligned_total = 0
    considered = 0
    for row in rows:
        probabilities = _calibrated_probabilities(row)
        if not probabilities:
            continue
        considered += 1
        uncertainty_total += _as_float(row.get("uncertainty"), default=0.0)
        sorted_probs = sorted(probabilities.items(), key=lambda item: item[1], reverse=True)
        top_verdict, top_probability = sorted_probs[0]
        second_probability = sorted_probs[1][1] if len(sorted_probs) > 1 else 0.0
        top_probability_total += top_probability
        margin_total += max(top_probability - second_probability, 0.0)
        selected_verdict = str(row.get("verdict") or "").strip().lower()
        if selected_verdict == top_verdict:
            aligned_total += 1

    if considered == 0:
        return {
            "count": 0,
            "avg_uncertainty": None,
            "avg_top_probability": None,
            "avg_probability_margin": None,
            "verdict_probability_alignment_rate": 0.0,
        }

    return {
        "count": considered,
        "avg_uncertainty": uncertainty_total / considered,
        "avg_top_probability": top_probability_total / considered,
        "avg_probability_margin": margin_total / considered,
        "verdict_probability_alignment_rate": aligned_total / considered,
    }


def _calibrated_probabilities(row: dict[str, Any]) -> dict[str, float]:
    raw = row.get("calibrated_probabilities")
    if not isinstance(raw, dict):
        return {}
    probability_payload = cast(dict[str, Any], raw)
    verdict_keys = ["approve", "veto", "adjust", "abstain", "escalate"]
    probs: dict[str, float] = {}
    for key in verdict_keys:
        probs[key] = _as_float(probability_payload.get(key), default=0.0)
    total = sum(probs.values())
    if total <= 0:
        return {}
    return {key: value / total for key, value in probs.items()}


def _as_float(value: object, default: float) -> float:
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, Decimal):
        return float(value)
    try:
        return float(str(value))
    except (TypeError, ValueError):
        return default


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
