from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.candidate_specs.support import (
    Decimal,
    StrategyCatalogConfig,
    _TestCandidateSpecsBase,
    _capital_profile,
    build_hypothesis_cards,
    candidate_spec_capital_features,
    candidate_specs_module,
    compile_candidate_specs,
)


class TestRejectedSignalClaimAddsCounterfactualOutcomeContract(_TestCandidateSpecsBase):
    def test_rejected_signal_claim_adds_counterfactual_outcome_contract(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-red-2400",
            claims=[
                {
                    "claim_id": "rejection-event-outcome-labels",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Algorithmically rejected trading events with outcome labels "
                        "turn rejected signal logs into counterfactual examples for "
                        "veto calibration."
                    ),
                    "data_requirements": [
                        "rejected_signal_log",
                        "outcome_labels",
                        "executable_quote",
                    ],
                    "confidence": "0.76",
                },
                {
                    "claim_id": "counterfactual-reject-outcome-learning",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Rejected events require counterfactual return, route/TCA, "
                        "and post-cost net PnL labels before relaxing vetoes."
                    ),
                    "data_requirements": [
                        "rejected_signal_log",
                        "counterfactual_return",
                        "route_tca",
                        "post_cost_net_pnl",
                    ],
                    "confidence": "0.76",
                },
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("300")
        )

        self.assertIn(
            "rejected_signal_outcome_calibration",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertEqual(
            specs[0].hard_vetoes["required_min_rejected_signal_outcome_label_count"],
            "120",
        )
        self.assertEqual(
            specs[0].hard_vetoes["required_min_rejected_signal_reason_coverage"],
            "0.80",
        )
        self.assertEqual(
            specs[0].hard_vetoes["required_rejected_signal_outcome_persistence_state"],
            "ok",
        )
        self.assertTrue(
            specs[0].promotion_contract["requires_rejected_signal_outcome_learning"]
        )
        self.assertTrue(
            specs[0].promotion_contract[
                "requires_rejected_signal_counterfactual_replay"
            ]
        )
        self.assertTrue(
            specs[0].promotion_contract[
                "rejects_pending_rejected_signal_outcome_labels"
            ]
        )
        self.assertTrue(
            specs[0].promotion_contract["rejects_unlabeled_reject_relaxation"]
        )

    def test_rejected_signal_claim_adds_false_negative_rescue_profiles(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-red-2400",
            claims=[
                {
                    "claim_id": "rejection-event-outcome-labels",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Algorithmically rejected trading events with outcome labels "
                        "turn skipped signal logs into counterfactual false-negative "
                        "rescue examples for veto calibration."
                    ),
                    "data_requirements": [
                        "rejected_signal_log",
                        "outcome_labels",
                        "executable_quote",
                    ],
                    "confidence": "0.76",
                },
                {
                    "claim_id": "counterfactual-reject-outcome-learning",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Rejected events require counterfactual return, route/TCA, "
                        "and post-cost net PnL labels before relaxing vetoes."
                    ),
                    "data_requirements": [
                        "rejected_signal_log",
                        "counterfactual_return",
                        "route_tca",
                        "post_cost_net_pnl",
                    ],
                    "confidence": "0.76",
                },
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        family_ids = {spec.family_template_id for spec in specs}
        rescue_specs = [
            spec
            for spec in specs
            if spec.strategy_overrides.get("params", {}).get("veto_relaxation_scope")
            == "labeled_false_negative_only"
        ]

        self.assertEqual(
            family_ids,
            {
                "microstructure_continuation_matched_filter_v1",
                "microbar_cross_sectional_pairs_v1",
                "opening_drive_leader_reclaim_v1",
            },
        )
        self.assertTrue(rescue_specs)
        self.assertTrue(
            all(
                spec.strategy_overrides["params"]["outcome_label_filter"]
                == "profitable_after_costs"
                for spec in rescue_specs
            )
        )
        self.assertTrue(
            all(
                Decimal(str(spec.strategy_overrides["max_notional_per_trade"]))
                <= Decimal("30000")
                for spec in rescue_specs
            )
        )

    def test_morning_momentum_claim_selects_opening_drive_family(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-morning-momentum",
            claims=[
                {
                    "claim_id": "claim-first-half-hour",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "First half-hour return and opening drive leader reclaim "
                        "predict intraday momentum when information is discrete."
                    ),
                    "confidence": "0.83",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        opening_specs = [
            spec
            for spec in specs
            if spec.family_template_id == "opening_drive_leader_reclaim_v1"
        ]
        self.assertTrue(opening_specs)
        self.assertEqual(
            opening_specs[0].runtime_strategy_name,
            "breakout-continuation-long-v1",
        )
        self.assertIn(
            "morning_or_announcement_momentum",
            opening_specs[0].feature_contract["family_selection"]["reasons"],
        )

    def test_orb_claim_selects_opening_drive_and_breakout_families(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-orb-stocks-in-play",
            claims=[
                {
                    "claim_id": "claim-orb",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Stocks in Play with unusually high daily volume can produce "
                        "opening range breakout continuation after the first five minutes."
                    ),
                    "confidence": "0.82",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        families = {spec.family_template_id for spec in specs}

        self.assertIn("opening_drive_leader_reclaim_v1", families)
        self.assertIn("breakout_reclaim_v2", families)

    def test_literal_eod_reversal_claim_selects_end_of_day_family(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-eod-reversal",
            claims=[
                {
                    "claim_id": "claim-eod",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "End-of-day reversal in individual intraday losers appears "
                        "during the final 30 minutes as closing pressure unwinds."
                    ),
                    "confidence": "0.80",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        eod_specs = [
            spec
            for spec in specs
            if spec.family_template_id == "end_of_day_reversal_v1"
        ]

        self.assertTrue(eod_specs)
        self.assertIn(
            "closing_window_reversal",
            eod_specs[0].feature_contract["family_selection"]["reasons"],
        )

    def test_hmm_ofi_claim_selects_microstructure_family(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-ofi-hmm",
            claims=[
                {
                    "claim_id": "claim-ofi-hmm",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "A hidden Markov model over order flow imbalance identifies "
                        "latent regime persistence and liquidity dislocation states."
                    ),
                    "confidence": "0.78",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        microstructure_specs = [
            spec
            for spec in specs
            if spec.family_template_id
            == "microstructure_continuation_matched_filter_v1"
        ]

        self.assertTrue(microstructure_specs)
        self.assertIn(
            "volatility_or_regime_state",
            microstructure_specs[0].feature_contract["family_selection"]["reasons"],
        )

    def test_entropy_state_claim_routes_to_microstructure_regime_families(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-order-flow-entropy",
            claims=[
                {
                    "claim_id": "claim-entropy",
                    "claim_type": "feature_recipe",
                    "claim_text": (
                        "Real-time order-flow entropy predicts absolute intraday move size as "
                        "a volatility state, but not directional alpha."
                    ),
                    "data_requirements": [
                        "order_flow_entropy",
                        "trade_sign_markov_state",
                        "realized_volatility",
                    ],
                    "confidence": "0.75",
                },
                {
                    "claim_id": "claim-entropy-validation",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Entropy states require walk-forward validation and should be used "
                        "for sizing context unless separate direction clears placebo tests."
                    ),
                    "confidence": "0.75",
                },
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("300")
        )

        family_reasons = {
            spec.family_template_id: spec.feature_contract["family_selection"][
                "reasons"
            ]
            for spec in specs
        }
        self.assertIn("microstructure_continuation_matched_filter_v1", family_reasons)
        self.assertIn("intraday_tsmom_v2", family_reasons)
        self.assertIn(
            "volatility_or_regime_state",
            family_reasons["microstructure_continuation_matched_filter_v1"],
        )

    def test_constrained_factor_claim_routes_to_executable_factor_families(
        self,
    ) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-constrained-factor-dsl",
            claims=[
                {
                    "claim_id": "claim-factor-dsl",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Constrained LLM hypothesis search emits point-in-time factor DSL "
                        "programs with fixed splits, transaction costs, and portfolio tests."
                    ),
                    "data_requirements": [
                        "factor_dsl",
                        "append_only_experiment_trace",
                        "walk_forward_replay",
                    ],
                    "confidence": "0.77",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("300")
        )

        factor_specs = [
            spec
            for spec in specs
            if spec.family_template_id
            in {
                "microbar_cross_sectional_pairs_v1",
                "microstructure_continuation_matched_filter_v1",
            }
        ]
        self.assertTrue(factor_specs)
        self.assertTrue(
            all(
                "constrained_factor_search"
                in spec.feature_contract["family_selection"]["reasons"]
                for spec in factor_specs
            )
        )

    def test_unpinned_hypotheses_expand_all_family_execution_profiles(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-profile-breadth",
            claims=[
                {
                    "claim_id": "claim-flow-breadth",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Clustered order flow imbalance improves intraday LOB continuation signals.",
                    "confidence": "0.82",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        continuation_profiles = sorted(
            (
                spec.feature_contract["execution_profile"]["profile_id"]
                for spec in specs
                if spec.family_template_id
                == "microstructure_continuation_matched_filter_v1"
            ),
            key=lambda profile_id: int(str(profile_id).rsplit("-", 1)[1]),
        )
        expected_continuation_profiles = [
            f"microstructure_continuation_matched_filter_v1:profile-{index + 1}"
            for index in range(
                len(
                    candidate_specs_module._execution_profiles_for_target(
                        family_template_id="microstructure_continuation_matched_filter_v1",
                        target_net_pnl_per_day=Decimal("500"),
                    )
                )
            )
        ]
        self.assertEqual(
            continuation_profiles,
            expected_continuation_profiles,
        )
        self.assertEqual(
            len({spec.candidate_spec_id for spec in specs}),
            len(specs),
        )

    def test_portfolio_profit_target_adds_diversified_sleeve_families(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-portfolio-sleeves",
            claims=[
                {
                    "claim_id": "claim-flow-sleeves",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Clustered order flow imbalance improves intraday LOB continuation signals.",
                    "confidence": "0.82",
                }
            ],
        )

        baseline_specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("300")
        )
        portfolio_specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        self.assertEqual(
            {spec.family_template_id for spec in baseline_specs},
            {
                "intraday_tsmom_v2",
                "microbar_cross_sectional_pairs_v1",
                "microstructure_continuation_matched_filter_v1",
            },
        )
        self.assertEqual(
            {spec.family_template_id for spec in portfolio_specs},
            set(candidate_specs_module._FAMILY_EXECUTION_PROFILES),
        )
        self.assertEqual(
            len(portfolio_specs),
            sum(
                len(
                    candidate_specs_module._execution_profiles_for_target(
                        family_template_id=family_template_id,
                        target_net_pnl_per_day=Decimal("500"),
                    )
                )
                for family_template_id in candidate_specs_module._FAMILY_EXECUTION_PROFILES
            ),
        )
        self.assertGreater(len(portfolio_specs), 36)
        self.assertTrue(
            all(
                spec.strategy_overrides["params"]["position_isolation_mode"]
                == "per_strategy"
                for spec in portfolio_specs
            )
        )
        self.assertGreater(len(portfolio_specs), len(baseline_specs))
        complementary_spec = next(
            spec
            for spec in portfolio_specs
            if spec.family_template_id == "end_of_day_reversal_v1"
        )
        self.assertEqual(
            complementary_spec.feature_contract["family_selection"]["reasons"],
            ["portfolio_sleeve_diversification"],
        )

    def test_portfolio_profit_target_profiles_include_oracle_coverage_sleeves(
        self,
    ) -> None:
        coverage_profiles = (
            candidate_specs_module._PORTFOLIO_ORACLE_COVERAGE_EXECUTION_PROFILES
        )

        self.assertEqual(
            set(coverage_profiles), set(candidate_specs_module._FAMILY_RUNTIME)
        )
        coverage_symbols = set(
            candidate_specs_module._PORTFOLIO_COVERAGE_UNIVERSE_PROFILE
        )
        for family_template_id, profiles in coverage_profiles.items():
            self.assertGreaterEqual(len(profiles), 3, family_template_id)
            self.assertTrue(
                any(
                    list(profile["universe_symbols"])
                    == list(candidate_specs_module._PORTFOLIO_COVERAGE_UNIVERSE_PROFILE)
                    for profile in profiles
                ),
                family_template_id,
            )
            self.assertTrue(
                any(
                    list(profile["universe_symbols"])
                    == list(
                        candidate_specs_module._PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE
                    )
                    for profile in profiles
                ),
                family_template_id,
            )
            self.assertTrue(
                any(
                    list(profile["universe_symbols"])
                    == list(
                        candidate_specs_module._PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE
                    )
                    for profile in profiles
                ),
                family_template_id,
            )
            for profile in profiles:
                symbols = [
                    str(symbol).strip().upper()
                    for symbol in profile["universe_symbols"]
                ]
                self.assertEqual(
                    len(symbols),
                    len(set(symbols)),
                    f"{family_template_id} portfolio coverage profile has duplicate symbols",
                )
                self.assertEqual(
                    sorted(set(symbols) - coverage_symbols),
                    [],
                    f"{family_template_id} portfolio coverage profile uses unresearched symbols",
                )
                self.assertLessEqual(
                    Decimal(str(profile["max_position_pct_equity"])),
                    Decimal("4.0"),
                    family_template_id,
                )
                self.assertLessEqual(
                    Decimal(str(profile["max_notional_per_trade"])),
                    Decimal("126360"),
                    family_template_id,
                )

    def test_portfolio_profit_target_includes_prev_close_reversal_surface(
        self,
    ) -> None:
        coverage_profiles = (
            candidate_specs_module._PORTFOLIO_ORACLE_COVERAGE_EXECUTION_PROFILES
        )

        microbar_motifs = {
            str(profile["params"].get("signal_motif"))
            for profile in coverage_profiles["microbar_cross_sectional_pairs_v1"]
        }
        self.assertIn("overnight_gap_reversal", microbar_motifs)
        self.assertIn("opening_window_prev_close_reversal", microbar_motifs)
        self.assertIn("intraday_tug_of_war_reversal", microbar_motifs)

        prev_close_microbar = [
            profile
            for profile in coverage_profiles["microbar_cross_sectional_pairs_v1"]
            if str(profile["params"].get("rank_feature"))
            in {
                "cross_section_prev_session_close_rank",
                "cross_section_opening_window_return_from_prev_close_rank",
            }
        ]
        self.assertGreaterEqual(len(prev_close_microbar), 3)
        for profile in prev_close_microbar:
            params = profile["params"]
            self.assertEqual(params["selection_mode"], "reversal")
            self.assertIn("entry_window_minutes", params)
            self.assertEqual(
                params["gate_feature"],
                "cross_section_positive_opening_window_return_from_prev_close_ratio",
            )
            self.assertLessEqual(
                Decimal(str(profile["max_notional_per_trade"])), Decimal("63180")
            )
            self.assertLessEqual(
                Decimal(str(profile["max_position_pct_equity"])), Decimal("2.0")
            )
            self.assertLessEqual(
                Decimal(str(params["max_session_negative_exit_bps"])), Decimal("3")
            )

        for family_template_id in (
            "mean_reversion_rebound_v1",
            "end_of_day_reversal_v1",
        ):
            prev_close_profiles = [
                profile
                for profile in coverage_profiles[family_template_id]
                if profile["params"].get("drive_reference_basis") == "prev_close"
            ]
            self.assertGreaterEqual(len(prev_close_profiles), 3, family_template_id)
            for profile in prev_close_profiles:
                params = profile["params"]
                self.assertEqual(params["opening_window_reference_basis"], "prev_close")
                self.assertEqual(
                    params["opening_window_rank_reference_basis"], "prev_close"
                )
                self.assertLessEqual(
                    Decimal(str(profile["max_notional_per_trade"])), Decimal("63180")
                )
                self.assertLessEqual(
                    Decimal(str(profile["max_position_pct_equity"])), Decimal("2.0")
                )
                self.assertLessEqual(
                    Decimal(str(params["max_session_negative_exit_bps"])),
                    Decimal("3"),
                )

    def test_microbar_pairs_profiles_include_residual_statarb_surfaces(self) -> None:
        profiles = candidate_specs_module._FAMILY_EXECUTION_PROFILES[
            "microbar_cross_sectional_pairs_v1"
        ]
        rank_features = {
            str(profile["params"].get("rank_feature")) for profile in profiles
        }
        signal_motifs = {
            str(profile["params"].get("signal_motif")) for profile in profiles
        }

        self.assertIn("cross_section_factor_neutral_residual_rank", rank_features)
        self.assertIn("cross_section_residual_spread_zscore_rank", rank_features)
        self.assertIn("factor_neutral_residual_continuation", signal_motifs)
        self.assertIn("residual_spread_reversion", signal_motifs)

    def test_portfolio_profit_target_adds_capital_constrained_profiles(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-capital-realistic",
            claims=[
                {
                    "claim_id": "claim-flow-capital",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Order-flow clustering can predict short-horizon continuation.",
                    "confidence": "0.82",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        for family_template_id in candidate_specs_module._FAMILY_RUNTIME:
            capital_specs = [
                spec
                for spec in specs
                if spec.family_template_id == family_template_id
                and _capital_profile(spec) == "initial_equity_cash_constrained_1x"
            ]
            self.assertTrue(capital_specs, family_template_id)
            for spec in capital_specs:
                self.assertNotIn("capital_profile", spec.strategy_overrides)
                params = spec.strategy_overrides["params"]
                self.assertIsInstance(params, dict)
                self.assertEqual(
                    params["capital_profile"],
                    "initial_equity_cash_constrained_1x",
                )
                StrategyCatalogConfig.model_validate(
                    {
                        "strategies": [
                            {
                                "name": spec.candidate_spec_id,
                                "strategy_id": spec.candidate_spec_id,
                                "params": params,
                                "universe_symbols": spec.strategy_overrides.get(
                                    "universe_symbols", []
                                ),
                                "max_position_pct_equity": spec.strategy_overrides.get(
                                    "max_position_pct_equity"
                                ),
                                "max_notional_per_trade": spec.strategy_overrides.get(
                                    "max_notional_per_trade"
                                ),
                            }
                        ]
                    }
                )
                features = candidate_spec_capital_features(spec)
                self.assertEqual(features["capital_feasible_flag"], 1.0)
                self.assertLessEqual(
                    Decimal(str(features["estimated_max_gross_exposure_pct_equity"])),
                    Decimal("1.0"),
                    spec.candidate_spec_id,
                )
                self.assertEqual(
                    spec.strategy_overrides["params"]["max_gross_exposure_pct_equity"],
                    "1.0",
                )

    def test_portfolio_profit_target_adds_feedback_escape_profiles(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-feedback-escape",
            claims=[
                {
                    "claim_id": "claim-feedback-escape",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Order-flow clustering can predict short-horizon continuation.",
                    "confidence": "0.82",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        expected_profiles = {
            "daily_coverage_feedback_escape",
            "consistency_guard_feedback_escape",
            "turnover_coverage_feedback_escape",
        }
        for family_template_id in candidate_specs_module._FAMILY_RUNTIME:
            family_specs = [
                spec for spec in specs if spec.family_template_id == family_template_id
            ]
            remediation_profiles = {
                str(
                    spec.strategy_overrides["params"].get(
                        "feedback_remediation_profile"
                    )
                )
                for spec in family_specs
                if isinstance(spec.strategy_overrides.get("params"), dict)
                and spec.strategy_overrides["params"].get(
                    "feedback_remediation_profile"
                )
            }
            self.assertGreaterEqual(
                remediation_profiles,
                expected_profiles,
                family_template_id,
            )
            for spec in family_specs:
                params = spec.strategy_overrides.get("params")
                if not isinstance(params, dict) or not params.get(
                    "feedback_remediation_profile"
                ):
                    continue
                self.assertEqual(params["max_gross_exposure_pct_equity"], "1.0")
                self.assertTrue(str(params["capital_profile"]).startswith("feedback_"))
                self.assertEqual(
                    candidate_spec_capital_features(spec)["capital_feasible_flag"], 1.0
                )
