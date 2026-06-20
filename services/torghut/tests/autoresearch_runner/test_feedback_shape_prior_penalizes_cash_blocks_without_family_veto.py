from __future__ import annotations

from dataclasses import replace
from decimal import Decimal
from unittest.mock import patch

from sqlalchemy.orm import Session

import scripts.run_whitepaper_autoresearch_profit_target as runner
from app.models import (
    AutoresearchPortfolioCandidate,
)
from tests.autoresearch_runner.helpers import (
    AutoresearchRunnerTestCase,
)


class TestFeedbackShapePriorPenalizesCashBlocksWithoutFamilyVeto(
    AutoresearchRunnerTestCase
):
    def test_feedback_shape_prior_penalizes_cash_blocks_without_family_veto(
        self,
    ) -> None:
        failed_spec = self._candidate_spec("spec-shape-cash-source")
        same_shape_probe = replace(
            failed_spec,
            candidate_spec_id="spec-shape-cash-probe",
            hypothesis_id="hyp-spec-shape-cash-probe",
            hard_vetoes={"required_min_daily_notional": "400000"},
        )
        feedback_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=failed_spec.candidate_spec_id,
            candidate=runner._candidate_payload_with_feedback_metadata(
                spec=failed_spec,
                candidate={
                    "candidate_id": "cand-shape-cash-source",
                    "objective_scorecard": {
                        "net_pnl_per_day": "250",
                        "active_day_ratio": "1",
                        "positive_day_ratio": "1",
                        "best_day_share": "0.25",
                        "min_cash": "-1",
                    },
                },
            ),
            dataset_snapshot_id="snap-shape-cash-feedback",
            result_path="feedback://shape-cash",
        )

        model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(same_shape_probe,),
            feedback_evidence_bundles=(feedback_bundle,),
        )

        self.assertEqual(model["feedback_shape_matched_spec_count"], 1)
        self.assertEqual(rows[0]["training_source"], "feedback_shape_prior")
        self.assertEqual(
            rows[0]["selection_reason"],
            "pre_replay_mlx_family_feedback_penalized",
        )

    def test_feedback_scorecard_helpers_cover_veto_and_penalty_edges(self) -> None:
        invalid_universe_spec = replace(
            self._candidate_spec("spec-invalid-universe"),
            strategy_overrides={
                **self._candidate_spec("spec-invalid-universe").strategy_overrides,
                "universe_symbols": "NVDA",
            },
        )
        self.assertEqual(runner._candidate_spec_universe_key(invalid_universe_spec), "")
        self.assertTrue(
            runner._feedback_scorecard_has_hard_veto(
                {
                    "profit_target_oracle": {
                        "blockers": ["positive_day_ratio_below_oracle"]
                    }
                }
            )
        )
        self.assertTrue(
            runner._feedback_scorecard_has_hard_veto({"oracle_passed": False})
        )
        self.assertFalse(runner._feedback_daily_net_has_loss({"daily_net": "bad"}))
        self.assertTrue(
            runner._feedback_family_prior_has_hard_block(
                {
                    "profit_target_oracle": {
                        "blockers": ["active_day_ratio_below_oracle"]
                    }
                }
            )
        )
        self.assertTrue(
            runner._feedback_family_prior_has_hard_block({"positive_day_ratio": "0.5"})
        )
        self.assertTrue(
            runner._feedback_family_prior_has_hard_block({"best_day_share": "0.51"})
        )
        self.assertTrue(
            runner._feedback_family_prior_has_hard_block(
                {
                    "active_day_ratio": "1",
                    "positive_day_ratio": "1",
                    "best_day_share": "0.25",
                    "daily_net": {"2026-05-01": "0"},
                }
            )
        )
        for scorecard in (
            {
                "profit_target_oracle": {
                    "blockers": ["max_single_day_contribution_share_failed"]
                }
            },
            {"best_day_share": "0.36"},
            {"max_single_day_contribution_share": "0.36"},
            {"max_single_symbol_contribution_share": "0.36"},
            {"max_cluster_contribution_share": "0.41"},
        ):
            self.assertTrue(runner._feedback_risk_profile_has_penalty(scorecard))
        self.assertEqual(runner._feedback_risk_profile_key_from_scorecard({}), "")

        spec = self._candidate_spec("spec-empty-risk-key")
        orphan_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-unmatched-risk-feedback",
            candidate={
                "candidate_id": "cand-unmatched-risk-feedback",
                "objective_scorecard": {"positive_day_ratio": "0.5"},
            },
            dataset_snapshot_id="snap-empty-risk-key",
            result_path="feedback://empty-risk-key",
        )
        model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(spec,),
            feedback_evidence_bundles=(orphan_bundle,),
        )

        self.assertEqual(model["feedback_risk_profile_matched_spec_count"], 0)
        self.assertEqual(rows[0]["training_source"], "synthetic_prior")

    def test_feedback_evidence_loader_reconstructs_paper_probation_candidates(
        self,
    ) -> None:
        spec = self._candidate_spec("candidate-portfolio-probation")
        scorecard = {
            "target_met": True,
            "oracle_passed": False,
            "net_pnl_per_day": "525",
            "profit_target_oracle": {
                "blockers": ["delay_adjusted_depth_tail_coverage_passed_failed"]
            },
        }
        sleeve = {
            "candidate_id": "candidate-portfolio-probation",
            "candidate_spec_id": spec.candidate_spec_id,
            "family_template_id": spec.family_template_id,
            "runtime_family": spec.runtime_family,
            "runtime_strategy_name": spec.runtime_strategy_name,
            "weight": "1.00",
            "expected_net_pnl_per_day": "525",
            "source_expected_net_pnl_per_day": "525",
            "risk_contribution": "2500",
            "source_risk_contribution": "2500",
            "correlation_cluster": "NVDA",
            "params": {"signal_motif": "order_flow_continuation"},
            "universe_symbols": ["NVDA"],
        }

        with (
            Session(self.engine) as session,
            patch(
                "scripts.whitepaper_autoresearch_runner.persisted_feedback_sources.SessionLocal",
                side_effect=lambda: Session(self.engine),
            ),
        ):
            session.add(
                AutoresearchPortfolioCandidate(
                    portfolio_candidate_id="portfolio-feedback-probation",
                    epoch_id="portfolio-feedback-probation-epoch",
                    source_candidate_ids_json=["candidate-portfolio-probation"],
                    target_net_pnl_per_day=Decimal("500"),
                    objective_scorecard_json=scorecard,
                    optimizer_report_json={"method": "test"},
                    payload_json={
                        "schema_version": "torghut.portfolio-candidate-spec.v1",
                        "portfolio_candidate_id": "portfolio-feedback-probation",
                        "source_candidate_ids": ["candidate-portfolio-probation"],
                        "target_net_pnl_per_day": "500",
                        "sleeves": [sleeve],
                        "objective_scorecard": scorecard,
                        "optimizer_report": {"method": "test"},
                        "promotion_readiness": {
                            "stage": "research_portfolio",
                            "status": "blocked_pending_promotion_prerequisites",
                            "promotable": False,
                            "blockers": [
                                "delay_adjusted_depth_tail_coverage_passed_failed"
                            ],
                        },
                    },
                    status="paper_probation",
                )
            )
            session.commit()

            loaded, manifest = runner._load_recent_persisted_feedback_evidence_bundles()

        self.assertEqual(len(loaded), 1)
        self.assertEqual(loaded[0].candidate_spec_id, spec.candidate_spec_id)
        self.assertEqual(
            loaded[0].objective_scorecard["portfolio_status"], "paper_probation"
        )
        self.assertIn(
            "delay_adjusted_depth_tail_coverage_passed_failed",
            loaded[0].objective_scorecard["portfolio_blockers"],
        )
        self.assertEqual(manifest["portfolio_candidate_bundle_count"], 1)
