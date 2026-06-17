from __future__ import annotations

from tests.candidate_specs.support import (
    Decimal,
    HYPOTHESIS_CARD_SCHEMA_VERSION,
    HypothesisCard,
    Path,
    _CHIP_UNIVERSE_SYMBOLS,
    _TestCandidateSpecsBase,
    build_hypothesis_cards,
    candidate_spec_from_payload,
    candidate_specs_module,
    compile_candidate_specs,
    compile_whitepaper_candidate_specs,
)


class TestPortfolioProfitTargetAddsHPairsReplayLedgerBreadthProfiles(
    _TestCandidateSpecsBase
):
    def test_portfolio_profit_target_adds_h_pairs_replay_ledger_breadth_profiles(
        self,
    ) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-hpairs-ledger-breadth",
            claims=[
                {
                    "claim_id": "claim-hpairs-breadth",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Cross-sectional pair ranking over intraday order-flow and "
                        "opening-window signals can improve H-PAIRS notional throughput."
                    ),
                    "confidence": "0.86",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        replay_guided_specs = [
            spec
            for spec in specs
            if spec.family_template_id == "microbar_cross_sectional_pairs_v1"
            and spec.parameter_space.get("replay_ledger_guided_candidate_expansion")
            and not spec.strategy_overrides["params"].get(
                "feedback_remediation_profile"
            )
        ]
        self.assertGreaterEqual(len(replay_guided_specs), 2)
        for spec in replay_guided_specs:
            params = spec.strategy_overrides["params"]
            self.assertGreaterEqual(int(params["top_n"]), 4)
            self.assertGreaterEqual(int(params["max_pair_legs"]), 5)
            self.assertGreaterEqual(int(params["max_entries_per_session"]), 6)
            self.assertEqual(
                params["replay_ledger_guidance_scope"],
                "bounded_exact_replay_prefilter",
            )
            self.assertEqual(
                spec.promotion_contract["promotion_policy"], "research_only"
            )
            self.assertTrue(
                spec.promotion_contract["requires_runtime_ledger_profit_proof"]
            )
            self.assertTrue(
                spec.promotion_contract[
                    "replay_ledger_guided_search_is_not_promotion_proof"
                ]
            )

    def test_feedback_escape_profiles_dedupe_and_fallback_invalid_params(self) -> None:
        profile = {
            "params": {
                "entry_minute_after_open": "not-a-decimal",
                "exit_minute_after_open": "invalid",
                "top_n": "2",
                "max_pair_legs": "2",
                "gate_feature": "cross_section_positive_opening_window_return_from_prev_close_ratio",
                "gate_min": "0.20",
                "gate_max": "0.80",
            },
            "universe_symbols": ["NVDA", "AAPL"],
            "max_notional_per_trade": "90000",
            "max_position_pct_equity": "2.0",
        }

        expanded = candidate_specs_module._portfolio_feedback_escape_execution_profiles(
            (profile, profile)
        )

        self.assertEqual(
            [
                next_profile["params"]["feedback_remediation_profile"]
                for next_profile in expanded
            ],
            [
                "daily_coverage_feedback_escape",
                "consistency_guard_feedback_escape",
                "turnover_coverage_feedback_escape",
                "notional_throughput_feedback_escape",
                "adverse_selection_feedback_escape",
                "symbol_diversification_feedback_escape",
            ],
        )
        for next_profile in expanded:
            self.assertNotIn("gate_feature", next_profile["params"])
            self.assertNotIn("gate_min", next_profile["params"])
            self.assertNotIn("gate_max", next_profile["params"])
        notional = expanded[3]
        self.assertGreaterEqual(
            int(notional["params"]["max_entries_per_session"]),
            10,
        )
        self.assertGreaterEqual(int(notional["params"]["top_n"]), 4)
        self.assertGreaterEqual(int(notional["params"]["max_pair_legs"]), 4)
        self.assertEqual(notional["params"]["entry_notional_max_multiplier"], "1.0")
        adverse_selection = expanded[4]
        self.assertEqual(
            adverse_selection["params"]["feedback_remediation_profile"],
            "adverse_selection_feedback_escape",
        )
        self.assertEqual(
            adverse_selection["params"]["max_stop_loss_exits_per_session"],
            "1",
        )
        diversified = expanded[-1]
        self.assertEqual(diversified["params"]["top_n"], "3")
        self.assertGreaterEqual(
            int(diversified["params"]["max_concurrent_positions"]), 3
        )
        self.assertEqual(
            diversified["params"]["symbol_concentration_feedback_guard"],
            "max_single_symbol_contribution",
        )
        self.assertGreater(
            len(diversified["universe_symbols"]), len(profile["universe_symbols"])
        )
        self.assertEqual(
            sorted(set(diversified["universe_symbols"]) - _CHIP_UNIVERSE_SYMBOLS),
            [],
        )
        self.assertEqual(
            candidate_specs_module._decimal_profile_param(
                profile["params"],
                "entry_minute_after_open",
                default=Decimal("45"),
            ),
            Decimal("45"),
        )
        self.assertEqual(
            candidate_specs_module._int_profile_param(
                profile["params"],
                "exit_minute_after_open",
                default=150,
            ),
            150,
        )

    def test_short_exhaustion_claim_compiles_short_sleeve_profiles(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-short-exhaustion",
            claims=[
                {
                    "claim_id": "claim-short-fade",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Short-side upside exhaustion fade with offer pressure can "
                        "profit from overbought intraday weakness."
                    ),
                    "confidence": "0.81",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("300")
        )
        short_specs = [
            spec
            for spec in specs
            if spec.family_template_id == "mean_reversion_exhaustion_short_v1"
        ]

        self.assertEqual(len(short_specs), 3)
        self.assertTrue(
            all(
                spec.runtime_family == "mean_reversion_exhaustion_short_consistent"
                for spec in short_specs
            )
        )
        self.assertTrue(
            all(
                spec.runtime_strategy_name == "mean-reversion-exhaustion-short-v1"
                for spec in short_specs
            )
        )
        self.assertEqual(
            {
                spec.feature_contract["execution_profile"]["profile_id"]
                for spec in short_specs
            },
            {
                "mean_reversion_exhaustion_short_v1:profile-1",
                "mean_reversion_exhaustion_short_v1:profile-2",
                "mean_reversion_exhaustion_short_v1:profile-3",
            },
        )
        self.assertTrue(
            all(
                "short_stop_loss_bps" in spec.strategy_overrides["params"]
                for spec in short_specs
            )
        )

    def test_same_family_whitepaper_hypotheses_get_distinct_execution_profiles(
        self,
    ) -> None:
        cards = [
            HypothesisCard(
                schema_version=HYPOTHESIS_CARD_SCHEMA_VERSION,
                hypothesis_id=f"hyp-profile-{index}",
                source_run_id="paper-profile",
                source_claim_ids=(f"claim-profile-{index}",),
                mechanism="Clustered order flow imbalance improves intraday LOB continuation signals.",
                asset_scope="us_equities_intraday",
                horizon_scope="intraday",
                expected_direction="positive",
                required_features=("order_flow_imbalance", "spread_bps"),
                entry_motifs=("microbar_rank",),
                exit_motifs=("time_exit",),
                risk_controls=("quote_quality",),
                expected_regimes=("liquid_regular_session",),
                failure_modes=("cost_stress",),
                implementation_constraints={"execution_profile_index": index},
                confidence=Decimal("0.8"),
            )
            for index in range(2)
        ]

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("300")
        )

        continuation_specs = [
            spec
            for spec in specs
            if spec.family_template_id
            == "microstructure_continuation_matched_filter_v1"
        ]
        self.assertEqual(len(continuation_specs), 2)
        self.assertNotEqual(
            continuation_specs[0].strategy_overrides,
            continuation_specs[1].strategy_overrides,
        )
        self.assertEqual(
            continuation_specs[0].feature_contract["execution_profile"]["profile_id"],
            "microstructure_continuation_matched_filter_v1:profile-1",
        )
        self.assertEqual(
            continuation_specs[1].to_vnext_experiment_payload()["template_overrides"][
                "params"
            ]["leader_reclaim_start_minutes_since_open"],
            "45",
        )

    def test_explicit_universe_symbols_override_profile_universes(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-chip-universe",
            claims=[
                {
                    "claim_id": "claim-flow",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Order-flow clustering can predict short-horizon continuation.",
                    "data_requirements": ["order_flow_imbalance", "spread_bps"],
                    "confidence": "0.8",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards,
            target_net_pnl_per_day=Decimal("300"),
            universe_symbols=("nvda", " AMD ", "NVDA", "arm", "mu", "aapl"),
        )

        self.assertTrue(specs)
        for spec in specs:
            self.assertEqual(
                spec.strategy_overrides["universe_symbols"],
                ["NVDA", "AMD", "AAPL"],
            )
            self.assertEqual(
                spec.to_vnext_experiment_payload()["template_overrides"][
                    "universe_symbols"
                ],
                ["NVDA", "AMD", "AAPL"],
            )

    def test_microbar_whitepaper_profiles_include_runtime_risk_controls(self) -> None:
        card = HypothesisCard(
            schema_version=HYPOTHESIS_CARD_SCHEMA_VERSION,
            hypothesis_id="hyp-microbar-risk-controls",
            source_run_id="paper-microbar-risk",
            source_claim_ids=("claim-microbar-risk",),
            mechanism="Order-flow LOB imbalance continuation with execution shortfall controls.",
            asset_scope="us_equities_intraday",
            horizon_scope="intraday",
            expected_direction="positive",
            required_features=("order_flow_imbalance", "spread_bps"),
            entry_motifs=("microbar_rank",),
            exit_motifs=("time_exit",),
            risk_controls=("quote_quality", "stop_loss", "max_drawdown"),
            expected_regimes=("liquid_regular_session",),
            failure_modes=("cost_stress",),
            implementation_constraints={"execution_profile_index": 1},
            confidence=Decimal("0.8"),
        )

        specs = compile_candidate_specs(
            hypothesis_cards=[card], target_net_pnl_per_day=Decimal("300")
        )
        microbar = next(
            spec
            for spec in specs
            if spec.family_template_id == "microbar_cross_sectional_pairs_v1"
        )

        params = microbar.to_vnext_experiment_payload()["template_overrides"]["params"]
        self.assertEqual(params["long_stop_loss_bps"], "10")
        self.assertEqual(params["long_trailing_stop_activation_profit_bps"], "8")
        self.assertEqual(params["long_trailing_stop_drawdown_bps"], "4")
        self.assertEqual(params["max_session_negative_exit_bps"], "8")
        self.assertEqual(params["max_stop_loss_exits_per_session"], "1")

    def test_late_day_whitepaper_hypothesis_gets_late_day_runtime_profile(self) -> None:
        card = HypothesisCard(
            schema_version=HYPOTHESIS_CARD_SCHEMA_VERSION,
            hypothesis_id="hyp-late-day-momentum",
            source_run_id="paper-late-day-alpha",
            source_claim_ids=("claim-late-day-alpha",),
            mechanism=(
                "Macro announcement incremental information strengthens late-day intraday "
                "momentum into the close with VWAP exit and microprice confirmation."
            ),
            asset_scope="us_equities_intraday",
            horizon_scope="intraday_momentum",
            expected_direction="positive",
            required_features=(
                "macro_announcement_window",
                "weighted_microprice_momentum",
                "spread_bps",
            ),
            entry_motifs=("late_day_continuation",),
            exit_motifs=("vwap_ladder_exit",),
            risk_controls=("quote_quality", "stop_loss", "close_flatten"),
            expected_regimes=("late_session_information_arrival",),
            failure_modes=("event_overfit", "cost_stress"),
            implementation_constraints={"execution_profile_index": 0},
            confidence=Decimal("0.74"),
        )

        specs = compile_candidate_specs(
            hypothesis_cards=[card], target_net_pnl_per_day=Decimal("300")
        )
        late_day = next(
            spec
            for spec in specs
            if spec.family_template_id == "late_day_continuation_v1"
        )

        self.assertEqual(late_day.runtime_family, "late_day_continuation_consistent")
        self.assertEqual(
            late_day.runtime_strategy_name, "late-day-continuation-long-v1"
        )
        self.assertEqual(late_day.objective["target_net_pnl_per_day"], "300")
        self.assertEqual(
            late_day.feature_contract["execution_profile"]["profile_id"],
            "late_day_continuation_v1:profile-1",
        )
        self.assertIn(
            "macro_announcement_dvar_momentum",
            late_day.parameter_space["mechanism_overlay_ids"],
        )
        self.assertTrue(late_day.hard_vetoes["required_event_non_event_holdout_replay"])
        self.assertTrue(
            late_day.promotion_contract["rejects_pooled_macro_and_non_macro_replay"]
        )
        params = late_day.strategy_overrides["params"]
        self.assertEqual(params["entry_start_minute_utc"], "1080")
        self.assertEqual(params["entry_end_minute_utc"], "1170")
        self.assertIn("min_cross_section_continuation_breadth", params)

    def test_final_half_hour_reversal_hypothesis_gets_eod_runtime_profile(self) -> None:
        card = HypothesisCard(
            schema_version=HYPOTHESIS_CARD_SCHEMA_VERSION,
            hypothesis_id="hyp-eod-loser-reversal",
            source_run_id="paper-eod-loser-reversal",
            source_claim_ids=("claim-eod-loser-reversal",),
            mechanism=(
                "Individual-stock losers can reverse sharply in the final 30 minutes "
                "during a closing-window rebound."
            ),
            asset_scope="us_equities_intraday",
            horizon_scope="late_day_reversal",
            expected_direction="positive",
            required_features=(
                "closing_window",
                "intraday_return_rank",
                "quote_quality",
            ),
            entry_motifs=("end_of_day_reversal",),
            exit_motifs=("close_flatten",),
            risk_controls=("quote_quality", "stop_loss"),
            expected_regimes=("late_session_reversal",),
            failure_modes=("cost_stress",),
            implementation_constraints={"execution_profile_index": 0},
            confidence=Decimal("0.77"),
        )

        specs = compile_candidate_specs(
            hypothesis_cards=[card], target_net_pnl_per_day=Decimal("300")
        )
        eod = next(
            spec
            for spec in specs
            if spec.family_template_id == "end_of_day_reversal_v1"
        )

        self.assertEqual(eod.runtime_family, "end_of_day_reversal_consistent")
        self.assertEqual(eod.runtime_strategy_name, "end-of-day-reversal-long-v1")
        self.assertEqual(
            eod.feature_contract["execution_profile"]["profile_id"],
            "end_of_day_reversal_v1:profile-1",
        )
        params = eod.strategy_overrides["params"]
        self.assertEqual(params["entry_start_minute_utc"], "1150")
        self.assertEqual(params["entry_end_minute_utc"], "1188")
        self.assertIn("min_cross_section_reversal_rank", params)

    def test_missing_features_and_invalid_payloads_are_blocked(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-2",
            claims=[
                {
                    "claim_id": "claim-new-feature",
                    "claim_type": "signal_mechanism",
                    "claim_text": "A new exotic feature improves short-horizon execution.",
                    "required_features": ["feature_that_does_not_exist"],
                    "confidence": "0.82",
                }
            ],
        )

        compilation = compile_whitepaper_candidate_specs(
            hypothesis_cards=cards,
            target_net_pnl_per_day=Decimal("300"),
            family_template_dir=Path("config/trading/families"),
        )

        self.assertEqual(compilation.executable_specs, ())
        self.assertEqual(
            compilation.blockers[0].reason,
            "required_features_missing_from_family_template",
        )
        with self.assertRaisesRegex(ValueError, "candidate_spec_schema_invalid"):
            candidate_spec_from_payload({"schema_version": "invalid"})
