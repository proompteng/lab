"""Rejected-signal rescue execution profiles for candidate specs."""

from __future__ import annotations

from typing import Any

from .candidate_spec_profile_constants import (
    PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE as _PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE,
    PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE as _PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE,
)

REJECTED_SIGNAL_FALSE_NEGATIVE_RESCUE_EXECUTION_PROFILES: dict[
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

__all__ = ("REJECTED_SIGNAL_FALSE_NEGATIVE_RESCUE_EXECUTION_PROFILES",)
