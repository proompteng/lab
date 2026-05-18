from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

import app.trading.discovery.candidate_specs as candidate_specs_module
from app.trading.discovery.hypothesis_cards import build_hypothesis_cards
from app.trading.discovery.whitepaper_candidate_compiler import (
    compile_claim_payloads_to_whitepaper_experiments,
    compile_whitepaper_candidate_specs,
)


_PORTFOLIO_TARGET_FAMILIES = set(candidate_specs_module._FAMILY_EXECUTION_PROFILES)


def _profile_count_for_family(
    family_template_id: str,
    *,
    target_net_pnl_per_day: Decimal = Decimal("300"),
) -> int:
    return len(
        candidate_specs_module._execution_profiles_for_target(
            family_template_id=family_template_id,
            target_net_pnl_per_day=target_net_pnl_per_day,
        )
    )


def _expected_candidate_count(
    family_ids: set[str],
    *,
    target_net_pnl_per_day: Decimal = Decimal("300"),
) -> int:
    return sum(
        _profile_count_for_family(
            family_id,
            target_net_pnl_per_day=target_net_pnl_per_day,
        )
        for family_id in family_ids
    )


def _expected_portfolio_target_candidate_count() -> int:
    return _expected_candidate_count(
        _PORTFOLIO_TARGET_FAMILIES,
        target_net_pnl_per_day=Decimal("500"),
    )


class TestWhitepaperCandidateCompiler(TestCase):
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

    def test_missing_family_template_blocks_execution(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-run-2",
            claims=[
                {
                    "claim_id": "claim-flow",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Clustered order flow imbalance improves short-horizon LOB signals.",
                    "confidence": "0.82",
                }
            ],
        )

        compilation = compile_whitepaper_candidate_specs(
            hypothesis_cards=cards,
            target_net_pnl_per_day=Decimal("500"),
            family_template_dir=Path("/tmp/does-not-exist-torghut-families"),
        )

        self.assertEqual(len(compilation.executable_specs), 0)
        self.assertEqual(
            len(compilation.blocked_specs), _expected_portfolio_target_candidate_count()
        )
        self.assertEqual(compilation.blockers[0].reason, "family_template_missing")

    def test_late_day_continuation_family_is_executable_from_fresh_momentum_claim(
        self,
    ) -> None:
        compilation = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-run-late-day",
            claims=[
                {
                    "claim_id": "claim-late-momentum",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Macro announcement information strengthens late-day intraday momentum "
                        "into the close with VWAP exit confirmation."
                    ),
                    "required_features": [
                        "macro_announcement_window",
                        "weighted_microprice_momentum",
                        "spread_bps",
                    ],
                    "confidence": "0.74",
                },
                {
                    "claim_id": "claim-late-validation",
                    "claim_type": "validation_requirement",
                    "claim_text": "The sleeve must pass non-announcement held-out days and transaction-cost stress.",
                    "required_features": ["transaction_cost_stress"],
                    "confidence": "0.72",
                },
            ],
            target_net_pnl_per_day=Decimal("300"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )

        late_day_specs = [
            spec
            for spec in compilation.executable_specs
            if spec.family_template_id == "late_day_continuation_v1"
        ]
        self.assertEqual(len(late_day_specs), 3)
        self.assertEqual(
            {
                spec.feature_contract["execution_profile"]["profile_id"]
                for spec in late_day_specs
            },
            {
                "late_day_continuation_v1:profile-1",
                "late_day_continuation_v1:profile-2",
                "late_day_continuation_v1:profile-3",
            },
        )
        self.assertTrue(
            all(
                spec.runtime_strategy_name == "late-day-continuation-long-v1"
                for spec in late_day_specs
            )
        )
        self.assertTrue(
            all(
                spec.objective["target_net_pnl_per_day"] == "300"
                for spec in late_day_specs
            )
        )

    def test_end_of_day_reversal_family_is_executable_from_loser_reversal_claim(
        self,
    ) -> None:
        compilation = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-run-eod-reversal",
            claims=[
                {
                    "claim_id": "claim-eod-reversal",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Individual-stock losers can reverse in the final 30 minutes "
                        "with closing-window rebid confirmation."
                    ),
                    "required_features": [
                        "closing_window",
                        "intraday_return_rank",
                        "quote_quality",
                    ],
                    "confidence": "0.77",
                },
                {
                    "claim_id": "claim-eod-validation",
                    "claim_type": "validation_requirement",
                    "claim_text": "The reversal sleeve must pass held-out transaction-cost stress.",
                    "required_features": ["transaction_cost_stress"],
                    "confidence": "0.72",
                },
            ],
            target_net_pnl_per_day=Decimal("300"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )

        eod_specs = [
            spec
            for spec in compilation.executable_specs
            if spec.family_template_id == "end_of_day_reversal_v1"
        ]
        self.assertEqual(len(eod_specs), 2)
        self.assertEqual(
            {
                spec.feature_contract["execution_profile"]["profile_id"]
                for spec in eod_specs
            },
            {
                "end_of_day_reversal_v1:profile-1",
                "end_of_day_reversal_v1:profile-2",
            },
        )
        self.assertTrue(
            all(
                spec.runtime_strategy_name == "end-of-day-reversal-long-v1"
                for spec in eod_specs
            )
        )
        self.assertTrue(
            all(spec.objective["target_net_pnl_per_day"] == "300" for spec in eod_specs)
        )

    def test_short_exhaustion_family_is_executable_from_fade_claim(self) -> None:
        compilation = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-run-short-exhaustion",
            claims=[
                {
                    "claim_id": "claim-short-exhaustion",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Short-side upside exhaustion fade with offer pressure can "
                        "profit from overbought intraday weakness."
                    ),
                    "required_features": [
                        "session_open_extension",
                        "offer_pressure",
                        "quote_quality",
                    ],
                    "confidence": "0.79",
                }
            ],
            target_net_pnl_per_day=Decimal("300"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )

        short_specs = [
            spec
            for spec in compilation.executable_specs
            if spec.family_template_id == "mean_reversion_exhaustion_short_v1"
        ]
        self.assertEqual(len(short_specs), 3)
        self.assertFalse(
            [
                blocker
                for blocker in compilation.blockers
                if blocker.reason == "required_features_missing_from_family_template"
            ]
        )
        self.assertTrue(
            all(
                spec.runtime_strategy_name == "mean-reversion-exhaustion-short-v1"
                for spec in short_specs
            )
        )

    def test_momentum_and_reversal_families_cover_inferred_feature_contracts(
        self,
    ) -> None:
        momentum = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-run-momentum-contract",
            claims=[
                {
                    "claim_id": "claim-momentum-contract",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Fresh intraday momentum and trend persistence in chip stocks "
                        "support pullback continuation entries."
                    ),
                    "confidence": "0.76",
                }
            ],
            target_net_pnl_per_day=Decimal("300"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )
        momentum_family_ids = {
            spec.family_template_id for spec in momentum.executable_specs
        }

        self.assertTrue(
            {
                "momentum_pullback_v1",
                "intraday_tsmom_v2",
            }.issubset(momentum_family_ids)
        )
        self.assertFalse(
            [
                blocker
                for blocker in momentum.blockers
                if blocker.reason == "required_features_missing_from_family_template"
            ]
        )

        reversal = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-run-reversal-contract",
            claims=[
                {
                    "claim_id": "claim-reversal-contract",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Intraday washout reversal and mean reversion in liquid chip "
                        "stocks support controlled rebound entries."
                    ),
                    "confidence": "0.76",
                }
            ],
            target_net_pnl_per_day=Decimal("300"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )
        reversal_family_ids = {
            spec.family_template_id for spec in reversal.executable_specs
        }

        self.assertTrue(
            {
                "washout_rebound_v2",
                "mean_reversion_rebound_v1",
            }.issubset(reversal_family_ids)
        )
        self.assertFalse(
            [
                blocker
                for blocker in reversal.blockers
                if blocker.reason == "required_features_missing_from_family_template"
            ]
        )

    def test_missing_seed_sweep_blocks_execution(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-run-3",
            claims=[
                {
                    "claim_id": "claim-flow",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Clustered order flow imbalance improves short-horizon LOB signals.",
                    "confidence": "0.82",
                }
            ],
        )

        with TemporaryDirectory() as tmpdir:
            compilation = compile_whitepaper_candidate_specs(
                hypothesis_cards=cards,
                target_net_pnl_per_day=Decimal("500"),
                family_template_dir=Path("config/trading/families"),
                seed_sweep_dir=Path(tmpdir),
            )

        self.assertEqual(compilation.executable_specs, ())
        self.assertEqual(
            len(compilation.blocked_specs), _expected_portfolio_target_candidate_count()
        )
        self.assertEqual(compilation.blockers[0].reason, "seed_sweep_missing")

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
