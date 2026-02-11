"""Operator-focused LLM evaluation and telemetry helpers."""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, TypedDict, cast
from zoneinfo import ZoneInfo

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from ...models import LLMDecisionReview, TradeDecision


EASTERN_TZ = ZoneInfo("America/New_York")
VERDICT_ORDER = ("approve", "veto", "adjust", "error")


class LLMTelemetryTotals(TypedDict):
    total_reviews: int
    error_reviews: int
    tokens_prompt: int
    tokens_completion: int
    last_review_timestamp_seconds: int


def get_llm_daily_metrics(session: Session, now: datetime | None = None) -> dict[str, object]:
    """Return today's LLM review metrics in America/New_York."""

    now_local = (now or datetime.now(EASTERN_TZ)).astimezone(EASTERN_TZ)
    start_local = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
    end_local = start_local + timedelta(days=1)
    start_utc = start_local.astimezone(timezone.utc)
    end_utc = end_local.astimezone(timezone.utc)

    base_filters = (
        LLMDecisionReview.created_at >= start_utc,
        LLMDecisionReview.created_at < end_utc,
    )

    totals_stmt = (
        select(
            func.count(LLMDecisionReview.id),
            func.sum(case((LLMDecisionReview.verdict == "error", 1), else_=0)),
            func.avg(LLMDecisionReview.confidence),
            func.coalesce(func.sum(LLMDecisionReview.tokens_prompt), 0),
            func.coalesce(func.sum(LLMDecisionReview.tokens_completion), 0),
        )
        .select_from(LLMDecisionReview)
        .join(TradeDecision)
        .where(*base_filters)
    )
    total_reviews, error_reviews, avg_confidence, tokens_prompt, tokens_completion = session.execute(
        totals_stmt
    ).one()

    verdict_stmt = (
        select(LLMDecisionReview.verdict, func.count(LLMDecisionReview.id))
        .select_from(LLMDecisionReview)
        .join(TradeDecision)
        .where(*base_filters)
        .group_by(LLMDecisionReview.verdict)
    )
    verdict_counts: dict[str, int] = {verdict: int(count) for verdict, count in session.execute(verdict_stmt)}
    for verdict in VERDICT_ORDER:
        verdict_counts.setdefault(verdict, 0)

    total_reviews_int = int(total_reviews or 0)
    error_reviews_int = int(error_reviews or 0)
    error_rate = error_reviews_int / total_reviews_int if total_reviews_int else 0.0

    metrics: dict[str, object] = {
        "date": {
            "timezone": EASTERN_TZ.key,
            "start": start_local.isoformat(),
            "end": end_local.isoformat(),
            "as_of": now_local.isoformat(),
        },
        "total_reviews": total_reviews_int,
        "verdict_counts": verdict_counts,
        "error_rate": error_rate,
        "avg_confidence": _to_float(avg_confidence),
        "tokens": {
            "prompt": int(tokens_prompt or 0),
            "completion": int(tokens_completion or 0),
        },
        "top_risk_flags": _top_risk_flags(session, base_filters),
    }
    return metrics


def get_llm_telemetry_totals(session: Session) -> LLMTelemetryTotals:
    """Return cumulative LLM telemetry counters for Prometheus export."""

    totals_stmt = (
        select(
            func.count(LLMDecisionReview.id),
            func.sum(case((LLMDecisionReview.verdict == "error", 1), else_=0)),
            func.coalesce(func.sum(LLMDecisionReview.tokens_prompt), 0),
            func.coalesce(func.sum(LLMDecisionReview.tokens_completion), 0),
            func.max(LLMDecisionReview.created_at),
        )
        .select_from(LLMDecisionReview)
        .join(TradeDecision)
    )
    total_reviews, error_reviews, tokens_prompt, tokens_completion, last_review_at = session.execute(
        totals_stmt
    ).one()

    if last_review_at is None:
        last_review_seconds = 0
    elif last_review_at.tzinfo is None:
        last_review_seconds = int(last_review_at.replace(tzinfo=timezone.utc).timestamp())
    else:
        last_review_seconds = int(last_review_at.astimezone(timezone.utc).timestamp())

    return cast(
        LLMTelemetryTotals,
        {
            "total_reviews": int(total_reviews or 0),
            "error_reviews": int(error_reviews or 0),
            "tokens_prompt": int(tokens_prompt or 0),
            "tokens_completion": int(tokens_completion or 0),
            "last_review_timestamp_seconds": last_review_seconds,
        },
    )


def render_llm_prometheus_metrics(payload: LLMTelemetryTotals) -> str:
    """Render Prometheus text exposition for LLM telemetry."""

    labels = 'namespace="torghut",service="torghut"'
    lines = [
        "# HELP torghut_llm_reviews_total Total LLM decision reviews recorded.",
        "# TYPE torghut_llm_reviews_total counter",
        f"torghut_llm_reviews_total{{{labels}}} {int(payload['total_reviews'])}",
        "# HELP torghut_llm_review_errors_total Total LLM decision reviews with error verdict.",
        "# TYPE torghut_llm_review_errors_total counter",
        f"torghut_llm_review_errors_total{{{labels}}} {int(payload['error_reviews'])}",
        "# HELP torghut_llm_prompt_tokens_total Total prompt tokens recorded for LLM reviews.",
        "# TYPE torghut_llm_prompt_tokens_total counter",
        f"torghut_llm_prompt_tokens_total{{{labels}}} {int(payload['tokens_prompt'])}",
        "# HELP torghut_llm_completion_tokens_total Total completion tokens recorded for LLM reviews.",
        "# TYPE torghut_llm_completion_tokens_total counter",
        f"torghut_llm_completion_tokens_total{{{labels}}} {int(payload['tokens_completion'])}",
        "# HELP torghut_llm_review_last_created_at_seconds Unix timestamp of last LLM review created_at.",
        "# TYPE torghut_llm_review_last_created_at_seconds gauge",
        f"torghut_llm_review_last_created_at_seconds{{{labels}}} {int(payload['last_review_timestamp_seconds'])}",
        "",
    ]
    return "\n".join(lines)


def _top_risk_flags(
    session: Session,
    base_filters: tuple[Any, ...],
    limit: int = 5,
) -> list[dict[str, object]]:
    if session.bind is not None and session.bind.dialect.name == "postgresql":
        flag_value = func.jsonb_array_elements_text(LLMDecisionReview.risk_flags).label("flag")
        stmt = (
            select(flag_value, func.count())
            .select_from(LLMDecisionReview)
            .join(TradeDecision)
            .where(
                *base_filters,
                LLMDecisionReview.risk_flags.is_not(None),
                func.jsonb_typeof(LLMDecisionReview.risk_flags) == "array",
            )
            .group_by(flag_value)
            .order_by(func.count().desc())
            .limit(limit)
        )
        rows = cast(list[tuple[str | None, int]], session.execute(stmt).all())
        return [{"flag": flag, "count": int(count)} for flag, count in rows if flag]

    stmt = (
        select(LLMDecisionReview.risk_flags)
        .select_from(LLMDecisionReview)
        .join(TradeDecision)
        .where(*base_filters, LLMDecisionReview.risk_flags.is_not(None))
    )
    rows = cast(list[list[str | None] | str | None], session.execute(stmt).scalars().all())
    counter: Counter[str] = Counter()
    for flags in rows:
        if isinstance(flags, list):
            for flag in flags:
                if flag is not None:
                    counter[str(flag)] += 1
        elif flags is not None:
            counter[str(flags)] += 1
    return [{"flag": flag, "count": count} for flag, count in counter.most_common(limit)]


def _to_float(value: Decimal | float | None) -> float | None:
    if value is None:
        return None
    return float(value)
