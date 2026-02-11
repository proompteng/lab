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
        **metrics,
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

    return {
        "total_reviews": total_reviews,
        "verdict_counts": verdict_counts,
        "error_rate": error_rate,
        "avg_confidence": avg_confidence_value,
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
