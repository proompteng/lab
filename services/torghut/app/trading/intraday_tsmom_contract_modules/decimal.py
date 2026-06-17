# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Shared parameter contract for intraday_tsmom_v1 across runtimes."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Mapping


from .intraday_tsmom_threshold_profile import (
    IntradayTsmomEvaluation,
    IntradayTsmomThresholdProfile,
    optional_decimal_param as _optional_decimal_param,
    evaluate_intraday_tsmom_signal,
    resolve_intraday_tsmom_thresholds,
    validate_intraday_tsmom_params,
)


def _decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ArithmeticError, TypeError, ValueError):
        return None


def _minute_param(
    *,
    params: Mapping[str, Any],
    key: str,
) -> int | None:
    raw_value = params.get(key)
    if raw_value is None:
        return None
    try:
        resolved = int(str(raw_value))
    except (TypeError, ValueError):
        return None
    if resolved < 0 or resolved >= 24 * 60:
        return None
    return resolved


def _validate_optional_minute_param(
    *,
    params: Mapping[str, Any],
    key: str,
    invalid_error: str,
    out_of_range_error: str,
) -> None:
    if key not in params:
        return
    raw_value = params.get(key)
    try:
        resolved = int(str(raw_value))
    except (TypeError, ValueError):
        raise ValueError(invalid_error) from None
    if resolved < 0 or resolved >= 24 * 60:
        raise ValueError(out_of_range_error)


def _within_entry_window(
    *,
    event_ts: str | datetime | None,
    params: Mapping[str, Any],
) -> bool:
    if not event_ts:
        return True
    entry_start_minute = _minute_param(
        params=params,
        key="entry_start_minute_utc",
    )
    entry_end_minute = _minute_param(
        params=params,
        key="entry_end_minute_utc",
    )
    if entry_start_minute is None and entry_end_minute is None:
        return True
    if isinstance(event_ts, datetime):
        event_dt = event_ts
    else:
        try:
            event_dt = datetime.fromisoformat(event_ts.replace("Z", "+00:00"))
        except ValueError:
            return False
    if event_dt.tzinfo is None:
        event_dt = event_dt.replace(tzinfo=timezone.utc)
    event_dt = event_dt.astimezone(timezone.utc)
    minute_of_day = event_dt.hour * 60 + event_dt.minute
    if entry_start_minute is not None and minute_of_day < entry_start_minute:
        return False
    if entry_end_minute is not None and minute_of_day > entry_end_minute:
        return False
    return True


def _validate_optional_decimal_param(
    *,
    params: Mapping[str, Any],
    key: str,
    invalid_error: str,
) -> None:
    if key not in params:
        return
    if _decimal(params.get(key)) is None:
        raise ValueError(invalid_error)


def _validate_optional_rsi_param(
    *,
    params: Mapping[str, Any],
    key: str,
    invalid_error: str,
    out_of_range_error: str,
) -> None:
    if key not in params:
        return
    value = _decimal(params.get(key))
    if value is None:
        raise ValueError(invalid_error)
    if value < 0 or value > 100:
        raise ValueError(out_of_range_error)


def _volatility_within_budget(
    volatility: Decimal | None,
    *,
    floor: Decimal | None,
    ceil: Decimal | None,
) -> bool:
    if volatility is None:
        return True
    if floor is not None and volatility < floor:
        return False
    if ceil is not None and volatility > ceil:
        return False
    return True


def _spread_bps(
    *,
    price: Decimal,
    spread: Decimal | None,
) -> Decimal | None:
    if spread is None or spread <= 0 or price <= 0:
        return None
    return (spread / price) * Decimal("10000")


def _rsi_within_bearish_bounds(
    rsi14: Decimal,
    *,
    min_bear_rsi: Decimal | None,
    max_bear_rsi: Decimal | None,
) -> bool:
    if min_bear_rsi is not None and rsi14 < min_bear_rsi:
        return False
    if max_bear_rsi is not None and rsi14 > max_bear_rsi:
        return False
    return True


def _optional_min_threshold(
    value: Decimal | None,
    threshold: Decimal | None,
) -> bool:
    if threshold is None:
        return True
    if value is None:
        return False
    return value >= threshold


def _optional_max_threshold(
    value: Decimal | None,
    threshold: Decimal | None,
) -> bool:
    if threshold is None:
        return True
    if value is None:
        return False
    return value <= threshold


def _weighted_average_decimal(
    weighted_values: list[tuple[Decimal | None, Decimal]],
) -> Decimal | None:
    weighted_sum = Decimal("0")
    total_weight = Decimal("0")
    for value, weight in weighted_values:
        if value is None or weight <= 0:
            continue
        weighted_sum += value * weight
        total_weight += weight
    if total_weight <= 0:
        return None
    return weighted_sum / total_weight


def _session_minutes_elapsed(event_ts: str | datetime | None) -> int:
    if event_ts is None:
        return 0
    if isinstance(event_ts, datetime):
        event_dt = event_ts
    else:
        try:
            event_dt = datetime.fromisoformat(event_ts.replace("Z", "+00:00"))
        except ValueError:
            return 0
    if event_dt.tzinfo is None:
        event_dt = event_dt.replace(tzinfo=timezone.utc)
    event_dt = event_dt.astimezone(timezone.utc)
    open_minute = 13 * 60 + 30
    current_minute = event_dt.hour * 60 + event_dt.minute
    return max(0, current_minute - open_minute)


def _resolve_live_continuation_rank(
    *,
    event_ts: str | datetime | None,
    cross_section_opening_window_return_rank: Decimal | None,
    cross_section_opening_window_return_from_prev_close_rank: Decimal | None,
    cross_section_range_position_rank: Decimal | None,
    cross_section_vwap_w5m_rank: Decimal | None,
    cross_section_recent_imbalance_rank: Decimal | None,
    fallback_rank: Decimal | None,
) -> Decimal | None:
    effective_opening_window_rank = (
        cross_section_opening_window_return_from_prev_close_rank
        if cross_section_opening_window_return_from_prev_close_rank is not None
        else cross_section_opening_window_return_rank
    )
    if (
        effective_opening_window_rank is None
        and cross_section_range_position_rank is None
        and cross_section_vwap_w5m_rank is None
        and cross_section_recent_imbalance_rank is None
    ):
        return fallback_rank
    minutes_elapsed = _session_minutes_elapsed(event_ts)
    structural_progress = Decimal(max(0, min(minutes_elapsed - 30, 90))) / Decimal("90")
    resolved = _weighted_average_decimal(
        [
            (
                effective_opening_window_rank,
                Decimal("0.30") - (Decimal("0.15") * structural_progress),
            ),
            (
                cross_section_range_position_rank,
                Decimal("0.25") + (Decimal("0.08") * structural_progress),
            ),
            (cross_section_vwap_w5m_rank, Decimal("0.25")),
            (
                cross_section_recent_imbalance_rank,
                Decimal("0.20") + (Decimal("0.07") * structural_progress),
            ),
        ]
    )
    return resolved if resolved is not None else fallback_rank


def _decayed_minimum(
    *,
    event_ts: str | datetime | None,
    early_floor: Decimal | None,
    late_session_floor_multiplier: Decimal | None,
    decay_start_minutes: int = 60,
    decay_duration_minutes: int = 120,
) -> Decimal | None:
    if early_floor is None:
        return None
    if late_session_floor_multiplier is None:
        return early_floor
    effective_multiplier = min(
        max(late_session_floor_multiplier, Decimal("0")), Decimal("1")
    )
    late_floor = early_floor * effective_multiplier
    if decay_duration_minutes <= 0:
        return late_floor
    minutes_elapsed = _session_minutes_elapsed(event_ts)
    if minutes_elapsed <= decay_start_minutes:
        return early_floor
    progress = Decimal(
        min(max(minutes_elapsed - decay_start_minutes, 0), decay_duration_minutes)
    ) / Decimal(decay_duration_minutes)
    return early_floor - ((early_floor - late_floor) * progress)


def _isolated_continuation_strength_confirmed(
    *,
    params: Mapping[str, Any],
    live_continuation_rank: Decimal | None,
    range_position_rank: Decimal | None,
    vwap_w5m_rank: Decimal | None,
    recent_imbalance_rank: Decimal | None,
    recent_microprice_bias_bps_avg: Decimal | None,
) -> bool:
    return (
        _optional_min_threshold(
            live_continuation_rank,
            _optional_decimal_param(
                params=params,
                key="isolated_flow_min_live_continuation_rank",
                default=Decimal("0.82"),
            ),
        )
        and _optional_min_threshold(
            range_position_rank,
            _optional_decimal_param(
                params=params,
                key="isolated_flow_min_range_position_rank",
                default=Decimal("0.88"),
            ),
        )
        and _optional_min_threshold(
            vwap_w5m_rank,
            _optional_decimal_param(
                params=params,
                key="isolated_flow_min_vwap_w5m_rank",
                default=Decimal("0.80"),
            ),
        )
        and _optional_min_threshold(
            recent_imbalance_rank,
            _optional_decimal_param(
                params=params,
                key="isolated_flow_min_recent_imbalance_rank",
                default=Decimal("0.75"),
            ),
        )
        and _optional_min_threshold(
            recent_microprice_bias_bps_avg,
            _optional_decimal_param(
                params=params,
                key="isolated_flow_min_recent_microprice_bias_bps",
                default=Decimal("0.20"),
            ),
        )
    )


def _relax_floor_for_isolated_strength(
    *,
    floor: Decimal | None,
    isolated_strength_confirmed: bool,
    relaxation: Decimal | None,
) -> Decimal | None:
    if floor is None or not isolated_strength_confirmed:
        return floor
    effective_relaxation = relaxation or Decimal("0")
    if effective_relaxation <= 0:
        return floor
    return max(Decimal("0"), floor - effective_relaxation)


__all__ = [
    "IntradayTsmomEvaluation",
    "IntradayTsmomThresholdProfile",
    "evaluate_intraday_tsmom_signal",
    "resolve_intraday_tsmom_thresholds",
    "validate_intraday_tsmom_params",
]


# Public aliases used by split-module consumers.
decayed_minimum = _decayed_minimum
decimal = _decimal
isolated_continuation_strength_confirmed = _isolated_continuation_strength_confirmed
optional_max_threshold = _optional_max_threshold
optional_min_threshold = _optional_min_threshold
relax_floor_for_isolated_strength = _relax_floor_for_isolated_strength
resolve_live_continuation_rank = _resolve_live_continuation_rank
rsi_within_bearish_bounds = _rsi_within_bearish_bounds
spread_bps = _spread_bps
validate_optional_decimal_param = _validate_optional_decimal_param
validate_optional_minute_param = _validate_optional_minute_param
validate_optional_rsi_param = _validate_optional_rsi_param
volatility_within_budget = _volatility_within_budget
within_entry_window = _within_entry_window

__all__ = (
    "decayed_minimum",
    "decimal",
    "isolated_continuation_strength_confirmed",
    "optional_max_threshold",
    "optional_min_threshold",
    "relax_floor_for_isolated_strength",
    "resolve_live_continuation_rank",
    "rsi_within_bearish_bounds",
    "spread_bps",
    "validate_optional_decimal_param",
    "validate_optional_minute_param",
    "validate_optional_rsi_param",
    "volatility_within_budget",
    "within_entry_window",
)
