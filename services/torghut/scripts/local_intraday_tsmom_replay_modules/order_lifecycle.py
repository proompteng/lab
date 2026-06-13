from __future__ import annotations

from app.config import settings

from app.trading.execution_policy import (
    _near_touch_limit_price,
    _should_keep_market_order_for_high_conviction_entry,
)

from app.trading.models import (
    SignalEnvelope,
    StrategyDecision,
)

from app.trading.session_context import regular_session_close_utc_for

from collections import defaultdict

from dataclasses import dataclass

from datetime import datetime

from decimal import Decimal

from typing import (
    Any,
    Iterable,
    Mapping,
)

from .positions import (
    _decision_exit_reason,
    _decision_position_owner,
)

from .replay_types import (
    ClosedTrade,
    PendingOrder,
    _FILL_LATENCY_BUCKETS_MS,
    _FILL_LATENCY_THRESHOLDS_MS,
    _decimal_text,
    _position_key,
    logger,
)

from .signal_rows import (
    _extract_ask,
    _extract_bid,
    _extract_decimal_payload,
    _extract_price,
    _extract_spread,
    _signal_spread_bps,
)


@dataclass(frozen=True)
class OrderLifecycleEvent:
    decision: StrategyDecision
    placement_signal: SignalEnvelope
    created_at: datetime
    resolved_at: datetime
    outcome: str
    censor_reason: str | None = None


@dataclass
class OrderLifecycleBuckets:
    aggregate: dict[str, Any]
    by_day: dict[str, dict[str, Any]]
    by_symbol: dict[str, dict[str, Any]]


@dataclass(frozen=True)
class TraceBlockContext:
    runtime_intent_strategy_ids: set[str]
    runtime_suppression_reason_by_strategy_id: dict[str, str]
    raw_decision_strategy_ids: set[str]
    allocation_reject_reason_by_strategy_id: dict[str, str]
    sizing_reject_reason_by_strategy_id: dict[str, str]
    emitted_strategy_ids: set[str]


def _order_age_ms(*, created_at: datetime, as_of: datetime) -> int:
    return max(0, int((as_of - created_at).total_seconds() * 1000))


def _latency_bucket(ms: int) -> str:
    if ms <= 0:
        return "0ms"
    lower_bound = 1
    for upper_bound in _FILL_LATENCY_BUCKETS_MS[1:]:
        if ms <= upper_bound:
            return f"{lower_bound}-{upper_bound}ms"
        lower_bound = upper_bound + 1
    return f">{_FILL_LATENCY_BUCKETS_MS[-1]}ms"


def _init_order_lifecycle_stats() -> dict[str, Any]:
    return {
        "submitted_order_count": 0,
        "filled_order_count": 0,
        "pending_censored_count": 0,
        "replaced_pending_count": 0,
        "outcome_counts": defaultdict(int),
        "censor_reason_counts": defaultdict(int),
        "decision_count_by_order_type": defaultdict(int),
        "filled_count_by_order_type": defaultdict(int),
        "submitted_count_by_latency_bucket": defaultdict(int),
        "filled_count_by_latency_bucket": defaultdict(int),
        "filled_latency_ms_samples": [],
        "pending_age_ms_samples": [],
        "spread_bps_samples": [],
        "depth_notional_samples": [],
        "queue_touch_qty_samples": [],
        "queue_touch_notional_samples": [],
        "order_qty_to_touch_qty_ratio_samples": [],
        "max_censored_pending_age_ms": 0,
    }


def _append_decimal_sample(
    stats: dict[str, Any],
    key: str,
    value: Decimal | None,
) -> None:
    if value is None:
        return
    samples = stats.setdefault(key, [])
    samples.append(value)


def _execution_proxy_payload(
    *,
    decision: StrategyDecision,
    signal: SignalEnvelope,
) -> dict[str, Decimal]:
    price = _extract_price(signal)
    bid_px = _extract_bid(signal)
    ask_px = _extract_ask(signal)
    bid_qty = _extract_decimal_payload(signal, "imbalance_bid_sz")
    ask_qty = _extract_decimal_payload(signal, "imbalance_ask_sz")
    proxy: dict[str, Decimal] = {}
    spread_bps = _signal_spread_bps(signal=signal, price=price)
    if spread_bps is not None:
        proxy["spread_bps"] = spread_bps
    if (
        bid_px is not None
        and ask_px is not None
        and bid_qty is not None
        and ask_qty is not None
        and bid_px > 0
        and ask_px > 0
        and bid_qty > 0
        and ask_qty > 0
    ):
        proxy["depth_notional"] = (bid_px * bid_qty) + (ask_px * ask_qty)
    normalized_action = decision.action.strip().lower()
    touch_px = ask_px if normalized_action == "buy" else bid_px
    touch_qty = ask_qty if normalized_action == "buy" else bid_qty
    if touch_qty is not None and touch_qty > 0:
        proxy["queue_touch_qty"] = touch_qty
        proxy["order_qty_to_touch_qty_ratio"] = decision.qty / touch_qty
        if touch_px is not None and touch_px > 0:
            proxy["queue_touch_notional"] = touch_px * touch_qty
    return proxy


def _record_order_lifecycle_outcome(
    stats: dict[str, Any],
    event: OrderLifecycleEvent,
) -> None:
    age_ms = _order_age_ms(created_at=event.created_at, as_of=event.resolved_at)
    bucket = _latency_bucket(age_ms)
    normalized_outcome = event.outcome.strip().lower() or "unknown"
    order_type = event.decision.order_type.strip().lower() or "unknown"
    stats["submitted_order_count"] += 1
    stats["outcome_counts"][normalized_outcome] += 1
    stats["decision_count_by_order_type"][order_type] += 1
    stats["submitted_count_by_latency_bucket"][bucket] += 1
    if normalized_outcome == "filled":
        stats["filled_order_count"] += 1
        stats["filled_count_by_order_type"][order_type] += 1
        stats["filled_count_by_latency_bucket"][bucket] += 1
        stats["filled_latency_ms_samples"].append(age_ms)
    else:
        stats["pending_censored_count"] += 1
        stats["pending_age_ms_samples"].append(age_ms)
        stats["max_censored_pending_age_ms"] = max(
            int(stats.get("max_censored_pending_age_ms") or 0),
            age_ms,
        )
        if normalized_outcome == "replaced":
            stats["replaced_pending_count"] += 1
        if event.censor_reason:
            stats["censor_reason_counts"][event.censor_reason] += 1

    proxy = _execution_proxy_payload(
        decision=event.decision,
        signal=event.placement_signal,
    )
    _append_decimal_sample(stats, "spread_bps_samples", proxy.get("spread_bps"))
    _append_decimal_sample(stats, "depth_notional_samples", proxy.get("depth_notional"))
    _append_decimal_sample(
        stats, "queue_touch_qty_samples", proxy.get("queue_touch_qty")
    )
    _append_decimal_sample(
        stats,
        "queue_touch_notional_samples",
        proxy.get("queue_touch_notional"),
    )
    _append_decimal_sample(
        stats,
        "order_qty_to_touch_qty_ratio_samples",
        proxy.get("order_qty_to_touch_qty_ratio"),
    )


def _record_order_lifecycle(
    buckets: OrderLifecycleBuckets,
    event: OrderLifecycleEvent,
) -> None:
    day_key = event.created_at.date().isoformat()
    symbol_key = event.decision.symbol.strip().upper()
    for stats in (
        buckets.aggregate,
        buckets.by_day.setdefault(day_key, _init_order_lifecycle_stats()),
        buckets.by_symbol.setdefault(symbol_key, _init_order_lifecycle_stats()),
    ):
        _record_order_lifecycle_outcome(stats, event)


def _pending_censor_time(
    *,
    pending: PendingOrder,
    fallback: datetime,
) -> datetime:
    close_ts = regular_session_close_utc_for(pending.created_at)
    if close_ts > pending.created_at:
        return close_ts
    return fallback


def _decimal_average(values: list[Decimal]) -> Decimal | None:
    if not values:
        return None
    return sum(values, Decimal("0")) / Decimal(len(values))


def _int_average(values: list[int]) -> Decimal | None:
    if not values:
        return None
    return Decimal(sum(values)) / Decimal(len(values))


def _decimal_percentile(values: list[Decimal], percentile: Decimal) -> Decimal | None:
    if not values:
        return None
    ordered = sorted(values)
    index = int(Decimal(len(ordered) - 1) * percentile)
    return ordered[index]


def _int_percentile(values: list[int], percentile: Decimal) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    index = int(Decimal(len(ordered) - 1) * percentile)
    return ordered[index]


def _decimal_or_none(value: Decimal | None) -> str | None:
    return str(value) if value is not None else None


def _fill_probability_by_latency_bucket(stats: Mapping[str, Any]) -> dict[str, Any]:
    submitted = stats.get("submitted_count_by_latency_bucket") or {}
    filled = stats.get("filled_count_by_latency_bucket") or {}
    payload: dict[str, Any] = {}
    for bucket in sorted(submitted):
        submitted_count = int(submitted[bucket])
        filled_count = int(filled.get(bucket, 0))
        payload[str(bucket)] = {
            "submitted_order_count": submitted_count,
            "filled_order_count": filled_count,
            "fill_rate": str(
                Decimal(filled_count) / Decimal(submitted_count)
                if submitted_count > 0
                else Decimal("0")
            ),
        }
    return payload


def _fill_probability_by_latency_threshold(stats: Mapping[str, Any]) -> dict[str, Any]:
    filled_latency = [
        int(value) for value in stats.get("filled_latency_ms_samples") or []
    ]
    submitted_order_count = int(stats.get("submitted_order_count") or 0)
    payload: dict[str, Any] = {}
    for threshold_ms in _FILL_LATENCY_THRESHOLDS_MS:
        filled_within_count = sum(
            1 for value in filled_latency if value <= threshold_ms
        )
        payload[str(threshold_ms)] = {
            "submitted_order_count": submitted_order_count,
            "filled_within_count": filled_within_count,
            "fill_rate": str(
                Decimal(filled_within_count) / Decimal(submitted_order_count)
                if submitted_order_count > 0
                else Decimal("0")
            ),
        }
    return payload


def _order_lifecycle_summary(
    stats: Mapping[str, Any],
    *,
    post_cost_survivorship: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    filled_latency = [
        int(value) for value in stats.get("filled_latency_ms_samples") or []
    ]
    pending_age = [int(value) for value in stats.get("pending_age_ms_samples") or []]
    spread_bps_samples = list(stats.get("spread_bps_samples") or [])
    depth_notional_samples = list(stats.get("depth_notional_samples") or [])
    queue_touch_qty_samples = list(stats.get("queue_touch_qty_samples") or [])
    queue_touch_notional_samples = list(stats.get("queue_touch_notional_samples") or [])
    touch_ratio_samples = list(stats.get("order_qty_to_touch_qty_ratio_samples") or [])
    submitted_order_count = int(stats.get("submitted_order_count") or 0)
    filled_order_count = int(stats.get("filled_order_count") or 0)
    payload: dict[str, Any] = {
        "submitted_order_count": submitted_order_count,
        "filled_order_count": filled_order_count,
        "pending_censored_count": int(stats.get("pending_censored_count") or 0),
        "replaced_pending_count": int(stats.get("replaced_pending_count") or 0),
        "fill_rate": str(
            Decimal(filled_order_count) / Decimal(submitted_order_count)
            if submitted_order_count > 0
            else Decimal("0")
        ),
        "outcome_counts": dict(sorted((stats.get("outcome_counts") or {}).items())),
        "censor_reason_counts": dict(
            sorted((stats.get("censor_reason_counts") or {}).items())
        ),
        "decision_count_by_order_type": dict(
            sorted((stats.get("decision_count_by_order_type") or {}).items())
        ),
        "filled_count_by_order_type": dict(
            sorted((stats.get("filled_count_by_order_type") or {}).items())
        ),
        "fill_time_ms_avg": _decimal_or_none(_int_average(filled_latency)),
        "fill_time_ms_p50": _int_percentile(filled_latency, Decimal("0.50")),
        "fill_time_ms_p95": _int_percentile(filled_latency, Decimal("0.95")),
        "pending_age_ms_avg": _decimal_or_none(_int_average(pending_age)),
        "pending_age_ms_p95": _int_percentile(pending_age, Decimal("0.95")),
        "max_censored_pending_age_ms": int(
            stats.get("max_censored_pending_age_ms") or 0
        ),
        "fill_probability_by_latency_bucket": _fill_probability_by_latency_bucket(
            stats
        ),
        "fill_probability_by_latency_threshold_ms": _fill_probability_by_latency_threshold(
            stats
        ),
        "spread_bps_avg_at_order": _decimal_or_none(
            _decimal_average(spread_bps_samples)
        ),
        "spread_bps_p95_at_order": _decimal_or_none(
            _decimal_percentile(spread_bps_samples, Decimal("0.95"))
        ),
        "depth_notional_min_at_order": str(min(depth_notional_samples))
        if depth_notional_samples
        else None,
        "depth_notional_avg_at_order": _decimal_or_none(
            _decimal_average(depth_notional_samples)
        ),
        "queue_touch_qty_avg": _decimal_or_none(
            _decimal_average(queue_touch_qty_samples)
        ),
        "queue_touch_notional_avg": _decimal_or_none(
            _decimal_average(queue_touch_notional_samples)
        ),
        "order_qty_to_touch_qty_ratio_p95": _decimal_or_none(
            _decimal_percentile(touch_ratio_samples, Decimal("0.95"))
        ),
        "fill_survival_sample_count": submitted_order_count,
        "fill_survival_evidence_present": submitted_order_count > 0,
    }
    if post_cost_survivorship is not None:
        payload["post_cost_survivorship"] = dict(post_cost_survivorship)
    return payload


def _post_cost_survivorship_summary(trades: list[ClosedTrade]) -> dict[str, Any]:
    closed_trade_count = len(trades)
    gross_positive_count = sum(1 for trade in trades if trade.gross_pnl > 0)
    net_positive_count = sum(1 for trade in trades if trade.net_pnl > 0)
    survived_count = sum(
        1 for trade in trades if trade.gross_pnl > 0 and trade.net_pnl > 0
    )
    killed_count = sum(
        1 for trade in trades if trade.gross_pnl > 0 and trade.net_pnl <= 0
    )
    return {
        "closed_trade_count": closed_trade_count,
        "gross_positive_count": gross_positive_count,
        "net_positive_count": net_positive_count,
        "gross_positive_survived_post_cost_count": survived_count,
        "gross_positive_killed_by_cost_count": killed_count,
        "post_cost_survival_rate": str(
            Decimal(survived_count) / Decimal(gross_positive_count)
            if gross_positive_count > 0
            else Decimal("0")
        ),
    }


def _decision_entry_order_type(decision: StrategyDecision) -> str:
    raw = decision.params.get("entry_order_type")
    if raw is None:
        return "runtime_default"
    value = str(raw).strip().lower()
    return (
        value
        if value in {"market", "limit", "prefer_limit", "runtime_default"}
        else "runtime_default"
    )


def _decision_market_order_spread_bps_max(decision: StrategyDecision) -> Decimal:
    raw = decision.params.get("market_order_spread_bps_max")
    if raw is None:
        return Decimal("12")
    try:
        return max(Decimal("0"), min(Decimal("12"), Decimal(str(raw))))
    except Exception:
        return Decimal("12")


def _decision_spread_bps(
    decision: StrategyDecision,
    *,
    price: Decimal | None,
    spread: Decimal | None,
) -> Decimal | None:
    execution_features = decision.params.get("execution_features")
    if isinstance(execution_features, dict):
        raw = execution_features.get("spread_bps")
        if raw is not None:
            try:
                return Decimal(str(raw))
            except Exception:
                pass
    if spread is None or spread <= 0 or price is None or price <= 0:
        return None
    return (spread / price) * Decimal("10000")


def _apply_order_preferences(
    decision: StrategyDecision,
    signal: SignalEnvelope,
    strategy_params: Mapping[str, Any] | None = None,
) -> StrategyDecision:
    if strategy_params:
        decision = decision.model_copy(
            update={"params": {**dict(strategy_params), **decision.params}}
        )
    position_exit = decision.params.get("position_exit")
    if isinstance(position_exit, dict):
        exit_type = str(position_exit.get("type") or "").strip()
        if exit_type == "session_flatten_minute_utc":
            return decision
    entry_order_type = _decision_entry_order_type(decision)
    if entry_order_type == "market":
        return decision
    prefer_limit = (
        entry_order_type in {"limit", "prefer_limit"}
        or settings.trading_execution_prefer_limit
    )
    if not prefer_limit:
        return decision
    if decision.order_type != "market":
        return decision
    price = _extract_price(signal)
    spread = _extract_spread(signal)
    spread_bps = _decision_spread_bps(decision, price=price, spread=spread)
    market_spread_bps_max = _decision_market_order_spread_bps_max(decision)
    if (
        entry_order_type != "limit"
        and _should_keep_market_order_for_high_conviction_entry(
            decision,
            price=price,
            spread=spread,
        )
        and (spread_bps is None or spread_bps <= market_spread_bps_max)
    ):
        return decision
    return decision.model_copy(
        update={
            "order_type": "limit",
            "limit_price": _near_touch_limit_price(price, spread, decision.action),
        }
    )


def _resolve_pending_fill_price(
    decision: StrategyDecision,
    signal: SignalEnvelope,
) -> Decimal | None:
    price = _extract_price(signal)
    bid = _extract_bid(signal)
    ask = _extract_ask(signal)
    normalized_action = decision.action.strip().lower()

    if decision.order_type == "limit" and decision.limit_price is not None:
        if normalized_action == "buy":
            executable_price = ask if ask is not None else price
            if executable_price > decision.limit_price:
                return None
            return executable_price
        executable_price = bid if bid is not None else price
        if executable_price < decision.limit_price:
            return None
        return executable_price

    if normalized_action == "buy":
        return ask if ask is not None else price
    return bid if bid is not None else price


def _first_reject_reason(
    *,
    reason_codes: Iterable[str],
    default_reason: str,
) -> str:
    for reason_code in reason_codes:
        cleaned = str(reason_code).strip()
        if cleaned:
            return cleaned
    return default_reason


def _resolve_passed_trace_block_reason(
    strategy_id: str,
    context: TraceBlockContext,
) -> str | None:
    if strategy_id not in context.runtime_intent_strategy_ids:
        return "engine_runtime_no_intent"
    for reason_by_strategy_id in (
        context.runtime_suppression_reason_by_strategy_id,
        context.allocation_reject_reason_by_strategy_id,
        context.sizing_reject_reason_by_strategy_id,
    ):
        if strategy_id in reason_by_strategy_id:
            return reason_by_strategy_id[strategy_id]
    if strategy_id not in context.raw_decision_strategy_ids:
        return "engine_runtime_intent_not_emitted"
    if strategy_id not in context.emitted_strategy_ids:
        return "post_runtime_filter_rejected"
    return None


def _pending_order_priority(decision: StrategyDecision) -> int:
    if decision.action.strip().lower() != "sell":
        return 0
    position_exit = decision.params.get("position_exit")
    exit_type = ""
    if isinstance(position_exit, dict):
        exit_type = str(position_exit.get("type") or "").strip()
    if exit_type == "session_flatten_minute_utc":
        return 5
    if exit_type in {"long_stop_loss_bps", "long_trailing_stop_bps"}:
        return 4
    if decision.order_type == "market":
        return 3
    if exit_type:
        return 2
    return 1


def _should_replace_pending_order(
    *,
    existing: StrategyDecision,
    replacement: StrategyDecision,
) -> bool:
    existing_priority = _pending_order_priority(existing)
    replacement_priority = _pending_order_priority(replacement)
    should_replace = False
    if replacement_priority != existing_priority:
        should_replace = replacement_priority > existing_priority
    elif existing.action.strip().lower() == replacement.action.strip().lower():
        should_replace = _same_priority_pending_order_should_replace(
            existing=existing,
            replacement=replacement,
        )
    return should_replace


def _same_priority_pending_order_should_replace(
    *,
    existing: StrategyDecision,
    replacement: StrategyDecision,
) -> bool:
    if existing.order_type != replacement.order_type:
        return existing.order_type == "limit" and replacement.order_type == "market"
    if existing.order_type != "limit":
        return False
    existing_limit = existing.limit_price
    replacement_limit = replacement.limit_price
    if existing_limit is None or replacement_limit is None:
        return False
    replacement_action = replacement.action.strip().lower()
    if replacement_action == "sell":
        return replacement_limit < existing_limit
    if replacement_action == "buy":
        return replacement_limit > existing_limit
    return False


def _reconcile_pending_order_before_immediate_fill(
    *,
    decision: StrategyDecision,
    pending_orders: dict[tuple[str, str], PendingOrder],
    created_at: datetime,
    force_position_isolation: bool = False,
) -> PendingOrder | None:
    pending_key = _position_key(
        decision.symbol,
        _decision_position_owner(
            decision,
            force_position_isolation=force_position_isolation,
        ),
    )
    existing_pending = pending_orders.pop(pending_key, None)
    if existing_pending is None:
        return None
    logger.info(
        "replay_pending_order_cleared_for_immediate_fill ts=%s symbol=%s existing_order_type=%s existing_limit=%s existing_exit=%s immediate_order_type=%s immediate_limit=%s immediate_exit=%s",
        created_at.isoformat(),
        decision.symbol,
        existing_pending.decision.order_type,
        existing_pending.decision.limit_price,
        _decision_exit_reason(existing_pending.decision),
        decision.order_type,
        decision.limit_price,
        _decision_exit_reason(decision),
    )
    return existing_pending


def _log_pending_order_replaced(
    *,
    created_at: datetime,
    existing: StrategyDecision,
    replacement: StrategyDecision,
) -> None:
    logger.info(
        "replay_pending_order_replaced ts=%s symbol=%s existing_order_type=%s existing_limit=%s existing_exit=%s replacement_order_type=%s replacement_limit=%s replacement_exit=%s",
        created_at.isoformat(),
        replacement.symbol,
        existing.order_type,
        _decimal_text(existing.limit_price)
        if existing.limit_price is not None
        else "None",
        _decision_exit_reason(existing),
        replacement.order_type,
        _decimal_text(replacement.limit_price)
        if replacement.limit_price is not None
        else "None",
        _decision_exit_reason(replacement),
    )
