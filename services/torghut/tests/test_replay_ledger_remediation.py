from __future__ import annotations

from unittest import TestCase

from app.trading.discovery.replay_ledger_remediation import (
    build_replay_ledger_remediation_report,
)


class TestReplayLedgerRemediation(TestCase):
    def test_report_maps_replay_blockers_to_next_search_actions(self) -> None:
        report = build_replay_ledger_remediation_report(
            {
                "schema_version": "torghut.exact-replay-ledger-ranking.v1",
                "policy": {
                    "target_net_pnl_per_day": "500",
                    "min_window_weekday_count": 20,
                    "min_avg_filled_notional_per_day": "300000",
                    "max_best_day_share": "0.25",
                    "max_gross_exposure_pct_equity": "0.05",
                    "start_equity": "31590.02",
                },
                "candidates": [
                    {
                        "candidate_id": "candidate-1",
                        "artifact_ref": "/tmp/candidate-1-exact-replay-ledger.json",
                        "promotion_status": "blocked_pending_runtime_promotion_proof",
                        "promotion_blockers": [
                            "replay_artifact_only_not_live",
                            "window_net_pnl_per_day_below_target",
                            "avg_filled_notional_per_day_below_min",
                            "best_day_share_above_max",
                            "max_single_fill_notional_pct_equity_above_max",
                        ],
                        "runtime_ledger_blockers": [],
                        "window_net_pnl_per_day": "125",
                        "active_net_pnl_per_day": "625",
                        "total_net_pnl_after_costs": "1000",
                        "window_weekday_count": 8,
                        "avg_filled_notional_per_window_weekday": "150000",
                        "best_day_share": "0.50",
                        "max_single_fill_notional_pct_equity": "0.12",
                    }
                ],
            }
        )

        self.assertEqual(report["status"], "blocked_pending_search_remediation")
        self.assertFalse(report["promotion_allowed"])
        self.assertEqual(report["candidate_id"], "candidate-1")
        self.assertEqual(
            report["recommended_objective_adjustments"]["target_net_pnl_per_day"],
            "500",
        )
        self.assertEqual(
            report["recommended_objective_adjustments"][
                "min_avg_filled_notional_per_day"
            ],
            "300000",
        )
        self.assertEqual(report["metric_snapshot"]["start_equity"], "31590.02")
        actions = {item["action"] for item in report["recommended_search_actions"]}
        self.assertIn(
            "run_runtime_closure_then_live_paper_ledger_validation",
            actions,
        )
        self.assertIn(
            "bias_search_to_full_window_net_pnl_per_day_not_active_day_only",
            actions,
        )
        self.assertIn(
            "increase_tradeable_breadth_without_raising_single_fill_exposure",
            actions,
        )
        self.assertIn("penalize_single_day_pnl_concentration", actions)
        self.assertIn("cap_per_fill_notional_before_scaling_notional", actions)

    def test_report_blocks_when_no_ranked_ledgers_exist(self) -> None:
        report = build_replay_ledger_remediation_report(
            {
                "schema_version": "torghut.exact-replay-ledger-ranking.v1",
                "policy": {"target_net_pnl_per_day": "500"},
                "candidates": [],
            }
        )

        self.assertEqual(
            report["status"],
            "blocked_no_exact_replay_ledger_candidates",
        )
        self.assertFalse(report["promotion_allowed"])
        self.assertEqual(
            report["promotion_blockers"],
            ["exact_replay_ledger_candidate_missing"],
        )
        self.assertEqual(
            report["recommended_search_actions"][0]["action"],
            "produce_exact_replay_ledger_artifacts",
        )

    def test_report_requires_runtime_proof_when_replay_checks_pass(self) -> None:
        report = build_replay_ledger_remediation_report(
            {
                "schema_version": "torghut.exact-replay-ledger-ranking.v1",
                "policy": {"target_net_pnl_per_day": "500"},
                "candidates": [
                    {
                        "candidate_id": "candidate-runtime-ready",
                        "promotion_status": "candidate_replay_evidence_only",
                        "promotion_blockers": [],
                        "runtime_ledger_blockers": [],
                    }
                ],
            }
        )

        self.assertEqual(
            report["status"],
            "blocked_pending_runtime_promotion_proof",
        )
        self.assertFalse(report["promotion_allowed"])
        self.assertEqual(
            report["recommended_search_actions"][0]["action"],
            "start_runtime_paper_validation",
        )

    def test_report_surfaces_execution_quality_actions_without_promotion(self) -> None:
        report = build_replay_ledger_remediation_report(
            {
                "schema_version": "torghut.exact-replay-ledger-ranking.v1",
                "policy": {"target_net_pnl_per_day": "500"},
                "candidates": [
                    {
                        "candidate_id": "candidate-needs-fill-curve",
                        "promotion_status": "candidate_replay_evidence_only",
                        "promotion_blockers": ["replay_artifact_only_not_live"],
                        "runtime_ledger_blockers": [],
                        "execution_quality_blockers": [
                            "limit_fill_probability_evidence_incomplete",
                            "queue_position_survival_evidence_incomplete",
                        ],
                        "execution_quality_penalty_bps": "12",
                        "execution_quality_adjusted_window_net_pnl_per_day": "480",
                        "execution_quality": {
                            "schema_version": "torghut.exact-replay-execution-quality.v1",
                            "limit_order_count": 4,
                            "limit_fill_probability_sample_count": 0,
                        },
                    }
                ],
            }
        )

        self.assertFalse(report["promotion_allowed"])
        self.assertEqual(
            report["execution_quality"]["schema_version"],
            "torghut.exact-replay-execution-quality.v1",
        )
        actions = {
            item["action"]: item for item in report["recommended_search_actions"]
        }
        self.assertIn("collect_limit_fill_probability_evidence", actions)
        self.assertIn(
            "collect_queue_position_survival_fill_curve_evidence",
            actions,
        )
        self.assertEqual(
            actions["collect_queue_position_survival_fill_curve_evidence"]["authority"],
            "research_ranking_only_final_promotion_still_requires_runtime_ledger",
        )

    def test_report_handles_malformed_shapes_without_promotion(self) -> None:
        report = build_replay_ledger_remediation_report(
            {
                "schema_version": "torghut.exact-replay-ledger-ranking.v1",
                "policy": "not-a-policy",
                "candidates": "not-a-candidate-list",
            }
        )

        self.assertEqual(
            report["status"],
            "blocked_no_exact_replay_ledger_candidates",
        )
        self.assertEqual(report["metric_snapshot"], {})

    def test_report_keeps_unknown_and_start_equity_blockers_actionable(self) -> None:
        report = build_replay_ledger_remediation_report(
            {
                "schema_version": "torghut.exact-replay-ledger-ranking.v1",
                "policy": {
                    "target_net_pnl_per_day": "500",
                    "min_window_weekday_count": 20,
                },
                "candidates": [
                    {
                        "candidate_id": "candidate-blocked",
                        "promotion_status": "blocked_pending_runtime_promotion_proof",
                        "promotion_blockers": [
                            "window_net_pnl_per_day_below_target",
                            "start_equity_missing_for_exposure_check",
                            "unknown_runtime_gate",
                            "unknown_runtime_gate",
                        ],
                        "runtime_ledger_blockers": "not-a-list",
                        "window_net_pnl_per_day": "not-a-number",
                    }
                ],
            }
        )

        actions = {
            item["action"]: item for item in report["recommended_search_actions"]
        }
        self.assertIsNone(
            actions["bias_search_to_full_window_net_pnl_per_day_not_active_day_only"][
                "required_multiplier"
            ]
        )
        self.assertEqual(
            actions["rerun_ranking_with_start_equity"]["parameter_hints"],
            ["set_start_equity"],
        )
        self.assertEqual(
            actions["fix_runtime_ledger_or_policy_blocker_before_research_continues"][
                "blocker"
            ],
            "unknown_runtime_gate",
        )
