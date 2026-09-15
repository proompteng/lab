"""HPAIRS replay-ledger breadth profiles for candidate specs."""

from __future__ import annotations

from typing import Any

from .candidate_spec_profile_constants import (
    PORTFOLIO_COVERAGE_UNIVERSE_PROFILE as _PORTFOLIO_COVERAGE_UNIVERSE_PROFILE,
)

H_PAIRS_REPLAY_LEDGER_BREADTH_EXECUTION_PROFILES: tuple[dict[str, Any], ...] = (
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

__all__ = ("H_PAIRS_REPLAY_LEDGER_BREADTH_EXECUTION_PROFILES",)
