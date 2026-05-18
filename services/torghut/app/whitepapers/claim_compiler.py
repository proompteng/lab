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
                "relation_type": "invalidates",
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
