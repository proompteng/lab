from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.candidate_specs.support import *


class TestCandidateSpecsPart1(_TestCandidateSpecsBase):
    def test_factor_acceptance_artifact_accepts_rankic_cost_stressed_factor(
        self,
    ) -> None:
        artifact = build_factor_acceptance_artifact(
            factor_expression="cross_section_recent_15m_return_rank",
            source_idea="nvidia_signal_discovery_rankic_acceptance",
            allowed_feature_dependencies=[
                "cross_section_recent_15m_return_rank",
                "spread_bps",
            ],
            train_window={"start": "2026-01-02", "end": "2026-03-31"},
            test_window={"start": "2026-04-01", "end": "2026-04-30"},
            sample_count=144,
            candidate_count=4,
            rank_ic=Decimal("0.061"),
            rank_ir=Decimal("0.71"),
            p_value=Decimal("0.006"),
            gross_expectancy_bps=Decimal("5.2"),
            cost_stress_bps=Decimal("1.8"),
        )

        self.assertEqual(artifact["status"], "accepted")
        self.assertEqual(artifact["rejection_reasons"], [])
        self.assertEqual(artifact["deflated_p_value"], "0.024")
        self.assertEqual(artifact["cost_stressed_net_expectancy_bps"], "3.4")
        self.assertTrue(artifact["does_not_authorize_live_promotion"])
        self.assertEqual(
            artifact["lineage_hash"],
            build_factor_acceptance_artifact(
                factor_expression="cross_section_recent_15m_return_rank",
                source_idea="nvidia_signal_discovery_rankic_acceptance",
                allowed_feature_dependencies=[
                    "cross_section_recent_15m_return_rank",
                    "spread_bps",
                ],
                train_window={"start": "2026-01-02", "end": "2026-03-31"},
                test_window={"start": "2026-04-01", "end": "2026-04-30"},
                sample_count=144,
                candidate_count=4,
                rank_ic=Decimal("0.061"),
                rank_ir=Decimal("0.71"),
                p_value=Decimal("0.006"),
                gross_expectancy_bps=Decimal("5.2"),
                cost_stress_bps=Decimal("1.8"),
            )["lineage_hash"],
        )

    def test_factor_acceptance_artifact_rejects_missing_features_low_ic_and_cost(
        self,
    ) -> None:
        artifact = build_factor_acceptance_artifact(
            factor_expression="unavailable_alt_data_factor",
            source_idea="rankic_factor_acceptance_negative_case",
            allowed_feature_dependencies=[
                "unavailable_alt_data_factor",
                "cross_section_recent_15m_return_rank",
            ],
            sample_count=12,
            candidate_count=8,
            rank_ic=Decimal("0.01"),
            rank_ir=Decimal("0.10"),
            p_value=Decimal("0.02"),
            gross_expectancy_bps=Decimal("1.0"),
            cost_stress_bps=Decimal("1.5"),
        )

        self.assertEqual(artifact["status"], "rejected")
        self.assertIn("feature_dependency_missing", artifact["rejection_reasons"])
        self.assertIn("sample_count_below_floor", artifact["rejection_reasons"])
        self.assertIn("rank_ic_below_floor", artifact["rejection_reasons"])
        self.assertIn("rank_ir_below_floor", artifact["rejection_reasons"])
        self.assertIn("deflated_p_value_above_floor", artifact["rejection_reasons"])
        self.assertIn(
            "cost_stressed_expectancy_non_positive",
            artifact["rejection_reasons"],
        )

    def test_factor_acceptance_artifact_from_scorecard_uses_replay_metrics(
        self,
    ) -> None:
        artifact = build_factor_acceptance_artifact_from_scorecard(
            factor_expression="cross_section_session_open_rank",
            source_idea="runtime_replay_rankic_factor_acceptance",
            allowed_feature_dependencies=[
                "cross_section_session_open_rank",
                "spread_bps",
            ],
            scorecard={
                "rank_ic": "0.061",
                "rank_ir": "0.71",
                "p_value": "0.006",
                "factor_candidate_count": 4,
                "decision_count": 144,
                "net_pnl_per_day": "34",
                "avg_filled_notional_per_day": "100000",
                "market_impact_stress_cost_bps": "1.8",
                "train_window": {"start": "2026-01-02", "end": "2026-03-31"},
                "holdout_window": {"start": "2026-04-01", "end": "2026-04-30"},
            },
            candidate_spec_id="spec-rankic",
            candidate_id="candidate-rankic",
            evidence_bundle_id="ev-rankic",
        )

        self.assertEqual(artifact["status"], "accepted")
        self.assertEqual(artifact["sample_count"], 144)
        self.assertEqual(artifact["candidate_count"], 4)
        self.assertEqual(artifact["deflated_p_value"], "0.024")
        self.assertEqual(artifact["cost_stressed_net_expectancy_bps"], "1.60000")
        self.assertEqual(
            artifact["evidence_metadata"]["source"],
            "replay_or_live_paper_scorecard",
        )
        self.assertEqual(artifact["promotion_scope"], "research_paper_probation_only")
        self.assertTrue(artifact["does_not_authorize_live_promotion"])

    def test_rankic_signal_discovery_claim_adds_fail_closed_factor_harness(
        self,
    ) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-nvidia-signal-discovery",
            claims=[
                {
                    "claim_id": "rankic-factor-mining",
                    "claim_type": "feature_recipe",
                    "claim_text": (
                        "NVIDIA quantitative signal discovery and FactorMiner style "
                        "factor mining require RankIC, RankIR, p-value and cost "
                        "stress acceptance before alpha factors enter paper routing."
                    ),
                    "data_requirements": [
                        "cross_section_recent_15m_return_rank",
                        "spread_bps",
                    ],
                    "confidence": "0.82",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        first = specs[0]
        artifact = first.feature_contract["factor_acceptance_artifact"]

        self.assertIn(
            "rankic_factor_acceptance_harness",
            first.parameter_space["mechanism_overlay_ids"],
        )
        self.assertEqual(artifact["status"], "rejected")
        self.assertIn("rank_ic_below_floor", artifact["rejection_reasons"])
        self.assertTrue(first.hard_vetoes["required_factor_acceptance_artifact"])
        self.assertEqual(
            first.hard_vetoes["required_factor_acceptance_status"],
            "accepted",
        )
        self.assertTrue(
            first.promotion_contract[
                "rejects_llm_generated_factor_without_deterministic_acceptance"
            ]
        )
        self.assertTrue(
            first.promotion_contract[
                "rejects_factor_acceptance_as_live_promotion_proof"
            ]
        )

    def test_profile_rank_floor_handles_invalid_params_and_universe_fallbacks(
        self,
    ) -> None:
        self.assertEqual(
            candidate_specs_module._profile_rank_count_floor(
                {
                    "params": {"rank_count": "not-a-decimal"},
                    "universe_symbols": "NVDA",
                }
            ),
            1,
        )
        self.assertEqual(
            candidate_specs_module._profile_rank_count_floor(
                {"params": {}, "universe_symbols": ["NVDA", "", "AMD"]}
            ),
            2,
        )

        fallback = candidate_specs_module._strategy_overrides_for_profile(
            family_template_id="unknown-family",
            profile_index=0,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertEqual(fallback["max_notional_per_trade"], "50000")
        self.assertEqual(
            fallback["params"],
            {"position_isolation_mode": "per_strategy"},
        )

    def test_default_execution_profiles_use_chip_only_universes(self) -> None:
        seen_profiles = 0
        execution_profiles = candidate_specs_module._FAMILY_EXECUTION_PROFILES
        for family, profiles in execution_profiles.items():
            for index, profile in enumerate(profiles):
                raw_symbols = profile.get("universe_symbols")
                self.assertIsInstance(
                    raw_symbols,
                    list,
                    f"{family} profile {index} missing universe_symbols",
                )
                symbols = [str(symbol).strip().upper() for symbol in raw_symbols]
                self.assertLessEqual(
                    len(symbols),
                    12,
                    f"{family} profile {index} has too many symbols",
                )
                self.assertEqual(
                    len(symbols),
                    len(set(symbols)),
                    f"{family} profile {index} has duplicate symbols",
                )
                self.assertEqual(
                    sorted(set(symbols) - _CHIP_UNIVERSE_SYMBOLS),
                    [],
                    f"{family} profile {index} contains symbols outside the researched chip/AI infrastructure universe",
                )
                seen_profiles += 1

        self.assertGreater(seen_profiles, 0)

    def test_candidate_spec_ids_are_deterministic_and_round_trip(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-1",
            claims=[
                {
                    "claim_id": "claim-flow",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Clustered order flow imbalance improves intraday LOB signals.",
                    "confidence": "0.82",
                }
            ],
        )

        first = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("300")
        )
        second = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("300")
        )

        self.assertEqual(first[0].candidate_spec_id, second[0].candidate_spec_id)
        self.assertEqual(first[0].objective["target_net_pnl_per_day"], "300")
        self.assertIn("required_max_drawdown", first[0].hard_vetoes)
        self.assertIn("params", first[0].strategy_overrides)
        self.assertIn("execution_profile", first[0].feature_contract)
        self.assertIn("execution_profile_id", first[0].parameter_space)
        if first[0].family_template_id == "microbar_cross_sectional_pairs_v1":
            params = first[0].strategy_overrides["params"]
            self.assertIn("long_stop_loss_bps", params)
            self.assertIn("long_trailing_stop_drawdown_bps", params)
            self.assertIn("max_session_negative_exit_bps", params)
        self.assertEqual(
            first[0].strategy_overrides["params"]["position_isolation_mode"],
            "per_strategy",
        )
        self.assertNotIn("live_runtime_config_path", first[0].to_payload())
        reloaded = candidate_spec_from_payload(first[0].to_payload())
        self.assertEqual(reloaded.candidate_spec_id, first[0].candidate_spec_id)

    def test_structured_source_claims_survive_candidate_spec_payload(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-structured-claims",
            claims=[
                {
                    "claim_id": "claim-structured-flow",
                    "claim_type": "feature_recipe",
                    "claim_text": "Order flow imbalance requires route/TCA aware feature contracts.",
                    "data_requirements": ["order_flow_imbalance", "route_tca"],
                    "asset_scope": "us_equities_intraday",
                    "horizon_scope": "intraday_microstructure",
                    "expected_direction": "neutral",
                    "confidence": "0.82",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("300")
        )

        source_claims = specs[0].feature_contract["source_claims"]
        self.assertEqual(source_claims[0]["claim_id"], "claim-structured-flow")
        self.assertEqual(source_claims[0]["claim_type"], "feature_recipe")
        self.assertIn("route_tca", source_claims[0]["data_requirements"])
        self.assertEqual(
            specs[0].to_vnext_experiment_payload()["candidate_spec"][
                "feature_contract"
            ]["source_claims"][0]["horizon_scope"],
            "intraday_microstructure",
        )

    def test_cluster_lob_claim_adds_event_clustering_overlay_contract(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-clusterlob",
            claims=[
                {
                    "claim_id": "clusterlob-clustered-ofi-alpha",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "ClusterLOB clustered order events and order-flow imbalance "
                        "improve short-horizon LOB signals."
                    ),
                    "data_requirements": [
                        "clustered_order_events",
                        "order_flow_imbalance",
                        "spread_bps",
                    ],
                    "confidence": "0.82",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("300")
        )

        self.assertIn(
            "cluster_lob_event_clustering",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertIn(
            "hawkes_lob_event_replay_harness",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertIn(
            "ofi_lob_continuation_response",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        hawkes_harness = specs[0].parameter_space["hawkes_lob_event_replay_harness"]
        self.assertEqual(
            hawkes_harness["schema_version"],
            "torghut.hawkes-lob-event-replay-harness.v1",
        )
        self.assertEqual(
            set(hawkes_harness["source_ids"]),
            {"arxiv-2502.17417", "arxiv-2510.08085"},
        )
        self.assertGreaterEqual(len(hawkes_harness["required_event_taxonomy"]), 12)
        self.assertIn(
            "time_rescaling_ks_pvalue",
            hawkes_harness["diagnostics_required"],
        )
        self.assertFalse(hawkes_harness["proof_neutrality"]["promotion_authority"])
        self.assertTrue(
            specs[0].hard_vetoes["required_hawkes_lob_event_replay_harness"]
        )
        self.assertTrue(
            specs[0].promotion_contract[
                "rejects_hawkes_simulated_fills_as_pnl_authority"
            ]
        )
        self.assertEqual(
            specs[0].hard_vetoes["required_min_event_cluster_stability_score"],
            "0.60",
        )
        self.assertTrue(specs[0].promotion_contract["requires_lob_event_stream_parity"])
        hpairs_specs = [
            spec
            for spec in specs
            if spec.family_template_id == "microbar_cross_sectional_pairs_v1"
        ]
        self.assertGreater(len(hpairs_specs), 0)
        replay_tape_contract = hpairs_specs[0].feature_contract[
            "hpairs_replay_tape_feature_contract"
        ]
        self.assertEqual(
            replay_tape_contract["feature_schema_version"],
            "torghut.hpairs-replay-tape-features.v1",
        )
        self.assertRegex(
            replay_tape_contract["feature_schema_hash"],
            r"^[0-9a-f]{64}$",
        )
        self.assertEqual(
            replay_tape_contract["ofi_memory_regime_slices"],
            ["instant", "short", "medium", "long"],
        )
        self.assertFalse(replay_tape_contract["promotion_authority"])
        self.assertFalse(replay_tape_contract["runtime_ledger_authority"])

    def test_nonlinear_market_impact_claim_adds_route_tca_contract(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-realistic-impact",
            claims=[
                {
                    "claim_id": "nonlinear-market-impact",
                    "claim_type": "feature_recipe",
                    "claim_text": (
                        "Nonlinear market impact and square-root impact curves change "
                        "strategy ranking under route/TCA stress."
                    ),
                    "data_requirements": [
                        "route_tca",
                        "turnover",
                        "nonlinear_impact_curve",
                        "market_impact_stress",
                    ],
                    "confidence": "0.82",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("300")
        )

        self.assertEqual(
            specs[0].family_template_id,
            "microstructure_continuation_matched_filter_v1",
        )
        self.assertNotEqual(specs[0].family_template_id, "mean_reversion_rebound_v1")
        self.assertIn(
            "nonlinear_market_impact_tca",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertEqual(
            specs[0].hard_vetoes["required_impact_stress_model"],
            "square_root_or_power_law",
        )
        self.assertEqual(
            specs[0].promotion_contract["ranking_cost_model"],
            "post_cost_nonlinear_impact",
        )

    def test_transient_impact_claim_adds_hawkes_propagator_grid(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-transient-impact-hawkes-propagator",
            claims=[
                {
                    "claim_id": "transient-impact-hawkes-propagator-execution",
                    "claim_type": "execution_assumption",
                    "claim_text": (
                        "Transient price impact with a nonlinear propagator model, "
                        "power-law decay, bivariate Hawkes self-exciting order flow, "
                        "and N-player execution predator cost-of-anarchy stress "
                        "should change intraday execution trajectory ranking."
                    ),
                    "data_requirements": [
                        "transient_impact_kernel_fit",
                        "impact_decay_residuals",
                        "hawkes_self_cross_excitation_matrix",
                        "execution_trajectory_trace",
                        "twap_vwap_benchmark_shortfall",
                        "predator_cost_of_anarchy_stress",
                        "route_tca",
                    ],
                    "confidence": "0.76",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        self.assertIn(
            "transient_impact_hawkes_propagator_grid",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        grid = specs[0].parameter_space["transient_impact_hawkes_propagator_grid"]
        self.assertEqual(
            grid["schema_version"],
            "torghut.transient-impact-hawkes-propagator-grid.v1",
        )
        self.assertEqual(
            set(grid["source_ids"]),
            {"arxiv-2504.10282", "arxiv-2503.04323", "arxiv-2501.09638"},
        )
        self.assertIn(
            "impact_decay_kernel_family_grid",
            grid["candidate_search_inputs"],
        )
        self.assertIn("predator_count_grid", grid["candidate_search_inputs"])
        self.assertIn("impact_decay_after_child_order", grid["stress_inputs_required"])
        self.assertIn("price_manipulation_screen_passed", grid["diagnostics_required"])
        self.assertFalse(grid["proof_neutrality"]["proof_authority"])
        self.assertTrue(
            grid["proof_neutrality"][
                "rejects_hawkes_generated_order_flow_as_fill_authority"
            ]
        )
        self.assertTrue(
            specs[0].hard_vetoes["required_transient_impact_hawkes_propagator_grid"]
        )
        self.assertEqual(
            specs[0].hard_vetoes["required_max_predator_cost_of_anarchy_bps"],
            "10",
        )
        self.assertTrue(
            specs[0].promotion_contract[
                "requires_transient_impact_hawkes_propagator_grid"
            ]
        )
        self.assertTrue(
            specs[0].promotion_contract[
                "rejects_modeled_transient_impact_as_profit_proof"
            ]
        )
        mechanism_overlays = candidate_specs_module._mechanism_overlays_for_card(
            cards[0]
        )
        contract = next(
            item
            for item in mechanism_overlays["feature_contract"]["mechanism_overlays"]
            if item["overlay_id"] == "transient_impact_hawkes_propagator_grid"
        )
        self.assertEqual(
            contract["rank_metric"],
            "post_cost_net_pnl_after_transient_impact_hawkes_predator_stress",
        )

    def test_cross_impact_claim_adds_multi_asset_execution_grid(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-multi-asset-cross-impact-execution",
            claims=[
                {
                    "claim_id": "cross-impact-resilience-execution",
                    "claim_type": "execution_assumption",
                    "claim_text": (
                        "Multi-asset optimal trade execution with stochastic "
                        "cross-effects, matrix-valued price impact and resilience, "
                        "cross-hedging, signed trade flow feedback, and spread and "
                        "volume imbalance state projection should stress H-PAIRS leg "
                        "scheduling before any promotion proof."
                    ),
                    "data_requirements": [
                        "pair_leg_order_flow_covariance",
                        "cross_impact_matrix_fit",
                        "impact_resilience_matrix_fit",
                        "cross_hedge_leg_ablation",
                        "signed_trade_flow_decay_feedback",
                        "spread_volume_imbalance_state_projection",
                        "route_tca",
                    ],
                    "confidence": "0.78",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        first = specs[0]
        self.assertEqual(first.family_template_id, "microbar_cross_sectional_pairs_v1")
        self.assertIn(
            "multi_asset_cross_impact_pairs_execution",
            first.feature_contract["family_selection"]["reasons"],
        )
        self.assertIn(
            "multi_asset_cross_impact_execution_grid",
            first.parameter_space["mechanism_overlay_ids"],
        )
        grid = first.parameter_space["multi_asset_cross_impact_execution_grid"]
        self.assertEqual(
            grid["schema_version"],
            "torghut.multi-asset-cross-impact-execution-grid.v1",
        )
        self.assertEqual(
            set(grid["source_ids"]),
            {"arxiv-2503.05594", "arxiv-2603.24137", "arxiv-2506.05755"},
        )
        self.assertIn(
            "factor_low_rank_psd",
            grid["candidate_search_inputs"]["impact_matrix_structure_grid"],
        )
        self.assertIn(
            "lead_lag_hedged",
            grid["candidate_search_inputs"]["pair_leg_execution_mode_grid"],
        )
        self.assertIn(
            "signed_trade_flow_decay_kernel",
            grid["stress_inputs_required"],
        )
        self.assertIn(
            "price_manipulation_screen_passed",
            grid["diagnostics_required"],
        )
        self.assertFalse(grid["proof_neutrality"]["proof_authority"])
        self.assertTrue(
            grid["proof_neutrality"]["rejects_cross_impact_model_as_profit_proof"]
        )
        self.assertTrue(
            first.hard_vetoes["required_multi_asset_cross_impact_execution_grid"]
        )
        self.assertTrue(first.hard_vetoes["required_cross_hedge_leg_ablation"])
        self.assertEqual(
            first.hard_vetoes["required_max_cross_impact_fit_error_bps"], "8"
        )
        self.assertTrue(
            first.promotion_contract["requires_multi_asset_cross_impact_execution_grid"]
        )
        self.assertTrue(
            first.promotion_contract["rejects_cross_hedge_ablation_as_fill_authority"]
        )
        self.assertEqual(
            first.strategy_overrides["params"]["cross_impact_stress_profile"],
            "multi_asset_matrix_resilience",
        )
        self.assertEqual(
            first.strategy_overrides["params"]["cross_hedge_live_authority"],
            "disabled_candidate_only",
        )
        mechanism_overlays = candidate_specs_module._mechanism_overlays_for_card(
            cards[0]
        )
        contract = next(
            item
            for item in mechanism_overlays["feature_contract"]["mechanism_overlays"]
            if item["overlay_id"] == "multi_asset_cross_impact_execution_grid"
        )
        self.assertEqual(contract["source_papers"][0]["source_id"], "arxiv-2503.05594")
        self.assertEqual(
            contract["rank_metric"],
            "post_cost_net_pnl_after_cross_impact_resilience_stress",
        )
        self.assertIn("runtime_ledger", contract["required_evidence"])

    def test_lob_simulation_reality_gap_claim_adds_implementation_risk_overlay(
        self,
    ) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-lob-simulation-reality-gap",
            claims=[
                {
                    "claim_id": "lob-simulation-benchmark-parity",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Limit order book simulation can expose stylized fillability "
                        "and adverse-selection mechanisms only when calibrated against "
                        "real LOB event streams and fill outcomes."
                    ),
                    "data_requirements": [
                        "lob_event_stream",
                        "fill_outcomes",
                        "simulation_parity",
                    ],
                    "confidence": "0.82",
                },
                {
                    "claim_id": "sim-to-live-reality-gap-validation",
                    "claim_type": "risk_constraint",
                    "claim_text": (
                        "Simulation reality gaps require explicit live-paper parity "
                        "metrics before simulated fillability can affect capital gates."
                    ),
                    "data_requirements": [
                        "simulation_parity",
                        "live_paper_parity",
                        "adverse_selection_stress",
                        "route_tca",
                    ],
                    "confidence": "0.80",
                },
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        self.assertIn(
            "simulation_reality_gap_implementation_risk",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertTrue(specs[0].hard_vetoes["required_simulation_live_parity_metrics"])
        self.assertEqual(
            specs[0].hard_vetoes["required_min_simulation_parity_sample_count"],
            "120",
        )
        self.assertTrue(
            specs[0].promotion_contract[
                "rejects_synthetic_lob_fillability_as_capital_gate"
            ]
        )
        self.assertTrue(
            specs[0].promotion_contract["requires_implementation_uncertainty_stability"]
        )

    def test_implementation_risk_claim_adds_backtest_stability_overlay(
        self,
    ) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-implementation-risk-backtesting",
            claims=[
                {
                    "claim_id": "implementation-risk-engine-sensitivity",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Implementation risk in portfolio backtesting creates engine "
                        "sensitivity and implementation uncertainty intervals under "
                        "nonzero transaction costs."
                    ),
                    "data_requirements": [
                        "multi_engine_replay",
                        "engine_sensitivity",
                        "implementation_uncertainty_interval",
                        "conclusion_stability",
                        "transaction_cost_stress",
                    ],
                    "confidence": "0.80",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        self.assertIn(
            "implementation_risk_backtest_stability",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertTrue(specs[0].hard_vetoes["required_multi_engine_replay"])
        self.assertEqual(
            specs[0].hard_vetoes["required_min_implementation_uncertainty_model_count"],
            "2",
        )
        self.assertTrue(
            specs[0].promotion_contract["rejects_single_engine_backtest_proof"]
        )
        self.assertTrue(
            specs[0].promotion_contract[
                "requires_implementation_risk_backtest_stability"
            ]
        )
