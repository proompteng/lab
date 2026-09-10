"""Snapshot-owned inputs for options subscription ranking."""

from __future__ import annotations

from collections.abc import Mapping


def snapshot_ranking_inputs(payload: Mapping[str, object]) -> dict[str, float]:
    """Return only the recency inputs owned by snapshot enrichment."""

    return {
        "trade_recency_score": 1.0 if payload.get("latest_trade_ts") else 0.2,
        "quote_recency_score": 1.0 if payload.get("latest_quote_ts") else 0.2,
    }
