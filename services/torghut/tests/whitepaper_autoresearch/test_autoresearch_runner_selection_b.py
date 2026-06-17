from __future__ import annotations

from tests.whitepaper_autoresearch.autoresearch_runner_base import (
    Any,
    Decimal,
    WhitepaperAutoresearchRunnerTestCaseBase,
    cast,
    replace,
    runner,
)


class TestAutoresearchRunnerSelectionB(WhitepaperAutoresearchRunnerTestCaseBase):
    def test_candidate_selection_blocks_no_activity_feedback_from_reaudit(
        self,
    ) -> None:
        spec = self._candidate_spec("spec-no-activity-feedback")
        feedback_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-no-activity-feedback",
                "family_template_id": spec.family_template_id,
                "runtime_family": spec.runtime_family,
                "runtime_strategy_name": spec.runtime_strategy_name,
                "objective_scorecard": {
                    "net_pnl_per_day": "75",
                    "active_day_ratio": "0",
                    "positive_day_ratio": "0",
                    "decision_count": 0,
                    "filled_count": 0,
                    "orders_submitted_count": 0,
                    "avg_filled_notional_per_day": "0",
                },
            },
            dataset_snapshot_id="snap-no-activity-feedback",
            result_path="feedback://no-activity",
        )

        _model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(spec,),
            feedback_evidence_bundles=(feedback_bundle,),
        )

        self.assertEqual(rows[0]["training_source"], "feedback_real_replay")
        self.assertEqual(
            rows[0]["selection_reason"],
            "pre_replay_mlx_no_activity_feedback_blocked",
        )

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(spec,),
            proposal_rows=rows,
            top_k=1,
            exploration_slots=0,
            feedback_block_reaudit_slots=1,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [])
        self.assertEqual(selection["budget"]["selected_count"], 0)
        self.assertEqual(
            selection["budget"]["feedback_block_reaudit_selected_count"], 0
        )
        self.assertEqual(
            selection["rows"][0]["selection_reason"],
            "pre_replay_mlx_no_activity_feedback_blocked",
        )

    def test_candidate_selection_blocks_failed_false_negative_rescue_family(
        self,
    ) -> None:
        source_spec_base = self._candidate_spec(
            "spec-fn-rescue-negative-source",
            selection_mode="continuation",
        )
        source_params = cast(
            dict[str, Any], source_spec_base.strategy_overrides["params"]
        )
        source_spec = replace(
            source_spec_base,
            parameter_space={
                "mechanism_overlay_ids": ["rejected_signal_outcome_calibration"]
            },
            strategy_overrides={
                **source_spec_base.strategy_overrides,
                "params": {
                    **source_params,
                    "signal_motif": "rejected_signal_false_negative_replay",
                    "outcome_label_filter": "profitable_after_costs",
                    "veto_relaxation_scope": "labeled_false_negative_only",
                    "rank_feature": "rejected_signal_counterfactual_return_rank",
                },
            },
        )
        probe_spec_base = self._candidate_spec(
            "spec-fn-rescue-negative-probe",
            selection_mode="continuation",
        )
        probe_params = cast(
            dict[str, Any], probe_spec_base.strategy_overrides["params"]
        )
        probe_spec = replace(
            probe_spec_base,
            parameter_space={
                "mechanism_overlay_ids": ["rejected_signal_outcome_calibration"]
            },
            strategy_overrides={
                **probe_spec_base.strategy_overrides,
                "params": {
                    **probe_params,
                    "signal_motif": "rejected_signal_false_negative_replay",
                    "outcome_label_filter": "profitable_after_costs",
                    "veto_relaxation_scope": "labeled_false_negative_only",
                    "rank_feature": "rejected_signal_opening_drive_rank",
                },
            },
        )
        feedback_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=source_spec.candidate_spec_id,
            candidate=runner._candidate_payload_with_feedback_metadata(
                spec=source_spec,
                candidate={
                    "candidate_id": "cand-fn-rescue-negative-source",
                    "objective_scorecard": {
                        "net_pnl_per_day": "-47.54",
                        "active_day_ratio": "0.66",
                        "positive_day_ratio": "0",
                        "negative_day_count": 3,
                        "daily_net": {
                            "2026-05-06": "-77.11",
                            "2026-05-07": "-65.51",
                        },
                    },
                },
            ),
            dataset_snapshot_id="snap-fn-rescue-negative-feedback",
            result_path="feedback://fn-rescue-negative",
        )

        _model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(probe_spec,),
            feedback_evidence_bundles=(feedback_bundle,),
        )

        self.assertEqual(rows[0]["training_source"], "feedback_family_replay")
        self.assertEqual(
            rows[0]["selection_reason"],
            "pre_replay_mlx_false_negative_rescue_feedback_blocked",
        )
        self.assertLessEqual(
            Decimal(str(rows[0]["proposal_score"])), Decimal("-999999")
        )

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(probe_spec,),
            proposal_rows=rows,
            top_k=1,
            exploration_slots=1,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [])
        self.assertEqual(selection["budget"]["selected_count"], 0)
        self.assertEqual(selection["budget"]["eligible_candidate_count"], 0)
        self.assertEqual(
            selection["rows"][0]["selection_reason"],
            "pre_replay_mlx_false_negative_rescue_feedback_blocked",
        )

    def test_candidate_selection_can_reaudit_feedback_blocked_candidates(
        self,
    ) -> None:
        source_spec = self._candidate_spec("spec-reaudit-source")
        blocked_spec = self._candidate_spec(
            "spec-reaudit-blocked",
            entry_minute_after_open="60",
        )
        capital_unsafe_spec = replace(
            self._candidate_spec(
                "spec-reaudit-capital-unsafe",
                family_template_id="breakout_reclaim_v2",
            ),
            strategy_overrides={
                **self._candidate_spec(
                    "spec-reaudit-capital-unsafe",
                    family_template_id="breakout_reclaim_v2",
                ).strategy_overrides,
                "max_notional_per_trade": "157950",
                "max_position_pct_equity": "4",
            },
        )
        feedback_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=source_spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-reaudit-source",
                "family_template_id": source_spec.family_template_id,
                "runtime_family": source_spec.runtime_family,
                "runtime_strategy_name": source_spec.runtime_strategy_name,
                "objective_scorecard": {
                    "net_pnl_per_day": "-250",
                    "active_day_ratio": "1",
                    "positive_day_ratio": "0",
                    "negative_day_count": 4,
                    "daily_net": {"2026-05-01": "-250"},
                },
            },
            dataset_snapshot_id="snap-reaudit-feedback",
            result_path="feedback://reaudit",
        )

        _model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(blocked_spec, capital_unsafe_spec),
            feedback_evidence_bundles=(feedback_bundle,),
        )

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(blocked_spec, capital_unsafe_spec),
            proposal_rows=rows,
            top_k=1,
            exploration_slots=0,
            feedback_block_reaudit_slots=1,
            max_candidates=2,
            portfolio_size_min=1,
        )
        row_by_spec = {row["candidate_spec_id"]: row for row in selection["rows"]}

        self.assertEqual(selected, [blocked_spec])
        self.assertEqual(selection["budget"]["selected_count"], 1)
        self.assertEqual(
            selection["budget"]["feedback_block_reaudit_selected_count"], 1
        )
        self.assertEqual(
            row_by_spec[blocked_spec.candidate_spec_id]["selection_reason"],
            "feedback_block_reaudit",
        )
        self.assertFalse(
            row_by_spec[capital_unsafe_spec.candidate_spec_id]["selected_for_replay"]
        )

    def test_candidate_selection_replays_feedback_reaudit_before_synthetic_probe(
        self,
    ) -> None:
        feedback_spec = self._candidate_spec("spec-feedback-first")
        synthetic_probe_spec = self._candidate_spec(
            "spec-synthetic-probe",
            family_template_id="mean_reversion_rebound_v1",
            entry_minute_after_open="75",
        )

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(synthetic_probe_spec, feedback_spec),
            proposal_rows=[
                {
                    "candidate_spec_id": synthetic_probe_spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": -12.5,
                    "selection_reason": "pre_replay_mlx_rank",
                    "training_source": "synthetic_prior",
                    "feedback_evidence_context_count": 1,
                },
                {
                    "candidate_spec_id": feedback_spec.candidate_spec_id,
                    "rank": 2,
                    "proposal_score": -1_000_000,
                    "selection_reason": "pre_replay_mlx_feedback_blocked",
                    "training_source": "feedback_real_replay",
                },
            ],
            top_k=1,
            exploration_slots=1,
            feedback_block_reaudit_slots=1,
            max_candidates=2,
            portfolio_size_min=1,
        )
        row_by_spec = {row["candidate_spec_id"]: row for row in selection["rows"]}

        self.assertEqual(selected, [feedback_spec, synthetic_probe_spec])
        self.assertEqual(
            row_by_spec[feedback_spec.candidate_spec_id]["selection_reason"],
            "feedback_block_reaudit",
        )
        self.assertEqual(
            row_by_spec[synthetic_probe_spec.candidate_spec_id]["selection_reason"],
            "synthetic_prior_exploration",
        )
        self.assertEqual(
            row_by_spec[feedback_spec.candidate_spec_id]["replay_order"], 1
        )
        self.assertEqual(
            row_by_spec[synthetic_probe_spec.candidate_spec_id]["replay_order"], 2
        )

    def test_candidate_selection_keeps_positive_blocked_feedback_repair_candidates(
        self,
    ) -> None:
        spec = self._candidate_spec("spec-positive-blocked-feedback")
        feedback_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-positive-blocked-feedback",
                "family_template_id": spec.family_template_id,
                "runtime_family": spec.runtime_family,
                "runtime_strategy_name": spec.runtime_strategy_name,
                "objective_scorecard": {
                    "net_pnl_per_day": "959.07",
                    "active_day_ratio": "0.2",
                    "positive_day_ratio": "0.2",
                    "negative_day_count": 2,
                    "min_cash": "-100",
                    "negative_cash_observation_count": 8,
                    "daily_net": {
                        "2026-05-01": "4795.37",
                        "2026-05-04": "-980.59",
                    },
                },
            },
            dataset_snapshot_id="snap-positive-blocked-feedback",
            result_path="feedback://positive-blocked",
        )

        _model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(spec,),
            feedback_evidence_bundles=(feedback_bundle,),
        )

        self.assertEqual(rows[0]["training_source"], "feedback_real_replay")
        self.assertEqual(
            rows[0]["selection_reason"], "pre_replay_mlx_feedback_penalized"
        )
        self.assertGreater(Decimal(str(rows[0]["proposal_score"])), Decimal("-999999"))

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(spec,),
            proposal_rows=rows,
            top_k=1,
            exploration_slots=0,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [spec])
        self.assertEqual(selection["budget"]["selected_count"], 1)
        self.assertEqual(selection["budget"]["eligible_candidate_count"], 1)
        self.assertEqual(
            selection["rows"][0]["selection_reason"],
            "exploitation",
        )

    def test_candidate_selection_blocks_capital_infeasible_replay_candidates(
        self,
    ) -> None:
        base_unsafe_spec = self._candidate_spec("spec-unsafe-capital")
        unsafe_spec = replace(
            base_unsafe_spec,
            strategy_overrides={
                **base_unsafe_spec.strategy_overrides,
                "max_notional_per_trade": "157950",
                "max_position_pct_equity": "8.0",
            },
            promotion_contract={
                "profit_target_oracle_policy": {"max_gross_exposure_pct_equity": "1.0"}
            },
        )
        safe_spec = self._candidate_spec("spec-safe-capital")
        proposal_rows = [
            {
                "candidate_spec_id": unsafe_spec.candidate_spec_id,
                "proposal_score": 1000,
                "rank": 1,
                "selection_reason": "pre_replay_mlx_rank",
                "training_source": "synthetic_prior",
            },
            {
                "candidate_spec_id": safe_spec.candidate_spec_id,
                "proposal_score": 10,
                "rank": 2,
                "selection_reason": "pre_replay_mlx_rank",
                "training_source": "synthetic_prior",
            },
        ]

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(unsafe_spec, safe_spec),
            proposal_rows=proposal_rows,
            top_k=1,
            exploration_slots=0,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [safe_spec])
        row_by_spec = {row["candidate_spec_id"]: row for row in selection["rows"]}
        self.assertEqual(
            row_by_spec[unsafe_spec.candidate_spec_id]["selection_reason"],
            "pre_replay_capital_budget_blocked",
        )
        self.assertFalse(
            row_by_spec[unsafe_spec.candidate_spec_id]["selected_for_replay"]
        )
        self.assertEqual(
            selection["budget"]["pre_replay_capital_blocked_candidate_count"], 1
        )
        self.assertTrue(
            row_by_spec[safe_spec.candidate_spec_id]["capital_budget"][
                "capital_feasible"
            ]
        )

    def test_candidate_selection_keeps_positive_signature_feedback_repair_candidates(
        self,
    ) -> None:
        source_spec = self._candidate_spec("spec-positive-signature-source")
        matching_spec = self._candidate_spec("spec-positive-signature-match")
        feedback_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=source_spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-positive-signature-source",
                "family_template_id": source_spec.family_template_id,
                "runtime_family": source_spec.runtime_family,
                "runtime_strategy_name": source_spec.runtime_strategy_name,
                "execution_signature": runner._candidate_spec_execution_signature(
                    source_spec
                ),
                "objective_scorecard": {
                    "net_pnl_per_day": "741.86",
                    "active_day_ratio": "0.3333333333",
                    "positive_day_ratio": "0.1666666667",
                    "negative_day_count": 3,
                    "daily_net": {
                        "2026-05-01": "4451.21",
                        "2026-05-04": "-1668.80",
                    },
                },
            },
            dataset_snapshot_id="snap-positive-signature-feedback",
            result_path="feedback://positive-signature",
        )

        _model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(matching_spec,),
            feedback_evidence_bundles=(feedback_bundle,),
        )

        self.assertEqual(
            rows[0]["training_source"], "feedback_execution_signature_replay"
        )
        self.assertEqual(
            rows[0]["selection_reason"],
            "pre_replay_mlx_signature_feedback_penalized",
        )
        self.assertGreater(Decimal(str(rows[0]["proposal_score"])), Decimal("-999999"))

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(matching_spec,),
            proposal_rows=rows,
            top_k=1,
            exploration_slots=0,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [matching_spec])
        self.assertEqual(selection["budget"]["selected_count"], 1)
        self.assertEqual(selection["budget"]["eligible_candidate_count"], 1)

    def test_pre_replay_ranker_blocks_shape_and_penalizes_risk_profile_feedback(
        self,
    ) -> None:
        failed_spec = self._candidate_spec("spec-daily-coverage-source")
        same_shape_probe = replace(
            failed_spec,
            candidate_spec_id="spec-same-shape-probe",
            hypothesis_id="hyp-spec-same-shape-probe",
            hard_vetoes={"required_min_daily_notional": "400000"},
        )
        different_shape_same_risk_probe = replace(
            failed_spec,
            candidate_spec_id="spec-risk-profile-probe",
            hypothesis_id="hyp-spec-risk-profile-probe",
            hard_vetoes={"required_min_daily_notional": "450000"},
            strategy_overrides={
                **failed_spec.strategy_overrides,
                "params": {
                    **cast(dict[str, Any], failed_spec.strategy_overrides["params"]),
                    "entry_minute_after_open": "90",
                },
            },
        )
        clean_probe = self._candidate_spec(
            "spec-clean-probe",
            family_template_id="breakout_reclaim_v2",
            entry_minute_after_open="120",
            selection_mode="continuation",
        )
        self.assertNotEqual(
            runner._candidate_spec_execution_signature(failed_spec),
            runner._candidate_spec_execution_signature(same_shape_probe),
        )
        self.assertEqual(
            runner._candidate_spec_feedback_shape_key(failed_spec),
            runner._candidate_spec_feedback_shape_key(same_shape_probe),
        )
        self.assertNotEqual(
            runner._candidate_spec_feedback_shape_key(failed_spec),
            runner._candidate_spec_feedback_shape_key(different_shape_same_risk_probe),
        )
        self.assertEqual(
            runner._candidate_spec_feedback_risk_profile_key(failed_spec),
            runner._candidate_spec_feedback_risk_profile_key(
                different_shape_same_risk_probe
            ),
        )
        feedback_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=failed_spec.candidate_spec_id,
            candidate=runner._candidate_payload_with_feedback_metadata(
                spec=failed_spec,
                candidate={
                    "candidate_id": "cand-daily-coverage-source",
                    "objective_scorecard": {
                        "net_pnl_per_day": "959.07",
                        "active_day_ratio": "0.2",
                        "positive_day_ratio": "0.2",
                        "negative_day_count": 0,
                        "best_day_share": "0.92",
                        "daily_net": {
                            "2026-05-01": "4795.37",
                            "2026-05-04": "0",
                        },
                    },
                },
            ),
            dataset_snapshot_id="snap-daily-coverage-feedback",
            result_path="feedback://daily-coverage",
        )

        model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(same_shape_probe, different_shape_same_risk_probe, clean_probe),
            feedback_evidence_bundles=(feedback_bundle,),
        )

        row_by_spec = {row["candidate_spec_id"]: row for row in rows}
        self.assertEqual(model["feedback_shape_matched_spec_count"], 1)
        self.assertEqual(model["feedback_risk_profile_matched_spec_count"], 1)
        self.assertEqual(
            row_by_spec[same_shape_probe.candidate_spec_id]["training_source"],
            "feedback_shape_prior",
        )
        self.assertEqual(
            row_by_spec[same_shape_probe.candidate_spec_id]["selection_reason"],
            "pre_replay_mlx_shape_feedback_blocked",
        )
        self.assertLessEqual(
            Decimal(
                str(row_by_spec[same_shape_probe.candidate_spec_id]["proposal_score"])
            ),
            Decimal("-999999"),
        )
        self.assertEqual(
            row_by_spec[different_shape_same_risk_probe.candidate_spec_id][
                "training_source"
            ],
            "feedback_risk_profile_prior",
        )
        self.assertEqual(
            row_by_spec[different_shape_same_risk_probe.candidate_spec_id][
                "selection_reason"
            ],
            "pre_replay_mlx_risk_profile_feedback_penalized",
        )
        self.assertLessEqual(
            Decimal(
                str(
                    row_by_spec[different_shape_same_risk_probe.candidate_spec_id][
                        "proposal_score"
                    ]
                )
            ),
            Decimal("-500000"),
        )
        self.assertEqual(
            row_by_spec[clean_probe.candidate_spec_id]["training_source"],
            "synthetic_prior",
        )
