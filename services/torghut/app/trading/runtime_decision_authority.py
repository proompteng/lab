"""Source-decision authority labels for runtime-ledger proof."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

ROUTE_ACQUISITION_SOURCE_DECISION_MODE = "route_acquisition_probe"
STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE = "strategy_signal_paper"
BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE = (
    "bounded_paper_route_collection"
)
LIVE_STRATEGY_SIGNAL_SOURCE_DECISION_MODE = "live_strategy_signal"
SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER = (
    "source_decision_mode_not_profit_proof_eligible"
)
SOURCE_DECISION_MODE_PROFIT_PROOF_MISSING_BLOCKER = (
    "source_decision_mode_profit_proof_missing"
)

_ROUTE_ACQUISITION_ALIASES = frozenset(
    {
        "paper_route_acquisition",
        "paper_route_target_plan_source_decision",
        ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    }
)
_BOUNDED_PAPER_ROUTE_COLLECTION_ALIASES = frozenset(
    {
        "bounded_paper_route",
        "bounded_paper_route_source_decision",
        "bounded_paper_route_target_plan_source_decision",
        "bounded_live_paper_route_collection",
        BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    }
)
PROFIT_PROOF_ELIGIBLE_SOURCE_DECISION_MODES = frozenset(
    {
        BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
        STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
        LIVE_STRATEGY_SIGNAL_SOURCE_DECISION_MODE,
    }
)


def normalize_source_decision_mode(value: object) -> str | None:
    text = str(value or "").strip().lower().replace("-", "_")
    if not text:
        return None
    if text in _ROUTE_ACQUISITION_ALIASES:
        return ROUTE_ACQUISITION_SOURCE_DECISION_MODE
    if text in _BOUNDED_PAPER_ROUTE_COLLECTION_ALIASES:
        return BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
    return text


def source_decision_mode_is_profit_proof_eligible(value: object) -> bool:
    mode = normalize_source_decision_mode(value)
    return mode in PROFIT_PROOF_ELIGIBLE_SOURCE_DECISION_MODES


def source_decision_mode_counts_have_non_profit_proof_modes(value: Any) -> bool:
    if not isinstance(value, Mapping):
        return False
    for key, count in cast(Mapping[object, object], value).items():
        try:
            positive = int(str(count or "0")) > 0
        except (TypeError, ValueError):
            positive = False
        if positive and not source_decision_mode_is_profit_proof_eligible(key):
            return True
    return False


def source_decision_mode_counts_have_profit_proof_modes(value: Any) -> bool:
    if not isinstance(value, Mapping):
        return False
    for key, count in cast(Mapping[object, object], value).items():
        try:
            positive = int(str(count or "0")) > 0
        except (TypeError, ValueError):
            positive = False
        if positive and source_decision_mode_is_profit_proof_eligible(key):
            return True
    return False


__all__ = [
    "BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE",
    "LIVE_STRATEGY_SIGNAL_SOURCE_DECISION_MODE",
    "PROFIT_PROOF_ELIGIBLE_SOURCE_DECISION_MODES",
    "ROUTE_ACQUISITION_SOURCE_DECISION_MODE",
    "SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER",
    "SOURCE_DECISION_MODE_PROFIT_PROOF_MISSING_BLOCKER",
    "STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE",
    "normalize_source_decision_mode",
    "source_decision_mode_counts_have_non_profit_proof_modes",
    "source_decision_mode_counts_have_profit_proof_modes",
    "source_decision_mode_is_profit_proof_eligible",
]
