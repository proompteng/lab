"""Import observed runtime windows into the hypothesis governance ledger."""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Sequence


from .common import (
    ObservedRuntimeBucket,
    observation_int,
    optional_decimal,
    runtime_ledger_bucket_blockers,
)
from .ledger_persistence import (
    median_decimal,
    p10_decimal,
    runtime_ledger_equity_denominator,
    runtime_ledger_symbol_pnl_items,
    runtime_ledger_trading_day_key,
)
from .observed_buckets import runtime_ledger_bucket_payloads


def _empty_symbol_pnl() -> dict[str, Decimal]:
    return {}


def _empty_equity_denominators() -> list[tuple[Decimal, str]]:
    return []


@dataclass
class _DailyRuntimeLedgerState:
    trading_days: list[str]
    net_pnl_by_day: dict[str, Decimal]
    filled_notional_by_day: dict[str, Decimal]
    closed_trade_count_by_day: dict[str, int]
    cumulative_by_day: dict[str, Decimal]
    peak_by_day: dict[str, Decimal]
    max_intraday_drawdown: Decimal = Decimal("0")
    symbol_net_pnl: dict[str, Decimal] = field(default_factory=_empty_symbol_pnl)
    equity_denominators: list[tuple[Decimal, str]] = field(
        default_factory=_empty_equity_denominators
    )


def _new_daily_runtime_ledger_state(
    buckets: Sequence[ObservedRuntimeBucket],
) -> _DailyRuntimeLedgerState:
    trading_days = sorted(
        {runtime_ledger_trading_day_key(bucket.window_started_at) for bucket in buckets}
    )
    return _DailyRuntimeLedgerState(
        trading_days=trading_days,
        net_pnl_by_day={day: Decimal("0") for day in trading_days},
        filled_notional_by_day={day: Decimal("0") for day in trading_days},
        closed_trade_count_by_day={day: 0 for day in trading_days},
        cumulative_by_day={day: Decimal("0") for day in trading_days},
        peak_by_day={day: Decimal("0") for day in trading_days},
    )


def _record_daily_ledger_payload(
    state: _DailyRuntimeLedgerState,
    day: str,
    ledger_payload: dict[str, Any],
) -> Decimal:
    if runtime_ledger_bucket_blockers(ledger_payload):
        return Decimal("0")
    net_pnl = optional_decimal(ledger_payload.get("net_strategy_pnl_after_costs"))
    filled_notional = optional_decimal(ledger_payload.get("filled_notional"))
    bucket_net_pnl = net_pnl or Decimal("0")
    state.net_pnl_by_day[day] += bucket_net_pnl
    if filled_notional is not None and filled_notional > 0:
        state.filled_notional_by_day[day] += filled_notional
    state.closed_trade_count_by_day[day] += observation_int(
        ledger_payload.get("closed_trade_count")
    )
    for symbol, pnl in runtime_ledger_symbol_pnl_items(ledger_payload, net_pnl=net_pnl):
        state.symbol_net_pnl[symbol] = (
            state.symbol_net_pnl.get(symbol, Decimal("0")) + pnl
        )
    if equity_denominator := runtime_ledger_equity_denominator(ledger_payload):
        state.equity_denominators.append(equity_denominator)
    return bucket_net_pnl


def _record_bucket_daily_drawdown(
    state: _DailyRuntimeLedgerState,
    day: str,
    bucket_net_pnl: Decimal,
) -> None:
    state.cumulative_by_day[day] += bucket_net_pnl
    if state.cumulative_by_day[day] > state.peak_by_day[day]:
        state.peak_by_day[day] = state.cumulative_by_day[day]
    drawdown = state.peak_by_day[day] - state.cumulative_by_day[day]
    if drawdown > state.max_intraday_drawdown:
        state.max_intraday_drawdown = drawdown


def _collect_daily_runtime_ledger_state(
    buckets: Sequence[ObservedRuntimeBucket],
) -> _DailyRuntimeLedgerState:
    state = _new_daily_runtime_ledger_state(buckets)

    for bucket in buckets:
        day = runtime_ledger_trading_day_key(bucket.window_started_at)
        bucket_net_pnl = Decimal("0")
        for ledger_payload in runtime_ledger_bucket_payloads(bucket.payload_json):
            bucket_net_pnl += _record_daily_ledger_payload(
                state,
                day,
                ledger_payload,
            )
        _record_bucket_daily_drawdown(state, day, bucket_net_pnl)
    return state


def _base_daily_summary(state: _DailyRuntimeLedgerState) -> dict[str, Any]:
    day_count = len(state.trading_days)
    daily_net_values = [state.net_pnl_by_day[day] for day in state.trading_days]
    total_daily_net_pnl = sum(daily_net_values, Decimal("0"))
    total_filled_notional = sum(
        (state.filled_notional_by_day[day] for day in state.trading_days),
        Decimal("0"),
    )
    mean_daily_net_pnl = (
        total_daily_net_pnl / Decimal(day_count) if day_count > 0 else Decimal("0")
    )
    avg_daily_filled_notional = (
        total_filled_notional / Decimal(day_count) if day_count > 0 else Decimal("0")
    )
    positive_daily_values = [value for value in daily_net_values if value > 0]
    total_positive_daily_net_pnl = sum(positive_daily_values, Decimal("0"))
    summary: dict[str, Any] = {
        "runtime_ledger_observed_trading_day_count": day_count,
        "runtime_ledger_net_pnl_by_trading_day": {
            day: str(state.net_pnl_by_day[day]) for day in state.trading_days
        },
        "runtime_ledger_mean_daily_net_pnl_after_costs": str(mean_daily_net_pnl),
        "runtime_ledger_median_daily_net_pnl_after_costs": str(
            median_decimal(daily_net_values)
        ),
        "runtime_ledger_p10_daily_net_pnl_after_costs": str(
            p10_decimal(daily_net_values)
        ),
        "runtime_ledger_worst_day_net_pnl_after_costs": str(
            min(daily_net_values) if daily_net_values else Decimal("0")
        ),
        "runtime_ledger_max_intraday_drawdown": str(state.max_intraday_drawdown),
        "runtime_ledger_avg_daily_filled_notional": str(avg_daily_filled_notional),
        "runtime_ledger_filled_notional_by_trading_day": {
            day: str(state.filled_notional_by_day[day]) for day in state.trading_days
        },
        "runtime_ledger_closed_trade_count_by_day": {
            day: state.closed_trade_count_by_day[day] for day in state.trading_days
        },
    }
    if total_positive_daily_net_pnl > 0:
        summary["runtime_ledger_best_day_share"] = str(
            max(positive_daily_values) / total_positive_daily_net_pnl
        )
    return summary


def _add_equity_summary(
    summary: dict[str, Any],
    state: _DailyRuntimeLedgerState,
) -> None:
    if state.equity_denominators:
        equity_denominator, equity_source = min(
            state.equity_denominators, key=lambda item: item[0]
        )
        summary["runtime_ledger_drawdown_pct_equity"] = str(
            state.max_intraday_drawdown / equity_denominator
        )
        summary["runtime_ledger_max_drawdown_pct_equity"] = summary[
            "runtime_ledger_drawdown_pct_equity"
        ]
        summary["runtime_ledger_drawdown_pct_equity_source"] = equity_source


def _add_symbol_summary(
    summary: dict[str, Any],
    state: _DailyRuntimeLedgerState,
) -> None:
    symbol_abs_pnl = {
        symbol: abs(value)
        for symbol, value in state.symbol_net_pnl.items()
        if value != 0
    }
    total_symbol_abs_pnl = sum(symbol_abs_pnl.values(), Decimal("0"))
    if total_symbol_abs_pnl > 0:
        summary["runtime_ledger_net_pnl_by_symbol"] = {
            symbol: str(state.symbol_net_pnl[symbol])
            for symbol in sorted(state.symbol_net_pnl)
        }
        summary["runtime_ledger_symbol_concentration_share"] = str(
            max(symbol_abs_pnl.values()) / total_symbol_abs_pnl
        )
        summary["runtime_ledger_symbol_concentration_basis"] = "absolute_net_pnl"


def runtime_ledger_daily_summary_from_observed_buckets(
    buckets: Sequence[ObservedRuntimeBucket],
) -> dict[str, Any]:
    ordered_buckets = sorted(buckets, key=lambda item: item.window_started_at)
    state = _collect_daily_runtime_ledger_state(ordered_buckets)
    summary = _base_daily_summary(state)
    _add_equity_summary(summary, state)
    _add_symbol_summary(summary, state)
    return summary
