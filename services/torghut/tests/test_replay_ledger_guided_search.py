from __future__ import annotations

from unittest import TestCase

from app.trading.discovery.replay_ledger_guided_search import (
    apply_replay_ledger_remediation_guidance,
)


class TestReplayLedgerGuidedSearch(TestCase):
    def test_search_blockers_expand_breadth_and_tighten_risk(self) -> None:
        result = apply_replay_ledger_remediation_guidance(
            sweep_config={
                "schema_version": "torghut.replay-frontier-sweep.v1",
                "consistency_constraints": {
                    "max_best_day_share_of_total_pnl": "0.55",
                },
                "parameters": {
                    "top_n": ["1", "2"],
                    "max_pair_legs": ["2"],
                    "max_entries_per_session": ["1"],
                    "max_gross_exposure_pct_equity": ["6.0", "8.0"],
                },
                "strategy_overrides": {
                    "max_position_pct_equity": ["6.0", "8.0"],
                    "max_notional_per_trade": ["157950.10"],
                },
            },
            remediation_report={
                "status": "blocked_pending_search_remediation",
                "candidate_id": "candidate-1",
                "promotion_blockers": [
                    "replay_artifact_only_not_live",
                    "avg_filled_notional_per_day_below_min",
                    "best_day_share_above_max",
                    "max_single_fill_notional_pct_equity_above_max",
                ],
                "runtime_ledger_blockers": [],
                "recommended_objective_adjustments": {
                    "max_best_day_share": "0.25",
                    "max_gross_exposure_pct_equity": "1.0",
                    "start_equity": "31590.02",
                },
                "recommended_search_actions": [
                    {
                        "action": "increase_tradeable_breadth_without_raising_single_fill_exposure",
                        "required_multiplier": "1.9",
                    }
                ],
                "metric_snapshot": {
                    "avg_filled_notional_per_window_weekday": "159425.58",
                    "best_day_share": "1",
                    "max_single_fill_notional_pct_equity": "5.08",
                },
            },
        )

        self.assertTrue(result.applied)
        self.assertEqual(
            result.applied_actions,
            ("breadth", "concentration", "exposure"),
        )
        self.assertEqual(result.sweep_config["parameters"]["top_n"], ["1", "2", "4"])
        self.assertEqual(result.sweep_config["parameters"]["max_pair_legs"], ["2", "4"])
        self.assertEqual(
            result.sweep_config["parameters"]["max_entries_per_session"],
            ["1", "2"],
        )
        self.assertEqual(
            result.sweep_config["consistency_constraints"][
                "max_best_day_share_of_total_pnl"
            ],
            "0.25",
        )
        self.assertEqual(
            result.sweep_config["parameters"]["max_gross_exposure_pct_equity"],
            ["1"],
        )
        self.assertEqual(
            result.sweep_config["strategy_overrides"]["max_position_pct_equity"],
            ["0.25"],
        )
        self.assertEqual(
            result.sweep_config["strategy_overrides"]["max_notional_per_trade"],
            ["7897.5"],
        )
        self.assertEqual(
            result.sweep_config["metadata"]["replay_ledger_guided_search"][
                "source_candidate_id"
            ],
            "candidate-1",
        )

    def test_runtime_only_blocker_does_not_mutate_search(self) -> None:
        result = apply_replay_ledger_remediation_guidance(
            sweep_config={"parameters": {"top_n": ["2"]}},
            remediation_report={
                "status": "blocked_pending_runtime_promotion_proof",
                "promotion_blockers": ["replay_artifact_only_not_live"],
                "runtime_ledger_blockers": [],
            },
        )

        self.assertFalse(result.applied)
        self.assertEqual(result.sweep_config, {"parameters": {"top_n": ["2"]}})

    def test_execution_quality_blockers_are_carried_into_guided_metadata(
        self,
    ) -> None:
        result = apply_replay_ledger_remediation_guidance(
            sweep_config={
                "parameters": {"top_n": ["2"]},
                "metadata": {"existing": "kept"},
            },
            remediation_report={
                "status": "blocked_pending_runtime_promotion_proof",
                "candidate_id": "candidate-execution-quality",
                "promotion_blockers": ["replay_artifact_only_not_live"],
                "runtime_ledger_blockers": [],
                "execution_quality_blockers": [
                    "execution_shortfall_evidence_incomplete",
                    "queue_position_survival_evidence_incomplete",
                ],
                "recommended_search_actions": [
                    {
                        "blocker": "execution_shortfall_evidence_incomplete",
                        "action": "collect_route_tca_shortfall_evidence",
                        "reason": "route TCA/shortfall is required before execution quality can influence collection",
                        "parameter_hints": [
                            "route_tca_bps",
                            "execution_shortfall_bps",
                        ],
                    },
                    {
                        "blocker": "queue_position_survival_evidence_incomplete",
                        "action": "collect_queue_position_survival_fill_curve_evidence",
                        "reason": "queue-position/time-to-fill evidence is missing for limit-order candidates",
                        "parameter_hints": [
                            "queue_position",
                            "queue_ahead_qty",
                        ],
                    },
                ],
                "metric_snapshot": {
                    "execution_quality_penalty_bps": "12.5",
                },
            },
        )

        self.assertTrue(result.applied)
        self.assertEqual(result.applied_actions, ("execution_quality",))
        self.assertEqual(result.sweep_config["parameters"], {"top_n": ["2"]})
        self.assertEqual(result.sweep_config["metadata"]["existing"], "kept")
        metadata = result.sweep_config["metadata"]["replay_ledger_guided_search"]
        self.assertEqual(metadata["blockers"], [])
        self.assertEqual(
            metadata["execution_quality_blockers"],
            [
                "execution_shortfall_evidence_incomplete",
                "queue_position_survival_evidence_incomplete",
            ],
        )
        self.assertEqual(
            metadata["execution_quality_authority"],
            "research_ranking_only_final_promotion_still_requires_runtime_ledger",
        )
        self.assertEqual(
            metadata["required_replay_evidence_fields"],
            [
                "arrival_shortfall_bps",
                "execution_shortfall_bps",
                "queue_ahead_qty",
                "queue_position",
                "route_tca_bps",
                "time_to_fill_seconds",
            ],
        )
        self.assertEqual(
            metadata["execution_quality_remediations"],
            [
                {
                    "blocker": "execution_shortfall_evidence_incomplete",
                    "action": "collect_route_tca_shortfall_evidence",
                    "reason": "route TCA/shortfall is required before execution quality can influence collection",
                    "parameter_hints": [
                        "route_tca_bps",
                        "execution_shortfall_bps",
                    ],
                },
                {
                    "blocker": "queue_position_survival_evidence_incomplete",
                    "action": "collect_queue_position_survival_fill_curve_evidence",
                    "reason": "queue-position/time-to-fill evidence is missing for limit-order candidates",
                    "parameter_hints": [
                        "queue_position",
                        "queue_ahead_qty",
                    ],
                },
            ],
        )

    def test_window_blocker_is_recorded_without_guessing_dates(self) -> None:
        result = apply_replay_ledger_remediation_guidance(
            sweep_config={"parameters": {"entry_cooldown_seconds": ["600"]}},
            remediation_report={
                "status": "blocked_pending_search_remediation",
                "candidate_id": "candidate-short-window",
                "promotion_blockers": [
                    "window_weekday_count_below_min_observed_trading_days"
                ],
                "runtime_ledger_blockers": [],
                "recommended_objective_adjustments": {"min_window_weekday_count": "20"},
                "metric_snapshot": {
                    "min_window_weekday_count": "20",
                    "window_weekday_count": "2",
                },
            },
        )

        self.assertTrue(result.applied)
        self.assertEqual(result.applied_actions, ("window",))
        self.assertEqual(
            result.sweep_config["consistency_constraints"]["min_window_weekday_count"],
            20,
        )
        self.assertEqual(
            result.sweep_config["metadata"]["replay_ledger_guided_search"]["blockers"],
            ["window_weekday_count_below_min_observed_trading_days"],
        )
        self.assertEqual(
            result.sweep_config["metadata"]["replay_ledger_guided_search"][
                "parameter_changes"
            ],
            [
                {
                    "key": "consistency_constraints.min_window_weekday_count",
                    "before": "",
                    "after": "20",
                }
            ],
        )

    def test_microbar_notional_blocker_adds_pair_breadth_when_missing(self) -> None:
        result = apply_replay_ledger_remediation_guidance(
            sweep_config={
                "schema_version": "torghut.replay-frontier-sweep.v1",
                "family_template_id": "microbar_cross_sectional_pairs_v1",
                "parameters": {
                    "top_n": ["1"],
                    "max_entries_per_session": ["1"],
                },
            },
            remediation_report={
                "status": "blocked_pending_search_remediation",
                "candidate_id": "hpairs-candidate",
                "promotion_blockers": ["avg_filled_notional_per_day_below_min"],
                "runtime_ledger_blockers": [],
                "recommended_search_actions": [
                    {
                        "action": "increase_tradeable_pair_breadth",
                        "required_multiplier": "2.0",
                    }
                ],
            },
        )

        self.assertTrue(result.applied)
        self.assertEqual(result.sweep_config["parameters"]["top_n"], ["1", "2"])
        self.assertEqual(
            result.sweep_config["parameters"]["max_entries_per_session"],
            ["1", "2"],
        )
        self.assertEqual(result.sweep_config["parameters"]["max_pair_legs"], ["2", "4"])
        self.assertIn(
            {
                "key": "parameters.max_pair_legs",
                "before": "",
                "after": "2,4",
            },
            result.sweep_config["metadata"]["replay_ledger_guided_search"][
                "parameter_changes"
            ],
        )
