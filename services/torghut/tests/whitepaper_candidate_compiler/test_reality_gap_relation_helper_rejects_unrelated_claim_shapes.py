from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.whitepaper_candidate_compiler.support import (
    Decimal,
    Path,
    _TestWhitepaperCandidateCompilerBase,
    _expected_portfolio_target_candidate_count,
    candidate_specs_module,
    compile_claim_payloads_to_whitepaper_experiments,
    compiler_module,
)


class TestRealityGapRelationHelperRejectsUnrelatedClaimShapes(
    _TestWhitepaperCandidateCompilerBase
):
    def test_reality_gap_relation_helper_rejects_unrelated_claim_shapes(self) -> None:
        spec = candidate_specs_module.CandidateSpec(
            schema_version="torghut.candidate-spec.v1",
            candidate_spec_id="spec-reality-gap-helper",
            hypothesis_id="hyp-reality-gap-helper",
            family_template_id="microstructure_continuation_matched_filter_v1",
            candidate_kind="sleeve",
            runtime_family="breakout_continuation_consistent",
            runtime_strategy_name="breakout-continuation-long-v1",
            feature_contract={
                "source_claims": [
                    {
                        "claim_id": "feature-source",
                        "claim_type": "feature_recipe",
                        "claim_text": "LOB simulation feature recipe.",
                    },
                    {
                        "claim_id": "risk-source",
                        "claim_type": "risk_constraint",
                        "claim_text": "Simulation reality gap requires fill outcomes.",
                    },
                    {
                        "claim_id": "risk-target",
                        "claim_type": "risk_constraint",
                        "claim_text": "Capital sizing risk target.",
                    },
                    {
                        "claim_id": "signal-target",
                        "claim_type": "signal_mechanism",
                        "claim_text": "LOB simulation signal target.",
                    },
                ]
            },
            parameter_space={"mechanism_overlay_ids": []},
            strategy_overrides={},
            objective={"target_net_pnl_per_day": "500"},
            hard_vetoes={},
            expected_failure_modes=(),
            promotion_contract={},
        )

        self.assertEqual(compiler_module._claim_type(None), "")
        self.assertIn(
            "flow", compiler_module._claim_haystack(None, {"claim_text": "flow"})
        )
        self.assertFalse(
            compiler_module._is_simulation_reality_gap_validation_relation(
                {
                    "relation_type": "supports",
                    "source_claim_id": "risk-source",
                    "target_claim_id": "signal-target",
                },
                spec,
            )
        )
        self.assertFalse(
            compiler_module._is_simulation_reality_gap_validation_relation(
                {
                    "relation_type": "invalidates",
                    "source_claim_id": "feature-source",
                    "target_claim_id": "signal-target",
                },
                spec,
            )
        )
        self.assertFalse(
            compiler_module._is_simulation_reality_gap_validation_relation(
                {
                    "relation_type": "invalidates",
                    "source_claim_id": "risk-source",
                    "target_claim_id": "risk-target",
                },
                spec,
            )
        )

    def test_contradictory_claim_relation_blocks_dependent_candidate_specs(
        self,
    ) -> None:
        compilation = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-run-contradiction",
            claims=[
                {
                    "claim_id": "claim-flow",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Clustered order flow imbalance improves short-horizon LOB signals.",
                    "confidence": "0.82",
                },
                {
                    "claim_id": "claim-validation",
                    "claim_type": "validation_requirement",
                    "claim_text": "The signal must pass liquidity-shock replay windows.",
                    "confidence": "0.76",
                },
            ],
            relations=[
                {
                    "relation_id": "rel-invalidates-flow",
                    "relation_type": "invalidates",
                    "source_claim_id": "claim-validation",
                    "target_claim_id": "claim-flow",
                    "rationale": "The validation claim invalidates direct execution.",
                }
            ],
            target_net_pnl_per_day=Decimal("500"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )

        self.assertEqual(
            len(compilation.candidate_specs),
            _expected_portfolio_target_candidate_count(),
        )
        self.assertEqual(compilation.executable_specs, ())
        self.assertEqual(
            len(compilation.blocked_specs), _expected_portfolio_target_candidate_count()
        )
        self.assertTrue(
            all(
                blocker.reason == "contradictory_claim_relation"
                for blocker in compilation.blockers
            )
        )
        self.assertEqual(
            compilation.blockers[0].detail["claim_relation_blockers"][0]["relation_id"],
            "rel-invalidates-flow",
        )

    def test_reality_gap_invalidates_relation_stays_executable_as_validation_contract(
        self,
    ) -> None:
        compilation = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-arxiv-2603.24137",
            claims=[
                {
                    "claim_id": "lob-simulation-benchmark-parity",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Limit-order-book simulation can expose stylized fillability "
                        "and adverse-selection mechanisms only when calibrated "
                        "against real event streams and fill outcomes."
                    ),
                    "asset_scope": "intraday_microstructure",
                    "horizon_scope": "simulation_validation",
                    "expected_direction": "neutral",
                    "data_requirements": [
                        "lob_event_stream",
                        "fill_outcomes",
                        "simulation_parity",
                    ],
                    "confidence": "0.76",
                },
                {
                    "claim_id": "sim-to-live-reality-gap-validation",
                    "claim_type": "risk_constraint",
                    "claim_text": (
                        "LOB simulation reality gaps require explicit parity metrics "
                        "before simulated fillability or adverse-selection estimates "
                        "can affect capital gates."
                    ),
                    "asset_scope": "intraday_microstructure",
                    "horizon_scope": "simulation_validation",
                    "expected_direction": "neutral",
                    "data_requirements": [
                        "simulation_parity",
                        "live_paper_parity",
                        "adverse_selection_stress",
                        "route_tca",
                    ],
                    "confidence": "0.77",
                },
            ],
            relations=[
                {
                    "relation_id": "lob-sim-reality-gap-blocks-synthetic-proof",
                    "relation_type": "invalidates",
                    "source_claim_id": "sim-to-live-reality-gap-validation",
                    "target_claim_id": "lob-simulation-benchmark-parity",
                }
            ],
            target_net_pnl_per_day=Decimal("500"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )

        self.assertEqual(
            len(compilation.candidate_specs),
            _expected_portfolio_target_candidate_count(),
        )
        self.assertTrue(compilation.executable_specs)
        self.assertFalse(
            [
                blocker
                for blocker in compilation.blockers
                if blocker.reason == "contradictory_claim_relation"
            ]
        )
        self.assertTrue(
            any(
                "simulation_reality_gap_implementation_risk"
                in spec.parameter_space.get("mechanism_overlay_ids", [])
                for spec in compilation.executable_specs
            )
        )
        self.assertTrue(
            all(
                spec.hard_vetoes.get("required_simulation_live_parity_metrics")
                for spec in compilation.executable_specs
            )
        )
        self.assertTrue(
            all(
                spec.promotion_contract.get(
                    "rejects_synthetic_lob_fillability_as_capital_gate"
                )
                for spec in compilation.executable_specs
            )
        )

    def test_implementation_risk_claims_compile_to_backtest_stability_overlay(
        self,
    ) -> None:
        compilation = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-arxiv-2603.20319",
            claims=[
                {
                    "claim_id": "multi-engine-implementation-risk-replay",
                    "claim_type": "feature_recipe",
                    "claim_text": (
                        "Implementation risk in portfolio backtesting means the "
                        "same logical strategy must be replayed across independent "
                        "engines before post-cost net PnL can be promotion evidence."
                    ),
                    "asset_scope": "us_equities_portfolio",
                    "horizon_scope": "portfolio_backtesting",
                    "expected_direction": "neutral",
                    "data_requirements": [
                        "multi_engine_replay",
                        "engine_sensitivity",
                        "implementation_uncertainty_interval",
                        "transaction_cost_stress",
                    ],
                    "confidence": "0.78",
                },
                {
                    "claim_id": "conclusion-stability-capital-gate",
                    "claim_type": "risk_constraint",
                    "claim_text": (
                        "A candidate should affect capital gates only when the "
                        "implementation-uncertainty lower bound stays above target "
                        "and conclusion stability agrees across replay implementations."
                    ),
                    "asset_scope": "us_equities_portfolio",
                    "horizon_scope": "portfolio_backtesting",
                    "expected_direction": "neutral",
                    "data_requirements": [
                        "implementation_uncertainty_interval",
                        "conclusion_stability",
                        "post_cost_net_pnl",
                        "multi_engine_replay",
                    ],
                    "confidence": "0.80",
                },
            ],
            relations=[
                {
                    "relation_id": (
                        "implementation-uncertainty-requires-multi-engine-stability"
                    ),
                    "relation_type": "requires_validation",
                    "source_claim_id": "conclusion-stability-capital-gate",
                    "target_claim_id": "multi-engine-implementation-risk-replay",
                }
            ],
            target_net_pnl_per_day=Decimal("500"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )

        self.assertTrue(compilation.executable_specs)
        self.assertTrue(
            any(
                "implementation_risk_backtest_stability"
                in spec.parameter_space.get("mechanism_overlay_ids", [])
                for spec in compilation.executable_specs
            )
        )
        self.assertTrue(
            all(
                spec.promotion_contract.get("rejects_single_engine_backtest_proof")
                for spec in compilation.executable_specs
            )
        )
        self.assertTrue(
            all(
                spec.hard_vetoes.get(
                    "required_implementation_uncertainty_lower_bound_above_target"
                )
                for spec in compilation.executable_specs
            )
        )

    def test_crumbling_quote_claims_compile_to_validation_only_overlay(self) -> None:
        compilation = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-arxiv-2604-21993",
            claims=[
                {
                    "claim_id": "crumbling-quote-probability",
                    "claim_type": "execution_assumption",
                    "claim_text": (
                        "Calibrated crumbling quote probabilities detect transient "
                        "mechanical liquidity erosion before aggressive routing."
                    ),
                    "asset_scope": "us_equities_lob",
                    "horizon_scope": "intraday_microstructure",
                    "expected_direction": "down",
                    "data_requirements": [
                        "crumbling_quote_probability",
                        "mechanical_liquidity_erosion",
                        "lob_event_stream",
                    ],
                    "confidence": "0.78",
                },
                {
                    "claim_id": "crumbling-live-paper-route-tca",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Crumbling quote detections can only tighten routing after "
                        "executable quotes and route TCA match live-paper evidence."
                    ),
                    "asset_scope": "us_equities_lob",
                    "horizon_scope": "intraday_microstructure",
                    "expected_direction": "neutral",
                    "data_requirements": [
                        "executable_quote",
                        "route_tca",
                        "live_paper_parity",
                    ],
                    "confidence": "0.76",
                },
            ],
            target_net_pnl_per_day=Decimal("500"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )

        self.assertTrue(compilation.executable_specs)
        self.assertTrue(
            all(
                "crumbling_quote_liquidity_erosion"
                in spec.parameter_space.get("mechanism_overlay_ids", [])
                for spec in compilation.executable_specs
            )
        )
        self.assertTrue(
            all(
                spec.hard_vetoes.get("required_crumbling_quote_probability")
                and spec.hard_vetoes.get(
                    "required_mechanical_liquidity_erosion_probability"
                )
                for spec in compilation.executable_specs
            )
        )
        self.assertTrue(
            all(
                spec.promotion_contract.get(
                    "rejects_crumbling_quote_simulation_as_promotion_proof"
                )
                and spec.promotion_contract.get("requires_live_paper_parity")
                for spec in compilation.executable_specs
            )
        )
        self.assertTrue(
            all(
                spec.strategy_overrides["params"].get("entry_order_type")
                == "prefer_limit"
                for spec in compilation.executable_specs
            )
        )

    def test_mpc_execution_claims_compile_to_dynamic_schedule_overlay(self) -> None:
        compilation = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-arxiv-2603.28898",
            claims=[
                {
                    "claim_id": "dynamic-execution-schedule-control",
                    "claim_type": "feature_recipe",
                    "claim_text": (
                        "Model-predictive execution control can adapt participation "
                        "and urgency to liquidity forecasts, inventory path, and "
                        "execution shortfall."
                    ),
                    "asset_scope": "us_equities_execution",
                    "horizon_scope": "intraday_execution",
                    "expected_direction": "neutral",
                    "data_requirements": [
                        "execution_schedule_trace",
                        "liquidity_forecast",
                        "inventory_path",
                        "execution_shortfall",
                    ],
                    "confidence": "0.71",
                },
                {
                    "claim_id": "mpc-execution-stress-required",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Dynamic execution schedules should remain validation-only "
                        "until replay shows lower shortfall after latency, spread, "
                        "and market-impact stress."
                    ),
                    "asset_scope": "us_equities_execution",
                    "horizon_scope": "intraday_execution",
                    "expected_direction": "neutral",
                    "data_requirements": [
                        "latency_stress",
                        "market_impact_stress",
                        "post_cost_net_pnl",
                    ],
                    "confidence": "0.72",
                },
            ],
            relations=[
                {
                    "relation_id": "mpc-execution-validates-dynamic-schedule",
                    "relation_type": "requires_validation",
                    "source_claim_id": "mpc-execution-stress-required",
                    "target_claim_id": "dynamic-execution-schedule-control",
                }
            ],
            target_net_pnl_per_day=Decimal("500"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )

        self.assertTrue(compilation.executable_specs)
        self.assertTrue(
            any(
                "mpc_dynamic_execution_schedule"
                in spec.parameter_space.get("mechanism_overlay_ids", [])
                for spec in compilation.executable_specs
            )
        )
        self.assertTrue(
            all(
                spec.hard_vetoes.get("required_execution_schedule_trace")
                for spec in compilation.executable_specs
            )
        )
        self.assertTrue(
            all(
                spec.promotion_contract.get(
                    "rejects_dynamic_schedule_without_shortfall_ablation"
                )
                for spec in compilation.executable_specs
            )
        )

    def test_deployment_consistency_claims_compile_to_semantic_parity_overlay(
        self,
    ) -> None:
        compilation = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-arxiv-2603.21330",
            claims=[
                {
                    "claim_id": "weight-centric-unified-execution-protocol",
                    "claim_type": "feature_recipe",
                    "claim_text": (
                        "A deployment-consistent trading architecture keeps data "
                        "processing, strategy construction, backtesting, and broker "
                        "execution behind one weight-centric protocol."
                    ),
                    "asset_scope": "us_equities_portfolio",
                    "horizon_scope": "research_to_live_deployment",
                    "expected_direction": "neutral",
                    "data_requirements": [
                        "portfolio_weight_trace",
                        "signal_payload_parity",
                        "order_sizing_parity",
                        "broker_execution_semantics",
                    ],
                    "confidence": "0.76",
                },
                {
                    "claim_id": "replay-paper-live-semantic-parity-required",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Replay, paper, and live broker paths must use the same "
                        "signal payloads, order sizing, route constraints, and "
                        "execution semantics before post-cost PnL is promotion evidence."
                    ),
                    "asset_scope": "us_equities_portfolio",
                    "horizon_scope": "research_to_live_deployment",
                    "expected_direction": "neutral",
                    "data_requirements": [
                        "replay_paper_live_semantic_parity",
                        "signal_payload_parity",
                        "order_sizing_parity",
                        "route_constraint_parity",
                        "live_paper_parity",
                    ],
                    "confidence": "0.78",
                },
                {
                    "claim_id": "broker-execution-risk-overlay-parity",
                    "claim_type": "risk_constraint",
                    "claim_text": (
                        "Portfolio-level risk overlays and broker execution semantics "
                        "must remain invariant between backtest, paper, and live adapters."
                    ),
                    "asset_scope": "us_equities_portfolio",
                    "horizon_scope": "research_to_live_deployment",
                    "expected_direction": "neutral",
                    "data_requirements": [
                        "portfolio_risk_overlay_parity",
                        "broker_execution_semantics",
                        "route_constraint_parity",
                        "replay_harness_implementation_trace",
                    ],
                    "confidence": "0.78",
                },
            ],
            relations=[
                {
                    "relation_id": (
                        "deployment-consistency-requires-semantic-parity-proof"
                    ),
                    "relation_type": "requires_validation",
                    "source_claim_id": "replay-paper-live-semantic-parity-required",
                    "target_claim_id": "weight-centric-unified-execution-protocol",
                }
            ],
            target_net_pnl_per_day=Decimal("500"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )

        self.assertTrue(compilation.executable_specs)
        self.assertTrue(
            all(
                "replay_paper_live_semantic_parity"
                in spec.parameter_space.get("mechanism_overlay_ids", [])
                for spec in compilation.executable_specs
            )
        )
        self.assertTrue(
            all(
                spec.hard_vetoes.get("required_order_sizing_parity")
                for spec in compilation.executable_specs
            )
        )
        self.assertTrue(
            all(
                spec.promotion_contract.get("rejects_adapter_only_execution_behavior")
                for spec in compilation.executable_specs
            )
        )

    def test_risk_aware_trading_portfolio_claims_compile_to_optimizer_overlay(
        self,
    ) -> None:
        compilation = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-arxiv-2503.04662",
            claims=[
                {
                    "claim_id": "ratpo-risk-pnl-optimizer",
                    "claim_type": "portfolio_construction",
                    "claim_text": (
                        "Risk-aware trading portfolio optimization uses a RATS "
                        "algorithm over unique eligible instruments and eligible "
                        "optimization strategy candidates."
                    ),
                    "asset_scope": "us_equities_portfolio",
                    "horizon_scope": "portfolio_risk_control",
                    "expected_direction": "positive",
                    "data_requirements": [
                        "risk_aware_trading_portfolio_optimization",
                        "market_risk_var",
                        "pnl_objective",
                        "eligible_instrument_universe",
                        "eligible_optimization_strategy",
                        "transaction_cost_stress",
                    ],
                    "confidence": "0.76",
                },
                {
                    "claim_id": "ratpo-risk-limit-validation",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Market sensitivity constraints, capital charge stress, "
                        "and risk limit compliance are required before replay "
                        "selection."
                    ),
                    "asset_scope": "us_equities_portfolio",
                    "horizon_scope": "portfolio_risk_control",
                    "expected_direction": "neutral",
                    "data_requirements": [
                        "market_sensitivity_constraints",
                        "capital_charge_stress",
                        "risk_limit_compliance",
                        "portfolio_replay",
                        "walk_forward_replay",
                    ],
                    "confidence": "0.75",
                },
            ],
            relations=[
                {
                    "relation_id": (
                        "ratpo-risk-constraints-require-cost-aware-optimization"
                    ),
                    "relation_type": "requires_validation",
                    "source_claim_id": "ratpo-risk-limit-validation",
                    "target_claim_id": "ratpo-risk-pnl-optimizer",
                }
            ],
            target_net_pnl_per_day=Decimal("500"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )

        self.assertTrue(compilation.executable_specs)
        self.assertTrue(
            all(
                "risk_aware_trading_portfolio_optimization"
                in spec.parameter_space.get("mechanism_overlay_ids", [])
                for spec in compilation.executable_specs
            )
        )
        self.assertTrue(
            all(
                spec.hard_vetoes.get("required_market_risk_var")
                for spec in compilation.executable_specs
            )
        )
        self.assertTrue(
            all(
                spec.hard_vetoes.get("required_capital_charge_stress")
                for spec in compilation.executable_specs
            )
        )
        self.assertTrue(
            all(
                spec.promotion_contract.get("rejects_optimizer_only_promotion")
                for spec in compilation.executable_specs
            )
        )
