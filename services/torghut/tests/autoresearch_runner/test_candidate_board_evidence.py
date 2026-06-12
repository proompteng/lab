from __future__ import annotations

from dataclasses import replace
from decimal import Decimal
from pathlib import Path


import scripts.run_whitepaper_autoresearch_profit_target as runner
from tests.autoresearch_runner.helpers import (
    AutoresearchRunnerTestCase,
)


class TestAutoresearchRunnerCandidateBoardEvidence(AutoresearchRunnerTestCase):
    def test_candidate_board_adds_factor_acceptance_replay_metadata(self) -> None:
        spec = replace(
            self._candidate_spec("spec-factor-acceptance"),
            feature_contract={
                "mechanism": "rankic signal discovery",
                "required_features": ("cross_section_session_open_rank", "spread_bps"),
                "factor_acceptance_artifact": {
                    "status": "rejected",
                    "factor_expression": "cross_section_session_open_rank",
                    "source_idea": "static_rankic_compile_contract",
                    "allowed_feature_dependencies": [
                        "cross_section_session_open_rank",
                        "spread_bps",
                    ],
                    "rejection_reasons": ["rank_ic_below_floor"],
                    "lineage_hash": "static-factor-lineage",
                },
            },
            parameter_space={
                "mechanism_overlay_ids": ["rankic_factor_acceptance_harness"]
            },
        )
        evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-factor-acceptance",
            candidate_id="candidate-factor-acceptance",
            candidate_spec_id=spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-factor-acceptance",
            feature_spec_hash="feature-hash",
            code_commit="commit-sha",
            replay_artifact_refs=("replay-factor.json",),
            objective_scorecard={
                "rank_ic": "0.061",
                "rank_ir": "0.71",
                "p_value": "0.006",
                "decision_count": 144,
                "net_pnl_per_day": "34",
                "avg_filled_notional_per_day": "100000",
                "market_impact_stress_cost_bps": "1.8",
                "train_window": {"start": "2026-01-02", "end": "2026-03-31"},
                "holdout_window": {"start": "2026-04-01", "end": "2026-04-30"},
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={},
            null_comparator={},
            promotion_readiness={},
        )

        board = runner._candidate_board_payload(
            epoch_id="epoch-factor-acceptance",
            output_dir=Path("/tmp/torghut-factor-acceptance"),
            target=Decimal("500"),
            candidate_specs=[spec],
            candidate_selection={
                "budget": {"compiled_candidate_count": 4},
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                        "selection_reason": "top_k",
                        "rank": 1,
                    }
                ],
            },
            pre_replay_proposal_rows=[
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": "0.9",
                }
            ],
            proposal_rows=[
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": "0.9",
                }
            ],
            evidence_bundles=[evidence],
            portfolio=None,
            promotion_readiness={"promotable": False},
            runtime_closure={"status": "blocked"},
        )

        row = board["rows"][0]
        metadata = row["factor_acceptance_replay_metadata"]
        artifact = metadata["replay_artifact"]

        self.assertEqual(board["factor_acceptance_summary"]["accepted_count"], 1)
        self.assertEqual(metadata["status"], "accepted")
        self.assertEqual(metadata["evidence_status"], "replayed")
        self.assertFalse(metadata["promotion_allowed"])
        self.assertFalse(metadata["final_promotion_authorized"])
        self.assertEqual(artifact["deflated_p_value"], "0.024")
        self.assertEqual(artifact["cost_stressed_net_expectancy_bps"], "1.60000")
        self.assertFalse(row["factor_acceptance_promotion_allowed"])
        self.assertEqual(board["current_answer"], "no_promotion_ready_candidate")

    def test_paper_mechanism_contract_prior_selects_replay_only_candidate(
        self,
    ) -> None:
        control_spec = self._candidate_spec(
            "spec-paper-control",
            family_template_id="breakout_reclaim_v2",
            entry_minute_after_open="75",
            selection_mode="continuation",
        )
        paper_spec_base = self._candidate_spec(
            "spec-paper-contract",
            family_template_id="breakout_reclaim_v2",
            entry_minute_after_open="75",
            selection_mode="continuation",
        )
        paper_spec = replace(
            paper_spec_base,
            feature_contract={
                **paper_spec_base.feature_contract,
                "source_claims": [
                    {
                        "claim_id": "claim-route-tca",
                        "claim_type": "execution_assumption",
                        "data_requirements": ["route_tca", "execution_shortfall"],
                    },
                    {
                        "claim_id": "claim-live-parity",
                        "claim_type": "validation_requirement",
                        "data_requirements": ["live_paper_parity"],
                    },
                ],
                "validation_requirements": [
                    {
                        "claim_id": "validate-fill-curve",
                        "claim_type": "validation_requirement",
                        "data_requirements": [
                            "fill_outcomes",
                            "runtime_ledger",
                        ],
                    }
                ],
                "mechanism_overlays": [
                    {
                        "overlay_id": "queue_position_survival_fill_curve",
                        "required_evidence": [
                            "queue_position_survival_fill_curve",
                            "order_lifecycle_fill_evidence",
                        ],
                    }
                ],
            },
            parameter_space={
                "mechanism_overlay_ids": [
                    "mixed_market_limit_execution_policy",
                    "queue_position_survival_fill_curve",
                ]
            },
            promotion_contract={
                "requires_route_tca": True,
                "requires_live_paper_parity": True,
                "requires_runtime_ledger": True,
                "rejects_synthetic_evidence": True,
            },
        )

        self.assertGreater(
            runner._pre_replay_candidate_score(paper_spec),
            runner._pre_replay_candidate_score(control_spec),
        )

        prior_bundle = runner._pre_replay_prior_bundle(paper_spec)
        self.assertFalse(prior_bundle.promotion_readiness["promotable"])
        self.assertIn(
            "runtime_replay_required", prior_bundle.promotion_readiness["blockers"]
        )
        self.assertIn(
            "validation_live_paper_parity_pending",
            prior_bundle.promotion_readiness["blockers"],
        )

        _model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(control_spec, paper_spec),
        )
        row_by_spec = {row["candidate_spec_id"]: row for row in rows}

        self.assertGreater(
            Decimal(str(row_by_spec[paper_spec.candidate_spec_id]["proposal_score"])),
            Decimal(str(row_by_spec[control_spec.candidate_spec_id]["proposal_score"])),
        )
        self.assertLess(
            row_by_spec[paper_spec.candidate_spec_id]["rank"],
            row_by_spec[control_spec.candidate_spec_id]["rank"],
        )

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(control_spec, paper_spec),
            proposal_rows=rows,
            top_k=1,
            exploration_slots=0,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [paper_spec])
        self.assertEqual(
            selection["selected_candidate_spec_ids"], [paper_spec.candidate_spec_id]
        )
        paper_selection_row = next(
            row
            for row in selection["rows"]
            if row["candidate_spec_id"] == paper_spec.candidate_spec_id
        )
        control_selection_row = next(
            row
            for row in selection["rows"]
            if row["candidate_spec_id"] == control_spec.candidate_spec_id
        )
        self.assertTrue(paper_selection_row["selected_for_replay"])
        self.assertEqual(paper_selection_row["selection_reason"], "exploitation")
        self.assertEqual(
            control_selection_row["selection_reason"], "duplicate_execution_signature"
        )
        self.assertGreater(
            Decimal(str(paper_selection_row["paper_contract_prior_score"])),
            Decimal("0"),
        )
        self.assertEqual(
            paper_selection_row["paper_mechanism_overlay_ids"],
            [
                "mixed_market_limit_execution_policy",
                "queue_position_survival_fill_curve",
            ],
        )
        self.assertIn(
            "route_tca", paper_selection_row["paper_required_evidence_tokens"]
        )
        self.assertIn(
            "live_paper_parity", paper_selection_row["paper_required_evidence_tokens"]
        )
        self.assertGreaterEqual(paper_selection_row["paper_required_evidence_count"], 6)
        self.assertEqual(
            selection["budget"]["paper_contract_candidate_selected_count"], 0
        )

        exploration_selected, exploration_selection = (
            runner._select_candidate_specs_for_replay(
                specs=(control_spec, paper_spec),
                proposal_rows=rows,
                top_k=0,
                exploration_slots=1,
                max_candidates=1,
                portfolio_size_min=1,
            )
        )

        self.assertEqual(exploration_selected, [paper_spec])
        self.assertEqual(
            exploration_selection["budget"]["paper_contract_candidate_selected_count"],
            1,
        )
        exploration_paper_row = next(
            row
            for row in exploration_selection["rows"]
            if row["candidate_spec_id"] == paper_spec.candidate_spec_id
        )
        self.assertEqual(
            exploration_paper_row["selection_reason"], "paper_contract_exploration"
        )

    def test_candidate_board_helpers_keep_blockers_explicit(self) -> None:
        spec = replace(
            self._candidate_spec("spec-regime-diagnostics"),
            hard_vetoes={"required_min_regime_slice_pass_rate": "0.45"},
            feature_contract={
                "source_claims": [
                    {
                        "claim_id": "risk-sensitive-routing",
                        "claim_type": "market_regime",
                    },
                    {
                        "claim_id": "vvg-validation",
                        "claim_type": "validation_requirement",
                    },
                ]
            },
        )
        evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-test",
            candidate_id="candidate-test",
            candidate_spec_id="spec-test",
            dataset_snapshot_id="snapshot-test",
            feature_spec_hash="hash-test",
            code_commit="commit-test",
            replay_artifact_refs=("replay.json",),
            objective_scorecard={},
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={},
            null_comparator={},
            promotion_readiness={},
        )

        self.assertEqual(runner._candidate_board_int_field({"bad": object()}, "bad"), 0)
        self.assertEqual(
            runner._candidate_board_market_impact_proof_summary(
                {
                    "market_impact_stress_model": "almgren_chriss_proxy",
                    "market_impact_stress_cost_bps": "150",
                    "market_impact_stress_net_pnl_per_day": "510",
                    "market_impact_stress_artifact_ref": "/tmp/impact.json",
                    "market_impact_stress_components": {
                        "source_marker": "realistic_market_impact_arxiv_2603_29086_2026",
                        "source_markers": [
                            "double_square_root_impact_arxiv_2502_16246_2025",
                            "realistic_market_impact_arxiv_2603_29086_2026",
                        ],
                        "selected_model": "almgren_chriss_proxy",
                        "selected_cost_bps": "150",
                    },
                    "nonlinear_market_impact_stress_passed": True,
                }
            )["state"],
            "passed",
        )
        self.assertIn(
            "double_square_root_impact_arxiv_2502_16246_2025",
            runner._candidate_board_market_impact_proof_summary(
                {
                    "market_impact_stress_model": "almgren_chriss_proxy",
                    "market_impact_stress_cost_bps": "150",
                    "market_impact_stress_net_pnl_per_day": "510",
                    "market_impact_stress_artifact_ref": "/tmp/impact.json",
                    "market_impact_stress_components": {
                        "source_marker": "realistic_market_impact_arxiv_2603_29086_2026",
                        "source_markers": [
                            "double_square_root_impact_arxiv_2502_16246_2025",
                            "realistic_market_impact_arxiv_2603_29086_2026",
                        ],
                        "selected_model": "almgren_chriss_proxy",
                        "selected_cost_bps": "150",
                    },
                    "nonlinear_market_impact_stress_passed": True,
                }
            )["source_markers"],
        )
        missing_impact = runner._candidate_board_market_impact_proof_summary(
            {"target_met": True}
        )
        self.assertEqual(missing_impact["state"], "blocked")
        self.assertIn(
            "nonlinear_market_impact_components_missing",
            missing_impact["blockers"],
        )
        regime_summary = runner._candidate_board_regime_specialist_summary(
            spec, {"regime_slice_pass_rate": "0.30"}
        )
        self.assertEqual(regime_summary["state"], "blocked")
        self.assertIn(
            "regime_slice_pass_rate_below_specialist_threshold",
            regime_summary["blockers"],
        )
        self.assertEqual(
            regime_summary["regime_claim_ids"],
            ["risk-sensitive-routing", "vvg-validation"],
        )
        self.assertEqual(
            runner._candidate_board_blockers(
                selected_for_replay=True,
                evidence=None,
                scorecard={},
            ),
            ["replay_evidence_missing"],
        )
        self.assertEqual(
            runner._candidate_board_blockers(
                selected_for_replay=True,
                evidence=evidence,
                scorecard={"target_met": True, "oracle_passed": False},
            ),
            ["profit_target_oracle_failed"],
        )
        dirty_lineage = runner._candidate_board_evidence_lineage_summary(
            replace(evidence, code_commit="commit-test-dirty")
        )
        self.assertEqual(dirty_lineage["blockers"], ["code_commit_dirty"])
        self.assertEqual(
            runner._candidate_board_status(
                selected_for_replay=True,
                evidence=None,
                scorecard={},
                in_best_portfolio=False,
                portfolio_oracle_passed=False,
            ),
            "selected_pending_replay_evidence",
        )
        self.assertEqual(
            runner._candidate_board_status(
                selected_for_replay=True,
                evidence=evidence,
                scorecard={"oracle_passed": True},
                in_best_portfolio=False,
                portfolio_oracle_passed=False,
            ),
            "candidate_oracle_passed",
        )
        self.assertEqual(
            runner._candidate_board_status(
                selected_for_replay=True,
                evidence=evidence,
                scorecard={"target_met": True, "oracle_passed": False},
                in_best_portfolio=False,
                portfolio_oracle_passed=False,
            ),
            "blocked_by_oracle",
        )
        self.assertEqual(
            runner._candidate_board_status(
                selected_for_replay=True,
                evidence=evidence,
                scorecard={},
                in_best_portfolio=True,
                portfolio_oracle_passed=True,
            ),
            "portfolio_component_passed_oracle",
        )
        denied_readiness = runner._promotion_readiness_payload(
            oracle_candidate_found=True,
            status="ready_for_promotion_review",
            blockers=[],
            runtime_closure={
                "status": "ready_for_promotion_review",
                "next_required_steps": ["promotion_review"],
                "promotion_prerequisites": {
                    "allowed": False,
                    "reasons": ["promotion_gate_report_denied"],
                },
            },
        )
        self.assertFalse(denied_readiness["promotable"])
        self.assertEqual(
            denied_readiness["status"], "blocked_pending_promotion_prerequisites"
        )
        self.assertEqual(denied_readiness["blockers"], ["promotion_gate_report_denied"])
        allowed_readiness = runner._promotion_readiness_payload(
            oracle_candidate_found=True,
            status="ready_for_promotion_review",
            blockers=[],
            runtime_closure={
                "status": "ready_for_promotion_review",
                "next_required_steps": ["promotion_review"],
                "promotion_prerequisites": {"allowed": True, "reasons": []},
            },
        )
        self.assertTrue(allowed_readiness["promotable"])
        self.assertEqual(allowed_readiness["status"], "promotion_ready")

    def test_candidate_sleeve_goal_rows_carry_order_type_proof_refs(self) -> None:
        base_spec = self._candidate_spec("spec-sleeve-order-type-proof")
        spec = replace(
            base_spec,
            feature_contract={
                **base_spec.feature_contract,
                "source_claims": [
                    {
                        "claim_id": "route-tca-required",
                        "claim_type": "execution_assumption",
                        "data_requirements": ["route_tca"],
                    }
                ],
            },
            parameter_space={
                "mechanism_overlay_ids": ["mixed_market_limit_execution_policy"]
            },
            hard_vetoes={
                "required_order_type_ablation_passed": True,
                "required_min_order_type_ablation_sample_count": "60",
            },
            promotion_contract={
                "requires_order_type_execution_quality": True,
                "requires_market_limit_order_mix": True,
            },
        )
        evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-sleeve-order-type-proof",
            candidate_id="cand-sleeve-order-type-proof",
            candidate_spec_id=spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-sleeve-order-type-proof",
            feature_spec_hash="hash-sleeve-order-type-proof",
            code_commit="commit-test",
            replay_artifact_refs=(
                "replay.json",
                "order-type-ablation.json",
                "route-tca.json",
            ),
            objective_scorecard={
                "net_pnl_per_day": "640",
                "active_day_ratio": "1.0",
                "positive_day_ratio": "1.0",
                "order_type_ablation_passed": True,
                "order_type_ablation_artifact_ref": "order-type-ablation.json",
                "order_type_ablation_sample_count": 60,
                "market_limit_order_mix_evidence_present": True,
                "limit_fill_probability_evidence_present": True,
                "price_improvement_evidence_present": True,
                "opportunity_cost_evidence_present": True,
                "execution_shortfall_evidence_present": True,
                "route_tca_artifact_ref": "route-tca.json",
                "order_type_opportunity_cost_bps": "4",
                "market_order_spread_bps": "4",
                "exact_replay_ledger_artifact_ref": "sleeve-exact-replay-ledger.json",
                "exact_replay_ledger_artifact_row_count": 30,
                "exact_replay_ledger_artifact_fill_count": 10,
                "runtime_window_start": "2026-05-18T13:30:00+00:00",
                "runtime_window_end": "2026-05-18T20:00:00+00:00",
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "calibrated", "source": "route_tca"},
            null_comparator={},
            promotion_readiness={},
        )
        candidate_selection = {
            "rows": [
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "selected_for_replay": True,
                    "rank": 1,
                    "selection_reason": "paper_contract_exploration",
                    "paper_contract_prior_score": "29",
                    "paper_mechanism_overlay_ids": [
                        "mixed_market_limit_execution_policy"
                    ],
                    "paper_required_evidence_tokens": [
                        "route_tca",
                        "runtime_ledger",
                    ],
                    "paper_required_evidence_count": 2,
                }
            ]
        }

        rows = runner._candidate_sleeve_goal_rows(
            candidate_specs=(spec,),
            candidate_selection=candidate_selection,
            evidence_bundles=(evidence,),
            false_positive_table=(),
            best_false_negative_table=(),
            portfolio=None,
        )

        self.assertEqual(
            rows[0]["replay_artifact_refs"], list(evidence.replay_artifact_refs)
        )
        self.assertTrue(rows[0]["evidence_lineage"]["passed"])
        self.assertEqual(rows[0]["evidence_lineage"]["code_commit"], "commit-test")
        self.assertEqual(rows[0]["evidence_lineage"]["replay_artifact_ref_count"], 3)
        self.assertEqual(
            rows[0]["order_type_execution_quality"]["artifact_refs"],
            ["order-type-ablation.json"],
        )
        self.assertEqual(rows[0]["order_type_execution_quality"]["sample_count"], 60)
        self.assertTrue(rows[0]["order_type_execution_quality"]["passed"])
        self.assertEqual(
            rows[0]["replay_selection_reason"], "paper_contract_exploration"
        )
        self.assertTrue(rows[0]["paper_contract_candidate"])
        self.assertTrue(rows[0]["paper_contract_selected_for_replay"])
        self.assertEqual(rows[0]["paper_contract_prior_score"], "29")
        self.assertEqual(
            rows[0]["paper_mechanism_overlay_ids"],
            ["mixed_market_limit_execution_policy"],
        )
        self.assertEqual(
            rows[0]["paper_required_evidence_tokens"],
            ["route_tca", "runtime_ledger"],
        )
        self.assertEqual(rows[0]["paper_required_evidence_count"], 2)
        self.assertEqual(
            rows[0]["exact_replay_ledger_artifact_refs"],
            ["sleeve-exact-replay-ledger.json"],
        )
        self.assertEqual(
            rows[0]["exact_replay_ledger_artifact_ref"],
            "sleeve-exact-replay-ledger.json",
        )
        self.assertNotIn("runtime_ledger_artifact_ref", rows[0])
        self.assertNotIn("runtime_ledger_artifact_refs", rows[0])
        self.assertEqual(rows[0]["exact_replay_ledger_artifact_row_count"], 30)
        self.assertEqual(rows[0]["exact_replay_ledger_artifact_fill_count"], 10)
        self.assertEqual(rows[0]["runtime_window_start"], "2026-05-18T13:30:00+00:00")
        fallback_rows = runner._candidate_sleeve_goal_rows(
            candidate_specs=(spec,),
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                        "rank": 1,
                    }
                ]
            },
            evidence_bundles=(evidence,),
            false_positive_table=(),
            best_false_negative_table=(),
            portfolio=None,
        )
        self.assertGreater(
            Decimal(str(fallback_rows[0]["paper_contract_prior_score"])),
            Decimal("0"),
        )
        self.assertEqual(
            fallback_rows[0]["paper_mechanism_overlay_ids"],
            ["mixed_market_limit_execution_policy"],
        )
        self.assertIn("route_tca", fallback_rows[0]["paper_required_evidence_tokens"])
        self.assertGreater(fallback_rows[0]["paper_required_evidence_count"], 0)

        portfolio = runner.PortfolioCandidateSpec(
            schema_version="torghut.portfolio-candidate-spec.v1",
            portfolio_candidate_id="portfolio-sleeve-order-type-proof",
            source_candidate_ids=(evidence.candidate_id,),
            target_net_pnl_per_day=Decimal("500"),
            sleeves=(
                {
                    "candidate_id": evidence.candidate_id,
                    "candidate_spec_id": spec.candidate_spec_id,
                    "weight": "1",
                },
            ),
            capital_budget={},
            correlation_budget={},
            drawdown_budget={},
            evidence_refs=(),
            objective_scorecard={"target_met": True, "oracle_passed": True},
            optimizer_report={},
        )
        portfolio_rows = runner._candidate_sleeve_goal_rows(
            candidate_specs=(spec,),
            candidate_selection=candidate_selection,
            evidence_bundles=(evidence,),
            false_positive_table=(),
            best_false_negative_table=(),
            portfolio=portfolio,
        )

        self.assertEqual(portfolio_rows[0]["evidence_status"], "replayed")
        self.assertEqual(
            portfolio_rows[0]["replay_artifact_refs"],
            list(evidence.replay_artifact_refs),
        )
        self.assertTrue(portfolio_rows[0]["evidence_lineage"]["passed"])
        self.assertTrue(portfolio_rows[0]["order_type_execution_quality"]["passed"])
        self.assertEqual(portfolio_rows[0]["market_impact_proof"]["state"], "blocked")
        self.assertEqual(
            portfolio_rows[0]["replay_selection_reason"], "paper_contract_exploration"
        )
        self.assertTrue(portfolio_rows[0]["paper_contract_selected_for_replay"])
        self.assertEqual(
            portfolio_rows[0]["exact_replay_ledger_artifact_refs"],
            ["sleeve-exact-replay-ledger.json"],
        )
        self.assertNotIn("runtime_ledger_artifact_refs", portfolio_rows[0])

    def test_candidate_board_marks_portfolio_promotion_found_when_portfolio_oracle_passes(
        self,
    ) -> None:
        spec = self._candidate_spec("spec-portfolio-promotion-subject")
        evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-portfolio-promotion-subject",
            candidate_id="cand-portfolio-promotion-subject",
            candidate_spec_id=spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-portfolio-promotion-subject",
            feature_spec_hash="hash-portfolio-promotion-subject",
            code_commit="commit-test",
            replay_artifact_refs=("component-replay.json",),
            objective_scorecard={
                "target_met": False,
                "oracle_passed": False,
                "net_pnl_per_day": "260",
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={},
            null_comparator={},
            promotion_readiness={},
        )
        portfolio = runner.PortfolioCandidateSpec(
            schema_version="torghut.portfolio-candidate-spec.v1",
            portfolio_candidate_id="portfolio-promotion-subject",
            source_candidate_ids=(evidence.candidate_id,),
            target_net_pnl_per_day=Decimal("500"),
            sleeves=(
                {
                    "candidate_id": evidence.candidate_id,
                    "candidate_spec_id": spec.candidate_spec_id,
                    "weight": "1",
                },
            ),
            capital_budget={},
            correlation_budget={},
            drawdown_budget={},
            evidence_refs=("portfolio-replay.json",),
            objective_scorecard={
                "target_met": True,
                "oracle_passed": True,
                "net_pnl_per_day": "535",
                "market_impact_stress_artifact_ref": "portfolio-impact.json",
                "market_impact_stress_model": "almgren_chriss_proxy",
                "market_impact_stress_cost_bps": "8",
                "market_impact_stress_net_pnl_per_day": "515",
                "market_impact_stress_components": {
                    "source_marker": "realistic_market_impact_arxiv_2603_29086_2026",
                    "selected_model": "almgren_chriss_proxy",
                    "selected_cost_bps": "8",
                },
                "nonlinear_market_impact_stress_passed": True,
            },
            optimizer_report={},
        )

        board = runner._candidate_board_payload(
            epoch_id="epoch-portfolio-promotion-subject",
            output_dir=Path("/tmp/torghut-test"),
            target=Decimal("500"),
            candidate_specs=(spec,),
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                        "rank": 1,
                    }
                ]
            },
            pre_replay_proposal_rows=(),
            proposal_rows=(),
            evidence_bundles=(evidence,),
            portfolio=portfolio,
            promotion_readiness={"status": "promotion_ready", "promotable": True},
            runtime_closure={"status": "ready_for_promotion_review"},
        )

        self.assertEqual(board["current_answer"], "promotion_candidate_found")
        self.assertEqual(board["promotion_subject"]["type"], "portfolio")
        self.assertEqual(
            board["promotion_subject"]["portfolio_candidate_id"],
            "portfolio-promotion-subject",
        )
        self.assertTrue(board["promotion_subject"]["oracle_passed"])
        self.assertTrue(board["promotion_subject"]["promotable"])
        self.assertEqual(
            board["promotion_subject"]["market_impact_proof"]["state"], "passed"
        )
        self.assertFalse(board["closest_promotion_candidate"]["oracle_passed"])
        self.assertEqual(
            board["rows"][0]["status"], "portfolio_component_passed_oracle"
        )

    def test_candidate_board_fails_rejected_signal_candidate_without_labels(
        self,
    ) -> None:
        spec = replace(
            self._candidate_spec("spec-rejected-signal-proof"),
            parameter_space={
                "mechanism_overlay_ids": ["rejected_signal_outcome_calibration"]
            },
            hard_vetoes={
                "required_min_rejected_signal_outcome_label_count": "120",
                "required_min_rejected_signal_reason_coverage": "0.80",
                "required_max_rejected_signal_outcome_pending_ratio": "0.05",
                "required_rejected_signal_counterfactual_fields": [
                    "counterfactual_return",
                    "route_tca",
                    "post_cost_net_pnl",
                    "executable_quote",
                ],
                "required_rejected_signal_outcome_persistence_state": "ok",
            },
            promotion_contract={"requires_rejected_signal_outcome_learning": True},
        )
        evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-rejected-signal-proof",
            candidate_id="cand-rejected-signal-proof",
            candidate_spec_id=spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-rejected-signal-proof",
            feature_spec_hash="hash-rejected-signal-proof",
            code_commit="commit-test",
            replay_artifact_refs=("replay.json",),
            objective_scorecard={
                "net_pnl_per_day": "640",
                "target_met": True,
                "oracle_passed": True,
                "profit_target_oracle": {"blockers": []},
                "trade_decision_count": 9,
                "orders_submitted_count": 9,
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "provisional", "source": "paper_runtime"},
            null_comparator={},
            promotion_readiness={},
        )

        board = runner._candidate_board_payload(
            epoch_id="epoch-rejected-signal-board",
            output_dir=Path("/tmp/epoch-rejected-signal-board"),
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
        self.assertIn("rejected_signal_outcome_labeled_count_failed", row["blockers"])
        self.assertIn("rejected_signal_reason_coverage_failed", row["blockers"])
        self.assertIn(
            "rejected_signal_counterfactual_fields_present_failed", row["blockers"]
        )
        self.assertFalse(row["rejected_signal_outcome_learning"]["passed"])

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

    def test_candidate_sleeve_goal_proof_handoff_surfaces_runtime_ledger_materialization(
        self,
    ) -> None:
        spec = self._candidate_spec("spec-sleeve-runtime-ledger-handoff")
        runtime_ledger_handoff = {
            "materialization_status": "lineage_unmaterialized",
            "runtime_ledger_required": True,
            "zero_authoritative_daily_pnl_until_materialized": True,
            "required_artifacts": "runtime-ledger/daily-pnl.json",
        }
        evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-sleeve-runtime-ledger-handoff",
            candidate_id="cand-sleeve-runtime-ledger-handoff",
            candidate_spec_id=spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-sleeve-runtime-ledger-handoff",
            feature_spec_hash="hash-sleeve-runtime-ledger-handoff",
            code_commit="commit-test",
            replay_artifact_refs=("sleeve-runtime-ledger-handoff.json",),
            objective_scorecard={},
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={},
            null_comparator={},
            promotion_readiness={
                "runtime_ledger_lineage_materialization_handoff": (
                    runtime_ledger_handoff
                )
            },
        )

        proof_handoff = runner._candidate_sleeve_goal_proof_handoff_fields(
            selection={"selected_for_replay": True},
            spec=spec,
            scorecard=evidence.objective_scorecard,
            evidence=evidence,
            selected_for_replay=True,
        )

        self.assertEqual(
            proof_handoff["runtime_ledger_lineage_materialization_handoff"],
            runtime_ledger_handoff,
        )
        self.assertEqual(
            proof_handoff["runtime_ledger_required_materialized_artifacts"],
            ["runtime-ledger/daily-pnl.json"],
        )
        self.assertEqual(
            proof_handoff["runtime_ledger_materialization_status"],
            "lineage_unmaterialized",
        )
        self.assertTrue(
            proof_handoff["zero_authoritative_daily_pnl_until_materialized"]
        )
        self.assertEqual(
            runner._candidate_board_runtime_ledger_required_materialized_artifacts({}),
            [],
        )
        self.assertEqual(
            runner._candidate_board_runtime_ledger_required_materialized_artifacts(
                {"required_materialized_artifacts": "runtime-ledger/string.json"}
            ),
            ["runtime-ledger/string.json"],
        )
        self.assertEqual(
            runner._candidate_board_runtime_ledger_required_materialized_artifacts(
                {
                    "required_materialized_artifacts": [
                        {"path": "runtime-ledger/path.json"},
                        {"name": "runtime-ledger/name.json"},
                        {"artifact": "runtime-ledger/artifact.json"},
                        "runtime-ledger/raw.json",
                        {"kind": "missing-ref"},
                    ]
                }
            ),
            [
                "runtime-ledger/path.json",
                "runtime-ledger/name.json",
                "runtime-ledger/artifact.json",
                "runtime-ledger/raw.json",
            ],
        )

        scorecard_handoff = {
            "status": "requires_runtime_ledger_materialization_before_authority",
            "zero_authoritative_daily_pnl_until_materialized": True,
            "required_materialized_artifacts": [
                {"ref": "runtime-ledger/scorecard-ref.json"}
            ],
        }
        scorecard_proof_handoff = runner._candidate_sleeve_goal_proof_handoff_fields(
            selection={},
            spec=None,
            scorecard={
                "runtime_ledger_lineage_materialization_handoff": scorecard_handoff
            },
            evidence=None,
            selected_for_replay=False,
        )
        self.assertEqual(
            scorecard_proof_handoff["runtime_ledger_lineage_materialization_handoff"],
            scorecard_handoff,
        )
        self.assertEqual(
            scorecard_proof_handoff["runtime_ledger_required_materialized_artifacts"],
            ["runtime-ledger/scorecard-ref.json"],
        )
        self.assertEqual(
            scorecard_proof_handoff["runtime_ledger_materialization_status"],
            "requires_runtime_ledger_materialization_before_authority",
        )
        self.assertTrue(
            scorecard_proof_handoff["zero_authoritative_daily_pnl_until_materialized"]
        )
