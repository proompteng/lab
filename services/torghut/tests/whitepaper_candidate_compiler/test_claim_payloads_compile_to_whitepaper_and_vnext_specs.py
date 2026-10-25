from __future__ import annotations

from tests.whitepaper_candidate_compiler.support import (
    Decimal,
    Path,
    _PORTFOLIO_TARGET_FAMILIES,
    _TestWhitepaperCandidateCompilerBase,
    _expected_portfolio_target_candidate_count,
    _profile_count_for_family,
    compile_claim_payloads_to_whitepaper_experiments,
)


class TestClaimPayloadsCompileToWhitepaperAndVnextSpecs(
    _TestWhitepaperCandidateCompilerBase
):
    def test_claim_payloads_compile_to_whitepaper_and_vnext_specs(self) -> None:
        compilation = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-run-1",
            claims=[
                {
                    "claim_id": "claim-flow",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Clustered order flow imbalance improves short-horizon LOB signals.",
                    "confidence": "0.82",
                }
            ],
            target_net_pnl_per_day=Decimal("500"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )

        expected_spec_count = _expected_portfolio_target_candidate_count()
        self.assertEqual(len(compilation.candidate_specs), expected_spec_count)
        self.assertEqual(len(compilation.executable_specs), expected_spec_count)
        self.assertEqual(
            len(compilation.whitepaper_experiment_payloads), expected_spec_count
        )
        self.assertEqual(
            len(compilation.vnext_experiment_payloads), expected_spec_count
        )
        family_ids = {spec.family_template_id for spec in compilation.executable_specs}
        self.assertEqual(family_ids, _PORTFOLIO_TARGET_FAMILIES)
        self.assertEqual(
            {
                family_id: sum(
                    1
                    for spec in compilation.executable_specs
                    if spec.family_template_id == family_id
                )
                for family_id in family_ids
            },
            {
                family_id: _profile_count_for_family(
                    family_id,
                    target_net_pnl_per_day=Decimal("500"),
                )
                for family_id in _PORTFOLIO_TARGET_FAMILIES
            },
        )
        self.assertTrue(
            all(
                "family_selection" in spec.feature_contract
                for spec in compilation.executable_specs
            )
        )
        self.assertEqual(
            compilation.whitepaper_experiment_payloads[0]["selection_objectives"][
                "target_net_pnl_per_day"
            ],
            "500",
        )
        self.assertEqual(
            compilation.vnext_experiment_payloads[0]["family_template_id"],
            "microstructure_continuation_matched_filter_v1",
        )

    def test_portfolio_target_includes_notional_throughput_feedback_escape(
        self,
    ) -> None:
        compilation = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-run-notional-throughput",
            claims=[
                {
                    "claim_id": "claim-flow-throughput",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Scale-invariant order-flow and intraday transition regimes "
                        "support diversified high-turnover microstructure sleeves."
                    ),
                    "required_features": [
                        "order_flow_imbalance",
                        "cross_section_rank",
                        "quote_quality",
                    ],
                    "confidence": "0.78",
                }
            ],
            target_net_pnl_per_day=Decimal("500"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )

        throughput_specs = [
            spec
            for spec in compilation.executable_specs
            if spec.strategy_overrides["params"].get("feedback_remediation_profile")
            == "notional_throughput_feedback_escape"
        ]

        self.assertEqual(
            {spec.family_template_id for spec in throughput_specs},
            _PORTFOLIO_TARGET_FAMILIES,
        )
        self.assertTrue(
            all(
                spec.strategy_overrides["params"]["capital_profile"]
                == "feedback_notional_throughput_cash_constrained_1x"
                for spec in throughput_specs
            )
        )
        self.assertTrue(
            all(
                int(spec.strategy_overrides["params"]["max_entries_per_session"]) >= 8
                for spec in throughput_specs
            )
        )
        self.assertTrue(
            all(
                Decimal(str(spec.strategy_overrides["max_notional_per_trade"]))
                <= Decimal("30000")
                for spec in throughput_specs
            )
        )
        self.assertTrue(
            all(
                spec.hard_vetoes["required_min_daily_notional"] == "300000"
                and spec.hard_vetoes["required_min_active_day_ratio"] == "0.90"
                and spec.hard_vetoes["required_max_best_day_share"] == "0.25"
                for spec in throughput_specs
            )
        )

    def test_tradefm_claims_preserve_scale_invariant_and_synthetic_stress_contract(
        self,
    ) -> None:
        compilation = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-arxiv-2602-23784",
            claims=[
                {
                    "claim_id": "scale-invariant-flow",
                    "claim_type": "feature_recipe",
                    "claim_text": (
                        "Scale-invariant trade-flow representations can capture "
                        "transferable market microstructure across equities."
                    ),
                    "data_requirements": [
                        "trade_flow",
                        "spread_bps",
                        "relative_volume",
                    ],
                    "confidence": "0.78",
                },
                {
                    "claim_id": "synthetic-rollout-stress",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Synthetic trade-flow rollouts should be used for stress "
                        "testing and not direct promotion before replay and shadow gates pass."
                    ),
                    "data_requirements": [
                        "historical_replay",
                        "live_paper_parity",
                        "market_impact_stress",
                    ],
                    "confidence": "0.72",
                },
            ],
            target_net_pnl_per_day=Decimal("300"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )

        microstructure_specs = [
            spec
            for spec in compilation.executable_specs
            if spec.family_template_id
            == "microstructure_continuation_matched_filter_v1"
        ]

        self.assertTrue(microstructure_specs)
        self.assertFalse(
            [
                blocker
                for blocker in compilation.blockers
                if blocker.reason == "required_features_missing_from_family_template"
            ]
        )
        self.assertIn(
            "market_cap_scaled",
            microstructure_specs[0].feature_contract["normalization_candidates"],
        )
        self.assertEqual(
            microstructure_specs[0].promotion_contract["synthetic_evidence_policy"],
            "validation_only_not_promotion_proof",
        )
        self.assertEqual(
            microstructure_specs[0].promotion_contract[
                "validation_requirement_claim_ids"
            ],
            ["synthetic-rollout-stress"],
        )

    def test_may_2026_order_flow_noise_claim_compiles_with_validation_artifacts(
        self,
    ) -> None:
        compilation = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-arxiv-2605.15746",
            claims=[
                {
                    "claim_id": "orderflow-observation-noise-model",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Order-flow observation noise changes inferred adverse-selection "
                        "and impact estimates, so OFI features need explicit source-quality state."
                    ),
                    "data_requirements": [
                        "order_flow_imbalance",
                        "quote_attribution_quality",
                        "market_impact_stress",
                    ],
                    "confidence": "0.72",
                },
                {
                    "claim_id": "noise-perturbed-orderflow-adverse-selection",
                    "claim_type": "risk_constraint",
                    "claim_text": (
                        "Noisy or partially private order-flow observations can understate "
                        "impact, requiring attribution-quality stress before treating flow "
                        "as executable alpha."
                    ),
                    "data_requirements": [
                        "quote_attribution_quality",
                        "route_tca",
                        "impact_lambda_estimate",
                        "live_paper_parity",
                    ],
                    "confidence": "0.72",
                },
            ],
            target_net_pnl_per_day=Decimal("300"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )

        self.assertTrue(compilation.executable_specs)
        self.assertFalse(
            [
                blocker
                for blocker in compilation.blockers
                if blocker.reason == "required_features_missing_from_family_template"
            ]
        )
        self.assertTrue(
            all(
                spec.feature_contract["validation_requirements"][0]["claim_id"]
                == "noise-perturbed-orderflow-adverse-selection"
                for spec in compilation.executable_specs
            )
        )
        self.assertTrue(
            all(
                spec.promotion_contract["synthetic_evidence_policy"]
                == "validation_only_not_promotion_proof"
                for spec in compilation.executable_specs
            )
        )

    def test_recent_entropy_and_factor_claim_aliases_compile_to_runtime_families(
        self,
    ) -> None:
        compilation = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-recent-runtime-claims",
            claims=[
                {
                    "claim_id": "order-flow-entropy-volatility-state",
                    "claim_type": "feature_recipe",
                    "claim_text": (
                        "Real-time order-flow entropy and trade-sign Markov state identify "
                        "volatility windows without proving direction."
                    ),
                    "data_requirements": [
                        "order_flow_entropy",
                        "trade_sign_markov_state",
                        "realized_volatility",
                    ],
                    "confidence": "0.75",
                },
                {
                    "claim_id": "constrained-factor-dsl-search",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Constrained LLM hypothesis search emits point-in-time factor DSL "
                        "programs with append-only traces and walk-forward replay."
                    ),
                    "data_requirements": [
                        "factor_dsl",
                        "append_only_experiment_trace",
                        "walk_forward_replay",
                    ],
                    "confidence": "0.77",
                },
                {
                    "claim_id": "recent-runtime-validation",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Recent paper claims require deterministic splits, live-paper parity, "
                        "transaction costs, and portfolio replay before promotion."
                    ),
                    "data_requirements": [
                        "portfolio_replay",
                        "transaction_cost_stress",
                        "live_paper_parity",
                    ],
                    "confidence": "0.76",
                },
            ],
            target_net_pnl_per_day=Decimal("300"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )

        self.assertTrue(compilation.executable_specs)
        self.assertFalse(
            [
                blocker
                for blocker in compilation.blockers
                if blocker.reason == "required_features_missing_from_family_template"
            ]
        )
        self.assertTrue(
            all(
                spec.promotion_contract["synthetic_evidence_policy"]
                == "validation_only_not_promotion_proof"
                for spec in compilation.executable_specs
            )
        )

    def test_double_selection_factor_claims_compile_to_factor_screen_overlay(
        self,
    ) -> None:
        compilation = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-arxiv-2601-06499",
            claims=[
                {
                    "claim_id": "short-term-trading-factor-screen",
                    "claim_type": "feature_recipe",
                    "claim_text": (
                        "Short-term trading-based factors can provide incremental "
                        "explanatory power after double-selection LASSO controls."
                    ),
                    "data_requirements": [
                        "short_term_trading_factors",
                        "cross_sectional_ranks",
                        "realized_volatility",
                    ],
                    "confidence": "0.70",
                },
                {
                    "claim_id": "alpha191-us-incremental-explanatory-power",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "High-dimensional factor screens require strict out-of-sample "
                        "and multiple-testing controls."
                    ),
                    "data_requirements": [
                        "train_holdout_split",
                        "factor_rank_panel",
                        "multiple_testing_controls",
                    ],
                    "confidence": "0.72",
                },
            ],
            target_net_pnl_per_day=Decimal("500"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )

        self.assertTrue(compilation.executable_specs)
        self.assertFalse(
            [
                blocker
                for blocker in compilation.blockers
                if blocker.reason == "required_features_missing_from_family_template"
            ]
        )
        self.assertTrue(
            all(
                "double_selection_factor_screen"
                in spec.parameter_space.get("mechanism_overlay_ids", [])
                for spec in compilation.executable_specs
            )
        )
        self.assertTrue(
            all(
                spec.promotion_contract.get("rejects_factor_screen_only_promotion")
                for spec in compilation.executable_specs
            )
        )

    def test_alphacrafter_factor_loop_claims_compile_to_executable_overlay(
        self,
    ) -> None:
        compilation = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-arxiv-2605.05580",
            claims=[
                {
                    "claim_id": "adaptive-factor-to-execution-loop",
                    "claim_type": "portfolio_construction",
                    "claim_text": (
                        "AlphaCrafter adaptive factor-to-execution loops combine continuous "
                        "factor mining, adaptive factor screening, and risk-constrained execution."
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
                        "Agentic factor discovery and screening can only rank replay candidates; "
                        "promotion still requires walk-forward replay, explicit costs, and "
                        "runtime-ledger proof."
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
            target_net_pnl_per_day=Decimal("500"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )

        self.assertTrue(compilation.executable_specs)
        self.assertFalse(
            [
                blocker
                for blocker in compilation.blockers
                if blocker.reason == "required_features_missing_from_family_template"
            ]
        )
        self.assertTrue(
            all(
                "adaptive_factor_to_execution_loop"
                in spec.parameter_space.get("mechanism_overlay_ids", [])
                for spec in compilation.executable_specs
            )
        )
        self.assertTrue(
            all(
                spec.promotion_contract.get("rejects_agentic_search_only_promotion")
                for spec in compilation.executable_specs
            )
        )

    def test_may_2026_toxicity_and_options_aliases_compile_to_runtime_families(
        self,
    ) -> None:
        compilation = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-may-2026-toxicity-options",
            claims=[
                {
                    "claim_id": "informed-flow-toxicity-score",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Real-time informed-flow detection combines VPIN, Kyle lambda, "
                        "hazard rate, and informed flow score before entries."
                    ),
                    "data_requirements": [
                        "vpin",
                        "kyle_lambda",
                        "hazard_rate",
                        "informed_flow_score",
                    ],
                    "confidence": "0.71",
                },
                {
                    "claim_id": "weekly-option-gamma-flow-state",
                    "claim_type": "feature_recipe",
                    "claim_text": (
                        "Weekly option availability and gamma exposure create volatility "
                        "and option-flow state around short-horizon option trading."
                    ),
                    "data_requirements": [
                        "weekly_option_availability",
                        "gamma_exposure",
                        "option_flow",
                        "realized_volatility",
                    ],
                    "confidence": "0.70",
                },
                {
                    "claim_id": "may-2026-route-validation",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Recent toxicity and option-flow claims need route TCA, live-paper "
                        "parity, walk-forward replay, and drawdown validation."
                    ),
                    "data_requirements": [
                        "route_tca",
                        "live_paper_parity",
                        "walk_forward_replay",
                        "drawdown_validation",
                    ],
                    "confidence": "0.72",
                },
            ],
            target_net_pnl_per_day=Decimal("500"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )

        self.assertTrue(compilation.executable_specs)
        self.assertFalse(
            [
                blocker
                for blocker in compilation.blockers
                if blocker.reason == "required_features_missing_from_family_template"
            ]
        )

    def test_recent_portable_lob_impact_and_ofi_response_claims_compile_to_runtime_families(
        self,
    ) -> None:
        compilation = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-recent-portable-impact-response",
            claims=[
                {
                    "claim_id": "portable-lob-feature-library",
                    "claim_type": "feature_recipe",
                    "claim_text": (
                        "Stable SHAP feature importance across heterogeneous order books "
                        "supports portable LOB feature recipes after equity replay confirms spread."
                    ),
                    "data_requirements": [
                        "portable_lob_feature_stability",
                        "multi_level_order_book",
                        "order_flow_imbalance",
                        "spread_bps",
                    ],
                    "confidence": "0.73",
                },
                {
                    "claim_id": "persistent-core-flow-impact-scaling",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Persistent core signed order flow can explain rough volume, volatility, "
                        "and power-law market impact for cost-coupled continuation."
                    ),
                    "data_requirements": [
                        "core_flow_persistence",
                        "signed_order_flow",
                        "realized_volatility",
                        "turnover",
                    ],
                    "confidence": "0.75",
                },
                {
                    "claim_id": "ofi-response-trigger",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Order-flow imbalance shocks have memory and should be evaluated "
                        "with response-ratio horizon selection."
                    ),
                    "data_requirements": [
                        "order_flow_imbalance",
                        "ofi_memory_state",
                        "response_ratio",
                        "forecast_horizon",
                    ],
                    "confidence": "0.76",
                },
                {
                    "claim_id": "recent-impact-and-route-validation",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Recent microstructure sleeves need maker-taker route/TCA splits, "
                        "nonlinear impact stress, walk-forward replay, and live-paper parity."
                    ),
                    "data_requirements": [
                        "maker_taker_fill_assumption",
                        "nonlinear_impact_curve",
                        "route_tca",
                        "walk_forward_replay",
                        "live_paper_parity",
                    ],
                    "confidence": "0.76",
                },
            ],
            target_net_pnl_per_day=Decimal("500"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )

        family_ids = {spec.family_template_id for spec in compilation.executable_specs}

        self.assertTrue(compilation.executable_specs)
        self.assertTrue(
            {
                "microstructure_continuation_matched_filter_v1",
                "microbar_cross_sectional_pairs_v1",
                "intraday_tsmom_v2",
                "opening_drive_leader_reclaim_v1",
            }.issubset(family_ids)
        )
        microstructure_or_opening_specs = [
            spec
            for spec in compilation.executable_specs
            if spec.family_template_id
            in {
                "microstructure_continuation_matched_filter_v1",
                "opening_drive_leader_reclaim_v1",
            }
        ]
        self.assertTrue(
            any(
                spec.strategy_overrides.get("params", {}).get("signal_motif")
                in {
                    "ofi_lob_response_continuation",
                    "opening_ofi_leader_reclaim_continuation",
                }
                for spec in microstructure_or_opening_specs
            )
        )
        self.assertTrue(
            any(
                "ofi_lob_continuation_response"
                in spec.parameter_space.get("mechanism_overlay_ids", [])
                for spec in microstructure_or_opening_specs
            )
        )
        self.assertTrue(
            any(
                spec.hard_vetoes.get("required_min_ofi_response_sample_count") == "120"
                for spec in microstructure_or_opening_specs
            )
        )
        self.assertFalse(
            [
                blocker
                for blocker in compilation.blockers
                if blocker.reason == "required_features_missing_from_family_template"
            ]
        )
        self.assertTrue(
            all(
                spec.promotion_contract["synthetic_evidence_policy"]
                == "validation_only_not_promotion_proof"
                for spec in compilation.executable_specs
            )
        )

    def test_order_flow_filtration_claims_require_parent_trade_obi_overlay(
        self,
    ) -> None:
        compilation = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-arxiv-2507-22712",
            claims=[
                {
                    "claim_id": "parent-trade-filtered-obi",
                    "claim_type": "feature_recipe",
                    "claim_text": (
                        "Order-flow filtration links parent orders, order lifetime, "
                        "modification count, and filtered orderbook imbalance to "
                        "short-horizon returns."
                    ),
                    "data_requirements": [
                        "parent_order_trade_linkage",
                        "filtered_orderbook_imbalance",
                        "order_lifetime_filter",
                        "order_modification_count",
                    ],
                    "confidence": "0.75",
                },
                {
                    "claim_id": "filtered-obi-causal-validation",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Filtered OBI candidates require event-time excitation, route TCA, "
                        "walk-forward replay, and live-paper parity before promotion."
                    ),
                    "data_requirements": [
                        "event_time_excitation",
                        "route_tca",
                        "walk_forward_replay",
                        "live_paper_parity",
                    ],
                    "confidence": "0.74",
                },
            ],
            target_net_pnl_per_day=Decimal("500"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )

        self.assertTrue(compilation.executable_specs)
        self.assertFalse(
            [
                blocker
                for blocker in compilation.blockers
                if blocker.reason == "required_features_missing_from_family_template"
            ]
        )
        self.assertTrue(
            any(
                "order_flow_filtration_parent_trade_obi"
                in spec.parameter_space.get("mechanism_overlay_ids", [])
                for spec in compilation.executable_specs
            )
        )
        self.assertTrue(
            any(
                spec.hard_vetoes.get("required_parent_order_trade_linkage") is True
                for spec in compilation.executable_specs
            )
        )
        self.assertTrue(
            all(
                spec.promotion_contract.get("rejects_unfiltered_obi_only_promotion")
                for spec in compilation.executable_specs
            )
        )
