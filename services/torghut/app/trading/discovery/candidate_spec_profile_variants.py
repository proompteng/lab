"""Execution-profile variants for candidate-spec compilation."""

from __future__ import annotations

import json
from decimal import Decimal
from typing import Any, Mapping, Sequence, cast

from app.trading.discovery.capital_budget import estimate_capital_pressure
from app.trading.discovery.hypothesis_cards import HypothesisCard

from .candidate_spec_common import (
    mapping as _mapping,
    stable_hash as _stable_hash,
    stable_int as _stable_int,
    string as _string,
)
from .candidate_spec_profiles import (
    BASE_FAMILY_EXECUTION_PROFILES as _BASE_FAMILY_EXECUTION_PROFILES,
    DEFAULT_PROFILE_COUNT as _DEFAULT_PROFILE_COUNT,
    H_PAIRS_REPLAY_LEDGER_BREADTH_EXECUTION_PROFILES as _H_PAIRS_REPLAY_LEDGER_BREADTH_EXECUTION_PROFILES,
    PORTFOLIO_COVERAGE_UNIVERSE_PROFILE as _PORTFOLIO_COVERAGE_UNIVERSE_PROFILE,
    PORTFOLIO_ORACLE_COVERAGE_EXECUTION_PROFILES as _PORTFOLIO_ORACLE_COVERAGE_EXECUTION_PROFILES,
    PORTFOLIO_TARGET_NET_PNL_PER_DAY as _PORTFOLIO_TARGET_NET_PNL_PER_DAY,
    REJECTED_SIGNAL_FALSE_NEGATIVE_RESCUE_EXECUTION_PROFILES as _REJECTED_SIGNAL_FALSE_NEGATIVE_RESCUE_EXECUTION_PROFILES,
)


def _format_profile_budget(value: Decimal) -> str:
    text = format(value.normalize(), "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


def _profile_rank_count_floor(profile: Mapping[str, Any]) -> int:
    params = _mapping(profile.get("params"))
    for key in (
        "max_entries_per_session",
        "max_concurrent_positions",
        "max_pair_legs",
        "top_n",
        "rank_count",
    ):
        try:
            if Decimal(str(params.get(key) or "0")) > 0:
                return 1
        except Exception:
            continue
    universe = profile.get("universe_symbols")
    if not isinstance(universe, Sequence) or isinstance(universe, (str, bytes)):
        return 1
    cleaned_count = 0
    for item in cast(Sequence[Any], universe):
        if _string(item):
            cleaned_count += 1
    return max(1, cleaned_count)


def _capital_limited_profile_values(profile: Mapping[str, Any]) -> tuple[str, str]:
    params = _mapping(profile.get("params"))
    pressure = max(
        Decimal("1"),
        Decimal(
            str(
                estimate_capital_pressure(
                    params,
                    rank_count_floor=_profile_rank_count_floor(profile),
                )
            )
        ),
    )
    max_notional = (Decimal("30000") / pressure).quantize(Decimal("0.01"))
    max_position = (Decimal("1") / pressure).quantize(Decimal("0.000001"))
    return _format_profile_budget(max_notional), _format_profile_budget(max_position)


def _decimal_profile_param(
    params: Mapping[str, Any],
    key: str,
    *,
    default: Decimal,
) -> Decimal:
    try:
        return Decimal(str(params.get(key) or default))
    except Exception:
        return default


def _int_profile_param(params: Mapping[str, Any], key: str, *, default: int) -> int:
    try:
        return int(Decimal(str(params.get(key) or default)))
    except Exception:
        return default


def _clamped_profile_decimal(
    *,
    params: Mapping[str, Any],
    key: str,
    default: Decimal,
    delta: Decimal,
    lower: Decimal,
    upper: Decimal,
    places: Decimal = Decimal("0.01"),
) -> str:
    value = _decimal_profile_param(params, key, default=default) + delta
    return _format_profile_budget(min(upper, max(lower, value)).quantize(places))


def _cash_constrain_profile(
    profile: dict[str, Any],
    *,
    capital_profile: str,
    label: str,
) -> dict[str, Any]:
    params = _mapping(profile.get("params"))
    max_notional, max_position = _capital_limited_profile_values(profile)
    profile["max_notional_per_trade"] = max_notional
    profile["max_position_pct_equity"] = max_position
    params["capital_profile"] = capital_profile
    params["feedback_remediation_profile"] = label
    params["max_gross_exposure_pct_equity"] = "1.0"
    profile["params"] = params
    return profile


def _drop_fragile_prev_close_positive_gate(params: dict[str, Any]) -> None:
    if (
        str(params.get("gate_feature") or "")
        == "cross_section_positive_opening_window_return_from_prev_close_ratio"
    ):
        params.pop("gate_feature", None)
        params.pop("gate_min", None)
        params.pop("gate_max", None)


def _daily_coverage_feedback_escape_profile(
    profile: Mapping[str, Any],
) -> dict[str, Any]:
    next_profile = json.loads(json.dumps(profile))
    params = _mapping(next_profile.get("params"))
    _drop_fragile_prev_close_positive_gate(params)
    params["max_entries_per_session"] = str(
        max(2, min(4, _int_profile_param(params, "max_entries_per_session", default=2)))
    )
    params["max_concurrent_positions"] = str(
        max(1, min(3, _profile_rank_count_floor(next_profile)))
    )
    params["entry_cooldown_seconds"] = str(
        max(300, _int_profile_param(params, "entry_cooldown_seconds", default=600))
    )
    params["long_stop_loss_bps"] = str(
        min(8, max(4, _int_profile_param(params, "long_stop_loss_bps", default=6)))
    )
    params["short_stop_loss_bps"] = str(
        min(8, max(4, _int_profile_param(params, "short_stop_loss_bps", default=6)))
    )
    params["max_session_negative_exit_bps"] = str(
        min(
            8,
            max(
                3,
                _int_profile_param(params, "max_session_negative_exit_bps", default=4),
            ),
        )
    )
    next_profile["params"] = params
    return _cash_constrain_profile(
        next_profile,
        capital_profile="feedback_daily_coverage_cash_constrained_1x",
        label="daily_coverage_feedback_escape",
    )


def _consistency_guard_feedback_escape_profile(
    profile: Mapping[str, Any],
) -> dict[str, Any]:
    next_profile = json.loads(json.dumps(profile))
    params = _mapping(next_profile.get("params"))
    _drop_fragile_prev_close_positive_gate(params)
    params["entry_cooldown_seconds"] = str(
        max(1200, _int_profile_param(params, "entry_cooldown_seconds", default=1200))
    )
    params["long_stop_loss_bps"] = str(
        min(6, max(4, _int_profile_param(params, "long_stop_loss_bps", default=6)))
    )
    params["short_stop_loss_bps"] = str(
        min(6, max(4, _int_profile_param(params, "short_stop_loss_bps", default=6)))
    )
    params["max_session_negative_exit_bps"] = str(
        min(
            5,
            max(
                2,
                _int_profile_param(params, "max_session_negative_exit_bps", default=3),
            ),
        )
    )
    next_profile["max_position_pct_equity"] = _clamped_profile_decimal(
        params=next_profile,
        key="max_position_pct_equity",
        default=Decimal("0.25"),
        delta=Decimal("-0.05"),
        lower=Decimal("0.05"),
        upper=Decimal("0.35"),
    )
    next_profile["params"] = params
    return _cash_constrain_profile(
        next_profile,
        capital_profile="feedback_consistency_guard_cash_constrained_1x",
        label="consistency_guard_feedback_escape",
    )


def _turnover_coverage_feedback_escape_profile(
    profile: Mapping[str, Any],
) -> dict[str, Any]:
    next_profile = json.loads(json.dumps(profile))
    params = _mapping(next_profile.get("params"))
    _drop_fragile_prev_close_positive_gate(params)
    current_entries = _int_profile_param(params, "max_entries_per_session", default=3)
    params["max_entries_per_session"] = str(max(2, min(5, current_entries + 1)))
    params["max_concurrent_positions"] = str(
        max(1, min(2, _profile_rank_count_floor(next_profile)))
    )
    current_cooldown = _int_profile_param(params, "entry_cooldown_seconds", default=480)
    params["entry_cooldown_seconds"] = str(max(180, min(900, current_cooldown)))
    current_hold_seconds = _int_profile_param(params, "max_hold_seconds", default=1800)
    params["max_hold_seconds"] = str(max(300, min(2400, current_hold_seconds)))
    params["long_stop_loss_bps"] = str(
        min(6, max(3, _int_profile_param(params, "long_stop_loss_bps", default=5)))
    )
    params["short_stop_loss_bps"] = str(
        min(6, max(3, _int_profile_param(params, "short_stop_loss_bps", default=5)))
    )
    params["max_session_negative_exit_bps"] = str(
        min(
            5,
            max(
                2,
                _int_profile_param(params, "max_session_negative_exit_bps", default=3),
            ),
        )
    )
    next_profile["params"] = params
    return _cash_constrain_profile(
        next_profile,
        capital_profile="feedback_turnover_coverage_cash_constrained_1x",
        label="turnover_coverage_feedback_escape",
    )


def _notional_throughput_feedback_escape_profile(
    profile: Mapping[str, Any],
) -> dict[str, Any]:
    next_profile = json.loads(json.dumps(profile))
    params = _mapping(next_profile.get("params"))
    _drop_fragile_prev_close_positive_gate(params)
    current_entries = _int_profile_param(params, "max_entries_per_session", default=4)
    params["max_entries_per_session"] = str(max(10, min(12, current_entries + 6)))
    params["entry_notional_max_multiplier"] = "1.0"
    params["max_concurrent_positions"] = str(
        max(1, min(2, _profile_rank_count_floor(next_profile)))
    )
    if "max_pair_legs" in params:
        current_pair_legs = _int_profile_param(params, "max_pair_legs", default=2)
        if "top_n" in params:
            params["max_pair_legs"] = str(max(3, min(5, current_pair_legs + 2)))
            params["max_concurrent_positions"] = str(
                max(
                    2,
                    min(
                        4,
                        max(
                            _int_profile_param(
                                params, "max_concurrent_positions", default=1
                            ),
                            current_pair_legs,
                        ),
                    ),
                )
            )
        else:
            params["max_pair_legs"] = str(max(1, min(2, current_pair_legs)))
    if "top_n" in params:
        current_top_n = _int_profile_param(params, "top_n", default=2)
        params["top_n"] = str(max(3, min(5, current_top_n + 2)))
    current_cooldown = _int_profile_param(params, "entry_cooldown_seconds", default=300)
    params["entry_cooldown_seconds"] = str(max(90, min(300, current_cooldown)))
    current_hold_seconds = _int_profile_param(params, "max_hold_seconds", default=900)
    params["max_hold_seconds"] = str(max(300, min(1200, current_hold_seconds)))
    params["long_stop_loss_bps"] = str(
        min(5, max(3, _int_profile_param(params, "long_stop_loss_bps", default=4)))
    )
    params["short_stop_loss_bps"] = str(
        min(5, max(3, _int_profile_param(params, "short_stop_loss_bps", default=4)))
    )
    params["max_session_negative_exit_bps"] = str(
        min(
            4,
            max(
                2,
                _int_profile_param(params, "max_session_negative_exit_bps", default=3),
            ),
        )
    )
    threshold_steps = (
        (
            "min_cross_section_continuation_rank",
            Decimal("-0.08"),
            Decimal("0.35"),
            Decimal("0.90"),
        ),
        (
            "min_cross_section_opening_window_return_rank",
            Decimal("-0.08"),
            Decimal("0.30"),
            Decimal("0.90"),
        ),
        (
            "min_cross_section_reversal_rank",
            Decimal("-0.08"),
            Decimal("0.50"),
            Decimal("0.90"),
        ),
        (
            "max_cross_section_continuation_rank",
            Decimal("0.08"),
            Decimal("0.25"),
            Decimal("0.75"),
        ),
        (
            "leader_reclaim_min_recent_imbalance_pressure",
            Decimal("-0.03"),
            Decimal("-0.05"),
            Decimal("0.40"),
        ),
        (
            "leader_reclaim_min_recent_microprice_bias_bps",
            Decimal("-0.08"),
            Decimal("-0.20"),
            Decimal("0.60"),
        ),
        (
            "min_recent_imbalance_pressure",
            Decimal("-0.03"),
            Decimal("-0.10"),
            Decimal("0.40"),
        ),
        (
            "min_recent_microprice_bias_bps",
            Decimal("-0.08"),
            Decimal("-0.30"),
            Decimal("0.60"),
        ),
        ("min_imbalance_pressure", Decimal("-0.03"), Decimal("-0.12"), Decimal("0.40")),
    )
    for key, delta, lower, upper in threshold_steps:
        if key not in params:
            continue
        params[key] = _clamped_profile_decimal(
            params=params,
            key=key,
            default=Decimal(str(params[key])),
            delta=delta,
            lower=lower,
            upper=upper,
            places=Decimal("0.01"),
        )
    next_profile["params"] = params
    return _cash_constrain_profile(
        next_profile,
        capital_profile="feedback_notional_throughput_cash_constrained_1x",
        label="notional_throughput_feedback_escape",
    )


def _adverse_selection_feedback_escape_profile(
    profile: Mapping[str, Any],
) -> dict[str, Any]:
    next_profile = json.loads(json.dumps(profile))
    params = _mapping(next_profile.get("params"))
    _drop_fragile_prev_close_positive_gate(params)
    current_entries = _int_profile_param(params, "max_entries_per_session", default=4)
    params["max_entries_per_session"] = str(max(10, min(12, current_entries + 6)))
    params["entry_notional_max_multiplier"] = "1.0"
    params["max_concurrent_positions"] = "1"
    current_cooldown = _int_profile_param(params, "entry_cooldown_seconds", default=600)
    params["entry_cooldown_seconds"] = str(max(600, min(1200, current_cooldown)))
    current_hold_seconds = _int_profile_param(params, "max_hold_seconds", default=900)
    params["max_hold_seconds"] = str(max(900, min(1800, current_hold_seconds)))
    params["long_stop_loss_bps"] = str(
        min(5, max(4, _int_profile_param(params, "long_stop_loss_bps", default=4)))
    )
    params["short_stop_loss_bps"] = str(
        min(5, max(4, _int_profile_param(params, "short_stop_loss_bps", default=4)))
    )
    params["max_session_negative_exit_bps"] = str(
        min(
            4,
            max(
                2,
                _int_profile_param(params, "max_session_negative_exit_bps", default=3),
            ),
        )
    )
    params["max_stop_loss_exits_per_session"] = "1"
    params["stop_loss_lockout_seconds"] = str(
        max(1800, _int_profile_param(params, "stop_loss_lockout_seconds", default=1800))
    )
    for key in (
        "entry_minute_after_open",
        "leader_reclaim_start_minutes_since_open",
    ):
        if key in params:
            params[key] = str(
                min(120, _int_profile_param(params, key, default=45) + 15)
            )
    if "entry_start_minute_utc" in params:
        params["entry_start_minute_utc"] = str(
            min(
                1140,
                _int_profile_param(params, "entry_start_minute_utc", default=840) + 15,
            )
        )
    long_confirmation_steps = (
        (
            "min_cross_section_continuation_rank",
            Decimal("0.08"),
            Decimal("0.58"),
            Decimal("0.92"),
        ),
        (
            "min_cross_section_opening_window_return_rank",
            Decimal("0.06"),
            Decimal("0.52"),
            Decimal("0.92"),
        ),
        (
            "leader_reclaim_min_recent_imbalance_pressure",
            Decimal("0.04"),
            Decimal("0.04"),
            Decimal("0.40"),
        ),
        (
            "leader_reclaim_min_recent_microprice_bias_bps",
            Decimal("0.12"),
            Decimal("0.12"),
            Decimal("0.80"),
        ),
        (
            "min_recent_imbalance_pressure",
            Decimal("0.04"),
            Decimal("0.02"),
            Decimal("0.40"),
        ),
        (
            "min_recent_microprice_bias_bps",
            Decimal("0.12"),
            Decimal("0.10"),
            Decimal("0.80"),
        ),
        (
            "min_recent_above_opening_window_close_ratio",
            Decimal("0.06"),
            Decimal("0.58"),
            Decimal("0.88"),
        ),
        (
            "min_recent_above_vwap_w5m_ratio",
            Decimal("0.06"),
            Decimal("0.58"),
            Decimal("0.88"),
        ),
    )
    short_confirmation_steps = (
        (
            "max_recent_imbalance_pressure",
            Decimal("-0.04"),
            Decimal("-0.40"),
            Decimal("-0.02"),
        ),
        (
            "max_recent_microprice_bias_bps",
            Decimal("-0.12"),
            Decimal("-0.80"),
            Decimal("-0.10"),
        ),
        (
            "max_cross_section_continuation_rank",
            Decimal("-0.06"),
            Decimal("0.08"),
            Decimal("0.55"),
        ),
    )
    for key, delta, lower, upper in (
        *long_confirmation_steps,
        *short_confirmation_steps,
    ):
        if key not in params:
            continue
        params[key] = _clamped_profile_decimal(
            params=params,
            key=key,
            default=Decimal(str(params[key])),
            delta=delta,
            lower=lower,
            upper=upper,
            places=Decimal("0.01"),
        )
    next_profile["params"] = params
    return _cash_constrain_profile(
        next_profile,
        capital_profile="feedback_adverse_selection_cash_constrained_1x",
        label="adverse_selection_feedback_escape",
    )


def _symbol_diversification_feedback_escape_profile(
    profile: Mapping[str, Any],
) -> dict[str, Any]:
    next_profile = json.loads(json.dumps(profile))
    params = _mapping(next_profile.get("params"))
    _drop_fragile_prev_close_positive_gate(params)
    diversified_symbols: list[str] = []
    seen_symbols: set[str] = set()
    raw_symbols = next_profile.get("universe_symbols")
    base_symbols = (
        cast(Sequence[Any], raw_symbols)
        if isinstance(raw_symbols, Sequence) and not isinstance(raw_symbols, str)
        else ()
    )
    for symbol in (
        *base_symbols,
        *_PORTFOLIO_COVERAGE_UNIVERSE_PROFILE,
    ):
        normalized = str(symbol).strip().upper()
        if not normalized or normalized in seen_symbols:
            continue
        diversified_symbols.append(normalized)
        seen_symbols.add(normalized)
        if len(diversified_symbols) >= len(_PORTFOLIO_COVERAGE_UNIVERSE_PROFILE):
            break
    if diversified_symbols:
        next_profile["universe_symbols"] = diversified_symbols
    params["max_entries_per_session"] = str(
        max(
            4,
            min(
                8,
                _int_profile_param(params, "max_entries_per_session", default=3) + 2,
            ),
        )
    )
    params["max_concurrent_positions"] = str(
        max(3, min(5, _profile_rank_count_floor(next_profile)))
    )
    if "max_pair_legs" in params:
        params["max_pair_legs"] = str(
            max(3, min(5, _int_profile_param(params, "max_pair_legs", default=3)))
        )
    if "top_n" in params:
        params["top_n"] = str(
            max(3, min(5, _int_profile_param(params, "top_n", default=3)))
        )
    params["long_stop_loss_bps"] = str(
        min(6, max(3, _int_profile_param(params, "long_stop_loss_bps", default=4)))
    )
    params["short_stop_loss_bps"] = str(
        min(6, max(3, _int_profile_param(params, "short_stop_loss_bps", default=4)))
    )
    params["long_trailing_stop_drawdown_bps"] = str(
        min(
            4,
            max(
                2,
                _int_profile_param(
                    params, "long_trailing_stop_drawdown_bps", default=3
                ),
            ),
        )
    )
    params["max_session_negative_exit_bps"] = str(
        min(
            4,
            max(
                2,
                _int_profile_param(params, "max_session_negative_exit_bps", default=3),
            ),
        )
    )
    params["symbol_concentration_feedback_guard"] = "max_single_symbol_contribution"
    next_profile["params"] = params
    return _cash_constrain_profile(
        next_profile,
        capital_profile="feedback_symbol_diversification_cash_constrained_1x",
        label="symbol_diversification_feedback_escape",
    )


def _portfolio_feedback_escape_execution_profiles(
    profiles: Sequence[Mapping[str, Any]],
) -> tuple[dict[str, Any], ...]:
    expanded: list[dict[str, Any]] = []
    seen: set[str] = set()
    for profile in profiles:
        for next_profile in (
            _daily_coverage_feedback_escape_profile(profile),
            _consistency_guard_feedback_escape_profile(profile),
            _turnover_coverage_feedback_escape_profile(profile),
            _notional_throughput_feedback_escape_profile(profile),
            _adverse_selection_feedback_escape_profile(profile),
            _symbol_diversification_feedback_escape_profile(profile),
        ):
            key = _stable_hash(next_profile)
            if key in seen:
                continue
            seen.add(key)
            expanded.append(next_profile)
    return tuple(expanded)


def _capital_constrained_execution_profiles(
    profiles: Sequence[Mapping[str, Any]],
) -> tuple[dict[str, Any], ...]:
    constrained: list[dict[str, Any]] = []
    for profile in profiles:
        next_profile = json.loads(json.dumps(profile))
        params = _mapping(next_profile.get("params"))
        max_notional, max_position = _capital_limited_profile_values(next_profile)
        next_profile["max_notional_per_trade"] = max_notional
        next_profile["max_position_pct_equity"] = max_position
        params["capital_profile"] = "initial_equity_cash_constrained_1x"
        params["max_gross_exposure_pct_equity"] = "1.0"
        next_profile["params"] = params
        constrained.append(next_profile)
    return tuple(constrained)


def _execution_profile_index(
    *,
    card: HypothesisCard,
    family_template_id: str,
    family_rank: int,
    target_net_pnl_per_day: Decimal = Decimal("300"),
    include_false_negative_rescue: bool = False,
) -> int:
    profiles = _execution_profiles_for_target(
        family_template_id=family_template_id,
        target_net_pnl_per_day=target_net_pnl_per_day,
        include_false_negative_rescue=include_false_negative_rescue,
    )
    profile_count = len(profiles) if profiles else _DEFAULT_PROFILE_COUNT
    explicit_profile = card.implementation_constraints.get("execution_profile_index")
    if explicit_profile is not None:
        try:
            return max(0, int(str(explicit_profile))) % profile_count
        except ValueError:
            pass
    return (
        _stable_int(
            {
                "hypothesis_id": card.hypothesis_id,
                "source_claim_ids": list(card.source_claim_ids),
                "family_template_id": family_template_id,
                "family_rank": family_rank,
            }
        )
        % profile_count
    )


def _execution_profile_indexes(
    *,
    card: HypothesisCard,
    family_template_id: str,
    family_rank: int,
    target_net_pnl_per_day: Decimal = Decimal("300"),
    include_false_negative_rescue: bool = False,
) -> tuple[int, ...]:
    profiles = _execution_profiles_for_target(
        family_template_id=family_template_id,
        target_net_pnl_per_day=target_net_pnl_per_day,
        include_false_negative_rescue=include_false_negative_rescue,
    )
    profile_count = len(profiles) if profiles else _DEFAULT_PROFILE_COUNT
    explicit_profile = card.implementation_constraints.get("execution_profile_index")
    if explicit_profile is not None:
        return (
            _execution_profile_index(
                card=card,
                family_template_id=family_template_id,
                family_rank=family_rank,
                target_net_pnl_per_day=target_net_pnl_per_day,
                include_false_negative_rescue=include_false_negative_rescue,
            ),
        )
    return tuple(range(profile_count))


def _execution_profile_id(*, family_template_id: str, profile_index: int) -> str:
    return f"{family_template_id}:profile-{profile_index + 1}"


def _execution_profiles_for_target(
    *,
    family_template_id: str,
    target_net_pnl_per_day: Decimal = Decimal("300"),
    include_false_negative_rescue: bool = False,
) -> tuple[dict[str, Any], ...]:
    base_profiles = _BASE_FAMILY_EXECUTION_PROFILES.get(family_template_id, ())
    if target_net_pnl_per_day < _PORTFOLIO_TARGET_NET_PNL_PER_DAY:
        return base_profiles
    portfolio_profiles = _PORTFOLIO_ORACLE_COVERAGE_EXECUTION_PROFILES.get(
        family_template_id, ()
    )
    h_pairs_replay_ledger_breadth_profiles = (
        _H_PAIRS_REPLAY_LEDGER_BREADTH_EXECUTION_PROFILES
        if family_template_id == "microbar_cross_sectional_pairs_v1"
        else ()
    )
    rejected_signal_rescue_profiles = (
        _REJECTED_SIGNAL_FALSE_NEGATIVE_RESCUE_EXECUTION_PROFILES.get(
            family_template_id, ()
        )
        if include_false_negative_rescue
        else ()
    )
    exploratory_profiles = (
        *rejected_signal_rescue_profiles,
        *base_profiles,
        *portfolio_profiles,
        *h_pairs_replay_ledger_breadth_profiles,
    )
    capital_constrained_profiles = _capital_constrained_execution_profiles(
        exploratory_profiles
    )
    feedback_escape_profiles = _portfolio_feedback_escape_execution_profiles(
        exploratory_profiles
    )
    return (
        *exploratory_profiles,
        *capital_constrained_profiles,
        *feedback_escape_profiles,
    )


def _strategy_overrides_for_profile(
    *,
    family_template_id: str,
    profile_index: int,
    target_net_pnl_per_day: Decimal = Decimal("300"),
    include_false_negative_rescue: bool = False,
) -> dict[str, Any]:
    profiles = _execution_profiles_for_target(
        family_template_id=family_template_id,
        target_net_pnl_per_day=target_net_pnl_per_day,
        include_false_negative_rescue=include_false_negative_rescue,
    )
    if not profiles:
        return {
            "max_notional_per_trade": "50000",
            "params": {"position_isolation_mode": "per_strategy"},
        }
    selected = profiles[profile_index % len(profiles)]
    overrides = json.loads(json.dumps(selected))
    params = _mapping(overrides.get("params"))
    params.setdefault("position_isolation_mode", "per_strategy")
    overrides["params"] = params
    return overrides


format_profile_budget = _format_profile_budget
profile_rank_count_floor = _profile_rank_count_floor
capital_limited_profile_values = _capital_limited_profile_values
decimal_profile_param = _decimal_profile_param
int_profile_param = _int_profile_param
clamped_profile_decimal = _clamped_profile_decimal
cash_constrain_profile = _cash_constrain_profile
drop_fragile_prev_close_positive_gate = _drop_fragile_prev_close_positive_gate
daily_coverage_feedback_escape_profile = _daily_coverage_feedback_escape_profile
consistency_guard_feedback_escape_profile = _consistency_guard_feedback_escape_profile
turnover_coverage_feedback_escape_profile = _turnover_coverage_feedback_escape_profile
notional_throughput_feedback_escape_profile = (
    _notional_throughput_feedback_escape_profile
)
adverse_selection_feedback_escape_profile = _adverse_selection_feedback_escape_profile
symbol_diversification_feedback_escape_profile = (
    _symbol_diversification_feedback_escape_profile
)
portfolio_feedback_escape_execution_profiles = (
    _portfolio_feedback_escape_execution_profiles
)
capital_constrained_execution_profiles = _capital_constrained_execution_profiles
execution_profile_index = _execution_profile_index
execution_profile_indexes = _execution_profile_indexes
execution_profile_id = _execution_profile_id
execution_profiles_for_target = _execution_profiles_for_target
strategy_overrides_for_profile = _strategy_overrides_for_profile


__all__ = (
    "_format_profile_budget",
    "format_profile_budget",
    "_profile_rank_count_floor",
    "profile_rank_count_floor",
    "_capital_limited_profile_values",
    "capital_limited_profile_values",
    "_decimal_profile_param",
    "decimal_profile_param",
    "_int_profile_param",
    "int_profile_param",
    "_clamped_profile_decimal",
    "clamped_profile_decimal",
    "_cash_constrain_profile",
    "cash_constrain_profile",
    "_drop_fragile_prev_close_positive_gate",
    "drop_fragile_prev_close_positive_gate",
    "_daily_coverage_feedback_escape_profile",
    "daily_coverage_feedback_escape_profile",
    "_consistency_guard_feedback_escape_profile",
    "consistency_guard_feedback_escape_profile",
    "_turnover_coverage_feedback_escape_profile",
    "turnover_coverage_feedback_escape_profile",
    "_notional_throughput_feedback_escape_profile",
    "notional_throughput_feedback_escape_profile",
    "_adverse_selection_feedback_escape_profile",
    "adverse_selection_feedback_escape_profile",
    "_symbol_diversification_feedback_escape_profile",
    "symbol_diversification_feedback_escape_profile",
    "_portfolio_feedback_escape_execution_profiles",
    "portfolio_feedback_escape_execution_profiles",
    "_capital_constrained_execution_profiles",
    "capital_constrained_execution_profiles",
    "_execution_profile_index",
    "execution_profile_index",
    "_execution_profile_indexes",
    "execution_profile_indexes",
    "_execution_profile_id",
    "execution_profile_id",
    "_execution_profiles_for_target",
    "execution_profiles_for_target",
    "_strategy_overrides_for_profile",
    "strategy_overrides_for_profile",
)
