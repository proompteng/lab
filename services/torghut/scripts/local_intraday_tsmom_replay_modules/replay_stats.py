from __future__ import annotations

from app.trading.evaluation_trace import (
    NearMissRecord,
    StrategyTrace,
)

from app.trading.models import (
    SignalEnvelope,
    StrategyDecision,
)

from collections import defaultdict

from dataclasses import dataclass

from datetime import (
    date,
    datetime,
)

from decimal import Decimal

from typing import Any

from .fill_stats import _ensure_replay_stats_bucket

from .signal_rows import (
    _extract_ask,
    _extract_bid,
    _extract_decimal_payload,
    _extract_price,
)

from .positions import (
    _position_equity,
    _position_exposure,
)

from .replay_types import (
    PositionState,
    _decimal_text,
    logger,
)


@dataclass(frozen=True)
class ReplayProgressSnapshot:
    signal_day: date
    signal_ts: datetime
    signals_seen: int
    day_bucket: dict[str, Any]
    open_position_count: int
    pending_order_count: int
    cash: Decimal
    equity: Decimal


def _record_decision(stats: dict[str, Any], decision: StrategyDecision) -> None:
    stats["decision_count"] += 1
    symbol_counts = stats.setdefault("decision_symbols", defaultdict(int))
    symbol_counts[decision.symbol] += 1
    order_type_counts = stats.setdefault(
        "decision_count_by_order_type", defaultdict(int)
    )
    order_type_counts[decision.order_type] += 1


def _init_day_stats() -> dict[str, Any]:
    return {
        "decision_count": 0,
        "filled_count": 0,
        "decision_count_by_order_type": defaultdict(int),
        "filled_count_by_order_type": defaultdict(int),
        "filled_notional": Decimal("0"),
        "daily_adv_notional": Decimal("0"),
        "depth_notional": None,
        "liquidity_observation_count": 0,
        "gross_pnl": Decimal("0"),
        "net_pnl": Decimal("0"),
        "cost_total": Decimal("0"),
        "wins": 0,
        "losses": 0,
        "closed_trades": [],
        "capital_snapshot_count": 0,
        "min_cash": None,
        "min_equity": None,
        "max_gross_exposure": Decimal("0"),
        "max_net_exposure_abs": Decimal("0"),
        "max_gross_exposure_pct_equity": Decimal("0"),
        "negative_cash_observation_count": 0,
    }


def _init_funnel_stats() -> dict[str, Any]:
    return {
        "retained_rows": 0,
        "runtime_evaluable_rows": 0,
        "quote_valid_rows": 0,
        "strategy_evaluations": 0,
        "gate_pass_counts": defaultdict(int),
        "first_failed_gate_counts": defaultdict(int),
        "failing_threshold_counts": defaultdict(int),
        "post_gate_block_reason_counts": defaultdict(int),
        "passed_trace_count": 0,
        "decision_count": 0,
        "filled_count": 0,
        "decision_count_by_order_type": defaultdict(int),
        "filled_count_by_order_type": defaultdict(int),
        "filled_notional": Decimal("0"),
        "closed_trade_count": 0,
        "gross_pnl": Decimal("0"),
        "net_pnl": Decimal("0"),
        "cost_total": Decimal("0"),
    }


def _record_liquidity_observation(
    *, bucket: dict[str, Any], signal: SignalEnvelope
) -> None:
    bucket = _ensure_replay_stats_bucket(bucket)
    price = _extract_price(signal)
    observed = False
    microbar_volume = _extract_decimal_payload(signal, "microbar_volume")
    if microbar_volume is not None and microbar_volume > 0 and price > 0:
        bucket["daily_adv_notional"] += microbar_volume * price
        observed = True

    bid_px = _extract_bid(signal)
    ask_px = _extract_ask(signal)
    bid_sz = _extract_decimal_payload(signal, "imbalance_bid_sz")
    ask_sz = _extract_decimal_payload(signal, "imbalance_ask_sz")
    if (
        bid_px is not None
        and ask_px is not None
        and bid_sz is not None
        and ask_sz is not None
        and bid_px > 0
        and ask_px > 0
        and bid_sz > 0
        and ask_sz > 0
    ):
        depth_notional = (bid_px * bid_sz) + (ask_px * ask_sz)
        current_depth = bucket.get("depth_notional")
        if not isinstance(current_depth, Decimal) or depth_notional < current_depth:
            bucket["depth_notional"] = depth_notional
        observed = True

    if observed:
        bucket["liquidity_observation_count"] += 1


def _record_capital_snapshot(
    *,
    bucket: dict[str, Any],
    cash: Decimal,
    positions: dict[tuple[str, str], PositionState],
    last_prices: dict[str, Decimal],
) -> Decimal:
    bucket = _ensure_replay_stats_bucket(bucket)
    equity = _position_equity(cash=cash, positions=positions, last_prices=last_prices)
    gross_exposure, net_exposure = _position_exposure(
        positions=positions,
        last_prices=last_prices,
    )
    gross_exposure_pct_equity = (
        gross_exposure / equity
        if equity > 0
        else Decimal("999999999")
        if gross_exposure > 0
        else Decimal("0")
    )
    min_cash = bucket.get("min_cash")
    if not isinstance(min_cash, Decimal) or cash < min_cash:
        bucket["min_cash"] = cash
    min_equity = bucket.get("min_equity")
    if not isinstance(min_equity, Decimal) or equity < min_equity:
        bucket["min_equity"] = equity
    if gross_exposure > bucket["max_gross_exposure"]:
        bucket["max_gross_exposure"] = gross_exposure
    net_exposure_abs = abs(net_exposure)
    if net_exposure_abs > bucket["max_net_exposure_abs"]:
        bucket["max_net_exposure_abs"] = net_exposure_abs
    if gross_exposure_pct_equity > bucket["max_gross_exposure_pct_equity"]:
        bucket["max_gross_exposure_pct_equity"] = gross_exposure_pct_equity
    bucket["capital_snapshot_count"] += 1
    if cash < 0:
        bucket["negative_cash_observation_count"] += 1
    return equity


def _record_trace_for_funnel(
    stats: dict[str, Any],
    trace: StrategyTrace,
) -> None:
    stats["strategy_evaluations"] += 1
    if trace.passed:
        stats["passed_trace_count"] += 1
    for gate in trace.gates:
        if not gate.passed:
            break
        gate_key = f"{trace.strategy_type}:{gate.gate}"
        stats["gate_pass_counts"][gate_key] += 1
    if trace.first_failed_gate is None:
        return
    failed_gate_key = f"{trace.strategy_type}:{trace.first_failed_gate}"
    stats["first_failed_gate_counts"][failed_gate_key] += 1
    failed_gate = trace.failed_gate()
    if failed_gate is None:
        return
    for threshold in failed_gate.failing_thresholds():
        threshold_key = f"{trace.strategy_type}:{failed_gate.gate}:{threshold.metric}"
        stats["failing_threshold_counts"][threshold_key] += 1


def _build_near_miss(
    trace: StrategyTrace, *, trading_day: str
) -> NearMissRecord | None:
    if trace.passed or trace.first_failed_gate is None:
        return None
    failed_gate = trace.failed_gate()
    if failed_gate is None:
        return None
    failing_thresholds = failed_gate.failing_thresholds()
    if not failing_thresholds:
        return None
    return NearMissRecord(
        trading_day=trading_day,
        symbol=trace.symbol,
        strategy_id=trace.strategy_id,
        strategy_type=trace.strategy_type,
        event_ts=trace.event_ts,
        action=trace.action,
        first_failed_gate=trace.first_failed_gate,
        distance_score=trace.distance_score(),
        thresholds=failing_thresholds,
    )


def _insert_near_miss(
    near_misses: dict[str, list[NearMissRecord]],
    record: NearMissRecord,
    *,
    limit: int = 20,
) -> None:
    bucket = near_misses.setdefault(record.trading_day, [])
    bucket.append(record)
    bucket.sort(
        key=lambda item: (
            item.distance_score,
            item.event_ts,
            item.strategy_id,
            item.symbol,
        )
    )
    del bucket[limit:]


def _log_decision_queued(decision: StrategyDecision, created_at: datetime) -> None:
    logger.info(
        "replay_decision_queued ts=%s strategy_id=%s symbol=%s action=%s qty=%s order_type=%s limit_price=%s rationale=%s",
        created_at.isoformat(),
        decision.strategy_id,
        decision.symbol,
        decision.action,
        _decimal_text(decision.qty),
        decision.order_type,
        _decimal_text(decision.limit_price)
        if decision.limit_price is not None
        else "None",
        decision.rationale or "",
    )


def _log_day_summary(
    *,
    day: date,
    stats: dict[str, Any],
    cash: Decimal,
    equity: Decimal,
    open_positions: int,
) -> None:
    logger.info(
        "replay_day_complete day=%s decisions=%s fills=%s wins=%s losses=%s gross_pnl=%s net_pnl=%s cost_total=%s cash=%s equity=%s open_positions=%s",
        day.isoformat(),
        stats["decision_count"],
        stats["filled_count"],
        stats["wins"],
        stats["losses"],
        _decimal_text(stats["gross_pnl"]),
        _decimal_text(stats["net_pnl"]),
        _decimal_text(stats["cost_total"]),
        _decimal_text(cash),
        _decimal_text(equity),
        open_positions,
    )


def _log_progress(snapshot: ReplayProgressSnapshot) -> None:
    logger.info(
        "replay_progress day=%s ts=%s signals=%s decisions=%s fills=%s wins=%s losses=%s pending_orders=%s open_positions=%s cash=%s equity=%s",
        snapshot.signal_day.isoformat(),
        snapshot.signal_ts.isoformat(),
        snapshot.signals_seen,
        snapshot.day_bucket["decision_count"],
        snapshot.day_bucket["filled_count"],
        snapshot.day_bucket["wins"],
        snapshot.day_bucket["losses"],
        snapshot.pending_order_count,
        snapshot.open_position_count,
        _decimal_text(snapshot.cash),
        _decimal_text(snapshot.equity),
    )


def _signal_regime_label(signal: SignalEnvelope) -> str | None:
    payload = signal.payload or {}
    for key in ("route_regime_label", "regime_label"):
        raw = payload.get(key)
        if raw is None:
            continue
        value = str(raw).strip()
        if value:
            return value
    return None
