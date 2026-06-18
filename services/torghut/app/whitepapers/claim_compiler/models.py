"""Data types and claim-classification constants for whitepaper compilation."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping


MECHANISM_CLAIM_TYPES = frozenset(
    (
        "signal_mechanism",
        "feature_recipe",
        "normalization_rule",
        "portfolio_construction",
    )
)
FEATURE_RECIPE_CLAIM_TYPES = frozenset(("feature_recipe", "normalization_rule"))
FEATURE_BLOCKER_CLAIM_TYPES = frozenset(
    ("feature_missing_blocker", "data_gap", "feature_gap")
)
FEATURE_FIELD_KEYS = (
    "data_requirements",
    "required_features",
    "features",
    "feature_family_ids",
)
FEATURE_BLOCKER_RELATION_TYPES = frozenset(
    ("requires_feature", "missing_feature", "feature_missing")
)
RISK_VALIDATION_CLAIM_TYPES = frozenset(
    (
        "risk_constraint",
        "validation_requirement",
        "execution_assumption",
        "market_regime",
    )
)
RISK_VALIDATION_RELATION_TYPES = frozenset(
    ("contradicts", "requires_regime", "invalidates")
)


@dataclass(frozen=True)
class WhitepaperResearchSource:
    run_id: str
    title: str
    source_url: str
    published_at: str
    claims: tuple[Mapping[str, Any], ...]
    claim_relations: tuple[Mapping[str, Any], ...] = ()

    def to_payload(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "title": self.title,
            "source_url": self.source_url,
            "published_at": self.published_at,
            "claims": [dict(item) for item in self.claims],
            "claim_relations": [dict(item) for item in self.claim_relations],
        }
