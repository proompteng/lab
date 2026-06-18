"""Curated recent whitepaper seeds for Torghut hypothesis compilation."""

from __future__ import annotations

from .models import WhitepaperResearchSource


RECENT_WHITEPAPER_MICROSTRUCTURE_SEEDS: tuple[WhitepaperResearchSource, ...] = (
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
)
