from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from unittest import TestCase

from app.strategies.catalog import StrategyCatalogConfig
import app.trading.discovery.candidate_specs as candidate_specs_module
from app.trading.discovery.candidate_specs import (
    candidate_spec_from_payload,
    compile_candidate_specs,
)
from app.trading.discovery.hypothesis_cards import (
    HYPOTHESIS_CARD_SCHEMA_VERSION,
    HypothesisCard,
    build_hypothesis_cards,
)
from app.trading.discovery.mlx_training_data import candidate_spec_capital_features
from app.trading.discovery.whitepaper_candidate_compiler import (
    compile_whitepaper_candidate_specs,
)
from app.trading.semiconductor_universe import RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE


_CHIP_UNIVERSE_SYMBOLS = set(RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE)


def _capital_profile(spec: candidate_specs_module.CandidateSpec) -> object:
    params = spec.strategy_overrides.get("params")
    return params.get("capital_profile") if isinstance(params, dict) else None


class TestCandidateSpecs(TestCase):
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

    def test_feedback_escape_profiles_dedupe_and_fallback_invalid_params(self) -> None:
        profile = {
            "params": {
                "entry_minute_after_open": "not-a-decimal",
                "exit_minute_after_open": "invalid",
                "top_n": "2",
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
            ],
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
