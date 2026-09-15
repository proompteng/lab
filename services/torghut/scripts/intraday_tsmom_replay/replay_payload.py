from __future__ import annotations

import time as time_mod
from collections import defaultdict
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from app.trading.evaluation_trace import ReplayFunnelBucket, ReplayFunnelReport

from .ledger import _exact_replay_ledger_payload
from .order_lifecycle import _order_lifecycle_summary, _post_cost_survivorship_summary
from .positions import _position_equity
from .replay_state import ReplayRunState
from .replay_types import ClosedTrade, _decimal_text, logger


@dataclass(frozen=True)
class ReplaySummaryMetrics:
    final_equity: Decimal
    total_decisions: int
    total_filled: int
    total_filled_notional: Decimal
    decision_count_by_order_type: dict[str, int]
    filled_count_by_order_type: dict[str, int]
    total_gross: Decimal
    total_net: Decimal
    total_cost: Decimal
    wins: int
    losses: int
    min_cash: Decimal
    min_equity: Decimal
    max_gross_exposure: Decimal
    max_net_exposure_abs: Decimal
    max_gross_exposure_pct_equity: Decimal
    capital_snapshot_count: int
    negative_cash_observation_count: int

    @classmethod
    def from_state(cls, state: ReplayRunState) -> "ReplaySummaryMetrics":
        final_equity = _position_equity(
            cash=state.cash,
            positions=state.positions,
            last_prices=state.last_prices,
        )
        return cls(
            final_equity=final_equity,
            total_decisions=sum(
                item["decision_count"] for item in state.day_stats.values()
            ),
            total_filled=sum(item["filled_count"] for item in state.day_stats.values()),
            total_filled_notional=sum(
                (item["filled_notional"] for item in state.day_stats.values()),
                Decimal("0"),
            ),
            decision_count_by_order_type=_order_type_counts(
                state.day_stats,
                "decision_count_by_order_type",
            ),
            filled_count_by_order_type=_order_type_counts(
                state.day_stats,
                "filled_count_by_order_type",
            ),
            total_gross=sum(
                (item["gross_pnl"] for item in state.day_stats.values()),
                Decimal("0"),
            ),
            total_net=final_equity - state.config.start_equity,
            total_cost=sum(
                (item["cost_total"] for item in state.day_stats.values()),
                Decimal("0"),
            ),
            wins=sum(item["wins"] for item in state.day_stats.values()),
            losses=sum(item["losses"] for item in state.day_stats.values()),
            min_cash=_decimal_metric_extreme(state, "min_cash", state.cash, min),
            min_equity=_decimal_metric_extreme(state, "min_equity", final_equity, min),
            max_gross_exposure=_decimal_metric_extreme(
                state,
                "max_gross_exposure",
                Decimal("0"),
                max,
            ),
            max_net_exposure_abs=_decimal_metric_extreme(
                state,
                "max_net_exposure_abs",
                Decimal("0"),
                max,
            ),
            max_gross_exposure_pct_equity=_decimal_metric_extreme(
                state,
                "max_gross_exposure_pct_equity",
                Decimal("0"),
                max,
            ),
            capital_snapshot_count=sum(
                int(item.get("capital_snapshot_count") or 0)
                for item in state.day_stats.values()
            ),
            negative_cash_observation_count=sum(
                int(item.get("negative_cash_observation_count") or 0)
                for item in state.day_stats.values()
            ),
        )


def _build_payload(state: ReplayRunState) -> dict[str, Any]:
    metrics = ReplaySummaryMetrics.from_state(state)
    closed_trades = sorted(state.all_closed_trades, key=lambda item: item.net_pnl)
    _log_replay_complete(state, metrics)
    payload = _base_payload(state, metrics, closed_trades)
    _attach_exact_replay_ledger(state, payload)
    return payload


def _log_replay_complete(
    state: ReplayRunState,
    metrics: ReplaySummaryMetrics,
) -> None:
    logger.info(
        "replay_complete elapsed_s=%.3f signals=%s decisions=%s fills=%s wins=%s losses=%s gross_pnl=%s net_pnl=%s total_cost=%s final_equity=%s",
        time_mod.monotonic() - state.replay_started_at,
        state.signals_seen,
        metrics.total_decisions,
        metrics.total_filled,
        metrics.wins,
        metrics.losses,
        _decimal_text(metrics.total_gross),
        _decimal_text(metrics.total_net),
        _decimal_text(metrics.total_cost),
        _decimal_text(metrics.final_equity),
    )


def _base_payload(
    state: ReplayRunState,
    metrics: ReplaySummaryMetrics,
    closed_trades: list[ClosedTrade],
) -> dict[str, Any]:
    return {
        **_identity_payload(state, metrics),
        **_performance_payload(metrics),
        **_risk_payload(metrics),
        **_position_and_day_payload(state),
        "largest_losses": [_closed_trade_item(item) for item in closed_trades[:10]],
        "largest_wins": [
            _closed_trade_item(item) for item in list(reversed(closed_trades[-10:]))
        ],
        "trace": [item.to_payload() for item in state.trace_records],
        "funnel": _funnel_report(state).to_payload(),
        "near_misses": _near_miss_payload(state),
        "order_lifecycle": _order_lifecycle_summary(
            state.order_lifecycle_stats,
            post_cost_survivorship=_post_cost_survivorship_summary(
                state.all_closed_trades
            ),
        ),
        "order_lifecycle_by_day": {
            key: _order_lifecycle_summary(value)
            for key, value in sorted(state.order_lifecycle_day_stats.items())
        },
        "order_lifecycle_by_symbol": {
            key: _order_lifecycle_summary(value)
            for key, value in sorted(state.order_lifecycle_symbol_stats.items())
        },
    }


def _identity_payload(
    state: ReplayRunState,
    metrics: ReplaySummaryMetrics,
) -> dict[str, Any]:
    return {
        "start_date": state.config.start_date.isoformat(),
        "end_date": state.config.end_date.isoformat(),
        "start_equity": str(state.config.start_equity),
        "economic_policy": {
            "schema_version": state.economic_policy.schema_version,
            "policy_id": state.economic_policy.policy_id,
            "digest": state.economic_policy.digest,
        },
        "final_cash": str(state.cash),
        "final_equity": str(metrics.final_equity),
    }


def _performance_payload(metrics: ReplaySummaryMetrics) -> dict[str, Any]:
    return {
        "net_pnl": str(metrics.total_net),
        "gross_pnl": str(metrics.total_gross),
        "total_cost": str(metrics.total_cost),
        "decision_count": metrics.total_decisions,
        "decision_count_by_order_type": metrics.decision_count_by_order_type,
        "filled_count": metrics.total_filled,
        "filled_count_by_order_type": metrics.filled_count_by_order_type,
        "limit_fill_rate": _limit_fill_rate(
            metrics.filled_count_by_order_type,
            metrics.decision_count_by_order_type,
        ),
        "filled_notional": str(metrics.total_filled_notional),
        "wins": metrics.wins,
        "losses": metrics.losses,
    }


def _risk_payload(metrics: ReplaySummaryMetrics) -> dict[str, Any]:
    return {
        "capital_snapshot_count": metrics.capital_snapshot_count,
        "min_cash": str(metrics.min_cash),
        "min_equity": str(metrics.min_equity),
        "max_gross_exposure": str(metrics.max_gross_exposure),
        "max_net_exposure_abs": str(metrics.max_net_exposure_abs),
        "max_gross_exposure_pct_equity": str(metrics.max_gross_exposure_pct_equity),
        "negative_cash_observation_count": metrics.negative_cash_observation_count,
    }


def _position_and_day_payload(state: ReplayRunState) -> dict[str, Any]:
    return {
        "open_positions": _open_positions_payload(state),
        "daily": _daily_payload(state),
    }


def _attach_exact_replay_ledger(
    state: ReplayRunState,
    payload: dict[str, Any],
) -> None:
    if state.exact_ledger_rows is None or state.ledger_context is None:
        return
    payload["exact_replay_ledger"] = _exact_replay_ledger_payload(
        rows=state.exact_ledger_rows,
        config=state.config,
        context=state.ledger_context,
    )


def _order_type_counts(
    day_stats: dict[str, dict[str, Any]],
    key: str,
) -> dict[str, int]:
    counts: dict[str, int] = defaultdict(int)
    for item in day_stats.values():
        for order_type, count in item.get(key, {}).items():
            counts[str(order_type)] += int(count)
    return dict(sorted(counts.items()))


def _decimal_metric_extreme(
    state: ReplayRunState,
    key: str,
    default: Decimal,
    selector: Any,
) -> Decimal:
    values = [
        value
        for item in state.day_stats.values()
        if isinstance((value := item.get(key)), Decimal)
    ]
    return selector(values, default=default)


def _limit_fill_rate(
    filled_counts: dict[str, int], decision_counts: dict[str, int]
) -> str | None:
    limit_decisions = decision_counts.get("limit", 0)
    if limit_decisions <= 0:
        return None
    return str(Decimal(filled_counts.get("limit", 0)) / Decimal(limit_decisions))


def _funnel_report(state: ReplayRunState) -> ReplayFunnelReport:
    return ReplayFunnelReport(
        start_date=state.config.start_date.isoformat(),
        end_date=state.config.end_date.isoformat(),
        buckets=tuple(
            _funnel_bucket(trading_day, symbol, bucket)
            for (trading_day, symbol), bucket in sorted(state.funnel_stats.items())
        ),
    )


def _funnel_bucket(
    trading_day: str,
    symbol: str,
    bucket: dict[str, Any],
) -> ReplayFunnelBucket:
    return ReplayFunnelBucket(
        trading_day=trading_day,
        symbol=symbol,
        retained_rows=int(bucket["retained_rows"]),
        runtime_evaluable_rows=int(bucket["runtime_evaluable_rows"]),
        quote_valid_rows=int(bucket["quote_valid_rows"]),
        strategy_evaluations=int(bucket["strategy_evaluations"]),
        gate_pass_counts=dict(bucket["gate_pass_counts"]),
        first_failed_gate_counts=dict(bucket["first_failed_gate_counts"]),
        failing_threshold_counts=dict(bucket["failing_threshold_counts"]),
        post_gate_block_reason_counts=dict(bucket["post_gate_block_reason_counts"]),
        passed_trace_count=int(bucket["passed_trace_count"]),
        decision_count=int(bucket["decision_count"]),
        filled_count=int(bucket["filled_count"]),
        filled_notional=bucket["filled_notional"],
        closed_trade_count=int(bucket["closed_trade_count"]),
        gross_pnl=bucket["gross_pnl"],
        net_pnl=bucket["net_pnl"],
        cost_total=bucket["cost_total"],
        daily_adv_notional=bucket.get("daily_adv_notional", Decimal("0")),
        depth_notional=bucket.get("depth_notional")
        if isinstance(bucket.get("depth_notional"), Decimal)
        else None,
        liquidity_observation_count=int(bucket.get("liquidity_observation_count") or 0),
    )


def _near_miss_payload(state: ReplayRunState) -> list[dict[str, Any]]:
    return [
        item.to_payload()
        for trading_day in sorted(state.near_misses)
        for item in state.near_misses[trading_day]
    ]


def _closed_trade_item(trade: ClosedTrade) -> dict[str, str]:
    return {
        "symbol": trade.symbol,
        "strategy_id": trade.strategy_id,
        "decision_at": trade.decision_at.isoformat(),
        "opened_at": trade.opened_at.isoformat(),
        "closed_at": trade.closed_at.isoformat(),
        "qty": str(trade.qty),
        "entry_price": str(trade.entry_price),
        "exit_price": str(trade.exit_price),
        "net_pnl": str(trade.net_pnl),
        "exit_reason": trade.exit_reason,
    }


def _daily_payload(state: ReplayRunState) -> dict[str, dict[str, Any]]:
    return {key: _daily_item(value) for key, value in sorted(state.day_stats.items())}


def _daily_item(value: dict[str, Any]) -> dict[str, Any]:
    decision_counts = dict(
        sorted(value.get("decision_count_by_order_type", {}).items())
    )
    filled_counts = dict(sorted(value.get("filled_count_by_order_type", {}).items()))
    return {
        "decision_count": value["decision_count"],
        "decision_count_by_order_type": decision_counts,
        "filled_count": value["filled_count"],
        "filled_count_by_order_type": filled_counts,
        "limit_fill_rate": _limit_fill_rate(filled_counts, decision_counts),
        "filled_notional": str(value["filled_notional"]),
        "daily_adv_notional": str(value["daily_adv_notional"]),
        "depth_notional": str(value["depth_notional"])
        if isinstance(value.get("depth_notional"), Decimal)
        else None,
        "liquidity_observation_count": int(
            value.get("liquidity_observation_count") or 0
        ),
        "gross_pnl": str(value["gross_pnl"]),
        "net_pnl": str(value["net_pnl"]),
        "cost_total": str(value["cost_total"]),
        "wins": value["wins"],
        "losses": value["losses"],
        "capital_snapshot_count": int(value.get("capital_snapshot_count") or 0),
        "min_cash": str(value["min_cash"])
        if isinstance(value.get("min_cash"), Decimal)
        else None,
        "min_equity": str(value["min_equity"])
        if isinstance(value.get("min_equity"), Decimal)
        else None,
        "max_gross_exposure": str(value.get("max_gross_exposure", Decimal("0"))),
        "max_net_exposure_abs": str(value.get("max_net_exposure_abs", Decimal("0"))),
        "max_gross_exposure_pct_equity": str(
            value.get("max_gross_exposure_pct_equity", Decimal("0"))
        ),
        "negative_cash_observation_count": int(
            value.get("negative_cash_observation_count") or 0
        ),
    }


def _open_positions_payload(state: ReplayRunState) -> dict[str, dict[str, str]]:
    return {
        f"{symbol}|{owner_strategy_id}": {
            "strategy_id": position.strategy_id,
            "qty": str(position.qty),
            "avg_entry_price": str(position.avg_entry_price),
            "last_price": str(state.last_prices.get(symbol, position.avg_entry_price)),
        }
        for (symbol, owner_strategy_id), position in state.positions.items()
    }


__all__ = [
    "ReplaySummaryMetrics",
    "_build_payload",
]
