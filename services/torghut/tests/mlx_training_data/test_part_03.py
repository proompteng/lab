from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.mlx_training_data.support import *


class TestMlxTrainingDataPart3(_TestMlxTrainingDataBase):
    def test_training_rows_penalize_missing_execution_proof_feedback(self) -> None:
        base_kwargs = {
            "schema_version": "torghut.candidate-spec.v1",
            "hypothesis_id": "H-PROOF",
            "family_template_id": "microstructure_continuation_matched_filter_v1",
            "candidate_kind": "configuration",
            "runtime_family": "intraday_tsmom_consistent",
            "runtime_strategy_name": "intraday-tsmom-profit-v3",
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
        missing_proof = CandidateSpec(
            candidate_spec_id="spec-missing-proof", **base_kwargs
        )
        passing_proof = CandidateSpec(
            candidate_spec_id="spec-passing-proof",
            **{**base_kwargs, "hypothesis_id": "H-PROOF-PASSING"},
        )
        shared_scorecard = {
            "net_pnl_per_day": "520",
            "active_day_ratio": "1",
            "positive_day_ratio": "1",
            "negative_day_count": 0,
            "best_day_share": "0.20",
            "worst_day_loss": "0",
            "max_drawdown": "40",
            "avg_filled_notional_per_day": "350000",
            "hard_vetoes": [],
        }
        bundles = [
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=missing_proof.candidate_spec_id,
                candidate={
                    "candidate_id": "cand-missing-proof",
                    "objective_scorecard": {
                        **shared_scorecard,
                        "market_impact_stress_passed": False,
                        "market_impact_liquidity_evidence_present": False,
                        "market_impact_stress_net_pnl_per_day": "200",
                        "delay_adjusted_depth_stress_passed": False,
                        "delay_adjusted_depth_stress_net_pnl_per_day": "150",
                        "delay_adjusted_depth_fillable_notional_per_day": "0",
                        "double_oos_passed": False,
                        "double_oos_independent_window_count": 0,
                        "double_oos_pass_rate": "0",
                        "double_oos_net_pnl_per_day": "100",
                        "double_oos_cost_shock_net_pnl_per_day": "50",
                        "implementation_uncertainty_stability_passed": False,
                        "implementation_uncertainty_lower_net_pnl_per_day": "25",
                    },
                },
                dataset_snapshot_id="snapshot-missing-proof",
                result_path="/tmp/cand-missing-proof.json",
            ),
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=passing_proof.candidate_spec_id,
                candidate={
                    "candidate_id": "cand-passing-proof",
                    "objective_scorecard": {
                        **shared_scorecard,
                        "market_impact_stress_passed": True,
                        "market_impact_stress_artifact_ref": "/tmp/market-impact.json",
                        "market_impact_stress_model": "almgren_chriss_proxy",
                        "market_impact_stress_cost_bps": "6",
                        "market_impact_stress_components": {
                            "source_marker": "realistic_market_impact_arxiv_2603_29086_2026",
                            "selected_model": "almgren_chriss_proxy",
                            "selected_cost_bps": "6",
                        },
                        "nonlinear_market_impact_stress_passed": True,
                        "nonlinear_market_impact_stress_model": "almgren_chriss_proxy",
                        "nonlinear_market_impact_stress_cost_bps": "6",
                        "nonlinear_market_impact_stress_net_pnl_per_day": "515",
                        "market_impact_liquidity_evidence_present": True,
                        "market_impact_stress_net_pnl_per_day": "515",
                        "delay_adjusted_depth_stress_passed": True,
                        "delay_adjusted_depth_stress_artifact_ref": "/tmp/depth.json",
                        "delay_adjusted_depth_stress_ms": "250",
                        "delay_adjusted_depth_fillable_notional_per_day": "525000",
                        "delay_adjusted_depth_stress_net_pnl_per_day": "510",
                        "double_oos_passed": True,
                        "double_oos_artifact_ref": "/tmp/double-oos.json",
                        "double_oos_independent_window_count": 2,
                        "double_oos_pass_rate": "1",
                        "double_oos_net_pnl_per_day": "515",
                        "double_oos_cost_shock_net_pnl_per_day": "505",
                        "implementation_uncertainty_stability_passed": True,
                        "implementation_uncertainty_lower_net_pnl_per_day": "502",
                    },
                },
                dataset_snapshot_id="snapshot-passing-proof",
                result_path="/tmp/cand-passing-proof.json",
            ),
        ]

        rows = build_mlx_training_rows(
            candidate_specs=[missing_proof, passing_proof],
            evidence_bundles=bundles,
        )
        row_by_spec = {row.candidate_spec_id: row for row in rows}
        missing_payload = row_by_spec[missing_proof.candidate_spec_id].to_payload()
        passing_payload = row_by_spec[passing_proof.candidate_spec_id].to_payload()

        self.assertEqual(
            missing_payload["features"]["history_market_impact_stress_passed"],
            0.0,
        )
        self.assertEqual(
            passing_payload["features"]["history_market_impact_stress_passed"],
            1.0,
        )
        self.assertGreater(
            missing_payload["features"]["history_double_oos_target_shortfall"],
            passing_payload["features"]["history_double_oos_target_shortfall"],
        )
        self.assertLess(
            row_by_spec[missing_proof.candidate_spec_id].target,
            row_by_spec[passing_proof.candidate_spec_id].target - 2000.0,
        )

    def test_training_target_prefers_deployable_lower_bound_over_optimistic_net(
        self,
    ) -> None:
        base_kwargs = {
            "schema_version": "torghut.candidate-spec.v1",
            "hypothesis_id": "H-LOWER-BOUND",
            "family_template_id": "intraday_tsmom_v2",
            "candidate_kind": "configuration",
            "runtime_family": "intraday_tsmom_consistent",
            "runtime_strategy_name": "intraday-tsmom-profit-v3",
            "feature_contract": {},
            "parameter_space": {},
            "strategy_overrides": {
                "max_notional_per_trade": "25000",
                "max_position_pct_equity": "0.25",
                "params": {
                    "capital_profile": "feedback_daily_coverage_cash_constrained_1x",
                    "max_entries_per_session": "12",
                    "max_gross_exposure_pct_equity": "1.0",
                    "top_n": "1",
                },
            },
            "objective": {"target_net_pnl_per_day": "500"},
            "hard_vetoes": {"required_min_daily_notional": "250000"},
            "expected_failure_modes": (),
            "promotion_contract": {},
        }
        optimistic = CandidateSpec(
            candidate_spec_id="spec-optimistic-high-net",
            **base_kwargs,
        )
        raw_only = CandidateSpec(
            candidate_spec_id="spec-raw-only-high-net",
            **{**base_kwargs, "hypothesis_id": "H-LOWER-BOUND-RAW-ONLY"},
        )
        robust = CandidateSpec(
            candidate_spec_id="spec-robust-lower-bound",
            **{**base_kwargs, "hypothesis_id": "H-LOWER-BOUND-ROBUST"},
        )
        shared_scorecard = {
            "active_day_ratio": "1",
            "positive_day_ratio": "1",
            "negative_day_count": 0,
            "best_day_share": "0.10",
            "worst_day_loss": "0",
            "max_drawdown": "25",
            "avg_filled_notional_per_day": "300000",
            "hard_vetoes": [],
            "market_impact_stress_passed": True,
            "market_impact_stress_artifact_ref": "/tmp/impact.json",
            "market_impact_liquidity_evidence_present": True,
            "delay_adjusted_depth_stress_passed": True,
            "delay_adjusted_depth_stress_artifact_ref": "/tmp/depth.json",
            "delay_adjusted_depth_fillable_notional_per_day": "300000",
            "double_oos_passed": True,
            "double_oos_artifact_ref": "/tmp/oos.json",
            "double_oos_independent_window_count": 2,
            "double_oos_pass_rate": "1",
            "implementation_uncertainty_stability_passed": True,
        }
        bundles = [
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=optimistic.candidate_spec_id,
                candidate={
                    "candidate_id": "cand-optimistic",
                    "objective_scorecard": {
                        **shared_scorecard,
                        "net_pnl_per_day": "1500",
                        "market_impact_stress_net_pnl_per_day": "320",
                        "delay_adjusted_depth_stress_net_pnl_per_day": "280",
                        "double_oos_net_pnl_per_day": "260",
                        "double_oos_cost_shock_net_pnl_per_day": "240",
                        "implementation_uncertainty_lower_net_pnl_per_day": "220",
                    },
                },
                dataset_snapshot_id="snapshot-optimistic",
                result_path="/tmp/cand-optimistic.json",
            ),
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=robust.candidate_spec_id,
                candidate={
                    "candidate_id": "cand-robust",
                    "objective_scorecard": {
                        **shared_scorecard,
                        "net_pnl_per_day": "620",
                        "market_impact_stress_net_pnl_per_day": "610",
                        "delay_adjusted_depth_stress_net_pnl_per_day": "600",
                        "double_oos_net_pnl_per_day": "595",
                        "double_oos_cost_shock_net_pnl_per_day": "590",
                        "implementation_uncertainty_lower_net_pnl_per_day": "580",
                    },
                },
                dataset_snapshot_id="snapshot-robust",
                result_path="/tmp/cand-robust.json",
            ),
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=raw_only.candidate_spec_id,
                candidate={
                    "candidate_id": "cand-raw-only",
                    "objective_scorecard": {
                        "net_pnl_per_day": "2500",
                        "active_day_ratio": "1",
                        "positive_day_ratio": "1",
                        "negative_day_count": 0,
                        "best_day_share": "0.10",
                        "worst_day_loss": "0",
                        "max_drawdown": "25",
                        "avg_filled_notional_per_day": "300000",
                        "hard_vetoes": [],
                    },
                },
                dataset_snapshot_id="snapshot-raw-only",
                result_path="/tmp/cand-raw-only.json",
            ),
        ]

        rows = build_mlx_training_rows(
            candidate_specs=[optimistic, robust, raw_only],
            evidence_bundles=bundles,
        )
        row_by_spec = {row.candidate_spec_id: row for row in rows}
        optimistic_payload = row_by_spec[optimistic.candidate_spec_id].to_payload()
        robust_payload = row_by_spec[robust.candidate_spec_id].to_payload()
        raw_only_payload = row_by_spec[raw_only.candidate_spec_id].to_payload()

        self.assertEqual(
            optimistic_payload["features"][
                "history_deployable_lower_bound_net_pnl_per_day"
            ],
            220.0,
        )
        self.assertEqual(
            robust_payload["features"][
                "history_deployable_lower_bound_net_pnl_per_day"
            ],
            580.0,
        )
        self.assertLess(
            row_by_spec[optimistic.candidate_spec_id].target,
            row_by_spec[robust.candidate_spec_id].target,
        )
        self.assertGreater(
            raw_only_payload["features"][
                "history_deployable_lower_bound_missing_count"
            ],
            0.0,
        )
        self.assertLess(
            row_by_spec[raw_only.candidate_spec_id].target,
            row_by_spec[robust.candidate_spec_id].target,
        )
