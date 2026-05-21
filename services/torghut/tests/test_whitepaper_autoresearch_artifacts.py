from __future__ import annotations

from decimal import Decimal
from typing import Any
from unittest import TestCase
from unittest.mock import patch

import app.trading.discovery.candidate_specs as candidate_specs_module
from app.trading.discovery.candidate_specs import (
    candidate_spec_from_payload,
    compile_candidate_specs,
)
from app.trading.discovery.evidence_bundles import (
    evidence_bundle_from_frontier_candidate,
    evidence_bundle_from_payload,
)
from app.trading.discovery.hypothesis_cards import (
    HYPOTHESIS_CARD_SCHEMA_VERSION,
    HypothesisCard,
    build_hypothesis_cards,
    hypothesis_card_from_payload,
)
from app.trading.discovery.mlx_training_data import (
    build_mlx_training_rows,
    mlx_ranker_model_from_payload,
    rank_training_rows,
    train_mlx_ranker,
)
from app.trading.discovery.portfolio_optimizer import optimize_portfolio_candidate


def _profile_ids_for_family(family_template_id: str) -> list[str]:
    return [
        f"{family_template_id}:profile-{index + 1}"
        for index in range(
            len(
                candidate_specs_module._execution_profiles_for_target(
                    family_template_id=family_template_id,
                    target_net_pnl_per_day=Decimal("500"),
                )
            )
        )
    ]


class TestWhitepaperAutoresearchArtifacts(TestCase):
    def test_hypothesis_and_candidate_specs_round_trip(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-2026",
            claims=[
                {
                    "claim_id": "claim-flow",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Clustered order flow imbalance improves intraday trading signals.",
                    "asset_scope": "us_equities_intraday",
                    "horizon_scope": "intraday",
                    "expected_direction": "positive",
                    "confidence": "0.82",
                }
            ],
        )

        self.assertEqual(len(cards), 1)
        reloaded_card = hypothesis_card_from_payload(cards[0].to_payload())
        self.assertEqual(reloaded_card.hypothesis_id, cards[0].hypothesis_id)
        self.assertIn("order_flow_imbalance", reloaded_card.required_features)

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        expected_family_profiles = {
            family_template_id: _profile_ids_for_family(family_template_id)
            for family_template_id in candidate_specs_module._FAMILY_EXECUTION_PROFILES
        }
        self.assertEqual(
            len(specs),
            sum(len(profiles) for profiles in expected_family_profiles.values()),
        )
        family_profiles: dict[str, list[str]] = {}
        for spec in specs:
            family_profiles.setdefault(spec.family_template_id, []).append(
                str(spec.feature_contract["execution_profile"]["profile_id"])
            )
        self.assertEqual(family_profiles, expected_family_profiles)
        self.assertIn(
            "microbar_cross_sectional_pairs_v1",
            {spec.family_template_id for spec in specs},
        )
        self.assertEqual(specs[0].objective["target_net_pnl_per_day"], "500")

        reloaded_spec = candidate_spec_from_payload(specs[0].to_payload())
        self.assertEqual(reloaded_spec.candidate_spec_id, specs[0].candidate_spec_id)
        self.assertEqual(
            reloaded_spec.to_vnext_experiment_payload()["family_template_id"],
            specs[0].family_template_id,
        )

    def test_evidence_training_rows_and_portfolio_optimizer(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-2026",
            claims=[
                {
                    "claim_id": "claim-flow",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Trade-flow order flow clustering creates a transferable intraday signal.",
                    "confidence": "0.82",
                },
                {
                    "claim_id": "claim-momentum",
                    "claim_type": "feature_recipe",
                    "claim_text": "Momentum pullback ranking improves continuation entries.",
                    "confidence": "0.76",
                },
            ],
        )
        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        bundles = [
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=f"{spec.candidate_spec_id}-{index}",
                candidate={
                    "candidate_id": f"cand-{index}",
                    "objective_scorecard": {
                        "net_pnl_per_day": str(625 - (index * 25)),
                        "active_day_ratio": "0.92",
                        "positive_day_ratio": "0.64",
                        "worst_day_loss": "150",
                        "max_drawdown": "400",
                        "best_day_share": "0.18",
                    },
                    "full_window": {
                        "daily_net": {
                            "2026-02-23": str(625 - (index * 25)),
                            "2026-02-24": str(625 - (index * 25)),
                        },
                        "daily_filled_notional": {
                            "2026-02-23": "350000",
                            "2026-02-24": "350000",
                        },
                    },
                },
                dataset_snapshot_id="snap-1",
                result_path=f"/tmp/result-{index}.json",
            )
            for index, spec in enumerate([specs[0], specs[0]], start=1)
        ]

        rows = build_mlx_training_rows(candidate_specs=specs, evidence_bundles=bundles)
        self.assertEqual(len(rows), len(specs))
        self.assertEqual(rows[0].feature_names[0], "family_code")

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=bundles,
            target_net_pnl_per_day=Decimal("500"),
            portfolio_size_min=2,
            portfolio_size_max=4,
        )

        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        self.assertTrue(portfolio.objective_scorecard["target_met"])
        self.assertEqual(len(portfolio.sleeves), 2)

    def test_mlx_ranker_learns_and_scores_training_rows(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-2026",
            claims=[
                {
                    "claim_id": "claim-flow",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Trade-flow order flow clustering creates a transferable intraday signal.",
                    "confidence": "0.82",
                }
            ],
        )
        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        high_spec = specs[0]
        low_spec = candidate_spec_from_payload(
            {
                **high_spec.to_payload(),
                "candidate_spec_id": f"{high_spec.candidate_spec_id}-low",
                "hypothesis_id": f"{high_spec.hypothesis_id}-low",
            }
        )
        bundles = [
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=high_spec.candidate_spec_id,
                candidate={
                    "candidate_id": "high",
                    "objective_scorecard": {
                        "net_pnl_per_day": "500",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "0.8",
                    },
                },
                dataset_snapshot_id="snap-1",
                result_path="/tmp/high.json",
            ),
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=low_spec.candidate_spec_id,
                candidate={
                    "candidate_id": "low",
                    "objective_scorecard": {
                        "net_pnl_per_day": "50",
                        "active_day_ratio": "0.5",
                        "positive_day_ratio": "0.4",
                    },
                },
                dataset_snapshot_id="snap-1",
                result_path="/tmp/low.json",
            ),
        ]

        rows = build_mlx_training_rows(
            candidate_specs=[high_spec, low_spec],
            evidence_bundles=bundles,
        )
        model = train_mlx_ranker(rows, backend_preference="numpy-fallback", steps=128)
        ranked = rank_training_rows(model=model, rows=rows)

        self.assertEqual(model.schema_version, "torghut.mlx-ranker.v1")
        self.assertEqual(model.backend, "numpy-fallback")
        self.assertEqual(model.row_count, 2)
        self.assertEqual(ranked[0].candidate_spec_id, high_spec.candidate_spec_id)
        self.assertGreater(ranked[0].score, ranked[1].score)

    def test_hypothesis_cards_cover_failure_and_threshold_edges(self) -> None:
        self.assertEqual(
            build_hypothesis_cards(source_run_id="empty", claims=[]),
            [],
        )
        self.assertEqual(
            build_hypothesis_cards(
                source_run_id="low-confidence",
                claims=[
                    {
                        "claim_id": "weak",
                        "claim_text": "Weak momentum signal.",
                        "confidence": "0.10",
                    }
                ],
                min_confidence=Decimal("0.50"),
            ),
            [],
        )

        cards = build_hypothesis_cards(
            source_run_id="edge-paper",
            claims=[
                {
                    "claim_id": "negative-reversal",
                    "claim_text": "A reversal washout can fail when liquidity vanishes.",
                    "expected_direction": "negative",
                    "expected_failure_modes": "liquidity_vanishes",
                    "expected_regimes": "stressed_open",
                    "confidence": "not-a-decimal",
                    "metadata": {"features": {"bad": "shape"}},
                }
            ],
            relations=[
                {
                    "relation_id": "rel-1",
                    "relation_type": "contradicts",
                }
            ],
            min_confidence=Decimal("0"),
        )

        self.assertEqual(len(cards), 1)
        self.assertIn("session_selloff_bps", cards[0].required_features)
        self.assertIn("rebound", cards[0].entry_motifs)
        self.assertIn("liquidity_vanishes", cards[0].failure_modes)
        self.assertIn("contradiction:rel-1", cards[0].failure_modes)
        with self.assertRaisesRegex(ValueError, "hypothesis_card_schema_invalid"):
            hypothesis_card_from_payload({"schema_version": "bad"})

    def test_candidate_specs_cover_family_selection_and_payload_edges(self) -> None:
        cards = [
            HypothesisCard(
                schema_version=HYPOTHESIS_CARD_SCHEMA_VERSION,
                hypothesis_id=f"hyp-{index}",
                source_run_id="paper",
                source_claim_ids=(f"claim-{index}",),
                mechanism=mechanism,
                asset_scope="us_equities_intraday",
                horizon_scope="intraday",
                expected_direction="positive",
                required_features=(),
                entry_motifs=(),
                exit_motifs=("time_exit",),
                risk_controls=("quote_quality",),
                expected_regimes=("regular_session",),
                failure_modes=("cost_stress",),
                implementation_constraints={},
                confidence=Decimal("0.8"),
            )
            for index, mechanism in enumerate(
                [
                    "matched-filter normalization signal",
                    "washout rebound signal",
                    "momentum trend pullback signal",
                    "breakout continuation signal",
                ],
                start=1,
            )
        ]

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        primary_family_by_hypothesis = {
            spec.hypothesis_id: spec.family_template_id
            for spec in specs
            if spec.feature_contract.get("family_selection", {}).get("rank") == 1
        }
        self.assertEqual(
            [primary_family_by_hypothesis[card.hypothesis_id] for card in cards],
            [
                "microstructure_continuation_matched_filter_v1",
                "washout_rebound_v2",
                "momentum_pullback_v1",
                "breakout_reclaim_v2",
            ],
        )
        payload = specs[0].to_payload()
        payload["feature_contract"] = "not-a-mapping"
        reloaded = candidate_spec_from_payload(payload)
        self.assertEqual(reloaded.feature_contract, {})
        with self.assertRaisesRegex(ValueError, "candidate_spec_schema_invalid"):
            candidate_spec_from_payload({"schema_version": "bad"})

    def test_evidence_bundle_covers_full_window_fallbacks(self) -> None:
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-fallback",
            candidate={
                "candidate_id": "",
                "runtime_family": "microbar_cross_sectional_pairs",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "family_template_id": "microbar_cross_sectional_pairs_v1",
                "full_window": {
                    "net_per_day": "123",
                    "active_day_ratio": "1.0",
                    "positive_day_ratio": "0.8",
                    "best_day_share": "0.2",
                    "max_drawdown": "0",
                    "trading_day_count": "1",
                    "avg_filled_notional_per_day": "350000",
                    "daily_net": {"2026-02-23": "123"},
                    "daily_filled_notional": {"2026-02-23": "350000"},
                    "daily_liquidity_notional": {"2026-02-23": "900000"},
                    "decision_count_by_order_type": {"market": 2, "limit": 3},
                    "filled_count_by_order_type": {"market": 2, "limit": 2},
                    "limit_fill_rate": "0.6667",
                    "implementation_uncertainty_required": True,
                    "implementation_uncertainty_model": "impact_latency_cost_model_interval",
                    "implementation_uncertainty_model_count": 5,
                    "implementation_uncertainty_stability_passed": False,
                    "implementation_uncertainty_lower_net_pnl_per_day": "88",
                    "implementation_uncertainty_upper_net_pnl_per_day": "120",
                    "implementation_uncertainty_interval_width_per_day": "32",
                    "implementation_uncertainty_scenarios": {
                        "latency_depth_fillability": "88"
                    },
                },
                "route_tca_artifact_ref": "/tmp/route-tca.json",
                "order_type_execution_artifact_ref": "/tmp/order-type-execution.json",
                "execution_shortfall_evidence_present": True,
            },
            dataset_snapshot_id="snap-fallback",
            result_path="/tmp/fallback.json",
        )

        self.assertEqual(bundle.candidate_id, "spec-fallback")
        self.assertEqual(bundle.objective_scorecard["net_pnl_per_day"], "123")
        self.assertIn("daily_filled_notional", bundle.objective_scorecard)
        self.assertTrue(
            bundle.objective_scorecard["nonlinear_market_impact_stress_missing"]
        )
        self.assertEqual(
            bundle.objective_scorecard["avg_liquidity_notional_per_day"],
            "900000",
        )
        self.assertFalse(bundle.objective_scorecard["market_impact_stress_passed"])
        self.assertEqual(
            bundle.objective_scorecard[
                "delay_adjusted_depth_fillable_notional_per_day"
            ],
            "350000",
        )
        self.assertEqual(
            bundle.objective_scorecard[
                "delay_adjusted_depth_worst_active_day_fillable_notional"
            ],
            "350000",
        )
        self.assertEqual(
            bundle.objective_scorecard[
                "delay_adjusted_depth_p10_active_day_fillable_notional"
            ],
            "350000",
        )
        self.assertTrue(
            bundle.objective_scorecard["delay_adjusted_depth_tail_coverage_passed"]
        )
        self.assertEqual(
            bundle.objective_scorecard["delay_adjusted_depth_stress_net_pnl_per_day"],
            "88",
        )
        self.assertTrue(
            bundle.objective_scorecard["delay_adjusted_depth_stress_passed"]
        )
        self.assertEqual(
            bundle.objective_scorecard["decision_count_by_order_type"],
            {"market": 2, "limit": 3},
        )
        self.assertEqual(bundle.objective_scorecard["limit_fill_rate"], "0.6667")
        self.assertEqual(
            bundle.objective_scorecard["market_limit_order_mix_sample_count"],
            5,
        )
        self.assertTrue(
            bundle.objective_scorecard["implementation_uncertainty_required"]
        )
        self.assertEqual(
            bundle.objective_scorecard["implementation_uncertainty_model_count"],
            5,
        )
        self.assertIn(
            "latency_depth_fillability",
            bundle.objective_scorecard["implementation_uncertainty_scenarios"],
        )
        self.assertTrue(
            bundle.objective_scorecard["market_limit_order_mix_evidence_present"]
        )
        self.assertEqual(
            bundle.objective_scorecard["limit_fill_probability_sample_count"],
            3,
        )
        self.assertTrue(
            bundle.objective_scorecard["limit_fill_probability_evidence_present"]
        )
        self.assertEqual(
            bundle.objective_scorecard["route_tca_artifact_ref"],
            "/tmp/route-tca.json",
        )
        self.assertEqual(
            bundle.objective_scorecard["order_type_execution_artifact_ref"],
            "/tmp/order-type-execution.json",
        )
        self.assertTrue(
            bundle.objective_scorecard["execution_shortfall_evidence_present"]
        )
        self.assertEqual(len(bundle.stress_metrics), 3)
        self.assertEqual(
            bundle.stress_metrics[2]["stress_type"], "implementation_uncertainty"
        )
        with self.assertRaisesRegex(ValueError, "evidence_bundle_schema_invalid"):
            evidence_bundle_from_payload({"schema_version": "bad"})

    def test_evidence_bundle_marks_order_type_execution_artifact_without_ablation(
        self,
    ) -> None:
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-order-type-execution",
            candidate={
                "candidate_id": "cand-order-type-execution",
                "runtime_family": "microbar_cross_sectional_pairs",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "family_template_id": "microbar_cross_sectional_pairs_v1",
                "full_window": {
                    "net_per_day": "123",
                    "trading_day_count": "1",
                    "avg_filled_notional_per_day": "350000",
                    "daily_net": {"2026-02-23": "123"},
                    "daily_filled_notional": {"2026-02-23": "350000"},
                    "daily_liquidity_notional": {"2026-02-23": "900000"},
                    "decision_count_by_order_type": {"market": 2, "limit": 3},
                    "filled_count_by_order_type": {"market": 2, "limit": 2},
                    "limit_fill_rate": "0.6667",
                },
            },
            dataset_snapshot_id="snap-order-type-execution",
            result_path="/tmp/order-type-execution-replay.json",
        )

        self.assertEqual(
            bundle.objective_scorecard["order_type_execution_artifact_ref"],
            "/tmp/order-type-execution-replay.json",
        )
        self.assertEqual(
            bundle.objective_scorecard["market_limit_order_mix_artifact_ref"],
            "/tmp/order-type-execution-replay.json",
        )
        self.assertNotIn("order_type_ablation_artifact_ref", bundle.objective_scorecard)
        self.assertNotIn("order_type_ablation_passed", bundle.objective_scorecard)

    def test_evidence_bundle_preserves_replay_lineage_and_window_coverage(
        self,
    ) -> None:
        replay_lineage = {
            "schema_version": "torghut.frontier-replay-lineage.v1",
            "lineage_hash": "lineage-hash",
            "expected_windows": ["train", "holdout", "full_window"],
            "present_windows": ["train", "holdout", "full_window"],
            "missing_windows": [],
        }
        replay_window_coverage = {
            "schema_version": "torghut.replay-window-coverage.v1",
            "lineage_hash": "lineage-hash",
            "expected_windows": ["train", "holdout", "full_window"],
            "present_windows": ["train", "holdout", "full_window"],
            "missing_windows": [],
            "window_count": 3,
        }

        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-replay-lineage",
            candidate={
                "candidate_id": "cand-replay-lineage",
                "runtime_family": "microbar_cross_sectional_pairs",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "family_template_id": "microbar_cross_sectional_pairs_v1",
                "replay_lineage": replay_lineage,
                "objective_scorecard": {
                    "net_pnl_per_day": "640",
                    "replay_window_coverage": replay_window_coverage,
                },
                "full_window": {
                    "net_per_day": "640",
                    "trading_day_count": "1",
                    "daily_net": {"2026-02-23": "640"},
                },
            },
            dataset_snapshot_id="snap-replay-lineage",
            result_path="/tmp/replay-lineage.json",
        )

        self.assertEqual(bundle.objective_scorecard["replay_lineage"], replay_lineage)
        self.assertEqual(
            bundle.objective_scorecard["replay_window_coverage"],
            replay_window_coverage,
        )

    def test_evidence_bundle_preserves_nested_order_type_ablation_artifact(
        self,
    ) -> None:
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-order-type-ablation",
            candidate={
                "candidate_id": "cand-order-type-ablation",
                "runtime_family": "microbar_cross_sectional_pairs",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "family_template_id": "microbar_cross_sectional_pairs_v1",
                "full_window": {
                    "net_per_day": "123",
                    "trading_day_count": "1",
                    "avg_filled_notional_per_day": "350000",
                    "daily_net": {"2026-02-23": "123"},
                    "daily_filled_notional": {"2026-02-23": "350000"},
                    "daily_liquidity_notional": {"2026-02-23": "900000"},
                    "decision_count_by_order_type": {"market": 2, "limit": 3},
                    "filled_count_by_order_type": {"market": 2, "limit": 2},
                    "limit_fill_rate": "0.6667",
                },
                "order_type_ablation": {
                    "artifact_ref": "/tmp/order-type-ablation.json",
                    "passed": True,
                    "sample_count": 60,
                    "selected_order_type": "limit",
                    "opportunity_cost_bps": "4.5",
                    "limit_sample_count": 30,
                },
            },
            dataset_snapshot_id="snap-order-type-ablation",
            result_path="/tmp/order-type-ablation-replay.json",
        )

        self.assertEqual(
            bundle.objective_scorecard["order_type_ablation_artifact_ref"],
            "/tmp/order-type-ablation.json",
        )
        self.assertTrue(bundle.objective_scorecard["order_type_ablation_passed"])
        self.assertEqual(
            bundle.objective_scorecard["order_type_ablation_sample_count"], 60
        )
        self.assertEqual(
            bundle.objective_scorecard["order_type_ablation_selected_order_type"],
            "limit",
        )
        self.assertEqual(
            bundle.objective_scorecard["order_type_opportunity_cost_bps"],
            "4.5",
        )
        self.assertTrue(
            bundle.objective_scorecard["order_type_opportunity_cost_evidence_present"]
        )
        self.assertEqual(
            bundle.objective_scorecard["limit_fill_probability_sample_count"],
            30,
        )
        self.assertEqual(
            bundle.replay_artifact_refs,
            (
                "/tmp/order-type-ablation-replay.json",
                "/tmp/order-type-ablation.json",
            ),
        )
        self.assertNotIn("route_tca_artifact_ref", bundle.objective_scorecard)
        self.assertNotIn(
            "price_improvement_evidence_present", bundle.objective_scorecard
        )
        self.assertNotIn(
            "execution_shortfall_evidence_present", bundle.objective_scorecard
        )

    def test_evidence_bundle_fails_delay_depth_without_recorded_daily_liquidity(
        self,
    ) -> None:
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-missing-depth",
            candidate={
                "candidate_id": "cand-missing-depth",
                "runtime_family": "microbar_cross_sectional_pairs",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "family_template_id": "microbar_cross_sectional_pairs_v1",
                "full_window": {
                    "net_per_day": "700",
                    "trading_day_count": "1",
                    "avg_filled_notional_per_day": "350000",
                    "daily_net": {"2026-02-23": "700"},
                    "daily_filled_notional": {"2026-02-23": "350000"},
                },
            },
            dataset_snapshot_id="snap-missing-depth",
            result_path="/tmp/missing-depth.json",
        )

        self.assertFalse(
            bundle.objective_scorecard[
                "delay_adjusted_depth_liquidity_evidence_present"
            ]
        )
        self.assertEqual(
            bundle.objective_scorecard[
                "delay_adjusted_depth_liquidity_missing_day_count"
            ],
            1,
        )
        self.assertEqual(
            bundle.objective_scorecard[
                "delay_adjusted_depth_fillable_notional_per_day"
            ],
            "0",
        )
        self.assertEqual(
            bundle.objective_scorecard[
                "delay_adjusted_depth_worst_active_day_fillable_notional"
            ],
            "0",
        )
        self.assertEqual(
            bundle.objective_scorecard[
                "delay_adjusted_depth_p10_active_day_fillable_notional"
            ],
            "0",
        )
        self.assertFalse(
            bundle.objective_scorecard["delay_adjusted_depth_tail_coverage_passed"]
        )
        self.assertFalse(
            bundle.objective_scorecard["delay_adjusted_depth_stress_passed"]
        )

    def test_evidence_bundle_uses_per_day_depth_not_average_liquidity(self) -> None:
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-thin-depth",
            candidate={
                "candidate_id": "cand-thin-depth",
                "runtime_family": "microbar_cross_sectional_pairs",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "family_template_id": "microbar_cross_sectional_pairs_v1",
                "full_window": {
                    "net_per_day": "800",
                    "trading_day_count": "2",
                    "avg_filled_notional_per_day": "400000",
                    "daily_net": {
                        "2026-02-23": "800",
                        "2026-02-24": "800",
                    },
                    "daily_filled_notional": {
                        "2026-02-23": "400000",
                        "2026-02-24": "400000",
                    },
                    "daily_liquidity_notional": {
                        "2026-02-23": "1000000",
                        "2026-02-24": "200000",
                    },
                },
            },
            dataset_snapshot_id="snap-thin-depth",
            result_path="/tmp/thin-depth.json",
        )

        self.assertTrue(
            bundle.objective_scorecard[
                "delay_adjusted_depth_liquidity_evidence_present"
            ]
        )
        self.assertEqual(
            bundle.objective_scorecard[
                "delay_adjusted_depth_liquidity_missing_day_count"
            ],
            0,
        )
        self.assertEqual(
            bundle.objective_scorecard[
                "delay_adjusted_depth_fillable_notional_per_day"
            ],
            "295000.00",
        )
        self.assertEqual(
            bundle.objective_scorecard[
                "delay_adjusted_depth_worst_grid_fillable_notional_per_day"
            ],
            "275000.00",
        )
        self.assertEqual(
            bundle.objective_scorecard[
                "delay_adjusted_depth_worst_active_day_fillable_notional"
            ],
            "150000.00",
        )
        self.assertEqual(
            bundle.objective_scorecard[
                "delay_adjusted_depth_p10_active_day_fillable_notional"
            ],
            "150000.00",
        )
        self.assertTrue(
            bundle.objective_scorecard["delay_adjusted_depth_tail_coverage_passed"]
        )
        self.assertEqual(
            bundle.objective_scorecard["delay_adjusted_depth_fillable_ratio"],
            "0.7375",
        )
        self.assertEqual(
            bundle.objective_scorecard[
                "delay_adjusted_depth_unfillable_notional_per_day"
            ],
            "105000.00",
        )
        self.assertEqual(
            Decimal(
                bundle.objective_scorecard[
                    "delay_adjusted_depth_stress_net_pnl_per_day"
                ]
            ),
            Decimal("560.5"),
        )

    def test_mlx_ranker_covers_fallback_and_error_edges(self) -> None:
        rows = [
            build_mlx_training_rows(
                candidate_specs=[
                    compile_candidate_specs(
                        hypothesis_cards=build_hypothesis_cards(
                            source_run_id="paper",
                            claims=[
                                {
                                    "claim_id": "claim-flow",
                                    "claim_type": "signal_mechanism",
                                    "claim_text": "Order flow cluster signal.",
                                    "confidence": "0.8",
                                }
                            ],
                        ),
                        target_net_pnl_per_day=Decimal("500"),
                    )[0]
                ],
                evidence_bundles=[],
            )[0]
        ]

        import builtins

        real_import = builtins.__import__

        def fake_import(name: str, *args: Any, **kwargs: Any) -> Any:
            if name == "mlx.core":
                raise ModuleNotFoundError("mlx unavailable in test")
            return real_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=fake_import):
            model = train_mlx_ranker(rows, backend_preference="mlx", steps=2)

        self.assertEqual(model.backend, "numpy-fallback")
        self.assertEqual(
            mlx_ranker_model_from_payload(model.to_payload()).model_id,
            model.model_id,
        )
        with self.assertRaisesRegex(ValueError, "mlx_ranker_training_rows_required"):
            train_mlx_ranker([])
        with self.assertRaisesRegex(ValueError, "mlx_ranker_schema_invalid"):
            mlx_ranker_model_from_payload({"schema_version": "bad"})

    def test_portfolio_optimizer_uses_daily_vectors_and_correlation_cap(self) -> None:
        bundles = [
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id="spec-a",
                candidate={
                    "candidate_id": "cand-a",
                    "objective_scorecard": {
                        "net_pnl_per_day": "900",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "1.0",
                        "worst_day_loss": "0",
                        "max_drawdown": "0",
                        "best_day_share": "0.34",
                    },
                    "full_window": {
                        "daily_net": {
                            "2026-02-23": "600",
                            "2026-02-24": "1200",
                            "2026-02-25": "900",
                        }
                    },
                },
                dataset_snapshot_id="snap-1",
                result_path="/tmp/a.json",
            ),
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id="spec-b",
                candidate={
                    "candidate_id": "cand-b",
                    "objective_scorecard": {
                        "net_pnl_per_day": "810",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "1.0",
                        "worst_day_loss": "0",
                        "max_drawdown": "0",
                        "best_day_share": "0.34",
                    },
                    "full_window": {
                        "daily_net": {
                            "2026-02-23": "300",
                            "2026-02-24": "1050",
                            "2026-02-25": "1080",
                        }
                    },
                },
                dataset_snapshot_id="snap-1",
                result_path="/tmp/b.json",
            ),
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id="spec-c",
                candidate={
                    "candidate_id": "cand-c",
                    "objective_scorecard": {
                        "net_pnl_per_day": "780",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "1.0",
                        "worst_day_loss": "0",
                        "max_drawdown": "0",
                        "best_day_share": "0.34",
                    },
                    "full_window": {
                        "daily_net": {
                            "2026-02-23": "540",
                            "2026-02-24": "1080",
                            "2026-02-25": "720",
                        }
                    },
                },
                dataset_snapshot_id="snap-1",
                result_path="/tmp/c.json",
            ),
        ]

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=bundles,
            target_net_pnl_per_day=Decimal("700"),
            portfolio_size_min=2,
            portfolio_size_max=3,
        )

        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        self.assertEqual(portfolio.source_candidate_ids, ("cand-a", "cand-b"))
        self.assertEqual(portfolio.objective_scorecard["net_pnl_per_day"], "855.0")
        self.assertEqual(portfolio.objective_scorecard["worst_day_loss"], "0")
        self.assertEqual(
            portfolio.objective_scorecard["daily_net"],
            {
                "2026-02-23": "450.0",
                "2026-02-24": "1125.0",
                "2026-02-25": "990.0",
            },
        )
        rejection_reasons = [
            item["reason"] for item in portfolio.optimizer_report["rejections"]
        ]
        self.assertIn("correlation_cap", rejection_reasons)
