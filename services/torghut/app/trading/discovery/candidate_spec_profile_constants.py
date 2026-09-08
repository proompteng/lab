"""Candidate-spec runtime family and universe profile constants."""

from __future__ import annotations

from decimal import Decimal

from app.trading.semiconductor_universe import (
    LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE,
    RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE,
)


FAMILY_RUNTIME = {
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

FAMILY_TIEBREAK = {
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
MAX_FAMILIES_PER_HYPOTHESIS = 3
PORTFOLIO_TARGET_NET_PNL_PER_DAY = Decimal("500")
PORTFOLIO_SLEEVE_FAMILY_TARGET = len(FAMILY_RUNTIME)
PORTFOLIO_SLEEVE_FAMILY_ORDER = (
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
DEFAULT_PROFILE_COUNT = 3

RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE_PROFILE = RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE
AI_ACCELERATOR_UNIVERSE_PROFILE: tuple[str, ...] = (
    "NVDA",
    "AVGO",
    "AMD",
)
LIQUID_TECH_PLATFORM_UNIVERSE_PROFILE: tuple[str, ...] = (
    "AAPL",
    "AMZN",
    "GOOGL",
    "ORCL",
    "INTC",
)
BROAD_SEMICONDUCTOR_UNIVERSE_PROFILE: tuple[str, ...] = (
    RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE_PROFILE
)
PORTFOLIO_COVERAGE_UNIVERSE_PROFILE: tuple[str, ...] = (
    "NVDA",
    "AAPL",
    "AMD",
    "AVGO",
    "INTC",
    "ORCL",
    "AMZN",
    "GOOGL",
)
PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE = AI_ACCELERATOR_UNIVERSE_PROFILE
PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE = LIQUID_TECH_PLATFORM_UNIVERSE_PROFILE

LARGE_CAP_UNIVERSE_PROFILES: tuple[tuple[str, ...], ...] = (
    AI_ACCELERATOR_UNIVERSE_PROFILE,
    LIQUID_TECH_PLATFORM_UNIVERSE_PROFILE,
    BROAD_SEMICONDUCTOR_UNIVERSE_PROFILE,
)
BREAKOUT_UNIVERSE_PROFILES: tuple[tuple[str, ...], ...] = (
    AI_ACCELERATOR_UNIVERSE_PROFILE,
    ("NVDA", "AVGO", "AMD", "ORCL", "INTC"),
    BROAD_SEMICONDUCTOR_UNIVERSE_PROFILE,
)
REVERSAL_UNIVERSE_PROFILES: tuple[tuple[str, ...], ...] = (
    ("AMD", "INTC", "ORCL", "AAPL"),
    ("AMD", "INTC", "ORCL", "AAPL", "AMZN", "GOOGL", "AVGO"),
    BROAD_SEMICONDUCTOR_UNIVERSE_PROFILE,
)
TSMOM_UNIVERSE_PROFILES: tuple[tuple[str, ...], ...] = (
    ("NVDA",),
    ("NVDA", "AVGO", "AMD", "INTC"),
    BROAD_SEMICONDUCTOR_UNIVERSE_PROFILE,
)


__all__ = (
    "LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE",
    "RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE",
    "FAMILY_RUNTIME",
    "FAMILY_TIEBREAK",
    "MAX_FAMILIES_PER_HYPOTHESIS",
    "PORTFOLIO_TARGET_NET_PNL_PER_DAY",
    "PORTFOLIO_SLEEVE_FAMILY_TARGET",
    "PORTFOLIO_SLEEVE_FAMILY_ORDER",
    "DEFAULT_PROFILE_COUNT",
    "RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE_PROFILE",
    "AI_ACCELERATOR_UNIVERSE_PROFILE",
    "LIQUID_TECH_PLATFORM_UNIVERSE_PROFILE",
    "BROAD_SEMICONDUCTOR_UNIVERSE_PROFILE",
    "PORTFOLIO_COVERAGE_UNIVERSE_PROFILE",
    "PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE",
    "PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE",
    "LARGE_CAP_UNIVERSE_PROFILES",
    "BREAKOUT_UNIVERSE_PROFILES",
    "REVERSAL_UNIVERSE_PROFILES",
    "TSMOM_UNIVERSE_PROFILES",
)
