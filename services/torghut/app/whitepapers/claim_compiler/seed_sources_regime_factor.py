"""Curated recent whitepaper seeds for Torghut hypothesis compilation."""

from __future__ import annotations

from .models import WhitepaperResearchSource


RECENT_WHITEPAPER_REGIME_FACTOR_SEEDS: tuple[WhitepaperResearchSource, ...] = (
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
