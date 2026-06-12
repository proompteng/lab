from __future__ import annotations

from dataclasses import replace
from decimal import Decimal
from pathlib import Path


import scripts.run_whitepaper_autoresearch_profit_target as runner
from tests.autoresearch_runner.helpers import (
    AutoresearchRunnerTestCase,
)


class TestAutoresearchRunnerCandidateBoardEvidencePart2(AutoresearchRunnerTestCase):
    def test_candidate_board_rejects_unknown_code_commit_lineage(self) -> None:
        spec = self._candidate_spec("spec-unknown-lineage")
        evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-unknown-lineage",
            candidate_id="cand-unknown-lineage",
            candidate_spec_id=spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-unknown-lineage",
            feature_spec_hash="hash-unknown-lineage",
            code_commit="unknown",
            replay_artifact_refs=("replay.json",),
            objective_scorecard={
                "net_pnl_per_day": "700",
                "target_met": True,
                "oracle_passed": True,
                "profit_target_oracle": {"blockers": []},
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "calibrated", "source": "route_tca"},
            null_comparator={},
            promotion_readiness={},
        )

        board = runner._candidate_board_payload(
            epoch_id="epoch-unknown-lineage-board",
            output_dir=Path("/tmp/epoch-unknown-lineage-board"),
            target=Decimal("500"),
            candidate_specs=(spec,),
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                    }
                ]
            },
            pre_replay_proposal_rows=(
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": "9.0",
                },
            ),
            proposal_rows=(),
            evidence_bundles=(evidence,),
            portfolio=None,
            promotion_readiness={"promotable": True},
            runtime_closure={},
        )

        row = board["rows"][0]
        self.assertFalse(row["oracle_passed"])
        self.assertFalse(row["evidence_lineage"]["passed"])
        self.assertIn("code_commit_missing_or_unknown", row["blockers"])
        self.assertIn(
            "code_commit_missing_or_unknown",
            row["evidence_lineage"]["blockers"],
        )
        self.assertEqual(board["current_answer"], "no_promotion_ready_candidate")

    def test_candidate_board_fails_market_limit_candidate_without_order_type_evidence(
        self,
    ) -> None:
        spec = replace(
            self._candidate_spec("spec-market-limit-proof"),
            parameter_space={
                "mechanism_overlay_ids": ["mixed_market_limit_execution_policy"]
            },
            hard_vetoes={
                "required_order_type_ablation_passed": True,
                "required_min_order_type_ablation_sample_count": "60",
                "required_limit_fill_probability_evidence": True,
                "required_price_improvement_evidence": True,
                "required_opportunity_cost_evidence": True,
                "required_execution_shortfall_evidence": True,
                "required_max_order_type_opportunity_cost_bps": "8",
                "required_max_market_order_spread_bps": "8",
            },
            promotion_contract={
                "requires_order_type_execution_quality": True,
                "requires_market_limit_order_mix": True,
                "requires_limit_fill_probability": True,
                "requires_execution_shortfall": True,
            },
        )
        evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-market-limit-proof",
            candidate_id="cand-market-limit-proof",
            candidate_spec_id=spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-market-limit-proof",
            feature_spec_hash="hash-market-limit-proof",
            code_commit="commit-test",
            replay_artifact_refs=("replay.json",),
            objective_scorecard={
                "net_pnl_per_day": "640",
                "target_met": True,
                "oracle_passed": True,
                "profit_target_oracle": {"blockers": []},
                "order_type_ablation_sample_count": 59,
                "order_type_opportunity_cost_bps": "9",
                "market_order_spread_bps": "9",
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "provisional", "source": "paper_runtime"},
            null_comparator={},
            promotion_readiness={},
        )

        board = runner._candidate_board_payload(
            epoch_id="epoch-market-limit-board",
            output_dir=Path("/tmp/epoch-market-limit-board"),
            target=Decimal("500"),
            candidate_specs=(spec,),
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                    }
                ]
            },
            pre_replay_proposal_rows=(
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": "9.0",
                },
            ),
            proposal_rows=(),
            evidence_bundles=(evidence,),
            portfolio=None,
            promotion_readiness={"promotable": True},
            runtime_closure={},
        )

        row = board["rows"][0]
        self.assertFalse(row["oracle_passed"])
        self.assertEqual(board["current_answer"], "no_promotion_ready_candidate")
        self.assertIn("order_type_ablation_passed_failed", row["blockers"])
        self.assertIn("order_type_ablation_artifact_present_failed", row["blockers"])
        self.assertIn("order_type_ablation_sample_count_failed", row["blockers"])
        self.assertIn("market_limit_order_mix_evidence_present_failed", row["blockers"])
        self.assertIn("limit_fill_probability_evidence_present_failed", row["blockers"])
        self.assertIn("route_tca_evidence_present_failed", row["blockers"])
        self.assertIn("market_order_spread_bps_failed", row["blockers"])
        self.assertFalse(row["order_type_execution_quality"]["passed"])

    def test_candidate_board_accepts_market_limit_candidate_with_order_type_evidence(
        self,
    ) -> None:
        spec = replace(
            self._candidate_spec("spec-market-limit-pass"),
            parameter_space={
                "mechanism_overlay_ids": ["mixed_market_limit_execution_policy"]
            },
            hard_vetoes={
                "required_order_type_ablation_passed": True,
                "required_min_order_type_ablation_sample_count": "60",
                "required_limit_fill_probability_evidence": True,
                "required_price_improvement_evidence": True,
                "required_opportunity_cost_evidence": True,
                "required_execution_shortfall_evidence": True,
                "required_max_order_type_opportunity_cost_bps": "8",
                "required_max_market_order_spread_bps": "8",
            },
            promotion_contract={
                "requires_order_type_execution_quality": True,
                "requires_market_limit_order_mix": True,
                "requires_limit_fill_probability": True,
                "requires_execution_shortfall": True,
            },
        )
        evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-market-limit-pass",
            candidate_id="cand-market-limit-pass",
            candidate_spec_id=spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-market-limit-pass",
            feature_spec_hash="hash-market-limit-pass",
            code_commit="commit-test",
            replay_artifact_refs=(
                "replay.json",
                "order-type-ablation.json",
                "route-tca.json",
            ),
            objective_scorecard={
                "net_pnl_per_day": "640",
                "target_met": True,
                "oracle_passed": True,
                "profit_target_oracle": {"blockers": []},
                "order_type_ablation_passed": True,
                "order_type_ablation_artifact_ref": "order-type-ablation.json",
                "order_type_ablation_sample_count": 60,
                "market_limit_order_mix_evidence_present": True,
                "limit_fill_probability_evidence_present": True,
                "price_improvement_evidence_present": True,
                "opportunity_cost_evidence_present": True,
                "execution_shortfall_evidence_present": True,
                "route_tca_artifact_ref": "route-tca.json",
                "order_type_opportunity_cost_bps": "8",
                "market_order_spread_bps": "8",
                "replay_lineage": {
                    "lineage_hash": "lineage-market-limit-pass",
                    "expected_windows": ["train", "holdout", "full_window"],
                    "present_windows": ["train", "holdout", "full_window"],
                    "missing_windows": [],
                },
                "replay_window_coverage": {
                    "lineage_hash": "lineage-market-limit-pass",
                    "expected_windows": ["train", "holdout", "full_window"],
                    "present_windows": ["train", "holdout", "full_window"],
                    "missing_windows": [],
                },
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "calibrated", "source": "route_tca"},
            null_comparator={},
            promotion_readiness={},
        )

        board = runner._candidate_board_payload(
            epoch_id="epoch-market-limit-pass-board",
            output_dir=Path("/tmp/epoch-market-limit-pass-board"),
            target=Decimal("500"),
            candidate_specs=(spec,),
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                    }
                ]
            },
            pre_replay_proposal_rows=(
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": "9.0",
                },
            ),
            proposal_rows=(),
            evidence_bundles=(evidence,),
            portfolio=None,
            promotion_readiness={"promotable": True},
            runtime_closure={},
        )

        row = board["rows"][0]
        self.assertTrue(row["order_type_execution_quality"]["passed"])
        self.assertTrue(row["oracle_passed"])

    def test_candidate_board_rejects_queue_survival_overlay_without_lifecycle_depth(
        self,
    ) -> None:
        spec = replace(
            self._candidate_spec("spec-queue-survival-proof"),
            parameter_space={
                "mechanism_overlay_ids": ["queue_position_survival_fill_curve"]
            },
            hard_vetoes={
                "required_queue_position_survival_fill_curve": True,
                "required_min_queue_position_survival_sample_count": "60",
                "required_max_queue_position_nonfill_opportunity_cost_bps": "8",
                "required_time_to_fill_quantiles": True,
                "required_order_lifecycle_fill_evidence": True,
            },
            promotion_contract={
                "requires_queue_position_survival_fill_curve": True,
                "requires_time_to_fill_quantiles": True,
                "requires_nonfill_opportunity_cost": True,
                "requires_order_lifecycle_fill_evidence": True,
            },
        )
        evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-queue-survival-proof",
            candidate_id="cand-queue-survival-proof",
            candidate_spec_id=spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-queue-survival-proof",
            feature_spec_hash="hash-queue-survival-proof",
            code_commit="commit-test",
            replay_artifact_refs=("replay.json",),
            objective_scorecard={
                "net_pnl_per_day": "640",
                "target_met": True,
                "oracle_passed": True,
                "profit_target_oracle": {"blockers": []},
                "queue_position_survival_fill_curve_evidence_present": True,
                "queue_position_survival_sample_count": 12,
                "queue_position_survival_fill_rate": "0.85",
                "queue_position_survival_queue_ratio_p95": "0.25",
                "queue_position_survival_queue_ahead_depletion_evidence_present": True,
                "queue_position_survival_queue_ahead_depletion_sample_count": 12,
                "queue_position_survival_nonfill_opportunity_cost_bps": "12",
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "calibrated", "source": "route_tca"},
            null_comparator={},
            promotion_readiness={},
        )

        board = runner._candidate_board_payload(
            epoch_id="epoch-queue-survival-board",
            output_dir=Path("/tmp/epoch-queue-survival-board"),
            target=Decimal("500"),
            candidate_specs=(spec,),
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                    }
                ]
            },
            pre_replay_proposal_rows=(
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": "9.0",
                },
            ),
            proposal_rows=(),
            evidence_bundles=(evidence,),
            portfolio=None,
            promotion_readiness={"promotable": True},
            runtime_closure={},
        )

        row = board["rows"][0]
        queue_summary = row["queue_position_survival_fill_quality"]
        self.assertFalse(row["oracle_passed"])
        self.assertFalse(queue_summary["passed"])
        self.assertIn("queue_position_survival_sample_count_failed", row["blockers"])
        self.assertIn(
            "queue_position_survival_nonfill_opportunity_cost_bps_failed",
            row["blockers"],
        )
        self.assertIn("time_to_fill_quantiles_present_failed", row["blockers"])
        self.assertEqual(queue_summary["min_sample_count"], 60)

    def test_candidate_board_accepts_queue_survival_overlay_with_lifecycle_depth(
        self,
    ) -> None:
        spec = replace(
            self._candidate_spec("spec-queue-survival-pass"),
            parameter_space={
                "mechanism_overlay_ids": ["queue_position_survival_fill_curve"]
            },
            hard_vetoes={
                "required_queue_position_survival_fill_curve": True,
                "required_min_queue_position_survival_sample_count": "60",
                "required_max_queue_position_nonfill_opportunity_cost_bps": "8",
                "required_time_to_fill_quantiles": True,
            },
            promotion_contract={
                "requires_queue_position_survival_fill_curve": True,
                "requires_time_to_fill_quantiles": True,
                "requires_nonfill_opportunity_cost": True,
            },
        )

        summary = runner._candidate_board_queue_position_survival_summary(
            spec,
            {
                "queue_position_survival_fill_curve_evidence_present": True,
                "queue_position_survival_sample_count": 60,
                "queue_position_survival_fill_rate": "0.85",
                "queue_position_survival_queue_ratio_p95": "0.25",
                "queue_position_survival_queue_ahead_depletion_evidence_present": True,
                "queue_position_survival_queue_ahead_depletion_sample_count": 60,
                "queue_position_survival_nonfill_opportunity_cost_bps": "8",
                "fill_time_ms_p50": "110",
                "fill_time_ms_p95": "450",
            },
        )

        self.assertTrue(summary["required"])
        self.assertTrue(summary["passed"])
        self.assertEqual(summary["blockers"], [])
        self.assertTrue(summary["time_to_fill_quantiles_present"])

    def test_candidate_board_rejects_market_limit_candidate_with_unreachable_artifacts(
        self,
    ) -> None:
        spec = replace(
            self._candidate_spec("spec-market-limit-missing-artifact-ref"),
            parameter_space={
                "mechanism_overlay_ids": ["mixed_market_limit_execution_policy"]
            },
            hard_vetoes={
                "required_order_type_ablation_passed": True,
                "required_min_order_type_ablation_sample_count": "60",
                "required_limit_fill_probability_evidence": True,
                "required_price_improvement_evidence": True,
                "required_opportunity_cost_evidence": True,
                "required_execution_shortfall_evidence": True,
                "required_max_order_type_opportunity_cost_bps": "8",
                "required_max_market_order_spread_bps": "8",
            },
            promotion_contract={
                "requires_order_type_execution_quality": True,
                "requires_market_limit_order_mix": True,
                "requires_limit_fill_probability": True,
                "requires_execution_shortfall": True,
            },
        )
        evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-market-limit-missing-artifact-ref",
            candidate_id="cand-market-limit-missing-artifact-ref",
            candidate_spec_id=spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-market-limit-missing-artifact-ref",
            feature_spec_hash="hash-market-limit-missing-artifact-ref",
            code_commit="commit-test",
            replay_artifact_refs=("replay.json",),
            objective_scorecard={
                "net_pnl_per_day": "640",
                "target_met": True,
                "oracle_passed": True,
                "profit_target_oracle": {"blockers": []},
                "order_type_ablation_passed": True,
                "order_type_ablation_artifact_ref": "order-type-ablation.json",
                "order_type_ablation_sample_count": 60,
                "market_limit_order_mix_evidence_present": True,
                "limit_fill_probability_evidence_present": True,
                "price_improvement_evidence_present": True,
                "opportunity_cost_evidence_present": True,
                "execution_shortfall_evidence_present": True,
                "route_tca_artifact_ref": "route-tca.json",
                "order_type_opportunity_cost_bps": "8",
                "market_order_spread_bps": "8",
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "calibrated", "source": "route_tca"},
            null_comparator={},
            promotion_readiness={},
        )

        board = runner._candidate_board_payload(
            epoch_id="epoch-market-limit-missing-artifact-ref-board",
            output_dir=Path("/tmp/epoch-market-limit-missing-artifact-ref-board"),
            target=Decimal("500"),
            candidate_specs=(spec,),
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                    }
                ]
            },
            pre_replay_proposal_rows=(
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": "9.0",
                },
            ),
            proposal_rows=(),
            evidence_bundles=(evidence,),
            portfolio=None,
            promotion_readiness={"promotable": True},
            runtime_closure={},
        )

        row = board["rows"][0]
        self.assertFalse(row["order_type_execution_quality"]["passed"])
        self.assertFalse(row["oracle_passed"])
        self.assertIn(
            "order_type_proof_artifact_ref_missing_from_bundle", row["blockers"]
        )
        self.assertEqual(
            row["order_type_execution_quality"]["missing_replay_artifact_refs"],
            ["order-type-ablation.json", "route-tca.json"],
        )

    def test_candidate_board_rejects_route_tca_boolean_without_artifact(
        self,
    ) -> None:
        spec = replace(
            self._candidate_spec("spec-market-limit-route-bool"),
            parameter_space={
                "mechanism_overlay_ids": ["mixed_market_limit_execution_policy"]
            },
            hard_vetoes={
                "required_order_type_ablation_passed": True,
                "required_min_order_type_ablation_sample_count": "60",
                "required_limit_fill_probability_evidence": True,
                "required_price_improvement_evidence": True,
                "required_opportunity_cost_evidence": True,
                "required_execution_shortfall_evidence": True,
                "required_max_order_type_opportunity_cost_bps": "8",
                "required_max_market_order_spread_bps": "8",
            },
            promotion_contract={
                "requires_order_type_execution_quality": True,
                "requires_market_limit_order_mix": True,
                "requires_limit_fill_probability": True,
                "requires_execution_shortfall": True,
            },
        )
        evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-market-limit-route-bool",
            candidate_id="cand-market-limit-route-bool",
            candidate_spec_id=spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-market-limit-route-bool",
            feature_spec_hash="hash-market-limit-route-bool",
            code_commit="commit-test",
            replay_artifact_refs=("replay.json",),
            objective_scorecard={
                "net_pnl_per_day": "640",
                "target_met": True,
                "oracle_passed": True,
                "profit_target_oracle": {"blockers": []},
                "order_type_ablation_passed": True,
                "order_type_ablation_artifact_ref": "order-type-ablation.json",
                "order_type_ablation_sample_count": 60,
                "market_limit_order_mix_evidence_present": True,
                "limit_fill_probability_evidence_present": True,
                "price_improvement_evidence_present": True,
                "opportunity_cost_evidence_present": True,
                "execution_shortfall_evidence_present": True,
                "route_tca_evidence_present": True,
                "order_type_opportunity_cost_bps": "8",
                "market_order_spread_bps": "8",
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "calibrated", "source": "route_tca"},
            null_comparator={},
            promotion_readiness={},
        )

        board = runner._candidate_board_payload(
            epoch_id="epoch-market-limit-route-bool-board",
            output_dir=Path("/tmp/epoch-market-limit-route-bool-board"),
            target=Decimal("500"),
            candidate_specs=(spec,),
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                    }
                ]
            },
            pre_replay_proposal_rows=(),
            proposal_rows=(),
            evidence_bundles=(evidence,),
            portfolio=None,
            promotion_readiness={"promotable": True},
            runtime_closure={},
        )

        row = board["rows"][0]
        self.assertFalse(row["order_type_execution_quality"]["passed"])
        self.assertIn("route_tca_evidence_present_failed", row["blockers"])

    def test_candidate_board_rejects_route_tca_as_order_type_ablation_artifact(
        self,
    ) -> None:
        spec = replace(
            self._candidate_spec("spec-market-limit-route-artifact"),
            parameter_space={
                "mechanism_overlay_ids": ["mixed_market_limit_execution_policy"]
            },
            hard_vetoes={
                "required_order_type_ablation_passed": True,
                "required_min_order_type_ablation_sample_count": "60",
                "required_limit_fill_probability_evidence": True,
                "required_price_improvement_evidence": True,
                "required_opportunity_cost_evidence": True,
                "required_execution_shortfall_evidence": True,
                "required_max_order_type_opportunity_cost_bps": "8",
                "required_max_market_order_spread_bps": "8",
            },
            promotion_contract={
                "requires_order_type_execution_quality": True,
                "requires_market_limit_order_mix": True,
                "requires_limit_fill_probability": True,
                "requires_execution_shortfall": True,
            },
        )
        evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-market-limit-route-artifact",
            candidate_id="cand-market-limit-route-artifact",
            candidate_spec_id=spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-market-limit-route-artifact",
            feature_spec_hash="hash-market-limit-route-artifact",
            code_commit="commit-test",
            replay_artifact_refs=("replay.json",),
            objective_scorecard={
                "net_pnl_per_day": "640",
                "target_met": True,
                "oracle_passed": True,
                "profit_target_oracle": {"blockers": []},
                "order_type_ablation_passed": True,
                "order_type_execution_artifact_ref": "order-type-execution.json",
                "order_type_ablation_sample_count": 60,
                "market_limit_order_mix_evidence_present": True,
                "limit_fill_probability_evidence_present": True,
                "price_improvement_evidence_present": True,
                "opportunity_cost_evidence_present": True,
                "execution_shortfall_evidence_present": True,
                "route_tca_artifact_ref": "route-tca.json",
                "order_type_opportunity_cost_bps": "8",
                "market_order_spread_bps": "8",
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "calibrated", "source": "route_tca"},
            null_comparator={},
            promotion_readiness={},
        )

        board = runner._candidate_board_payload(
            epoch_id="epoch-market-limit-route-artifact-board",
            output_dir=Path("/tmp/epoch-market-limit-route-artifact-board"),
            target=Decimal("500"),
            candidate_specs=(spec,),
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                    }
                ]
            },
            pre_replay_proposal_rows=(),
            proposal_rows=(),
            evidence_bundles=(evidence,),
            portfolio=None,
            promotion_readiness={"promotable": True},
            runtime_closure={},
        )

        row = board["rows"][0]
        self.assertFalse(row["order_type_execution_quality"]["passed"])
        self.assertIn("order_type_ablation_artifact_present_failed", row["blockers"])
        self.assertNotIn("route_tca_evidence_present_failed", row["blockers"])

    def test_candidate_board_separates_research_rank_from_executed_candidate(
        self,
    ) -> None:
        research_spec = self._candidate_spec(
            "spec-83161ae16d17828eabcc58cc",
            family_template_id="intraday_tsmom_v2",
        )
        executed_spec = self._candidate_spec(
            "spec-hmicro-proof",
            family_template_id="microstructure_continuation_matched_filter_v1",
        )
        executed_evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-hmicro-proof",
            candidate_id="chip-paper-microbar-composite@execution-proof",
            candidate_spec_id=executed_spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-hmicro-runtime-proof",
            feature_spec_hash="hash-hmicro-proof",
            code_commit="commit-test",
            replay_artifact_refs=(
                "paper-window.json",
                "paper-window-exact-replay-ledger.json",
            ),
            objective_scorecard={
                "net_pnl_per_day": "82.50",
                "market_impact_stress_passed": True,
                "market_impact_stress_net_pnl_per_day": "82.50",
                "delay_adjusted_depth_stress_passed": True,
                "delay_adjusted_depth_stress_net_pnl_per_day": "82.50",
                "post_cost_net_pnl_after_queue_position_survival_fill_stress": "82.50",
                "double_oos_passed": True,
                "double_oos_net_pnl_per_day": "82.50",
                "double_oos_cost_shock_net_pnl_per_day": "82.50",
                "implementation_uncertainty_stability_passed": True,
                "implementation_uncertainty_lower_net_pnl_per_day": "82.50",
                "conformal_tail_risk_passed": True,
                "conformal_tail_risk_adjusted_net_pnl_per_day": "82.50",
                "delay_adjusted_depth_fill_survival_evidence_present": True,
                "delay_adjusted_depth_fill_survival_sample_count": 7,
                "delay_adjusted_depth_fill_survival_rate": "0.85",
                "queue_position_survival_fill_curve_evidence_present": True,
                "queue_position_survival_sample_count": 7,
                "queue_position_survival_fill_rate": "0.85",
                "queue_position_survival_queue_ratio_p95": "0.25",
                "queue_position_survival_queue_ahead_depletion_evidence_present": True,
                "queue_position_survival_queue_ahead_depletion_sample_count": 7,
                "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
                "delay_adjusted_depth_queue_ahead_depletion_sample_count": 7,
                "queue_ahead_depletion_evidence_present": True,
                "queue_ahead_depletion_sample_count": 7,
                "target_met": False,
                "oracle_passed": False,
                "trading_day_count": 3,
                "trade_decision_count": 7,
                "orders_submitted_count": 7,
                "trade_count": 7,
                "executable_replay_submitted_order_count": 7,
                "exact_replay_ledger_artifact_ref": "paper-window-exact-replay-ledger.json",
                "exact_replay_ledger_artifact_row_count": 21,
                "exact_replay_ledger_artifact_fill_count": 7,
                "replay_lineage": {
                    "windows": {
                        "full_window": {
                            "start_date": "2026-05-18",
                            "end_date": "2026-05-20",
                        }
                    }
                },
                "profit_target_oracle": {
                    "blockers": [
                        "portfolio_post_cost_net_pnl_per_day_failed",
                        "min_observed_trading_days_failed",
                    ],
                },
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "provisional", "source": "paper_runtime"},
            null_comparator={},
            promotion_readiness={},
        )

        board = runner._candidate_board_payload(
            epoch_id="epoch-candidate-board-split",
            output_dir=Path("/tmp/epoch-candidate-board-split"),
            target=Decimal("500"),
            candidate_specs=(research_spec, executed_spec),
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": executed_spec.candidate_spec_id,
                        "selected_for_replay": True,
                    }
                ]
            },
            pre_replay_proposal_rows=(
                {
                    "candidate_spec_id": research_spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": "2.52157822",
                },
                {
                    "candidate_spec_id": executed_spec.candidate_spec_id,
                    "rank": 2,
                    "proposal_score": "1.4",
                },
            ),
            proposal_rows=(),
            evidence_bundles=(executed_evidence,),
            portfolio=None,
            promotion_readiness={"promotable": False, "blockers": ["not_ready"]},
            runtime_closure={"status": "blocked"},
        )

        self.assertEqual(board["current_answer"], "no_promotion_ready_candidate")
        self.assertEqual(
            board["best_research_candidate"]["candidate_spec_id"],
            research_spec.candidate_spec_id,
        )
        self.assertEqual(
            board["best_executed_candidate"]["candidate_id"],
            "chip-paper-microbar-composite@execution-proof",
        )
        self.assertEqual(
            board["closest_promotion_candidate"]["candidate_id"],
            "chip-paper-microbar-composite@execution-proof",
        )
        self.assertEqual(
            board["paper_probation_candidate"]["candidate_id"],
            "chip-paper-microbar-composite@execution-proof",
        )
        self.assertEqual(
            board["paper_probation_candidate"]["selection_reason"],
            "closest_lower_bound_economics_below_target",
        )
        self.assertEqual(board["best_executed_candidate"]["decision_count"], 7)
        self.assertEqual(board["best_executed_candidate"]["submitted_order_count"], 7)
        self.assertEqual(board["best_executed_candidate"]["filled_order_count"], 7)
        self.assertEqual(board["double_oos_summary"]["replayed_candidate_count"], 1)
        self.assertEqual(
            board["double_oos_summary"]["missing_artifact_candidate_count"], 1
        )
        self.assertIn(
            "double_oos_artifact_missing_for_replayed_candidates",
            board["double_oos_summary"]["blockers"],
        )
        self.assertRegex(board["status_digest"], r"^[0-9a-f]{64}$")

    def test_candidate_board_rejects_alpha_decay_overlay_without_stress(
        self,
    ) -> None:
        spec = replace(
            self._candidate_spec("spec-alpha-decay-missing-stress"),
            parameter_space={
                "mechanism_overlay_ids": ["alpha_decay_predictability_stress"]
            },
            promotion_contract={
                "requires_predictability_decay_stress": True,
                "requires_horizon_decay_curve": True,
                "requires_spread_adjusted_label_replay": True,
            },
        )
        evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-alpha-decay-missing-stress",
            candidate_id="cand-alpha-decay-missing-stress",
            candidate_spec_id=spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-alpha-decay-missing-stress",
            feature_spec_hash="hash-alpha-decay-missing-stress",
            code_commit="commit-test",
            replay_artifact_refs=("alpha-decay-replay.json",),
            objective_scorecard={
                "net_pnl_per_day": "725",
                "target_met": True,
                "oracle_passed": True,
                "trade_decision_count": 14,
                "orders_submitted_count": 14,
                "trade_count": 14,
                "profit_target_oracle": {"blockers": []},
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "provisional", "source": "paper_runtime"},
            null_comparator={},
            promotion_readiness={},
        )

        board = runner._candidate_board_payload(
            epoch_id="epoch-alpha-decay-missing-stress",
            output_dir=Path("/tmp/epoch-alpha-decay-missing-stress"),
            target=Decimal("500"),
            candidate_specs=(spec,),
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                    }
                ]
            },
            pre_replay_proposal_rows=(),
            proposal_rows=(),
            evidence_bundles=(evidence,),
            portfolio=None,
            promotion_readiness={"promotable": False},
            runtime_closure={},
        )

        row = board["rows"][0]
        self.assertFalse(row["oracle_passed"])
        self.assertFalse(row["predictability_decay_stress"]["passed"])
        self.assertIn(
            "predictability_decay_stress_passed_failed",
            row["predictability_decay_stress"]["blockers"],
        )
        self.assertIn(
            "predictability_decay_stress_passed_failed",
            row["blockers"],
        )
        self.assertEqual(
            row["predictability_decay_stress"]["source_marker"],
            "tkan_lob_alpha_decay_arxiv_2601_02310_2026",
        )
