"""Identity rules for market-neutral pair-entry decisions."""

from __future__ import annotations

from .models import StrategyDecision

PAIR_ENTRY_RATIONALE = "microbar_cross_sectional_pair_entry"


def is_pair_entry(decision: StrategyDecision) -> bool:
    """Return whether a decision belongs to an atomic market-neutral pair."""

    return PAIR_ENTRY_RATIONALE in {
        token.strip() for token in str(decision.rationale or "").split(",")
    }


__all__ = ["PAIR_ENTRY_RATIONALE", "is_pair_entry"]
