from __future__ import annotations

import app.trading.discovery.evidence_bundles as evidence_bundles

from tests.whitepaper_autoresearch.autoresearch_runner_base import (
    Decimal,
    Path,
    WhitepaperAutoresearchRunnerTestCaseBase,
    json,
    replace,
    runner,
)


class TestAutoresearchRunnerPaperProbationA(WhitepaperAutoresearchRunnerTestCaseBase):
    def test_candidate_board_surfaces_paper_probation_without_promotion(
        self,
    ) -> None:
        spec = self._candidate_spec("spec-paper-probation")
        evidence = evidence_bundles.CandidateEvidenceBundle(
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
        weak_evidence = evidence_bundles.CandidateEvidenceBundle(
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
        close_evidence = evidence_bundles.CandidateEvidenceBundle(
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
        raw_only_evidence = evidence_bundles.CandidateEvidenceBundle(
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
