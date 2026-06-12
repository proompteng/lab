from __future__ import annotations

from dataclasses import replace
import json
from argparse import Namespace
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory


import scripts.run_whitepaper_autoresearch_profit_target as runner
from tests.autoresearch_runner.helpers import (
    AutoresearchRunnerTestCase,
    _CHIP_UNIVERSE,
    _compact_recent_whitepaper_sources,
)


class TestAutoresearchRunnerCandidateBoardPaperProbation(AutoresearchRunnerTestCase):
    def test_candidate_board_surfaces_paper_probation_without_promotion(
        self,
    ) -> None:
        spec = self._candidate_spec("spec-paper-probation")
        evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-paper-probation",
            candidate_id="cand-paper-probation",
            candidate_spec_id=spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-paper-probation",
            feature_spec_hash="hash-paper-probation",
            code_commit="commit-test",
            replay_artifact_refs=(
                "paper-probation.json",
                "paper-probation-exact-ledger.json",
            ),
            objective_scorecard={
                "net_pnl_per_day": "525",
                "market_impact_stress_passed": True,
                "market_impact_stress_net_pnl_per_day": "525",
                "delay_adjusted_depth_stress_passed": True,
                "delay_adjusted_depth_stress_net_pnl_per_day": "525",
                "post_cost_net_pnl_after_queue_position_survival_fill_stress": "525",
                "double_oos_passed": True,
                "double_oos_cost_shock_net_pnl_per_day": "525",
                "implementation_uncertainty_stability_passed": True,
                "implementation_uncertainty_lower_net_pnl_per_day": "525",
                "conformal_tail_risk_passed": True,
                "conformal_tail_risk_adjusted_net_pnl_per_day": "525",
                "breakeven_transaction_cost_buffer_passed": True,
                "breakeven_transaction_cost_buffer_bps": "5",
                "transaction_cost_buffer_bps": "1",
                "post_cost_net_pnl_after_breakeven_transaction_cost_buffer": "520",
                "required_seed_model_family_robustness": True,
                "seed_model_family_robustness_status": (
                    "required_not_materialized_by_single_frontier_replay"
                ),
                "seed_robustness_passed": False,
                "seed_robustness_sample_count": 0,
                "model_family_robustness_passed": False,
                "model_family_robustness_family_count": 0,
                "delay_adjusted_depth_fill_survival_evidence_present": True,
                "delay_adjusted_depth_fill_survival_sample_count": 9,
                "delay_adjusted_depth_fill_survival_rate": "0.85",
                "queue_position_survival_fill_curve_evidence_present": True,
                "queue_position_survival_sample_count": 9,
                "queue_position_survival_fill_rate": "0.85",
                "queue_position_survival_queue_ratio_p95": "0.25",
                "queue_position_survival_queue_ahead_depletion_evidence_present": True,
                "queue_position_survival_queue_ahead_depletion_sample_count": 9,
                "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
                "delay_adjusted_depth_queue_ahead_depletion_sample_count": 9,
                "queue_ahead_depletion_evidence_present": True,
                "queue_ahead_depletion_sample_count": 9,
                "target_met": True,
                "oracle_passed": False,
                "trade_decision_count": 9,
                "orders_submitted_count": 9,
                "trade_count": 9,
                "exact_replay_ledger_artifact_ref": "paper-probation-exact-ledger.json",
                "exact_replay_ledger_artifact_row_count": 27,
                "exact_replay_ledger_artifact_fill_count": 9,
                "replay_lineage": {
                    "windows": {
                        "full_window": {
                            "start_date": "2026-05-18",
                            "end_date": "2026-05-20",
                        }
                    }
                },
                "profit_target_oracle": {
                    "blockers": ["delay_adjusted_depth_tail_coverage_passed_failed"]
                },
                "runtime_ledger_lineage_materialization_handoff": {
                    "status": "requires_runtime_ledger_materialization_before_authoritative_pnl",
                    "runtime_ledger_required": True,
                    "source_backed_runtime_ledger_required": True,
                    "proof_authority": False,
                    "promotion_allowed": False,
                    "final_authority_ok": False,
                    "zero_authoritative_daily_pnl_until_materialized": True,
                    "required_materialized_artifacts": [
                        {
                            "artifact_ref": "paper-probation-exact-ledger.json",
                            "kind": "exact_replay_ledger",
                        },
                        "runtime-ledger/daily-pnl.parquet",
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
            epoch_id="epoch-paper-probation-board",
            output_dir=Path("/tmp/epoch-paper-probation-board"),
            target=Decimal("500"),
            candidate_specs=(spec,),
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                        "selection_reason": "paper_contract_exploration",
                        "paper_contract_prior_score": "31.5",
                        "paper_mechanism_overlay_ids": [
                            "mixed_market_limit_execution_policy",
                            "queue_position_survival_fill_curve",
                        ],
                        "paper_required_evidence_tokens": [
                            "live_paper_parity",
                            "route_tca",
                            "runtime_ledger",
                        ],
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
            promotion_readiness={"promotable": False},
            runtime_closure={},
        )

        self.assertEqual(board["current_answer"], "no_promotion_ready_candidate")
        row = board["rows"][0]
        self.assertEqual(row["replay_selection_reason"], "paper_contract_exploration")
        self.assertTrue(row["paper_contract_candidate"])
        self.assertTrue(row["paper_contract_selected_for_replay"])
        self.assertEqual(row["paper_contract_prior_score"], "31.5")
        self.assertEqual(
            row["paper_mechanism_overlay_ids"],
            [
                "mixed_market_limit_execution_policy",
                "queue_position_survival_fill_curve",
            ],
        )
        self.assertEqual(
            row["paper_required_evidence_tokens"],
            ["live_paper_parity", "route_tca", "runtime_ledger"],
        )
        self.assertEqual(row["paper_required_evidence_count"], 3)
        self.assertTrue(row["breakeven_transaction_cost_buffer_passed"])
        self.assertEqual(row["breakeven_transaction_cost_buffer_bps"], "5")
        self.assertEqual(row["transaction_cost_buffer_bps"], "1")
        self.assertEqual(
            row["post_cost_net_pnl_after_breakeven_transaction_cost_buffer"],
            "520",
        )
        self.assertTrue(row["required_seed_model_family_robustness"])
        self.assertEqual(
            row["seed_model_family_robustness_status"],
            "required_not_materialized_by_single_frontier_replay",
        )
        self.assertFalse(row["seed_robustness_passed"])
        self.assertEqual(row["seed_robustness_sample_count"], 0)
        self.assertFalse(row["model_family_robustness_passed"])
        self.assertEqual(row["model_family_robustness_family_count"], 0)
        expected_runtime_ledger_handoff = {
            "status": "requires_runtime_ledger_materialization_before_authoritative_pnl",
            "runtime_ledger_required": True,
            "source_backed_runtime_ledger_required": True,
            "proof_authority": False,
            "promotion_allowed": False,
            "final_authority_ok": False,
            "zero_authoritative_daily_pnl_until_materialized": True,
            "required_materialized_artifacts": [
                {
                    "artifact_ref": "paper-probation-exact-ledger.json",
                    "kind": "exact_replay_ledger",
                },
                "runtime-ledger/daily-pnl.parquet",
            ],
        }
        expected_required_materialized_artifacts = [
            "paper-probation-exact-ledger.json",
            "runtime-ledger/daily-pnl.parquet",
        ]
        self.assertEqual(
            row["runtime_ledger_lineage_materialization_handoff"],
            expected_runtime_ledger_handoff,
        )
        self.assertEqual(
            row["runtime_ledger_required_materialized_artifacts"],
            expected_required_materialized_artifacts,
        )
        self.assertEqual(
            row["runtime_ledger_materialization_status"],
            "requires_runtime_ledger_materialization_before_authoritative_pnl",
        )
        self.assertTrue(row["zero_authoritative_daily_pnl_until_materialized"])
        self.assertEqual(
            board["paper_probation_candidate"]["candidate_id"], "cand-paper-probation"
        )
        probation_candidate = board["paper_probation_candidate"]
        self.assertEqual(
            probation_candidate["candidate_selection"],
            "oracle_recommended_paper_probation",
        )
        self.assertTrue(probation_candidate["paper_probation_authorized"])
        self.assertTrue(probation_candidate["probation_allowed"])
        self.assertEqual(
            probation_candidate["paper_probation_authorization_scope"],
            "evidence_collection_only",
        )
        self.assertIn(
            "seed_robustness_replay_grid",
            probation_candidate["live_paper_evidence_requirements"],
        )
        self.assertIn(
            "model_family_robustness_replay_grid",
            probation_candidate["live_paper_evidence_requirements"],
        )
        self.assertIn(
            "run_offline_seed_model_family_robustness_grid_before_paper_probation",
            probation_candidate["safe_evidence_collection_path"],
        )
        self.assertIn(
            "attach_seed_model_family_robustness_artifact_to_evidence_bundle",
            probation_candidate["safe_evidence_collection_path"],
        )
        self.assertEqual(probation_candidate["evidence_collection_stage"], "paper")
        self.assertEqual(
            probation_candidate["selection_reason"], "target_met_but_oracle_blocked"
        )
        self.assertEqual(probation_candidate["probation_target_shortfall"], "0")
        self.assertEqual(probation_candidate["probation_target_progress_ratio"], "1.05")
        self.assertEqual(
            probation_candidate["required_notional_repair_scale_to_target"], "1"
        )
        self.assertIn(
            "real_runtime_trade_decisions",
            probation_candidate["live_paper_evidence_requirements"],
        )
        self.assertIn(
            "broker_runtime_ledger_reconciliation",
            probation_candidate["live_paper_evidence_requirements"],
        )
        self.assertIn(
            "import_exact_replay_runtime_window_metadata_without_live_submit",
            probation_candidate["safe_evidence_collection_path"],
        )
        self.assertFalse(probation_candidate["live_capital_authorized"])
        self.assertTrue(
            probation_candidate["final_promotion_requires_live_paper_runtime_proof"]
        )
        self.assertEqual(
            probation_candidate["runtime_ledger_lineage_materialization_handoff"],
            expected_runtime_ledger_handoff,
        )
        self.assertEqual(
            probation_candidate["runtime_ledger_required_materialized_artifacts"],
            expected_required_materialized_artifacts,
        )
        self.assertTrue(
            probation_candidate["zero_authoritative_daily_pnl_until_materialized"]
        )
        self.assertFalse(probation_candidate["promotion_allowed"])
        self.assertFalse(probation_candidate["final_promotion_authorized"])
        self.assertFalse(probation_candidate["final_promotion_allowed"])
        self.assertIn(
            "delay_adjusted_depth_tail_coverage_passed_failed",
            probation_candidate["final_promotion_blockers"],
        )
        plan = board["runtime_window_import_plan"]
        self.assertEqual(
            plan["schema_version"], "torghut.runtime-window-import-plan.v1"
        )
        self.assertEqual(plan["status"], "ready")
        self.assertEqual(plan["target_count"], 1)
        target = plan["targets"][0]
        self.assertEqual(target["candidate_id"], "cand-paper-probation")
        self.assertEqual(target["candidate_spec_id"], spec.candidate_spec_id)
        self.assertEqual(target["hypothesis_id"], spec.hypothesis_id)
        self.assertEqual(target["strategy_family"], spec.runtime_family)
        self.assertEqual(target["strategy_name"], spec.runtime_strategy_name)
        self.assertEqual(target["observed_stage"], "paper")
        self.assertEqual(
            target["source_kind"], "simulation_exact_replay_runtime_ledger"
        )
        self.assertEqual(target["account_label"], "TORGHUT_REPLAY")
        self.assertEqual(target["window_start"], "2026-05-18T13:30:00+00:00")
        self.assertEqual(target["window_end"], "2026-05-20T20:00:00+00:00")
        self.assertEqual(target["dataset_snapshot_ref"], "snapshot-paper-probation")
        self.assertEqual(
            target["artifact_refs"],
            ["paper-probation.json", "paper-probation-exact-ledger.json"],
        )
        self.assertEqual(
            target["exact_replay_ledger_artifact_refs"],
            ["paper-probation-exact-ledger.json"],
        )
        self.assertEqual(
            target["exact_replay_ledger_artifact_ref"],
            "paper-probation-exact-ledger.json",
        )
        self.assertNotIn("runtime_ledger_artifact_refs", target)
        self.assertEqual(target["exact_replay_ledger_artifact_row_count"], 27)
        self.assertEqual(target["exact_replay_ledger_artifact_fill_count"], 9)
        self.assertEqual(
            target["runtime_ledger_lineage_materialization_handoff"],
            expected_runtime_ledger_handoff,
        )
        self.assertEqual(
            target["runtime_ledger_required_materialized_artifacts"],
            expected_required_materialized_artifacts,
        )
        self.assertEqual(
            target["runtime_ledger_materialization_status"],
            "requires_runtime_ledger_materialization_before_authoritative_pnl",
        )
        self.assertTrue(target["zero_authoritative_daily_pnl_until_materialized"])
        self.assertEqual(
            target["replay_selection_reason"], "paper_contract_exploration"
        )
        self.assertTrue(target["paper_contract_candidate"])
        self.assertTrue(target["paper_contract_selected_for_replay"])
        self.assertEqual(target["paper_contract_prior_score"], "31.5")
        self.assertEqual(
            target["paper_required_evidence_tokens"],
            ["live_paper_parity", "route_tca", "runtime_ledger"],
        )
        self.assertIn("--artifact-ref", target["import_command_args"])
        self.assertIn(
            "paper-probation-exact-ledger.json", target["import_command_args"]
        )
        self.assertIn("--target-metadata-json", target["import_command_args"])
        metadata_arg_index = (
            target["import_command_args"].index("--target-metadata-json") + 1
        )
        import_metadata = json.loads(target["import_command_args"][metadata_arg_index])
        self.assertEqual(
            import_metadata["exact_replay_ledger_artifact_refs"],
            ["paper-probation-exact-ledger.json"],
        )
        self.assertNotIn("runtime_ledger_artifact_refs", import_metadata)
        self.assertEqual(import_metadata["exact_replay_ledger_artifact_row_count"], 27)
        self.assertEqual(import_metadata["exact_replay_ledger_artifact_fill_count"], 9)
        self.assertEqual(
            import_metadata["exact_replay_ledger_artifact_ref"],
            "paper-probation-exact-ledger.json",
        )
        self.assertEqual(
            import_metadata["runtime_ledger_lineage_materialization_handoff"],
            expected_runtime_ledger_handoff,
        )
        self.assertEqual(
            import_metadata["runtime_ledger_required_materialized_artifacts"],
            expected_required_materialized_artifacts,
        )
        self.assertEqual(
            import_metadata["runtime_ledger_materialization_status"],
            "requires_runtime_ledger_materialization_before_authoritative_pnl",
        )
        self.assertTrue(
            import_metadata["zero_authoritative_daily_pnl_until_materialized"]
        )
        self.assertEqual(import_metadata["window_start"], target["window_start"])
        self.assertEqual(import_metadata["window_end"], target["window_end"])
        self.assertEqual(
            import_metadata["replay_selection_reason"], "paper_contract_exploration"
        )
        self.assertEqual(
            import_metadata["paper_mechanism_overlay_ids"],
            [
                "mixed_market_limit_execution_policy",
                "queue_position_survival_fill_curve",
            ],
        )
        self.assertEqual(
            import_metadata["paper_required_evidence_tokens"],
            ["live_paper_parity", "route_tca", "runtime_ledger"],
        )
        self.assertTrue(import_metadata["paper_probation_authorized"])
        self.assertFalse(import_metadata["promotion_allowed"])
        self.assertFalse(import_metadata["final_promotion_authorized"])
        self.assertEqual(
            import_metadata["required_notional_repair_scale_to_target"], "1"
        )
        self.assertIn(
            "broker_fill_events",
            import_metadata["live_paper_evidence_requirements"],
        )
        self.assertIn(
            "materialize_source_backed_runtime_ledger_lineage_for_decisions_orders_fills_costs",
            import_metadata["safe_evidence_collection_path"],
        )
        self.assertFalse(import_metadata["live_capital_authorized"])
        self.assertEqual(target["handoff"], "runtime_window_import_only")
        self.assertEqual(
            target["promotion_gate"], "existing_runtime_governance_fail_closed"
        )
        self.assertTrue(target["paper_probation_authorized"])
        self.assertEqual(target["evidence_collection_stage"], "paper")
        self.assertFalse(target["promotion_allowed"])
        self.assertFalse(target["final_promotion_authorized"])
        self.assertFalse(target["final_promotion_allowed"])
        self.assertEqual(target["selection_reason"], "target_met_but_oracle_blocked")
        handoff = runner._paper_probation_handoff_payload(board)
        self.assertEqual(
            handoff["schema_version"], "torghut.paper-probation-handoff.v1"
        )
        self.assertEqual(handoff["status"], "ready")
        self.assertTrue(handoff["paper_probation_authorized"])
        self.assertFalse(handoff["promotion_allowed"])
        self.assertFalse(handoff["final_promotion_allowed"])
        self.assertEqual(handoff["candidate_count"], 1)
        self.assertEqual(
            handoff["candidates"][0]["candidate_id"], "cand-paper-probation"
        )
        self.assertEqual(
            handoff["runtime_window_import_plan"]["target_count"],
            1,
        )

    def test_candidate_board_paper_probation_prefers_lower_bound_economics(
        self,
    ) -> None:
        weak_spec = self._candidate_spec("spec-weak-probation")
        close_spec = self._candidate_spec("spec-close-probation")
        bridge_spec = self._candidate_spec("spec-bridge-probation")
        raw_only_spec = self._candidate_spec("spec-raw-only-probation")
        weak_evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-weak-probation",
            candidate_id="cand-weak-probation",
            candidate_spec_id=weak_spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-weak-probation",
            feature_spec_hash="hash-weak-probation",
            code_commit="commit-test",
            replay_artifact_refs=("weak-probation.json",),
            objective_scorecard={
                "net_pnl_per_day": "125",
                "market_impact_stress_passed": True,
                "market_impact_stress_net_pnl_per_day": "125",
                "delay_adjusted_depth_stress_passed": True,
                "delay_adjusted_depth_stress_net_pnl_per_day": "125",
                "delay_adjusted_depth_fill_survival_evidence_present": True,
                "delay_adjusted_depth_fill_survival_sample_count": 12,
                "delay_adjusted_depth_fill_survival_rate": "0.85",
                "queue_position_survival_fill_curve_evidence_present": True,
                "queue_position_survival_sample_count": 12,
                "queue_position_survival_fill_rate": "0.85",
                "queue_position_survival_queue_ratio_p95": "0.25",
                "queue_position_survival_queue_ahead_depletion_evidence_present": True,
                "queue_position_survival_queue_ahead_depletion_sample_count": 12,
                "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
                "delay_adjusted_depth_queue_ahead_depletion_sample_count": 12,
                "queue_ahead_depletion_evidence_present": True,
                "queue_ahead_depletion_sample_count": 12,
                "post_cost_net_pnl_after_queue_position_survival_fill_stress": "125",
                "double_oos_passed": True,
                "double_oos_net_pnl_per_day": "125",
                "double_oos_cost_shock_net_pnl_per_day": "125",
                "implementation_uncertainty_stability_passed": True,
                "implementation_uncertainty_lower_net_pnl_per_day": "125",
                "conformal_tail_risk_passed": True,
                "conformal_tail_risk_adjusted_net_pnl_per_day": "125",
                "target_met": False,
                "oracle_passed": False,
                "active_day_ratio": "1",
                "positive_day_ratio": "1",
                "best_day_share": "0.10",
                "worst_day_loss": "0",
                "trade_decision_count": 12,
                "orders_submitted_count": 12,
                "trade_count": 12,
                "profit_target_oracle": {
                    "blockers": ["min_daily_net_pnl_failed"],
                },
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "provisional", "source": "paper_runtime"},
            null_comparator={},
            promotion_readiness={},
        )
        close_evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-close-probation",
            candidate_id="cand-close-probation",
            candidate_spec_id=close_spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-close-probation",
            feature_spec_hash="hash-close-probation",
            code_commit="commit-test",
            replay_artifact_refs=(
                "close-probation.json",
                "close-probation-exact-replay-ledger.json",
            ),
            objective_scorecard={
                "net_pnl_per_day": "480",
                "market_impact_stress_passed": True,
                "market_impact_stress_net_pnl_per_day": "460",
                "delay_adjusted_depth_stress_passed": True,
                "delay_adjusted_depth_stress_net_pnl_per_day": "450",
                "delay_adjusted_depth_fill_survival_evidence_present": True,
                "delay_adjusted_depth_fill_survival_sample_count": 8,
                "delay_adjusted_depth_fill_survival_rate": "0.85",
                "queue_position_survival_fill_curve_evidence_present": True,
                "queue_position_survival_sample_count": 8,
                "queue_position_survival_fill_rate": "0.85",
                "queue_position_survival_queue_ratio_p95": "0.25",
                "queue_position_survival_queue_ahead_depletion_evidence_present": True,
                "queue_position_survival_queue_ahead_depletion_sample_count": 8,
                "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
                "delay_adjusted_depth_queue_ahead_depletion_sample_count": 8,
                "queue_ahead_depletion_evidence_present": True,
                "queue_ahead_depletion_sample_count": 8,
                "post_cost_net_pnl_after_queue_position_survival_fill_stress": "430",
                "double_oos_passed": True,
                "double_oos_net_pnl_per_day": "440",
                "double_oos_cost_shock_net_pnl_per_day": "440",
                "implementation_uncertainty_stability_passed": True,
                "implementation_uncertainty_lower_net_pnl_per_day": "430",
                "conformal_tail_risk_passed": True,
                "conformal_tail_risk_adjusted_net_pnl_per_day": "430",
                "target_met": False,
                "oracle_passed": False,
                "active_day_ratio": "0.82",
                "positive_day_ratio": "0.68",
                "best_day_share": "0.32",
                "worst_day_loss": "40",
                "trade_decision_count": 8,
                "orders_submitted_count": 8,
                "trade_count": 8,
                "exact_replay_ledger_artifact_ref": "close-probation-exact-replay-ledger.json",
                "exact_replay_ledger_artifact_row_count": 24,
                "exact_replay_ledger_artifact_fill_count": 8,
                "replay_lineage": {
                    "windows": {
                        "full_window": {
                            "start_date": "2026-05-18",
                            "end_date": "2026-05-21",
                        }
                    }
                },
                "profit_target_oracle": {
                    "blockers": [
                        "min_daily_net_pnl_failed",
                        "delay_adjusted_depth_stress_net_pnl_per_day_failed",
                    ],
                },
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "provisional", "source": "paper_runtime"},
            null_comparator={},
            promotion_readiness={},
        )
        raw_only_evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-raw-only-probation",
            candidate_id="cand-raw-only-probation",
            candidate_spec_id=raw_only_spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-raw-only-probation",
            feature_spec_hash="hash-raw-only-probation",
            code_commit="commit-test",
            replay_artifact_refs=("raw-only-probation.json",),
            objective_scorecard={
                "net_pnl_per_day": "900",
                "target_met": False,
                "oracle_passed": False,
                "active_day_ratio": "1",
                "positive_day_ratio": "1",
                "best_day_share": "0.10",
                "worst_day_loss": "0",
                "trade_decision_count": 20,
                "orders_submitted_count": 20,
                "trade_count": 20,
                "profit_target_oracle": {
                    "blockers": ["deployable_lower_bound_proof_missing"],
                },
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "provisional", "source": "paper_runtime"},
            null_comparator={},
            promotion_readiness={},
        )
        bridge_scorecard = {
            **close_evidence.objective_scorecard,
            "net_pnl_per_day": "315",
            "market_impact_stress_net_pnl_per_day": "290",
            "delay_adjusted_depth_stress_net_pnl_per_day": "280",
            "post_cost_net_pnl_after_queue_position_survival_fill_stress": "260",
            "double_oos_net_pnl_per_day": "270",
            "double_oos_cost_shock_net_pnl_per_day": "270",
            "implementation_uncertainty_lower_net_pnl_per_day": "260",
            "conformal_tail_risk_adjusted_net_pnl_per_day": "260",
            "exact_replay_ledger_artifact_ref": "bridge-probation-exact-replay-ledger.json",
            "exact_replay_ledger_artifact_row_count": 18,
            "exact_replay_ledger_artifact_fill_count": 6,
        }
        bridge_evidence = replace(
            close_evidence,
            evidence_bundle_id="ev-bridge-probation",
            candidate_id="cand-bridge-probation",
            candidate_spec_id=bridge_spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-bridge-probation",
            feature_spec_hash="hash-bridge-probation",
            replay_artifact_refs=(
                "bridge-probation.json",
                "bridge-probation-exact-replay-ledger.json",
            ),
            objective_scorecard=bridge_scorecard,
        )

        board = runner._candidate_board_payload(
            epoch_id="epoch-paper-probation-economics",
            output_dir=Path("/tmp/epoch-paper-probation-economics"),
            target=Decimal("500"),
            candidate_specs=(weak_spec, close_spec, bridge_spec, raw_only_spec),
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": weak_spec.candidate_spec_id,
                        "selected_for_replay": True,
                    },
                    {
                        "candidate_spec_id": close_spec.candidate_spec_id,
                        "selected_for_replay": True,
                    },
                    {
                        "candidate_spec_id": bridge_spec.candidate_spec_id,
                        "selected_for_replay": True,
                    },
                    {
                        "candidate_spec_id": raw_only_spec.candidate_spec_id,
                        "selected_for_replay": True,
                    },
                ]
            },
            pre_replay_proposal_rows=(
                {
                    "candidate_spec_id": weak_spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": "9.0",
                },
                {
                    "candidate_spec_id": close_spec.candidate_spec_id,
                    "rank": 2,
                    "proposal_score": "8.0",
                },
                {
                    "candidate_spec_id": raw_only_spec.candidate_spec_id,
                    "rank": 3,
                    "proposal_score": "7.0",
                },
                {
                    "candidate_spec_id": bridge_spec.candidate_spec_id,
                    "rank": 4,
                    "proposal_score": "6.0",
                },
            ),
            proposal_rows=(),
            evidence_bundles=(
                weak_evidence,
                close_evidence,
                bridge_evidence,
                raw_only_evidence,
            ),
            portfolio=None,
            promotion_readiness={"promotable": False},
            runtime_closure={},
            paper_probation_target_limit=2,
        )

        probation_candidate = board["paper_probation_candidate"]
        self.assertEqual(probation_candidate["candidate_id"], "cand-close-probation")
        self.assertEqual(board["paper_probation_target_limit"], 2)
        self.assertEqual(
            [
                candidate["candidate_id"]
                for candidate in board["paper_probation_candidates"]
            ],
            ["cand-close-probation", "cand-bridge-probation"],
        )
        self.assertEqual(
            probation_candidate["selection_reason"],
            "closest_lower_bound_economics_below_target",
        )
        self.assertEqual(
            probation_candidate["probation_lower_bound_net_pnl_per_day"], "430"
        )
        self.assertEqual(probation_candidate["probation_target_shortfall"], "70")
        self.assertEqual(probation_candidate["probation_target_progress_ratio"], "0.86")
        self.assertEqual(
            probation_candidate["required_notional_repair_scale_to_target"], "1.1628"
        )
        self.assertIn(
            "post_cost_costs_tca_and_execution_shortfall",
            probation_candidate["live_paper_evidence_requirements"],
        )
        self.assertIn(
            "verify_closed_flat_positions_and_broker_runtime_ledger_reconciliation",
            probation_candidate["safe_evidence_collection_path"],
        )
        self.assertFalse(probation_candidate["live_capital_authorized"])
        self.assertEqual(
            probation_candidate["deployable_lower_bound_missing_count"],
            0,
        )
        self.assertFalse(probation_candidate["final_promotion_allowed"])
        self.assertEqual(board["runtime_window_import_plan"]["target_count"], 2)
        self.assertEqual(
            [
                target["candidate_id"]
                for target in board["runtime_window_import_plan"]["targets"]
            ],
            ["cand-close-probation", "cand-bridge-probation"],
        )

    def test_candidate_board_paper_probation_requires_runtime_ledger_admission(
        self,
    ) -> None:
        generic_row = {
            "candidate_spec_id": "spec-generic-paper",
            "candidate_id": "cand-generic-paper",
            "hypothesis_id": "hyp-generic-paper",
            "runtime_family": "microbar_cross_sectional_pairs",
            "runtime_strategy_name": "microbar_cross_sectional_pairs-runtime",
            "replay_artifact_refs": ["generic-replay.json"],
        }
        ledger_row = {
            **generic_row,
            "candidate_spec_id": "spec-ledger-paper",
            "candidate_id": "cand-ledger-paper",
            "exact_replay_ledger_artifact_ref": "ledger-exact-replay-ledger.json",
            "exact_replay_ledger_artifact_row_count": 18,
            "exact_replay_ledger_artifact_fill_count": 6,
            "runtime_window_start": "2026-05-18",
            "runtime_window_end": "2026-05-20",
        }

        self.assertEqual(
            runner._candidate_board_paper_probation_admission_blockers(generic_row),
            [
                "paper_probation_exact_replay_ledger_artifact_missing",
                "paper_probation_exact_replay_ledger_row_count_missing",
                "paper_probation_exact_replay_ledger_fill_count_missing",
                "paper_probation_runtime_window_bounds_missing",
            ],
        )
        self.assertEqual(
            runner._candidate_board_paper_probation_admission_blockers(ledger_row),
            [],
        )

    def test_candidate_board_single_paper_probation_fallback_blocker(self) -> None:
        row = {
            "candidate_spec_id": "spec-single-probation",
            "candidate_id": "cand-single-probation",
            "hypothesis_id": "H-MICRO-01",
            "runtime_family": "microstructure_breakout",
            "runtime_strategy_name": "microbar-volume-continuation-long-top2-chip-v1",
            "has_replay_evidence": True,
            "oracle_passed": False,
            "target_met": False,
            "decision_count": 4,
            "submitted_order_count": 4,
            "filled_order_count": 4,
            "exact_replay_ledger_artifact_ref": "single-exact-replay-ledger.json",
            "exact_replay_ledger_artifact_row_count": 12,
            "exact_replay_ledger_artifact_fill_count": 4,
            "runtime_window_start": "2026-05-18",
            "runtime_window_end": "2026-05-20",
            "net_pnl_per_day": "215",
            "market_impact_stress_passed": True,
            "market_impact_stress_net_pnl_per_day": "190",
            "delay_adjusted_depth_stress_passed": True,
            "delay_adjusted_depth_stress_net_pnl_per_day": "180",
            "post_cost_net_pnl_after_queue_position_survival_fill_stress": "170",
            "double_oos_passed": True,
            "double_oos_cost_shock_net_pnl_per_day": "175",
            "implementation_uncertainty_stability_passed": True,
            "implementation_uncertainty_lower_net_pnl_per_day": "165",
            "conformal_tail_risk_passed": True,
            "conformal_tail_risk_adjusted_net_pnl_per_day": "160",
            "delay_adjusted_depth_fill_survival_evidence_present": True,
            "delay_adjusted_depth_fill_survival_sample_count": 4,
            "delay_adjusted_depth_fill_survival_rate": "0.85",
            "queue_position_survival_fill_curve_evidence_present": True,
            "queue_position_survival_sample_count": 4,
            "queue_position_survival_fill_rate": "0.85",
            "queue_position_survival_queue_ratio_p95": "0.25",
            "queue_position_survival_queue_ahead_depletion_evidence_present": True,
            "queue_position_survival_queue_ahead_depletion_sample_count": 4,
            "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
            "delay_adjusted_depth_queue_ahead_depletion_sample_count": 4,
            "queue_ahead_depletion_evidence_present": True,
            "queue_ahead_depletion_sample_count": 4,
            "blockers": [],
        }

        candidate = runner._candidate_board_paper_probation_candidate(
            [row],
            target=Decimal("500"),
        )

        self.assertIsNotNone(candidate)
        assert candidate is not None
        self.assertEqual(candidate["candidate_id"], "cand-single-probation")
        self.assertEqual(
            candidate["final_promotion_blockers"],
            ["final_promotion_requires_runtime_governance"],
        )
        self.assertFalse(candidate["final_promotion_allowed"])
        self.assertIsNone(
            runner._candidate_board_paper_probation_candidate(
                [],
                target=Decimal("500"),
            )
        )

    def test_candidate_board_runtime_window_plan_dedupes_and_blocks_incomplete_targets(
        self,
    ) -> None:
        row = {
            "candidate_spec_id": "spec-runtime-plan",
            "candidate_id": "cand-runtime-plan",
            "hypothesis_id": "H-MICRO-01",
            "runtime_family": "microstructure_breakout",
            "runtime_strategy_name": "microbar-volume-continuation-long-top2-chip-v1",
            "dataset_snapshot_id": "snapshot-runtime-plan",
            "replay_artifact_refs": [
                "paper-runtime-plan.json",
                "paper-runtime-plan-exact-replay-ledger.json",
            ],
            "exact_replay_ledger_artifact_ref": "paper-runtime-plan-exact-replay-ledger.json",
            "exact_replay_ledger_artifact_row_count": 36,
            "exact_replay_ledger_artifact_fill_count": 12,
            "runtime_window_start": "2026-05-18T13:30:00+00:00",
            "runtime_window_end": "2026-05-20T20:00:00+00:00",
            "account_label": "TORGHUT_REPLAY",
            "blockers": ["delay_adjusted_depth_tail_coverage_passed_failed"],
        }
        fallback_row = {
            "candidate_spec_id": "spec-runtime-plan-fallback",
            "candidate_id": "cand-runtime-plan-fallback",
            "hypothesis_id": "H-MICRO-02",
            "runtime_family": "microstructure_breakout",
            "runtime_strategy_name": "microbar-volume-continuation-long-top2-chip-v1",
            "dataset_snapshot_id": "snapshot-runtime-plan-fallback",
            "exact_replay_ledger_artifact_refs": "fallback-exact-replay-ledger.json",
            "runtime_window_start": "2026-05-21T13:30:00+00:00",
            "runtime_window_end": "2026-05-21T20:00:00+00:00",
        }

        plan = runner._candidate_board_runtime_window_import_plan(
            rows=(row,),
            paper_probation_candidate=row,
            promotion_subject={
                "target_met": True,
                "sleeve_candidate_spec_ids": ["spec-runtime-plan"],
            },
        )
        fallback_plan = runner._candidate_board_runtime_window_import_plan(
            rows=(),
            paper_probation_candidate=fallback_row,
            promotion_subject=None,
        )
        incomplete_plan = runner._candidate_board_runtime_window_import_plan(
            rows=(),
            paper_probation_candidate={
                "candidate_spec_id": "spec-incomplete",
                "candidate_id": "",
                "hypothesis_id": "",
                "runtime_family": "microstructure_breakout",
                "runtime_strategy_name": "microbar-volume-continuation-long-top2-chip-v1",
            },
            promotion_subject=None,
        )

        self.assertEqual(
            runner._candidate_board_hypothesis_manifest_ref(None),
            "",
        )
        self.assertEqual(
            runner._candidate_board_runtime_window_bounds(
                {
                    "runtime_window_start": "2026-05-01",
                    "runtime_window_end": "2026-05-02",
                }
            ),
            ("2026-05-01", "2026-05-02"),
        )
        self.assertEqual(plan["target_count"], 1)
        self.assertEqual(
            plan["targets"][0]["source_manifest_ref"],
            "config/trading/hypotheses/h-micro-01.json",
        )
        self.assertEqual(plan["targets"][0]["candidate_blockers"], row["blockers"])
        self.assertEqual(
            plan["targets"][0]["exact_replay_ledger_artifact_refs"],
            ["paper-runtime-plan-exact-replay-ledger.json"],
        )
        self.assertNotIn("runtime_ledger_artifact_refs", plan["targets"][0])
        self.assertEqual(
            plan["targets"][0]["window_start"], "2026-05-18T13:30:00+00:00"
        )
        self.assertEqual(plan["targets"][0]["window_end"], "2026-05-20T20:00:00+00:00")
        self.assertEqual(plan["targets"][0]["account_label"], "TORGHUT_REPLAY")
        self.assertIn(
            "paper-runtime-plan-exact-replay-ledger.json",
            plan["targets"][0]["import_command_args"],
        )
        self.assertIn(
            "--target-metadata-json",
            plan["targets"][0]["import_command_args"],
        )
        metadata_arg_index = (
            plan["targets"][0]["import_command_args"].index("--target-metadata-json")
            + 1
        )
        import_metadata = json.loads(
            plan["targets"][0]["import_command_args"][metadata_arg_index]
        )
        self.assertEqual(
            import_metadata["exact_replay_ledger_artifact_refs"],
            ["paper-runtime-plan-exact-replay-ledger.json"],
        )
        self.assertNotIn("runtime_ledger_artifact_refs", import_metadata)
        self.assertEqual(import_metadata["exact_replay_ledger_artifact_row_count"], 36)
        self.assertEqual(import_metadata["exact_replay_ledger_artifact_fill_count"], 12)
        self.assertEqual(import_metadata["window_start"], "2026-05-18T13:30:00+00:00")
        self.assertEqual(import_metadata["window_end"], "2026-05-20T20:00:00+00:00")
        self.assertEqual(fallback_plan["status"], "ready")
        self.assertEqual(fallback_plan["target_count"], 1)
        self.assertEqual(
            fallback_plan["targets"][0]["exact_replay_ledger_artifact_refs"],
            ["fallback-exact-replay-ledger.json"],
        )
        self.assertEqual(
            fallback_plan["targets"][0]["exact_replay_ledger_artifact_ref"],
            "fallback-exact-replay-ledger.json",
        )
        self.assertNotIn("runtime_ledger_artifact_ref", fallback_plan["targets"][0])
        self.assertEqual(
            fallback_plan["targets"][0]["account_label"],
            "TORGHUT_REPLAY",
        )
        self.assertEqual(incomplete_plan["status"], "blocked")
        self.assertEqual(incomplete_plan["target_count"], 0)
        self.assertEqual(
            incomplete_plan["blockers"][0]["missing_fields"],
            [
                "candidate_id",
                "hypothesis_id",
                "window_start",
                "window_end",
                "account_label",
            ],
        )

    def test_candidate_universe_symbols_default_to_chip_coverage_when_empty(
        self,
    ) -> None:
        symbols = runner._candidate_universe_symbols_from_args(
            Namespace(symbols="MSFT,SHOP")
        )

        self.assertEqual(symbols, tuple(_CHIP_UNIVERSE))

    def test_full_chip_universe_is_compile_allowlist_not_profile_override(
        self,
    ) -> None:
        self.assertEqual(
            runner._candidate_universe_symbols_for_compilation(
                Namespace(symbols=",".join(_CHIP_UNIVERSE))
            ),
            (),
        )
        self.assertEqual(
            runner._candidate_universe_symbols_for_compilation(
                Namespace(symbols="MSFT,SHOP")
            ),
            (),
        )
        self.assertEqual(
            runner._candidate_universe_symbols_for_compilation(
                Namespace(symbols="NVDA,AMAT,AAPL")
            ),
            ("NVDA", "AAPL"),
        )

    def test_rejects_candidate_universe_larger_than_twelve_symbols(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            args = self._args(output_dir)
            args.symbols = "A,B,C,D,E,F,G,H,I,J,K,L,M"

            payload = runner.run_whitepaper_autoresearch_profit_target(args)

        self.assertEqual(payload["status"], "invalid_universe")
        self.assertEqual(payload["failure_reason"], "candidate_universe_too_large:13")
        self.assertFalse((output_dir / "candidate-specs.jsonl").exists())

    def test_seed_recent_whitepapers_honors_top_k_and_exploration_budget(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir, _compact_recent_whitepaper_sources(4):
            output_dir = Path(tmpdir) / "epoch"
            args = self._args(output_dir)
            args.top_k = 1
            args.exploration_slots = 1
            args.max_frontier_candidates_per_spec = 2
            args.max_total_frontier_candidates = 6
            payload = runner.run_whitepaper_autoresearch_profit_target(args)

            selection = json.loads(
                (output_dir / "candidate-selection-manifest.json").read_text(
                    encoding="utf-8"
                )
            )
            proposal_rows = [
                json.loads(line)
                for line in (output_dir / "mlx-proposal-scores.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
                if line
            ]
            pre_replay_rows = [
                json.loads(line)
                for line in (output_dir / "pre-replay-mlx-proposal-scores.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
                if line
            ]

        self.assertEqual(payload["status"], "no_profit_target_candidate")
        self.assertEqual(
            payload["profit_target_oracle_policy"]["min_daily_net_pnl"], "-999999999"
        )
        self.assertEqual(selection["budget"]["exploration_slots_requested"], 1)
        self.assertGreaterEqual(selection["budget"]["exploration_slots_effective"], 1)
        self.assertEqual(selection["budget"]["selected_count"], 3)
        self.assertEqual(payload["replay_candidate_spec_count"], 3)
        self.assertEqual(payload["evidence_bundle_count"], 3)
        self.assertGreater(payload["candidate_spec_count"], args.max_candidates)
        self.assertEqual(
            selection["budget"]["compiled_candidate_count"],
            payload["candidate_spec_count"],
        )
        self.assertTrue(payload["best_false_negative_table"])
        self.assertEqual(
            payload["best_false_negative_table"][0]["evidence_status"], "not_replayed"
        )
        self.assertFalse(payload["best_false_negative_table"][0]["selected_for_replay"])
        selected_rows = [row for row in selection["rows"] if row["selected_for_replay"]]
        self.assertGreater(selection["budget"]["capital_feasible_candidate_count"], 0)
        self.assertTrue(
            all(row["capital_budget"]["capital_feasible"] for row in selected_rows)
        )
        selected_reasons = {row["selection_reason"] for row in selected_rows}
        self.assertIn("runtime_strategy_floor", selected_reasons)
        self.assertLessEqual(
            selected_reasons,
            {
                "runtime_strategy_floor",
                "exploitation",
                "exploration",
                "budget_backfill",
            },
        )
        proposal_selected = [row for row in proposal_rows if row["selected_for_replay"]]
        self.assertEqual(len(proposal_selected), 3)
        proposal_reasons = {row["replay_selection_reason"] for row in proposal_selected}
        self.assertIn("runtime_strategy_floor", proposal_reasons)
        self.assertLessEqual(
            proposal_reasons,
            {
                "runtime_strategy_floor",
                "exploitation",
                "exploration",
                "budget_backfill",
            },
        )
        self.assertEqual(len(pre_replay_rows), payload["candidate_spec_count"])
        self.assertEqual(
            {row["selection_reason"] for row in pre_replay_rows},
            {"pre_replay_mlx_rank"},
        )

    def test_best_false_negative_table_excludes_pre_replay_blocked_specs(self) -> None:
        table = runner._best_false_negative_table(
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": "spec-feedback-blocked",
                        "rank": 1,
                        "selected_for_replay": False,
                        "selection_reason": "pre_replay_mlx_feedback_blocked",
                    },
                    {
                        "candidate_spec_id": "spec-capital-blocked",
                        "rank": 2,
                        "selected_for_replay": False,
                        "selection_reason": "pre_replay_capital_budget_blocked",
                    },
                    {
                        "candidate_spec_id": "spec-negative-prior",
                        "rank": 3,
                        "selected_for_replay": False,
                        "selection_reason": "pre_replay_mlx_synthetic_nonpositive_expected_value",
                    },
                    {
                        "candidate_spec_id": "spec-duplicate",
                        "rank": 4,
                        "selected_for_replay": False,
                        "selection_reason": "duplicate_execution_signature",
                    },
                    {
                        "candidate_spec_id": "spec-clean-budget-miss",
                        "rank": 5,
                        "selected_for_replay": False,
                        "selection_reason": "not_selected_budget",
                    },
                ]
            },
            pre_replay_proposal_rows=[
                {
                    "candidate_spec_id": "spec-clean-budget-miss",
                    "proposal_score": 25,
                }
            ],
            evidence_bundles=(),
        )

        self.assertEqual(len(table), 1)
        self.assertEqual(table[0]["candidate_spec_id"], "spec-clean-budget-miss")
        self.assertEqual(table[0]["reason"], "not_replayed_budget")

    def test_seed_recent_whitepapers_diversifies_exploitation_slots(self) -> None:
        with TemporaryDirectory() as tmpdir, _compact_recent_whitepaper_sources(4):
            output_dir = Path(tmpdir) / "epoch"
            args = self._args(output_dir)
            args.top_k = 3
            args.exploration_slots = 0
            args.max_frontier_candidates_per_spec = 2
            args.max_total_frontier_candidates = 6
            payload = runner.run_whitepaper_autoresearch_profit_target(args)

            selection = json.loads(
                (output_dir / "candidate-selection-manifest.json").read_text(
                    encoding="utf-8"
                )
            )

        self.assertEqual(payload["status"], "no_profit_target_candidate")
        replay_rows = sorted(
            [row for row in selection["rows"] if row["selected_for_replay"]],
            key=lambda row: row["replay_order"],
        )
        self.assertEqual(len(replay_rows), 3)
        self.assertGreater(
            sum(
                1
                for row in replay_rows
                if row["selection_reason"] == "runtime_strategy_floor"
            ),
            0,
        )
        self.assertGreater(
            len({row["runtime_strategy_name"] for row in replay_rows}),
            1,
        )
        self.assertEqual(
            selection["selected_candidate_spec_ids"],
            [row["candidate_spec_id"] for row in replay_rows],
        )
        self.assertEqual([row["replay_order"] for row in replay_rows], [1, 2, 3])
        self.assertGreater(
            len({row["family_template_id"] for row in replay_rows[:2]}),
            1,
        )

    def test_candidate_selection_reserves_distinct_runtime_strategy_floor(
        self,
    ) -> None:
        breakout_primary = replace(
            self._candidate_spec(
                "spec-breakout-primary",
                family_template_id="microstructure_continuation_matched_filter_v1",
            ),
            runtime_family="breakout_continuation_consistent",
            runtime_strategy_name="breakout-continuation-long-v1",
        )
        breakout_secondary = replace(
            self._candidate_spec(
                "spec-breakout-secondary",
                family_template_id="opening_drive_leader_reclaim_v1",
            ),
            runtime_family="breakout_continuation_consistent",
            runtime_strategy_name="breakout-continuation-long-v1",
        )
        intraday = replace(
            self._candidate_spec(
                "spec-intraday", family_template_id="intraday_tsmom_v2"
            ),
            runtime_family="intraday_tsmom_consistent",
            runtime_strategy_name="intraday-tsmom-profit-v3",
        )
        late_day = replace(
            self._candidate_spec(
                "spec-late-day", family_template_id="late_day_continuation_v1"
            ),
            runtime_family="late_day_continuation_consistent",
            runtime_strategy_name="late-day-continuation-long-v1",
        )

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(breakout_primary, breakout_secondary, intraday, late_day),
            proposal_rows=[
                {
                    "candidate_spec_id": breakout_primary.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": 100.0,
                    "selection_reason": "pre_replay_mlx_rank",
                },
                {
                    "candidate_spec_id": breakout_secondary.candidate_spec_id,
                    "rank": 2,
                    "proposal_score": 99.0,
                    "selection_reason": "pre_replay_mlx_rank",
                },
                {
                    "candidate_spec_id": intraday.candidate_spec_id,
                    "rank": 3,
                    "proposal_score": 10.0,
                    "selection_reason": "pre_replay_mlx_rank",
                },
                {
                    "candidate_spec_id": late_day.candidate_spec_id,
                    "rank": 4,
                    "proposal_score": 5.0,
                    "selection_reason": "pre_replay_mlx_rank",
                },
            ],
            top_k=2,
            exploration_slots=0,
            max_candidates=3,
            portfolio_size_min=2,
        )

        selected_runtime_names = {spec.runtime_strategy_name for spec in selected}
        self.assertEqual(
            selected_runtime_names,
            {
                "breakout-continuation-long-v1",
                "intraday-tsmom-profit-v3",
                "late-day-continuation-long-v1",
            },
        )
        row_by_spec = {row["candidate_spec_id"]: row for row in selection["rows"]}
        self.assertEqual(
            row_by_spec[intraday.candidate_spec_id]["selection_reason"],
            "runtime_strategy_floor",
        )
        self.assertEqual(
            row_by_spec[late_day.candidate_spec_id]["selection_reason"],
            "runtime_strategy_floor",
        )
        self.assertEqual(
            selection["budget"]["runtime_strategy_floor_selected_count"],
            3,
        )

    def test_seed_recent_whitepapers_dedupes_execution_signatures(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            args = self._source_jsonl_args(output_dir, source_count=2)
            args.top_k = 6
            args.exploration_slots = 4
            payload = runner.run_whitepaper_autoresearch_profit_target(args)

            selection = json.loads(
                (output_dir / "candidate-selection-manifest.json").read_text(
                    encoding="utf-8"
                )
            )

        self.assertEqual(payload["status"], "no_profit_target_candidate")
        selected_rows = [row for row in selection["rows"] if row["selected_for_replay"]]
        duplicate_rows = [
            row
            for row in selection["rows"]
            if row["selection_reason"] == "duplicate_execution_signature"
        ]
        self.assertEqual(
            len({row["execution_signature"] for row in selected_rows}),
            len(selected_rows),
        )
        self.assertGreater(len(duplicate_rows), 0)
        self.assertGreaterEqual(
            selection["budget"]["unique_execution_signature_count"],
            len(selected_rows),
        )
        self.assertLessEqual(len(selected_rows), args.max_candidates)
        self.assertEqual(payload["replay_candidate_spec_count"], len(selected_rows))
