"""Pure whitepaper claim compilation helpers for autoresearch."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence, cast

from app.trading.discovery.hypothesis_cards import (
    HypothesisCard,
    build_hypothesis_cards,
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
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-arxiv-2510-08085",
        title="A Deterministic Limit Order Book Simulator with Hawkes-Driven Order Flow",
        source_url="https://arxiv.org/abs/2510.08085",
        published_at="2025-10-09",
        claims=(
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
        ),
    ),
)


def compile_sources_to_hypothesis_cards(
    sources: Sequence[WhitepaperResearchSource],
) -> list[HypothesisCard]:
    cards: list[HypothesisCard] = []
    for source in sources:
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
