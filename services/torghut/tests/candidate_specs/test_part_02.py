from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.candidate_specs.support import *


class TestCandidateSpecsPart2(_TestCandidateSpecsBase):
    def test_deployment_consistency_claim_adds_semantic_parity_overlay(
        self,
    ) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-finrl-x-deployment-consistency",
            claims=[
                {
                    "claim_id": "weight-centric-unified-execution-protocol",
                    "claim_type": "feature_recipe",
                    "claim_text": (
                        "FinRL-X uses a deployment-consistent weight-centric "
                        "protocol so data processing, strategy construction, "
                        "backtesting, and broker execution keep downstream "
                        "execution semantics unchanged."
                    ),
                    "data_requirements": [
                        "portfolio_weight_trace",
                        "signal_payload_parity",
                        "order_sizing_parity",
                        "broker_execution_semantics",
                    ],
                    "confidence": "0.78",
                },
                {
                    "claim_id": "replay-paper-live-semantic-parity-required",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Replay paper live semantic parity requires identical "
                        "signal payloads, order sizing, route constraints, and "
                        "portfolio risk overlays before promotion."
                    ),
                    "data_requirements": [
                        "replay_paper_live_semantic_parity",
                        "signal_payload_parity",
                        "order_sizing_parity",
                        "route_constraint_parity",
                        "portfolio_risk_overlay_parity",
                        "live_paper_parity",
                    ],
                    "confidence": "0.78",
                },
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        self.assertIn(
            "replay_paper_live_semantic_parity",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertTrue(
            specs[0].hard_vetoes["required_replay_paper_live_semantic_parity"]
        )
        self.assertTrue(specs[0].hard_vetoes["required_signal_payload_parity"])
        self.assertEqual(
            specs[0].hard_vetoes["required_adapter_behavior_drift_count"], "0"
        )
        self.assertTrue(
            specs[0].promotion_contract["rejects_adapter_only_execution_behavior"]
        )
        self.assertTrue(
            specs[0].promotion_contract["requires_broker_execution_semantics"]
        )

    def test_market_limit_execution_claim_adds_candidate_local_policy(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-market-limit-execution",
            claims=[
                {
                    "claim_id": "mixed-market-limit-execution-policy",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Dynamic allocation between market and limit orders can improve "
                        "execution revenue when spread, limit fill probability, order type "
                        "ablation, price improvement, and opportunity cost are modeled."
                    ),
                    "data_requirements": [
                        "market_limit_order_mix",
                        "limit_fill_probability",
                        "execution_shortfall",
                        "order_type_ablation",
                        "opportunity_cost",
                        "price_improvement",
                    ],
                    "confidence": "0.74",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("300")
        )

        params = specs[0].strategy_overrides["params"]
        self.assertEqual(params["entry_order_type"], "prefer_limit")
        self.assertEqual(params["market_order_spread_bps_max"], "6")
        self.assertIn(
            "mixed_market_limit_execution_policy",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertIn(
            "logistic_normal_market_limit_allocation_grid",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        allocation_grid = specs[0].parameter_space[
            "logistic_normal_market_limit_allocation_grid"
        ]
        self.assertEqual(
            allocation_grid["schema_version"],
            "torghut.logistic-normal-market-limit-allocation-grid.v1",
        )
        self.assertEqual(
            allocation_grid["allocation_dimensions"],
            ["market_order_share", "best_limit_share", "passive_limit_share"],
        )
        self.assertIn(
            "allocation_covariance_scale_grid",
            allocation_grid["candidate_search_inputs"],
        )
        self.assertIn("arxiv-2507.06345", allocation_grid["source_ids"])
        self.assertFalse(allocation_grid["proof_neutrality"]["proof_authority"])
        self.assertTrue(
            specs[0].hard_vetoes["required_logistic_normal_allocation_grid"]
        )
        self.assertTrue(specs[0].hard_vetoes["required_order_type_ablation_passed"])
        self.assertEqual(
            specs[0].hard_vetoes["required_min_order_type_ablation_sample_count"],
            "60",
        )
        self.assertTrue(specs[0].hard_vetoes["required_price_improvement_evidence"])
        self.assertTrue(specs[0].hard_vetoes["required_opportunity_cost_evidence"])
        self.assertEqual(
            specs[0].hard_vetoes["required_max_order_type_opportunity_cost_bps"],
            "8",
        )
        self.assertTrue(
            specs[0].promotion_contract["requires_order_type_execution_quality"]
        )
        self.assertTrue(specs[0].promotion_contract["requires_order_type_ablation"])
        self.assertTrue(specs[0].promotion_contract["requires_market_limit_order_mix"])
        self.assertTrue(
            specs[0].promotion_contract["requires_logistic_normal_allocation_grid"]
        )

    def test_intraday_volume_forecast_claim_adds_periodicity_capacity_contract(
        self,
    ) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-intraday-volume-forecast",
            claims=[
                {
                    "claim_id": "intraday-volume-periodicity",
                    "claim_type": "execution_assumption",
                    "claim_text": (
                        "Intraday volume forecasting and VWAP execution need "
                        "u-shaped volume periodicity and clock-bucket capacity."
                    ),
                    "data_requirements": [
                        "intraday_volume_forecast",
                        "vwap",
                        "route_tca",
                    ],
                    "confidence": "0.82",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        first = specs[0]

        self.assertIn(
            "intraday_volume_periodicity_execution",
            first.parameter_space["mechanism_overlay_ids"],
        )
        self.assertIn(
            first.family_template_id,
            {
                "opening_drive_leader_reclaim_v1",
                "late_day_continuation_v1",
                "intraday_tsmom_v2",
                "breakout_reclaim_v2",
            },
        )
        self.assertTrue(first.hard_vetoes["required_intraday_volume_forecast"])
        self.assertEqual(
            first.hard_vetoes["required_min_volume_periodicity_capacity_ratio"],
            "1.00",
        )
        self.assertTrue(first.promotion_contract["requires_clock_bucket_capacity"])
        self.assertTrue(
            first.promotion_contract["rejects_pooled_all_day_capacity_assumptions"]
        )

    def test_execution_delay_depth_claim_adds_delay_adjusted_stress_contract(
        self,
    ) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-depth-delay",
            claims=[
                {
                    "claim_id": "execution-delay-depth-state",
                    "claim_type": "feature_recipe",
                    "claim_text": (
                        "Market depth and execution delay jointly determine "
                        "whether apparent liquidity is practically fillable."
                    ),
                    "data_requirements": [
                        "market_depth",
                        "execution_delay",
                        "latency_stress",
                        "limit_fill_probability",
                        "route_tca",
                    ],
                    "confidence": "0.81",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("300")
        )

        self.assertIn(
            "delay_adjusted_depth_stress",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertTrue(specs[0].hard_vetoes["required_delay_adjusted_depth_stress"])
        self.assertEqual(
            specs[0].hard_vetoes["required_max_route_latency_ms"],
            "250",
        )
        self.assertTrue(
            specs[0].promotion_contract["requires_delay_adjusted_depth_stress"]
        )
        self.assertTrue(
            specs[0].promotion_contract["rejects_no_delay_fill_assumptions"]
        )

    def test_queue_position_survival_claim_adds_fill_curve_contract(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-kanformer-queue-survival",
            claims=[
                {
                    "claim_id": "kanformer-fill-survival",
                    "claim_type": "execution_assumption",
                    "claim_text": (
                        "KANFormer predicts limit order fill probabilities with "
                        "queue-position survival analysis and time-to-fill quantiles, "
                        "while queue-reactive replay and order submission latency "
                        "stress expose nonfill opportunity cost."
                    ),
                    "data_requirements": [
                        "queue_position",
                        "survival_fill_curve",
                        "time_to_fill_quantiles",
                        "right_censored_time_to_fill_labels",
                        "fill_probability_calibration_metrics",
                        "queue_reactive_replay_parity",
                        "latency_distribution",
                        "nonfill_opportunity_cost",
                        "route_tca",
                    ],
                    "confidence": "0.80",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        self.assertIn(
            "queue_position_survival_fill_curve",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertIn(
            "queue_reactive_survival_latency_grid",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        survival_grid = specs[0].parameter_space["queue_reactive_survival_latency_grid"]
        self.assertEqual(
            survival_grid["schema_version"],
            "torghut.queue-reactive-survival-latency-grid.v1",
        )
        self.assertEqual(
            survival_grid["source_ids"],
            [
                "arxiv-2501.08822",
                "arxiv-2511.15262",
                "arxiv-2512.05734",
                "arxiv-2504.00846",
            ],
        )
        self.assertIn(
            "kanformer",
            survival_grid["candidate_search_inputs"]["survival_model_family_grid"],
        )
        self.assertIn(
            "multidimensional_deep_queue_reactive",
            survival_grid["candidate_search_inputs"][
                "queue_reactive_model_family_grid"
            ],
        )
        self.assertIn(
            "submission_latency_ms",
            survival_grid["stress_inputs_required"],
        )
        self.assertIn(
            "right_censored_log_likelihood",
            survival_grid["diagnostics_required"],
        )
        self.assertIn(
            "missed_winner_vs_filled_loser_count",
            survival_grid["diagnostics_required"],
        )
        self.assertTrue(
            survival_grid["proof_neutrality"][
                "rejects_survival_model_fill_probability_as_fill_authority"
            ]
        )
        self.assertTrue(
            survival_grid["proof_neutrality"][
                "rejects_queue_reactive_counterfactual_pnl_as_profit_proof"
            ]
        )
        self.assertTrue(survival_grid["proof_neutrality"]["requires_runtime_ledger"])
        self.assertTrue(
            specs[0].hard_vetoes["required_queue_position_survival_fill_curve"]
        )
        self.assertTrue(
            specs[0].hard_vetoes["required_queue_reactive_survival_latency_grid"]
        )
        self.assertEqual(
            specs[0].hard_vetoes["required_min_queue_position_survival_sample_count"],
            "60",
        )
        self.assertTrue(specs[0].hard_vetoes["required_time_to_fill_quantiles"])
        self.assertTrue(
            specs[0].hard_vetoes["required_right_censored_time_to_fill_labels"]
        )
        self.assertEqual(
            specs[0].hard_vetoes["required_max_fill_probability_calibration_error"],
            "0.08",
        )
        self.assertEqual(
            specs[0].hard_vetoes["required_min_fill_survival_c_index"],
            "0.55",
        )
        self.assertTrue(specs[0].hard_vetoes["required_latency_distribution"])
        self.assertTrue(specs[0].hard_vetoes["required_queue_reactive_replay_parity"])
        mechanism_overlays = candidate_specs_module._mechanism_overlays_for_card(
            cards[0]
        )
        queue_contract = next(
            contract
            for contract in mechanism_overlays["feature_contract"]["mechanism_overlays"]
            if contract["overlay_id"] == "queue_position_survival_fill_curve"
        )
        self.assertEqual(
            queue_contract["rank_metric"],
            "post_cost_net_pnl_after_queue_position_survival_fill_stress",
        )
        queue_grid_contract = next(
            contract
            for contract in mechanism_overlays["feature_contract"]["mechanism_overlays"]
            if contract["overlay_id"] == "queue_reactive_survival_latency_grid"
        )
        self.assertEqual(
            queue_grid_contract["source_papers"][0]["source_id"],
            "arxiv-2501.08822",
        )
        self.assertIn(
            "runtime_ledger",
            queue_grid_contract["required_evidence"],
        )
        self.assertEqual(
            queue_grid_contract["rank_metric"],
            "post_cost_net_pnl_after_queue_survival_latency_nonfill_stress",
        )
        self.assertTrue(
            specs[0].promotion_contract["requires_queue_position_survival_fill_curve"]
        )
        self.assertTrue(
            specs[0].promotion_contract["requires_queue_reactive_survival_latency_grid"]
        )
        self.assertTrue(specs[0].promotion_contract["requires_runtime_ledger"])
        self.assertTrue(
            specs[0].promotion_contract[
                "rejects_survival_model_fill_probability_as_fill_authority"
            ]
        )
        self.assertTrue(
            specs[0].promotion_contract[
                "rejects_queue_reactive_counterfactual_pnl_as_profit_proof"
            ]
        )
        self.assertTrue(
            specs[0].promotion_contract["rejects_queue_position_free_fill_assumptions"]
        )

    def test_mpc_execution_claim_adds_dynamic_schedule_contract(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-mpc-trade-execution",
            claims=[
                {
                    "claim_id": "dynamic-execution-schedule-control",
                    "claim_type": "feature_recipe",
                    "claim_text": (
                        "Model predictive control can adapt a dynamic execution "
                        "schedule to liquidity forecasts, inventory path, and "
                        "execution shortfall."
                    ),
                    "data_requirements": [
                        "execution_schedule_trace",
                        "liquidity_forecast",
                        "inventory_path",
                        "execution_shortfall",
                        "route_tca",
                    ],
                    "confidence": "0.71",
                },
                {
                    "claim_id": "mpc-execution-stress-required",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Dynamic execution schedules remain validation-only until "
                        "replay shows lower shortfall after latency and market-impact "
                        "stress."
                    ),
                    "data_requirements": [
                        "latency_stress",
                        "market_impact_stress",
                        "post_cost_net_pnl",
                    ],
                    "confidence": "0.72",
                },
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        self.assertIn(
            "mpc_dynamic_execution_schedule",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertTrue(specs[0].hard_vetoes["required_execution_schedule_trace"])
        self.assertTrue(
            specs[0].hard_vetoes["required_mpc_schedule_shortfall_ablation_passed"]
        )
        self.assertEqual(
            specs[0].hard_vetoes["required_min_mpc_schedule_trace_sample_count"],
            "60",
        )
        self.assertTrue(specs[0].hard_vetoes["required_latency_stress"])
        self.assertTrue(specs[0].hard_vetoes["required_market_impact_stress"])
        mechanism_overlays = candidate_specs_module._mechanism_overlays_for_card(
            cards[0]
        )
        mpc_contract = next(
            contract
            for contract in mechanism_overlays["feature_contract"]["mechanism_overlays"]
            if contract["overlay_id"] == "mpc_dynamic_execution_schedule"
        )
        self.assertEqual(
            mpc_contract["rank_metric"],
            "post_cost_net_pnl_after_mpc_schedule_shortfall_stress",
        )
        self.assertTrue(
            specs[0].promotion_contract["requires_mpc_dynamic_execution_schedule"]
        )
        self.assertTrue(specs[0].promotion_contract["requires_execution_shortfall"])
        self.assertTrue(
            specs[0].promotion_contract[
                "rejects_dynamic_schedule_without_shortfall_ablation"
            ]
        )
        self.assertEqual(
            specs[0].promotion_contract["execution_policy"],
            "mpc_dynamic_schedule_validation_only",
        )

    def test_liquidity_uncertainty_claim_adds_resilience_execution_grid(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-liquidity-uncertainty-execution",
            claims=[
                {
                    "claim_id": "stochastic-liquidity-resilience-execution",
                    "claim_type": "execution_assumption",
                    "claim_text": (
                        "Optimal execution under liquidity uncertainty needs "
                        "regime-switching liquidity, stochastic market depth, "
                        "LOB shape parameters, and liquidity resilience after "
                        "child orders."
                    ),
                    "data_requirements": [
                        "liquidity_regime_transition_trace",
                        "stochastic_market_depth_state",
                        "lob_shape_parameter_history",
                        "resilience_decay_half_life",
                        "depth_recovery_after_child_order",
                        "execution_shortfall_by_liquidity_regime",
                        "route_tca",
                    ],
                    "confidence": "0.73",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        self.assertIn(
            "stochastic_liquidity_resilience_execution_grid",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        grid = specs[0].parameter_space[
            "stochastic_liquidity_resilience_execution_grid"
        ]
        self.assertEqual(
            grid["schema_version"],
            "torghut.stochastic-liquidity-resilience-execution-grid.v1",
        )
        self.assertEqual(set(grid["source_ids"]), {"arxiv-2506.11813", "ssrn-3798235"})
        self.assertIn(
            "resilience_half_life_seconds_grid",
            grid["candidate_search_inputs"],
        )
        self.assertIn("depth_recovery_after_trade", grid["stress_inputs_required"])
        self.assertIn("impact_recovery_residual_bps", grid["diagnostics_required"])
        self.assertFalse(grid["proof_neutrality"]["proof_authority"])
        self.assertTrue(
            specs[0].hard_vetoes[
                "required_stochastic_liquidity_resilience_execution_grid"
            ]
        )
        self.assertTrue(
            specs[0].promotion_contract[
                "requires_stochastic_liquidity_resilience_execution_grid"
            ]
        )
        self.assertTrue(
            specs[0].promotion_contract[
                "rejects_modeled_liquidity_resilience_as_profit_proof"
            ]
        )
        mechanism_overlays = candidate_specs_module._mechanism_overlays_for_card(
            cards[0]
        )
        contract = next(
            item
            for item in mechanism_overlays["feature_contract"]["mechanism_overlays"]
            if item["overlay_id"] == "stochastic_liquidity_resilience_execution_grid"
        )
        self.assertEqual(
            contract["rank_metric"],
            "post_cost_net_pnl_after_liquidity_regime_resilience_shortfall_stress",
        )

    def test_friction_aware_regime_claim_adds_policy_overlay(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-frlux-regime-friction",
            claims=[
                {
                    "claim_id": "frlux-regime-conditioned-policy",
                    "claim_type": "feature_recipe",
                    "claim_text": (
                        "FR-LUX friction-aware, regime-conditioned policy optimization "
                        "uses proportional and impact costs across volatility-liquidity regimes."
                    ),
                    "data_requirements": [
                        "regime_state",
                        "regime_conditioned_policy",
                        "proportional_cost_model",
                        "impact_cost_model",
                    ],
                    "confidence": "0.76",
                },
                {
                    "claim_id": "frlux-turnover-budget-validation",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Trade-space trust region, turnover budget, cost misspecification stress, "
                        "scenario-level inference, and live-paper parity must validate the policy."
                    ),
                    "data_requirements": [
                        "trade_space_trust_region",
                        "turnover_budget",
                        "cost_misspecification_stress",
                        "scenario_level_inference",
                        "live_paper_parity",
                    ],
                    "confidence": "0.74",
                },
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        first = specs[0]

        self.assertIn(
            "friction_aware_regime_conditioned_policy",
            first.parameter_space["mechanism_overlay_ids"],
        )
        params = first.strategy_overrides["params"]
        self.assertEqual(params["cost_model_profile"], "proportional_plus_impact")
        self.assertEqual(params["turnover_budget_profile"], "trade_space_trust_region")
        self.assertEqual(params["regime_conditioning_profile"], "volatility_liquidity")
        self.assertTrue(first.hard_vetoes["required_trade_space_trust_region"])
        self.assertTrue(first.hard_vetoes["required_cost_misspecification_stress"])
        self.assertTrue(first.promotion_contract["requires_turnover_budget"])
        self.assertTrue(
            first.promotion_contract["rejects_cost_blind_policy_optimization"]
        )
        mechanism_overlays = candidate_specs_module._mechanism_overlays_for_card(
            cards[0]
        )
        friction_contract = next(
            contract
            for contract in mechanism_overlays["feature_contract"]["mechanism_overlays"]
            if contract["overlay_id"] == "friction_aware_regime_conditioned_policy"
        )
        self.assertEqual(
            friction_contract["rank_metric"],
            "post_cost_net_pnl_after_regime_conditioned_friction_stress",
        )
        self.assertEqual(
            friction_contract["evidence_policy"],
            "friction_aware_regime_conditioned_policy_is_replay_ranking_not_promotion_proof",
        )

    def test_adaptive_factor_loop_claim_adds_validation_only_contract(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-alphacrafter-factor-loop",
            claims=[
                {
                    "claim_id": "adaptive-factor-to-execution-loop",
                    "claim_type": "portfolio_construction",
                    "claim_text": (
                        "AlphaCrafter adaptive factor-to-execution loop combines continuous "
                        "factor mining, adaptive factor screener, and risk-constrained execution."
                    ),
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
                        "Agentic factor discovery can rank replay candidates only; promotion "
                        "requires post-cost replay and runtime-ledger proof."
                    ),
                    "data_requirements": [
                        "portfolio_replay",
                        "walk_forward_replay",
                        "transaction_cost_stress",
                        "post_cost_net_pnl",
                        "runtime_ledger_profit_proof",
                    ],
                    "confidence": "0.76",
                },
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        first = specs[0]

        self.assertIn(
            "adaptive_factor_to_execution_loop",
            first.parameter_space["mechanism_overlay_ids"],
        )
        self.assertTrue(first.hard_vetoes["required_adaptive_factor_to_execution_loop"])
        self.assertTrue(first.hard_vetoes["required_continuous_factor_mining"])
        self.assertTrue(first.hard_vetoes["required_adaptive_factor_screener"])
        self.assertTrue(first.hard_vetoes["required_risk_constrained_execution"])
        self.assertTrue(
            first.promotion_contract["rejects_agentic_search_only_promotion"]
        )
        self.assertTrue(
            first.promotion_contract["requires_runtime_ledger_profit_proof"]
        )
        mechanism_overlays = candidate_specs_module._mechanism_overlays_for_card(
            cards[0]
        )
        factor_loop_contract = next(
            contract
            for contract in mechanism_overlays["feature_contract"]["mechanism_overlays"]
            if contract["overlay_id"] == "adaptive_factor_to_execution_loop"
        )
        self.assertEqual(
            factor_loop_contract["rank_metric"],
            "adaptive_factor_loop_post_cost_net_pnl_per_day",
        )
        self.assertEqual(
            factor_loop_contract["evidence_policy"],
            "adaptive_factor_loop_is_search_prefilter_not_promotion_proof",
        )
