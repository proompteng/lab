"""Pure whitepaper claim compilation helpers for autoresearch."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence, cast

from app.trading.discovery.hypothesis_cards import (
    HypothesisCard,
    build_hypothesis_cards,
)


MECHANISM_CLAIM_TYPES = frozenset(
    ("signal_mechanism", "feature_recipe", "normalization_rule")
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


RECENT_WHITEPAPER_SEEDS: tuple[WhitepaperResearchSource, ...] = (
    WhitepaperResearchSource(
        run_id="seed-arxiv-2602-23784",
        title="TradeFM: A Generative Foundation Model for Trade-flow and Market Microstructure",
        source_url="https://arxiv.org/abs/2602.23784",
        published_at="2026-02-27",
        claims=(
            {
                "claim_id": "tradefm-scale-invariant-flow",
                "claim_type": "feature_recipe",
                "claim_text": (
                    "Scale-invariant trade-flow representations can capture transferable market "
                    "microstructure structure across equities."
                ),
                "asset_scope": "us_equities_intraday",
                "horizon_scope": "intraday_microstructure",
                "expected_direction": "positive",
                "data_requirements": ["trade_flow", "spread_bps", "relative_volume"],
                "confidence": "0.78",
            },
            {
                "claim_id": "tradefm-synthetic-stress",
                "claim_type": "validation_requirement",
                "claim_text": "Synthetic trade-flow rollouts should be used for stress testing rather than direct promotion.",
                "asset_scope": "us_equities_intraday",
                "horizon_scope": "intraday_microstructure",
                "expected_direction": "neutral",
                "confidence": "0.72",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-arxiv-2504-20349",
        title="ClusterLOB: Enhancing Trading Strategies by Clustering Orders in Limit Order Books",
        source_url="https://arxiv.org/abs/2504.20349",
        published_at="2025-04-29",
        claims=(
            {
                "claim_id": "clusterlob-clustered-ofi",
                "claim_type": "signal_mechanism",
                "claim_text": (
                    "Order-flow imbalance decomposed by participant-like clusters can improve "
                    "short-horizon trading signals over aggregate order-flow baselines."
                ),
                "asset_scope": "us_equities_intraday",
                "horizon_scope": "intraday",
                "expected_direction": "positive",
                "data_requirements": ["order_flow_imbalance", "clustered_order_events"],
                "confidence": "0.82",
            },
            {
                "claim_id": "clusterlob-robustness",
                "claim_type": "validation_requirement",
                "claim_text": "Signals should be validated across add, cancel, and trade event decompositions.",
                "asset_scope": "us_equities_intraday",
                "horizon_scope": "intraday",
                "expected_direction": "neutral",
                "confidence": "0.76",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-arxiv-2511-02016",
        title="ABIDES-MARL: A Multi-Agent Reinforcement Learning Environment for Endogenous Price Formation",
        source_url="https://arxiv.org/abs/2511.02016",
        published_at="2025-11-03",
        claims=(
            {
                "claim_id": "abides-liquidity-response-signal",
                "claim_type": "signal_mechanism",
                "claim_text": (
                    "Endogenous market-maker liquidity response in order-flow state can support "
                    "short-horizon execution-aware sizing signals after liquidity shocks."
                ),
                "asset_scope": "us_equities_intraday",
                "horizon_scope": "intraday_execution",
                "expected_direction": "positive",
                "data_requirements": [
                    "spread_bps",
                    "depth_proxy",
                    "execution_shortfall",
                ],
                "confidence": "0.73",
            },
            {
                "claim_id": "abides-endogenous-liquidity",
                "claim_type": "risk_constraint",
                "claim_text": (
                    "Execution policies should account for endogenous liquidity and market-maker response "
                    "when sizing intraday strategies."
                ),
                "asset_scope": "us_equities_intraday",
                "horizon_scope": "intraday_execution",
                "expected_direction": "positive",
                "data_requirements": [
                    "spread_bps",
                    "depth_proxy",
                    "execution_shortfall",
                ],
                "confidence": "0.74",
            },
            {
                "claim_id": "abides-market-maker-response-validation",
                "claim_type": "validation_requirement",
                "claim_text": (
                    "Replay promotion should stress market-maker response, spread widening, and execution "
                    "shortfall before using the signal in a portfolio sleeve."
                ),
                "asset_scope": "us_equities_intraday",
                "horizon_scope": "intraday_execution",
                "expected_direction": "neutral",
                "confidence": "0.71",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-arxiv-2510-08085",
        title="A Deterministic Limit Order Book Simulator with Hawkes-Driven Order Flow",
        source_url="https://arxiv.org/abs/2510.08085",
        published_at="2025-10-09",
        claims=(
            {
                "claim_id": "hawkes-clustered-arrival-signal",
                "claim_type": "signal_mechanism",
                "claim_text": (
                    "Self-exciting order arrivals can identify clustered liquidity-pressure windows where "
                    "microbar signals need regime-aware sizing."
                ),
                "asset_scope": "us_equities_intraday",
                "horizon_scope": "intraday_microstructure",
                "expected_direction": "positive",
                "data_requirements": [
                    "order_arrival_clustering",
                    "spread_bps",
                    "volatility_state",
                ],
                "confidence": "0.72",
            },
            {
                "claim_id": "hawkes-order-flow-clustering",
                "claim_type": "market_regime",
                "claim_text": (
                    "Nearly unstable order-flow clustering is important for reproducing realistic "
                    "microstructure stress regimes."
                ),
                "asset_scope": "us_equities_intraday",
                "horizon_scope": "intraday_microstructure",
                "expected_direction": "positive",
                "data_requirements": [
                    "order_arrival_clustering",
                    "spread_bps",
                    "volatility_state",
                ],
                "confidence": "0.70",
            },
            {
                "claim_id": "hawkes-clustering-stress-validation",
                "claim_type": "validation_requirement",
                "claim_text": (
                    "Candidate families should pass clustered-arrival stress windows before promotion to "
                    "avoid brittle behavior in nearly unstable flow regimes."
                ),
                "asset_scope": "us_equities_intraday",
                "horizon_scope": "intraday_microstructure",
                "expected_direction": "neutral",
                "confidence": "0.70",
            },
        ),
    ),
)


def _string(value: Any) -> str:
    return str(value or "").strip()


def _strings_from_value(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        values: Sequence[Any] = (value,)
    elif isinstance(value, list):
        values = cast(list[Any], value)
    elif isinstance(value, tuple):
        values = cast(tuple[Any, ...], value)
    elif isinstance(value, set):
        values = tuple(cast(set[Any], value))
    else:
        return ()
    resolved: list[str] = []
    for item in values:
        text = _string(item)
        if text and text not in resolved:
            resolved.append(text)
    return tuple(resolved)


def _claim_type(claim: Mapping[str, Any]) -> str:
    return _string(claim.get("claim_type")).lower()


def _claim_text(claim: Mapping[str, Any]) -> str:
    return _string(claim.get("claim_text")) or _string(claim.get("claim"))


def _relation_type(relation: Mapping[str, Any]) -> str:
    return _string(relation.get("relation_type")).lower()


def _claim_feature_terms(claim: Mapping[str, Any]) -> tuple[str, ...]:
    metadata = claim.get("metadata")
    metadata_payload: Mapping[str, Any] = (
        cast(Mapping[str, Any], metadata) if isinstance(metadata, Mapping) else {}
    )
    terms: list[str] = []
    for key in FEATURE_FIELD_KEYS:
        terms.extend(_strings_from_value(claim.get(key)))
        terms.extend(_strings_from_value(metadata_payload.get(key)))
    return tuple(dict.fromkeys(terms))


def _has_mechanism(claims: Sequence[Mapping[str, Any]]) -> bool:
    return any(
        _claim_type(claim) in MECHANISM_CLAIM_TYPES and bool(_claim_text(claim))
        for claim in claims
    )


def _has_feature_recipe_or_blocker(
    claims: Sequence[Mapping[str, Any]],
    relations: Sequence[Mapping[str, Any]],
) -> bool:
    for claim in claims:
        claim_type = _claim_type(claim)
        if claim_type in FEATURE_RECIPE_CLAIM_TYPES | FEATURE_BLOCKER_CLAIM_TYPES:
            return True
        if _claim_feature_terms(claim):
            return True
    return any(
        _relation_type(relation) in FEATURE_BLOCKER_RELATION_TYPES
        for relation in relations
    )


def _has_risk_validation_constraint(
    claims: Sequence[Mapping[str, Any]],
    relations: Sequence[Mapping[str, Any]],
) -> bool:
    if any(
        _claim_type(claim) in RISK_VALIDATION_CLAIM_TYPES and bool(_claim_text(claim))
        for claim in claims
    ):
        return True
    return any(
        _relation_type(relation) in RISK_VALIDATION_RELATION_TYPES
        for relation in relations
    )


def claim_subgraph_blockers(source: WhitepaperResearchSource) -> tuple[str, ...]:
    """Return deterministic reasons this source cannot produce executable hypotheses."""

    claims = tuple(dict(item) for item in source.claims)
    relations = tuple(dict(item) for item in source.claim_relations)
    blockers: list[str] = []
    if not _string(source.run_id):
        blockers.append("source_run_id_missing")
    if not claims:
        blockers.append("claims_missing")
    if claims and not any(_claim_text(claim) for claim in claims):
        blockers.append("claim_text_missing")
    if not _has_mechanism(claims):
        blockers.append("mechanism_missing")
    if not _has_feature_recipe_or_blocker(claims, relations):
        blockers.append("feature_recipe_or_blocker_missing")
    if not _has_risk_validation_constraint(claims, relations):
        blockers.append("risk_or_validation_constraint_missing")
    return tuple(blockers)


def compile_sources_to_hypothesis_cards(
    sources: Sequence[WhitepaperResearchSource],
) -> list[HypothesisCard]:
    cards: list[HypothesisCard] = []
    for source in sources:
        if claim_subgraph_blockers(source):
            continue
        cards.extend(
            build_hypothesis_cards(
                source_run_id=source.run_id,
                claims=source.claims,
                relations=source.claim_relations,
            )
        )
    return cards


def source_from_payload(payload: Mapping[str, Any]) -> WhitepaperResearchSource:
    claims = payload.get("claims")
    relations = payload.get("claim_relations")
    claim_rows = cast(list[Any], claims) if isinstance(claims, list) else []
    relation_rows = cast(list[Any], relations) if isinstance(relations, list) else []
    return WhitepaperResearchSource(
        run_id=str(payload.get("run_id") or "").strip(),
        title=str(payload.get("title") or "").strip(),
        source_url=str(payload.get("source_url") or "").strip(),
        published_at=str(payload.get("published_at") or "").strip(),
        claims=tuple(
            cast(Mapping[str, Any], item)
            for item in claim_rows
            if isinstance(item, Mapping)
        ),
        claim_relations=tuple(
            cast(Mapping[str, Any], item)
            for item in relation_rows
            if isinstance(item, Mapping)
        ),
    )
