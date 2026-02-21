from __future__ import annotations

from unittest import TestCase

from app.trading.reporting import build_promotion_recommendation


class TestPromotionRecommendation(TestCase):
    def test_recommendation_requires_fold_stress_and_rationale_evidence(self) -> None:
        recommendation = build_promotion_recommendation(
            run_id="run-1",
            candidate_id="cand-1",
            requested_mode="paper",
            recommended_mode="paper",
            gate_allowed=True,
            prerequisite_allowed=True,
            rollback_ready=True,
            fold_metrics_count=0,
            stress_metrics_count=0,
            rationale="",
            reasons=[],
        )

        self.assertFalse(recommendation.eligible)
        self.assertEqual(recommendation.action, "deny")
        self.assertIn("fold_metrics_missing", recommendation.reasons)
        self.assertIn("stress_metrics_missing", recommendation.reasons)
        self.assertIn("promotion_rationale_missing", recommendation.reasons)
        self.assertFalse(recommendation.evidence.evidence_complete)

    def test_recommendation_trace_id_is_deterministic(self) -> None:
        first = build_promotion_recommendation(
            run_id="run-1",
            candidate_id="cand-1",
            requested_mode="paper",
            recommended_mode="paper",
            gate_allowed=True,
            prerequisite_allowed=True,
            rollback_ready=True,
            fold_metrics_count=1,
            stress_metrics_count=4,
            rationale="all_required_gates_passed_for_paper_promotion_recommended_mode_paper",
            reasons=["ok"],
        )
        second = build_promotion_recommendation(
            run_id="run-1",
            candidate_id="cand-1",
            requested_mode="paper",
            recommended_mode="paper",
            gate_allowed=True,
            prerequisite_allowed=True,
            rollback_ready=True,
            fold_metrics_count=1,
            stress_metrics_count=4,
            rationale="all_required_gates_passed_for_paper_promotion_recommended_mode_paper",
            reasons=["ok"],
        )

        self.assertEqual(first.trace_id, second.trace_id)
        self.assertEqual(first.action, "promote")
        self.assertTrue(first.eligible)
