"""Candidate spec compilation from typed whitepaper hypotheses."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Literal, Mapping, Sequence, cast

from app.trading.discovery.hypothesis_cards import HypothesisCard


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
    "microbar_cross_sectional_pairs_v1": (
        "microbar_cross_sectional_pairs",
        "microbar-cross-sectional-pairs-v1",
    ),
    "microstructure_continuation_matched_filter_v1": (
        "breakout_continuation_consistent",
        "breakout-continuation-long-v1",
    ),
    "intraday_tsmom_v2": ("intraday_tsmom_consistent", "intraday-tsmom-profit-v3"),
}

_FAMILY_TIEBREAK = {
    family_template_id: index
    for index, family_template_id in enumerate(
        (
            "microstructure_continuation_matched_filter_v1",
            "microbar_cross_sectional_pairs_v1",
            "intraday_tsmom_v2",
            "momentum_pullback_v1",
            "breakout_reclaim_v2",
            "washout_rebound_v2",
            "mean_reversion_rebound_v1",
        )
    )
}
_MAX_FAMILIES_PER_HYPOTHESIS = 3
_DEFAULT_PROFILE_COUNT = 3

_LARGE_CAP_UNIVERSE_PROFILES: tuple[tuple[str, ...], ...] = (
    ("AAPL", "AMAT", "GOOG", "MSFT", "MU", "NVDA", "SHOP"),
    ("AAPL", "AMAT", "AMD", "GOOG", "INTC", "META", "MSFT", "MU", "NVDA", "SHOP"),
    ("AAPL", "AMD", "GOOG", "META", "MSFT", "MU", "NVDA", "PLTR", "SHOP"),
)
_BREAKOUT_UNIVERSE_PROFILES: tuple[tuple[str, ...], ...] = (
    ("AMAT", "GOOG", "INTC", "META", "MSFT", "MU", "NVDA", "PLTR", "SHOP"),
    ("AMAT", "GOOG", "INTC", "MSFT", "MU", "NVDA", "SHOP"),
    ("AAPL", "AMAT", "AMD", "GOOG", "META", "MSFT", "MU", "NVDA", "SHOP"),
)
_REVERSAL_UNIVERSE_PROFILES: tuple[tuple[str, ...], ...] = (
    ("AMD", "INTC", "SHOP", "AMAT", "MU"),
    ("AMD", "INTC", "SHOP", "AMAT", "MU", "GOOG", "MSFT"),
    ("AAPL", "AMD", "AMAT", "INTC", "MSFT", "MU", "NVDA", "SHOP"),
)
_TSMOM_UNIVERSE_PROFILES: tuple[tuple[str, ...], ...] = (
    ("NVDA",),
    ("NVDA", "AMAT"),
    ("NVDA", "AMAT", "AMD"),
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
    ),
    "mean_reversion_rebound_v1": (
        {
            "universe_symbols": list(_LARGE_CAP_UNIVERSE_PROFILES[1]) + ["PLTR"],
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
            "universe_symbols": list(_LARGE_CAP_UNIVERSE_PROFILES[1]) + ["PLTR"],
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
    "momentum_pullback_v1": (
        {
            "universe_symbols": list(_LARGE_CAP_UNIVERSE_PROFILES[1]) + ["AVGO", "PLTR"],
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
            "universe_symbols": list(_LARGE_CAP_UNIVERSE_PROFILES[1]) + ["AVGO", "PLTR"],
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
            "universe_symbols": list(_LARGE_CAP_UNIVERSE_PROFILES[2]) + ["AVGO"],
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
}


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
            "order flow",
            "order-flow",
            "order_flow",
            "trade-flow",
            "trade flow",
            "ofi",
            "imbalance",
            "lob",
            "limit order book",
        )
    ):
        bump("microbar_cross_sectional_pairs_v1", 5, "order_flow_or_lob_signal")
        bump(
            "microstructure_continuation_matched_filter_v1",
            4,
            "order_flow_or_lob_signal",
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
    if has_any(
        (
            "liquidity",
            "execution",
            "shortfall",
            "spread",
            "market-maker",
            "market maker",
        )
    ):
        bump("mean_reversion_rebound_v1", 4, "liquidity_response_or_execution_stress")
        bump("washout_rebound_v2", 3, "liquidity_response_or_execution_stress")
        bump(
            "microstructure_continuation_matched_filter_v1",
            3,
            "liquidity_response_or_execution_stress",
        )
    if has_any(("volatility", "regime", "stress window", "nearly unstable")):
        bump("intraday_tsmom_v2", 4, "volatility_or_regime_state")
        bump("momentum_pullback_v1", 2, "volatility_or_regime_state")
    if has_any(("momentum", "trend", "pullback", "trend persistence")):
        bump("momentum_pullback_v1", 5, "momentum_or_pullback")
        bump("intraday_tsmom_v2", 4, "momentum_or_pullback")
    if has_any(("breakout", "continuation", "reclaim", "leader")):
        bump("breakout_reclaim_v2", 5, "continuation_or_reclaim")
        bump(
            "microstructure_continuation_matched_filter_v1",
            2,
            "continuation_or_reclaim",
        )
    if has_any(("washout", "reversal", "rebound", "mean reversion", "dislocation")):
        bump("washout_rebound_v2", 5, "reversal_or_rebound")
        bump("mean_reversion_rebound_v1", 5, "reversal_or_rebound")
    if has_any(("relative_volume", "relative volume", "turnover")):
        bump("intraday_tsmom_v2", 2, "relative_volume_or_turnover")
        bump("breakout_reclaim_v2", 2, "relative_volume_or_turnover")

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
    card: HypothesisCard,
) -> tuple[tuple[str, int, tuple[str, ...]], ...]:
    return tuple(_family_scores_for_hypothesis(card)[:_MAX_FAMILIES_PER_HYPOTHESIS])


def _execution_profile_index(
    *,
    card: HypothesisCard,
    family_template_id: str,
    family_rank: int,
) -> int:
    profiles = _FAMILY_EXECUTION_PROFILES.get(family_template_id)
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


def _execution_profile_id(
    *, family_template_id: str, profile_index: int
) -> str:
    return f"{family_template_id}:profile-{profile_index + 1}"


def _strategy_overrides_for_profile(
    *, family_template_id: str, profile_index: int
) -> dict[str, Any]:
    profiles = _FAMILY_EXECUTION_PROFILES.get(family_template_id)
    if not profiles:
        return {"max_notional_per_trade": "50000"}
    selected = profiles[profile_index % len(profiles)]
    return json.loads(json.dumps(selected))


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
    target_net_pnl_per_day: Decimal = Decimal("500"),
) -> list[CandidateSpec]:
    specs: list[CandidateSpec] = []
    for card in hypothesis_cards:
        for family_rank, (
            family_template_id,
            family_score,
            family_reasons,
        ) in enumerate(_families_for_hypothesis(card), start=1):
            runtime_family, runtime_strategy_name = _FAMILY_RUNTIME[family_template_id]
            execution_profile_index = _execution_profile_index(
                card=card,
                family_template_id=family_template_id,
                family_rank=family_rank,
            )
            execution_profile_id = _execution_profile_id(
                family_template_id=family_template_id,
                profile_index=execution_profile_index,
            )
            strategy_overrides = _strategy_overrides_for_profile(
                family_template_id=family_template_id,
                profile_index=execution_profile_index,
            )
            feature_contract: dict[str, Any] = {
                "source_run_id": card.source_run_id,
                "source_claim_ids": list(card.source_claim_ids),
                "mechanism": card.mechanism,
                "required_features": list(card.required_features),
                "entry_motifs": list(card.entry_motifs),
                "exit_motifs": list(card.exit_motifs),
                "expected_regimes": list(card.expected_regimes),
                "normalization_candidates": ["price_scaled", "trading_value_scaled"],
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
            parameter_space = {
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
            promotion_contract = {
                "source": "whitepaper_autoresearch_profit_target",
                "target_net_pnl_per_day": str(target_net_pnl_per_day),
                "requires_scheduler_v3_parity_replay": True,
                "requires_scheduler_v3_approval_replay": True,
                "requires_shadow_validation": True,
                "promotion_policy": "research_only",
            }
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
