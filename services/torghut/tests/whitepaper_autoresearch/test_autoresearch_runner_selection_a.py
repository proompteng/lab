from __future__ import annotations

import app.trading.discovery.evidence_bundles as evidence_bundles
import scripts.whitepaper_autoresearch_runner.proposal_building as proposal_building

from tests.whitepaper_autoresearch.autoresearch_runner_base import (
    Any,
    Decimal,
    WhitepaperAutoresearchRunnerTestCaseBase,
    cast,
    replace,
    runner,
)


class TestAutoresearchRunnerSelectionA(WhitepaperAutoresearchRunnerTestCaseBase):
    def test_candidate_selection_blocks_nonpositive_family_feedback(self) -> None:
        source_spec = self._candidate_spec("spec-family-negative-source")
        mutated_family_spec = self._candidate_spec(
            "spec-family-negative-mutated",
            entry_minute_after_open="60",
        )
        family_feedback_bundle = (
            evidence_bundles.evidence_bundle_from_frontier_candidate(
                candidate_spec_id=source_spec.candidate_spec_id,
                candidate={
                    "candidate_id": "cand-family-negative-source",
                    "family_template_id": source_spec.family_template_id,
                    "runtime_family": source_spec.runtime_family,
                    "runtime_strategy_name": source_spec.runtime_strategy_name,
                    "objective_scorecard": {
                        "net_pnl_per_day": "-250",
                        "active_day_ratio": "1",
                        "positive_day_ratio": "0",
                        "negative_day_count": 4,
                        "daily_net": {
                            "2026-05-01": "-150",
                            "2026-05-04": "-350",
                        },
                    },
                },
                dataset_snapshot_id="snap-family-negative-feedback",
                result_path="feedback://family-negative",
            )
        )

        _model, rows = proposal_building._pre_replay_proposal_model_and_rows(
            specs=(mutated_family_spec,),
            feedback_evidence_bundles=(family_feedback_bundle,),
        )

        self.assertEqual(rows[0]["training_source"], "feedback_family_replay")
        self.assertEqual(
            rows[0]["selection_reason"], "pre_replay_mlx_family_feedback_blocked"
        )
        self.assertLessEqual(
            Decimal(str(rows[0]["proposal_score"])), Decimal("-999999")
        )

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(mutated_family_spec,),
            proposal_rows=rows,
            top_k=1,
            exploration_slots=0,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [])
        self.assertEqual(selection["budget"]["selected_count"], 0)
        self.assertEqual(selection["budget"]["eligible_candidate_count"], 0)
        self.assertEqual(
            selection["budget"]["pre_replay_feedback_blocked_candidate_count"], 1
        )
        self.assertEqual(
            selection["rows"][0]["selection_reason"],
            "pre_replay_mlx_family_feedback_blocked",
        )

    def test_candidate_selection_keeps_active_loss_counter_candidate(
        self,
    ) -> None:
        source_spec = self._candidate_spec("spec-active-loss-source")
        adaptive_base = self._candidate_spec(
            "spec-active-loss-adaptive",
            entry_minute_after_open="75",
        )
        adaptive_params = dict(
            cast(dict[str, Any], adaptive_base.strategy_overrides["params"])
        )
        adaptive_params["feedback_remediation_profile"] = (
            "adverse_selection_feedback_escape"
        )
        adaptive_spec = replace(
            adaptive_base,
            strategy_overrides={
                **adaptive_base.strategy_overrides,
                "params": adaptive_params,
            },
        )
        family_feedback_bundle = (
            evidence_bundles.evidence_bundle_from_frontier_candidate(
                candidate_spec_id=source_spec.candidate_spec_id,
                candidate={
                    "candidate_id": "cand-active-loss-source",
                    "family_template_id": source_spec.family_template_id,
                    "runtime_family": source_spec.runtime_family,
                    "runtime_strategy_name": source_spec.runtime_strategy_name,
                    "objective_scorecard": {
                        "net_pnl_per_day": "-50",
                        "active_day_ratio": "0.67",
                        "positive_day_ratio": "0",
                        "negative_day_count": 2,
                        "decision_count": 4,
                        "filled_count": 4,
                        "avg_filled_notional_per_day": "40000",
                        "worst_day_loss": "90",
                        "max_drawdown": "130",
                        "daily_net": {
                            "2026-05-06": "-40",
                            "2026-05-07": "-90",
                        },
                    },
                },
                dataset_snapshot_id="snap-active-loss-feedback",
                result_path="feedback://active-loss",
            )
        )

        _model, rows = proposal_building._pre_replay_proposal_model_and_rows(
            specs=(adaptive_spec,),
            feedback_evidence_bundles=(family_feedback_bundle,),
        )

        self.assertEqual(rows[0]["training_source"], "feedback_family_replay")
        self.assertEqual(
            rows[0]["selection_reason"],
            "pre_replay_mlx_active_loss_counter_candidate",
        )
        self.assertGreater(Decimal(str(rows[0]["proposal_score"])), Decimal("-999999"))

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(adaptive_spec,),
            proposal_rows=rows,
            top_k=0,
            exploration_slots=1,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [adaptive_spec])
        self.assertEqual(selection["budget"]["eligible_candidate_count"], 1)
        self.assertEqual(
            selection["budget"]["active_loss_counter_candidate_selected_count"],
            1,
        )
        self.assertEqual(
            selection["rows"][0]["selection_reason"],
            "active_loss_counter_candidate",
        )

    def test_candidate_selection_keeps_positive_consistency_repair_candidate(
        self,
    ) -> None:
        source_spec = self._candidate_spec("spec-consistency-source")
        repair_base = self._candidate_spec(
            "spec-consistency-repair",
            entry_minute_after_open="75",
        )
        repair_params = dict(
            cast(dict[str, Any], repair_base.strategy_overrides["params"])
        )
        repair_params["feedback_remediation_profile"] = (
            "consistency_guard_feedback_escape"
        )
        repair_spec = replace(
            repair_base,
            strategy_overrides={
                **repair_base.strategy_overrides,
                "params": repair_params,
            },
        )
        family_feedback_bundle = (
            evidence_bundles.evidence_bundle_from_frontier_candidate(
                candidate_spec_id=source_spec.candidate_spec_id,
                candidate={
                    "candidate_id": "cand-consistency-source",
                    "family_template_id": source_spec.family_template_id,
                    "runtime_family": source_spec.runtime_family,
                    "runtime_strategy_name": source_spec.runtime_strategy_name,
                    "objective_scorecard": {
                        "net_pnl_per_day": "900",
                        "active_day_ratio": "0.40",
                        "positive_day_ratio": "0.20",
                        "negative_day_count": 0,
                        "decision_count": 5,
                        "filled_count": 5,
                        "avg_filled_notional_per_day": "350000",
                        "best_day_share": "0.84",
                        "max_cluster_contribution_share": "0.70",
                        "worst_day_loss": "0",
                        "max_drawdown": "0",
                        "min_daily_net_pnl": "0",
                        "daily_net": {
                            "2026-05-06": "4500",
                            "2026-05-07": "0",
                        },
                    },
                },
                dataset_snapshot_id="snap-consistency-feedback",
                result_path="feedback://consistency",
            )
        )

        _model, rows = proposal_building._pre_replay_proposal_model_and_rows(
            specs=(repair_spec,),
            feedback_evidence_bundles=(family_feedback_bundle,),
        )

        self.assertEqual(rows[0]["training_source"], "feedback_family_replay")
        self.assertEqual(
            rows[0]["selection_reason"],
            "pre_replay_mlx_consistency_repair_candidate",
        )
        self.assertGreater(Decimal(str(rows[0]["proposal_score"])), Decimal("-999999"))
        self.assertEqual(rows[0]["consistency_repair_tags"], ["loss_control_shortfall"])
        self.assertIn(
            "daily_coverage_shortfall",
            rows[0]["consistency_repair_feedback_reasons"],
        )
        self.assertIn(
            "loss_control_shortfall",
            rows[0]["consistency_repair_feedback_reasons"],
        )
        self.assertIn(
            "symbol_concentration_shortfall",
            rows[0]["consistency_repair_feedback_reasons"],
        )

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(repair_spec,),
            proposal_rows=rows,
            top_k=0,
            exploration_slots=1,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [repair_spec])
        self.assertEqual(selection["budget"]["eligible_candidate_count"], 1)
        self.assertEqual(
            selection["budget"]["consistency_repair_candidate_selected_count"],
            1,
        )
        self.assertEqual(
            selection["rows"][0]["selection_reason"],
            "consistency_repair_candidate",
        )

    def test_active_loss_counter_candidates_keep_relative_scores(
        self,
    ) -> None:
        source_spec = self._candidate_spec("spec-active-loss-score-source")
        daily_base = self._candidate_spec("spec-active-loss-score-daily")
        adverse_base = self._candidate_spec("spec-active-loss-score-adverse")
        daily_params = dict(
            cast(dict[str, Any], daily_base.strategy_overrides["params"])
        )
        daily_params["feedback_remediation_profile"] = "daily_coverage_feedback_escape"
        adverse_params = dict(
            cast(dict[str, Any], adverse_base.strategy_overrides["params"])
        )
        adverse_params["feedback_remediation_profile"] = (
            "adverse_selection_feedback_escape"
        )
        adverse_params["max_stop_loss_exits_per_session"] = "1"
        adverse_params["stop_loss_lockout_seconds"] = "2400"
        daily_spec = replace(
            daily_base,
            strategy_overrides={
                **daily_base.strategy_overrides,
                "params": daily_params,
            },
        )
        adverse_spec = replace(
            adverse_base,
            strategy_overrides={
                **adverse_base.strategy_overrides,
                "params": adverse_params,
            },
        )
        family_feedback_bundle = (
            evidence_bundles.evidence_bundle_from_frontier_candidate(
                candidate_spec_id=source_spec.candidate_spec_id,
                candidate={
                    "candidate_id": "cand-active-loss-score-source",
                    "family_template_id": source_spec.family_template_id,
                    "runtime_family": source_spec.runtime_family,
                    "runtime_strategy_name": source_spec.runtime_strategy_name,
                    "objective_scorecard": {
                        "net_pnl_per_day": "-50",
                        "active_day_ratio": "0.50",
                        "positive_day_ratio": "0",
                        "negative_day_count": 2,
                        "decision_count": 4,
                        "filled_count": 4,
                        "avg_filled_notional_per_day": "40000",
                        "worst_day_loss": "90",
                        "max_drawdown": "130",
                        "daily_net": {
                            "2026-05-06": "-40",
                            "2026-05-07": "-90",
                        },
                    },
                },
                dataset_snapshot_id="snap-active-loss-score-feedback",
                result_path="feedback://active-loss-score",
            )
        )

        _model, rows = proposal_building._pre_replay_proposal_model_and_rows(
            specs=(daily_spec, adverse_spec),
            feedback_evidence_bundles=(family_feedback_bundle,),
        )

        row_by_spec = {row["candidate_spec_id"]: row for row in rows}
        self.assertGreater(
            Decimal(str(row_by_spec[adverse_spec.candidate_spec_id]["proposal_score"])),
            Decimal(str(row_by_spec[daily_spec.candidate_spec_id]["proposal_score"])),
        )
        self.assertEqual(
            row_by_spec[adverse_spec.candidate_spec_id]["active_loss_counter_tags"],
            [
                "adverse_selection_shortfall",
                "daily_coverage_shortfall",
                "loss_control_shortfall",
                "notional_throughput_shortfall",
            ],
        )
        self.assertIn(
            "notional_throughput_shortfall",
            row_by_spec[adverse_spec.candidate_spec_id][
                "active_loss_counter_feedback_reasons"
            ],
        )

    def test_candidate_selection_caps_active_loss_counter_for_small_batches(
        self,
    ) -> None:
        active_breakout = replace(
            self._candidate_spec(
                "spec-active-breakout",
                family_template_id="breakout_reclaim_v2",
            ),
            runtime_family="breakout_continuation_consistent",
            runtime_strategy_name="breakout-continuation-long-v1",
        )
        active_microbar = replace(
            self._candidate_spec(
                "spec-active-microbar",
                family_template_id="microbar_cross_sectional_pairs_v1",
            ),
            runtime_family="microbar_cross_sectional_pairs",
            runtime_strategy_name="microbar-cross-sectional-pairs-v1",
        )
        active_late_day = replace(
            self._candidate_spec(
                "spec-active-late-day",
                family_template_id="late_day_continuation_v1",
            ),
            runtime_family="late_day_continuation_consistent",
            runtime_strategy_name="late-day-continuation-long-v1",
        )
        runtime_intraday = replace(
            self._candidate_spec(
                "spec-runtime-intraday",
                family_template_id="intraday_tsmom_v2",
            ),
            runtime_family="intraday_tsmom_consistent",
            runtime_strategy_name="intraday-tsmom-profit-v3",
        )
        runtime_late_day = replace(
            self._candidate_spec(
                "spec-runtime-late-day",
                family_template_id="opening_drive_leader_reclaim_v1",
            ),
            runtime_family="late_day_continuation_consistent",
            runtime_strategy_name="late-day-continuation-long-v1",
        )

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(
                active_breakout,
                active_microbar,
                active_late_day,
                runtime_intraday,
                runtime_late_day,
            ),
            proposal_rows=[
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "rank": index,
                    "proposal_score": 100.0 - index,
                    "selection_reason": "pre_replay_mlx_active_loss_counter_candidate",
                }
                for index, spec in enumerate(
                    (active_breakout, active_microbar, active_late_day),
                    start=1,
                )
            ]
            + [
                {
                    "candidate_spec_id": runtime_intraday.candidate_spec_id,
                    "rank": 4,
                    "proposal_score": 1.0,
                    "selection_reason": "pre_replay_mlx_rank",
                },
                {
                    "candidate_spec_id": runtime_late_day.candidate_spec_id,
                    "rank": 5,
                    "proposal_score": 0.5,
                    "selection_reason": "pre_replay_mlx_rank",
                },
            ],
            top_k=0,
            exploration_slots=4,
            max_candidates=4,
            portfolio_size_min=2,
        )

        selected_reasons = {
            row["candidate_spec_id"]: row["selection_reason"]
            for row in selection["rows"]
            if row["selected_for_replay"]
        }
        self.assertEqual(len(selected), 4)
        self.assertEqual(
            selection["budget"]["active_loss_counter_candidate_selected_count"],
            2,
        )
        self.assertEqual(
            sum(
                1
                for reason in selected_reasons.values()
                if reason == "active_loss_counter_candidate"
            ),
            2,
        )
        self.assertGreaterEqual(
            sum(
                1
                for reason in selected_reasons.values()
                if reason == "runtime_strategy_floor"
            ),
            1,
        )
