"""Pure whitepaper claim compilation helpers for autoresearch."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence, cast

from app.trading.discovery.hypothesis_cards import (
    HypothesisCard,
    build_hypothesis_cards,
)


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


RECENT_WHITEPAPER_SEEDS: tuple[WhitepaperResearchSource, ...] = (
    WhitepaperResearchSource(
        run_id="seed-arxiv-2602-00776",
        title="Explainable Patterns in Cryptocurrency Microstructure",
        source_url="https://arxiv.org/abs/2602.00776",
        published_at="2026-01-31",
        claims=(
            {
                "claim_id": "portable-lob-feature-library",
                "claim_type": "feature_recipe",
                "claim_text": (
                    "Stable order-book and trade-feature importance across heterogeneous assets "
                    "supports portable LOB feature recipes after equity replay confirms spread and "
                    "adverse-selection behavior."
                ),
                "asset_scope": "intraday_microstructure",
                "horizon_scope": "intraday",
                "expected_direction": "positive",
                "data_requirements": [
                    "portable_lob_feature_stability",
                    "multi_level_order_book",
                    "order_flow_imbalance",
                    "spread_bps",
                ],
                "confidence": "0.73",
            },
            {
                "claim_id": "maker-taker-adverse-selection-stress",
                "claim_type": "risk_constraint",
                "claim_text": (
                    "Divergent taker and maker performance during flash-crash stress means route/TCA "
                    "evidence must split maker-style and taker-style fill assumptions."
                ),
                "asset_scope": "intraday_microstructure",
                "horizon_scope": "intraday_execution",
                "expected_direction": "neutral",
                "data_requirements": [
                    "maker_taker_fill_assumption",
                    "route_tca",
                    "fill_model",
                    "adverse_selection_stress",
                ],
                "confidence": "0.76",
            },
        ),
        claim_relations=(
            {
                "relation_id": "flash-crash-adverse-selection-validates-portable-lob",
                "relation_type": "requires_validation",
                "source_claim_id": "maker-taker-adverse-selection-stress",
                "target_claim_id": "portable-lob-feature-library",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-arxiv-2602-03903",
        title="Taming Tail Risk in Financial Markets: Conformal Risk Control for Nonstationary Portfolio VaR",
        source_url="https://arxiv.org/abs/2602.03903",
        published_at="2026-02-03",
        claims=(
            {
                "claim_id": "regime-weighted-conformal-var-buffer",
                "claim_type": "feature_recipe",
                "claim_text": (
                    "Regime-weighted conformal risk control calibrates a safety buffer from "
                    "recent VaR forecast errors and regime-similarity weights."
                ),
                "asset_scope": "us_equities_portfolio",
                "horizon_scope": "portfolio_risk_control",
                "expected_direction": "neutral",
                "data_requirements": [
                    "regime_state",
                    "regime_similarity_weights",
                    "conformal_tail_risk",
                    "regime_tail_exceedance",
                    "var_forecast_error",
                ],
                "confidence": "0.76",
            },
            {
                "claim_id": "breakeven-cost-buffer-validation",
                "claim_type": "validation_requirement",
                "claim_text": (
                    "Candidates should clear the target after conformal tail-risk and "
                    "breakeven transaction-cost buffers, with seed and model-family robustness."
                ),
                "asset_scope": "us_equities_portfolio",
                "horizon_scope": "portfolio_risk_control",
                "expected_direction": "neutral",
                "data_requirements": [
                    "breakeven_transaction_cost_buffer",
                    "transaction_cost_buffer",
                    "transaction_cost_stress",
                    "post_cost_net_pnl",
                    "seed_robustness",
                    "model_family_robustness",
                ],
                "confidence": "0.76",
            },
        ),
        claim_relations=(
            {
                "relation_id": "conformal-buffer-requires-breakeven-cost-proof",
                "relation_type": "requires_validation",
                "source_claim_id": "breakeven-cost-buffer-validation",
                "target_claim_id": "regime-weighted-conformal-var-buffer",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-arxiv-2601-23172",
        title="A unified theory of order flow, market impact, and volatility",
        source_url="https://arxiv.org/abs/2601.23172",
        published_at="2026-02-02",
        claims=(
            {
                "claim_id": "persistent-core-flow-impact-scaling",
                "claim_type": "signal_mechanism",
                "claim_text": (
                    "Persistent core order flow can jointly explain rough volume, rough volatility, "
                    "and power-law market impact, making persistent-flow continuation "
                    "cost-and-volatility coupled."
                ),
                "asset_scope": "intraday_microstructure",
                "horizon_scope": "intraday",
                "expected_direction": "positive",
                "data_requirements": [
                    "core_flow_persistence",
                    "signed_order_flow",
                    "realized_volatility",
                    "turnover",
                ],
                "confidence": "0.75",
            },
            {
                "claim_id": "square-root-impact-cost-stress",
                "claim_type": "validation_requirement",
                "claim_text": (
                    "Order-flow persistence is consistent with square-root-like market-impact scaling, "
                    "so high-turnover candidates need nonlinear impact stress before portfolio ranking."
                ),
                "asset_scope": "intraday_microstructure",
                "horizon_scope": "portfolio_execution",
                "expected_direction": "neutral",
                "data_requirements": [
                    "nonlinear_impact_curve",
                    "market_impact_stress",
                    "turnover",
                    "post_cost_net_pnl",
                ],
                "confidence": "0.76",
            },
        ),
        claim_relations=(
            {
                "relation_id": "impact-stress-required-for-persistent-flow",
                "relation_type": "requires_validation",
                "source_claim_id": "square-root-impact-cost-stress",
                "target_claim_id": "persistent-core-flow-impact-scaling",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-arxiv-2601-17247",
        title="Learning Market Making with Closing Auctions",
        source_url="https://arxiv.org/abs/2601.17247",
        published_at="2026-01-24",
        claims=(
            {
                "claim_id": "closing-auction-inventory-control",
                "claim_type": "signal_mechanism",
                "claim_text": (
                    "Explicitly modeling the closing auction can change optimal end-of-session "
                    "inventory paths versus generic terminal inventory penalties."
                ),
                "asset_scope": "us_equities_intraday",
                "horizon_scope": "late_session_execution",
                "expected_direction": "positive",
                "data_requirements": [
                    "closing_auction_projection",
                    "terminal_inventory_path",
                    "closing_auction_clearing_price",
                ],
                "confidence": "0.73",
            },
            {
                "claim_id": "close-auction-exit-feature-recipe",
                "claim_type": "feature_recipe",
                "claim_text": (
                    "Late-day sleeves should separate close-auction projected clearing price, "
                    "inventory path, and close-flatten urgency from normal intraday exit features."
                ),
                "asset_scope": "us_equities_intraday",
                "horizon_scope": "late_session_execution",
                "expected_direction": "neutral",
                "data_requirements": [
                    "closing_auction_projection",
                    "terminal_inventory_path",
                    "quote_quality",
                ],
                "confidence": "0.72",
            },
            {
                "claim_id": "generative-close-auction-validation",
                "claim_type": "validation_requirement",
                "claim_text": (
                    "Generative closing-auction simulations are validation stress only; "
                    "promotion still needs historical replay, route TCA, and live-paper parity."
                ),
                "asset_scope": "us_equities_intraday",
                "horizon_scope": "late_session_execution",
                "expected_direction": "neutral",
                "data_requirements": [
                    "simulation_parity",
                    "historical_replay",
                    "live_paper_parity",
                ],
                "confidence": "0.73",
            },
        ),
        claim_relations=(
            {
                "relation_id": "close-auction-simulation-requires-live-paper",
                "relation_type": "requires_validation",
                "source_claim_id": "generative-close-auction-validation",
                "target_claim_id": "closing-auction-inventory-control",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-arxiv-2507-06345",
        title="Reinforcement Learning for Trade Execution with Market and Limit Orders",
        source_url="https://arxiv.org/abs/2507.06345",
        published_at="2026-01-26",
        claims=(
            {
                "claim_id": "mixed-market-limit-execution-policy",
                "claim_type": "signal_mechanism",
                "claim_text": (
                    "Dynamic allocation between market and limit orders can improve execution "
                    "revenue versus fixed execution benchmarks in LOB settings."
                ),
                "asset_scope": "us_equities_execution",
                "horizon_scope": "intraday_execution",
                "expected_direction": "positive",
                "data_requirements": [
                    "market_limit_order_mix",
                    "limit_fill_probability",
                    "execution_shortfall",
                ],
                "confidence": "0.74",
            },
            {
                "claim_id": "logistic-normal-order-mix-recipe",
                "claim_type": "feature_recipe",
                "claim_text": (
                    "Execution sweeps should expose market-versus-limit order mix, fill probability, "
                    "and shortfall as first-class features instead of one static order type."
                ),
                "asset_scope": "us_equities_execution",
                "horizon_scope": "intraday_execution",
                "expected_direction": "neutral",
                "data_requirements": [
                    "logistic_normal_execution_policy",
                    "market_limit_order_mix",
                    "limit_fill_probability",
                ],
                "confidence": "0.73",
            },
            {
                "claim_id": "mixed-order-execution-risk-gate",
                "claim_type": "risk_constraint",
                "claim_text": (
                    "Market/limit allocation must be stress-tested against tactical imbalance, "
                    "fill uncertainty, latency, and route TCA before any capital promotion."
                ),
                "asset_scope": "us_equities_execution",
                "horizon_scope": "intraday_execution",
                "expected_direction": "neutral",
                "data_requirements": [
                    "route_tca",
                    "fill_model",
                    "latency_stress",
                    "transaction_cost_stress",
                ],
                "confidence": "0.74",
            },
        ),
        claim_relations=(
            {
                "relation_id": "mixed-order-policy-requires-route-tca",
                "relation_type": "requires_validation",
                "source_claim_id": "mixed-order-execution-risk-gate",
                "target_claim_id": "mixed-market-limit-execution-policy",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-springer-lobdif-2026",
        title="Limit Order Book Event Stream Prediction with Diffusion Model",
        source_url="https://link.springer.com/article/10.1007/s41019-025-00328-4",
        published_at="2026-02-04",
        claims=(
            {
                "claim_id": "lobdiff-time-event-prediction",
                "claim_type": "signal_mechanism",
                "claim_text": (
                    "Diffusion modeling of LOB event streams can learn joint event-time and event-type "
                    "structure that simpler point-process assumptions may miss."
                ),
                "asset_scope": "limit_order_book_event_stream",
                "horizon_scope": "intraday_microstructure",
                "expected_direction": "positive",
                "data_requirements": [
                    "lob_diffusion_event_stream",
                    "time_event_joint_distribution",
                    "lob_event_stream",
                ],
                "confidence": "0.72",
            },
            {
                "claim_id": "skip-step-event-sampling-recipe",
                "claim_type": "feature_recipe",
                "claim_text": (
                    "LOB event-stream inference should track event-time distribution, event-type "
                    "distribution, and sampling latency so predictive state can be used in real time."
                ),
                "asset_scope": "limit_order_book_event_stream",
                "horizon_scope": "intraday_microstructure",
                "expected_direction": "neutral",
                "data_requirements": [
                    "time_event_joint_distribution",
                    "skip_step_sampling",
                    "latency_stress",
                ],
                "confidence": "0.71",
            },
            {
                "claim_id": "lobdiff-realtime-parity-validation",
                "claim_type": "validation_requirement",
                "claim_text": (
                    "Diffusion-derived LOB state must prove event-stream parity, latency tolerance, "
                    "and post-cost replay usefulness before influencing candidate ranking."
                ),
                "asset_scope": "limit_order_book_event_stream",
                "horizon_scope": "intraday_microstructure",
                "expected_direction": "neutral",
                "data_requirements": [
                    "simulation_parity",
                    "latency_stress",
                    "walk_forward_replay",
                ],
                "confidence": "0.71",
            },
        ),
        claim_relations=(
            {
                "relation_id": "lobdiff-state-requires-realtime-parity",
                "relation_type": "requires_validation",
                "source_claim_id": "lobdiff-realtime-parity-validation",
                "target_claim_id": "lobdiff-time-event-prediction",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-arxiv-2505-17388",
        title="Stochastic Price Dynamics in Response to Order Flow Imbalance: Evidence from CSI 300 Index Futures",
        source_url="https://arxiv.org/abs/2505.17388",
        published_at="2025-05-23",
        claims=(
            {
                "claim_id": "ofi-response-trigger",
                "claim_type": "signal_mechanism",
                "claim_text": (
                    "Order-flow imbalance can act as a shock with memory and can be evaluated as a "
                    "trigger through a response-ratio style cost-effectiveness measure."
                ),
                "asset_scope": "index_futures_intraday",
                "horizon_scope": "intraday",
                "expected_direction": "positive",
                "data_requirements": [
                    "order_flow_imbalance",
                    "ofi_memory_state",
                    "response_ratio",
                    "transaction_cost_stress",
                ],
                "confidence": "0.76",
            },
            {
                "claim_id": "ofi-regime-dependent-memory",
                "claim_type": "market_regime",
                "claim_text": (
                    "Order-flow imbalance forecasting power is horizon-dependent and regime-dependent, "
                    "so candidate sleeves need regime-sliced and forecast-horizon validation."
                ),
                "asset_scope": "index_futures_intraday",
                "horizon_scope": "intraday",
                "expected_direction": "neutral",
                "data_requirements": [
                    "forecast_horizon",
                    "order_flow_imbalance",
                    "realized_volatility",
                ],
                "confidence": "0.74",
            },
        ),
        claim_relations=(
            {
                "relation_id": "ofi-regime-validates-response",
                "relation_type": "requires_regime",
                "source_claim_id": "ofi-regime-dependent-memory",
                "target_claim_id": "ofi-response-trigger",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-arxiv-2508-06788",
        title="Returns and Order Flow Imbalances: Intraday Dynamics and Macroeconomic News Effects",
        source_url="https://arxiv.org/abs/2508.06788",
        published_at="2025-10-08",
        claims=(
            {
                "claim_id": "one-second-price-flow-impact-decay",
                "claim_type": "signal_mechanism",
                "claim_text": (
                    "One-second returns and order-flow imbalance interact through horizon-specific "
                    "price-flow impact that decays quickly and changes across intraday intervals."
                ),
                "asset_scope": "us_equities_intraday",
                "horizon_scope": "subminute_microstructure",
                "expected_direction": "positive",
                "data_requirements": [
                    "order_flow_imbalance",
                    "price_flow_impact",
                    "flow_impact_decay",
                    "forecast_horizon",
                ],
                "confidence": "0.74",
            },
            {
                "claim_id": "macro-news-price-flow-regime",
                "claim_type": "market_regime",
                "claim_text": (
                    "Macroeconomic news changes intraday price impact, order-flow impact, volatility, "
                    "and liquidity enough that flow sleeves need explicit event-window validation."
                ),
                "asset_scope": "us_equities_intraday",
                "horizon_scope": "macro_event_intraday",
                "expected_direction": "neutral",
                "data_requirements": [
                    "macro_announcement_window",
                    "realized_volatility",
                    "spread_bps",
                    "route_tca",
                ],
                "confidence": "0.73",
            },
            {
                "claim_id": "macro-news-heldout-replay-required",
                "claim_type": "validation_requirement",
                "claim_text": (
                    "Subminute price-flow effects should be evaluated separately on macro-news and "
                    "non-news windows before any candidate can affect promotion ranking."
                ),
                "asset_scope": "us_equities_intraday",
                "horizon_scope": "macro_event_intraday",
                "expected_direction": "neutral",
                "data_requirements": [
                    "walk_forward_replay",
                    "live_paper_parity",
                    "transaction_cost_stress",
                ],
                "confidence": "0.73",
            },
        ),
        claim_relations=(
            {
                "relation_id": "macro-news-regime-validates-price-flow-decay",
                "relation_type": "requires_regime",
                "source_claim_id": "macro-news-price-flow-regime",
                "target_claim_id": "one-second-price-flow-impact-decay",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-arxiv-2507-22712",
        title="Order-Flow Filtration and Directional Association with Short-Horizon Returns",
        source_url="https://arxiv.org/abs/2507.22712",
        published_at="2025-12-08",
        claims=(
            {
                "claim_id": "parent-trade-filtered-obi",
                "claim_type": "feature_recipe",
                "claim_text": (
                    "Filtering order-book imbalance to parent orders that actually produce trades can "
                    "strengthen short-horizon directional association versus raw transient order flow."
                ),
                "asset_scope": "limit_order_book_intraday",
                "horizon_scope": "short_horizon_returns",
                "expected_direction": "positive",
                "data_requirements": [
                    "parent_order_trade_linkage",
                    "filtered_orderbook_imbalance",
                    "order_lifetime_filter",
                    "order_modification_count",
                ],
                "confidence": "0.75",
            },
            {
                "claim_id": "filtration-causal-coherence-gate",
                "claim_type": "validation_requirement",
                "claim_text": (
                    "Filtration that improves directional correlation must still pass causality, "
                    "event-time excitation, route TCA, and walk-forward replay before promotion."
                ),
                "asset_scope": "limit_order_book_intraday",
                "horizon_scope": "short_horizon_returns",
                "expected_direction": "neutral",
                "data_requirements": [
                    "event_time_excitation",
                    "route_tca",
                    "walk_forward_replay",
                    "live_paper_parity",
                ],
                "confidence": "0.74",
            },
        ),
        claim_relations=(
            {
                "relation_id": "filtered-obi-requires-causal-execution-proof",
                "relation_type": "requires_validation",
                "source_claim_id": "filtration-causal-coherence-gate",
                "target_claim_id": "parent-trade-filtered-obi",
            },
        ),
    ),
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
    WhitepaperResearchSource(
        run_id="seed-arxiv-2502-17417",
        title="Event-Based Limit Order Book Simulation under a Neural Hawkes Process: Application in Market-Making",
        source_url="https://arxiv.org/abs/2502.17417",
        published_at="2025-02-24",
        claims=(
            {
                "claim_id": "neural-hawkes-lob-fill-parity",
                "claim_type": "signal_mechanism",
                "claim_text": (
                    "Neural Hawkes event simulation can model LOB event interactions and fill "
                    "distributions closer to real market-making fill behavior."
                ),
                "asset_scope": "limit_order_book_event_stream",
                "horizon_scope": "intraday_execution",
                "expected_direction": "positive",
                "data_requirements": [
                    "neural_hawkes_event_stream",
                    "lob_event_stream",
                    "synthetic_lob_fill_parity",
                ],
                "confidence": "0.72",
            },
            {
                "claim_id": "event-based-fill-model-recipe",
                "claim_type": "feature_recipe",
                "claim_text": (
                    "Fill models should represent add, cancel, and trade event interactions rather "
                    "than relying only on fixed spread or top-of-book assumptions."
                ),
                "asset_scope": "limit_order_book_event_stream",
                "horizon_scope": "intraday_execution",
                "expected_direction": "neutral",
                "data_requirements": [
                    "neural_hawkes_event_stream",
                    "fill_model",
                    "limit_fill_probability",
                ],
                "confidence": "0.72",
            },
            {
                "claim_id": "neural-hawkes-sim-validation-only",
                "claim_type": "validation_requirement",
                "claim_text": (
                    "Neural-Hawkes LOB simulation is useful for stress and pretraining, but simulated "
                    "fill parity cannot replace historical replay, route TCA, and live-paper evidence."
                ),
                "asset_scope": "limit_order_book_event_stream",
                "horizon_scope": "intraday_execution",
                "expected_direction": "neutral",
                "data_requirements": [
                    "simulation_parity",
                    "route_tca",
                    "live_paper_parity",
                ],
                "confidence": "0.73",
            },
        ),
        claim_relations=(
            {
                "relation_id": "neural-hawkes-sim-requires-fill-parity",
                "relation_type": "requires_validation",
                "source_claim_id": "neural-hawkes-sim-validation-only",
                "target_claim_id": "neural-hawkes-lob-fill-parity",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-arxiv-2605-04004",
        title=(
            "Structural Limits of OHLCV-Based Intraday Signals in MNQ Futures: "
            "A Systematic Falsification Study"
        ),
        source_url="https://arxiv.org/abs/2605.04004",
        published_at="2026-05-05",
        claims=(
            {
                "claim_id": "ohlcv-only-intraday-falsification",
                "claim_type": "validation_requirement",
                "claim_text": (
                    "OHLCV-only intraday momentum signals can fail strict walk-forward, sample-count, "
                    "post-cost, and multi-year stability gates even when naive gross edges look positive."
                ),
                "asset_scope": "intraday_momentum",
                "horizon_scope": "intraday",
                "expected_direction": "neutral",
                "data_requirements": [
                    "walk_forward_replay",
                    "transaction_cost_stress",
                    "live_paper_parity",
                ],
                "expected_failure_modes": [
                    "insufficient_trade_count",
                    "fails_transaction_cost_stress",
                    "unstable_multi_year_edge",
                ],
                "confidence": "0.76",
            },
            {
                "claim_id": "gap-continuation-positive-control",
                "claim_type": "signal_mechanism",
                "claim_text": (
                    "Gap-continuation signals should remain positive-control hypotheses until they clear "
                    "minimum trade-count and post-cost live-paper proof."
                ),
                "asset_scope": "intraday_momentum",
                "horizon_scope": "intraday",
                "expected_direction": "positive",
                "data_requirements": [
                    "gap_velocity",
                    "executable_quote",
                    "walk_forward_replay",
                ],
                "confidence": "0.70",
            },
            {
                "claim_id": "walk-forward-cost-constraints-required",
                "claim_type": "risk_constraint",
                "claim_text": (
                    "Candidate promotion should require out-of-sample walk-forward validation, realistic "
                    "execution costs, enough trades, and multi-year stability before capital is routed."
                ),
                "asset_scope": "intraday_momentum",
                "horizon_scope": "intraday",
                "expected_direction": "neutral",
                "data_requirements": [
                    "walk_forward_replay",
                    "transaction_cost_stress",
                    "live_paper_parity",
                ],
                "confidence": "0.75",
            },
        ),
        claim_relations=(
            {
                "relation_id": "ohlcv-falsification-requires-live-paper-proof",
                "relation_type": "requires_validation",
                "source_claim_id": "walk-forward-cost-constraints-required",
                "target_claim_id": "ohlcv-only-intraday-falsification",
                "rationale": (
                    "Naive OHLCV intraday signals should not be promoted without routeable post-cost "
                    "proof and live-paper parity."
                ),
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-arxiv-2604-10402",
        title="Risk-Sensitive Specialist Routing for Volatility Forecasting",
        source_url="https://arxiv.org/abs/2604.10402",
        published_at="2026-04-16",
        claims=(
            {
                "claim_id": "risk-routing-state-dependent-specialists",
                "claim_type": "signal_mechanism",
                "claim_text": (
                    "Risk-sensitive specialist routing can select different volatility forecasters across "
                    "calm and stressed states instead of using one globally best model."
                ),
                "asset_scope": "etf_panel_volatility",
                "horizon_scope": "risk_management",
                "expected_direction": "positive",
                "data_requirements": [
                    "state_variable",
                    "realized_volatility",
                    "walk_forward_validation",
                ],
                "confidence": "0.74",
            },
            {
                "claim_id": "underprediction-loss-routing-gate",
                "claim_type": "feature_recipe",
                "claim_text": (
                    "Underprediction loss and high-volatility loss should be used as routing features "
                    "when choosing risk specialists for sleeve sizing."
                ),
                "asset_scope": "etf_panel_volatility",
                "horizon_scope": "risk_management",
                "expected_direction": "neutral",
                "data_requirements": [
                    "underprediction_loss",
                    "high_volatility_loss",
                    "realized_volatility",
                ],
                "confidence": "0.74",
            },
            {
                "claim_id": "state-dependent-risk-routing-validation",
                "claim_type": "market_regime",
                "claim_text": (
                    "Volatility specialists should be validated by market state, because the strongest "
                    "forecaster is regime-dependent rather than stable across all states."
                ),
                "asset_scope": "etf_panel_volatility",
                "horizon_scope": "risk_management",
                "expected_direction": "neutral",
                "data_requirements": [
                    "state_variable",
                    "realized_volatility",
                    "walk_forward_validation",
                ],
                "confidence": "0.74",
            },
        ),
        claim_relations=(
            {
                "relation_id": "risk-routing-controls-sleeve-sizing",
                "relation_type": "requires_regime",
                "source_claim_id": "state-dependent-risk-routing-validation",
                "target_claim_id": "risk-routing-state-dependent-specialists",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-arxiv-2604-09060",
        title=(
            "Taming the Black Swan: A Momentum-Gated Hierarchical Optimisation "
            "Framework for Asymmetric Alpha Generation"
        ),
        source_url="https://arxiv.org/abs/2604.09060",
        published_at="2026-04-10",
        claims=(
            {
                "claim_id": "momentum-gated-diversification-alpha",
                "claim_type": "signal_mechanism",
                "claim_text": (
                    "Volatility-adjusted momentum filters combined with structural diversification can "
                    "preserve upside participation while reducing momentum crash intensity."
                ),
                "asset_scope": "equity_momentum",
                "horizon_scope": "risk_management",
                "expected_direction": "positive",
                "data_requirements": [
                    "momentum_filter",
                    "correlation_or_breadth_gate",
                    "drawdown_validation",
                ],
                "confidence": "0.70",
            },
            {
                "claim_id": "momentum-crash-regime-filter",
                "claim_type": "risk_constraint",
                "claim_text": (
                    "Momentum sleeves need state-aware gating and diversification controls to reduce "
                    "crash intensity without removing upside participation."
                ),
                "asset_scope": "equity_momentum",
                "horizon_scope": "risk_management",
                "expected_direction": "neutral",
                "data_requirements": [
                    "momentum_filter",
                    "correlation_or_breadth_gate",
                    "drawdown_validation",
                ],
                "confidence": "0.70",
            },
        ),
        claim_relations=(
            {
                "relation_id": "momentum-crash-gating-validates-alpha",
                "relation_type": "supports",
                "source_claim_id": "momentum-crash-regime-filter",
                "target_claim_id": "momentum-gated-diversification-alpha",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-arxiv-2603-29086",
        title="Realistic Market Impact Modeling for Reinforcement Learning Trading Environments",
        source_url="https://arxiv.org/abs/2603.29086",
        published_at="2026-04-04",
        claims=(
            {
                "claim_id": "nonlinear-market-impact-changes-strategy-ranking",
                "claim_type": "validation_requirement",
                "claim_text": (
                    "Nonlinear market-impact assumptions can materially change absolute performance, "
                    "trading behavior, turnover, and relative strategy rankings versus fixed-cost baselines."
                ),
                "asset_scope": "us_equities_portfolio",
                "horizon_scope": "portfolio_execution",
                "expected_direction": "neutral",
                "data_requirements": ["route_tca", "turnover", "market_impact_stress"],
                "confidence": "0.78",
            },
            {
                "claim_id": "impact-stress-feature-recipe",
                "claim_type": "feature_recipe",
                "claim_text": (
                    "Market-impact stress curves, route TCA, and turnover should be first-class "
                    "portfolio execution features for ranking candidate sleeves."
                ),
                "asset_scope": "us_equities_portfolio",
                "horizon_scope": "portfolio_execution",
                "expected_direction": "neutral",
                "data_requirements": ["route_tca", "turnover", "market_impact_stress"],
                "confidence": "0.76",
            },
            {
                "claim_id": "turnover-penalty-prevents-pathological-trading",
                "claim_type": "risk_constraint",
                "claim_text": (
                    "Cost-model-aware optimization is required to prevent pathological high-turnover "
                    "candidates from passing naive replay."
                ),
                "asset_scope": "us_equities_portfolio",
                "horizon_scope": "portfolio_execution",
                "expected_direction": "neutral",
                "data_requirements": [
                    "turnover",
                    "execution_shortfall",
                    "post_cost_net_pnl",
                ],
                "confidence": "0.77",
            },
        ),
        claim_relations=(
            {
                "relation_id": "impact-aware-ranking-requires-turnover-stress",
                "relation_type": "requires_validation",
                "source_claim_id": "turnover-penalty-prevents-pathological-trading",
                "target_claim_id": "nonlinear-market-impact-changes-strategy-ranking",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-arxiv-2510-02986",
        title="FR-LUX: Friction-Aware, Regime-Conditioned Policy Optimization for Implementable Portfolio Management",
        source_url="https://arxiv.org/abs/2510.02986",
        published_at="2025-10-03",
        claims=(
            {
                "claim_id": "friction-aware-regime-conditioned-policy",
                "claim_type": "feature_recipe",
                "claim_text": (
                    "FR-LUX uses friction-aware, regime-conditioned policy optimization to learn "
                    "after-cost trading policies across volatility-liquidity regimes."
                ),
                "asset_scope": "us_equities_portfolio",
                "horizon_scope": "portfolio_execution",
                "expected_direction": "positive",
                "data_requirements": [
                    "regime_state",
                    "regime_conditioned_policy",
                    "volatility_liquidity_regime",
                    "proportional_cost_model",
                    "impact_cost_model",
                    "post_cost_net_pnl",
                ],
                "confidence": "0.76",
            },
            {
                "claim_id": "trade-space-trust-region-turnover-budget",
                "claim_type": "risk_constraint",
                "claim_text": (
                    "Trade-space trust regions, inaction bands, and turnover budgets are needed "
                    "to avoid cost-blind inventory churn under convex frictions."
                ),
                "asset_scope": "us_equities_portfolio",
                "horizon_scope": "portfolio_execution",
                "expected_direction": "neutral",
                "data_requirements": [
                    "trade_space_trust_region",
                    "turnover_budget",
                    "turnover_bounds",
                    "cost_misspecification_stress",
                    "transaction_cost_stress",
                ],
                "confidence": "0.75",
            },
            {
                "claim_id": "scenario-level-cost-calibration-validation",
                "claim_type": "validation_requirement",
                "claim_text": (
                    "Promotion candidates should prove liquidity-proxy cost calibration, "
                    "scenario-level inference, and live-paper parity before a regime-conditioned "
                    "friction model affects capital."
                ),
                "asset_scope": "us_equities_portfolio",
                "horizon_scope": "portfolio_execution",
                "expected_direction": "neutral",
                "data_requirements": [
                    "liquidity_proxy_cost_calibration",
                    "scenario_level_inference",
                    "bootstrap_confidence_interval",
                    "multiple_testing_correction",
                    "live_paper_parity",
                ],
                "confidence": "0.74",
            },
        ),
        claim_relations=(
            {
                "relation_id": "frlux-policy-requires-turnover-and-cost-validation",
                "relation_type": "requires_validation",
                "source_claim_id": "trade-space-trust-region-turnover-budget",
                "target_claim_id": "friction-aware-regime-conditioned-policy",
            },
            {
                "relation_id": "frlux-policy-requires-scenario-cost-calibration",
                "relation_type": "requires_validation",
                "source_claim_id": "scenario-level-cost-calibration-validation",
                "target_claim_id": "friction-aware-regime-conditioned-policy",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-arxiv-2603-16365",
        title="FactorEngine: A Program-level Knowledge-Infused Factor Mining Framework for Quantitative Investment",
        source_url="https://arxiv.org/abs/2603.16365",
        published_at="2026-04-09",
        claims=(
            {
                "claim_id": "program-level-factor-discovery",
                "claim_type": "signal_mechanism",
                "claim_text": (
                    "Program-level factor discovery can generate executable and auditable factors while "
                    "separating logic revision from parameter optimization."
                ),
                "asset_scope": "equities_factor_mining",
                "horizon_scope": "short_term_cross_section",
                "expected_direction": "positive",
                "data_requirements": [
                    "factor_program",
                    "walk_forward_replay",
                    "cross_sectional_ranks",
                ],
                "confidence": "0.74",
            },
            {
                "claim_id": "factor-engine-code-recipe",
                "claim_type": "feature_recipe",
                "claim_text": (
                    "LLM-guided directional search should emit executable factor programs and let local "
                    "Bayesian search tune parameters under replay constraints."
                ),
                "asset_scope": "equities_factor_mining",
                "horizon_scope": "short_term_cross_section",
                "expected_direction": "positive",
                "data_requirements": [
                    "factor_program",
                    "walk_forward_replay",
                    "cross_sectional_ranks",
                ],
                "confidence": "0.74",
            },
            {
                "claim_id": "factor-engine-auditability-validation",
                "claim_type": "validation_requirement",
                "claim_text": (
                    "Generated factors must be directly executable, auditable, and tested for stability "
                    "against regime shifts and overfitting."
                ),
                "asset_scope": "equities_factor_mining",
                "horizon_scope": "short_term_cross_section",
                "expected_direction": "neutral",
                "data_requirements": [
                    "factor_program",
                    "walk_forward_replay",
                    "regime_shift_validation",
                ],
                "confidence": "0.73",
            },
        ),
        claim_relations=(
            {
                "relation_id": "factor-engine-validation-supports-program-factors",
                "relation_type": "supports",
                "source_claim_id": "factor-engine-auditability-validation",
                "target_claim_id": "program-level-factor-discovery",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-arxiv-2602-07085",
        title="QuantaAlpha: An Evolutionary Framework for LLM-Driven Alpha Mining",
        source_url="https://arxiv.org/abs/2602.07085",
        published_at="2026-04-22",
        claims=(
            {
                "claim_id": "trajectory-level-alpha-evolution",
                "claim_type": "signal_mechanism",
                "claim_text": (
                    "Trajectory-level mutation and crossover can refine alpha factors by localizing "
                    "suboptimal mining steps and reusing complementary validated patterns."
                ),
                "asset_scope": "equities_factor_mining",
                "horizon_scope": "short_term_cross_section",
                "expected_direction": "positive",
                "data_requirements": [
                    "alpha_search_trajectory",
                    "factor_program",
                    "walk_forward_replay",
                ],
                "confidence": "0.75",
            },
            {
                "claim_id": "semantic-consistency-factor-code",
                "claim_type": "feature_recipe",
                "claim_text": (
                    "Generated factors should maintain semantic consistency across hypothesis, factor "
                    "expression, and executable code while constraining redundancy and complexity."
                ),
                "asset_scope": "equities_factor_mining",
                "horizon_scope": "short_term_cross_section",
                "expected_direction": "positive",
                "data_requirements": [
                    "alpha_search_trajectory",
                    "factor_program",
                    "factor_redundancy_score",
                ],
                "confidence": "0.75",
            },
            {
                "claim_id": "trajectory-transfer-validation",
                "claim_type": "validation_requirement",
                "claim_text": (
                    "LLM-mined factors should prove transfer across market distributions before being "
                    "treated as robust candidate sleeves."
                ),
                "asset_scope": "equities_factor_mining",
                "horizon_scope": "short_term_cross_section",
                "expected_direction": "neutral",
                "data_requirements": [
                    "cross_market_holdout",
                    "factor_program",
                    "drawdown_validation",
                ],
                "confidence": "0.74",
            },
        ),
        claim_relations=(
            {
                "relation_id": "trajectory-validation-supports-alpha-evolution",
                "relation_type": "supports",
                "source_claim_id": "trajectory-transfer-validation",
                "target_claim_id": "trajectory-level-alpha-evolution",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-ssrn-6440898",
        title="Market Depth and Execution Delays",
        source_url="https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6440898",
        published_at="2026-05-15",
        claims=(
            {
                "claim_id": "delay-adjusted-depth-fillability",
                "claim_type": "feature_recipe",
                "claim_text": (
                    "Market depth and execution delay jointly determine practical fillability, so "
                    "route scoring should use delay-adjusted depth rather than spread alone."
                ),
                "asset_scope": "us_equities_execution",
                "horizon_scope": "intraday_execution",
                "expected_direction": "neutral",
                "data_requirements": [
                    "depth_proxy",
                    "execution_delay",
                    "route_tca",
                    "spread_bps",
                ],
                "confidence": "0.74",
            },
            {
                "claim_id": "delay-adjusted-liquidity-validation",
                "claim_type": "validation_requirement",
                "claim_text": (
                    "Execution-delay sensitivity should block promotion when paper fills depend on "
                    "optimistic no-delay liquidity assumptions."
                ),
                "asset_scope": "us_equities_execution",
                "horizon_scope": "intraday_execution",
                "expected_direction": "neutral",
                "data_requirements": [
                    "execution_delay",
                    "fill_model",
                    "route_tca",
                    "live_paper_parity",
                ],
                "confidence": "0.74",
            },
        ),
        claim_relations=(
            {
                "relation_id": "delay-depth-validates-fillability",
                "relation_type": "requires_validation",
                "source_claim_id": "delay-adjusted-liquidity-validation",
                "target_claim_id": "delay-adjusted-depth-fillability",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-arxiv-2605-15746",
        title="The Privacy Subsidy: Kyle's Lambda under Noise-Perturbed Order-Flow Observation",
        source_url="https://arxiv.org/abs/2605.15746",
        published_at="2026-05-15",
        claims=(
            {
                "claim_id": "orderflow-attribution-noise-state",
                "claim_type": "signal_mechanism",
                "claim_text": (
                    "Noise-perturbed order-flow observation changes inferred adverse selection and "
                    "market-impact estimates, so OFI signals need source-quality state."
                ),
                "asset_scope": "us_equities_intraday",
                "horizon_scope": "intraday_microstructure",
                "expected_direction": "neutral",
                "data_requirements": [
                    "order_flow_imbalance",
                    "quote_attribution_quality",
                    "impact_lambda_estimate",
                ],
                "confidence": "0.72",
            },
            {
                "claim_id": "attribution-quality-impact-stress",
                "claim_type": "risk_constraint",
                "claim_text": (
                    "Noisy or partially private flow observations can understate Kyle-lambda style "
                    "impact, requiring attribution-quality stress before treating flow as alpha."
                ),
                "asset_scope": "us_equities_intraday",
                "horizon_scope": "intraday_execution",
                "expected_direction": "neutral",
                "data_requirements": [
                    "quote_attribution_quality",
                    "route_tca",
                    "market_impact_stress",
                    "live_paper_parity",
                ],
                "confidence": "0.72",
            },
        ),
        claim_relations=(
            {
                "relation_id": "flow-noise-validates-attribution-quality",
                "relation_type": "requires_validation",
                "source_claim_id": "attribution-quality-impact-stress",
                "target_claim_id": "orderflow-attribution-noise-state",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-ssrn-6754305",
        title="Measuring Bubbles via Put-Call Disparity: A Model-Free Approach",
        source_url="https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6754305",
        published_at="2026-05-16",
        claims=(
            {
                "claim_id": "put-call-disparity-bubble-state",
                "claim_type": "feature_recipe",
                "claim_text": (
                    "Regularized put-call disparity can identify option-implied bubble states while "
                    "reducing sensitivity to thin out-of-the-money option quotes."
                ),
                "asset_scope": "index_options_risk",
                "horizon_scope": "risk_management",
                "expected_direction": "neutral",
                "data_requirements": [
                    "put_call_disparity",
                    "option_flow",
                    "quote_quality",
                ],
                "confidence": "0.72",
            },
            {
                "claim_id": "put-call-disparity-thin-quote-validation",
                "claim_type": "validation_requirement",
                "claim_text": (
                    "Option-disparity risk states should be bootstrap-stressed against microstructure "
                    "noise and thin OTM quote availability before affecting sleeve sizing."
                ),
                "asset_scope": "index_options_risk",
                "horizon_scope": "risk_management",
                "expected_direction": "neutral",
                "data_requirements": [
                    "quote_quality",
                    "transaction_cost_stress",
                    "drawdown_validation",
                ],
                "confidence": "0.72",
            },
        ),
        claim_relations=(
            {
                "relation_id": "put-call-disparity-requires-thin-quote-stress",
                "relation_type": "requires_validation",
                "source_claim_id": "put-call-disparity-thin-quote-validation",
                "target_claim_id": "put-call-disparity-bubble-state",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-ssrn-6658364",
        title="The Anatomy of a Decentralized Prediction Market: Microstructure Evidence from the Polymarket Order Book",
        source_url="https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6658364",
        published_at="2026-05-14",
        claims=(
            {
                "claim_id": "prediction-market-book-quality-state",
                "claim_type": "feature_recipe",
                "claim_text": (
                    "Continuous order-book archives can expose effective spread, ingestion delay, "
                    "depth shape, and self-counterparty activity as market-quality state variables."
                ),
                "asset_scope": "event_linked_microstructure",
                "horizon_scope": "intraday_microstructure",
                "expected_direction": "neutral",
                "data_requirements": [
                    "spread_bps",
                    "ingestion_delay",
                    "wash_trade_share",
                ],
                "confidence": "0.71",
            },
            {
                "claim_id": "book-archive-quality-validation",
                "claim_type": "validation_requirement",
                "claim_text": (
                    "Event-linked microstructure claims should fail closed when archive delay, wash "
                    "activity, or depth-profile quality would make paper fills non-representative."
                ),
                "asset_scope": "event_linked_microstructure",
                "horizon_scope": "intraday_execution",
                "expected_direction": "neutral",
                "data_requirements": [
                    "ingestion_delay",
                    "route_tca",
                    "live_paper_parity",
                ],
                "confidence": "0.71",
            },
        ),
        claim_relations=(
            {
                "relation_id": "book-quality-state-requires-archive-validation",
                "relation_type": "requires_validation",
                "source_claim_id": "book-archive-quality-validation",
                "target_claim_id": "prediction-market-book-quality-state",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-ssrn-6703098",
        title="Levering Up! Short-Horizon Option Availability and the Gamification of the Stock Market",
        source_url="https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6703098",
        published_at="2026-05-03",
        claims=(
            {
                "claim_id": "weekly-option-gamma-flow-state",
                "claim_type": "feature_recipe",
                "claim_text": (
                    "Short-horizon option availability can create gamma-sensitive underlying flow, "
                    "volume, and volatility states around speculative weekly-option trading."
                ),
                "asset_scope": "us_equities_options_linked",
                "horizon_scope": "intraday_risk_management",
                "expected_direction": "neutral",
                "data_requirements": [
                    "weekly_option_availability",
                    "gamma_exposure",
                    "option_flow",
                    "realized_volatility",
                ],
                "confidence": "0.70",
            },
            {
                "claim_id": "weekly-option-gamma-risk-validation",
                "claim_type": "risk_constraint",
                "claim_text": (
                    "Equity sleeves should stress weekly-option gamma windows separately because "
                    "higher maker hedging demand can amplify underlying volatility and turnover."
                ),
                "asset_scope": "us_equities_options_linked",
                "horizon_scope": "intraday_risk_management",
                "expected_direction": "neutral",
                "data_requirements": [
                    "gamma_exposure",
                    "turnover",
                    "drawdown_validation",
                ],
                "confidence": "0.70",
            },
        ),
        claim_relations=(
            {
                "relation_id": "weekly-options-require-gamma-risk-stress",
                "relation_type": "requires_regime",
                "source_claim_id": "weekly-option-gamma-risk-validation",
                "target_claim_id": "weekly-option-gamma-flow-state",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-ssrn-6687441",
        title="ForesightFlow: Real-Time Detection of Informed Trading in Decentralized Prediction Markets",
        source_url="https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6687441",
        published_at="2026-05-01",
        claims=(
            {
                "claim_id": "informed-flow-toxicity-score",
                "claim_type": "signal_mechanism",
                "claim_text": (
                    "Real-time informed-flow detection can combine VPIN, Kyle lambda, and hazard-rate "
                    "state to identify toxic order-flow windows before post-hoc PnL attribution."
                ),
                "asset_scope": "event_linked_microstructure",
                "horizon_scope": "intraday_microstructure",
                "expected_direction": "neutral",
                "data_requirements": [
                    "vpin",
                    "kyle_lambda",
                    "hazard_rate",
                    "informed_flow_score",
                ],
                "confidence": "0.71",
            },
            {
                "claim_id": "informed-flow-execution-veto",
                "claim_type": "risk_constraint",
                "claim_text": (
                    "Candidate entries should shrink or veto exposure during toxic informed-flow "
                    "windows unless route/TCA and live-paper parity prove fillability after costs."
                ),
                "asset_scope": "event_linked_microstructure",
                "horizon_scope": "intraday_execution",
                "expected_direction": "neutral",
                "data_requirements": [
                    "vpin",
                    "route_tca",
                    "live_paper_parity",
                    "transaction_cost_stress",
                ],
                "confidence": "0.71",
            },
        ),
        claim_relations=(
            {
                "relation_id": "informed-flow-score-requires-route-veto-validation",
                "relation_type": "requires_validation",
                "source_claim_id": "informed-flow-execution-veto",
                "target_claim_id": "informed-flow-toxicity-score",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-ssrn-6700018",
        title="Bridging Microstructure and Macro: Dynamic Regime Trading with VPIN, Hawkes, and Hurst on the S&P 500",
        source_url="https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6700018",
        published_at="2026-05-03",
        claims=(
            {
                "claim_id": "vpin-hawkes-hurst-regime-router",
                "claim_type": "feature_recipe",
                "claim_text": (
                    "A macro-regime filter can gate microstructure execution features so VPIN and "
                    "Hawkes-style toxicity signals are only used in compatible Hurst regimes."
                ),
                "asset_scope": "index_intraday_execution",
                "horizon_scope": "intraday_execution",
                "expected_direction": "neutral",
                "data_requirements": [
                    "vpin",
                    "order_arrival_clustering",
                    "hurst_regime",
                    "realized_volatility",
                ],
                "confidence": "0.66",
            },
            {
                "claim_id": "micro-macro-routing-validation",
                "claim_type": "validation_requirement",
                "claim_text": (
                    "Microstructure features should be validated inside macro regime slices instead of "
                    "pooled across hostile and favorable execution contexts."
                ),
                "asset_scope": "index_intraday_execution",
                "horizon_scope": "intraday_execution",
                "expected_direction": "neutral",
                "data_requirements": [
                    "regime_shift_validation",
                    "route_tca",
                    "walk_forward_replay",
                ],
                "confidence": "0.66",
            },
        ),
        claim_relations=(
            {
                "relation_id": "micro-macro-router-requires-regime-validation",
                "relation_type": "requires_regime",
                "source_claim_id": "micro-macro-routing-validation",
                "target_claim_id": "vpin-hawkes-hurst-regime-router",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-arxiv-2605-12151",
        title="RED-2400: A Public Benchmark of Algorithmically-Rejected Trading Events with Outcome Labels",
        source_url="https://arxiv.org/abs/2605.12151",
        published_at="2026-05-12",
        claims=(
            {
                "claim_id": "rejected-event-outcome-learning",
                "claim_type": "signal_mechanism",
                "claim_text": (
                    "Algorithmically rejected trading events with realized outcome labels can turn "
                    "skipped-signal logs into counterfactual training examples for veto calibration."
                ),
                "asset_scope": "intraday_execution",
                "horizon_scope": "rejected_event_learning",
                "expected_direction": "neutral",
                "data_requirements": [
                    "rejected_signal_log",
                    "outcome_labels",
                    "executable_quote",
                ],
                "confidence": "0.76",
            },
            {
                "claim_id": "counterfactual-reject-validation",
                "claim_type": "validation_requirement",
                "claim_text": (
                    "Rejected-event benchmarks should measure whether current vetoes discard "
                    "profitable executable opportunities or correctly block bad fills."
                ),
                "asset_scope": "intraday_execution",
                "horizon_scope": "rejected_event_learning",
                "expected_direction": "neutral",
                "data_requirements": [
                    "rejected_signal_log",
                    "counterfactual_return",
                    "route_tca",
                    "post_cost_net_pnl",
                ],
                "confidence": "0.76",
            },
        ),
        claim_relations=(
            {
                "relation_id": "rejected-outcomes-validate-vetoes",
                "relation_type": "requires_validation",
                "source_claim_id": "counterfactual-reject-validation",
                "target_claim_id": "rejected-event-outcome-learning",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-arxiv-2605-11423",
        title="A Validated Volatility-Volume-Gap Classifier for Regime Identification in MNQ Intraday Data",
        source_url="https://arxiv.org/abs/2605.11423",
        published_at="2026-05-12",
        claims=(
            {
                "claim_id": "vvg-descriptive-regime-filter",
                "claim_type": "feature_recipe",
                "claim_text": (
                    "Opening volatility, overnight gap, and abnormal volume can classify descriptive "
                    "intraday regimes, but should be used as context filters rather than direct alpha."
                ),
                "asset_scope": "intraday_momentum",
                "horizon_scope": "intraday",
                "expected_direction": "neutral",
                "data_requirements": [
                    "opening_window_return_bps",
                    "opening_window_return_from_prev_close_bps",
                    "volume_regime",
                    "realized_volatility",
                ],
                "confidence": "0.71",
            },
            {
                "claim_id": "vvg-directional-strategy-falsification",
                "claim_type": "validation_requirement",
                "claim_text": (
                    "Directional strategies derived from the classifier failed institutional "
                    "post-cost and multi-year stability gates, so promotion requires replay proof."
                ),
                "asset_scope": "intraday_momentum",
                "horizon_scope": "intraday",
                "expected_direction": "neutral",
                "data_requirements": [
                    "walk_forward_replay",
                    "transaction_cost_stress",
                    "drawdown_validation",
                    "live_paper_parity",
                ],
                "confidence": "0.75",
            },
        ),
        claim_relations=(
            {
                "relation_id": "vvg-falsification-requires-replay-proof",
                "relation_type": "invalidates",
                "source_claim_id": "vvg-directional-strategy-falsification",
                "target_claim_id": "vvg-descriptive-regime-filter",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-arxiv-2605-11640",
        title=(
            "Fill-Side Non-Retail Trading on Polymarket: An Empirical Study of Behavioral "
            "Tiers and Microstructure Signatures Under Quote-Attribution Constraints"
        ),
        source_url="https://arxiv.org/abs/2605.11640",
        published_at="2026-05-12",
        claims=(
            {
                "claim_id": "quote-lifecycle-attribution-gate",
                "claim_type": "validation_requirement",
                "claim_text": (
                    "When quote lifecycle attribution is unavailable, quote-intensity and two-sided "
                    "liquidity claims must fail closed instead of being inferred from fills."
                ),
                "asset_scope": "event_linked_microstructure",
                "horizon_scope": "intraday_microstructure",
                "expected_direction": "neutral",
                "data_requirements": [
                    "quote_attribution_quality",
                    "fill_side_vector",
                    "route_tca",
                ],
                "confidence": "0.73",
            },
            {
                "claim_id": "fill-side-tier-stratification",
                "claim_type": "feature_recipe",
                "claim_text": (
                    "Fill-side flow tiers can separate non-retail pressure when posted quote lifecycle "
                    "data is missing, but should only act as a liquidity-state context feature."
                ),
                "asset_scope": "event_linked_microstructure",
                "horizon_scope": "intraday_microstructure",
                "expected_direction": "neutral",
                "data_requirements": [
                    "fill_side_vector",
                    "notional_tier",
                    "trade_frequency_tier",
                ],
                "confidence": "0.72",
            },
        ),
        claim_relations=(
            {
                "relation_id": "quote-attribution-gates-fill-side-inference",
                "relation_type": "requires_validation",
                "source_claim_id": "quote-lifecycle-attribution-gate",
                "target_claim_id": "fill-side-tier-stratification",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-arxiv-2605-11180",
        title="The Value of Information: A Puzzle",
        source_url="https://arxiv.org/abs/2605.11180",
        published_at="2026-05-11",
        claims=(
            {
                "claim_id": "price-flow-covariance-information-value",
                "claim_type": "feature_recipe",
                "claim_text": (
                    "Covariance between price changes and order flow can proxy informed-trader value, "
                    "so OFI candidates need an information-value diagnostic rather than raw flow alone."
                ),
                "asset_scope": "us_equities_intraday",
                "horizon_scope": "intraday_microstructure",
                "expected_direction": "neutral",
                "data_requirements": [
                    "order_flow_imbalance",
                    "price_flow_covariance",
                    "impact_lambda_estimate",
                ],
                "confidence": "0.74",
            },
            {
                "claim_id": "information-value-cost-floor",
                "claim_type": "risk_constraint",
                "claim_text": (
                    "Estimated information value must clear transaction-cost and impact floors before "
                    "an order-flow signal is treated as routeable alpha."
                ),
                "asset_scope": "us_equities_intraday",
                "horizon_scope": "intraday_execution",
                "expected_direction": "neutral",
                "data_requirements": [
                    "transaction_cost_stress",
                    "market_impact_stress",
                    "post_cost_net_pnl",
                ],
                "confidence": "0.73",
            },
        ),
        claim_relations=(
            {
                "relation_id": "information-value-validates-order-flow-alpha",
                "relation_type": "requires_validation",
                "source_claim_id": "information-value-cost-floor",
                "target_claim_id": "price-flow-covariance-information-value",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-arxiv-2604-26747",
        title="From Hypotheses to Factors: Constrained LLM Agents in Cryptocurrency Markets",
        source_url="https://arxiv.org/abs/2604.26747",
        published_at="2026-04-29",
        claims=(
            {
                "claim_id": "constrained-factor-dsl-search",
                "claim_type": "signal_mechanism",
                "claim_text": (
                    "Sequential hypothesis search constrained to a point-in-time factor DSL can produce "
                    "auditable factors with fixed splits, transaction costs, and portfolio tests."
                ),
                "asset_scope": "liquid_factor_mining",
                "horizon_scope": "short_term_cross_section",
                "expected_direction": "positive",
                "data_requirements": [
                    "factor_dsl",
                    "append_only_experiment_trace",
                    "walk_forward_replay",
                ],
                "confidence": "0.77",
            },
            {
                "claim_id": "fixed-split-cost-portfolio-validation",
                "claim_type": "validation_requirement",
                "claim_text": (
                    "LLM-discovered factors must use deterministic data splits, append-only failed "
                    "hypothesis traces, transaction costs, and portfolio-level tests before promotion."
                ),
                "asset_scope": "liquid_factor_mining",
                "horizon_scope": "short_term_cross_section",
                "expected_direction": "neutral",
                "data_requirements": [
                    "append_only_experiment_trace",
                    "transaction_cost_stress",
                    "portfolio_replay",
                    "post_cost_net_pnl",
                ],
                "confidence": "0.77",
            },
        ),
        claim_relations=(
            {
                "relation_id": "factor-dsl-search-requires-fixed-split-validation",
                "relation_type": "requires_validation",
                "source_claim_id": "fixed-split-cost-portfolio-validation",
                "target_claim_id": "constrained-factor-dsl-search",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-arxiv-2604-20949",
        title="Early Detection of Latent Microstructure Regimes in Limit Order Books",
        source_url="https://arxiv.org/abs/2604.20949",
        published_at="2026-04-22",
        claims=(
            {
                "claim_id": "latent-lob-stress-leadtime",
                "claim_type": "signal_mechanism",
                "claim_text": (
                    "Latent limit-order-book build-up states can create positive lead-time before "
                    "observable stress, improving regime gating over reactive OFI or volatility alone."
                ),
                "asset_scope": "limit_order_book_intraday",
                "horizon_scope": "intraday_microstructure",
                "expected_direction": "positive",
                "data_requirements": [
                    "latent_build_up_state",
                    "order_flow_imbalance",
                    "realized_volatility",
                ],
                "confidence": "0.76",
            },
            {
                "claim_id": "rising-edge-threshold-validation",
                "claim_type": "validation_requirement",
                "claim_text": (
                    "Latent-stress detectors require rising-edge and adaptive-threshold validation "
                    "across low signal-to-noise and short build-up regimes before affecting sizing."
                ),
                "asset_scope": "limit_order_book_intraday",
                "horizon_scope": "intraday_microstructure",
                "expected_direction": "neutral",
                "data_requirements": [
                    "rising_edge_detector",
                    "adaptive_threshold",
                    "regime_shift_validation",
                    "live_paper_parity",
                ],
                "confidence": "0.75",
            },
        ),
        claim_relations=(
            {
                "relation_id": "latent-stress-detector-requires-leadtime-validation",
                "relation_type": "requires_validation",
                "source_claim_id": "rising-edge-threshold-validation",
                "target_claim_id": "latent-lob-stress-leadtime",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-arxiv-2512-15720",
        title="Hidden Order in Trades Predicts the Size of Price Moves",
        source_url="https://arxiv.org/abs/2512.15720",
        published_at="2025-12-02",
        claims=(
            {
                "claim_id": "order-flow-entropy-volatility-state",
                "claim_type": "feature_recipe",
                "claim_text": (
                    "Real-time order-flow entropy can identify volatility-state windows where absolute "
                    "return magnitude is elevated without providing directional edge."
                ),
                "asset_scope": "us_equities_intraday",
                "horizon_scope": "intraday_microstructure",
                "expected_direction": "neutral",
                "data_requirements": [
                    "order_flow_entropy",
                    "trade_sign_markov_state",
                    "realized_volatility",
                ],
                "confidence": "0.75",
            },
            {
                "claim_id": "entropy-not-directional-alpha",
                "claim_type": "validation_requirement",
                "claim_text": (
                    "Entropy states must be used as sizing or volatility context, not direct direction, "
                    "unless a separate directional signal clears walk-forward and label-placebo tests."
                ),
                "asset_scope": "us_equities_intraday",
                "horizon_scope": "intraday_microstructure",
                "expected_direction": "neutral",
                "data_requirements": [
                    "walk_forward_replay",
                    "label_permutation_placebo",
                    "live_paper_parity",
                ],
                "confidence": "0.75",
            },
        ),
        claim_relations=(
            {
                "relation_id": "entropy-state-invalidates-directional-only-use",
                "relation_type": "invalidates",
                "source_claim_id": "entropy-not-directional-alpha",
                "target_claim_id": "order-flow-entropy-volatility-state",
                "rationale": (
                    "Entropy can gate volatility or sizing, but it does not itself prove directional alpha."
                ),
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-arxiv-2605-05580",
        title="AlphaCrafter: A Full-Stack Multi-Agent Framework for Cross-Sectional Quantitative Trading",
        source_url="https://arxiv.org/abs/2605.05580",
        published_at="2026-05-07",
        claims=(
            {
                "claim_id": "adaptive-factor-to-execution-loop",
                "claim_type": "portfolio_construction",
                "claim_text": (
                    "AlphaCrafter-style adaptive factor-to-execution loops combine continuous "
                    "factor mining, adaptive factor screening, and risk-constrained execution "
                    "instead of treating alpha discovery as a one-shot static search."
                ),
                "asset_scope": "us_equities_cross_section",
                "horizon_scope": "cross_sectional_portfolio",
                "expected_direction": "positive",
                "data_requirements": [
                    "continuous_factor_mining",
                    "factor_pool_expansion",
                    "adaptive_factor_screener",
                    "regime_adaptive_factor_ensemble",
                    "risk_constrained_execution",
                ],
                "confidence": "0.74",
            },
            {
                "claim_id": "adaptive-loop-runtime-ledger-validation",
                "claim_type": "validation_requirement",
                "claim_text": (
                    "Agentic factor discovery and screening can only rank replay candidates; "
                    "promotion still requires walk-forward replay, explicit costs, and "
                    "runtime-ledger/live-paper proof."
                ),
                "asset_scope": "us_equities_cross_section",
                "horizon_scope": "cross_sectional_portfolio_validation",
                "expected_direction": "neutral",
                "data_requirements": [
                    "portfolio_replay",
                    "walk_forward_replay",
                    "transaction_cost_stress",
                    "post_cost_net_pnl",
                    "runtime_ledger_profit_proof",
                ],
                "confidence": "0.76",
            },
        ),
        claim_relations=(
            {
                "relation_id": "adaptive-factor-loop-requires-ledger-validation",
                "relation_type": "requires_validation",
                "source_claim_id": "adaptive-loop-runtime-ledger-validation",
                "target_claim_id": "adaptive-factor-to-execution-loop",
            },
        ),
    ),
    WhitepaperResearchSource(
        run_id="seed-arxiv-2510-11616",
        title="Attention Factors for Statistical Arbitrage",
        source_url="https://arxiv.org/abs/2510.11616",
        published_at="2025-10-13",
        claims=(
            {
                "claim_id": "attention-factor-residual-statarb",
                "claim_type": "signal_mechanism",
                "claim_text": (
                    "Conditional latent attention factors can identify similar-asset residual "
                    "portfolios and mispricing signals for statistical arbitrage when the factor "
                    "model and trading policy are optimized jointly after transaction costs."
                ),
                "asset_scope": "us_equities_cross_section",
                "horizon_scope": "statistical_arbitrage",
                "expected_direction": "positive",
                "data_requirements": [
                    "firm_characteristic_embeddings",
                    "attention_factor_exposures",
                    "cross_sectional_similarity_graph",
                    "residual_portfolio_returns",
                    "transaction_cost_model",
                ],
                "confidence": "0.75",
            },
            {
                "claim_id": "residual-sequence-policy-features",
                "claim_type": "feature_recipe",
                "claim_text": (
                    "Residual-portfolio return sequences should feed candidate ranking and policy "
                    "selection instead of relying only on static pair-spread z-scores."
                ),
                "asset_scope": "us_equities_cross_section",
                "horizon_scope": "statistical_arbitrage",
                "expected_direction": "positive",
                "data_requirements": [
                    "residual_return_sequence",
                    "pair_relative_return",
                    "factor_neutral_residual",
                    "residual_spread_zscore",
                    "turnover",
                ],
                "confidence": "0.74",
            },
            {
                "claim_id": "attention-factor-post-cost-validation",
                "claim_type": "validation_requirement",
                "claim_text": (
                    "Attention-factor statistical-arbitrage candidates remain research candidates "
                    "until walk-forward replay, transaction-cost stress, and runtime-ledger or "
                    "live-paper proof validate closed-position post-cost PnL."
                ),
                "asset_scope": "us_equities_cross_section",
                "horizon_scope": "statistical_arbitrage_validation",
                "expected_direction": "neutral",
                "data_requirements": [
                    "walk_forward_replay",
                    "transaction_cost_stress",
                    "runtime_ledger_profit_proof",
                    "post_cost_net_pnl",
                    "closed_round_trips",
                ],
                "confidence": "0.76",
            },
        ),
        claim_relations=(
            {
                "relation_id": "attention-factor-statarb-requires-ledger-proof",
                "relation_type": "requires_validation",
                "source_claim_id": "attention-factor-post-cost-validation",
                "target_claim_id": "attention-factor-residual-statarb",
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


def sources_from_jsonl(path: Path) -> list[WhitepaperResearchSource]:
    sources: list[WhitepaperResearchSource] = []
    for line_number, line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), start=1
    ):
        if not line.strip():
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(
                f"whitepaper_source_jsonl_invalid_json:{path}:{line_number}"
            ) from exc
        if not isinstance(payload, Mapping):
            raise ValueError(
                f"whitepaper_source_jsonl_row_not_mapping:{path}:{line_number}"
            )
        sources.append(source_from_payload(cast(Mapping[str, Any], payload)))
    return sources
