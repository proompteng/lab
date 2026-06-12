from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.mlx_training_data.support import *


class TestMlxTrainingDataPart2(_TestMlxTrainingDataBase):
    def test_training_rows_encode_double_selection_factor_screen_contract(
        self,
    ) -> None:
        spec = CandidateSpec(
            schema_version="torghut.candidate-spec.v1",
            candidate_spec_id="spec-double-selection-factor",
            hypothesis_id="H-DOUBLE-SELECTION",
            family_template_id="microbar_cross_sectional_pairs_v1",
            candidate_kind="configuration",
            runtime_family="microbar_cross_sectional_pairs",
            runtime_strategy_name="microbar-cross-sectional-pairs-v1",
            feature_contract={
                "source_claims": [
                    {
                        "claim_id": "short-term-trading-factor-screen",
                        "claim_type": "feature_recipe",
                        "confidence": "0.70",
                        "data_requirements": [
                            "short_term_trading_factors",
                            "cross_sectional_ranks",
                            "realized_volatility",
                        ],
                    }
                ],
                "validation_requirements": [
                    {
                        "claim_id": "alpha191-us-incremental-explanatory-power",
                        "data_requirements": [
                            "train_holdout_split",
                            "factor_rank_panel",
                            "multiple_testing_controls",
                        ],
                    }
                ],
                "mechanism_overlays": [
                    {
                        "overlay_id": "double_selection_factor_screen",
                        "required_evidence": [
                            "short_term_trading_factors",
                            "cross_sectional_ranks",
                            "factor_rank_panel",
                            "train_holdout_split",
                            "multiple_testing_controls",
                            "post_cost_net_pnl",
                        ],
                    }
                ],
            },
            parameter_space={
                "mechanism_overlay_ids": ["double_selection_factor_screen"]
            },
            strategy_overrides={
                "max_notional_per_trade": "25000",
                "max_position_pct_equity": "0.25",
                "params": {
                    "capital_profile": "initial_equity_cash_constrained_1x",
                    "max_entries_per_session": "2",
                    "max_gross_exposure_pct_equity": "1.0",
                },
            },
            objective={"target_net_pnl_per_day": "500"},
            hard_vetoes={"required_min_daily_notional": "250000"},
            expected_failure_modes=(),
            promotion_contract={
                "requires_double_selection_factor_screen": True,
                "requires_cross_sectional_rank_panel": True,
                "requires_train_holdout_split": True,
                "requires_multiple_testing_controls": True,
                "rejects_factor_screen_only_promotion": True,
            },
        )
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id=spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-double-selection-factor",
                "objective_scorecard": {
                    "net_pnl_per_day": "640",
                    "active_day_ratio": "1.0",
                    "positive_day_ratio": "0.68",
                    "double_selection_factor_post_cost_net_pnl_per_day": "530",
                },
            },
            dataset_snapshot_id="snapshot-double-selection-factor",
            result_path="/tmp/cand-double-selection-factor.json",
        )

        rows = build_mlx_training_rows(
            candidate_specs=[spec], evidence_bundles=[bundle]
        )
        features = rows[0].to_payload()["features"]

        self.assertEqual(features["paper_overlay_double_selection_factor_screen"], 1.0)
        self.assertEqual(features["paper_requires_factor_rank_panel"], 1.0)
        self.assertEqual(features["paper_requires_train_holdout_split"], 1.0)
        self.assertEqual(features["paper_requires_multiple_testing_controls"], 1.0)

    def test_training_rows_encode_friction_aware_regime_contract(self) -> None:
        spec = CandidateSpec(
            schema_version="torghut.candidate-spec.v1",
            candidate_spec_id="spec-frlux",
            hypothesis_id="H-FRLUX",
            family_template_id="intraday_tsmom_v2",
            candidate_kind="configuration",
            runtime_family="intraday_tsmom_consistent",
            runtime_strategy_name="intraday-tsmom-profit-v3",
            feature_contract={
                "source_claims": [
                    {
                        "claim_id": "friction-aware-regime-conditioned-policy",
                        "claim_type": "feature_recipe",
                        "confidence": "0.76",
                        "data_requirements": [
                            "regime_state",
                            "regime_conditioned_policy",
                            "proportional_cost_model",
                            "impact_cost_model",
                        ],
                    }
                ],
                "validation_requirements": [
                    {
                        "claim_id": "frlux-validation",
                        "data_requirements": [
                            "trade_space_trust_region",
                            "turnover_budget",
                            "cost_misspecification_stress",
                            "liquidity_proxy_cost_calibration",
                            "scenario_level_inference",
                        ],
                    }
                ],
                "mechanism_overlays": [
                    {
                        "overlay_id": "friction_aware_regime_conditioned_policy",
                        "required_evidence": [
                            "regime_state",
                            "regime_conditioned_policy",
                            "trade_space_trust_region",
                            "turnover_budget",
                            "cost_misspecification_stress",
                            "liquidity_proxy_cost_calibration",
                            "scenario_level_inference",
                            "live_paper_parity",
                        ],
                    }
                ],
            },
            parameter_space={
                "mechanism_overlay_ids": ["friction_aware_regime_conditioned_policy"]
            },
            strategy_overrides={
                "max_notional_per_trade": "25000",
                "max_position_pct_equity": "0.25",
                "params": {
                    "capital_profile": "initial_equity_cash_constrained_1x",
                    "max_entries_per_session": "2",
                    "max_gross_exposure_pct_equity": "1.0",
                },
            },
            objective={"target_net_pnl_per_day": "500"},
            hard_vetoes={"required_min_daily_notional": "250000"},
            expected_failure_modes=(),
            promotion_contract={
                "requires_regime_conditioned_policy": True,
                "requires_turnover_budget": True,
                "requires_cost_misspecification_stress": True,
                "rejects_cost_blind_policy_optimization": True,
            },
        )

        rows = build_mlx_training_rows(candidate_specs=[spec], evidence_bundles=[])
        features = rows[0].to_payload()["features"]

        self.assertEqual(
            features["paper_overlay_friction_aware_regime_conditioned_policy"],
            1.0,
        )
        self.assertEqual(features["paper_requires_regime_conditioning"], 1.0)
        self.assertEqual(features["paper_requires_trade_space_trust_region"], 1.0)
        self.assertEqual(features["paper_requires_turnover_budget"], 1.0)
        self.assertEqual(features["paper_requires_cost_misspecification_stress"], 1.0)
        self.assertEqual(
            features["paper_requires_liquidity_proxy_cost_calibration"], 1.0
        )
        self.assertEqual(features["paper_requires_scenario_level_inference"], 1.0)
        self.assertEqual(features["paper_requires_live_paper_parity"], 1.0)
        self.assertEqual(features["paper_promotion_requires_count"], 3.0)
        self.assertEqual(features["paper_promotion_rejects_count"], 1.0)

    def test_training_rows_encode_adaptive_factor_loop_contract(self) -> None:
        spec = CandidateSpec(
            schema_version="torghut.candidate-spec.v1",
            candidate_spec_id="spec-alphacrafter-factor-loop",
            hypothesis_id="H-ALPHACRAFTER",
            family_template_id="microbar_cross_sectional_pairs_v1",
            candidate_kind="configuration",
            runtime_family="microbar_cross_sectional_pairs",
            runtime_strategy_name="microbar-cross-sectional-pairs-v1",
            feature_contract={
                "source_claims": [
                    {
                        "claim_id": "adaptive-factor-to-execution-loop",
                        "claim_type": "portfolio_construction",
                        "confidence": "0.74",
                        "data_requirements": [
                            "continuous_factor_mining",
                            "factor_pool_expansion",
                            "adaptive_factor_screener",
                            "regime_adaptive_factor_ensemble",
                            "risk_constrained_execution",
                        ],
                    }
                ],
                "validation_requirements": [
                    {
                        "claim_id": "adaptive-loop-runtime-ledger-validation",
                        "data_requirements": [
                            "portfolio_replay",
                            "walk_forward_replay",
                            "transaction_cost_stress",
                            "post_cost_net_pnl",
                            "runtime_ledger_profit_proof",
                        ],
                    }
                ],
                "mechanism_overlays": [
                    {
                        "overlay_id": "adaptive_factor_to_execution_loop",
                        "required_evidence": [
                            "continuous_factor_mining",
                            "factor_pool_expansion",
                            "adaptive_factor_screener",
                            "regime_adaptive_factor_ensemble",
                            "risk_constrained_execution",
                            "portfolio_replay",
                            "walk_forward_replay",
                            "transaction_cost_stress",
                            "post_cost_net_pnl",
                            "runtime_ledger_profit_proof",
                        ],
                    }
                ],
            },
            parameter_space={
                "mechanism_overlay_ids": ["adaptive_factor_to_execution_loop"]
            },
            strategy_overrides={
                "max_notional_per_trade": "25000",
                "max_position_pct_equity": "0.25",
                "params": {
                    "capital_profile": "initial_equity_cash_constrained_1x",
                    "max_entries_per_session": "2",
                    "max_gross_exposure_pct_equity": "1.0",
                },
            },
            objective={"target_net_pnl_per_day": "500"},
            hard_vetoes={"required_min_daily_notional": "250000"},
            expected_failure_modes=(),
            promotion_contract={
                "requires_adaptive_factor_to_execution_loop": True,
                "requires_risk_constrained_execution": True,
                "requires_runtime_ledger_profit_proof": True,
                "rejects_agentic_search_only_promotion": True,
                "rejects_static_one_shot_factor_mining": True,
            },
        )

        rows = build_mlx_training_rows(candidate_specs=[spec], evidence_bundles=[])
        features = rows[0].to_payload()["features"]

        self.assertEqual(
            features["paper_overlay_adaptive_factor_to_execution_loop"], 1.0
        )
        self.assertEqual(features["paper_requires_adaptive_factor_screener"], 1.0)
        self.assertEqual(features["paper_requires_continuous_factor_mining"], 1.0)
        self.assertEqual(
            features["paper_requires_risk_constrained_execution_loop"], 1.0
        )
        self.assertEqual(features["paper_requires_portfolio_replay"], 1.0)
        self.assertEqual(features["paper_promotion_requires_count"], 3.0)
        self.assertEqual(features["paper_promotion_rejects_count"], 2.0)

    def test_training_rows_encode_crumbling_quote_overlay_contract(self) -> None:
        spec = CandidateSpec(
            schema_version="torghut.candidate-spec.v1",
            candidate_spec_id="spec-crumbling-quotes",
            hypothesis_id="H-CRUMBLING-QUOTES",
            family_template_id="microstructure_continuation_matched_filter_v1",
            candidate_kind="configuration",
            runtime_family="microstructure_continuation",
            runtime_strategy_name="microstructure-continuation-matched-filter-v1",
            feature_contract={
                "source_claims": [
                    {
                        "claim_id": "crumbling-quote-probability",
                        "claim_type": "execution_assumption",
                        "confidence": "0.78",
                        "data_requirements": [
                            "crumbling_quote_probability",
                            "mechanical_liquidity_erosion",
                        ],
                    }
                ],
                "validation_requirements": [
                    {
                        "claim_id": "crumbling-route-tca-validation",
                        "data_requirements": [
                            "executable_quote",
                            "route_tca",
                            "live_paper_parity",
                        ],
                    }
                ],
                "mechanism_overlays": [
                    {
                        "overlay_id": "crumbling_quote_liquidity_erosion",
                        "required_evidence": [
                            "crumbling_quote_probability",
                            "mechanical_liquidity_erosion",
                            "lob_event_stream",
                            "executable_quote",
                            "route_tca",
                            "live_paper_parity",
                        ],
                    }
                ],
            },
            parameter_space={
                "mechanism_overlay_ids": ["crumbling_quote_liquidity_erosion"]
            },
            strategy_overrides={
                "max_notional_per_trade": "25000",
                "max_position_pct_equity": "0.25",
                "params": {
                    "capital_profile": "initial_equity_cash_constrained_1x",
                    "max_entries_per_session": "2",
                    "max_gross_exposure_pct_equity": "1.0",
                },
            },
            objective={"target_net_pnl_per_day": "500"},
            hard_vetoes={"required_crumbling_quote_probability": True},
            expected_failure_modes=(),
            promotion_contract={
                "requires_crumbling_quote_probability": True,
                "requires_mechanical_liquidity_erosion_probability": True,
                "requires_live_paper_parity": True,
                "rejects_crumbling_quote_simulation_as_promotion_proof": True,
            },
        )

        rows = build_mlx_training_rows(candidate_specs=[spec], evidence_bundles=[])
        features = rows[0].to_payload()["features"]

        self.assertEqual(
            features["paper_overlay_crumbling_quote_liquidity_erosion"],
            1.0,
        )
        self.assertEqual(features["paper_requires_crumbling_quote_probability"], 1.0)
        self.assertEqual(
            features["paper_requires_mechanical_liquidity_erosion"],
            1.0,
        )
        self.assertEqual(features["paper_requires_executable_quote"], 1.0)
        self.assertEqual(features["paper_requires_route_tca"], 1.0)
        self.assertEqual(features["paper_requires_live_paper_parity"], 1.0)
        self.assertEqual(features["paper_promotion_requires_count"], 3.0)
        self.assertEqual(features["paper_promotion_rejects_count"], 1.0)

    def test_negative_rank_bucket_lift_demotes_to_heuristic_order(self) -> None:
        rows = [
            MlxTrainingRow(
                candidate_spec_id="aaa-strong",
                feature_names=("signal",),
                feature_values=(0.0,),
                target=500.0,
            ),
            MlxTrainingRow(
                candidate_spec_id="zzz-weak",
                feature_names=("signal",),
                feature_values=(0.0,),
                target=-100.0,
            ),
        ]
        tie_model = MlxRankerModel(
            schema_version=mlx_training_data_module.MLX_RANKER_SCHEMA_VERSION,
            model_id="mlx-ranker-v2-test",
            backend="numpy-fallback",
            feature_names=("signal",),
            feature_means=(0.0,),
            feature_scales=(1.0,),
            target_mean=0.0,
            target_scale=1.0,
            weights=(0.0,),
            bias=0.0,
            row_count=2,
            training_loss=0.0,
            trained_at="2026-04-21T00:00:00+00:00",
        )

        result = rank_training_rows_with_lift_policy(model=tie_model, rows=rows)

        self.assertEqual(result.model_status, "demoted_to_heuristic")
        self.assertEqual(result.selection_reason, "heuristic_negative_lift_fallback")
        self.assertLess(result.rank_bucket_lift.lift, 0)
        self.assertEqual(result.ranked_rows[0].candidate_spec_id, "aaa-strong")
        self.assertEqual(result.ranked_rows[0].score, 500.0)

    def test_training_rows_penalize_capital_infeasible_specs(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-capital-features",
            claims=[
                {
                    "claim_id": "claim-capital-features",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Order-flow clustering improves intraday continuation.",
                    "confidence": "0.82",
                }
            ],
        )
        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        over_budget = next(
            spec
            for spec in specs
            if _capital_profile(spec) != "initial_equity_cash_constrained_1x"
        )
        feasible = next(
            spec
            for spec in specs
            if _capital_profile(spec) == "initial_equity_cash_constrained_1x"
        )
        bundles = [
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=spec.candidate_spec_id,
                candidate={
                    "candidate_id": f"cand-{index}",
                    "objective_scorecard": {
                        "net_pnl_per_day": "500",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "1.0",
                    },
                },
                dataset_snapshot_id="snapshot-capital",
                result_path=f"/tmp/cand-{index}.json",
            )
            for index, spec in enumerate((over_budget, feasible), start=1)
        ]

        rows = build_mlx_training_rows(
            candidate_specs=[over_budget, feasible],
            evidence_bundles=bundles,
        )
        row_by_spec = {row.candidate_spec_id: row for row in rows}
        over_payload = row_by_spec[over_budget.candidate_spec_id].to_payload()
        feasible_payload = row_by_spec[feasible.candidate_spec_id].to_payload()

        self.assertGreater(
            over_payload["features"]["capital_budget_overage_ratio"], 0.0
        )
        self.assertEqual(over_payload["features"]["capital_feasible_flag"], 0.0)
        self.assertEqual(feasible_payload["features"]["capital_feasible_flag"], 1.0)
        self.assertLess(
            row_by_spec[over_budget.candidate_spec_id].target,
            row_by_spec[feasible.candidate_spec_id].target,
        )

    def test_training_rows_penalize_flat_real_replay_evidence(self) -> None:
        base_kwargs = {
            "schema_version": "torghut.candidate-spec.v1",
            "hypothesis_id": "H-FLAT",
            "family_template_id": "momentum_pullback_v1",
            "candidate_kind": "configuration",
            "runtime_family": "momentum_pullback_consistent",
            "runtime_strategy_name": "momentum-pullback-long-v1",
            "feature_contract": {},
            "parameter_space": {},
            "strategy_overrides": {
                "max_notional_per_trade": "7500",
                "max_position_pct_equity": "0.25",
                "params": {
                    "capital_profile": "initial_equity_cash_constrained_1x",
                    "max_entries_per_session": "1",
                    "max_gross_exposure_pct_equity": "1.0",
                },
            },
            "objective": {"target_net_pnl_per_day": "500"},
            "hard_vetoes": {"required_min_daily_notional": "300000"},
            "expected_failure_modes": (),
            "promotion_contract": {},
        }
        flat = CandidateSpec(candidate_spec_id="spec-flat", **base_kwargs)
        active = CandidateSpec(
            candidate_spec_id="spec-active",
            **{**base_kwargs, "hypothesis_id": "H-ACTIVE"},
        )
        bundles = [
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=flat.candidate_spec_id,
                candidate={
                    "candidate_id": "cand-flat",
                    "objective_scorecard": {
                        "net_pnl_per_day": "0",
                        "active_day_ratio": "0",
                        "positive_day_ratio": "0",
                        "avg_filled_notional_per_day": "0",
                        "hard_vetoes": [
                            "active_day_ratio_below_oracle",
                            "avg_filled_notional_per_day_below_oracle",
                        ],
                    },
                },
                dataset_snapshot_id="snapshot-flat",
                result_path="/tmp/cand-flat.json",
            ),
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=active.candidate_spec_id,
                candidate={
                    "candidate_id": "cand-active",
                    "objective_scorecard": {
                        "net_pnl_per_day": "25",
                        "active_day_ratio": "1",
                        "positive_day_ratio": "0.8",
                        "avg_filled_notional_per_day": "350000",
                        "hard_vetoes": [],
                    },
                },
                dataset_snapshot_id="snapshot-active",
                result_path="/tmp/cand-active.json",
            ),
        ]

        rows = build_mlx_training_rows(
            candidate_specs=[flat, active],
            evidence_bundles=bundles,
        )
        row_by_spec = {row.candidate_spec_id: row for row in rows}

        self.assertGreater(
            row_by_spec[flat.candidate_spec_id].to_payload()["features"][
                "history_observed_replay_viability_penalty"
            ],
            0.0,
        )
        self.assertLess(
            row_by_spec[flat.candidate_spec_id].target,
            row_by_spec[active.candidate_spec_id].target - 1000.0,
        )

    def test_training_rows_penalize_negative_post_cost_efficiency(self) -> None:
        base_kwargs = {
            "schema_version": "torghut.candidate-spec.v1",
            "hypothesis_id": "H-COST-EFFICIENCY",
            "family_template_id": "microbar_cross_sectional_pairs_v1",
            "candidate_kind": "configuration",
            "runtime_family": "microbar_cross_sectional_pairs",
            "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
            "feature_contract": {},
            "parameter_space": {},
            "strategy_overrides": {
                "max_notional_per_trade": "25000",
                "max_position_pct_equity": "0.25",
                "params": {
                    "capital_profile": "feedback_daily_coverage_cash_constrained_1x",
                    "max_entries_per_session": "2",
                    "max_gross_exposure_pct_equity": "1.0",
                },
            },
            "objective": {"target_net_pnl_per_day": "500"},
            "hard_vetoes": {"required_min_daily_notional": "25000"},
            "expected_failure_modes": (),
            "promotion_contract": {},
        }
        cost_killed = CandidateSpec(candidate_spec_id="spec-cost-killed", **base_kwargs)
        efficient = CandidateSpec(
            candidate_spec_id="spec-efficient",
            **{**base_kwargs, "hypothesis_id": "H-COST-EFFICIENT"},
        )
        bundles = [
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=cost_killed.candidate_spec_id,
                candidate={
                    "candidate_id": "cand-cost-killed",
                    "objective_scorecard": {
                        "net_pnl_per_day": "-50",
                        "active_day_ratio": "1",
                        "positive_day_ratio": "0",
                        "negative_day_count": 2,
                        "avg_filled_notional_per_day": "25000",
                        "hard_vetoes": [],
                    },
                },
                dataset_snapshot_id="snapshot-cost-killed",
                result_path="/tmp/cand-cost-killed.json",
            ),
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=efficient.candidate_spec_id,
                candidate={
                    "candidate_id": "cand-efficient",
                    "objective_scorecard": {
                        "net_pnl_per_day": "50",
                        "active_day_ratio": "1",
                        "positive_day_ratio": "1",
                        "negative_day_count": 0,
                        "avg_filled_notional_per_day": "25000",
                        "hard_vetoes": [],
                    },
                },
                dataset_snapshot_id="snapshot-efficient",
                result_path="/tmp/cand-efficient.json",
            ),
        ]

        rows = build_mlx_training_rows(
            candidate_specs=[cost_killed, efficient],
            evidence_bundles=bundles,
        )
        row_by_spec = {row.candidate_spec_id: row for row in rows}
        cost_killed_features = row_by_spec[cost_killed.candidate_spec_id].to_payload()[
            "features"
        ]
        efficient_features = row_by_spec[efficient.candidate_spec_id].to_payload()[
            "features"
        ]

        self.assertEqual(
            cost_killed_features["history_net_pnl_per_100k_filled_notional"],
            -200.0,
        )
        self.assertGreater(
            cost_killed_features["history_post_cost_efficiency_penalty"],
            efficient_features["history_post_cost_efficiency_penalty"],
        )
        self.assertLess(
            row_by_spec[cost_killed.candidate_spec_id].target,
            row_by_spec[efficient.candidate_spec_id].target - 500.0,
        )

    def test_training_rows_penalize_configured_daily_notional_shortfall(self) -> None:
        base_kwargs = {
            "schema_version": "torghut.candidate-spec.v1",
            "hypothesis_id": "H-CAPACITY",
            "family_template_id": "breakout_reclaim_v2",
            "candidate_kind": "configuration",
            "runtime_family": "breakout_continuation_consistent",
            "runtime_strategy_name": "breakout-continuation-long-v1",
            "feature_contract": {},
            "parameter_space": {},
            "strategy_overrides": {
                "max_position_pct_equity": "0.25",
                "params": {
                    "max_entries_per_session": "2",
                    "top_n": "1",
                    "max_gross_exposure_pct_equity": "1.0",
                },
            },
            "objective": {"target_net_pnl_per_day": "500"},
            "hard_vetoes": {"required_min_daily_notional": "300000"},
            "expected_failure_modes": (),
            "promotion_contract": {},
        }
        low_capacity = CandidateSpec(
            candidate_spec_id="spec-low-capacity",
            **{
                **base_kwargs,
                "strategy_overrides": {
                    **base_kwargs["strategy_overrides"],
                    "max_notional_per_trade": "10000",
                },
            },
        )
        full_capacity = CandidateSpec(
            candidate_spec_id="spec-full-capacity",
            **{
                **base_kwargs,
                "hypothesis_id": "H-CAPACITY-FULL",
                "strategy_overrides": {
                    **base_kwargs["strategy_overrides"],
                    "max_notional_per_trade": "30000",
                    "params": {
                        **base_kwargs["strategy_overrides"]["params"],
                        "max_entries_per_session": "10",
                    },
                },
            },
        )
        bundles = [
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=spec.candidate_spec_id,
                candidate={
                    "candidate_id": f"cand-{spec.candidate_spec_id}",
                    "objective_scorecard": {
                        "net_pnl_per_day": "25",
                        "active_day_ratio": "1",
                        "positive_day_ratio": "1",
                        "negative_day_count": 0,
                        "avg_filled_notional_per_day": "300000",
                        "hard_vetoes": [],
                    },
                },
                dataset_snapshot_id=f"snapshot-{spec.candidate_spec_id}",
                result_path=f"/tmp/{spec.candidate_spec_id}.json",
            )
            for spec in (low_capacity, full_capacity)
        ]

        rows = build_mlx_training_rows(
            candidate_specs=[low_capacity, full_capacity],
            evidence_bundles=bundles,
        )
        row_by_spec = {row.candidate_spec_id: row for row in rows}
        low_payload = row_by_spec[low_capacity.candidate_spec_id].to_payload()
        full_payload = row_by_spec[full_capacity.candidate_spec_id].to_payload()

        self.assertEqual(
            low_payload["features"]["configured_daily_notional_required_ratio"],
            20000.0 / 300000.0,
        )
        self.assertEqual(
            full_payload["features"]["configured_daily_notional_required_ratio"],
            1.0,
        )
        self.assertLess(
            row_by_spec[low_capacity.candidate_spec_id].target,
            row_by_spec[full_capacity.candidate_spec_id].target - 650.0,
        )
