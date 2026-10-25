from __future__ import annotations

import app.trading.discovery.evidence_bundles as evidence_bundles
import app.trading.discovery.portfolio_optimizer as portfolio_optimizer
import scripts.whitepaper_autoresearch_runner.candidate_goal_metadata as candidate_goal_metadata
import scripts.whitepaper_autoresearch_runner.candidate_prior_scoring as candidate_prior_scoring
import scripts.whitepaper_autoresearch_runner.feedback_bundle_builders as feedback_bundle_builders
import scripts.whitepaper_autoresearch_runner.proposal_building as proposal_building

from dataclasses import replace
from decimal import Decimal
from pathlib import Path


from tests.autoresearch_runner.helpers import (
    AutoresearchRunnerTestCase,
)
import scripts.whitepaper_autoresearch_runner.candidate_board_fields as candidate_board_fields
import scripts.whitepaper_autoresearch_runner.candidate_board_payloads as candidate_board_payloads
import scripts.whitepaper_autoresearch_runner.candidate_board_status as candidate_board_status
import scripts.whitepaper_autoresearch_runner.candidate_board_summaries as candidate_board_summaries
import scripts.whitepaper_autoresearch_runner.replay_selection as replay_selection
import scripts.whitepaper_autoresearch_runner.runtime_closure as runtime_closure


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
        evidence = evidence_bundles.CandidateEvidenceBundle(
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

        board = candidate_board_payloads._candidate_board_payload(
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
            candidate_prior_scoring._pre_replay_candidate_score(paper_spec),
            candidate_prior_scoring._pre_replay_candidate_score(control_spec),
        )

        prior_bundle = feedback_bundle_builders._pre_replay_prior_bundle(paper_spec)
        self.assertFalse(prior_bundle.promotion_readiness["promotable"])
        self.assertIn(
            "runtime_replay_required", prior_bundle.promotion_readiness["blockers"]
        )
        self.assertIn(
            "validation_live_paper_parity_pending",
            prior_bundle.promotion_readiness["blockers"],
        )

        _model, rows = proposal_building._pre_replay_proposal_model_and_rows(
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

        selected, selection = replay_selection._select_candidate_specs_for_replay(
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
            replay_selection._select_candidate_specs_for_replay(
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
        evidence = evidence_bundles.CandidateEvidenceBundle(
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

        self.assertEqual(
            candidate_board_fields._candidate_board_int_field({"bad": object()}, "bad"),
            0,
        )
        self.assertEqual(
            candidate_board_summaries._candidate_board_market_impact_proof_summary(
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
            candidate_board_summaries._candidate_board_market_impact_proof_summary(
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
        missing_impact = (
            candidate_board_summaries._candidate_board_market_impact_proof_summary(
                {"target_met": True}
            )
        )
        self.assertEqual(missing_impact["state"], "blocked")
        self.assertIn(
            "nonlinear_market_impact_components_missing",
            missing_impact["blockers"],
        )
        regime_summary = (
            candidate_board_summaries._candidate_board_regime_specialist_summary(
                spec, {"regime_slice_pass_rate": "0.30"}
            )
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
            candidate_board_status._candidate_board_blockers(
                selected_for_replay=True,
                evidence=None,
                scorecard={},
            ),
            ["replay_evidence_missing"],
        )
        self.assertEqual(
            candidate_board_status._candidate_board_blockers(
                selected_for_replay=True,
                evidence=evidence,
                scorecard={"target_met": True, "oracle_passed": False},
            ),
            ["profit_target_oracle_failed"],
        )
        dirty_lineage = (
            candidate_board_summaries._candidate_board_evidence_lineage_summary(
                replace(evidence, code_commit="commit-test-dirty")
            )
        )
        self.assertEqual(dirty_lineage["blockers"], ["code_commit_dirty"])
        self.assertEqual(
            candidate_board_status._candidate_board_status(
                selected_for_replay=True,
                evidence=None,
                scorecard={},
                in_best_portfolio=False,
                portfolio_oracle_passed=False,
            ),
            "selected_pending_replay_evidence",
        )
        self.assertEqual(
            candidate_board_status._candidate_board_status(
                selected_for_replay=True,
                evidence=evidence,
                scorecard={"oracle_passed": True},
                in_best_portfolio=False,
                portfolio_oracle_passed=False,
            ),
            "candidate_oracle_passed",
        )
        self.assertEqual(
            candidate_board_status._candidate_board_status(
                selected_for_replay=True,
                evidence=evidence,
                scorecard={"target_met": True, "oracle_passed": False},
                in_best_portfolio=False,
                portfolio_oracle_passed=False,
            ),
            "blocked_by_oracle",
        )
        self.assertEqual(
            candidate_board_status._candidate_board_status(
                selected_for_replay=True,
                evidence=evidence,
                scorecard={},
                in_best_portfolio=True,
                portfolio_oracle_passed=True,
            ),
            "portfolio_component_passed_oracle",
        )
        denied_readiness = runtime_closure._promotion_readiness_payload(
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
        allowed_readiness = runtime_closure._promotion_readiness_payload(
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
        evidence = evidence_bundles.CandidateEvidenceBundle(
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

        rows = candidate_goal_metadata._candidate_sleeve_goal_rows(
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
        fallback_rows = candidate_goal_metadata._candidate_sleeve_goal_rows(
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

        portfolio = portfolio_optimizer.PortfolioCandidateSpec(
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
        portfolio_rows = candidate_goal_metadata._candidate_sleeve_goal_rows(
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
        evidence = evidence_bundles.CandidateEvidenceBundle(
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
        portfolio = portfolio_optimizer.PortfolioCandidateSpec(
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

        board = candidate_board_payloads._candidate_board_payload(
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
        evidence = evidence_bundles.CandidateEvidenceBundle(
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

        board = candidate_board_payloads._candidate_board_payload(
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
