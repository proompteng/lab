from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Mapping, cast


def parse_event_ts(raw: str) -> datetime:
    normalized = raw.replace("Z", "+00:00")
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def minute_param(params: Mapping[str, Any], key: str, default: int) -> int:
    raw = params.get(key)
    if raw is None:
        return default
    try:
        return int(str(raw))
    except (TypeError, ValueError):
        return default


def optional_minute_param(params: Mapping[str, Any], key: str) -> int | None:
    raw = params.get(key)
    if raw is None:
        return None
    try:
        return int(str(raw))
    except (TypeError, ValueError):
        return None


def decimal_param(params: Mapping[str, Any], key: str, default: Decimal) -> Decimal:
    raw = params.get(key)
    if raw is None:
        return default
    try:
        return Decimal(str(raw))
    except Exception:
        return default


def optional_decimal_param(
    params: Mapping[str, Any], key: str, default: Decimal | None
) -> Decimal | None:
    raw = params.get(key)
    if raw is None:
        return default
    try:
        return Decimal(str(raw))
    except Exception:
        return default


def within_utc_window(ts: datetime, *, start_minute: int, end_minute: int) -> bool:
    minute = ts.hour * 60 + ts.minute
    return start_minute <= minute <= end_minute


def effective_entry_end_minute(
    params: Mapping[str, Any], *, default_end_minute: int
) -> int:
    entry_end_minute = minute_param(params, "entry_end_minute_utc", default_end_minute)
    flatten_start_minute = optional_minute_param(
        params, "session_flatten_start_minute_utc"
    )
    min_entry_minutes_before_flatten = minute_param(
        params, "min_entry_minutes_before_flatten", 15
    )
    if flatten_start_minute is None or min_entry_minutes_before_flatten <= 0:
        return entry_end_minute
    return min(
        entry_end_minute, flatten_start_minute - min_entry_minutes_before_flatten
    )


def bps_delta(price: Decimal | None, reference: Decimal | None) -> Decimal | None:
    if price is None or reference is None or reference == 0:
        return None
    return (price - reference) / reference * Decimal("10000")


def ratio_decimal_over_bps(
    value_bps: Decimal | None, reference_bps: Decimal | None
) -> Decimal | None:
    if value_bps is None or reference_bps is None or reference_bps <= 0:
        return None
    return value_bps / reference_bps


def prefer_primary_decimal(
    primary: Decimal | None, fallback: Decimal | None
) -> Decimal | None:
    return primary if primary is not None else fallback


def select_reference_decimal(
    *,
    params: Mapping[str, Any],
    key: str,
    default_basis: str,
    session_open_value: Decimal | None,
    prev_close_value: Decimal | None,
) -> Decimal | None:
    basis = str(params.get(key, default_basis)).strip().lower()
    if basis in {"session_open", "session"}:
        return prefer_primary_decimal(session_open_value, prev_close_value)
    return prefer_primary_decimal(prev_close_value, session_open_value)


def weighted_average_decimal(
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


def session_minutes_elapsed(event_ts: str) -> int:
    ts = parse_event_ts(event_ts)
    open_minute = 13 * 60 + 30
    current_minute = ts.hour * 60 + ts.minute
    return max(0, current_minute - open_minute)


@dataclass(frozen=True)
class ContinuationRankInputs:
    event_ts: str
    cross_section_session_open_rank: Decimal | None
    cross_section_prev_session_close_rank: Decimal | None
    cross_section_opening_window_return_rank: Decimal | None
    cross_section_opening_window_return_from_prev_close_rank: Decimal | None
    cross_section_range_position_rank: Decimal | None
    cross_section_vwap_w5m_rank: Decimal | None
    cross_section_recent_imbalance_rank: Decimal | None
    fallback_rank: Decimal | None

    @classmethod
    def from_kwargs(cls, values: Mapping[str, Any]) -> ContinuationRankInputs:
        return cls(
            event_ts=cast(str, values["event_ts"]),
            cross_section_session_open_rank=cast(
                Decimal | None,
                values.get("cross_section_session_open_rank"),
            ),
            cross_section_prev_session_close_rank=cast(
                Decimal | None,
                values.get("cross_section_prev_session_close_rank"),
            ),
            cross_section_opening_window_return_rank=cast(
                Decimal | None,
                values.get("cross_section_opening_window_return_rank"),
            ),
            cross_section_opening_window_return_from_prev_close_rank=cast(
                Decimal | None,
                values.get("cross_section_opening_window_return_from_prev_close_rank"),
            ),
            cross_section_range_position_rank=cast(
                Decimal | None,
                values.get("cross_section_range_position_rank"),
            ),
            cross_section_vwap_w5m_rank=cast(
                Decimal | None,
                values.get("cross_section_vwap_w5m_rank"),
            ),
            cross_section_recent_imbalance_rank=cast(
                Decimal | None,
                values.get("cross_section_recent_imbalance_rank"),
            ),
            fallback_rank=cast(Decimal | None, values.get("fallback_rank")),
        )


def resolve_live_continuation_rank(
    inputs: ContinuationRankInputs | None = None,
    **kwargs: Any,
) -> Decimal | None:
    resolved_inputs = inputs or ContinuationRankInputs.from_kwargs(kwargs)
    effective_session_drive_rank = prefer_primary_decimal(
        resolved_inputs.cross_section_prev_session_close_rank,
        resolved_inputs.cross_section_session_open_rank,
    )
    effective_opening_window_rank = prefer_primary_decimal(
        resolved_inputs.cross_section_opening_window_return_from_prev_close_rank,
        resolved_inputs.cross_section_opening_window_return_rank,
    )
    if (
        effective_session_drive_rank is None
        and effective_opening_window_rank is None
        and (resolved_inputs.cross_section_range_position_rank is None)
        and (resolved_inputs.cross_section_vwap_w5m_rank is None)
        and (resolved_inputs.cross_section_recent_imbalance_rank is None)
    ):
        return resolved_inputs.fallback_rank
    if (
        resolved_inputs.cross_section_range_position_rank is None
        and resolved_inputs.cross_section_vwap_w5m_rank is None
        and (resolved_inputs.cross_section_recent_imbalance_rank is None)
        and (resolved_inputs.fallback_rank is not None)
    ):
        return resolved_inputs.fallback_rank
    minutes_elapsed = session_minutes_elapsed(resolved_inputs.event_ts)
    structural_progress = Decimal(max(0, min(minutes_elapsed - 30, 60))) / Decimal("60")
    weights = {
        "session_drive": Decimal("0.18"),
        "opening_window": Decimal("0.16") - Decimal("0.10") * structural_progress,
        "range_position": Decimal("0.26") + Decimal("0.10") * structural_progress,
        "vwap": Decimal("0.20"),
        "imbalance": Decimal("0.20"),
    }
    resolved = weighted_average_decimal(
        [
            (effective_session_drive_rank, weights["session_drive"]),
            (effective_opening_window_rank, weights["opening_window"]),
            (
                resolved_inputs.cross_section_range_position_rank,
                weights["range_position"],
            ),
            (resolved_inputs.cross_section_vwap_w5m_rank, weights["vwap"]),
            (
                resolved_inputs.cross_section_recent_imbalance_rank,
                weights["imbalance"],
            ),
        ]
    )
    if resolved is None:
        return resolved_inputs.fallback_rank
    if resolved_inputs.fallback_rank is None:
        return resolved
    return max(resolved, resolved_inputs.fallback_rank)


def decayed_minimum(
    *,
    event_ts: str,
    early_floor: Decimal | None,
    late_floor: Decimal | None,
    decay_start_minutes: int = 60,
    decay_duration_minutes: int = 120,
) -> Decimal | None:
    if early_floor is None:
        return None
    if decay_duration_minutes <= 0:
        return late_floor if late_floor is not None else early_floor
    resolved_late_floor = late_floor
    if resolved_late_floor is None:
        resolved_late_floor = early_floor * Decimal("0.5")
    if resolved_late_floor > early_floor:
        resolved_late_floor = early_floor
    minutes_elapsed = session_minutes_elapsed(event_ts)
    if minutes_elapsed <= decay_start_minutes:
        return early_floor
    progress = Decimal(
        min(max(minutes_elapsed - decay_start_minutes, 0), decay_duration_minutes)
    ) / Decimal(decay_duration_minutes)
    return early_floor - (early_floor - resolved_late_floor) * progress


@dataclass(frozen=True)
class EarlyBreakoutQualityInputs:
    event_ts: str
    cutoff_minutes: int
    continuation_rank: Decimal | None
    elite_continuation_rank: Decimal | None
    continuation_breadth: Decimal | None
    min_continuation_breadth: Decimal | None
    microprice_bias_bps: Decimal | None
    min_microprice_bias_bps: Decimal | None

    @classmethod
    def from_kwargs(cls, values: Mapping[str, Any]) -> EarlyBreakoutQualityInputs:
        return cls(
            event_ts=cast(str, values["event_ts"]),
            cutoff_minutes=cast(int, values["cutoff_minutes"]),
            continuation_rank=cast(Decimal | None, values.get("continuation_rank")),
            elite_continuation_rank=cast(
                Decimal | None,
                values.get("elite_continuation_rank"),
            ),
            continuation_breadth=cast(
                Decimal | None,
                values.get("continuation_breadth"),
            ),
            min_continuation_breadth=cast(
                Decimal | None,
                values.get("min_continuation_breadth"),
            ),
            microprice_bias_bps=cast(
                Decimal | None,
                values.get("microprice_bias_bps"),
            ),
            min_microprice_bias_bps=cast(
                Decimal | None,
                values.get("min_microprice_bias_bps"),
            ),
        )


def early_breakout_quality_passes(
    inputs: EarlyBreakoutQualityInputs | None = None,
    **kwargs: Any,
) -> bool:
    resolved_inputs = inputs or EarlyBreakoutQualityInputs.from_kwargs(kwargs)
    minutes_elapsed = session_minutes_elapsed(resolved_inputs.event_ts)
    if minutes_elapsed > resolved_inputs.cutoff_minutes:
        return True
    if optional_min_threshold(
        resolved_inputs.continuation_rank,
        resolved_inputs.elite_continuation_rank,
    ):
        return True
    return optional_min_threshold(
        resolved_inputs.continuation_breadth,
        resolved_inputs.min_continuation_breadth,
    ) and optional_min_threshold(
        resolved_inputs.microprice_bias_bps,
        resolved_inputs.min_microprice_bias_bps,
    )


def isolated_breakout_strength_confirmed(
    *,
    params: Mapping[str, Any],
    range_position_rank: Decimal | None,
    vwap_w5m_rank: Decimal | None,
    recent_imbalance_rank: Decimal | None,
) -> bool:
    return (
        required_min_threshold(
            range_position_rank,
            optional_decimal_param(
                params, "isolated_flow_min_range_position_rank", Decimal("0.85")
            ),
        )
        and required_min_threshold(
            vwap_w5m_rank,
            optional_decimal_param(
                params, "isolated_flow_min_vwap_w5m_rank", Decimal("0.75")
            ),
        )
        and required_min_threshold(
            recent_imbalance_rank,
            optional_decimal_param(
                params, "isolated_flow_min_recent_imbalance_rank", Decimal("0.75")
            ),
        )
    )


@dataclass(frozen=True)
class SameDayLeadershipInputs:
    params: Mapping[str, Any]
    session_open_rank: Decimal | None
    opening_window_return_rank: Decimal | None
    continuation_rank: Decimal | None
    microprice_bias_bps: Decimal | None
    price_vs_opening_window_close_bps: Decimal | None
    recent_above_opening_window_close_ratio: Decimal | None

    @classmethod
    def from_kwargs(cls, values: Mapping[str, Any]) -> SameDayLeadershipInputs:
        return cls(
            params=cast(Mapping[str, Any], values["params"]),
            session_open_rank=cast(Decimal | None, values.get("session_open_rank")),
            opening_window_return_rank=cast(
                Decimal | None,
                values.get("opening_window_return_rank"),
            ),
            continuation_rank=cast(Decimal | None, values.get("continuation_rank")),
            microprice_bias_bps=cast(
                Decimal | None,
                values.get("microprice_bias_bps"),
            ),
            price_vs_opening_window_close_bps=cast(
                Decimal | None,
                values.get("price_vs_opening_window_close_bps"),
            ),
            recent_above_opening_window_close_ratio=cast(
                Decimal | None,
                values.get("recent_above_opening_window_close_ratio"),
            ),
        )


def confirm_same_day_leadership(
    inputs: SameDayLeadershipInputs | None = None,
    **kwargs: Any,
) -> bool:
    resolved_inputs = inputs or SameDayLeadershipInputs.from_kwargs(kwargs)
    return (
        required_min_threshold(
            resolved_inputs.session_open_rank,
            optional_decimal_param(
                resolved_inputs.params,
                "isolated_same_day_min_session_open_rank",
                Decimal("0.90"),
            ),
        )
        and required_min_threshold(
            resolved_inputs.opening_window_return_rank,
            optional_decimal_param(
                resolved_inputs.params,
                "isolated_same_day_min_opening_window_return_rank",
                Decimal("0.85"),
            ),
        )
        and required_min_threshold(
            resolved_inputs.continuation_rank,
            optional_decimal_param(
                resolved_inputs.params,
                "isolated_same_day_min_continuation_rank",
                Decimal("0.88"),
            ),
        )
        and required_min_threshold(
            resolved_inputs.microprice_bias_bps,
            optional_decimal_param(
                resolved_inputs.params,
                "isolated_same_day_min_microprice_bias_bps",
                Decimal("0.25"),
            ),
        )
        and required_min_threshold(
            resolved_inputs.price_vs_opening_window_close_bps,
            optional_decimal_param(
                resolved_inputs.params,
                "isolated_same_day_min_price_vs_opening_window_close_bps",
                Decimal("0"),
            ),
        )
        and required_min_threshold(
            resolved_inputs.recent_above_opening_window_close_ratio,
            optional_decimal_param(
                resolved_inputs.params,
                "isolated_same_day_min_recent_above_opening_window_close_ratio",
                Decimal("0.55"),
            ),
        )
    )


@dataclass(frozen=True)
class LeaderReclaimInputs:
    params: Mapping[str, Any]
    event_ts: str
    same_day_leadership_confirmed: bool
    recent_imbalance_pressure_avg: Decimal | None
    recent_microprice_bias_bps_avg: Decimal | None
    recent_above_opening_window_close_ratio: Decimal | None
    recent_above_vwap_w5m_ratio: Decimal | None
    price_position_in_session_range: Decimal | None
    price_vs_vwap_w5m_bps: Decimal | None

    @classmethod
    def from_kwargs(cls, values: Mapping[str, Any]) -> LeaderReclaimInputs:
        return cls(
            params=cast(Mapping[str, Any], values["params"]),
            event_ts=cast(str, values["event_ts"]),
            same_day_leadership_confirmed=cast(
                bool,
                values["same_day_leadership_confirmed"],
            ),
            recent_imbalance_pressure_avg=cast(
                Decimal | None,
                values.get("recent_imbalance_pressure_avg"),
            ),
            recent_microprice_bias_bps_avg=cast(
                Decimal | None,
                values.get("recent_microprice_bias_bps_avg"),
            ),
            recent_above_opening_window_close_ratio=cast(
                Decimal | None,
                values.get("recent_above_opening_window_close_ratio"),
            ),
            recent_above_vwap_w5m_ratio=cast(
                Decimal | None,
                values.get("recent_above_vwap_w5m_ratio"),
            ),
            price_position_in_session_range=cast(
                Decimal | None,
                values.get("price_position_in_session_range"),
            ),
            price_vs_vwap_w5m_bps=cast(
                Decimal | None,
                values.get("price_vs_vwap_w5m_bps"),
            ),
        )


def confirm_leader_reclaim(
    inputs: LeaderReclaimInputs | None = None,
    **kwargs: Any,
) -> bool:
    resolved_inputs = inputs or LeaderReclaimInputs.from_kwargs(kwargs)
    if not resolved_inputs.same_day_leadership_confirmed:
        return False
    if session_minutes_elapsed(resolved_inputs.event_ts) <= minute_param(
        resolved_inputs.params,
        "leader_reclaim_start_minutes_since_open",
        90,
    ):
        return False
    return (
        required_min_threshold(
            resolved_inputs.recent_imbalance_pressure_avg,
            optional_decimal_param(
                resolved_inputs.params,
                "leader_reclaim_min_recent_imbalance_pressure",
                Decimal("0.20"),
            ),
        )
        and required_min_threshold(
            resolved_inputs.recent_microprice_bias_bps_avg,
            optional_decimal_param(
                resolved_inputs.params,
                "leader_reclaim_min_recent_microprice_bias_bps",
                Decimal("1.0"),
            ),
        )
        and required_min_threshold(
            resolved_inputs.recent_above_opening_window_close_ratio,
            optional_decimal_param(
                resolved_inputs.params,
                "leader_reclaim_min_recent_above_opening_window_close_ratio",
                Decimal("0.85"),
            ),
        )
        and required_min_threshold(
            resolved_inputs.recent_above_vwap_w5m_ratio,
            optional_decimal_param(
                resolved_inputs.params,
                "leader_reclaim_min_recent_above_vwap_w5m_ratio",
                Decimal("0.80"),
            ),
        )
        and required_min_threshold(
            resolved_inputs.price_position_in_session_range,
            optional_decimal_param(
                resolved_inputs.params,
                "leader_reclaim_min_session_range_position",
                Decimal("0.80"),
            ),
        )
        and required_min_threshold(
            resolved_inputs.price_vs_vwap_w5m_bps,
            optional_decimal_param(
                resolved_inputs.params,
                "leader_reclaim_min_price_vs_vwap_w5m_bps",
                Decimal("-4"),
            ),
        )
        and optional_max_threshold(
            resolved_inputs.price_vs_vwap_w5m_bps,
            optional_decimal_param(
                resolved_inputs.params,
                "leader_reclaim_max_price_vs_vwap_w5m_bps",
                Decimal("28"),
            ),
        )
    )


def relax_floor_for_isolated_strength(
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
    relaxed_floor = floor - effective_relaxation
    if floor >= 0:
        return max(Decimal("0"), relaxed_floor)
    return relaxed_floor


def widen_cap_for_isolated_strength(
    *, cap: Decimal | None, isolated_strength_confirmed: bool, extension: Decimal | None
) -> Decimal | None:
    if cap is None or not isolated_strength_confirmed:
        return cap
    effective_extension = extension or Decimal("0")
    if effective_extension <= 0:
        return cap
    return cap + effective_extension


@dataclass(frozen=True)
class ContinuationShapeInputs:
    params: Mapping[str, Any]
    isolated_strength_confirmed: bool
    price_position_in_session_range: Decimal | None
    price_vs_opening_range_high_bps: Decimal | None
    opening_range_width_bps: Decimal | None
    session_range_bps: Decimal | None
    min_session_range_position_key: str = "isolated_flow_min_session_range_position"
    default_min_session_range_position: Decimal = Decimal("0.88")
    min_price_vs_opening_range_high_key: str = (
        "isolated_flow_min_price_vs_opening_range_high_bps"
    )
    default_min_price_vs_opening_range_high_bps: Decimal = Decimal("-24")
    min_opening_range_width_bps_key: str = "isolated_flow_min_opening_range_width_bps"
    default_min_opening_range_width_bps: Decimal = Decimal("8")
    min_session_range_bps_key: str = "isolated_flow_min_session_range_bps"
    default_min_session_range_bps: Decimal = Decimal("18")

    @classmethod
    def from_kwargs(cls, values: Mapping[str, Any]) -> ContinuationShapeInputs:
        return cls(
            params=cast(Mapping[str, Any], values["params"]),
            isolated_strength_confirmed=cast(
                bool,
                values["isolated_strength_confirmed"],
            ),
            price_position_in_session_range=cast(
                Decimal | None,
                values.get("price_position_in_session_range"),
            ),
            price_vs_opening_range_high_bps=cast(
                Decimal | None,
                values.get("price_vs_opening_range_high_bps"),
            ),
            opening_range_width_bps=cast(
                Decimal | None,
                values.get("opening_range_width_bps"),
            ),
            session_range_bps=cast(Decimal | None, values.get("session_range_bps")),
            min_session_range_position_key=cast(
                str,
                values.get(
                    "min_session_range_position_key",
                    "isolated_flow_min_session_range_position",
                ),
            ),
            default_min_session_range_position=cast(
                Decimal,
                values.get(
                    "default_min_session_range_position",
                    Decimal("0.88"),
                ),
            ),
            min_price_vs_opening_range_high_key=cast(
                str,
                values.get(
                    "min_price_vs_opening_range_high_key",
                    "isolated_flow_min_price_vs_opening_range_high_bps",
                ),
            ),
            default_min_price_vs_opening_range_high_bps=cast(
                Decimal,
                values.get(
                    "default_min_price_vs_opening_range_high_bps",
                    Decimal("-24"),
                ),
            ),
            min_opening_range_width_bps_key=cast(
                str,
                values.get(
                    "min_opening_range_width_bps_key",
                    "isolated_flow_min_opening_range_width_bps",
                ),
            ),
            default_min_opening_range_width_bps=cast(
                Decimal,
                values.get("default_min_opening_range_width_bps", Decimal("8")),
            ),
            min_session_range_bps_key=cast(
                str,
                values.get(
                    "min_session_range_bps_key",
                    "isolated_flow_min_session_range_bps",
                ),
            ),
            default_min_session_range_bps=cast(
                Decimal,
                values.get("default_min_session_range_bps", Decimal("18")),
            ),
        )


def isolated_leader_continuation_shape_passes(
    inputs: ContinuationShapeInputs | None = None,
    **kwargs: Any,
) -> bool:
    resolved_inputs = inputs or ContinuationShapeInputs.from_kwargs(kwargs)
    if not resolved_inputs.isolated_strength_confirmed:
        return False
    return (
        optional_min_threshold(
            resolved_inputs.price_position_in_session_range,
            optional_decimal_param(
                resolved_inputs.params,
                resolved_inputs.min_session_range_position_key,
                resolved_inputs.default_min_session_range_position,
            ),
        )
        and optional_min_threshold(
            resolved_inputs.price_vs_opening_range_high_bps,
            optional_decimal_param(
                resolved_inputs.params,
                resolved_inputs.min_price_vs_opening_range_high_key,
                resolved_inputs.default_min_price_vs_opening_range_high_bps,
            ),
        )
        and optional_min_threshold(
            resolved_inputs.opening_range_width_bps,
            optional_decimal_param(
                resolved_inputs.params,
                resolved_inputs.min_opening_range_width_bps_key,
                resolved_inputs.default_min_opening_range_width_bps,
            ),
        )
        and optional_min_threshold(
            resolved_inputs.session_range_bps,
            optional_decimal_param(
                resolved_inputs.params,
                resolved_inputs.min_session_range_bps_key,
                resolved_inputs.default_min_session_range_bps,
            ),
        )
    )


def nonnegative_decimal(value: Decimal | None) -> Decimal:
    if value is None:
        return Decimal("0")
    return max(value, Decimal("0"))


def scaled_extension_cap(
    *,
    base_cap: Decimal | None,
    reference_bps: Decimal | None,
    multiplier: Decimal | None,
) -> Decimal:
    cap = base_cap if base_cap is not None else Decimal("0")
    if (
        reference_bps is None
        or reference_bps <= 0
        or multiplier is None
        or (multiplier <= 0)
    ):
        return cap
    return max(cap, reference_bps * multiplier)


def calculate_imbalance_pressure(
    bid_sz: Decimal | None, ask_sz: Decimal | None
) -> Decimal:
    if bid_sz is None or ask_sz is None:
        return Decimal("0")
    total = bid_sz + ask_sz
    if total <= 0:
        return Decimal("0")
    return (bid_sz - ask_sz) / total


def optional_min_threshold(value: Decimal | None, floor: Decimal | None) -> bool:
    if floor is None or value is None:
        return True
    return value >= floor


def required_min_threshold(value: Decimal | None, floor: Decimal | None) -> bool:
    if floor is None:
        return True
    if value is None:
        return False
    return value >= floor


def recent_reference_hold_passes(
    *,
    recent_above_opening_range_high_ratio: Decimal | None,
    min_recent_above_opening_range_high_ratio: Decimal | None,
    recent_above_opening_window_close_ratio: Decimal | None,
    min_recent_above_opening_window_close_ratio: Decimal | None,
) -> bool:
    checks: list[bool] = []
    if min_recent_above_opening_range_high_ratio is not None:
        checks.append(
            required_min_threshold(
                recent_above_opening_range_high_ratio,
                min_recent_above_opening_range_high_ratio,
            )
        )
    if min_recent_above_opening_window_close_ratio is not None:
        checks.append(
            required_min_threshold(
                recent_above_opening_window_close_ratio,
                min_recent_above_opening_window_close_ratio,
            )
        )
    if not checks:
        return True
    return any(checks)


def optional_max_threshold(value: Decimal | None, ceil: Decimal | None) -> bool:
    if ceil is None or value is None:
        return True
    return value <= ceil


def resolve_entry_notional_multiplier(
    *,
    params: Mapping[str, Any],
    confidence: Decimal,
    rank: Decimal | None,
    spread_bps: Decimal | None,
    spread_cap_bps: Decimal | None,
) -> Decimal:
    min_multiplier = decimal_param(
        params, "entry_notional_min_multiplier", Decimal("0.20")
    )
    max_multiplier = decimal_param(
        params, "entry_notional_max_multiplier", Decimal("1")
    )
    if max_multiplier <= 0:
        return Decimal("0")
    if min_multiplier < 0:
        min_multiplier = Decimal("0")
    if min_multiplier > max_multiplier:
        min_multiplier = max_multiplier
    score_terms = [
        normalize_score(
            confidence,
            floor=decimal_param(
                params, "entry_notional_confidence_floor", Decimal("0.62")
            ),
            ceil=decimal_param(
                params, "entry_notional_confidence_ceiling", Decimal("0.85")
            ),
        )
    ]
    rank_floor = optional_decimal_param(params, "entry_notional_rank_floor", None)
    rank_ceil = optional_decimal_param(
        params, "entry_notional_rank_ceiling", Decimal("0.95")
    )
    if rank is not None and rank_floor is not None:
        score_terms.append(
            normalize_score(
                rank,
                floor=rank_floor,
                ceil=rank_ceil if rank_ceil is not None else Decimal("0.95"),
            )
        )
    spread_ceil = optional_decimal_param(
        params, "entry_notional_spread_ceiling_bps", spread_cap_bps
    )
    if spread_bps is not None and spread_ceil is not None and (spread_ceil > 0):
        score_terms.append(
            Decimal("1")
            - normalize_score(spread_bps, floor=Decimal("0"), ceil=spread_ceil)
        )
    score = sum(score_terms, Decimal("0")) / Decimal(len(score_terms))
    multiplier = min_multiplier + (max_multiplier - min_multiplier) * score
    if multiplier < min_multiplier:
        multiplier = min_multiplier
    if multiplier > max_multiplier:
        multiplier = max_multiplier
    return multiplier.quantize(Decimal("0.0001"))


def normalize_score(value: Decimal, *, floor: Decimal, ceil: Decimal) -> Decimal:
    if ceil <= floor:
        return Decimal("1") if value >= ceil else Decimal("0")
    if value <= floor:
        return Decimal("0")
    if value >= ceil:
        return Decimal("1")
    return (value - floor) / (ceil - floor)


__all__ = [
    "parse_event_ts",
    "minute_param",
    "optional_minute_param",
    "decimal_param",
    "optional_decimal_param",
    "within_utc_window",
    "effective_entry_end_minute",
    "bps_delta",
    "ratio_decimal_over_bps",
    "prefer_primary_decimal",
    "select_reference_decimal",
    "weighted_average_decimal",
    "session_minutes_elapsed",
    "ContinuationRankInputs",
    "resolve_live_continuation_rank",
    "decayed_minimum",
    "EarlyBreakoutQualityInputs",
    "early_breakout_quality_passes",
    "isolated_breakout_strength_confirmed",
    "SameDayLeadershipInputs",
    "confirm_same_day_leadership",
    "LeaderReclaimInputs",
    "confirm_leader_reclaim",
    "relax_floor_for_isolated_strength",
    "widen_cap_for_isolated_strength",
    "ContinuationShapeInputs",
    "isolated_leader_continuation_shape_passes",
    "nonnegative_decimal",
    "scaled_extension_cap",
    "calculate_imbalance_pressure",
    "optional_min_threshold",
    "required_min_threshold",
    "recent_reference_hold_passes",
    "optional_max_threshold",
    "resolve_entry_notional_multiplier",
    "normalize_score",
]
