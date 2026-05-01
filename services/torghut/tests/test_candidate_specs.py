from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from unittest import TestCase

from app.trading.discovery.candidate_specs import (
    candidate_spec_from_payload,
    compile_candidate_specs,
)
from app.trading.discovery.hypothesis_cards import (
    HYPOTHESIS_CARD_SCHEMA_VERSION,
    HypothesisCard,
    build_hypothesis_cards,
)
from app.trading.discovery.whitepaper_candidate_compiler import (
    compile_whitepaper_candidate_specs,
)


class TestCandidateSpecs(TestCase):
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
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        second = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        self.assertEqual(first[0].candidate_spec_id, second[0].candidate_spec_id)
        self.assertEqual(first[0].objective["target_net_pnl_per_day"], "500")
        self.assertIn("required_max_drawdown", first[0].hard_vetoes)
        self.assertIn("params", first[0].strategy_overrides)
        self.assertIn("execution_profile", first[0].feature_contract)
        self.assertIn("execution_profile_id", first[0].parameter_space)
        if first[0].family_template_id == "microbar_cross_sectional_pairs_v1":
            params = first[0].strategy_overrides["params"]
            self.assertIn("long_stop_loss_bps", params)
            self.assertIn("long_trailing_stop_drawdown_bps", params)
            self.assertIn("max_session_negative_exit_bps", params)
        self.assertNotIn("live_runtime_config_path", first[0].to_payload())
        reloaded = candidate_spec_from_payload(first[0].to_payload())
        self.assertEqual(reloaded.candidate_spec_id, first[0].candidate_spec_id)

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
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
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
            continuation_specs[1]
            .to_vnext_experiment_payload()["template_overrides"]["params"][
                "leader_reclaim_start_minutes_since_open"
            ],
            "45",
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
            hypothesis_cards=[card], target_net_pnl_per_day=Decimal("500")
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
        self.assertEqual(late_day.runtime_strategy_name, "late-day-continuation-long-v1")
        self.assertEqual(late_day.objective["target_net_pnl_per_day"], "300")
        self.assertEqual(
            late_day.feature_contract["execution_profile"]["profile_id"],
            "late_day_continuation_v1:profile-1",
        )
        params = late_day.strategy_overrides["params"]
        self.assertEqual(params["entry_start_minute_utc"], "1080")
        self.assertEqual(params["entry_end_minute_utc"], "1170")
        self.assertIn("min_cross_section_continuation_breadth", params)

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
            target_net_pnl_per_day=Decimal("500"),
            family_template_dir=Path("config/trading/families"),
        )

        self.assertEqual(compilation.executable_specs, ())
        self.assertEqual(
            compilation.blockers[0].reason,
            "required_features_missing_from_family_template",
        )
        with self.assertRaisesRegex(ValueError, "candidate_spec_schema_invalid"):
            candidate_spec_from_payload({"schema_version": "invalid"})
