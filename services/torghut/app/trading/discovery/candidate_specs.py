"""Candidate spec compilation from typed whitepaper hypotheses."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Literal, Mapping, Sequence, cast

from app.trading.discovery.capital_budget import estimate_capital_pressure
from app.trading.discovery.factor_acceptance import build_factor_acceptance_artifact
from app.trading.discovery.hypothesis_cards import HypothesisCard
from app.trading.semiconductor_universe import (
    LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE as LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE,
    RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE,
)


CANDIDATE_SPEC_SCHEMA_VERSION = "torghut.candidate-spec.v1"

_FAMILY_RUNTIME = {
    "breakout_reclaim_v2": (
        "breakout_continuation_consistent",
        "breakout-continuation-long-v1",
    ),
    "washout_rebound_v2": ("washout_rebound_consistent", "washout-rebound-long-v1"),
    "momentum_pullback_v1": (
        "momentum_pullback_consistent",
        "momentum-pullback-long-v1",
    ),
    "mean_reversion_rebound_v1": (
        "mean_reversion_rebound_consistent",
        "mean-reversion-rebound-long-v1",
    ),
    "mean_reversion_exhaustion_short_v1": (
        "mean_reversion_exhaustion_short_consistent",
        "mean-reversion-exhaustion-short-v1",
    ),
    "microbar_cross_sectional_pairs_v1": (
        "microbar_cross_sectional_pairs",
        "microbar-cross-sectional-pairs-v1",
    ),
    "microstructure_continuation_matched_filter_v1": (
        "breakout_continuation_consistent",
        "breakout-continuation-long-v1",
    ),
    "opening_drive_leader_reclaim_v1": (
        "breakout_continuation_consistent",
        "breakout-continuation-long-v1",
    ),
    "intraday_tsmom_v2": ("intraday_tsmom_consistent", "intraday-tsmom-profit-v3"),
    "late_day_continuation_v1": (
        "late_day_continuation_consistent",
        "late-day-continuation-long-v1",
    ),
    "end_of_day_reversal_v1": (
        "end_of_day_reversal_consistent",
        "end-of-day-reversal-long-v1",
    ),
}

_FAMILY_TIEBREAK = {
    family_template_id: index
    for index, family_template_id in enumerate(
        (
            "microstructure_continuation_matched_filter_v1",
            "opening_drive_leader_reclaim_v1",
            "microbar_cross_sectional_pairs_v1",
            "intraday_tsmom_v2",
            "momentum_pullback_v1",
            "late_day_continuation_v1",
            "end_of_day_reversal_v1",
            "mean_reversion_exhaustion_short_v1",
            "breakout_reclaim_v2",
            "washout_rebound_v2",
            "mean_reversion_rebound_v1",
        )
    )
}
_MAX_FAMILIES_PER_HYPOTHESIS = 3
_PORTFOLIO_TARGET_NET_PNL_PER_DAY = Decimal("500")
_PORTFOLIO_SLEEVE_FAMILY_TARGET = len(_FAMILY_RUNTIME)
_PORTFOLIO_SLEEVE_FAMILY_ORDER = (
    "microstructure_continuation_matched_filter_v1",
    "opening_drive_leader_reclaim_v1",
    "microbar_cross_sectional_pairs_v1",
    "intraday_tsmom_v2",
    "momentum_pullback_v1",
    "late_day_continuation_v1",
    "end_of_day_reversal_v1",
    "mean_reversion_exhaustion_short_v1",
    "breakout_reclaim_v2",
    "washout_rebound_v2",
    "mean_reversion_rebound_v1",
)
_DEFAULT_PROFILE_COUNT = 3

_RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE = RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE
_AI_ACCELERATOR_UNIVERSE_PROFILE: tuple[str, ...] = (
    "NVDA",
    "AVGO",
    "AMD",
)
_LIQUID_TECH_PLATFORM_UNIVERSE_PROFILE: tuple[str, ...] = (
    "AAPL",
    "AMZN",
    "GOOGL",
    "ORCL",
    "INTC",
)
_BROAD_SEMICONDUCTOR_UNIVERSE_PROFILE: tuple[str, ...] = (
    _RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE
)
_PORTFOLIO_COVERAGE_UNIVERSE_PROFILE: tuple[str, ...] = (
    "NVDA",
    "AAPL",
    "AMD",
    "AVGO",
    "INTC",
    "ORCL",
    "AMZN",
    "GOOGL",
)
_PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE = _AI_ACCELERATOR_UNIVERSE_PROFILE
_PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE = _LIQUID_TECH_PLATFORM_UNIVERSE_PROFILE

_LARGE_CAP_UNIVERSE_PROFILES: tuple[tuple[str, ...], ...] = (
    _AI_ACCELERATOR_UNIVERSE_PROFILE,
    _LIQUID_TECH_PLATFORM_UNIVERSE_PROFILE,
    _BROAD_SEMICONDUCTOR_UNIVERSE_PROFILE,
)
_BREAKOUT_UNIVERSE_PROFILES: tuple[tuple[str, ...], ...] = (
    _AI_ACCELERATOR_UNIVERSE_PROFILE,
    ("NVDA", "AVGO", "AMD", "ORCL", "INTC"),
    _BROAD_SEMICONDUCTOR_UNIVERSE_PROFILE,
)
_REVERSAL_UNIVERSE_PROFILES: tuple[tuple[str, ...], ...] = (
    ("AMD", "INTC", "ORCL", "AAPL"),
    ("AMD", "INTC", "ORCL", "AAPL", "AMZN", "GOOGL", "AVGO"),
    _BROAD_SEMICONDUCTOR_UNIVERSE_PROFILE,
)
_TSMOM_UNIVERSE_PROFILES: tuple[tuple[str, ...], ...] = (
    ("NVDA",),
    ("NVDA", "AVGO", "AMD", "INTC"),
    _BROAD_SEMICONDUCTOR_UNIVERSE_PROFILE,
)

_FAMILY_EXECUTION_PROFILES: dict[str, tuple[dict[str, Any], ...]] = {
    "microbar_cross_sectional_pairs_v1": (
        {
            "universe_symbols": list(_LARGE_CAP_UNIVERSE_PROFILES[0]),
            "normalization_regime": "market_neutral_gross_scaled",
            "max_position_pct_equity": "6.0",
            "max_notional_per_trade": "157950.10",
            "params": {
                "entry_minute_after_open": "60",
                "exit_minute_after_open": "120",
                "signal_motif": "vwap_close_continuation",
                "rank_feature": "cross_section_vwap_w5m_rank",
                "selection_mode": "continuation",
                "top_n": "1",
                "min_cross_section_continuation_rank": "0.55",
                "max_pair_legs": "2",
                "max_entries_per_session": "1",
                "entry_cooldown_seconds": "600",
                "long_stop_loss_bps": "10",
                "long_trailing_stop_activation_profit_bps": "8",
                "long_trailing_stop_drawdown_bps": "4",
                "max_hold_seconds": "7200",
                "max_session_negative_exit_bps": "10",
                "max_stop_loss_exits_per_session": "1",
                "stop_loss_lockout_seconds": "1800",
            },
        },
        {
            "universe_symbols": list(_LARGE_CAP_UNIVERSE_PROFILES[1]),
            "normalization_regime": "market_neutral_gross_scaled",
            "max_position_pct_equity": "8.0",
            "max_notional_per_trade": "236925.15",
            "params": {
                "entry_minute_after_open": "75",
                "exit_minute_after_open": "close",
                "signal_motif": "open_window_continuation",
                "rank_feature": "cross_section_session_open_rank",
                "selection_mode": "continuation",
                "top_n": "2",
                "min_cross_section_continuation_rank": "0.65",
                "max_pair_legs": "3",
                "max_entries_per_session": "2",
                "entry_cooldown_seconds": "900",
                "long_stop_loss_bps": "10",
                "long_trailing_stop_activation_profit_bps": "8",
                "long_trailing_stop_drawdown_bps": "4",
                "max_hold_seconds": "7200",
                "max_session_negative_exit_bps": "8",
                "max_stop_loss_exits_per_session": "1",
                "stop_loss_lockout_seconds": "1800",
            },
        },
        {
            "universe_symbols": list(_LARGE_CAP_UNIVERSE_PROFILES[2]),
            "normalization_regime": "market_neutral_gross_scaled",
            "max_position_pct_equity": "6.0",
            "max_notional_per_trade": "157950.10",
            "params": {
                "entry_minute_after_open": "75",
                "exit_minute_after_open": "120",
                "signal_motif": "vwap_close_continuation",
                "rank_feature": "cross_section_session_open_rank",
                "selection_mode": "continuation",
                "top_n": "1",
                "min_cross_section_continuation_rank": "0.60",
                "max_pair_legs": "2",
                "max_entries_per_session": "2",
                "entry_cooldown_seconds": "600",
                "long_stop_loss_bps": "8",
                "long_trailing_stop_activation_profit_bps": "6",
                "long_trailing_stop_drawdown_bps": "3",
                "max_hold_seconds": "5400",
                "max_session_negative_exit_bps": "8",
                "max_stop_loss_exits_per_session": "1",
                "stop_loss_lockout_seconds": "1800",
            },
        },
        {
            "universe_symbols": list(_LARGE_CAP_UNIVERSE_PROFILES[2]),
            "normalization_regime": "market_neutral_gross_scaled",
            "max_position_pct_equity": "4.0",
            "max_notional_per_trade": "126360",
            "params": {
                "entry_minute_after_open": "45",
                "exit_minute_after_open": "150",
                "signal_motif": "open_window_reversal",
                "rank_feature": "cross_section_session_open_rank",
                "selection_mode": "reversal",
                "top_n": "2",
                "max_cross_section_continuation_rank": "0.45",
                "min_cross_section_reversal_rank": "0.70",
                "max_pair_legs": "4",
                "max_entries_per_session": "2",
                "entry_cooldown_seconds": "1200",
                "long_stop_loss_bps": "8",
                "long_trailing_stop_activation_profit_bps": "6",
                "long_trailing_stop_drawdown_bps": "3",
                "max_hold_seconds": "5400",
                "max_session_negative_exit_bps": "6",
                "max_stop_loss_exits_per_session": "1",
                "stop_loss_lockout_seconds": "2700",
            },
        },
        {
            "universe_symbols": list(_LARGE_CAP_UNIVERSE_PROFILES[0]),
            "normalization_regime": "market_neutral_gross_scaled",
            "max_position_pct_equity": "4.0",
            "max_notional_per_trade": "94770",
            "params": {
                "entry_minute_after_open": "90",
                "exit_minute_after_open": "close",
                "signal_motif": "vwap_close_reversal",
                "rank_feature": "cross_section_vwap_w5m_rank",
                "selection_mode": "reversal",
                "top_n": "1",
                "max_cross_section_continuation_rank": "0.40",
                "min_cross_section_reversal_rank": "0.78",
                "max_pair_legs": "2",
                "max_entries_per_session": "1",
                "entry_cooldown_seconds": "1800",
                "long_stop_loss_bps": "6",
                "long_trailing_stop_activation_profit_bps": "5",
                "long_trailing_stop_drawdown_bps": "3",
                "max_hold_seconds": "3600",
                "max_session_negative_exit_bps": "5",
                "max_stop_loss_exits_per_session": "1",
                "stop_loss_lockout_seconds": "3600",
            },
        },
        {
            "universe_symbols": list(_LARGE_CAP_UNIVERSE_PROFILES[0]),
            "normalization_regime": "market_neutral_gross_scaled",
            "max_position_pct_equity": "4.0",
            "max_notional_per_trade": "94770",
            "params": {
                "entry_minute_after_open": "60",
                "exit_minute_after_open": "150",
                "signal_motif": "factor_neutral_residual_continuation",
                "rank_feature": "cross_section_factor_neutral_residual_rank",
                "selection_mode": "continuation",
                "top_n": "1",
                "min_cross_section_continuation_rank": "0.65",
                "max_pair_legs": "2",
                "max_entries_per_session": "1",
                "entry_cooldown_seconds": "900",
                "long_stop_loss_bps": "8",
                "long_trailing_stop_activation_profit_bps": "6",
                "long_trailing_stop_drawdown_bps": "3",
                "max_hold_seconds": "5400",
                "max_session_negative_exit_bps": "6",
                "max_stop_loss_exits_per_session": "1",
                "stop_loss_lockout_seconds": "2700",
            },
        },
        {
            "universe_symbols": list(_LARGE_CAP_UNIVERSE_PROFILES[2]),
            "normalization_regime": "market_neutral_gross_scaled",
            "max_position_pct_equity": "3.0",
            "max_notional_per_trade": "63180",
            "params": {
                "entry_minute_after_open": "75",
                "exit_minute_after_open": "150",
                "signal_motif": "residual_spread_reversion",
                "rank_feature": "cross_section_residual_spread_zscore_rank",
                "selection_mode": "reversal",
                "top_n": "1",
                "max_cross_section_continuation_rank": "0.35",
                "min_cross_section_reversal_rank": "0.75",
                "max_pair_legs": "2",
                "max_entries_per_session": "1",
                "entry_cooldown_seconds": "1800",
                "long_stop_loss_bps": "6",
                "long_trailing_stop_activation_profit_bps": "5",
                "long_trailing_stop_drawdown_bps": "3",
                "max_hold_seconds": "3600",
                "max_session_negative_exit_bps": "5",
                "max_stop_loss_exits_per_session": "1",
                "stop_loss_lockout_seconds": "3600",
            },
        },
    ),
    "microstructure_continuation_matched_filter_v1": (
        {
            "universe_symbols": list(_LARGE_CAP_UNIVERSE_PROFILES[0]),
            "max_position_pct_equity": "8.0",
            "max_notional_per_trade": "157950.10",
            "params": {
                "min_cross_section_continuation_rank": "0.55",
                "min_cross_section_opening_window_return_rank": "0.45",
                "max_gross_exposure_pct_equity": "8.0",
                "entry_notional_max_multiplier": "1.00",
                "max_entries_per_session": "1",
                "entry_cooldown_seconds": "600",
                "leader_reclaim_start_minutes_since_open": "30",
                "leader_reclaim_min_recent_imbalance_pressure": "0.08",
                "leader_reclaim_min_recent_microprice_bias_bps": "0.15",
                "leader_reclaim_min_recent_above_opening_window_close_ratio": "0.55",
                "leader_reclaim_min_recent_above_vwap_w5m_ratio": "0.55",
                "long_stop_loss_bps": "10",
                "long_trailing_stop_activation_profit_bps": "6",
                "long_trailing_stop_drawdown_bps": "3",
            },
        },
        {
            "universe_symbols": list(_LARGE_CAP_UNIVERSE_PROFILES[1]),
            "max_position_pct_equity": "10.0",
            "max_notional_per_trade": "236925.15",
            "params": {
                "min_cross_section_continuation_rank": "0.65",
                "min_cross_section_opening_window_return_rank": "0.55",
                "max_gross_exposure_pct_equity": "10.0",
                "entry_notional_max_multiplier": "1.25",
                "max_entries_per_session": "2",
                "entry_cooldown_seconds": "900",
                "leader_reclaim_start_minutes_since_open": "45",
                "leader_reclaim_min_recent_imbalance_pressure": "0.12",
                "leader_reclaim_min_recent_microprice_bias_bps": "0.25",
                "leader_reclaim_min_recent_above_opening_window_close_ratio": "0.65",
                "leader_reclaim_min_recent_above_vwap_w5m_ratio": "0.65",
                "long_stop_loss_bps": "12",
                "long_trailing_stop_activation_profit_bps": "8",
                "long_trailing_stop_drawdown_bps": "4",
            },
        },
        {
            "universe_symbols": list(_LARGE_CAP_UNIVERSE_PROFILES[2]),
            "max_position_pct_equity": "8.0",
            "max_notional_per_trade": "236925.15",
            "params": {
                "min_cross_section_continuation_rank": "0.60",
                "min_cross_section_opening_window_return_rank": "0.50",
                "max_gross_exposure_pct_equity": "8.0",
                "entry_notional_max_multiplier": "1.25",
                "max_entries_per_session": "2",
                "entry_cooldown_seconds": "600",
                "leader_reclaim_start_minutes_since_open": "45",
                "leader_reclaim_min_recent_imbalance_pressure": "0.10",
                "leader_reclaim_min_recent_microprice_bias_bps": "0.20",
                "leader_reclaim_min_recent_above_opening_window_close_ratio": "0.60",
                "leader_reclaim_min_recent_above_vwap_w5m_ratio": "0.60",
                "long_stop_loss_bps": "10",
                "long_trailing_stop_activation_profit_bps": "8",
                "long_trailing_stop_drawdown_bps": "3",
            },
        },
        {
            "universe_symbols": list(_LARGE_CAP_UNIVERSE_PROFILES[2]),
            "max_position_pct_equity": "4.0",
            "max_notional_per_trade": "126360",
            "params": {
                "min_cross_section_continuation_rank": "0.52",
                "min_cross_section_opening_window_return_rank": "0.45",
                "max_gross_exposure_pct_equity": "6.0",
                "entry_notional_max_multiplier": "0.80",
                "max_entries_per_session": "3",
                "entry_cooldown_seconds": "450",
                "leader_reclaim_start_minutes_since_open": "30",
                "leader_reclaim_min_recent_imbalance_pressure": "0.06",
                "leader_reclaim_min_recent_microprice_bias_bps": "0.10",
                "leader_reclaim_min_recent_above_opening_window_close_ratio": "0.52",
                "leader_reclaim_min_recent_above_vwap_w5m_ratio": "0.52",
                "max_session_negative_exit_bps": "6",
                "long_stop_loss_bps": "8",
                "long_trailing_stop_activation_profit_bps": "6",
                "long_trailing_stop_drawdown_bps": "3",
            },
        },
        {
            "universe_symbols": list(_LARGE_CAP_UNIVERSE_PROFILES[1]),
            "max_position_pct_equity": "6.0",
            "max_notional_per_trade": "189540",
            "params": {
                "min_cross_section_continuation_rank": "0.70",
                "min_cross_section_opening_window_return_rank": "0.60",
                "max_gross_exposure_pct_equity": "8.0",
                "entry_notional_max_multiplier": "1.00",
                "max_entries_per_session": "1",
                "entry_cooldown_seconds": "1200",
                "leader_reclaim_start_minutes_since_open": "60",
                "leader_reclaim_min_recent_imbalance_pressure": "0.16",
                "leader_reclaim_min_recent_microprice_bias_bps": "0.35",
                "leader_reclaim_min_recent_above_opening_window_close_ratio": "0.70",
                "leader_reclaim_min_recent_above_vwap_w5m_ratio": "0.70",
                "max_session_negative_exit_bps": "8",
                "long_stop_loss_bps": "10",
                "long_trailing_stop_activation_profit_bps": "10",
                "long_trailing_stop_drawdown_bps": "4",
            },
        },
    ),
    "opening_drive_leader_reclaim_v1": (
        {
            "universe_symbols": list(_PORTFOLIO_COVERAGE_UNIVERSE_PROFILE),
            "max_position_pct_equity": "6.0",
            "max_notional_per_trade": "189540",
            "params": {
                "min_cross_section_continuation_rank": "0.58",
                "min_cross_section_opening_window_return_rank": "0.54",
                "max_gross_exposure_pct_equity": "6.0",
                "entry_notional_max_multiplier": "1.00",
                "max_entries_per_session": "2",
                "entry_cooldown_seconds": "600",
                "leader_reclaim_start_minutes_since_open": "20",
                "leader_reclaim_min_recent_imbalance_pressure": "0.06",
                "leader_reclaim_min_recent_microprice_bias_bps": "0.12",
                "leader_reclaim_min_recent_above_opening_window_close_ratio": "0.54",
                "leader_reclaim_min_recent_above_vwap_w5m_ratio": "0.52",
                "max_session_negative_exit_bps": "6",
                "long_stop_loss_bps": "8",
                "long_trailing_stop_activation_profit_bps": "6",
                "long_trailing_stop_drawdown_bps": "3",
            },
        },
        {
            "universe_symbols": list(
                _PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE
            ),
            "max_position_pct_equity": "5.0",
            "max_notional_per_trade": "157950",
            "params": {
                "min_cross_section_continuation_rank": "0.64",
                "min_cross_section_opening_window_return_rank": "0.60",
                "max_gross_exposure_pct_equity": "5.0",
                "entry_notional_max_multiplier": "0.90",
                "max_entries_per_session": "2",
                "entry_cooldown_seconds": "900",
                "leader_reclaim_start_minutes_since_open": "30",
                "leader_reclaim_min_recent_imbalance_pressure": "0.08",
                "leader_reclaim_min_recent_microprice_bias_bps": "0.16",
                "leader_reclaim_min_recent_above_opening_window_close_ratio": "0.58",
                "leader_reclaim_min_recent_above_vwap_w5m_ratio": "0.56",
                "max_session_negative_exit_bps": "5",
                "long_stop_loss_bps": "7",
                "long_trailing_stop_activation_profit_bps": "6",
                "long_trailing_stop_drawdown_bps": "3",
            },
        },
        {
            "universe_symbols": list(_PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE),
            "max_position_pct_equity": "4.0",
            "max_notional_per_trade": "126360",
            "params": {
                "min_cross_section_continuation_rank": "0.52",
                "min_cross_section_opening_window_return_rank": "0.48",
                "max_gross_exposure_pct_equity": "4.0",
                "entry_notional_max_multiplier": "0.80",
                "max_entries_per_session": "3",
                "entry_cooldown_seconds": "600",
                "leader_reclaim_start_minutes_since_open": "15",
                "leader_reclaim_min_recent_imbalance_pressure": "0.04",
                "leader_reclaim_min_recent_microprice_bias_bps": "0.08",
                "leader_reclaim_min_recent_above_opening_window_close_ratio": "0.50",
                "leader_reclaim_min_recent_above_vwap_w5m_ratio": "0.48",
                "max_session_negative_exit_bps": "4",
                "long_stop_loss_bps": "6",
                "long_trailing_stop_activation_profit_bps": "5",
                "long_trailing_stop_drawdown_bps": "2",
            },
        },
    ),
    "intraday_tsmom_v2": (
        {
            "universe_symbols": list(_TSMOM_UNIVERSE_PROFILES[0]),
            "max_notional_per_trade": "15000",
            "max_position_pct_equity": "1.5",
            "params": {
                "long_stop_loss_bps": "12",
                "long_trailing_stop_activation_profit_bps": "8",
                "long_trailing_stop_drawdown_bps": "4",
                "max_session_negative_exit_bps": "8",
                "min_cross_section_continuation_rank": "0.60",
            },
        },
        {
            "universe_symbols": list(_TSMOM_UNIVERSE_PROFILES[1]),
            "max_notional_per_trade": "25000",
            "max_position_pct_equity": "2.0",
            "params": {
                "long_stop_loss_bps": "18",
                "long_trailing_stop_activation_profit_bps": "12",
                "long_trailing_stop_drawdown_bps": "6",
                "max_session_negative_exit_bps": "12",
                "min_cross_section_continuation_rank": "0.70",
            },
        },
        {
            "universe_symbols": list(_TSMOM_UNIVERSE_PROFILES[2]),
            "max_notional_per_trade": "35000",
            "max_position_pct_equity": "2.0",
            "params": {
                "long_stop_loss_bps": "12",
                "long_trailing_stop_activation_profit_bps": "12",
                "long_trailing_stop_drawdown_bps": "4",
                "max_session_negative_exit_bps": "8",
                "min_cross_section_continuation_rank": "0.65",
            },
        },
        {
            "universe_symbols": list(_TSMOM_UNIVERSE_PROFILES[1]),
            "max_notional_per_trade": "63180",
            "max_position_pct_equity": "3.0",
            "params": {
                "long_stop_loss_bps": "10",
                "long_trailing_stop_activation_profit_bps": "10",
                "long_trailing_stop_drawdown_bps": "4",
                "max_session_negative_exit_bps": "6",
                "min_cross_section_continuation_rank": "0.55",
                "max_entries_per_session": "3",
                "entry_cooldown_seconds": "600",
            },
        },
        {
            "universe_symbols": list(_TSMOM_UNIVERSE_PROFILES[2]),
            "max_notional_per_trade": "126360",
            "max_position_pct_equity": "4.0",
            "params": {
                "long_stop_loss_bps": "14",
                "long_trailing_stop_activation_profit_bps": "10",
                "long_trailing_stop_drawdown_bps": "5",
                "max_session_negative_exit_bps": "8",
                "min_cross_section_continuation_rank": "0.62",
                "max_entries_per_session": "2",
                "entry_cooldown_seconds": "900",
            },
        },
    ),
    "mean_reversion_rebound_v1": (
        {
            "universe_symbols": list(_REVERSAL_UNIVERSE_PROFILES[1]),
            "max_position_pct_equity": "2.0",
            "max_notional_per_trade": "63180",
            "params": {
                "min_bull_rsi": "40",
                "max_bull_rsi": "50",
                "min_price_below_vwap_bps": "8",
                "max_price_below_vwap_bps": "40",
                "max_price_vs_session_open_bps": "-20",
                "max_opening_window_return_bps": "-5",
                "max_cross_section_continuation_rank": "0.45",
                "min_cross_section_reversal_rank": "0.70",
                "min_recent_imbalance_pressure": "0.02",
                "entry_start_minute_utc": "840",
                "entry_end_minute_utc": "1080",
                "max_gross_exposure_pct_equity": "4.0",
                "entry_cooldown_seconds": "900",
            },
        },
        {
            "universe_symbols": list(_REVERSAL_UNIVERSE_PROFILES[2]),
            "max_position_pct_equity": "4.0",
            "max_notional_per_trade": "126360",
            "params": {
                "min_bull_rsi": "43",
                "max_bull_rsi": "50",
                "min_price_below_vwap_bps": "12",
                "max_price_below_vwap_bps": "55",
                "max_price_vs_session_open_bps": "-30",
                "max_opening_window_return_bps": "-10",
                "max_cross_section_continuation_rank": "0.55",
                "min_cross_section_reversal_rank": "0.78",
                "min_recent_imbalance_pressure": "0.03",
                "entry_start_minute_utc": "840",
                "entry_end_minute_utc": "1080",
                "max_gross_exposure_pct_equity": "4.0",
                "entry_cooldown_seconds": "1200",
            },
        },
        {
            "universe_symbols": list(_REVERSAL_UNIVERSE_PROFILES[2]),
            "max_position_pct_equity": "2.0",
            "max_notional_per_trade": "126360",
            "params": {
                "min_bull_rsi": "40",
                "max_bull_rsi": "50",
                "min_price_below_vwap_bps": "12",
                "max_price_below_vwap_bps": "40",
                "max_price_vs_session_open_bps": "-30",
                "max_opening_window_return_bps": "-5",
                "max_cross_section_continuation_rank": "0.45",
                "min_cross_section_reversal_rank": "0.78",
                "min_recent_imbalance_pressure": "0.02",
                "entry_start_minute_utc": "840",
                "entry_end_minute_utc": "1080",
                "max_gross_exposure_pct_equity": "4.0",
                "entry_cooldown_seconds": "900",
            },
        },
        {
            "universe_symbols": list(_REVERSAL_UNIVERSE_PROFILES[1]),
            "max_position_pct_equity": "2.0",
            "max_notional_per_trade": "63180",
            "params": {
                "min_bull_rsi": "36",
                "max_bull_rsi": "48",
                "min_price_below_vwap_bps": "10",
                "max_price_below_vwap_bps": "50",
                "max_price_vs_session_open_bps": "-25",
                "max_opening_window_return_bps": "-15",
                "max_cross_section_continuation_rank": "0.50",
                "min_cross_section_reversal_rank": "0.65",
                "min_recent_imbalance_pressure": "0.01",
                "entry_start_minute_utc": "870",
                "entry_end_minute_utc": "1110",
                "max_gross_exposure_pct_equity": "3.0",
                "entry_cooldown_seconds": "600",
                "long_stop_loss_bps": "10",
                "long_trailing_stop_activation_profit_bps": "8",
                "long_trailing_stop_drawdown_bps": "4",
                "max_session_negative_exit_bps": "8",
                "max_hold_seconds": "3600",
            },
        },
        {
            "universe_symbols": list(_REVERSAL_UNIVERSE_PROFILES[0]),
            "max_position_pct_equity": "3.0",
            "max_notional_per_trade": "94770",
            "params": {
                "min_bull_rsi": "42",
                "max_bull_rsi": "50",
                "min_price_below_vwap_bps": "18",
                "max_price_below_vwap_bps": "60",
                "max_price_vs_session_open_bps": "-35",
                "max_opening_window_return_bps": "-20",
                "max_cross_section_continuation_rank": "0.42",
                "min_cross_section_reversal_rank": "0.82",
                "min_recent_imbalance_pressure": "0.04",
                "entry_start_minute_utc": "900",
                "entry_end_minute_utc": "1140",
                "max_gross_exposure_pct_equity": "3.0",
                "entry_cooldown_seconds": "1800",
                "long_stop_loss_bps": "12",
                "long_trailing_stop_activation_profit_bps": "8",
                "long_trailing_stop_drawdown_bps": "4",
                "max_session_negative_exit_bps": "8",
                "max_hold_seconds": "2700",
            },
        },
    ),
    "breakout_reclaim_v2": (
        {
            "universe_symbols": list(_BREAKOUT_UNIVERSE_PROFILES[0]),
            "max_position_pct_equity": "10.0",
            "max_notional_per_trade": "315900.20",
            "params": {
                "min_cross_section_continuation_rank": "0.60",
                "min_cross_section_opening_window_return_rank": "0.50",
                "max_gross_exposure_pct_equity": "10.0",
                "entry_notional_max_multiplier": "1.50",
                "max_entries_per_session": "2",
                "entry_cooldown_seconds": "600",
                "max_session_negative_exit_bps": "8",
                "leader_reclaim_start_minutes_since_open": "45",
                "leader_reclaim_min_recent_imbalance_pressure": "0.10",
                "leader_reclaim_min_recent_microprice_bias_bps": "0.25",
                "leader_reclaim_min_recent_above_opening_window_close_ratio": "0.65",
                "leader_reclaim_min_recent_above_vwap_w5m_ratio": "0.60",
                "long_stop_loss_bps": "12",
                "long_trailing_stop_activation_profit_bps": "8",
                "long_trailing_stop_drawdown_bps": "4",
            },
        },
        {
            "universe_symbols": list(_BREAKOUT_UNIVERSE_PROFILES[1]),
            "max_position_pct_equity": "10.0",
            "max_notional_per_trade": "315900.20",
            "params": {
                "min_cross_section_continuation_rank": "0.60",
                "min_cross_section_opening_window_return_rank": "0.50",
                "max_gross_exposure_pct_equity": "10.0",
                "entry_notional_max_multiplier": "1.50",
                "max_entries_per_session": "3",
                "entry_cooldown_seconds": "900",
                "max_session_negative_exit_bps": "8",
                "leader_reclaim_start_minutes_since_open": "60",
                "leader_reclaim_min_recent_imbalance_pressure": "0.10",
                "leader_reclaim_min_recent_microprice_bias_bps": "0.35",
                "leader_reclaim_min_recent_above_opening_window_close_ratio": "0.65",
                "leader_reclaim_min_recent_above_vwap_w5m_ratio": "0.60",
                "long_stop_loss_bps": "12",
                "long_trailing_stop_activation_profit_bps": "8",
                "long_trailing_stop_drawdown_bps": "4",
            },
        },
        {
            "universe_symbols": list(_BREAKOUT_UNIVERSE_PROFILES[2]),
            "max_position_pct_equity": "10.0",
            "max_notional_per_trade": "315900.20",
            "params": {
                "min_cross_section_continuation_rank": "0.60",
                "min_cross_section_opening_window_return_rank": "0.50",
                "max_gross_exposure_pct_equity": "10.0",
                "entry_notional_max_multiplier": "1.50",
                "max_entries_per_session": "2",
                "entry_cooldown_seconds": "900",
                "max_session_negative_exit_bps": "8",
                "leader_reclaim_start_minutes_since_open": "60",
                "leader_reclaim_min_recent_imbalance_pressure": "0.10",
                "leader_reclaim_min_recent_microprice_bias_bps": "0.25",
                "leader_reclaim_min_recent_above_opening_window_close_ratio": "0.65",
                "leader_reclaim_min_recent_above_vwap_w5m_ratio": "0.60",
                "long_stop_loss_bps": "12",
                "long_trailing_stop_activation_profit_bps": "8",
                "long_trailing_stop_drawdown_bps": "4",
            },
        },
        {
            "universe_symbols": list(_BREAKOUT_UNIVERSE_PROFILES[2]),
            "max_position_pct_equity": "4.0",
            "max_notional_per_trade": "126360",
            "params": {
                "min_cross_section_continuation_rank": "0.68",
                "min_cross_section_opening_window_return_rank": "0.58",
                "max_gross_exposure_pct_equity": "6.0",
                "entry_notional_max_multiplier": "0.80",
                "max_entries_per_session": "1",
                "entry_cooldown_seconds": "1200",
                "max_session_negative_exit_bps": "6",
                "leader_reclaim_start_minutes_since_open": "45",
                "leader_reclaim_min_recent_imbalance_pressure": "0.14",
                "leader_reclaim_min_recent_microprice_bias_bps": "0.30",
                "leader_reclaim_min_recent_above_opening_window_close_ratio": "0.70",
                "leader_reclaim_min_recent_above_vwap_w5m_ratio": "0.68",
                "long_stop_loss_bps": "8",
                "long_trailing_stop_activation_profit_bps": "8",
                "long_trailing_stop_drawdown_bps": "3",
            },
        },
        {
            "universe_symbols": list(_BREAKOUT_UNIVERSE_PROFILES[1]),
            "max_position_pct_equity": "6.0",
            "max_notional_per_trade": "189540",
            "params": {
                "min_cross_section_continuation_rank": "0.62",
                "min_cross_section_opening_window_return_rank": "0.52",
                "max_gross_exposure_pct_equity": "8.0",
                "entry_notional_max_multiplier": "1.00",
                "max_entries_per_session": "2",
                "entry_cooldown_seconds": "600",
                "max_session_negative_exit_bps": "8",
                "leader_reclaim_start_minutes_since_open": "30",
                "leader_reclaim_min_recent_imbalance_pressure": "0.08",
                "leader_reclaim_min_recent_microprice_bias_bps": "0.20",
                "leader_reclaim_min_recent_above_opening_window_close_ratio": "0.60",
                "leader_reclaim_min_recent_above_vwap_w5m_ratio": "0.58",
                "long_stop_loss_bps": "10",
                "long_trailing_stop_activation_profit_bps": "8",
                "long_trailing_stop_drawdown_bps": "4",
            },
        },
    ),
    "washout_rebound_v2": (
        {
            "universe_symbols": list(_REVERSAL_UNIVERSE_PROFILES[0]),
            "max_notional_per_trade": "47385",
            "max_position_pct_equity": "1.5",
            "params": {
                "min_session_open_selloff_bps": "20",
                "max_price_vs_session_low_bps": "24",
                "min_recent_microprice_bias_bps": "0.05",
                "min_cross_section_reversal_rank": "0.65",
            },
        },
        {
            "universe_symbols": list(_REVERSAL_UNIVERSE_PROFILES[1]),
            "max_notional_per_trade": "63180",
            "max_position_pct_equity": "2.0",
            "params": {
                "min_session_open_selloff_bps": "28",
                "max_price_vs_session_low_bps": "36",
                "min_recent_microprice_bias_bps": "0.15",
                "min_cross_section_reversal_rank": "0.75",
            },
        },
        {
            "universe_symbols": list(_REVERSAL_UNIVERSE_PROFILES[2]),
            "max_notional_per_trade": "63180",
            "max_position_pct_equity": "1.5",
            "params": {
                "min_session_open_selloff_bps": "28",
                "max_price_vs_session_low_bps": "24",
                "min_recent_microprice_bias_bps": "0.10",
                "min_cross_section_reversal_rank": "0.70",
            },
        },
    ),
    "mean_reversion_exhaustion_short_v1": (
        {
            "universe_symbols": list(_AI_ACCELERATOR_UNIVERSE_PROFILE),
            "max_position_pct_equity": "1.0",
            "max_notional_per_trade": "30000",
            "params": {
                "min_price_above_vwap_bps": "8",
                "max_price_above_vwap_bps": "70",
                "min_price_above_ema12_bps": "2",
                "max_price_above_ema12_bps": "35",
                "min_bear_rsi": "52",
                "max_bear_rsi": "64",
                "min_macd_hist": "-0.010",
                "max_macd_hist": "0.012",
                "min_price_vs_session_open_bps": "20",
                "min_opening_window_return_bps": "5",
                "min_session_range_position": "0.68",
                "min_session_range_bps": "30",
                "min_price_vs_opening_range_high_bps": "-8",
                "max_price_vs_opening_range_high_bps": "12",
                "max_spread_bps": "8",
                "max_recent_spread_bps": "8",
                "max_recent_spread_bps_max": "16",
                "max_recent_quote_invalid_ratio": "0.18",
                "max_recent_quote_jump_bps": "55",
                "max_imbalance_pressure": "-0.02",
                "max_recent_imbalance_pressure": "-0.02",
                "max_recent_microprice_bias_bps": "-0.10",
                "max_cross_section_continuation_rank": "0.45",
                "min_cross_section_reversal_rank": "0.65",
                "rank_feature": "cross_section_reversal_rank",
                "selection_mode": "reversal",
                "top_n": "1",
                "universe_size": "3",
                "entry_start_minute_utc": "840",
                "entry_end_minute_utc": "1080",
                "max_entries_per_session": "1",
                "max_concurrent_positions": "1",
                "entry_cooldown_seconds": "900",
                "short_stop_loss_bps": "10",
                "max_hold_seconds": "900",
                "session_flatten_start_minute_utc": "1165",
            },
        },
        {
            "universe_symbols": list(_LIQUID_TECH_PLATFORM_UNIVERSE_PROFILE),
            "max_position_pct_equity": "1.0",
            "max_notional_per_trade": "30000",
            "params": {
                "min_price_above_vwap_bps": "6",
                "max_price_above_vwap_bps": "60",
                "min_price_above_ema12_bps": "2",
                "max_price_above_ema12_bps": "30",
                "min_bear_rsi": "50",
                "max_bear_rsi": "62",
                "min_macd_hist": "-0.012",
                "max_macd_hist": "0.010",
                "min_price_vs_session_open_bps": "15",
                "min_opening_window_return_bps": "4",
                "min_session_range_position": "0.64",
                "min_session_range_bps": "25",
                "min_price_vs_opening_range_high_bps": "-10",
                "max_price_vs_opening_range_high_bps": "14",
                "max_spread_bps": "8",
                "max_recent_spread_bps": "8",
                "max_recent_spread_bps_max": "16",
                "max_recent_quote_invalid_ratio": "0.20",
                "max_recent_quote_jump_bps": "55",
                "max_imbalance_pressure": "-0.01",
                "max_recent_imbalance_pressure": "-0.01",
                "max_recent_microprice_bias_bps": "0.00",
                "max_cross_section_continuation_rank": "0.50",
                "min_cross_section_reversal_rank": "0.60",
                "rank_feature": "cross_section_range_position_rank",
                "selection_mode": "reversal",
                "top_n": "1",
                "universe_size": "5",
                "entry_start_minute_utc": "855",
                "entry_end_minute_utc": "1110",
                "max_entries_per_session": "1",
                "max_concurrent_positions": "1",
                "entry_cooldown_seconds": "1200",
                "short_stop_loss_bps": "8",
                "max_hold_seconds": "1200",
                "session_flatten_start_minute_utc": "1165",
            },
        },
        {
            "universe_symbols": list(_PORTFOLIO_COVERAGE_UNIVERSE_PROFILE),
            "max_position_pct_equity": "1.0",
            "max_notional_per_trade": "30000",
            "params": {
                "min_price_above_vwap_bps": "10",
                "max_price_above_vwap_bps": "80",
                "min_price_above_ema12_bps": "3",
                "max_price_above_ema12_bps": "40",
                "min_bear_rsi": "54",
                "max_bear_rsi": "66",
                "min_macd_hist": "-0.008",
                "max_macd_hist": "0.014",
                "min_price_vs_session_open_bps": "25",
                "min_opening_window_return_bps": "8",
                "min_session_range_position": "0.72",
                "min_session_range_bps": "30",
                "min_price_vs_opening_range_high_bps": "-6",
                "max_price_vs_opening_range_high_bps": "10",
                "max_spread_bps": "8",
                "max_recent_spread_bps": "8",
                "max_recent_spread_bps_max": "16",
                "max_recent_quote_invalid_ratio": "0.18",
                "max_recent_quote_jump_bps": "45",
                "max_imbalance_pressure": "-0.03",
                "max_recent_imbalance_pressure": "-0.03",
                "max_recent_microprice_bias_bps": "-0.15",
                "max_cross_section_continuation_rank": "0.42",
                "min_cross_section_reversal_rank": "0.70",
                "rank_feature": "cross_section_recent_imbalance_rank",
                "selection_mode": "reversal",
                "top_n": "1",
                "universe_size": "8",
                "entry_start_minute_utc": "840",
                "entry_end_minute_utc": "1125",
                "max_entries_per_session": "1",
                "max_concurrent_positions": "1",
                "entry_cooldown_seconds": "1200",
                "short_stop_loss_bps": "8",
                "max_hold_seconds": "900",
                "session_flatten_start_minute_utc": "1165",
            },
        },
    ),
    "momentum_pullback_v1": (
        {
            "universe_symbols": list(_LARGE_CAP_UNIVERSE_PROFILES[2]),
            "max_position_pct_equity": "2.0",
            "max_notional_per_trade": "63180",
            "params": {
                "bullish_hist_min": "0.006",
                "min_bull_rsi": "48",
                "max_bull_rsi": "66",
                "min_price_below_ema12_bps": "1",
                "max_price_below_ema12_bps": "10",
                "max_spread_bps": "6",
                "min_imbalance_pressure": "-0.05",
                "min_recent_microprice_bias_bps": "-0.05",
                "min_cross_section_continuation_rank": "0.35",
                "entry_start_minute_utc": "870",
                "entry_end_minute_utc": "1020",
                "exit_macd_hist_max": "-0.006",
                "exit_rsi_max": "45",
                "max_hold_seconds": "420",
                "long_stop_loss_bps": "12",
                "long_trailing_stop_activation_profit_bps": "8",
                "long_trailing_stop_drawdown_bps": "4",
            },
        },
        {
            "universe_symbols": list(_LARGE_CAP_UNIVERSE_PROFILES[2]),
            "max_position_pct_equity": "4.0",
            "max_notional_per_trade": "126360",
            "params": {
                "bullish_hist_min": "0.006",
                "min_bull_rsi": "48",
                "max_bull_rsi": "66",
                "min_price_below_ema12_bps": "1",
                "max_price_below_ema12_bps": "10",
                "max_spread_bps": "6",
                "min_imbalance_pressure": "-0.05",
                "min_recent_microprice_bias_bps": "-0.05",
                "min_cross_section_continuation_rank": "0.35",
                "entry_start_minute_utc": "870",
                "entry_end_minute_utc": "1020",
                "exit_macd_hist_max": "-0.003",
                "exit_rsi_max": "49",
                "max_hold_seconds": "720",
                "long_stop_loss_bps": "18",
                "long_trailing_stop_activation_profit_bps": "12",
                "long_trailing_stop_drawdown_bps": "8",
            },
        },
        {
            "universe_symbols": list(_LARGE_CAP_UNIVERSE_PROFILES[2]),
            "max_position_pct_equity": "4.0",
            "max_notional_per_trade": "63180",
            "params": {
                "bullish_hist_min": "0.006",
                "min_bull_rsi": "48",
                "max_bull_rsi": "66",
                "min_price_below_ema12_bps": "1",
                "max_price_below_ema12_bps": "10",
                "max_spread_bps": "6",
                "min_imbalance_pressure": "-0.05",
                "min_recent_microprice_bias_bps": "-0.05",
                "min_cross_section_continuation_rank": "0.35",
                "entry_start_minute_utc": "870",
                "entry_end_minute_utc": "1020",
                "exit_macd_hist_max": "-0.006",
                "exit_rsi_max": "49",
                "max_hold_seconds": "720",
                "long_stop_loss_bps": "12",
                "long_trailing_stop_activation_profit_bps": "12",
                "long_trailing_stop_drawdown_bps": "7",
            },
        },
    ),
    "late_day_continuation_v1": (
        {
            "universe_symbols": list(_LARGE_CAP_UNIVERSE_PROFILES[2]),
            "max_position_pct_equity": "3.0",
            "max_notional_per_trade": "94770",
            "params": {
                "bullish_hist_min": "0.004",
                "bullish_hist_cap": "0.060",
                "min_bull_rsi": "54",
                "max_bull_rsi": "74",
                "vol_floor": "0.00005",
                "vol_ceil": "0.00030",
                "min_price_above_ema12_bps": "-4",
                "max_price_above_ema12_bps": "14",
                "min_price_vs_vwap_w5m_bps": "0",
                "max_price_vs_vwap_w5m_bps": "14",
                "min_session_open_drive_bps": "35",
                "min_opening_window_return_bps": "20",
                "min_session_range_position": "0.62",
                "min_cross_section_continuation_breadth": "0.40",
                "min_cross_section_opening_window_return_rank": "0.65",
                "min_cross_section_continuation_rank": "0.70",
                "min_imbalance_pressure": "-0.01",
                "min_recent_imbalance_pressure": "0.02",
                "min_recent_microprice_bias_bps": "0.00",
                "max_spread_bps": "8",
                "max_recent_spread_bps": "8",
                "max_recent_quote_invalid_ratio": "0.18",
                "max_recent_quote_jump_bps": "55",
                "min_recent_above_opening_window_close_ratio": "0.55",
                "min_recent_above_vwap_w5m_ratio": "0.55",
                "entry_start_minute_utc": "1080",
                "entry_end_minute_utc": "1170",
                "session_flatten_start_minute_utc": "1170",
                "min_entry_minutes_before_flatten": "8",
                "long_stop_loss_bps": "24",
                "long_trailing_stop_activation_profit_bps": "15",
                "long_trailing_stop_drawdown_bps": "8",
                "entry_cooldown_seconds": "1800",
                "max_entries_per_session": "2",
                "max_concurrent_positions": "2",
                "require_positive_price_for_signal_exit": "true",
            },
        },
        {
            "universe_symbols": list(_BREAKOUT_UNIVERSE_PROFILES[0]),
            "max_position_pct_equity": "4.0",
            "max_notional_per_trade": "126360",
            "params": {
                "bullish_hist_min": "0.003",
                "bullish_hist_cap": "0.065",
                "min_bull_rsi": "52",
                "max_bull_rsi": "76",
                "vol_floor": "0.00004",
                "vol_ceil": "0.00035",
                "min_price_above_ema12_bps": "-6",
                "max_price_above_ema12_bps": "18",
                "min_price_vs_vwap_w5m_bps": "-4",
                "max_price_vs_vwap_w5m_bps": "18",
                "min_session_open_drive_bps": "28",
                "min_opening_window_return_bps": "12",
                "min_session_range_position": "0.58",
                "min_cross_section_continuation_breadth": "0.35",
                "min_cross_section_opening_window_return_rank": "0.58",
                "min_cross_section_continuation_rank": "0.62",
                "min_imbalance_pressure": "-0.04",
                "min_recent_imbalance_pressure": "0.00",
                "min_recent_microprice_bias_bps": "-0.20",
                "max_spread_bps": "12",
                "max_recent_spread_bps": "12",
                "max_recent_quote_invalid_ratio": "0.25",
                "max_recent_quote_jump_bps": "80",
                "min_recent_above_opening_window_close_ratio": "0.45",
                "min_recent_above_vwap_w5m_ratio": "0.45",
                "entry_start_minute_utc": "1050",
                "entry_end_minute_utc": "1170",
                "session_flatten_start_minute_utc": "1170",
                "min_entry_minutes_before_flatten": "8",
                "long_stop_loss_bps": "20",
                "long_trailing_stop_activation_profit_bps": "12",
                "long_trailing_stop_drawdown_bps": "6",
                "entry_cooldown_seconds": "600",
                "max_entries_per_session": "3",
                "max_concurrent_positions": "3",
                "require_positive_price_for_signal_exit": "true",
            },
        },
        {
            "universe_symbols": list(_LARGE_CAP_UNIVERSE_PROFILES[2]),
            "max_position_pct_equity": "3.0",
            "max_notional_per_trade": "94770",
            "params": {
                "bullish_hist_min": "0.004",
                "bullish_hist_cap": "0.070",
                "min_bull_rsi": "54",
                "max_bull_rsi": "78",
                "vol_floor": "0.00005",
                "vol_ceil": "0.00040",
                "min_price_above_ema12_bps": "-8",
                "max_price_above_ema12_bps": "22",
                "min_price_vs_vwap_w5m_bps": "-6",
                "max_price_vs_vwap_w5m_bps": "20",
                "min_session_open_drive_bps": "24",
                "min_opening_window_return_bps": "10",
                "min_session_range_position": "0.56",
                "min_cross_section_continuation_breadth": "0.32",
                "min_cross_section_opening_window_return_rank": "0.55",
                "min_cross_section_continuation_rank": "0.60",
                "min_imbalance_pressure": "-0.04",
                "min_recent_imbalance_pressure": "-0.02",
                "min_recent_microprice_bias_bps": "-0.20",
                "max_spread_bps": "12",
                "max_recent_spread_bps": "12",
                "max_recent_quote_invalid_ratio": "0.25",
                "max_recent_quote_jump_bps": "80",
                "min_recent_above_opening_window_close_ratio": "0.45",
                "min_recent_above_vwap_w5m_ratio": "0.45",
                "isolated_same_day_min_session_open_rank": "0.72",
                "isolated_same_day_min_opening_window_return_rank": "0.70",
                "isolated_same_day_min_continuation_rank": "0.72",
                "isolated_same_day_min_microprice_bias_bps": "0.08",
                "entry_start_minute_utc": "1080",
                "entry_end_minute_utc": "1170",
                "session_flatten_start_minute_utc": "1170",
                "min_entry_minutes_before_flatten": "8",
                "long_stop_loss_bps": "24",
                "long_trailing_stop_activation_profit_bps": "12",
                "long_trailing_stop_drawdown_bps": "6",
                "entry_cooldown_seconds": "600",
                "max_entries_per_session": "3",
                "max_concurrent_positions": "3",
                "require_positive_price_for_signal_exit": "true",
            },
        },
    ),
    "end_of_day_reversal_v1": (
        {
            "universe_symbols": list(_BROAD_SEMICONDUCTOR_UNIVERSE_PROFILE),
            "max_position_pct_equity": "4.0",
            "max_notional_per_trade": "126360",
            "params": {
                "min_bull_rsi": "34",
                "max_bull_rsi": "48",
                "min_macd_hist": "-0.012",
                "max_macd_hist": "0.012",
                "max_price_vs_session_open_bps": "-35",
                "max_opening_window_return_bps": "-10",
                "max_cross_section_continuation_rank": "0.35",
                "min_cross_section_reversal_rank": "0.72",
                "entry_start_minute_utc": "1150",
                "entry_end_minute_utc": "1188",
                "max_gross_exposure_pct_equity": "4.0",
                "entry_cooldown_seconds": "3600",
                "min_hold_seconds": "60",
                "max_hold_seconds": "480",
            },
        },
        {
            "universe_symbols": list(_BROAD_SEMICONDUCTOR_UNIVERSE_PROFILE),
            "max_position_pct_equity": "2.0",
            "max_notional_per_trade": "63180",
            "params": {
                "min_bull_rsi": "38",
                "max_bull_rsi": "48",
                "min_macd_hist": "-0.010",
                "max_macd_hist": "0.012",
                "max_price_vs_session_open_bps": "-45",
                "max_opening_window_return_bps": "-15",
                "max_cross_section_continuation_rank": "0.45",
                "min_cross_section_reversal_rank": "0.78",
                "entry_start_minute_utc": "1160",
                "entry_end_minute_utc": "1188",
                "max_gross_exposure_pct_equity": "4.0",
                "entry_cooldown_seconds": "7200",
                "min_hold_seconds": "60",
                "max_hold_seconds": "480",
            },
        },
    ),
}

_BASE_FAMILY_EXECUTION_PROFILES = _FAMILY_EXECUTION_PROFILES

# RED-2400-style rejected-signal labels are most useful when they produce a
# distinct replay surface instead of only attaching stricter validation gates to
# the same weak profiles. These profiles stay on existing runtime features so a
# replay can execute today, while tagging the intent as labeled false-negative
# rescue for downstream feedback/ranking.
_REJECTED_SIGNAL_FALSE_NEGATIVE_RESCUE_EXECUTION_PROFILES: dict[
    str, tuple[dict[str, Any], ...]
] = {
    "microstructure_continuation_matched_filter_v1": (
        {
            "universe_symbols": list(
                _PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE
            ),
            "max_position_pct_equity": "0.8",
            "max_notional_per_trade": "25000",
            "params": {
                "signal_motif": "rejected_signal_false_negative_replay",
                "outcome_label_filter": "profitable_after_costs",
                "veto_relaxation_scope": "labeled_false_negative_only",
                "min_cross_section_continuation_rank": "0.62",
                "min_cross_section_opening_window_return_rank": "0.58",
                "max_gross_exposure_pct_equity": "1.0",
                "entry_notional_max_multiplier": "0.35",
                "max_entries_per_session": "2",
                "entry_cooldown_seconds": "900",
                "leader_reclaim_start_minutes_since_open": "35",
                "leader_reclaim_min_recent_imbalance_pressure": "0.08",
                "leader_reclaim_min_recent_microprice_bias_bps": "0.16",
                "leader_reclaim_min_recent_above_opening_window_close_ratio": "0.58",
                "leader_reclaim_min_recent_above_vwap_w5m_ratio": "0.56",
                "max_session_negative_exit_bps": "2",
                "long_stop_loss_bps": "4",
                "long_trailing_stop_activation_profit_bps": "5",
                "long_trailing_stop_drawdown_bps": "2",
            },
        },
        {
            "universe_symbols": list(_PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE),
            "max_position_pct_equity": "0.8",
            "max_notional_per_trade": "25000",
            "params": {
                "signal_motif": "rejected_signal_false_negative_replay",
                "outcome_label_filter": "profitable_after_costs",
                "veto_relaxation_scope": "labeled_false_negative_only",
                "min_cross_section_continuation_rank": "0.54",
                "min_cross_section_opening_window_return_rank": "0.48",
                "max_gross_exposure_pct_equity": "1.0",
                "entry_notional_max_multiplier": "0.35",
                "max_entries_per_session": "2",
                "entry_cooldown_seconds": "900",
                "leader_reclaim_start_minutes_since_open": "25",
                "leader_reclaim_min_recent_imbalance_pressure": "0.05",
                "leader_reclaim_min_recent_microprice_bias_bps": "0.10",
                "leader_reclaim_min_recent_above_opening_window_close_ratio": "0.52",
                "leader_reclaim_min_recent_above_vwap_w5m_ratio": "0.50",
                "max_session_negative_exit_bps": "2",
                "long_stop_loss_bps": "4",
                "long_trailing_stop_activation_profit_bps": "5",
                "long_trailing_stop_drawdown_bps": "2",
            },
        },
    ),
    "opening_drive_leader_reclaim_v1": (
        {
            "universe_symbols": list(
                _PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE
            ),
            "max_position_pct_equity": "0.8",
            "max_notional_per_trade": "25000",
            "params": {
                "signal_motif": "rejected_signal_opening_drive_rescue",
                "outcome_label_filter": "profitable_after_costs",
                "veto_relaxation_scope": "labeled_false_negative_only",
                "min_cross_section_continuation_rank": "0.60",
                "min_cross_section_opening_window_return_rank": "0.56",
                "max_gross_exposure_pct_equity": "1.0",
                "entry_notional_max_multiplier": "0.35",
                "max_entries_per_session": "2",
                "entry_cooldown_seconds": "900",
                "leader_reclaim_start_minutes_since_open": "20",
                "leader_reclaim_min_recent_imbalance_pressure": "0.07",
                "leader_reclaim_min_recent_microprice_bias_bps": "0.14",
                "leader_reclaim_min_recent_above_opening_window_close_ratio": "0.56",
                "leader_reclaim_min_recent_above_vwap_w5m_ratio": "0.54",
                "max_session_negative_exit_bps": "2",
                "long_stop_loss_bps": "4",
                "long_trailing_stop_activation_profit_bps": "5",
                "long_trailing_stop_drawdown_bps": "2",
            },
        },
    ),
    "microbar_cross_sectional_pairs_v1": (
        {
            "universe_symbols": list(_PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE),
            "normalization_regime": "market_neutral_gross_scaled",
            "max_position_pct_equity": "0.8",
            "max_notional_per_trade": "25000",
            "params": {
                "entry_minute_after_open": "60",
                "exit_minute_after_open": "150",
                "signal_motif": "rejected_signal_false_negative_replay",
                "outcome_label_filter": "profitable_after_costs",
                "veto_relaxation_scope": "labeled_false_negative_only",
                "rank_feature": "cross_section_session_open_rank",
                "selection_mode": "continuation",
                "top_n": "1",
                "min_cross_section_continuation_rank": "0.62",
                "max_pair_legs": "1",
                "max_gross_exposure_pct_equity": "1.0",
                "max_entries_per_session": "2",
                "entry_cooldown_seconds": "900",
                "long_stop_loss_bps": "4",
                "long_trailing_stop_activation_profit_bps": "5",
                "long_trailing_stop_drawdown_bps": "2",
                "max_hold_seconds": "2700",
                "max_session_negative_exit_bps": "2",
                "max_stop_loss_exits_per_session": "1",
                "stop_loss_lockout_seconds": "2400",
            },
        },
    ),
}

# These profiles broaden the portfolio-oracle research surface. They keep
# notional and stop/session-loss controls tight while lowering entry thresholds
# enough to test whether diversified sleeves can cover more trading days.
_PORTFOLIO_ORACLE_COVERAGE_EXECUTION_PROFILES: dict[str, tuple[dict[str, Any], ...]] = {
    "microbar_cross_sectional_pairs_v1": (
        {
            "universe_symbols": list(_PORTFOLIO_COVERAGE_UNIVERSE_PROFILE),
            "normalization_regime": "market_neutral_gross_scaled",
            "max_position_pct_equity": "3.0",
            "max_notional_per_trade": "94770",
            "params": {
                "entry_minute_after_open": "45",
                "exit_minute_after_open": "close",
                "signal_motif": "open_window_continuation",
                "rank_feature": "cross_section_session_open_rank",
                "selection_mode": "continuation",
                "top_n": "3",
                "min_cross_section_continuation_rank": "0.50",
                "max_pair_legs": "4",
                "max_entries_per_session": "4",
                "entry_cooldown_seconds": "300",
                "long_stop_loss_bps": "4",
                "long_trailing_stop_activation_profit_bps": "4",
                "long_trailing_stop_drawdown_bps": "2",
                "max_hold_seconds": "5400",
                "max_session_negative_exit_bps": "3",
                "max_stop_loss_exits_per_session": "1",
                "stop_loss_lockout_seconds": "1200",
            },
        },
        {
            "universe_symbols": list(
                _PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE
            ),
            "normalization_regime": "market_neutral_gross_scaled",
            "max_position_pct_equity": "2.5",
            "max_notional_per_trade": "78975",
            "params": {
                "entry_minute_after_open": "95",
                "exit_minute_after_open": "close",
                "signal_motif": "late_session_continuation",
                "rank_feature": "cross_section_session_open_rank",
                "selection_mode": "continuation",
                "top_n": "2",
                "min_cross_section_continuation_rank": "0.58",
                "max_pair_legs": "3",
                "max_entries_per_session": "3",
                "entry_cooldown_seconds": "600",
                "long_stop_loss_bps": "5",
                "long_trailing_stop_activation_profit_bps": "5",
                "long_trailing_stop_drawdown_bps": "2",
                "max_hold_seconds": "3600",
                "max_session_negative_exit_bps": "3",
                "max_stop_loss_exits_per_session": "1",
                "stop_loss_lockout_seconds": "1800",
            },
        },
        {
            "universe_symbols": list(_PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE),
            "normalization_regime": "market_neutral_gross_scaled",
            "max_position_pct_equity": "2.0",
            "max_notional_per_trade": "63180",
            "params": {
                "entry_minute_after_open": "35",
                "exit_minute_after_open": "close",
                "signal_motif": "open_window_reversal",
                "rank_feature": "cross_section_session_open_rank",
                "selection_mode": "reversal",
                "top_n": "2",
                "min_cross_section_continuation_rank": "0.40",
                "max_pair_legs": "3",
                "max_entries_per_session": "3",
                "entry_cooldown_seconds": "600",
                "long_stop_loss_bps": "4",
                "long_trailing_stop_activation_profit_bps": "5",
                "long_trailing_stop_drawdown_bps": "2",
                "max_hold_seconds": "2700",
                "max_session_negative_exit_bps": "3",
                "max_stop_loss_exits_per_session": "1",
                "stop_loss_lockout_seconds": "1800",
            },
        },
        {
            "universe_symbols": list(_PORTFOLIO_COVERAGE_UNIVERSE_PROFILE),
            "normalization_regime": "market_neutral_gross_scaled",
            "max_position_pct_equity": "2.0",
            "max_notional_per_trade": "63180",
            "params": {
                "entry_minute_after_open": "20",
                "entry_window_minutes": "25",
                "exit_minute_after_open": "150",
                "signal_motif": "overnight_gap_reversal",
                "rank_feature": "cross_section_prev_session_close_rank",
                "selection_mode": "reversal",
                "top_n": "2",
                "gate_feature": "cross_section_positive_opening_window_return_from_prev_close_ratio",
                "gate_min": "0.20",
                "gate_max": "0.80",
                "max_pair_legs": "3",
                "max_entries_per_session": "3",
                "entry_cooldown_seconds": "900",
                "long_stop_loss_bps": "4",
                "long_trailing_stop_activation_profit_bps": "5",
                "long_trailing_stop_drawdown_bps": "2",
                "max_hold_seconds": "2700",
                "max_session_negative_exit_bps": "3",
                "max_stop_loss_exits_per_session": "1",
                "stop_loss_lockout_seconds": "1800",
            },
        },
        {
            "universe_symbols": list(
                _PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE
            ),
            "normalization_regime": "market_neutral_gross_scaled",
            "max_position_pct_equity": "2.0",
            "max_notional_per_trade": "63180",
            "params": {
                "entry_minute_after_open": "35",
                "entry_window_minutes": "25",
                "exit_minute_after_open": "180",
                "signal_motif": "opening_window_prev_close_reversal",
                "rank_feature": "cross_section_opening_window_return_from_prev_close_rank",
                "selection_mode": "reversal",
                "top_n": "2",
                "gate_feature": "cross_section_positive_opening_window_return_from_prev_close_ratio",
                "gate_min": "0.20",
                "gate_max": "0.85",
                "max_pair_legs": "3",
                "max_entries_per_session": "3",
                "entry_cooldown_seconds": "900",
                "long_stop_loss_bps": "5",
                "long_trailing_stop_activation_profit_bps": "5",
                "long_trailing_stop_drawdown_bps": "2",
                "max_hold_seconds": "3000",
                "max_session_negative_exit_bps": "3",
                "max_stop_loss_exits_per_session": "1",
                "stop_loss_lockout_seconds": "1800",
            },
        },
        {
            "universe_symbols": list(_PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE),
            "normalization_regime": "market_neutral_gross_scaled",
            "max_position_pct_equity": "1.75",
            "max_notional_per_trade": "55283",
            "params": {
                "entry_minute_after_open": "120",
                "entry_window_minutes": "30",
                "exit_minute_after_open": "close",
                "signal_motif": "intraday_tug_of_war_reversal",
                "rank_feature": "cross_section_prev_session_close_rank",
                "selection_mode": "reversal",
                "top_n": "2",
                "gate_feature": "cross_section_positive_opening_window_return_from_prev_close_ratio",
                "gate_min": "0.15",
                "gate_max": "0.85",
                "max_pair_legs": "3",
                "max_entries_per_session": "2",
                "entry_cooldown_seconds": "1800",
                "long_stop_loss_bps": "4",
                "long_trailing_stop_activation_profit_bps": "5",
                "long_trailing_stop_drawdown_bps": "2",
                "max_hold_seconds": "3600",
                "max_session_negative_exit_bps": "3",
                "max_stop_loss_exits_per_session": "1",
                "stop_loss_lockout_seconds": "2400",
            },
        },
    ),
    "microstructure_continuation_matched_filter_v1": (
        {
            "universe_symbols": list(_PORTFOLIO_COVERAGE_UNIVERSE_PROFILE),
            "max_position_pct_equity": "3.0",
            "max_notional_per_trade": "94770",
            "params": {
                "min_cross_section_continuation_rank": "0.48",
                "min_cross_section_opening_window_return_rank": "0.40",
                "max_gross_exposure_pct_equity": "5.0",
                "entry_notional_max_multiplier": "0.70",
                "max_entries_per_session": "4",
                "entry_cooldown_seconds": "300",
                "leader_reclaim_start_minutes_since_open": "20",
                "leader_reclaim_min_recent_imbalance_pressure": "0.04",
                "leader_reclaim_min_recent_microprice_bias_bps": "0.08",
                "leader_reclaim_min_recent_above_opening_window_close_ratio": "0.50",
                "leader_reclaim_min_recent_above_vwap_w5m_ratio": "0.50",
                "max_session_negative_exit_bps": "4",
                "long_stop_loss_bps": "6",
                "long_trailing_stop_activation_profit_bps": "5",
                "long_trailing_stop_drawdown_bps": "2",
            },
        },
        {
            "universe_symbols": list(
                _PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE
            ),
            "max_position_pct_equity": "2.5",
            "max_notional_per_trade": "78975",
            "params": {
                "min_cross_section_continuation_rank": "0.58",
                "min_cross_section_opening_window_return_rank": "0.52",
                "max_gross_exposure_pct_equity": "4.0",
                "entry_notional_max_multiplier": "0.60",
                "max_entries_per_session": "3",
                "entry_cooldown_seconds": "600",
                "leader_reclaim_start_minutes_since_open": "40",
                "leader_reclaim_min_recent_imbalance_pressure": "0.06",
                "leader_reclaim_min_recent_microprice_bias_bps": "0.10",
                "leader_reclaim_min_recent_above_opening_window_close_ratio": "0.55",
                "leader_reclaim_min_recent_above_vwap_w5m_ratio": "0.55",
                "max_session_negative_exit_bps": "3",
                "long_stop_loss_bps": "5",
                "long_trailing_stop_activation_profit_bps": "5",
                "long_trailing_stop_drawdown_bps": "2",
            },
        },
        {
            "universe_symbols": list(_PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE),
            "max_position_pct_equity": "2.0",
            "max_notional_per_trade": "63180",
            "params": {
                "signal_motif": "ofi_lob_response_continuation",
                "min_cross_section_continuation_rank": "0.42",
                "min_cross_section_opening_window_return_rank": "0.34",
                "max_gross_exposure_pct_equity": "4.0",
                "entry_notional_max_multiplier": "0.50",
                "max_entries_per_session": "4",
                "entry_cooldown_seconds": "600",
                "leader_reclaim_start_minutes_since_open": "30",
                "leader_reclaim_min_recent_imbalance_pressure": "0.02",
                "leader_reclaim_min_recent_microprice_bias_bps": "0.04",
                "leader_reclaim_min_recent_above_opening_window_close_ratio": "0.48",
                "leader_reclaim_min_recent_above_vwap_w5m_ratio": "0.48",
                "max_session_negative_exit_bps": "3",
                "long_stop_loss_bps": "4",
                "long_trailing_stop_activation_profit_bps": "4",
                "long_trailing_stop_drawdown_bps": "2",
            },
        },
        {
            "universe_symbols": list(_PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE),
            "max_position_pct_equity": "2.0",
            "max_notional_per_trade": "63180",
            "params": {
                "signal_motif": "ofi_lob_response_continuation",
                "min_cross_section_continuation_rank": "0.50",
                "min_cross_section_opening_window_return_rank": "0.40",
                "min_recent_imbalance_pressure": "0.03",
                "min_recent_microprice_bias_bps": "0.08",
                "min_recent_above_opening_window_close_ratio": "0.48",
                "min_recent_above_vwap_w5m_ratio": "0.48",
                "max_gross_exposure_pct_equity": "3.0",
                "entry_notional_max_multiplier": "0.50",
                "max_entries_per_session": "4",
                "entry_cooldown_seconds": "300",
                "max_hold_seconds": "900",
                "max_session_negative_exit_bps": "3",
                "long_stop_loss_bps": "5",
                "long_trailing_stop_activation_profit_bps": "5",
                "long_trailing_stop_drawdown_bps": "2",
            },
        },
    ),
    "opening_drive_leader_reclaim_v1": (
        {
            "universe_symbols": list(_PORTFOLIO_COVERAGE_UNIVERSE_PROFILE),
            "max_position_pct_equity": "3.0",
            "max_notional_per_trade": "94770",
            "params": {
                "min_cross_section_continuation_rank": "0.48",
                "min_cross_section_opening_window_return_rank": "0.44",
                "max_gross_exposure_pct_equity": "4.0",
                "entry_notional_max_multiplier": "0.70",
                "max_entries_per_session": "4",
                "entry_cooldown_seconds": "300",
                "leader_reclaim_start_minutes_since_open": "15",
                "leader_reclaim_min_recent_imbalance_pressure": "0.03",
                "leader_reclaim_min_recent_microprice_bias_bps": "0.06",
                "leader_reclaim_min_recent_above_opening_window_close_ratio": "0.48",
                "leader_reclaim_min_recent_above_vwap_w5m_ratio": "0.46",
                "max_session_negative_exit_bps": "3",
                "long_stop_loss_bps": "5",
                "long_trailing_stop_activation_profit_bps": "4",
                "long_trailing_stop_drawdown_bps": "2",
            },
        },
        {
            "universe_symbols": list(
                _PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE
            ),
            "max_position_pct_equity": "2.5",
            "max_notional_per_trade": "78975",
            "params": {
                "min_cross_section_continuation_rank": "0.56",
                "min_cross_section_opening_window_return_rank": "0.52",
                "max_gross_exposure_pct_equity": "4.0",
                "entry_notional_max_multiplier": "0.60",
                "max_entries_per_session": "3",
                "entry_cooldown_seconds": "600",
                "leader_reclaim_start_minutes_since_open": "25",
                "leader_reclaim_min_recent_imbalance_pressure": "0.05",
                "leader_reclaim_min_recent_microprice_bias_bps": "0.10",
                "leader_reclaim_min_recent_above_opening_window_close_ratio": "0.54",
                "leader_reclaim_min_recent_above_vwap_w5m_ratio": "0.52",
                "max_session_negative_exit_bps": "3",
                "long_stop_loss_bps": "5",
                "long_trailing_stop_activation_profit_bps": "5",
                "long_trailing_stop_drawdown_bps": "2",
            },
        },
        {
            "universe_symbols": list(_PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE),
            "max_position_pct_equity": "2.0",
            "max_notional_per_trade": "63180",
            "params": {
                "signal_motif": "opening_ofi_leader_reclaim_continuation",
                "min_cross_section_continuation_rank": "0.42",
                "min_cross_section_opening_window_return_rank": "0.38",
                "max_gross_exposure_pct_equity": "3.0",
                "entry_notional_max_multiplier": "0.50",
                "max_entries_per_session": "4",
                "entry_cooldown_seconds": "600",
                "leader_reclaim_start_minutes_since_open": "15",
                "leader_reclaim_min_recent_imbalance_pressure": "0.02",
                "leader_reclaim_min_recent_microprice_bias_bps": "0.04",
                "leader_reclaim_min_recent_above_opening_window_close_ratio": "0.46",
                "leader_reclaim_min_recent_above_vwap_w5m_ratio": "0.44",
                "max_session_negative_exit_bps": "3",
                "long_stop_loss_bps": "4",
                "long_trailing_stop_activation_profit_bps": "4",
                "long_trailing_stop_drawdown_bps": "2",
            },
        },
        {
            "universe_symbols": list(_PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE),
            "max_position_pct_equity": "2.0",
            "max_notional_per_trade": "63180",
            "params": {
                "signal_motif": "opening_ofi_leader_reclaim_continuation",
                "min_cross_section_continuation_rank": "0.50",
                "min_cross_section_opening_window_return_rank": "0.40",
                "max_gross_exposure_pct_equity": "3.0",
                "entry_notional_max_multiplier": "0.50",
                "max_entries_per_session": "4",
                "entry_cooldown_seconds": "300",
                "leader_reclaim_start_minutes_since_open": "10",
                "leader_reclaim_min_recent_imbalance_pressure": "0.03",
                "leader_reclaim_min_recent_microprice_bias_bps": "0.06",
                "leader_reclaim_min_recent_above_opening_window_close_ratio": "0.48",
                "leader_reclaim_min_recent_above_vwap_w5m_ratio": "0.46",
                "min_recent_imbalance_pressure": "0.02",
                "min_recent_microprice_bias_bps": "0.05",
                "max_session_negative_exit_bps": "3",
                "long_stop_loss_bps": "5",
                "long_trailing_stop_activation_profit_bps": "5",
                "long_trailing_stop_drawdown_bps": "2",
            },
        },
    ),
    "intraday_tsmom_v2": (
        {
            "universe_symbols": list(_PORTFOLIO_COVERAGE_UNIVERSE_PROFILE),
            "max_notional_per_trade": "94770",
            "max_position_pct_equity": "3.0",
            "params": {
                "long_stop_loss_bps": "6",
                "long_trailing_stop_activation_profit_bps": "5",
                "long_trailing_stop_drawdown_bps": "2",
                "max_session_negative_exit_bps": "4",
                "min_cross_section_continuation_rank": "0.50",
                "max_entries_per_session": "4",
                "entry_cooldown_seconds": "300",
            },
        },
        {
            "universe_symbols": list(
                _PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE
            ),
            "max_notional_per_trade": "78975",
            "max_position_pct_equity": "2.5",
            "params": {
                "long_stop_loss_bps": "5",
                "long_trailing_stop_activation_profit_bps": "5",
                "long_trailing_stop_drawdown_bps": "2",
                "max_session_negative_exit_bps": "3",
                "min_cross_section_continuation_rank": "0.58",
                "max_entries_per_session": "3",
                "entry_cooldown_seconds": "600",
            },
        },
        {
            "universe_symbols": list(_PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE),
            "max_notional_per_trade": "63180",
            "max_position_pct_equity": "2.0",
            "params": {
                "long_stop_loss_bps": "4",
                "long_trailing_stop_activation_profit_bps": "4",
                "long_trailing_stop_drawdown_bps": "2",
                "max_session_negative_exit_bps": "3",
                "min_cross_section_continuation_rank": "0.42",
                "max_entries_per_session": "4",
                "entry_cooldown_seconds": "600",
            },
        },
    ),
    "mean_reversion_rebound_v1": (
        {
            "universe_symbols": list(_PORTFOLIO_COVERAGE_UNIVERSE_PROFILE),
            "max_position_pct_equity": "3.0",
            "max_notional_per_trade": "94770",
            "params": {
                "min_bull_rsi": "36",
                "max_bull_rsi": "52",
                "min_price_below_vwap_bps": "6",
                "max_price_below_vwap_bps": "65",
                "max_price_vs_session_open_bps": "-12",
                "max_opening_window_return_bps": "0",
                "max_cross_section_continuation_rank": "0.58",
                "min_cross_section_reversal_rank": "0.58",
                "min_recent_imbalance_pressure": "0.00",
                "entry_start_minute_utc": "810",
                "entry_end_minute_utc": "1140",
                "max_gross_exposure_pct_equity": "4.0",
                "entry_cooldown_seconds": "450",
                "long_stop_loss_bps": "8",
                "long_trailing_stop_activation_profit_bps": "6",
                "long_trailing_stop_drawdown_bps": "3",
                "max_session_negative_exit_bps": "5",
                "max_hold_seconds": "3600",
            },
        },
        {
            "universe_symbols": list(
                _PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE
            ),
            "max_position_pct_equity": "2.5",
            "max_notional_per_trade": "78975",
            "params": {
                "min_bull_rsi": "34",
                "max_bull_rsi": "50",
                "min_price_below_vwap_bps": "8",
                "max_price_below_vwap_bps": "80",
                "max_price_vs_session_open_bps": "-16",
                "max_opening_window_return_bps": "-2",
                "max_cross_section_continuation_rank": "0.52",
                "min_cross_section_reversal_rank": "0.62",
                "min_recent_imbalance_pressure": "-0.02",
                "entry_start_minute_utc": "825",
                "entry_end_minute_utc": "1110",
                "max_gross_exposure_pct_equity": "3.5",
                "entry_cooldown_seconds": "900",
                "long_stop_loss_bps": "7",
                "long_trailing_stop_activation_profit_bps": "6",
                "long_trailing_stop_drawdown_bps": "3",
                "max_session_negative_exit_bps": "4",
                "max_hold_seconds": "3000",
            },
        },
        {
            "universe_symbols": list(_PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE),
            "max_position_pct_equity": "2.0",
            "max_notional_per_trade": "63180",
            "params": {
                "min_bull_rsi": "38",
                "max_bull_rsi": "54",
                "min_price_below_vwap_bps": "4",
                "max_price_below_vwap_bps": "50",
                "max_price_vs_session_open_bps": "-8",
                "max_opening_window_return_bps": "4",
                "max_cross_section_continuation_rank": "0.62",
                "min_cross_section_reversal_rank": "0.52",
                "min_recent_imbalance_pressure": "-0.04",
                "entry_start_minute_utc": "810",
                "entry_end_minute_utc": "1080",
                "max_gross_exposure_pct_equity": "3.0",
                "entry_cooldown_seconds": "900",
                "long_stop_loss_bps": "6",
                "long_trailing_stop_activation_profit_bps": "5",
                "long_trailing_stop_drawdown_bps": "2",
                "max_session_negative_exit_bps": "3",
                "max_hold_seconds": "2400",
            },
        },
        {
            "universe_symbols": list(_PORTFOLIO_COVERAGE_UNIVERSE_PROFILE),
            "max_position_pct_equity": "2.0",
            "max_notional_per_trade": "63180",
            "params": {
                "drive_reference_basis": "prev_close",
                "opening_window_reference_basis": "prev_close",
                "opening_window_rank_reference_basis": "prev_close",
                "min_bull_rsi": "34",
                "max_bull_rsi": "54",
                "min_price_below_vwap_bps": "4",
                "max_price_below_vwap_bps": "72",
                "max_price_vs_session_open_bps": "-18",
                "max_opening_window_return_bps": "-4",
                "max_cross_section_continuation_rank": "0.50",
                "min_cross_section_reversal_rank": "0.60",
                "min_recent_imbalance_pressure": "-0.03",
                "entry_start_minute_utc": "840",
                "entry_end_minute_utc": "1020",
                "max_gross_exposure_pct_equity": "3.0",
                "entry_cooldown_seconds": "1200",
                "long_stop_loss_bps": "6",
                "long_trailing_stop_activation_profit_bps": "6",
                "long_trailing_stop_drawdown_bps": "2",
                "max_session_negative_exit_bps": "3",
                "max_hold_seconds": "2700",
            },
        },
        {
            "universe_symbols": list(
                _PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE
            ),
            "max_position_pct_equity": "1.75",
            "max_notional_per_trade": "55283",
            "params": {
                "drive_reference_basis": "prev_close",
                "opening_window_reference_basis": "prev_close",
                "opening_window_rank_reference_basis": "prev_close",
                "min_bull_rsi": "32",
                "max_bull_rsi": "50",
                "min_price_below_vwap_bps": "8",
                "max_price_below_vwap_bps": "90",
                "max_price_vs_session_open_bps": "-24",
                "max_opening_window_return_bps": "-8",
                "max_cross_section_continuation_rank": "0.45",
                "min_cross_section_reversal_rank": "0.66",
                "min_recent_imbalance_pressure": "-0.04",
                "entry_start_minute_utc": "855",
                "entry_end_minute_utc": "1050",
                "max_gross_exposure_pct_equity": "2.75",
                "entry_cooldown_seconds": "1800",
                "long_stop_loss_bps": "6",
                "long_trailing_stop_activation_profit_bps": "6",
                "long_trailing_stop_drawdown_bps": "2",
                "max_session_negative_exit_bps": "3",
                "max_hold_seconds": "2400",
            },
        },
        {
            "universe_symbols": list(_PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE),
            "max_position_pct_equity": "1.5",
            "max_notional_per_trade": "47385",
            "params": {
                "drive_reference_basis": "prev_close",
                "opening_window_reference_basis": "prev_close",
                "opening_window_rank_reference_basis": "prev_close",
                "min_bull_rsi": "38",
                "max_bull_rsi": "56",
                "min_price_below_vwap_bps": "3",
                "max_price_below_vwap_bps": "55",
                "max_price_vs_session_open_bps": "-12",
                "max_opening_window_return_bps": "0",
                "max_cross_section_continuation_rank": "0.55",
                "min_cross_section_reversal_rank": "0.55",
                "min_recent_imbalance_pressure": "-0.05",
                "entry_start_minute_utc": "870",
                "entry_end_minute_utc": "1080",
                "max_gross_exposure_pct_equity": "2.5",
                "entry_cooldown_seconds": "1800",
                "long_stop_loss_bps": "5",
                "long_trailing_stop_activation_profit_bps": "5",
                "long_trailing_stop_drawdown_bps": "2",
                "max_session_negative_exit_bps": "3",
                "max_hold_seconds": "2400",
            },
        },
    ),
    "breakout_reclaim_v2": (
        {
            "universe_symbols": list(_PORTFOLIO_COVERAGE_UNIVERSE_PROFILE),
            "max_position_pct_equity": "4.0",
            "max_notional_per_trade": "126360",
            "params": {
                "min_cross_section_continuation_rank": "0.50",
                "min_cross_section_opening_window_return_rank": "0.45",
                "max_gross_exposure_pct_equity": "6.0",
                "entry_notional_max_multiplier": "0.80",
                "max_entries_per_session": "4",
                "entry_cooldown_seconds": "300",
                "max_session_negative_exit_bps": "5",
                "leader_reclaim_start_minutes_since_open": "25",
                "leader_reclaim_min_recent_imbalance_pressure": "0.05",
                "leader_reclaim_min_recent_microprice_bias_bps": "0.12",
                "leader_reclaim_min_recent_above_opening_window_close_ratio": "0.54",
                "leader_reclaim_min_recent_above_vwap_w5m_ratio": "0.52",
                "long_stop_loss_bps": "6",
                "long_trailing_stop_activation_profit_bps": "6",
                "long_trailing_stop_drawdown_bps": "2",
            },
        },
        {
            "universe_symbols": list(
                _PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE
            ),
            "max_position_pct_equity": "2.5",
            "max_notional_per_trade": "78975",
            "params": {
                "min_cross_section_continuation_rank": "0.62",
                "min_cross_section_opening_window_return_rank": "0.58",
                "max_gross_exposure_pct_equity": "4.0",
                "entry_notional_max_multiplier": "0.60",
                "max_entries_per_session": "3",
                "entry_cooldown_seconds": "600",
                "max_session_negative_exit_bps": "3",
                "leader_reclaim_start_minutes_since_open": "40",
                "leader_reclaim_min_recent_imbalance_pressure": "0.08",
                "leader_reclaim_min_recent_microprice_bias_bps": "0.14",
                "leader_reclaim_min_recent_above_opening_window_close_ratio": "0.58",
                "leader_reclaim_min_recent_above_vwap_w5m_ratio": "0.56",
                "long_stop_loss_bps": "5",
                "long_trailing_stop_activation_profit_bps": "5",
                "long_trailing_stop_drawdown_bps": "2",
            },
        },
        {
            "universe_symbols": list(_PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE),
            "max_position_pct_equity": "2.0",
            "max_notional_per_trade": "63180",
            "params": {
                "min_cross_section_continuation_rank": "0.42",
                "min_cross_section_opening_window_return_rank": "0.36",
                "max_gross_exposure_pct_equity": "3.5",
                "entry_notional_max_multiplier": "0.50",
                "max_entries_per_session": "4",
                "entry_cooldown_seconds": "600",
                "max_session_negative_exit_bps": "3",
                "leader_reclaim_start_minutes_since_open": "30",
                "leader_reclaim_min_recent_imbalance_pressure": "0.02",
                "leader_reclaim_min_recent_microprice_bias_bps": "0.04",
                "leader_reclaim_min_recent_above_opening_window_close_ratio": "0.48",
                "leader_reclaim_min_recent_above_vwap_w5m_ratio": "0.48",
                "long_stop_loss_bps": "4",
                "long_trailing_stop_activation_profit_bps": "4",
                "long_trailing_stop_drawdown_bps": "2",
            },
        },
    ),
    "washout_rebound_v2": (
        {
            "universe_symbols": list(_PORTFOLIO_COVERAGE_UNIVERSE_PROFILE),
            "max_notional_per_trade": "94770",
            "max_position_pct_equity": "3.0",
            "params": {
                "min_session_open_selloff_bps": "12",
                "max_price_vs_session_low_bps": "48",
                "min_recent_microprice_bias_bps": "0.00",
                "min_cross_section_reversal_rank": "0.55",
            },
        },
        {
            "universe_symbols": list(
                _PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE
            ),
            "max_notional_per_trade": "78975",
            "max_position_pct_equity": "2.5",
            "params": {
                "min_session_open_selloff_bps": "18",
                "max_price_vs_session_low_bps": "55",
                "min_recent_microprice_bias_bps": "0.02",
                "min_cross_section_reversal_rank": "0.62",
            },
        },
        {
            "universe_symbols": list(_PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE),
            "max_notional_per_trade": "63180",
            "max_position_pct_equity": "2.0",
            "params": {
                "min_session_open_selloff_bps": "8",
                "max_price_vs_session_low_bps": "40",
                "min_recent_microprice_bias_bps": "-0.02",
                "min_cross_section_reversal_rank": "0.50",
            },
        },
    ),
    "mean_reversion_exhaustion_short_v1": (
        {
            "universe_symbols": list(_PORTFOLIO_COVERAGE_UNIVERSE_PROFILE),
            "max_position_pct_equity": "1.0",
            "max_notional_per_trade": "30000",
            "params": {
                "min_price_above_vwap_bps": "6",
                "max_price_above_vwap_bps": "75",
                "min_price_above_ema12_bps": "2",
                "max_price_above_ema12_bps": "38",
                "min_bear_rsi": "50",
                "max_bear_rsi": "66",
                "min_macd_hist": "-0.012",
                "max_macd_hist": "0.014",
                "min_price_vs_session_open_bps": "15",
                "min_opening_window_return_bps": "4",
                "min_session_range_position": "0.64",
                "min_session_range_bps": "25",
                "min_price_vs_opening_range_high_bps": "-10",
                "max_price_vs_opening_range_high_bps": "14",
                "max_spread_bps": "8",
                "max_recent_spread_bps": "8",
                "max_recent_spread_bps_max": "16",
                "max_recent_quote_invalid_ratio": "0.20",
                "max_recent_quote_jump_bps": "55",
                "max_imbalance_pressure": "-0.01",
                "max_recent_imbalance_pressure": "-0.01",
                "max_recent_microprice_bias_bps": "0.00",
                "max_cross_section_continuation_rank": "0.50",
                "min_cross_section_reversal_rank": "0.60",
                "rank_feature": "cross_section_reversal_rank",
                "selection_mode": "reversal",
                "top_n": "1",
                "universe_size": "8",
                "entry_start_minute_utc": "840",
                "entry_end_minute_utc": "1125",
                "max_entries_per_session": "1",
                "max_concurrent_positions": "1",
                "entry_cooldown_seconds": "1200",
                "short_stop_loss_bps": "8",
                "max_hold_seconds": "900",
                "session_flatten_start_minute_utc": "1165",
            },
        },
        {
            "universe_symbols": list(
                _PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE
            ),
            "max_position_pct_equity": "1.0",
            "max_notional_per_trade": "30000",
            "params": {
                "min_price_above_vwap_bps": "8",
                "max_price_above_vwap_bps": "70",
                "min_price_above_ema12_bps": "2",
                "max_price_above_ema12_bps": "35",
                "min_bear_rsi": "52",
                "max_bear_rsi": "64",
                "min_price_vs_session_open_bps": "20",
                "min_opening_window_return_bps": "5",
                "min_session_range_position": "0.68",
                "min_session_range_bps": "30",
                "min_price_vs_opening_range_high_bps": "-8",
                "max_price_vs_opening_range_high_bps": "12",
                "max_spread_bps": "8",
                "max_recent_spread_bps": "8",
                "max_recent_quote_invalid_ratio": "0.18",
                "max_imbalance_pressure": "-0.02",
                "max_recent_imbalance_pressure": "-0.02",
                "max_recent_microprice_bias_bps": "-0.10",
                "max_cross_section_continuation_rank": "0.45",
                "min_cross_section_reversal_rank": "0.65",
                "rank_feature": "cross_section_recent_imbalance_rank",
                "selection_mode": "reversal",
                "top_n": "1",
                "universe_size": "3",
                "entry_start_minute_utc": "840",
                "entry_end_minute_utc": "1080",
                "max_entries_per_session": "1",
                "max_concurrent_positions": "1",
                "entry_cooldown_seconds": "900",
                "short_stop_loss_bps": "8",
                "max_hold_seconds": "900",
                "session_flatten_start_minute_utc": "1165",
            },
        },
        {
            "universe_symbols": list(_PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE),
            "max_position_pct_equity": "1.0",
            "max_notional_per_trade": "30000",
            "params": {
                "min_price_above_vwap_bps": "5",
                "max_price_above_vwap_bps": "60",
                "min_price_above_ema12_bps": "1",
                "max_price_above_ema12_bps": "30",
                "min_bear_rsi": "50",
                "max_bear_rsi": "62",
                "min_price_vs_session_open_bps": "12",
                "min_opening_window_return_bps": "3",
                "min_session_range_position": "0.62",
                "min_session_range_bps": "25",
                "min_price_vs_opening_range_high_bps": "-12",
                "max_price_vs_opening_range_high_bps": "15",
                "max_spread_bps": "8",
                "max_recent_spread_bps": "8",
                "max_recent_quote_invalid_ratio": "0.22",
                "max_imbalance_pressure": "0.00",
                "max_recent_imbalance_pressure": "0.00",
                "max_recent_microprice_bias_bps": "0.00",
                "max_cross_section_continuation_rank": "0.55",
                "min_cross_section_reversal_rank": "0.55",
                "rank_feature": "cross_section_range_position_rank",
                "selection_mode": "reversal",
                "top_n": "1",
                "universe_size": "5",
                "entry_start_minute_utc": "855",
                "entry_end_minute_utc": "1110",
                "max_entries_per_session": "1",
                "max_concurrent_positions": "1",
                "entry_cooldown_seconds": "1200",
                "short_stop_loss_bps": "8",
                "max_hold_seconds": "1200",
                "session_flatten_start_minute_utc": "1165",
            },
        },
    ),
    "momentum_pullback_v1": (
        {
            "universe_symbols": list(_PORTFOLIO_COVERAGE_UNIVERSE_PROFILE),
            "max_position_pct_equity": "3.0",
            "max_notional_per_trade": "94770",
            "params": {
                "bullish_hist_min": "0.002",
                "min_bull_rsi": "46",
                "max_bull_rsi": "70",
                "min_price_below_ema12_bps": "-2",
                "max_price_below_ema12_bps": "16",
                "max_spread_bps": "8",
                "min_imbalance_pressure": "-0.08",
                "min_recent_microprice_bias_bps": "-0.10",
                "min_cross_section_continuation_rank": "0.30",
                "entry_start_minute_utc": "840",
                "entry_end_minute_utc": "1110",
                "exit_macd_hist_max": "-0.002",
                "exit_rsi_max": "52",
                "max_hold_seconds": "1200",
                "long_stop_loss_bps": "8",
                "long_trailing_stop_activation_profit_bps": "6",
                "long_trailing_stop_drawdown_bps": "3",
                "max_session_negative_exit_bps": "5",
            },
        },
        {
            "universe_symbols": list(
                _PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE
            ),
            "max_position_pct_equity": "2.5",
            "max_notional_per_trade": "78975",
            "params": {
                "bullish_hist_min": "0.004",
                "min_bull_rsi": "48",
                "max_bull_rsi": "68",
                "min_price_below_ema12_bps": "-4",
                "max_price_below_ema12_bps": "18",
                "max_spread_bps": "8",
                "min_imbalance_pressure": "-0.04",
                "min_recent_microprice_bias_bps": "-0.08",
                "min_cross_section_continuation_rank": "0.42",
                "entry_start_minute_utc": "840",
                "entry_end_minute_utc": "1080",
                "exit_macd_hist_max": "-0.001",
                "exit_rsi_max": "54",
                "max_hold_seconds": "1500",
                "long_stop_loss_bps": "7",
                "long_trailing_stop_activation_profit_bps": "6",
                "long_trailing_stop_drawdown_bps": "3",
                "max_session_negative_exit_bps": "4",
            },
        },
        {
            "universe_symbols": list(_PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE),
            "max_position_pct_equity": "2.0",
            "max_notional_per_trade": "63180",
            "params": {
                "bullish_hist_min": "0.001",
                "min_bull_rsi": "44",
                "max_bull_rsi": "66",
                "min_price_below_ema12_bps": "-8",
                "max_price_below_ema12_bps": "14",
                "max_spread_bps": "8",
                "min_imbalance_pressure": "-0.10",
                "min_recent_microprice_bias_bps": "-0.12",
                "min_cross_section_continuation_rank": "0.24",
                "entry_start_minute_utc": "810",
                "entry_end_minute_utc": "1050",
                "exit_macd_hist_max": "-0.003",
                "exit_rsi_max": "52",
                "max_hold_seconds": "1200",
                "long_stop_loss_bps": "6",
                "long_trailing_stop_activation_profit_bps": "5",
                "long_trailing_stop_drawdown_bps": "2",
                "max_session_negative_exit_bps": "3",
            },
        },
    ),
    "late_day_continuation_v1": (
        {
            "universe_symbols": list(_PORTFOLIO_COVERAGE_UNIVERSE_PROFILE),
            "max_position_pct_equity": "3.0",
            "max_notional_per_trade": "94770",
            "params": {
                "bullish_hist_min": "0.002",
                "bullish_hist_cap": "0.075",
                "min_bull_rsi": "50",
                "max_bull_rsi": "78",
                "vol_floor": "0.00003",
                "vol_ceil": "0.00045",
                "min_price_above_ema12_bps": "-10",
                "max_price_above_ema12_bps": "24",
                "min_price_vs_vwap_w5m_bps": "-8",
                "max_price_vs_vwap_w5m_bps": "24",
                "min_session_open_drive_bps": "16",
                "min_opening_window_return_bps": "6",
                "min_session_range_position": "0.52",
                "min_cross_section_continuation_breadth": "0.28",
                "min_cross_section_opening_window_return_rank": "0.48",
                "min_cross_section_continuation_rank": "0.52",
                "min_imbalance_pressure": "-0.06",
                "min_recent_imbalance_pressure": "-0.04",
                "min_recent_microprice_bias_bps": "-0.25",
                "max_spread_bps": "12",
                "max_recent_spread_bps": "12",
                "max_recent_quote_invalid_ratio": "0.25",
                "max_recent_quote_jump_bps": "80",
                "min_recent_above_opening_window_close_ratio": "0.42",
                "min_recent_above_vwap_w5m_ratio": "0.42",
                "entry_start_minute_utc": "1020",
                "entry_end_minute_utc": "1170",
                "session_flatten_start_minute_utc": "1170",
                "min_entry_minutes_before_flatten": "8",
                "long_stop_loss_bps": "12",
                "long_trailing_stop_activation_profit_bps": "8",
                "long_trailing_stop_drawdown_bps": "4",
                "entry_cooldown_seconds": "450",
                "max_entries_per_session": "4",
                "max_concurrent_positions": "4",
                "require_positive_price_for_signal_exit": "true",
            },
        },
        {
            "universe_symbols": list(
                _PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE
            ),
            "max_position_pct_equity": "2.5",
            "max_notional_per_trade": "78975",
            "params": {
                "bullish_hist_min": "0.004",
                "bullish_hist_cap": "0.070",
                "min_bull_rsi": "52",
                "max_bull_rsi": "76",
                "vol_floor": "0.00003",
                "vol_ceil": "0.00042",
                "min_price_above_ema12_bps": "-6",
                "max_price_above_ema12_bps": "22",
                "min_price_vs_vwap_w5m_bps": "-4",
                "max_price_vs_vwap_w5m_bps": "22",
                "min_session_open_drive_bps": "20",
                "min_opening_window_return_bps": "8",
                "min_session_range_position": "0.56",
                "min_cross_section_continuation_breadth": "0.34",
                "min_cross_section_opening_window_return_rank": "0.56",
                "min_cross_section_continuation_rank": "0.60",
                "min_imbalance_pressure": "-0.03",
                "min_recent_imbalance_pressure": "-0.02",
                "min_recent_microprice_bias_bps": "-0.18",
                "max_spread_bps": "10",
                "max_recent_spread_bps": "10",
                "max_recent_quote_invalid_ratio": "0.20",
                "max_recent_quote_jump_bps": "70",
                "min_recent_above_opening_window_close_ratio": "0.48",
                "min_recent_above_vwap_w5m_ratio": "0.48",
                "entry_start_minute_utc": "990",
                "entry_end_minute_utc": "1140",
                "session_flatten_start_minute_utc": "1170",
                "min_entry_minutes_before_flatten": "10",
                "long_stop_loss_bps": "10",
                "long_trailing_stop_activation_profit_bps": "8",
                "long_trailing_stop_drawdown_bps": "4",
                "entry_cooldown_seconds": "600",
                "max_entries_per_session": "3",
                "max_concurrent_positions": "3",
                "require_positive_price_for_signal_exit": "true",
            },
        },
        {
            "universe_symbols": list(_PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE),
            "max_position_pct_equity": "2.0",
            "max_notional_per_trade": "63180",
            "params": {
                "bullish_hist_min": "0.001",
                "bullish_hist_cap": "0.060",
                "min_bull_rsi": "48",
                "max_bull_rsi": "74",
                "vol_floor": "0.00002",
                "vol_ceil": "0.00040",
                "min_price_above_ema12_bps": "-12",
                "max_price_above_ema12_bps": "18",
                "min_price_vs_vwap_w5m_bps": "-10",
                "max_price_vs_vwap_w5m_bps": "18",
                "min_session_open_drive_bps": "10",
                "min_opening_window_return_bps": "2",
                "min_session_range_position": "0.50",
                "min_cross_section_continuation_breadth": "0.24",
                "min_cross_section_opening_window_return_rank": "0.42",
                "min_cross_section_continuation_rank": "0.44",
                "min_imbalance_pressure": "-0.08",
                "min_recent_imbalance_pressure": "-0.06",
                "min_recent_microprice_bias_bps": "-0.25",
                "max_spread_bps": "10",
                "max_recent_spread_bps": "10",
                "max_recent_quote_invalid_ratio": "0.20",
                "max_recent_quote_jump_bps": "70",
                "min_recent_above_opening_window_close_ratio": "0.40",
                "min_recent_above_vwap_w5m_ratio": "0.40",
                "entry_start_minute_utc": "1050",
                "entry_end_minute_utc": "1160",
                "session_flatten_start_minute_utc": "1170",
                "min_entry_minutes_before_flatten": "10",
                "long_stop_loss_bps": "8",
                "long_trailing_stop_activation_profit_bps": "6",
                "long_trailing_stop_drawdown_bps": "3",
                "entry_cooldown_seconds": "600",
                "max_entries_per_session": "3",
                "max_concurrent_positions": "3",
                "require_positive_price_for_signal_exit": "true",
            },
        },
    ),
    "end_of_day_reversal_v1": (
        {
            "universe_symbols": list(_PORTFOLIO_COVERAGE_UNIVERSE_PROFILE),
            "max_position_pct_equity": "3.0",
            "max_notional_per_trade": "94770",
            "params": {
                "min_bull_rsi": "32",
                "max_bull_rsi": "52",
                "min_macd_hist": "-0.014",
                "max_macd_hist": "0.014",
                "max_price_vs_session_open_bps": "-18",
                "max_opening_window_return_bps": "0",
                "max_cross_section_continuation_rank": "0.55",
                "min_cross_section_reversal_rank": "0.55",
                "entry_start_minute_utc": "1120",
                "entry_end_minute_utc": "1188",
                "max_gross_exposure_pct_equity": "4.0",
                "entry_cooldown_seconds": "1800",
                "min_hold_seconds": "60",
                "max_hold_seconds": "600",
            },
        },
        {
            "universe_symbols": list(
                _PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE
            ),
            "max_position_pct_equity": "2.5",
            "max_notional_per_trade": "78975",
            "params": {
                "min_bull_rsi": "30",
                "max_bull_rsi": "50",
                "min_macd_hist": "-0.016",
                "max_macd_hist": "0.012",
                "max_price_vs_session_open_bps": "-24",
                "max_opening_window_return_bps": "-4",
                "max_cross_section_continuation_rank": "0.50",
                "min_cross_section_reversal_rank": "0.62",
                "entry_start_minute_utc": "1110",
                "entry_end_minute_utc": "1188",
                "max_gross_exposure_pct_equity": "3.5",
                "entry_cooldown_seconds": "2400",
                "min_hold_seconds": "60",
                "max_hold_seconds": "600",
            },
        },
        {
            "universe_symbols": list(_PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE),
            "max_position_pct_equity": "2.0",
            "max_notional_per_trade": "63180",
            "params": {
                "min_bull_rsi": "36",
                "max_bull_rsi": "54",
                "min_macd_hist": "-0.010",
                "max_macd_hist": "0.014",
                "max_price_vs_session_open_bps": "-12",
                "max_opening_window_return_bps": "4",
                "max_cross_section_continuation_rank": "0.60",
                "min_cross_section_reversal_rank": "0.50",
                "entry_start_minute_utc": "1130",
                "entry_end_minute_utc": "1188",
                "max_gross_exposure_pct_equity": "3.0",
                "entry_cooldown_seconds": "2400",
                "min_hold_seconds": "60",
                "max_hold_seconds": "480",
            },
        },
        {
            "universe_symbols": list(_PORTFOLIO_COVERAGE_UNIVERSE_PROFILE),
            "max_position_pct_equity": "2.0",
            "max_notional_per_trade": "63180",
            "params": {
                "drive_reference_basis": "prev_close",
                "opening_window_reference_basis": "prev_close",
                "opening_window_rank_reference_basis": "prev_close",
                "min_bull_rsi": "32",
                "max_bull_rsi": "52",
                "min_macd_hist": "-0.018",
                "max_macd_hist": "0.012",
                "max_price_vs_session_open_bps": "-22",
                "max_opening_window_return_bps": "-6",
                "max_cross_section_continuation_rank": "0.50",
                "min_cross_section_reversal_rank": "0.62",
                "entry_start_minute_utc": "1080",
                "entry_end_minute_utc": "1185",
                "max_gross_exposure_pct_equity": "3.0",
                "entry_cooldown_seconds": "2400",
                "min_hold_seconds": "60",
                "max_hold_seconds": "600",
                "long_stop_loss_bps": "5",
                "long_trailing_stop_activation_profit_bps": "5",
                "long_trailing_stop_drawdown_bps": "2",
                "max_session_negative_exit_bps": "3",
            },
        },
        {
            "universe_symbols": list(
                _PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE
            ),
            "max_position_pct_equity": "1.75",
            "max_notional_per_trade": "55283",
            "params": {
                "drive_reference_basis": "prev_close",
                "opening_window_reference_basis": "prev_close",
                "opening_window_rank_reference_basis": "prev_close",
                "min_bull_rsi": "30",
                "max_bull_rsi": "50",
                "min_macd_hist": "-0.020",
                "max_macd_hist": "0.010",
                "max_price_vs_session_open_bps": "-30",
                "max_opening_window_return_bps": "-10",
                "max_cross_section_continuation_rank": "0.45",
                "min_cross_section_reversal_rank": "0.68",
                "entry_start_minute_utc": "1095",
                "entry_end_minute_utc": "1185",
                "max_gross_exposure_pct_equity": "2.75",
                "entry_cooldown_seconds": "3000",
                "min_hold_seconds": "60",
                "max_hold_seconds": "600",
                "long_stop_loss_bps": "5",
                "long_trailing_stop_activation_profit_bps": "5",
                "long_trailing_stop_drawdown_bps": "2",
                "max_session_negative_exit_bps": "3",
            },
        },
        {
            "universe_symbols": list(_PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE),
            "max_position_pct_equity": "1.5",
            "max_notional_per_trade": "47385",
            "params": {
                "drive_reference_basis": "prev_close",
                "opening_window_reference_basis": "prev_close",
                "opening_window_rank_reference_basis": "prev_close",
                "min_bull_rsi": "36",
                "max_bull_rsi": "54",
                "min_macd_hist": "-0.014",
                "max_macd_hist": "0.014",
                "max_price_vs_session_open_bps": "-16",
                "max_opening_window_return_bps": "-2",
                "max_cross_section_continuation_rank": "0.55",
                "min_cross_section_reversal_rank": "0.56",
                "entry_start_minute_utc": "1110",
                "entry_end_minute_utc": "1185",
                "max_gross_exposure_pct_equity": "2.5",
                "entry_cooldown_seconds": "3000",
                "min_hold_seconds": "60",
                "max_hold_seconds": "480",
                "long_stop_loss_bps": "4",
                "long_trailing_stop_activation_profit_bps": "5",
                "long_trailing_stop_drawdown_bps": "2",
                "max_session_negative_exit_bps": "3",
            },
        },
    ),
}

_H_PAIRS_REPLAY_LEDGER_BREADTH_EXECUTION_PROFILES: tuple[dict[str, Any], ...] = (
    {
        "universe_symbols": list(_PORTFOLIO_COVERAGE_UNIVERSE_PROFILE),
        "normalization_regime": "market_neutral_gross_scaled",
        "max_position_pct_equity": "1.0",
        "max_notional_per_trade": "30000",
        "params": {
            "entry_minute_after_open": "45",
            "exit_minute_after_open": "close",
            "signal_motif": "replay_ledger_notional_breadth_continuation",
            "rank_feature": "cross_section_session_open_rank",
            "selection_mode": "continuation",
            "top_n": "4",
            "min_cross_section_continuation_rank": "0.48",
            "max_pair_legs": "5",
            "max_entries_per_session": "8",
            "max_concurrent_positions": "4",
            "entry_cooldown_seconds": "240",
            "entry_notional_max_multiplier": "1.0",
            "long_stop_loss_bps": "4",
            "long_trailing_stop_activation_profit_bps": "4",
            "long_trailing_stop_drawdown_bps": "2",
            "max_hold_seconds": "3600",
            "max_session_negative_exit_bps": "3",
            "max_stop_loss_exits_per_session": "1",
            "stop_loss_lockout_seconds": "1200",
            "replay_ledger_guidance_profile": "hpairs_notional_breadth_v1",
            "replay_ledger_guidance_scope": "bounded_exact_replay_prefilter",
        },
    },
    {
        "universe_symbols": list(_PORTFOLIO_COVERAGE_UNIVERSE_PROFILE),
        "normalization_regime": "market_neutral_gross_scaled",
        "max_position_pct_equity": "0.8",
        "max_notional_per_trade": "25000",
        "params": {
            "entry_minute_after_open": "30",
            "entry_window_minutes": "40",
            "exit_minute_after_open": "150",
            "signal_motif": "replay_ledger_pair_breadth_reversal",
            "rank_feature": "cross_section_session_open_rank",
            "selection_mode": "reversal",
            "top_n": "5",
            "max_cross_section_continuation_rank": "0.52",
            "min_cross_section_reversal_rank": "0.56",
            "max_pair_legs": "5",
            "max_entries_per_session": "6",
            "max_concurrent_positions": "4",
            "entry_cooldown_seconds": "300",
            "entry_notional_max_multiplier": "0.9",
            "long_stop_loss_bps": "4",
            "long_trailing_stop_activation_profit_bps": "4",
            "long_trailing_stop_drawdown_bps": "2",
            "max_hold_seconds": "2700",
            "max_session_negative_exit_bps": "3",
            "max_stop_loss_exits_per_session": "1",
            "stop_loss_lockout_seconds": "1200",
            "replay_ledger_guidance_profile": "hpairs_pair_breadth_reversal_v1",
            "replay_ledger_guidance_scope": "bounded_exact_replay_prefilter",
        },
    },
)


def _stable_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _stable_int(payload: Mapping[str, Any]) -> int:
    return int(_stable_hash(payload)[:12], 16)


def _string(value: Any) -> str:
    return str(value or "").strip()


def _mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[Any, Any], value).items()}


def _string_sequence(value: Any) -> tuple[str, ...]:
    if not isinstance(value, Sequence) or isinstance(value, str):
        return ()
    return tuple(str(item) for item in cast(Sequence[Any], value))


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


def _universe_symbol_override(symbols: Sequence[str]) -> tuple[str, ...]:
    cleaned: list[str] = []
    seen: set[str] = set()
    allowed = set(_RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE)
    for symbol in symbols:
        normalized = str(symbol).strip().upper()
        if not normalized or normalized in seen or normalized not in allowed:
            continue
        cleaned.append(normalized)
        seen.add(normalized)
    return tuple(cleaned)


def _list_of_mappings(value: Any) -> tuple[dict[str, Any], ...]:
    if not isinstance(value, Sequence) or isinstance(value, str):
        return ()
    return tuple(
        _mapping(item) for item in cast(Sequence[Any], value) if _mapping(item)
    )


def _hypothesis_haystack(card: HypothesisCard) -> str:
    return " ".join(
        [
            card.mechanism,
            card.asset_scope,
            card.horizon_scope,
            " ".join(card.required_features),
            " ".join(card.entry_motifs),
            " ".join(card.exit_motifs),
            " ".join(card.expected_regimes),
            " ".join(card.failure_modes),
            " ".join(card.source_claim_ids),
        ]
    ).lower()


def _has_rejected_signal_outcome_calibration(card: HypothesisCard) -> bool:
    haystack = _hypothesis_haystack(card)
    return any(
        token in haystack
        for token in (
            "rejected trading event",
            "rejected event",
            "rejected-event",
            "rejected signal",
            "rejected_signal",
            "skipped signal",
            "skipped-signal",
            "counterfactual outcome",
            "counterfactual return",
            "outcome labels",
            "outcome_labels",
        )
    )


def _normalization_candidates_for_card(card: HypothesisCard) -> tuple[str, ...]:
    haystack = _hypothesis_haystack(card)
    candidates = ["price_scaled", "trading_value_scaled"]
    if any(
        token in haystack
        for token in (
            "market cap",
            "market-cap",
            "market_cap",
            "matched filter",
            "matched-filter",
            "matched_filter",
            "scale-invariant",
            "scale invariant",
        )
    ):
        candidates.append("market_cap_scaled")
    if any(
        token in haystack
        for token in (
            "opening",
            "session segment",
            "session_segment",
            "timezone",
            "time-of-day",
            "time of day",
        )
    ):
        candidates.append("opening_window_scaled")
    return tuple(dict.fromkeys(candidates))


def _requires_synthetic_validation_only_policy(card: HypothesisCard) -> bool:
    validation_requirements = _list_of_mappings(
        card.implementation_constraints.get("validation_requirements")
    )
    haystack = " ".join(
        " ".join(
            (
                str(item.get("claim_type") or ""),
                str(item.get("claim_text") or ""),
                " ".join(_string_sequence(item.get("data_requirements"))),
            )
        ).lower()
        for item in validation_requirements
    )
    return any(
        token in haystack
        for token in (
            "synthetic",
            "generated",
            "simulation",
            "simulated",
            "stress",
            "live_paper_parity",
        )
    )


def _is_validation_or_execution_constraint_only(card: HypothesisCard) -> bool:
    source_claims = _list_of_mappings(
        card.implementation_constraints.get("source_claims")
    )
    claim_types = {
        str(item.get("claim_type") or "").strip().lower()
        for item in source_claims
        if str(item.get("claim_type") or "").strip()
    }
    if not claim_types:
        return False
    signal_claim_types = {
        "feature_recipe",
        "signal_mechanism",
        "strategy_mechanism",
        "portfolio_construction",
    }
    if claim_types & signal_claim_types:
        return False
    return claim_types <= {
        "execution_assumption",
        "market_regime",
        "risk_constraint",
        "validation_requirement",
    }


def _paper_mechanism_haystack(card: HypothesisCard) -> str:
    validation_requirements = _list_of_mappings(
        card.implementation_constraints.get("validation_requirements")
    )
    validation_text = " ".join(
        " ".join(
            (
                str(item.get("claim_id") or ""),
                str(item.get("claim_type") or ""),
                str(item.get("claim_text") or ""),
                " ".join(_string_sequence(item.get("data_requirements"))),
            )
        )
        for item in validation_requirements
    )
    return f"{_hypothesis_haystack(card)} {validation_text}".lower()


def _requires_factor_acceptance_harness(card: HypothesisCard) -> bool:
    haystack = _paper_mechanism_haystack(card)
    return any(
        token in haystack
        for token in (
            "rankic",
            "rank ic",
            "rank-ir",
            "rank ir",
            "information coefficient",
            "factor mining",
            "factor discovery",
            "factor screener",
            "alpha factor",
            "signal discovery",
            "llm signal",
            "quantitative signal discovery",
            "adaptive factor",
            "chain-of-alpha",
            "alphacrafter",
            "alpha-r1",
            "r&d-agent-quant",
            "rd-agent-quant",
            "factorminer",
        )
    )


def _factor_acceptance_dependencies(
    card: HypothesisCard, strategy_overrides: Mapping[str, Any]
) -> tuple[str, ...]:
    params = _mapping(strategy_overrides.get("params"))
    dependencies: list[str] = []
    for key in ("rank_feature", "gate_feature"):
        value = _string(params.get(key))
        if value:
            dependencies.append(value)
    dependencies.extend(card.required_features)
    return tuple(dict.fromkeys(item for item in dependencies if item))


def _factor_acceptance_expression(strategy_overrides: Mapping[str, Any]) -> str:
    params = _mapping(strategy_overrides.get("params"))
    rank_feature = _string(params.get("rank_feature"))
    gate_feature = _string(params.get("gate_feature"))
    if rank_feature and gate_feature:
        return f"{rank_feature}|gated_by:{gate_feature}"
    if rank_feature:
        return rank_feature
    return "candidate_family_score"


def _apply_factor_acceptance_harness(
    *,
    card: HypothesisCard,
    feature_contract: dict[str, Any],
    parameter_space: dict[str, Any],
    strategy_overrides: Mapping[str, Any],
    hard_vetoes: dict[str, Any],
    promotion_contract: dict[str, Any],
) -> None:
    if not _requires_factor_acceptance_harness(card):
        return
    artifact = build_factor_acceptance_artifact(
        factor_expression=_factor_acceptance_expression(strategy_overrides),
        source_idea="2025_2026_signal_discovery_rankic_acceptance_harness",
        allowed_feature_dependencies=_factor_acceptance_dependencies(
            card, strategy_overrides
        ),
        train_window={"source": "runtime_replay_required"},
        test_window={"source": "holdout_or_live_paper_required"},
        sample_count=0,
        candidate_count=1,
    )
    feature_contract["factor_acceptance_artifact"] = artifact
    feature_contract["factor_acceptance_policy"] = (
        "deterministic_rankic_rankir_cost_stress_fail_closed"
    )
    overlay_ids = [
        str(item)
        for item in cast(
            Sequence[Any], parameter_space.get("mechanism_overlay_ids") or []
        )
    ]
    if "rankic_factor_acceptance_harness" not in overlay_ids:
        overlay_ids.append("rankic_factor_acceptance_harness")
    parameter_space["mechanism_overlay_ids"] = overlay_ids
    hard_vetoes.update(
        {
            "required_factor_acceptance_artifact": True,
            "required_factor_acceptance_status": "accepted",
            "required_factor_acceptance_min_rank_ic": artifact["thresholds"][
                "min_rank_ic"
            ],
            "required_factor_acceptance_min_rank_ir": artifact["thresholds"][
                "min_rank_ir"
            ],
            "required_factor_acceptance_max_deflated_p_value": artifact["thresholds"][
                "max_deflated_p_value"
            ],
            "required_factor_acceptance_min_sample_count": artifact["thresholds"][
                "min_sample_count"
            ],
            "required_factor_acceptance_cost_stressed_positive": True,
        }
    )
    promotion_contract.update(
        {
            "requires_factor_acceptance_artifact": True,
            "requires_feature_dependency_parity": True,
            "requires_rankic_rankir_holdout_acceptance": True,
            "requires_multiple_testing_penalty": True,
            "requires_cost_stressed_factor_expectancy": True,
            "rejects_llm_generated_factor_without_deterministic_acceptance": True,
            "rejects_factor_acceptance_as_live_promotion_proof": True,
        }
    )


def _mechanism_overlays_for_card(card: HypothesisCard) -> dict[str, Any]:
    haystack = _paper_mechanism_haystack(card)
    overlay_ids: list[str] = []
    overlay_contracts: list[dict[str, Any]] = []
    hard_vetoes: dict[str, Any] = {}
    promotion_contract: dict[str, Any] = {}

    def has_any(tokens: Sequence[str]) -> bool:
        return any(token in haystack for token in tokens)

    if has_any(
        (
            "clusterlob",
            "clustered order",
            "clustered_order",
            "order arrival clustering",
            "arrival clustering",
            "event stream",
            "event-stream",
            "lob event",
            "hawkes",
            "order_arrival_intensity",
            "state_dependent_hawkes_intensity",
        )
    ):
        overlay_ids.append("cluster_lob_event_clustering")
        overlay_contracts.append(
            {
                "overlay_id": "cluster_lob_event_clustering",
                "required_evidence": [
                    "clustered_order_events",
                    "event_cluster_stability",
                    "quote_quality_parity",
                ],
                "evidence_policy": "event_stream_required_not_ohlcv_only",
            }
        )
        hard_vetoes.update(
            {
                "required_min_event_cluster_stability_score": "0.60",
                "required_max_event_stream_latency_ms": "250",
            }
        )
        promotion_contract.update(
            {
                "requires_lob_event_stream_parity": True,
                "requires_event_cluster_stability": True,
                "rejects_ohlcv_only_evidence": True,
            }
        )

    if has_any(
        (
            "market-versus-limit",
            "market versus limit",
            "market-vs-limit",
            "market and limit orders",
            "market limit order mix",
            "market-versus-limit order mix",
            "limit fill probability",
            "execution shortfall",
            "opportunity cost",
            "order type ablation",
            "price improvement",
            "broker route quality",
            "marketable limit",
            "passive limit",
            "patient limit order",
            "dynamic allocation between market and limit",
            "mixed-market-limit",
            "mixed market limit",
        )
    ):
        overlay_ids.append("mixed_market_limit_execution_policy")
        overlay_contracts.append(
            {
                "overlay_id": "mixed_market_limit_execution_policy",
                "required_evidence": [
                    "market_limit_order_mix",
                    "limit_fill_probability",
                    "execution_shortfall",
                    "order_type_ablation",
                    "opportunity_cost",
                    "price_improvement",
                    "route_tca",
                ],
                "rank_metric": "post_cost_net_pnl_after_fill_adjusted_execution",
                "evidence_policy": "market_limit_mix_requires_real_fill_evidence",
            }
        )
        hard_vetoes.update(
            {
                "required_market_limit_order_mix_evidence": True,
                "required_limit_fill_probability_evidence": True,
                "required_order_type_ablation_passed": True,
                "required_min_order_type_ablation_sample_count": "60",
                "required_opportunity_cost_evidence": True,
                "required_price_improvement_evidence": True,
                "required_execution_shortfall_evidence": True,
                "required_max_order_type_opportunity_cost_bps": "8",
                "required_max_market_order_spread_bps": "8",
            }
        )
        promotion_contract.update(
            {
                "requires_order_type_execution_quality": True,
                "requires_order_type_ablation": True,
                "requires_market_limit_order_mix": True,
                "requires_limit_fill_probability": True,
                "requires_execution_shortfall": True,
                "requires_opportunity_cost": True,
                "requires_price_improvement": True,
                "execution_policy": "candidate_local_market_limit_mix",
            }
        )

    if has_any(
        (
            "kanformer",
            "queue-position",
            "queue position",
            "queue_position",
            "queue ratio",
            "queue_ratio",
            "time-to-fill",
            "time to fill",
            "time_to_fill",
            "survival analysis",
            "survival model",
            "survival_fill_curve",
            "fill survival",
            "fill_survival",
            "fill probability",
            "fill probabilities",
            "fill_probability",
            "limit fill probability",
            "limit_fill_probability",
            "nonfill opportunity cost",
            "nonfill_opportunity_cost",
            "right-censored",
            "right censored",
        )
    ):
        overlay_ids.append("queue_position_survival_fill_curve")
        overlay_contracts.append(
            {
                "overlay_id": "queue_position_survival_fill_curve",
                "required_evidence": [
                    "queue_position",
                    "survival_fill_curve",
                    "time_to_fill_quantiles",
                    "limit_fill_probability",
                    "nonfill_opportunity_cost",
                    "route_tca",
                    "live_paper_parity",
                ],
                "rank_metric": "post_cost_net_pnl_after_queue_position_survival_fill_stress",
                "evidence_policy": "queue_position_fill_probability_requires_real_order_lifecycle_evidence",
            }
        )
        hard_vetoes.update(
            {
                "required_queue_position_survival_fill_curve": True,
                "required_min_queue_position_survival_sample_count": "60",
                "required_max_queue_position_nonfill_opportunity_cost_bps": "8",
                "required_time_to_fill_quantiles": True,
                "required_order_lifecycle_fill_evidence": True,
            }
        )
        promotion_contract.update(
            {
                "requires_queue_position_survival_fill_curve": True,
                "requires_time_to_fill_quantiles": True,
                "requires_nonfill_opportunity_cost": True,
                "requires_order_lifecycle_fill_evidence": True,
                "rejects_queue_position_free_fill_assumptions": True,
                "execution_policy": "queue_position_survival_fill_curve",
            }
        )

    if has_any(
        (
            "model predictive control",
            "model-predictive control",
            "mpc trade execution",
            "mpc execution",
            "mpc_execution",
            "dynamic execution schedule",
            "dynamic_execution_schedule",
            "execution schedule control",
            "execution_schedule_trace",
            "liquidity forecast",
            "liquidity_forecast",
            "inventory path",
            "inventory_path",
            "execution shortfall",
            "execution_shortfall",
        )
    ):
        overlay_ids.append("mpc_dynamic_execution_schedule")
        overlay_contracts.append(
            {
                "overlay_id": "mpc_dynamic_execution_schedule",
                "required_evidence": [
                    "execution_schedule_trace",
                    "liquidity_forecast",
                    "inventory_path",
                    "execution_shortfall",
                    "route_tca",
                    "latency_stress",
                    "market_impact_stress",
                    "post_cost_net_pnl",
                ],
                "rank_metric": "post_cost_net_pnl_after_mpc_schedule_shortfall_stress",
                "evidence_policy": (
                    "dynamic_execution_schedule_requires_replay_shortfall_ablation"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_mpc_dynamic_execution_schedule": True,
                "required_execution_schedule_trace": True,
                "required_liquidity_forecast": True,
                "required_inventory_path_trace": True,
                "required_execution_shortfall_evidence": True,
                "required_mpc_schedule_shortfall_ablation_passed": True,
                "required_min_mpc_schedule_trace_sample_count": "60",
                "required_latency_stress": True,
                "required_market_impact_stress": True,
                "required_max_mpc_schedule_shortfall_bps": "8",
            }
        )
        promotion_contract.update(
            {
                "requires_mpc_dynamic_execution_schedule": True,
                "requires_execution_schedule_trace": True,
                "requires_liquidity_forecast": True,
                "requires_inventory_path_trace": True,
                "requires_execution_shortfall": True,
                "requires_route_tca": True,
                "requires_latency_stress": True,
                "requires_market_impact_stress": True,
                "rejects_static_schedule_free_mpc_claims": True,
                "rejects_dynamic_schedule_without_shortfall_ablation": True,
                "execution_policy": "mpc_dynamic_schedule_validation_only",
            }
        )

    if has_any(
        (
            "alpha decay",
            "alpha_decay",
            "predictability decay",
            "predictability_decay",
            "declined over time",
            "market efficiency",
            "short-run market efficiency",
            "t-kan",
            "tkan",
            "temporal kolmogorov",
            "tlob",
            "dual attention",
            "horizon bias",
            "horizon_bias",
            "spread-adjusted labels",
            "spread adjusted labels",
            "algorithmic activity",
            "tight spreads",
            "heavier trading",
            "high-volume regimes",
            "high volume regimes",
        )
    ):
        overlay_ids.append("alpha_decay_predictability_stress")
        overlay_contracts.append(
            {
                "overlay_id": "alpha_decay_predictability_stress",
                "required_evidence": [
                    "horizon_decay_curve",
                    "spread_adjusted_labels",
                    "tight_spread_regime_slices",
                    "high_volume_regime_slices",
                    "inference_latency",
                    "walk_forward_replay",
                    "route_tca",
                ],
                "rank_metric": "post_cost_net_pnl_after_predictability_decay_stress",
                "evidence_policy": "short_horizon_lob_alpha_requires_decay_and_cost_stress",
            }
        )
        hard_vetoes.update(
            {
                "required_predictability_decay_stress": True,
                "required_horizon_decay_curve": True,
                "required_spread_adjusted_label_replay": True,
                "required_min_decay_stress_horizon_count": "3",
                "required_min_tight_spread_regime_count": "20",
                "required_min_high_volume_regime_count": "20",
                "required_min_decay_stress_split_pass_rate": "0.60",
                "required_max_decay_stress_best_split_share": "0.35",
                "required_max_model_inference_latency_ms": "200",
            }
        )
        promotion_contract.update(
            {
                "requires_predictability_decay_stress": True,
                "requires_horizon_decay_curve": True,
                "requires_spread_adjusted_label_replay": True,
                "requires_tight_spread_and_high_volume_slices": True,
                "requires_model_latency_budget": True,
                "requires_route_tca": True,
                "rejects_single_horizon_lob_alpha_promotion": True,
                "rejects_classification_accuracy_without_costs": True,
            }
        )

    if has_any(
        (
            "fr-lux",
            "friction-aware",
            "friction aware",
            "regime-conditioned",
            "regime conditioned",
            "volatility-liquidity regime",
            "volatility liquidity regime",
            "trade-space trust region",
            "trade space trust region",
            "inventory flow trust region",
            "turnover budget",
            "turnover bounds",
            "inaction band",
            "convex frictions",
            "cost misspecification",
            "liquidity proxy",
            "liquidity proxies",
        )
    ):
        overlay_ids.append("friction_aware_regime_conditioned_policy")
        overlay_contracts.append(
            {
                "overlay_id": "friction_aware_regime_conditioned_policy",
                "required_evidence": [
                    "regime_state",
                    "regime_conditioned_policy",
                    "proportional_cost_model",
                    "impact_cost_model",
                    "liquidity_proxy_cost_calibration",
                    "trade_space_trust_region",
                    "turnover_budget",
                    "cost_misspecification_stress",
                    "scenario_level_inference",
                    "post_cost_net_pnl",
                    "live_paper_parity",
                ],
                "rank_metric": "post_cost_net_pnl_after_regime_conditioned_friction_stress",
                "evidence_policy": (
                    "friction_aware_regime_conditioned_policy_is_replay_ranking_not_promotion_proof"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_friction_aware_regime_conditioning": True,
                "required_proportional_and_impact_cost_model": True,
                "required_liquidity_proxy_cost_calibration": True,
                "required_trade_space_trust_region": True,
                "required_turnover_budget": True,
                "required_cost_misspecification_stress": True,
                "required_scenario_level_inference": True,
                "required_live_paper_parity": True,
            }
        )
        promotion_contract.update(
            {
                "requires_regime_conditioned_policy": True,
                "requires_proportional_and_impact_cost_model": True,
                "requires_liquidity_proxy_cost_calibration": True,
                "requires_trade_space_trust_region": True,
                "requires_turnover_budget": True,
                "requires_cost_misspecification_stress": True,
                "requires_scenario_level_inference": True,
                "requires_live_paper_parity": True,
                "rejects_cost_blind_policy_optimization": True,
                "rejects_single_regime_cost_backtest": True,
                "risk_policy": "friction_aware_regime_conditioned_policy_validation_only",
            }
        )

    if has_any(
        (
            "alphacrafter",
            "adaptive factor-to-execution",
            "factor-to-execution",
            "adaptive factor screener",
            "continuous factor mining",
            "factor pool expansion",
            "regime-adaptive factor",
            "regime adaptive factor",
            "risk-constrained execution",
            "risk constrained execution",
            "continuous candidate refresh",
            "miner screener trader",
            "factor discovery loop",
            "closed-loop cross-sectional trading",
        )
    ):
        overlay_ids.append("adaptive_factor_to_execution_loop")
        overlay_contracts.append(
            {
                "overlay_id": "adaptive_factor_to_execution_loop",
                "required_evidence": [
                    "continuous_factor_mining",
                    "factor_pool_expansion",
                    "adaptive_factor_screener",
                    "regime_adaptive_factor_ensemble",
                    "risk_constrained_execution",
                    "portfolio_replay",
                    "walk_forward_replay",
                    "transaction_cost_stress",
                    "post_cost_net_pnl",
                    "runtime_ledger_profit_proof",
                ],
                "rank_metric": "adaptive_factor_loop_post_cost_net_pnl_per_day",
                "evidence_policy": (
                    "adaptive_factor_loop_is_search_prefilter_not_promotion_proof"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_adaptive_factor_to_execution_loop": True,
                "required_continuous_factor_mining": True,
                "required_adaptive_factor_screener": True,
                "required_regime_adaptive_factor_ensemble": True,
                "required_risk_constrained_execution": True,
                "required_post_cost_replay": True,
            }
        )
        promotion_contract.update(
            {
                "requires_adaptive_factor_to_execution_loop": True,
                "requires_continuous_factor_mining": True,
                "requires_adaptive_factor_screener": True,
                "requires_regime_adaptive_factor_ensemble": True,
                "requires_risk_constrained_execution": True,
                "requires_portfolio_replay": True,
                "requires_post_cost_net_pnl": True,
                "requires_runtime_ledger_profit_proof": True,
                "rejects_agentic_search_only_promotion": True,
                "rejects_factor_screen_only_promotion": True,
                "rejects_static_one_shot_factor_mining": True,
                "risk_policy": "adaptive_factor_to_execution_loop_validation_only",
            }
        )

    if has_any(
        (
            "regime-weighted conformal",
            "regime weighted conformal",
            "regime_weighted_conformal",
            "conformal var",
            "conformal_var",
            "conformal value-at-risk",
            "conformal risk control",
            "conformal_risk_control",
            "conformal tail risk",
            "conformal_tail_risk",
            "tail risk buffer",
            "breakeven cost buffer",
            "breakeven transaction-cost",
            "breakeven_transaction_cost",
            "transaction cost buffer",
            "regime-similarity weight",
            "regime similarity weight",
            "tail exceedance",
            "tail_exceedance",
        )
    ):
        overlay_ids.append("regime_weighted_conformal_cost_buffer")
        overlay_contracts.append(
            {
                "overlay_id": "regime_weighted_conformal_cost_buffer",
                "required_evidence": [
                    "regime_weighted_conformal_var",
                    "conformal_tail_risk",
                    "regime_tail_exceedance",
                    "regime_similarity_weights",
                    "breakeven_transaction_cost_buffer",
                    "transaction_cost_stress",
                    "seed_robustness",
                    "model_family_robustness",
                    "walk_forward_replay",
                    "post_cost_net_pnl",
                ],
                "rank_metric": "conformal_tail_risk_adjusted_net_pnl_per_day",
                "evidence_policy": (
                    "regime_weighted_conformal_buffer_is_ranking_stress_not_promotion_proof"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_conformal_tail_risk": True,
                "required_regime_weighted_conformal_cost_buffer": True,
                "required_min_conformal_tail_risk_sample_count": "20",
                "required_regime_tail_exceedance_report": True,
                "required_breakeven_transaction_cost_buffer": True,
                "required_seed_model_family_robustness": True,
                "required_conformal_tail_risk_adjusted_net_above_target": True,
            }
        )
        promotion_contract.update(
            {
                "requires_conformal_tail_risk": True,
                "requires_conformal_var_cost_buffer": True,
                "requires_regime_tail_exceedance_report": True,
                "requires_breakeven_transaction_cost_buffer": True,
                "requires_seed_model_family_robustness": True,
                "requires_walk_forward_replay": True,
                "rejects_unbuffered_tail_risk_promotion": True,
                "rejects_single_seed_conformal_var_proof": True,
                "risk_policy": "regime_weighted_conformal_cost_buffer_validation_only",
            }
        )

    if has_any(
        (
            "risk-aware trading portfolio optimization",
            "risk aware trading portfolio optimization",
            "risk-aware trading swarm",
            "risk_aware_trading_swarm",
            "ratpo",
            "rats algorithm",
            "eligible optimization strategy",
            "unique eligible instrument",
            "unique eligible instruments",
            "market sensitivity constraints",
            "market sensitivities",
            "capital charge",
            "portfolio objective value",
            "market risk and pnl",
            "market risk and profit",
        )
    ):
        overlay_ids.append("risk_aware_trading_portfolio_optimization")
        overlay_contracts.append(
            {
                "overlay_id": "risk_aware_trading_portfolio_optimization",
                "required_evidence": [
                    "portfolio_replay",
                    "market_risk_var",
                    "pnl_objective",
                    "eligible_instrument_universe",
                    "eligible_optimization_strategy",
                    "market_sensitivity_constraints",
                    "capital_charge_stress",
                    "transaction_cost_stress",
                    "risk_limit_compliance",
                    "walk_forward_replay",
                    "post_cost_net_pnl",
                ],
                "rank_metric": "risk_adjusted_post_cost_net_pnl_per_day",
                "evidence_policy": (
                    "risk_aware_portfolio_optimizer_is_prefilter_not_promotion_proof"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_risk_aware_portfolio_optimization": True,
                "required_portfolio_replay": True,
                "required_market_risk_var": True,
                "required_market_sensitivity_constraints": True,
                "required_capital_charge_stress": True,
                "required_risk_limit_compliance": True,
                "required_transaction_cost_stress": True,
            }
        )
        promotion_contract.update(
            {
                "requires_risk_aware_portfolio_optimization": True,
                "requires_portfolio_replay": True,
                "requires_market_risk_var": True,
                "requires_market_sensitivity_constraints": True,
                "requires_capital_charge_stress": True,
                "requires_risk_limit_compliance": True,
                "requires_post_cost_net_pnl": True,
                "rejects_risk_only_objective_without_post_cost_pnl": True,
                "rejects_optimizer_only_promotion": True,
                "risk_policy": "risk_aware_portfolio_optimization_validation_only",
            }
        )

    if has_any(
        (
            "double-selection lasso",
            "double selection lasso",
            "double_selection_lasso",
            "high-dimensional factor",
            "high dimensional factor",
            "short-term trading factor",
            "short term trading factor",
            "short_term_trading_factors",
            "alpha191",
            "factor_rank_panel",
            "factor screen",
            "factor-screen",
            "multiple-testing controls",
            "multiple_testing_controls",
            "train_holdout_split",
        )
    ):
        overlay_ids.append("double_selection_factor_screen")
        overlay_contracts.append(
            {
                "overlay_id": "double_selection_factor_screen",
                "required_evidence": [
                    "short_term_trading_factors",
                    "cross_sectional_ranks",
                    "factor_rank_panel",
                    "train_holdout_split",
                    "multiple_testing_controls",
                    "walk_forward_replay",
                    "post_cost_net_pnl",
                    "runtime_ledger_profit_proof",
                ],
                "rank_metric": "double_selection_factor_post_cost_net_pnl_per_day",
                "evidence_policy": (
                    "double_selection_factor_screen_is_prefilter_not_promotion_proof"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_double_selection_factor_screen": True,
                "required_short_term_trading_factors": True,
                "required_cross_sectional_rank_panel": True,
                "required_train_holdout_split": True,
                "required_multiple_testing_controls": True,
                "required_post_cost_replay": True,
            }
        )
        promotion_contract.update(
            {
                "requires_double_selection_factor_screen": True,
                "requires_cross_sectional_rank_panel": True,
                "requires_train_holdout_split": True,
                "requires_multiple_testing_controls": True,
                "requires_post_cost_net_pnl": True,
                "requires_runtime_ledger_profit_proof": True,
                "rejects_factor_screen_only_promotion": True,
                "rejects_in_sample_factor_selection": True,
                "risk_policy": "double_selection_factor_screen_validation_only",
            }
        )

    if has_any(
        (
            "non-parametric bootstrap",
            "nonparametric bootstrap",
            "bootstrap robust optimization",
            "bootstrap robustness",
            "bootstrap confidence interval",
            "bootstrap confidence intervals",
            "resampled confidence interval",
            "resampled confidence intervals",
            "utility percentile",
            "percentile-based optimization",
            "percentile based optimization",
            "utility as a random variable",
            "selection bias",
            "overfitting and selection bias",
            "parameter instability",
            "model misspecification",
            "distribution-free robust optimization",
            "distribution free robust optimization",
        )
    ):
        overlay_ids.append("bootstrap_robust_optimization_stability")
        overlay_contracts.append(
            {
                "overlay_id": "bootstrap_robust_optimization_stability",
                "required_evidence": [
                    "bootstrap_confidence_interval",
                    "utility_percentile",
                    "resampled_strategy_optimization",
                    "parameter_instability_stress",
                    "selection_bias_stress",
                    "model_misspecification_stress",
                    "out_of_sample_generalization",
                    "walk_forward_replay",
                    "post_cost_net_pnl",
                ],
                "rank_metric": "bootstrap_percentile_robust_net_pnl_per_day",
                "evidence_policy": (
                    "bootstrap_robust_optimization_is_prefilter_not_promotion_proof"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_bootstrap_robust_optimization": True,
                "required_bootstrap_confidence_interval": True,
                "required_utility_percentile_optimization": True,
                "required_selection_bias_stress": True,
                "required_parameter_instability_stress": True,
                "required_model_misspecification_stress": True,
                "required_distribution_free_confidence_intervals": True,
                "required_min_bootstrap_replicates": "500",
            }
        )
        promotion_contract.update(
            {
                "requires_bootstrap_robust_optimization": True,
                "requires_bootstrap_confidence_intervals": True,
                "requires_utility_percentile_optimization": True,
                "requires_selection_bias_stress": True,
                "requires_parameter_instability_stress": True,
                "requires_model_misspecification_stress": True,
                "requires_walk_forward_replay": True,
                "rejects_point_estimate_only_optimization": True,
                "rejects_in_sample_selection_bias": True,
                "risk_policy": "bootstrap_robust_optimization_validation_only",
            }
        )

    if has_any(
        (
            "crumbling quote",
            "crumbling quotes",
            "crumbling_quote",
            "quote crumble",
            "quote_crumble",
            "quote erosion",
            "quote_erosion",
            "mechanical liquidity erosion",
            "mechanical_liquidity_erosion",
            "mechanical liquidity withdrawal",
            "liquidity withdrawal",
            "liquidity_withdrawal",
            "transient mechanical liquidity",
            "transient liquidity erosion",
        )
    ):
        overlay_ids.append("crumbling_quote_liquidity_erosion")
        overlay_contracts.append(
            {
                "overlay_id": "crumbling_quote_liquidity_erosion",
                "required_evidence": [
                    "crumbling_quote_probability",
                    "mechanical_liquidity_erosion",
                    "lob_event_stream",
                    "executable_quote",
                    "route_tca",
                    "live_paper_parity",
                    "adverse_selection_stress",
                ],
                "rank_metric": "post_cost_net_pnl_after_crumbling_quote_liquidity_stress",
                "evidence_policy": (
                    "crumbling_quote_probability_is_validation_only_until_live_paper_route_tca"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_crumbling_quote_liquidity_erosion": True,
                "required_crumbling_quote_probability": True,
                "required_mechanical_liquidity_erosion_probability": True,
                "required_min_crumbling_quote_sample_count": "60",
                "required_max_crumbling_quote_probability": "0.90",
                "required_route_tca": True,
                "required_live_paper_parity": True,
            }
        )
        promotion_contract.update(
            {
                "requires_crumbling_quote_liquidity_erosion": True,
                "requires_crumbling_quote_probability": True,
                "requires_mechanical_liquidity_erosion_probability": True,
                "requires_lob_event_stream": True,
                "requires_executable_quote_evidence": True,
                "requires_route_tca": True,
                "requires_live_paper_parity": True,
                "requires_adverse_selection_stress": True,
                "rejects_crumbling_quote_simulation_as_promotion_proof": True,
                "risk_policy": "crumbling_quote_liquidity_erosion_validation_only",
            }
        )

    if has_any(
        (
            "nonlinear impact",
            "nonlinear_impact",
            "square-root",
            "square root",
            "power-law market impact",
            "power law market impact",
            "almgren",
            "route/tca",
            "route_tca",
            "market impact stress",
            "impact stress",
        )
    ):
        overlay_ids.append("nonlinear_market_impact_tca")
        overlay_contracts.append(
            {
                "overlay_id": "nonlinear_market_impact_tca",
                "required_evidence": [
                    "route_tca",
                    "nonlinear_impact_curve",
                    "realized_slippage_bps",
                    "turnover",
                ],
                "rank_metric": "post_cost_net_pnl_after_nonlinear_impact",
            }
        )
        hard_vetoes.update(
            {
                "required_min_route_tca_sample_count": "60",
                "required_max_realized_slippage_bps": "8",
                "required_impact_stress_model": "square_root_or_power_law",
            }
        )
        promotion_contract.update(
            {
                "requires_route_tca": True,
                "requires_nonlinear_impact_curve": True,
                "requires_impact_stress_replay": True,
                "ranking_cost_model": "post_cost_nonlinear_impact",
            }
        )

    if has_any(
        (
            "reality gap",
            "simulation reality",
            "sim-to-live",
            "simulation-to-live",
            "simulation parity",
            "simulation_parity",
            "synthetic lob",
            "lob simulation",
            "limit-order-book simulation",
            "limit order book simulation",
            "fill outcomes",
            "fill_outcomes",
            "adverse-selection",
            "adverse selection",
            "adverse_selection_stress",
        )
    ):
        overlay_ids.append("simulation_reality_gap_implementation_risk")
        overlay_contracts.append(
            {
                "overlay_id": "simulation_reality_gap_implementation_risk",
                "required_evidence": [
                    "simulation_live_parity_metrics",
                    "lob_event_stream",
                    "fill_outcomes",
                    "route_tca",
                    "live_paper_parity",
                    "adverse_selection_stress",
                    "replay_harness_implementation_trace",
                ],
                "rank_metric": (
                    "post_cost_net_pnl_after_simulation_reality_gap_stress"
                ),
                "evidence_policy": (
                    "synthetic_lob_fillability_requires_live_paper_parity"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_simulation_live_parity_metrics": True,
                "required_lob_event_stream": True,
                "required_fill_outcome_evidence": True,
                "required_replay_harness_implementation_trace": True,
                "required_min_simulation_parity_sample_count": "120",
                "required_max_simulation_live_fill_error_bps": "8",
                "required_max_adverse_selection_error_bps": "8",
            }
        )
        promotion_contract.update(
            {
                "requires_simulation_live_parity_metrics": True,
                "requires_lob_event_stream": True,
                "requires_fill_outcomes": True,
                "requires_route_tca": True,
                "requires_live_paper_parity": True,
                "requires_adverse_selection_stress": True,
                "requires_replay_harness_implementation_trace": True,
                "requires_implementation_uncertainty_stability": True,
                "rejects_synthetic_lob_fillability_as_capital_gate": True,
                "rejects_simulated_fillability_without_route_tca": True,
            }
        )

    if has_any(
        (
            "implementation risk",
            "implementation-risk",
            "engine sensitivity",
            "engine_sensitivity",
            "implementation uncertainty",
            "implementation_uncertainty_interval",
            "conclusion stability",
            "conclusion_stability",
            "divergence amplification",
            "divergence_amplification",
            "multi-engine replay",
            "multi_engine_replay",
            "backtest engine",
            "portfolio backtesting",
        )
    ):
        overlay_ids.append("implementation_risk_backtest_stability")
        overlay_contracts.append(
            {
                "overlay_id": "implementation_risk_backtest_stability",
                "required_evidence": [
                    "multi_engine_replay",
                    "engine_sensitivity",
                    "implementation_uncertainty_interval",
                    "conclusion_stability",
                    "transaction_cost_stress",
                    "replay_harness_implementation_trace",
                ],
                "rank_metric": "implementation_uncertainty_lower_net_pnl_per_day",
                "evidence_policy": (
                    "promotion_requires_stable_conclusion_across_replay_engines"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_multi_engine_replay": True,
                "required_min_implementation_uncertainty_model_count": "2",
                "required_implementation_uncertainty_lower_bound_above_target": True,
                "required_conclusion_stability_index": "1.00",
                "required_replay_harness_implementation_trace": True,
            }
        )
        promotion_contract.update(
            {
                "requires_implementation_uncertainty_stability": True,
                "requires_implementation_risk_backtest_stability": True,
                "requires_multi_engine_replay": True,
                "requires_engine_sensitivity_report": True,
                "requires_conclusion_stability": True,
                "rejects_single_engine_backtest_proof": True,
                "rejects_flat_cost_only_implementation_proof": True,
            }
        )

    if has_any(
        (
            "finrl-x",
            "finrl x",
            "deployment-consistent",
            "deployment consistent",
            "deployment consistency",
            "weight-centric",
            "weight centric",
            "broker execution",
            "broker-integrated execution",
            "backtesting and broker execution",
            "data processing, strategy construction, backtesting",
            "unified protocol",
            "downstream execution semantics",
            "replay paper live",
            "replay-paper-live",
            "signal payload parity",
            "signal_payload_parity",
            "order sizing parity",
            "order_sizing_parity",
            "route constraint parity",
            "route_constraint_parity",
            "broker_execution_semantics",
            "portfolio risk overlay parity",
            "portfolio_risk_overlay_parity",
        )
    ):
        overlay_ids.append("replay_paper_live_semantic_parity")
        overlay_contracts.append(
            {
                "overlay_id": "replay_paper_live_semantic_parity",
                "required_evidence": [
                    "signal_payload_parity",
                    "order_sizing_parity",
                    "route_constraint_parity",
                    "broker_execution_semantics",
                    "portfolio_weight_trace",
                    "portfolio_risk_overlay_parity",
                    "live_paper_parity",
                    "replay_harness_implementation_trace",
                ],
                "rank_metric": "post_cost_net_pnl_after_semantic_parity",
                "evidence_policy": (
                    "promotion_requires_same_replay_paper_live_execution_semantics"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_replay_paper_live_semantic_parity": True,
                "required_signal_payload_parity": True,
                "required_order_sizing_parity": True,
                "required_route_constraint_parity": True,
                "required_broker_execution_semantics_trace": True,
                "required_portfolio_risk_overlay_parity": True,
                "required_replay_harness_implementation_trace": True,
                "required_adapter_behavior_drift_count": "0",
            }
        )
        promotion_contract.update(
            {
                "requires_replay_paper_live_semantic_parity": True,
                "requires_signal_payload_parity": True,
                "requires_order_sizing_parity": True,
                "requires_route_constraint_parity": True,
                "requires_broker_execution_semantics": True,
                "requires_portfolio_risk_overlay_parity": True,
                "requires_live_paper_parity": True,
                "rejects_adapter_only_execution_behavior": True,
                "rejects_backtest_only_strategy_protocol": True,
            }
        )

    if has_any(
        (
            "intraday volume",
            "volume forecasting",
            "volume forecast",
            "vwap",
            "volume weighted average price",
            "volume-weighted average price",
            "u-shape",
            "u shaped",
            "u-shaped",
            "volume periodicity",
            "periodic volume",
            "morning afternoon volume",
            "execution schedule",
        )
    ):
        overlay_ids.append("intraday_volume_periodicity_execution")
        overlay_contracts.append(
            {
                "overlay_id": "intraday_volume_periodicity_execution",
                "required_evidence": [
                    "intraday_volume_forecast",
                    "clock_bucket_vwap_tracking_error",
                    "fillable_notional_by_clock_bucket",
                    "route_tca",
                ],
                "rank_metric": "post_cost_net_pnl_after_volume_periodicity_capacity",
                "evidence_policy": "capacity_must_follow_intraday_volume_profile",
            }
        )
        hard_vetoes.update(
            {
                "required_intraday_volume_forecast": True,
                "required_min_clock_bucket_capacity_sample_count": "60",
                "required_max_vwap_tracking_error_bps": "12",
                "required_min_volume_periodicity_capacity_ratio": "1.00",
            }
        )
        promotion_contract.update(
            {
                "requires_intraday_volume_forecast": True,
                "requires_clock_bucket_capacity": True,
                "requires_vwap_tracking_error": True,
                "requires_route_tca": True,
                "rejects_pooled_all_day_capacity_assumptions": True,
            }
        )

    if has_any(
        (
            "macro announcement",
            "macro_announcement",
            "macroeconomic announcement",
            "macroeconomic news",
            "macro news",
            "public information",
            "incremental information",
            "dvar",
            "difference in abnormal return variance",
            "event/non-event",
            "event non-event",
        )
    ):
        overlay_ids.append("macro_announcement_dvar_momentum")
        overlay_contracts.append(
            {
                "overlay_id": "macro_announcement_dvar_momentum",
                "required_evidence": [
                    "macro_announcement_calendar",
                    "dvar_incremental_information",
                    "event_non_event_holdout_replay",
                    "relative_volume",
                    "route_tca",
                    "live_paper_parity",
                ],
                "rank_metric": "post_cost_net_pnl_after_macro_event_holdout",
                "evidence_policy": "macro_momentum_requires_event_non_event_replay",
            }
        )
        hard_vetoes.update(
            {
                "required_macro_announcement_calendar": True,
                "required_dvar_incremental_information": True,
                "required_event_non_event_holdout_replay": True,
                "required_min_macro_event_window_count": "20",
                "required_min_macro_non_event_holdout_count": "60",
                "required_min_macro_event_split_pass_rate": "0.60",
                "required_max_macro_event_best_day_share": "0.25",
                "required_min_route_tca_sample_count": "60",
            }
        )
        promotion_contract.update(
            {
                "requires_macro_announcement_calendar": True,
                "requires_dvar_incremental_information": True,
                "requires_event_non_event_holdout_replay": True,
                "requires_relative_volume_confirmation": True,
                "requires_route_tca": True,
                "requires_live_paper_parity": True,
                "rejects_pooled_macro_and_non_macro_replay": True,
            }
        )

    if has_any(
        (
            "order-flow imbalance",
            "order flow imbalance",
            "order_flow_imbalance",
            "ofi",
            "ofi memory",
            "ofi_memory",
            "response-ratio",
            "response ratio",
            "lob response",
            "lob_response",
            "horizon-dependent",
            "horizon dependent",
        )
    ):
        overlay_ids.append("ofi_lob_continuation_response")
        overlay_contracts.append(
            {
                "overlay_id": "ofi_lob_continuation_response",
                "required_evidence": [
                    "order_flow_imbalance",
                    "microprice_bias",
                    "forecast_horizon",
                    "route_tca",
                    "walk_forward_replay",
                ],
                "rank_metric": "post_cost_net_pnl_after_ofi_response_horizon",
                "evidence_policy": "ofi_response_requires_executable_lob_or_quote_evidence",
            }
        )
        hard_vetoes.update(
            {
                "required_min_ofi_response_sample_count": "120",
                "required_min_ofi_response_stable_split_pass_rate": "0.60",
                "required_max_ofi_response_best_split_share": "0.35",
                "required_executable_quote_evidence": True,
            }
        )
        promotion_contract.update(
            {
                "requires_ofi_response_horizon_selection": True,
                "requires_executable_quote_evidence": True,
                "requires_route_tca": True,
                "rejects_ohlcv_only_ofi_proxies": True,
            }
        )

    if has_any(
        (
            "order-flow filtration",
            "order flow filtration",
            "structural filters",
            "structural filter",
            "parent orders",
            "parent order",
            "parent_order",
            "order lifetime",
            "order_lifetime",
            "modification count",
            "modification timing",
            "filtered obi",
            "filtered orderbook imbalance",
            "filtered_orderbook_imbalance",
            "transient orders",
        )
    ):
        overlay_ids.append("order_flow_filtration_parent_trade_obi")
        overlay_contracts.append(
            {
                "overlay_id": "order_flow_filtration_parent_trade_obi",
                "required_evidence": [
                    "parent_order_trade_linkage",
                    "order_lifetime_filter",
                    "order_modification_count",
                    "filtered_orderbook_imbalance",
                    "route_tca",
                    "walk_forward_replay",
                ],
                "rank_metric": "post_cost_net_pnl_after_filtered_parent_order_obi",
                "evidence_policy": (
                    "parent_trade_obi_requires_structural_order_filter_evidence"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_parent_order_trade_linkage": True,
                "required_min_filtered_obi_sample_count": "120",
                "required_min_filtered_obi_stable_split_pass_rate": "0.60",
                "required_max_filtered_obi_best_split_share": "0.35",
            }
        )
        promotion_contract.update(
            {
                "requires_parent_order_trade_linkage": True,
                "requires_structural_order_flow_filters": True,
                "requires_filtered_orderbook_imbalance_replay": True,
                "rejects_unfiltered_obi_only_promotion": True,
            }
        )

    if has_any(
        (
            "rejected trading event",
            "rejected event",
            "rejected-event",
            "rejected signal",
            "rejected_signal",
            "skipped signal",
            "skipped-signal",
            "counterfactual training",
            "counterfactual outcome",
            "counterfactual return",
            "outcome labels",
            "outcome_labels",
            "veto calibration",
            "vetoes discard",
            "discard profitable",
        )
    ):
        overlay_ids.append("rejected_signal_outcome_calibration")
        overlay_contracts.append(
            {
                "overlay_id": "rejected_signal_outcome_calibration",
                "required_evidence": [
                    "rejected_signal_log",
                    "outcome_labels",
                    "counterfactual_return",
                    "route_tca",
                    "post_cost_net_pnl",
                    "executable_quote",
                    "live_paper_parity",
                ],
                "rank_metric": "post_cost_net_pnl_after_rejected_signal_replay",
                "evidence_policy": (
                    "rejected_events_require_labeled_counterfactual_outcomes"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_min_rejected_signal_outcome_label_count": "120",
                "required_min_rejected_signal_reason_coverage": "0.80",
                "required_max_rejected_signal_outcome_pending_ratio": "0.05",
                "required_rejected_signal_counterfactual_fields": [
                    "counterfactual_return",
                    "route_tca",
                    "post_cost_net_pnl",
                    "executable_quote",
                ],
                "required_rejected_signal_outcome_persistence_state": "ok",
            }
        )
        promotion_contract.update(
            {
                "requires_rejected_signal_outcome_learning": True,
                "requires_rejected_signal_outcome_labels": True,
                "requires_rejected_signal_reason_coverage": True,
                "requires_rejected_signal_counterfactual_replay": True,
                "requires_counterfactual_executable_quote": True,
                "requires_route_tca": True,
                "requires_live_paper_parity": True,
                "rejects_pending_rejected_signal_outcome_labels": True,
                "rejects_unlabeled_reject_relaxation": True,
                "promotion_impact": "repair_only_until_labeled",
            }
        )

    if has_any(
        (
            "delay-adjusted depth",
            "delay adjusted depth",
            "execution delay",
            "execution_delay",
            "market depth",
            "market_depth",
            "depth state",
            "depth_state",
            "latency stress",
            "latency_stress",
            "fillable",
            "fillability",
            "limit_fill_probability",
        )
    ):
        overlay_ids.append("delay_adjusted_depth_stress")
        overlay_contracts.append(
            {
                "overlay_id": "delay_adjusted_depth_stress",
                "required_evidence": [
                    "depth_proxy",
                    "execution_delay",
                    "fill_model",
                    "route_tca",
                    "live_paper_parity",
                ],
                "rank_metric": "post_cost_net_pnl_after_delay_adjusted_depth_stress",
                "evidence_policy": "no_delay_fill_assumptions_are_not_promotion_proof",
            }
        )
        hard_vetoes.update(
            {
                "required_delay_adjusted_depth_stress": True,
                "required_max_route_latency_ms": "250",
                "required_min_delay_depth_sample_count": "60",
            }
        )
        promotion_contract.update(
            {
                "requires_delay_adjusted_depth_stress": True,
                "requires_execution_delay_replay": True,
                "requires_depth_proxy_fill_model": True,
                "requires_route_tca": True,
                "rejects_no_delay_fill_assumptions": True,
            }
        )

    if has_any(
        (
            "ohlcv-only",
            "ohlcv only",
            "ohlcv_derived",
            "ohlcv-derived",
            "bar-only",
            "bar only",
            "systematic falsification",
        )
    ):
        overlay_ids.append("ohlcv_only_falsification")
        overlay_contracts.append(
            {
                "overlay_id": "ohlcv_only_falsification",
                "required_evidence": [
                    "walk_forward_replay",
                    "executable_quote_evidence",
                    "route_tca",
                    "live_paper_parity",
                ],
                "evidence_policy": "ohlcv_only_is_falsification_not_promotion_proof",
            }
        )
        hard_vetoes.update(
            {
                "required_min_ohlcv_falsification_trade_count": "120",
                "required_min_ohlcv_walk_forward_split_count": "4",
                "required_min_ohlcv_stable_split_pass_rate": "0.60",
                "required_max_ohlcv_best_split_share": "0.35",
                "required_min_route_tca_sample_count": "60",
                "required_executable_quote_evidence": True,
            }
        )
        promotion_contract.update(
            {
                "rejects_ohlcv_only_promotion_evidence": True,
                "requires_walk_forward_replay": True,
                "requires_executable_quote_evidence": True,
                "requires_route_tca": True,
                "requires_minimum_trade_count": True,
                "requires_multi_year_stability_check": True,
                "rejects_naive_gross_ohlcv_backtests": True,
                "positive_control_policy": (
                    "gap_continuation_only_until_post_cost_live_paper_proof"
                ),
            }
        )

    if not overlay_ids:
        return {}
    return {
        "feature_contract": {
            "mechanism_overlays": overlay_contracts,
        },
        "parameter_space": {
            "mechanism_overlay_ids": overlay_ids,
        },
        "hard_vetoes": hard_vetoes,
        "promotion_contract": promotion_contract,
    }


def _apply_mechanism_overlay_strategy_params(
    strategy_overrides: Mapping[str, Any],
    mechanism_overlays: Mapping[str, Any],
) -> dict[str, Any]:
    overlay_ids = set(
        _string_sequence(
            _mapping(mechanism_overlays.get("parameter_space")).get(
                "mechanism_overlay_ids"
            )
        )
    )
    if not (
        {
            "mixed_market_limit_execution_policy",
            "crumbling_quote_liquidity_erosion",
            "friction_aware_regime_conditioned_policy",
        }
        & overlay_ids
    ):
        return dict(strategy_overrides)
    next_overrides = dict(strategy_overrides)
    params = _mapping(next_overrides.get("params"))
    if "mixed_market_limit_execution_policy" in overlay_ids:
        params.setdefault("entry_order_type", "prefer_limit")
        params.setdefault("market_order_spread_bps_max", "6")
    if "crumbling_quote_liquidity_erosion" in overlay_ids:
        params.setdefault("entry_order_type", "prefer_limit")
        params.setdefault("market_order_spread_bps_max", "6")
        params.setdefault("max_recent_quote_invalid_ratio", "0.12")
        params.setdefault("max_recent_quote_jump_bps", "40")
    if "friction_aware_regime_conditioned_policy" in overlay_ids:
        params.setdefault("cost_model_profile", "proportional_plus_impact")
        params.setdefault("turnover_budget_profile", "trade_space_trust_region")
        params.setdefault("regime_conditioning_profile", "volatility_liquidity")
    next_overrides["params"] = params
    return next_overrides


def _family_scores_for_hypothesis(
    card: HypothesisCard,
) -> list[tuple[str, int, tuple[str, ...]]]:
    haystack = _hypothesis_haystack(card)
    scores = {family_template_id: 0 for family_template_id in _FAMILY_RUNTIME}
    reasons: dict[str, list[str]] = {
        family_template_id: [] for family_template_id in _FAMILY_RUNTIME
    }

    def bump(family_template_id: str, score: int, reason: str) -> None:
        scores[family_template_id] += score
        if reason not in reasons[family_template_id]:
            reasons[family_template_id].append(reason)

    def has_any(tokens: Sequence[str]) -> bool:
        return any(token in haystack for token in tokens)

    if has_any(
        (
            "scale-invariant",
            "normalization",
            "matched-filter",
            "matched_filter",
            "representation",
            "portable lob",
            "portable_lob",
            "feature stability",
            "feature_stability",
            "shap",
        )
    ):
        bump(
            "microstructure_continuation_matched_filter_v1",
            6,
            "representation_or_normalization",
        )
        bump("microbar_cross_sectional_pairs_v1", 2, "microstructure_representation")
    if has_any(
        (
            "kanformer",
            "queue-position",
            "queue position",
            "queue_position",
            "time-to-fill",
            "time to fill",
            "time_to_fill",
            "survival analysis",
            "survival model",
            "survival_fill_curve",
            "fill survival",
            "fill_survival",
            "fill probability",
            "fill probabilities",
            "nonfill opportunity cost",
            "nonfill_opportunity_cost",
        )
    ):
        bump(
            "microstructure_continuation_matched_filter_v1",
            6,
            "queue_position_survival_fill_curve",
        )
        bump(
            "microbar_cross_sectional_pairs_v1", 3, "queue_position_survival_fill_curve"
        )

    if has_any(
        (
            "alpha decay",
            "alpha_decay",
            "predictability decay",
            "predictability_decay",
            "declined over time",
            "short-run market efficiency",
            "market efficiency",
            "t-kan",
            "tkan",
            "temporal kolmogorov",
            "tlob",
            "dual attention",
            "horizon bias",
            "spread-adjusted",
            "algorithmic activity",
            "tight spreads",
            "heavier trading",
            "high-volume regimes",
        )
    ):
        bump(
            "microstructure_continuation_matched_filter_v1",
            5,
            "alpha_decay_predictability_stress",
        )
        bump("intraday_tsmom_v2", 3, "alpha_decay_predictability_stress")
        bump(
            "microbar_cross_sectional_pairs_v1",
            3,
            "alpha_decay_predictability_stress",
        )

    if has_any(
        (
            "order flow",
            "order-flow",
            "order_flow",
            "trade-flow",
            "trade flow",
            "ofi",
            "imbalance",
            "lob",
            "limit order book",
            "signed order flow",
            "signed_order_flow",
            "core flow",
            "core_flow",
            "filtered orderbook imbalance",
            "filtered_orderbook_imbalance",
            "parent order",
            "parent_order",
        )
    ):
        bump("microbar_cross_sectional_pairs_v1", 5, "order_flow_or_lob_signal")
        bump(
            "microstructure_continuation_matched_filter_v1",
            4,
            "order_flow_or_lob_signal",
        )
        bump(
            "opening_drive_leader_reclaim_v1",
            3,
            "order_flow_or_lob_signal",
        )
    if has_any(
        (
            "rejected trading event",
            "rejected event",
            "rejected-event",
            "rejected signal",
            "rejected_signal",
            "skipped signal",
            "skipped-signal",
            "counterfactual outcome",
            "counterfactual return",
            "outcome labels",
            "outcome_labels",
            "veto calibration",
            "vetoes discard",
            "discard profitable",
        )
    ):
        bump(
            "microstructure_continuation_matched_filter_v1",
            6,
            "rejected_signal_outcome_calibration",
        )
        bump(
            "microbar_cross_sectional_pairs_v1",
            4,
            "rejected_signal_outcome_calibration",
        )
        bump(
            "opening_drive_leader_reclaim_v1",
            4,
            "rejected_signal_outcome_calibration",
        )
    if has_any(
        (
            "cluster",
            "clustered",
            "self-exciting",
            "hawkes",
            "order arrival",
            "arrival clustering",
        )
    ):
        bump("intraday_tsmom_v2", 5, "clustered_arrival_regime")
        bump(
            "microstructure_continuation_matched_filter_v1",
            3,
            "clustered_arrival_regime",
        )
        bump("microbar_cross_sectional_pairs_v1", 2, "clustered_arrival_regime")
    impact_ranking_only = has_any(
        (
            "nonlinear impact",
            "nonlinear_impact",
            "square-root",
            "square root",
            "power-law market impact",
            "power law market impact",
            "almgren",
            "route/tca",
            "route_tca",
            "market impact stress",
            "impact stress",
        )
    )
    if has_any(
        (
            "liquidity",
            "execution",
            "shortfall",
            "spread",
            "market-maker",
            "market maker",
            "market impact",
            "market-impact",
            "power-law",
            "power law",
            "square-root",
            "square root",
            "nonlinear impact",
            "nonlinear_impact",
            "maker-taker",
            "maker taker",
        )
    ):
        if impact_ranking_only:
            bump(
                "microstructure_continuation_matched_filter_v1",
                6,
                "nonlinear_impact_route_tca_constraint",
            )
            bump(
                "microbar_cross_sectional_pairs_v1",
                3,
                "nonlinear_impact_route_tca_constraint",
            )
            bump(
                "intraday_tsmom_v2",
                2,
                "nonlinear_impact_route_tca_constraint",
            )
        else:
            bump(
                "mean_reversion_rebound_v1",
                4,
                "liquidity_response_or_execution_stress",
            )
            bump("washout_rebound_v2", 3, "liquidity_response_or_execution_stress")
            bump(
                "mean_reversion_exhaustion_short_v1",
                2,
                "liquidity_response_or_execution_stress",
            )
            bump(
                "microstructure_continuation_matched_filter_v1",
                3,
                "liquidity_response_or_execution_stress",
            )
    if has_any(
        (
            "volatility",
            "regime",
            "latent regime",
            "regime persistence",
            "stress window",
            "nearly unstable",
            "hidden markov",
            "hmm",
            "entropy",
            "fragility",
            "latent build-up",
            "latent_build_up",
            "rising-edge",
            "rising edge",
            "adaptive threshold",
            "forecast horizon",
            "forecast_horizon",
            "horizon-dependent",
            "horizon dependent",
            "regime-dependent",
            "regime dependent",
            "ofi memory",
            "ofi_memory",
            "response-ratio",
            "response ratio",
            "macro news",
            "macro-news",
            "macroeconomic news",
            "price-flow dynamics",
            "price flow dynamics",
            "flow impact",
            "flow_impact",
        )
    ):
        bump("intraday_tsmom_v2", 6, "volatility_or_regime_state")
        bump("momentum_pullback_v1", 2, "volatility_or_regime_state")
        bump("opening_drive_leader_reclaim_v1", 2, "volatility_or_regime_state")
        bump(
            "microstructure_continuation_matched_filter_v1",
            2,
            "volatility_or_regime_state",
        )
    if has_any(
        (
            "adverse selection",
            "adverse-selection",
            "toxicity",
            "toxic",
            "absorption",
            "passive buy",
            "passive-buy",
            "fill-side",
            "fill side",
            "quote attribution",
            "quote-attribution",
            "information value",
            "price-flow covariance",
            "price flow covariance",
            "kyle",
            "lambda",
        )
    ):
        bump(
            "microstructure_continuation_matched_filter_v1",
            5,
            "adverse_selection_or_liquidity_toxicity",
        )
        bump("mean_reversion_rebound_v1", 3, "adverse_selection_or_liquidity_toxicity")
        bump(
            "mean_reversion_exhaustion_short_v1",
            3,
            "adverse_selection_or_liquidity_toxicity",
        )
        bump(
            "microbar_cross_sectional_pairs_v1",
            2,
            "adverse_selection_or_liquidity_toxicity",
        )
    if has_any(
        (
            "factor dsl",
            "factor_dsl",
            "factor program",
            "factor_program",
            "append-only experiment trace",
            "append_only_experiment_trace",
            "hypothesis search",
            "constrained llm",
            "fixed splits",
            "fixed-split",
        )
    ):
        bump("microbar_cross_sectional_pairs_v1", 5, "constrained_factor_search")
        bump(
            "microstructure_continuation_matched_filter_v1",
            4,
            "constrained_factor_search",
        )
        bump("intraday_tsmom_v2", 3, "constrained_factor_search")
    if has_any(("momentum", "trend", "pullback", "trend persistence")):
        bump("momentum_pullback_v1", 5, "momentum_or_pullback")
        bump("intraday_tsmom_v2", 4, "momentum_or_pullback")
        bump("opening_drive_leader_reclaim_v1", 3, "momentum_or_pullback")
    if has_any(
        (
            "weighted microprice",
            "microprice momentum",
            "multi-window",
            "multi-level order book",
            "multi level order book",
        )
    ):
        bump(
            "microstructure_continuation_matched_filter_v1",
            4,
            "microprice_or_multi_level_order_book",
        )
        bump(
            "opening_drive_leader_reclaim_v1",
            3,
            "microprice_or_multi_level_order_book",
        )
        bump("breakout_reclaim_v2", 2, "microprice_or_multi_level_order_book")
    if has_any(
        (
            "late-day",
            "late day",
            "late-session",
            "late session",
            "final half-hour",
            "end-of-day",
            "end of day",
            "eod",
            "closing",
            "into the close",
            "macro announcement",
            "announcement",
            "portfolio adjustment",
            "vwap exit",
            "ladder exit",
        )
    ):
        bump("late_day_continuation_v1", 6, "late_session_or_announcement_momentum")
        bump("end_of_day_reversal_v1", 4, "late_session_or_announcement_momentum")
        bump("intraday_tsmom_v2", 2, "late_session_or_announcement_momentum")
        bump("momentum_pullback_v1", 2, "late_session_or_announcement_momentum")
    if has_any(
        (
            "final 30",
            "final half-hour",
            "end-of-day reversal",
            "end of day reversal",
            "eod reversal",
            "intraday loser",
            "intraday losers",
            "late-session loser",
            "late session loser",
            "closing-window",
            "closing window",
            "close reversion",
        )
    ):
        bump("end_of_day_reversal_v1", 7, "closing_window_reversal")
    if has_any(
        (
            "breakout",
            "continuation",
            "reclaim",
            "leader",
            "opening range breakout",
            "orb",
            "stocks in play",
            "overactive stocks",
        )
    ):
        bump("breakout_reclaim_v2", 5, "continuation_or_reclaim")
        bump(
            "microstructure_continuation_matched_filter_v1",
            2,
            "continuation_or_reclaim",
        )
    if has_any(
        (
            "first half-hour",
            "first half hour",
            "first 30",
            "morning momentum",
            "opening drive",
            "opening-drive",
            "opening range",
            "opening-range",
            "opening range breakout",
            "opening window",
            "open window",
            "leader reclaim",
            "stocks in play",
            "unusually high daily volume",
            "macro announcement",
            "announcement",
            "information discreteness",
        )
    ):
        bump("opening_drive_leader_reclaim_v1", 7, "morning_or_announcement_momentum")
        bump("late_day_continuation_v1", 3, "morning_or_announcement_momentum")
        bump("intraday_tsmom_v2", 2, "morning_or_announcement_momentum")
    if has_any(("washout", "reversal", "rebound", "mean reversion", "dislocation")):
        bump("washout_rebound_v2", 5, "reversal_or_rebound")
        bump("mean_reversion_rebound_v1", 5, "reversal_or_rebound")
        bump("mean_reversion_exhaustion_short_v1", 3, "reversal_or_rebound")
        bump("end_of_day_reversal_v1", 4, "reversal_or_rebound")
    if has_any(
        (
            "short-side",
            "short side",
            "short sleeve",
            "short-selling",
            "short selling",
            "short fade",
            "fade",
            "exhaustion",
            "overbought",
            "offer pressure",
            "weakness",
            "downside",
            "upside extension",
        )
    ):
        bump("mean_reversion_exhaustion_short_v1", 7, "short_exhaustion_fade")
    if has_any(("relative_volume", "relative volume", "turnover")):
        bump("intraday_tsmom_v2", 2, "relative_volume_or_turnover")
        bump("breakout_reclaim_v2", 2, "relative_volume_or_turnover")
    if has_any(
        (
            "intraday volume",
            "volume forecasting",
            "volume forecast",
            "volume periodicity",
            "periodic volume",
            "vwap",
            "volume weighted average price",
            "volume-weighted average price",
            "u-shape",
            "u shaped",
            "u-shaped",
        )
    ):
        bump("opening_drive_leader_reclaim_v1", 10, "volume_periodicity_execution")
        bump("late_day_continuation_v1", 8, "volume_periodicity_execution")
        bump("intraday_tsmom_v2", 7, "volume_periodicity_execution")
        bump("breakout_reclaim_v2", 6, "volume_periodicity_execution")

    if not any(scores.values()):
        bump("microbar_cross_sectional_pairs_v1", 1, "default_executable_microbar")

    return sorted(
        (
            (family_template_id, score, tuple(reasons[family_template_id]))
            for family_template_id, score in scores.items()
            if score > 0
        ),
        key=lambda item: (-item[1], _FAMILY_TIEBREAK.get(item[0], 10**6), item[0]),
    )


def _families_for_hypothesis(
    card: HypothesisCard, *, target_net_pnl_per_day: Decimal = Decimal("300")
) -> tuple[tuple[str, int, tuple[str, ...]], ...]:
    scored = _family_scores_for_hypothesis(card)
    rejected_signal_rescue = _has_rejected_signal_outcome_calibration(card)
    if rejected_signal_rescue or _is_validation_or_execution_constraint_only(card):
        family_limit = _MAX_FAMILIES_PER_HYPOTHESIS
    else:
        family_limit = (
            _PORTFOLIO_SLEEVE_FAMILY_TARGET
            if target_net_pnl_per_day >= _PORTFOLIO_TARGET_NET_PNL_PER_DAY
            else _MAX_FAMILIES_PER_HYPOTHESIS
        )
    selected = list(scored[:family_limit])
    if family_limit <= _MAX_FAMILIES_PER_HYPOTHESIS:
        return tuple(selected)

    selected_family_ids = {family_template_id for family_template_id, _, _ in selected}
    for family_template_id in _PORTFOLIO_SLEEVE_FAMILY_ORDER:
        if len(selected) >= family_limit:
            break
        if family_template_id in selected_family_ids:
            continue
        selected.append(
            (
                family_template_id,
                0,
                ("portfolio_sleeve_diversification",),
            )
        )
        selected_family_ids.add(family_template_id)
    return tuple(selected)


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


@dataclass(frozen=True)
class CandidateSpec:
    schema_version: Literal["torghut.candidate-spec.v1"]
    candidate_spec_id: str
    hypothesis_id: str
    family_template_id: str
    candidate_kind: Literal[
        "family", "sleeve", "portfolio", "algorithm", "configuration"
    ]
    runtime_family: str
    runtime_strategy_name: str
    feature_contract: Mapping[str, Any]
    parameter_space: Mapping[str, Any]
    strategy_overrides: Mapping[str, Any]
    objective: Mapping[str, Any]
    hard_vetoes: Mapping[str, Any]
    expected_failure_modes: tuple[str, ...]
    promotion_contract: Mapping[str, Any]

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "candidate_spec_id": self.candidate_spec_id,
            "hypothesis_id": self.hypothesis_id,
            "family_template_id": self.family_template_id,
            "candidate_kind": self.candidate_kind,
            "runtime_family": self.runtime_family,
            "runtime_strategy_name": self.runtime_strategy_name,
            "feature_contract": dict(self.feature_contract),
            "parameter_space": dict(self.parameter_space),
            "strategy_overrides": dict(self.strategy_overrides),
            "objective": dict(self.objective),
            "hard_vetoes": dict(self.hard_vetoes),
            "expected_failure_modes": list(self.expected_failure_modes),
            "promotion_contract": dict(self.promotion_contract),
            "candidate_authority": "discovery_probation_input_only",
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
        }

    def to_vnext_experiment_payload(
        self, *, experiment_id: str | None = None
    ) -> dict[str, Any]:
        return {
            "experiment_id": experiment_id or f"{self.candidate_spec_id}-exp",
            "family_template_id": self.family_template_id,
            "hypothesis": self.feature_contract.get("mechanism"),
            "paper_claim_links": list(
                cast(Sequence[str], self.feature_contract.get("source_claim_ids") or [])
            ),
            "dataset_snapshot_policy": {
                "source": "historical_market_replay",
                "window_size": "PT1S",
            },
            "template_overrides": dict(self.strategy_overrides),
            "feature_variants": list(
                cast(
                    Sequence[str],
                    self.feature_contract.get("normalization_candidates") or [],
                )
            ),
            "veto_controller_variants": [],
            "selection_objectives": dict(self.objective),
            "hard_vetoes": dict(self.hard_vetoes),
            "expected_failure_modes": list(self.expected_failure_modes),
            "promotion_contract": dict(self.promotion_contract),
            "candidate_spec": self.to_payload(),
        }


def candidate_spec_id_for_payload(payload: Mapping[str, Any]) -> str:
    return f"spec-{_stable_hash(payload)[:24]}"


def compile_candidate_specs(
    *,
    hypothesis_cards: Sequence[HypothesisCard],
    target_net_pnl_per_day: Decimal = Decimal("300"),
    universe_symbols: Sequence[str] = (),
) -> list[CandidateSpec]:
    specs: list[CandidateSpec] = []
    explicit_universe_symbols = _universe_symbol_override(universe_symbols)
    for card in hypothesis_cards:
        include_false_negative_rescue = _has_rejected_signal_outcome_calibration(card)
        for family_rank, (
            family_template_id,
            family_score,
            family_reasons,
        ) in enumerate(
            _families_for_hypothesis(
                card, target_net_pnl_per_day=target_net_pnl_per_day
            ),
            start=1,
        ):
            runtime_family, runtime_strategy_name = _FAMILY_RUNTIME[family_template_id]
            for execution_profile_index in _execution_profile_indexes(
                card=card,
                family_template_id=family_template_id,
                family_rank=family_rank,
                target_net_pnl_per_day=target_net_pnl_per_day,
                include_false_negative_rescue=include_false_negative_rescue,
            ):
                execution_profile_id = _execution_profile_id(
                    family_template_id=family_template_id,
                    profile_index=execution_profile_index,
                )
                strategy_overrides = _strategy_overrides_for_profile(
                    family_template_id=family_template_id,
                    profile_index=execution_profile_index,
                    target_net_pnl_per_day=target_net_pnl_per_day,
                    include_false_negative_rescue=include_false_negative_rescue,
                )
                if explicit_universe_symbols:
                    strategy_overrides = {
                        **strategy_overrides,
                        "universe_symbols": list(explicit_universe_symbols),
                    }
                feature_contract: dict[str, Any] = {
                    "source_run_id": card.source_run_id,
                    "source_claim_ids": list(card.source_claim_ids),
                    "mechanism": card.mechanism,
                    "asset_scope": card.asset_scope,
                    "horizon_scope": card.horizon_scope,
                    "expected_direction": card.expected_direction,
                    "required_features": list(card.required_features),
                    "entry_motifs": list(card.entry_motifs),
                    "exit_motifs": list(card.exit_motifs),
                    "expected_regimes": list(card.expected_regimes),
                    "normalization_candidates": list(
                        _normalization_candidates_for_card(card)
                    ),
                    "family_selection": {
                        "rank": family_rank,
                        "score": family_score,
                        "reasons": list(family_reasons),
                    },
                    "execution_profile": {
                        "profile_id": execution_profile_id,
                        "profile_index": execution_profile_index,
                    },
                }
                claim_relation_blockers = _list_of_mappings(
                    card.implementation_constraints.get("claim_relation_blockers")
                )
                if claim_relation_blockers:
                    feature_contract["claim_relation_blockers"] = [
                        dict(item) for item in claim_relation_blockers
                    ]
                validation_requirements = _list_of_mappings(
                    card.implementation_constraints.get("validation_requirements")
                )
                if validation_requirements:
                    feature_contract["validation_requirements"] = [
                        dict(item) for item in validation_requirements
                    ]
                source_claims = _list_of_mappings(
                    card.implementation_constraints.get("source_claims")
                )
                if source_claims:
                    feature_contract["source_claims"] = [
                        dict(item) for item in source_claims
                    ]
                objective = {
                    "target_net_pnl_per_day": str(target_net_pnl_per_day),
                    "require_positive_day_ratio": "0.60",
                }
                hard_vetoes = {
                    "required_min_active_day_ratio": "0.90",
                    "required_min_daily_notional": "300000",
                    "required_max_best_day_share": "0.25",
                    "required_max_worst_day_loss": "350",
                    "required_max_drawdown": "900",
                    "required_min_regime_slice_pass_rate": "0.45",
                }
                parameter_space: dict[str, Any] = {
                    "mode": "bounded_grid",
                    "source": "whitepaper_autoresearch",
                    "family_selection_rank": family_rank,
                    "execution_profile_id": execution_profile_id,
                    "execution_profile_index": execution_profile_index,
                    "parameter_override_keys": sorted(
                        str(key)
                        for key in _mapping(strategy_overrides.get("params")).keys()
                    ),
                }
                promotion_contract: dict[str, Any] = {
                    "source": "whitepaper_autoresearch_profit_target",
                    "target_net_pnl_per_day": str(target_net_pnl_per_day),
                    "requires_scheduler_v3_parity_replay": True,
                    "requires_scheduler_v3_approval_replay": True,
                    "requires_shadow_validation": True,
                    "promotion_policy": "research_only",
                }
                if family_template_id == "microbar_cross_sectional_pairs_v1":
                    feature_contract["hpairs_microstructure_prefilter_contract"] = {
                        "schema_version": "torghut.hpairs-microstructure-prefilter-contract.v1",
                        "clusterlob_adapter": "consume_lob_or_microbar_order_flow_fields_only",
                        "fallback_policy": (
                            "deterministic_microbar_order_flow_fallback_with_explicit_blockers"
                        ),
                        "horizon_ofi_microbars": [3, 12, 36],
                        "macro_window_concentration_metadata": True,
                        "impact_capacity_lineage": (
                            "square_root_power_law_prefilter_only_requires_source_backed_adv"
                        ),
                        "ranking_authority": "candidate_discovery_prefilter_only",
                    }
                    parameter_space["hpairs_microstructure_prefilter"] = {
                        "enabled": True,
                        "bounded_frontier_handoff": True,
                        "proof_source": "prefilter_only",
                        "promotion_allowed": False,
                        "final_promotion_allowed": False,
                    }
                    promotion_contract.update(
                        {
                            "hpairs_microstructure_prefilter_is_not_promotion_proof": True,
                            "hpairs_microstructure_prefilter_requires_exact_replay": True,
                            "hpairs_microstructure_prefilter_requires_runtime_ledger": True,
                        }
                    )
                if validation_requirements:
                    promotion_contract["validation_requirement_claim_ids"] = [
                        str(item.get("claim_id"))
                        for item in validation_requirements
                        if str(item.get("claim_id") or "").strip()
                    ]
                if _requires_synthetic_validation_only_policy(card):
                    promotion_contract.update(
                        {
                            "requires_historical_replay": True,
                            "requires_live_paper_parity": True,
                            "synthetic_evidence_policy": (
                                "validation_only_not_promotion_proof"
                            ),
                        }
                    )
                mechanism_overlays = _mechanism_overlays_for_card(card)
                strategy_overrides = _apply_mechanism_overlay_strategy_params(
                    strategy_overrides,
                    mechanism_overlays,
                )
                feature_contract.update(
                    _mapping(mechanism_overlays.get("feature_contract"))
                )
                parameter_space.update(
                    _mapping(mechanism_overlays.get("parameter_space"))
                )
                hard_vetoes.update(_mapping(mechanism_overlays.get("hard_vetoes")))
                promotion_contract.update(
                    _mapping(mechanism_overlays.get("promotion_contract"))
                )
                _apply_factor_acceptance_harness(
                    card=card,
                    feature_contract=feature_contract,
                    parameter_space=parameter_space,
                    strategy_overrides=strategy_overrides,
                    hard_vetoes=hard_vetoes,
                    promotion_contract=promotion_contract,
                )
                replay_guidance_profile = _string(
                    _mapping(strategy_overrides.get("params")).get(
                        "replay_ledger_guidance_profile"
                    )
                )
                if replay_guidance_profile:
                    parameter_space.update(
                        {
                            "replay_ledger_guided_candidate_expansion": True,
                            "replay_ledger_guidance_profile": replay_guidance_profile,
                        }
                    )
                    promotion_contract.update(
                        {
                            "requires_runtime_ledger_profit_proof": True,
                            "requires_source_backed_runtime_ledger": True,
                            "replay_ledger_guided_search_is_not_promotion_proof": True,
                        }
                    )
                base_payload = {
                    "hypothesis_id": card.hypothesis_id,
                    "family_template_id": family_template_id,
                    "feature_contract": feature_contract,
                    "parameter_space": parameter_space,
                    "strategy_overrides": strategy_overrides,
                    "objective": objective,
                }
                specs.append(
                    CandidateSpec(
                        schema_version=CANDIDATE_SPEC_SCHEMA_VERSION,
                        candidate_spec_id=candidate_spec_id_for_payload(base_payload),
                        hypothesis_id=card.hypothesis_id,
                        family_template_id=family_template_id,
                        candidate_kind="sleeve",
                        runtime_family=runtime_family,
                        runtime_strategy_name=runtime_strategy_name,
                        feature_contract=feature_contract,
                        parameter_space=parameter_space,
                        strategy_overrides=strategy_overrides,
                        objective=objective,
                        hard_vetoes=hard_vetoes,
                        expected_failure_modes=card.failure_modes,
                        promotion_contract=promotion_contract,
                    )
                )
    return specs


def candidate_spec_from_payload(payload: Mapping[str, Any]) -> CandidateSpec:
    schema_version = _string(payload.get("schema_version"))
    if schema_version != CANDIDATE_SPEC_SCHEMA_VERSION:
        raise ValueError(f"candidate_spec_schema_invalid:{schema_version}")
    return CandidateSpec(
        schema_version=CANDIDATE_SPEC_SCHEMA_VERSION,
        candidate_spec_id=_string(payload.get("candidate_spec_id")),
        hypothesis_id=_string(payload.get("hypothesis_id")),
        family_template_id=_string(payload.get("family_template_id")),
        candidate_kind=cast(Any, _string(payload.get("candidate_kind")) or "sleeve"),
        runtime_family=_string(payload.get("runtime_family")),
        runtime_strategy_name=_string(payload.get("runtime_strategy_name")),
        feature_contract=_mapping(payload.get("feature_contract")),
        parameter_space=_mapping(payload.get("parameter_space")),
        strategy_overrides=_mapping(payload.get("strategy_overrides")),
        objective=_mapping(payload.get("objective")),
        hard_vetoes=_mapping(payload.get("hard_vetoes")),
        expected_failure_modes=tuple(
            str(item)
            for item in cast(Sequence[Any], payload.get("expected_failure_modes") or [])
        ),
        promotion_contract=_mapping(payload.get("promotion_contract")),
    )
