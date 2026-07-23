from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Mapping, cast

from .core import (
    SleeveSignalEvaluation,
    SleeveSignalResult,
    build_sleeve_result,
    exit_trigger_gate,
)
from .helpers import (
    decimal_param,
    optional_decimal_param,
    optional_max_threshold,
    relax_floor_for_isolated_strength,
)


@dataclass(frozen=True)
class BreakoutExitRequest:
    params: Mapping[str, Any]
    strategy_id: str | None
    strategy_type: str | None
    symbol: str
    event_ts: str
    timeframe: str | None
    trace_enabled: bool
    trace_context: dict[str, Any]
    price: Decimal
    ema12: Decimal
    rsi14: Decimal
    macd_hist: Decimal
    price_vs_opening_range_high_bps: Decimal | None
    price_vs_vwap_w5m_bps: Decimal | None
    price_position_in_session_range: Decimal | None
    price_vs_session_open_bps: Decimal | None
    recent_imbalance_pressure_avg: Decimal | None
    isolated_strength_confirmed: bool

    @classmethod
    def from_kwargs(cls, values: Mapping[str, Any]) -> BreakoutExitRequest:
        return cls(
            params=cast(Mapping[str, Any], values["params"]),
            strategy_id=cast(str | None, values.get("strategy_id")),
            strategy_type=cast(str | None, values.get("strategy_type")),
            symbol=cast(str, values["symbol"]),
            event_ts=cast(str, values["event_ts"]),
            timeframe=cast(str | None, values.get("timeframe")),
            trace_enabled=cast(bool, values["trace_enabled"]),
            trace_context=cast(dict[str, Any], values["trace_context"]),
            price=cast(Decimal, values["price"]),
            ema12=cast(Decimal, values["ema12"]),
            rsi14=cast(Decimal, values["rsi14"]),
            macd_hist=cast(Decimal, values["macd_hist"]),
            price_vs_opening_range_high_bps=cast(
                Decimal | None,
                values.get("price_vs_opening_range_high_bps"),
            ),
            price_vs_vwap_w5m_bps=cast(
                Decimal | None,
                values.get("price_vs_vwap_w5m_bps"),
            ),
            price_position_in_session_range=cast(
                Decimal | None,
                values.get("price_position_in_session_range"),
            ),
            price_vs_session_open_bps=cast(
                Decimal | None,
                values.get("price_vs_session_open_bps"),
            ),
            recent_imbalance_pressure_avg=cast(
                Decimal | None,
                values.get("recent_imbalance_pressure_avg"),
            ),
            isolated_strength_confirmed=cast(
                bool,
                values["isolated_strength_confirmed"],
            ),
        )


def breakout_exit_result(
    request: BreakoutExitRequest | None = None,
    **kwargs: Any,
) -> SleeveSignalResult | None:
    resolved_request = request or BreakoutExitRequest.from_kwargs(kwargs)
    params = resolved_request.params
    exit_macd_hist_max = decimal_param(params, "exit_macd_hist_max", Decimal("-0.003"))
    exit_rsi_max = decimal_param(params, "exit_rsi_max", Decimal("56"))
    exit_price_below_opening_range_high_bps = relax_floor_for_isolated_strength(
        floor=decimal_param(
            params, "exit_price_below_opening_range_high_bps", Decimal("-6")
        ),
        isolated_strength_confirmed=resolved_request.isolated_strength_confirmed,
        relaxation=optional_decimal_param(
            params, "isolated_flow_price_vs_orh_relaxation_bps", Decimal("12")
        ),
    )
    momentum_rollover_failure_confirmed = (
        resolved_request.macd_hist <= exit_macd_hist_max
        and resolved_request.rsi14 <= exit_rsi_max
        and (resolved_request.price < resolved_request.ema12)
        and (
            resolved_request.price_vs_opening_range_high_bps is not None
            and resolved_request.price_vs_opening_range_high_bps
            <= decimal_param(
                params,
                "exit_momentum_rollover_price_vs_opening_range_high_bps",
                Decimal("0"),
            )
            or (
                resolved_request.price_vs_vwap_w5m_bps is not None
                and resolved_request.price_vs_vwap_w5m_bps
                <= decimal_param(
                    params, "exit_momentum_rollover_vwap_bps", Decimal("0")
                )
                and (resolved_request.price_position_in_session_range is not None)
                and (
                    resolved_request.price_position_in_session_range
                    <= decimal_param(
                        params,
                        "exit_momentum_rollover_session_range_position_max",
                        Decimal("0.80"),
                    )
                )
            )
        )
    )
    vwap_breakout_failure_confirmed = (
        resolved_request.price_vs_vwap_w5m_bps is not None
        and resolved_request.price_vs_vwap_w5m_bps
        <= decimal_param(params, "exit_price_vs_vwap_w5m_bps", Decimal("-10"))
        and (
            resolved_request.price_vs_opening_range_high_bps is not None
            and resolved_request.price_vs_opening_range_high_bps
            <= decimal_param(
                params,
                "exit_breakout_failure_price_vs_opening_range_high_bps",
                Decimal("0"),
            )
            or (
                resolved_request.price_position_in_session_range is not None
                and resolved_request.price_position_in_session_range
                <= decimal_param(
                    params,
                    "exit_breakout_failure_session_range_position_min",
                    decimal_param(
                        params, "exit_session_range_position_min", Decimal("0.48")
                    ),
                )
            )
        )
    )
    breakout_failure_confirmed = (
        vwap_breakout_failure_confirmed
        or (
            resolved_request.price_position_in_session_range is not None
            and resolved_request.price_position_in_session_range
            <= decimal_param(params, "exit_session_range_position_min", Decimal("0.48"))
        )
        or (
            resolved_request.price_vs_session_open_bps is not None
            and resolved_request.price_vs_session_open_bps
            <= decimal_param(params, "exit_session_open_drive_bps", Decimal("18"))
        )
        or momentum_rollover_failure_confirmed
    )
    session_strength_reversal_confirmed = (
        resolved_request.recent_imbalance_pressure_avg is not None
        and resolved_request.recent_imbalance_pressure_avg
        <= decimal_param(params, "exit_recent_imbalance_pressure_max", Decimal("-0.03"))
        and (
            resolved_request.price_vs_opening_range_high_bps is not None
            and resolved_request.price_vs_opening_range_high_bps
            <= decimal_param(
                params,
                "exit_session_strength_reversal_price_vs_opening_range_high_bps",
                Decimal("0"),
            )
            or (
                resolved_request.price_vs_vwap_w5m_bps is not None
                and resolved_request.price_vs_vwap_w5m_bps
                <= decimal_param(
                    params, "exit_session_strength_reversal_vwap_bps", Decimal("0")
                )
                and (resolved_request.price_position_in_session_range is not None)
                and (
                    resolved_request.price_position_in_session_range
                    <= decimal_param(
                        params,
                        "exit_session_strength_reversal_session_range_position_max",
                        Decimal("0.80"),
                    )
                )
            )
        )
    )
    price_below_opening_range_high = (
        resolved_request.price_vs_opening_range_high_bps is not None
        and optional_max_threshold(
            resolved_request.price_vs_opening_range_high_bps,
            exit_price_below_opening_range_high_bps,
        )
    )
    exit_gate = exit_trigger_gate(
        reason_flags={
            "breakout_failure_confirmed": breakout_failure_confirmed,
            "price_below_opening_range_high": price_below_opening_range_high,
            "session_strength_reversal_confirmed": session_strength_reversal_confirmed,
        }
    )
    if breakout_failure_confirmed:
        return build_sleeve_result(
            strategy_id=resolved_request.strategy_id,
            strategy_type=resolved_request.strategy_type,
            symbol=resolved_request.symbol,
            event_ts=resolved_request.event_ts,
            timeframe=resolved_request.timeframe,
            signal=SleeveSignalEvaluation(
                action="sell",
                confidence=Decimal("0.62"),
                rationale=("breakout_continuation_exit", "breakout_failed"),
            ),
            gates=(exit_gate,),
            trace_enabled=resolved_request.trace_enabled,
            context=resolved_request.trace_context,
        )
    if price_below_opening_range_high or session_strength_reversal_confirmed:
        return build_sleeve_result(
            strategy_id=resolved_request.strategy_id,
            strategy_type=resolved_request.strategy_type,
            symbol=resolved_request.symbol,
            event_ts=resolved_request.event_ts,
            timeframe=resolved_request.timeframe,
            signal=SleeveSignalEvaluation(
                action="sell",
                confidence=Decimal("0.63"),
                rationale=("breakout_continuation_exit", "session_strength_reversal"),
            ),
            gates=(exit_gate,),
            trace_enabled=resolved_request.trace_enabled,
            context=resolved_request.trace_context,
        )
    return None


__all__ = [
    "BreakoutExitRequest",
    "breakout_exit_result",
]
