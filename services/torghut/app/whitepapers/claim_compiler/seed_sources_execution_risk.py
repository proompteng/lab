"""Curated recent whitepaper seeds for Torghut hypothesis compilation."""

from __future__ import annotations

from .models import WhitepaperResearchSource


RECENT_WHITEPAPER_EXECUTION_RISK_SEEDS: tuple[WhitepaperResearchSource, ...] = (
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
)
