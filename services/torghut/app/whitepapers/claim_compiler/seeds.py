"""Aggregate curated whitepaper seed sources."""

from __future__ import annotations

from .models import WhitepaperResearchSource
from .seed_sources_execution_risk import (
    RECENT_WHITEPAPER_EXECUTION_RISK_SEEDS,
)
from .seed_sources_microstructure import (
    RECENT_WHITEPAPER_MICROSTRUCTURE_SEEDS,
)
from .seed_sources_regime_factor import (
    RECENT_WHITEPAPER_REGIME_FACTOR_SEEDS,
)


RECENT_WHITEPAPER_SEEDS: tuple[WhitepaperResearchSource, ...] = (
    *RECENT_WHITEPAPER_MICROSTRUCTURE_SEEDS,
    *RECENT_WHITEPAPER_EXECUTION_RISK_SEEDS,
    *RECENT_WHITEPAPER_REGIME_FACTOR_SEEDS,
)

__all__ = [
    "RECENT_WHITEPAPER_EXECUTION_RISK_SEEDS",
    "RECENT_WHITEPAPER_MICROSTRUCTURE_SEEDS",
    "RECENT_WHITEPAPER_REGIME_FACTOR_SEEDS",
    "RECENT_WHITEPAPER_SEEDS",
]
