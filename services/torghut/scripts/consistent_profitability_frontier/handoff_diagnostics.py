#!/usr/bin/env python3
"""Search replay candidates using holdout fitness plus full-window consistency penalties."""

from __future__ import annotations

from collections import Counter
from decimal import Decimal
from typing import Any, Mapping, cast


def _symbol_contributions_from_replay_payload(
    payload: Mapping[str, Any],
) -> dict[str, dict[str, Any]]:
    funnel = payload.get("funnel")
    if not isinstance(funnel, Mapping):
        return {}
    buckets = funnel.get("buckets")
    if not isinstance(buckets, list):
        return {}

    contributions: dict[str, dict[str, Any]] = {}
    for raw_bucket in buckets:
        if not isinstance(raw_bucket, Mapping):
            continue
        symbol = str(raw_bucket.get("symbol") or "").strip().upper()
        if not symbol:
            continue
        bucket_net = Decimal(str(raw_bucket.get("net_pnl", "0")))
        bucket_cost = Decimal(str(raw_bucket.get("cost_total", "0")))
        bucket_filled = int(raw_bucket.get("filled_count", 0) or 0)
        bucket_day = str(raw_bucket.get("trading_day") or "").strip()
        aggregate = contributions.setdefault(
            symbol,
            {
                "net_pnl": Decimal("0"),
                "cost_total": Decimal("0"),
                "downside_pnl": Decimal("0"),
                "worst_day_net": Decimal("0"),
                "active_days": set(),
                "negative_days": set(),
                "filled_count": 0,
            },
        )
        aggregate["net_pnl"] += bucket_net
        aggregate["cost_total"] += bucket_cost
        aggregate["filled_count"] += bucket_filled
        if bucket_filled > 0 and bucket_day:
            aggregate["active_days"].add(bucket_day)
        if bucket_net < 0:
            aggregate["downside_pnl"] += -bucket_net
            if bucket_day:
                aggregate["negative_days"].add(bucket_day)
            if bucket_net < aggregate["worst_day_net"]:
                aggregate["worst_day_net"] = bucket_net

    result: dict[str, dict[str, Any]] = {}
    for symbol, aggregate in contributions.items():
        net_pnl = aggregate["net_pnl"]
        downside_pnl = aggregate["downside_pnl"]
        worst_day_net = aggregate["worst_day_net"]
        # Risk-sensitive marginal contribution: reward positive contribution, penalize
        # downside and especially severe one-day losses.
        contribution_score = net_pnl - downside_pnl - abs(worst_day_net)
        result[symbol] = {
            "net_pnl": str(net_pnl),
            "cost_total": str(aggregate["cost_total"]),
            "downside_pnl": str(downside_pnl),
            "worst_day_net": str(worst_day_net),
            "active_days": len(aggregate["active_days"]),
            "negative_days": len(aggregate["negative_days"]),
            "filled_count": aggregate["filled_count"],
            "contribution_score": str(contribution_score),
        }
    return dict(
        sorted(
            result.items(),
            key=lambda item: (
                Decimal(str(item[1]["contribution_score"])),
                Decimal(str(item[1]["net_pnl"])),
            ),
        )
    )


def _top_counter_payload(
    counter: Counter[str], *, limit: int = 10
) -> list[dict[str, Any]]:
    return [
        {"key": key, "count": count}
        for key, count in counter.most_common(max(1, limit))
    ]


def _counter_from_payload(value: Any) -> Counter[str]:
    counter: Counter[str] = Counter()
    if not isinstance(value, Mapping):
        return counter
    for key, raw_count in value.items():
        try:
            count = int(raw_count)
        except (TypeError, ValueError):
            continue
        if count > 0:
            counter[str(key)] += count
    return counter


def _near_miss_digest(raw_near_miss: Mapping[str, Any]) -> dict[str, Any]:
    thresholds = raw_near_miss.get("thresholds")
    threshold_digest: list[dict[str, Any]] = []
    if isinstance(thresholds, list):
        for item in thresholds[:3]:
            if not isinstance(item, Mapping):
                continue
            threshold_digest.append(
                {
                    "metric": str(item.get("metric") or ""),
                    "value": item.get("value"),
                    "threshold": item.get("threshold"),
                    "distance_to_pass": item.get("distance_to_pass"),
                }
            )
    return {
        "trading_day": raw_near_miss.get("trading_day"),
        "symbol": raw_near_miss.get("symbol"),
        "strategy_type": raw_near_miss.get("strategy_type"),
        "event_ts": raw_near_miss.get("event_ts"),
        "first_failed_gate": raw_near_miss.get("first_failed_gate"),
        "distance_score": raw_near_miss.get("distance_score"),
        "thresholds": threshold_digest,
    }


def _train_gate_diagnostics_from_replay_payload(
    payload: Mapping[str, Any],
) -> dict[str, Any]:
    funnel = payload.get("funnel")
    buckets = (
        cast(list[Any], funnel.get("buckets"))
        if isinstance(funnel, Mapping) and isinstance(funnel.get("buckets"), list)
        else []
    )
    aggregate = {
        "retained_rows": 0,
        "runtime_evaluable_rows": 0,
        "quote_valid_rows": 0,
        "strategy_evaluations": 0,
        "passed_trace_count": 0,
        "decision_count": int(payload.get("decision_count") or 0),
        "filled_count": int(payload.get("filled_count") or 0),
    }
    first_failed_gate_counts: Counter[str] = Counter()
    failing_threshold_counts: Counter[str] = Counter()
    gate_pass_counts: Counter[str] = Counter()
    post_gate_block_reason_counts: Counter[str] = Counter()
    for raw_bucket in buckets:
        if not isinstance(raw_bucket, Mapping):
            continue
        for key in (
            "retained_rows",
            "runtime_evaluable_rows",
            "quote_valid_rows",
            "strategy_evaluations",
            "passed_trace_count",
        ):
            try:
                aggregate[key] += int(raw_bucket.get(key) or 0)
            except (TypeError, ValueError):
                continue
        first_failed_gate_counts.update(
            _counter_from_payload(raw_bucket.get("first_failed_gate_counts"))
        )
        failing_threshold_counts.update(
            _counter_from_payload(raw_bucket.get("failing_threshold_counts"))
        )
        gate_pass_counts.update(
            _counter_from_payload(raw_bucket.get("gate_pass_counts"))
        )
        post_gate_block_reason_counts.update(
            _counter_from_payload(raw_bucket.get("post_gate_block_reason_counts"))
        )

    near_misses = payload.get("near_misses")
    near_miss_digest = [
        _near_miss_digest(item)
        for item in (near_misses if isinstance(near_misses, list) else [])[:20]
        if isinstance(item, Mapping)
    ]
    status = (
        "available"
        if aggregate["strategy_evaluations"] > 0
        else "no_runtime_trace_evaluations"
    )
    return {
        "schema_version": "torghut.frontier-train-gate-diagnostics.v1",
        "status": status,
        "aggregate": aggregate,
        "top_first_failed_gates": _top_counter_payload(first_failed_gate_counts),
        "top_failing_thresholds": _top_counter_payload(failing_threshold_counts),
        "top_gate_pass_counts": _top_counter_payload(gate_pass_counts),
        "top_post_gate_block_reasons": _top_counter_payload(
            post_gate_block_reason_counts
        ),
        "near_misses": near_miss_digest,
    }


__all__ = [
    "_symbol_contributions_from_replay_payload",
    "_top_counter_payload",
    "_counter_from_payload",
    "_near_miss_digest",
    "_train_gate_diagnostics_from_replay_payload",
]
