from __future__ import annotations

# ruff: noqa: F403,F405
from tests.whitepaper_autoresearch.autoresearch_runner_base import *


class TestAutoresearchRunnerNextEpoch(WhitepaperAutoresearchRunnerTestCaseBase):
    def test_remediation_prioritizes_missing_promotion_proof(self) -> None:
        remediation = runner._candidate_search_remediation(
            failure_reason="portfolio_optimizer_produced_no_candidate",
            candidate_selection={
                "budget": {"compiled_candidate_count": "not-an-int"},
                "rows": [
                    {
                        "candidate_spec_id": "spec-selected",
                        "selected_for_replay": True,
                    }
                ],
            },
            evidence_bundles=(),
            false_positive_table=(
                {
                    "candidate_spec_id": "spec-selected",
                    "evidence_status": "replayed",
                    "failure_reasons": [
                        "shadow_parity_status_not_within_budget",
                        "executable_replay_not_passed",
                        "executable_replay_artifact_missing",
                        "executable_replay_account_buying_power_missing",
                        "executable_replay_max_notional_missing",
                        "market_impact_liquidity_evidence_present_failed",
                        "market_impact_stress_model_failed",
                        "market_impact_stress_cost_bps_failed",
                        "delay_adjusted_depth_stress_model_failed",
                        "delay_adjusted_depth_stress_ms_failed",
                        "double_oos_artifact_present_failed",
                        "double_oos_cost_shock_net_pnl_per_day_failed",
                    ],
                },
            ),
            best_false_negative_table=(),
            replay_timeout_seconds=7200,
            max_frontier_candidates_per_spec=2,
        )

        proof_action = remediation["next_actions"][0]
        self.assertEqual(
            proof_action["action"],
            "complete_runtime_closure_double_oos_and_shadow_evidence",
        )
        self.assertEqual(
            proof_action["blocking_failure_counts"]["executable_replay_not_passed"],
            1,
        )
        self.assertIn(
            "executable_replay_artifact_ref",
            proof_action["required_scorecard_fields"],
        )
        self.assertIn(
            "market_impact_liquidity_evidence_present",
            proof_action["required_scorecard_fields"],
        )
        self.assertIn(
            "delay_adjusted_depth_stress_model",
            proof_action["required_scorecard_fields"],
        )
        self.assertIn(
            "double_oos_cost_shock_net_pnl_per_day",
            proof_action["required_scorecard_fields"],
        )

    def test_remediation_defers_promotion_proof_until_profit_gates_pass(self) -> None:
        remediation = runner._candidate_search_remediation(
            failure_reason="portfolio_candidate_failed_profit_target_oracle",
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": "spec-selected",
                        "selected_for_replay": True,
                    }
                ]
            },
            evidence_bundles=(),
            false_positive_table=(
                {
                    "candidate_spec_id": "spec-selected",
                    "evidence_status": "replayed",
                    "failure_reasons": [
                        "positive_day_ratio_below_oracle",
                        "max_drawdown_above_oracle",
                        "shadow_parity_status_not_within_budget",
                        "executable_replay_not_passed",
                    ],
                },
            ),
            best_false_negative_table=(),
            replay_timeout_seconds=7200,
            max_frontier_candidates_per_spec=2,
            current_top_k=24,
            current_exploration_slots=16,
            current_portfolio_size_min=3,
            current_max_candidates=96,
            current_max_total_frontier_candidates=48,
        )

        self.assertEqual(
            remediation["next_actions"][0]["action"],
            "increase_breadth_and_portfolio_diversity",
        )
        proof_action = next(
            action
            for action in remediation["next_actions"]
            if action["action"]
            == "complete_runtime_closure_double_oos_and_shadow_evidence"
        )
        self.assertEqual(
            proof_action["deferred_until"],
            "portfolio_profit_and_risk_oracle_failures_clear",
        )
        self.assertEqual(
            proof_action["blocked_by_non_proof_failure_counts"][
                "positive_day_ratio_below_oracle"
            ],
            1,
        )
        self.assertEqual(proof_action["priority"], 7)

    def test_remediation_increases_breadth_from_current_epoch(self) -> None:
        remediation = runner._candidate_search_remediation(
            failure_reason="portfolio_optimizer_produced_no_candidate",
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": "spec-selected",
                        "selected_for_replay": True,
                    }
                ]
            },
            evidence_bundles=(),
            false_positive_table=(
                {
                    "candidate_spec_id": "spec-selected",
                    "evidence_status": "replayed",
                    "failure_reasons": [
                        "active_day_ratio_below_oracle",
                        "positive_day_ratio_below_oracle",
                    ],
                },
            ),
            best_false_negative_table=(),
            replay_timeout_seconds=7200,
            max_frontier_candidates_per_spec=2,
            current_top_k=16,
            current_exploration_slots=8,
            current_portfolio_size_min=2,
            current_max_candidates=64,
            current_max_total_frontier_candidates=24,
        )

        breadth_action = remediation["next_actions"][0]
        self.assertEqual(
            breadth_action["action"], "increase_breadth_and_portfolio_diversity"
        )
        self.assertEqual(breadth_action["recommended_flags"]["--top-k"], "24")
        self.assertEqual(
            breadth_action["recommended_flags"]["--exploration-slots"], "16"
        )
        self.assertEqual(breadth_action["recommended_flags"]["--max-candidates"], "96")
        self.assertEqual(
            breadth_action["recommended_flags"]["--max-total-frontier-candidates"],
            "48",
        )
        self.assertEqual(
            breadth_action["recommended_flags"]["--portfolio-size-min"], "3"
        )

    def test_remediation_recommends_profile_surface_when_selection_budget_exhausted(
        self,
    ) -> None:
        selected_rows = [
            {
                "candidate_spec_id": f"spec-selected-{index}",
                "family_template_id": family_template_id,
                "selected_for_replay": True,
            }
            for index, family_template_id in enumerate(
                (
                    "breakout_reclaim_v2",
                    "intraday_tsmom_v2",
                    "mean_reversion_rebound_v1",
                    "microbar_cross_sectional_pairs_v1",
                    "microstructure_continuation_matched_filter_v1",
                )
                * 3,
                start=1,
            )
        ]
        remediation = runner._candidate_search_remediation(
            failure_reason="portfolio_optimizer_produced_no_candidate",
            candidate_selection={
                "budget": {
                    "compiled_candidate_count": 54,
                    "unique_execution_signature_count": 15,
                    "selected_count": 15,
                    "max_candidates": 1032,
                    "top_k": 520,
                    "exploration_slots_effective": 512,
                },
                "rows": selected_rows,
            },
            evidence_bundles=(),
            false_positive_table=tuple(
                {
                    "candidate_spec_id": row["candidate_spec_id"],
                    "evidence_status": "replayed",
                    "failure_reasons": [
                        "active_day_ratio_below_oracle",
                        "positive_day_ratio_below_oracle",
                    ],
                }
                for row in selected_rows
            ),
            best_false_negative_table=(),
            replay_timeout_seconds=7200,
            max_frontier_candidates_per_spec=2,
            current_top_k=520,
            current_exploration_slots=512,
            current_portfolio_size_min=3,
            current_max_candidates=1032,
            current_max_total_frontier_candidates=128,
        )

        self.assertTrue(remediation["candidate_surface_exhausted"])
        surface_action = remediation["next_actions"][0]
        self.assertEqual(surface_action["action"], "expand_execution_profile_surface")
        self.assertEqual(
            surface_action["observed_selection_budget"][
                "unique_execution_signature_count"
            ],
            15,
        )
        self.assertEqual(
            surface_action["target_family_template_ids"],
            [
                "breakout_reclaim_v2",
                "intraday_tsmom_v2",
                "mean_reversion_rebound_v1",
                "microbar_cross_sectional_pairs_v1",
                "microstructure_continuation_matched_filter_v1",
            ],
        )
        self.assertNotIn("recommended_flags", surface_action)
        self.assertFalse(
            [
                action
                for action in remediation["next_actions"]
                if action["action"] == "increase_breadth_and_portfolio_diversity"
            ]
        )

    def test_remediation_recommends_surface_mutation_when_only_eligible_specs_replayed(
        self,
    ) -> None:
        selected_rows = [
            {
                "candidate_spec_id": "spec-eligible",
                "family_template_id": "end_of_day_reversal_v1",
                "selected_for_replay": True,
            }
        ]
        remediation = runner._candidate_search_remediation(
            failure_reason="portfolio_optimizer_produced_no_candidate",
            candidate_selection={
                "budget": {
                    "compiled_candidate_count": 2250,
                    "unique_execution_signature_count": 375,
                    "eligible_candidate_count": 1,
                    "selected_count": 1,
                    "pre_replay_feedback_blocked_candidate_count": 179,
                    "pre_replay_nonpositive_synthetic_candidate_count": 185,
                    "pre_replay_blocked_candidate_count": 364,
                    "max_candidates": 264,
                    "top_k": 136,
                    "exploration_slots_effective": 128,
                },
                "rows": selected_rows,
            },
            evidence_bundles=(),
            false_positive_table=(
                {
                    "candidate_spec_id": "spec-eligible",
                    "evidence_status": "replayed",
                    "failure_reasons": [
                        "active_day_ratio_below_oracle",
                        "positive_day_ratio_below_oracle",
                        "non_positive_net_pnl_per_day",
                    ],
                },
            ),
            best_false_negative_table=(),
            replay_timeout_seconds=7200,
            max_frontier_candidates_per_spec=2,
            current_top_k=136,
            current_exploration_slots=128,
            current_portfolio_size_min=3,
            current_max_candidates=264,
            current_max_total_frontier_candidates=128,
        )

        self.assertFalse(remediation["candidate_surface_exhausted"])
        self.assertTrue(remediation["replayable_candidate_surface_exhausted"])
        surface_action = remediation["next_actions"][0]
        self.assertEqual(surface_action["action"], "expand_execution_profile_surface")
        self.assertIn("currently eligible", surface_action["reason"])
        self.assertEqual(
            surface_action["target_family_template_ids"], ["end_of_day_reversal_v1"]
        )
        self.assertFalse(
            [
                action
                for action in remediation["next_actions"]
                if action["action"] == "increase_breadth_and_portfolio_diversity"
            ]
        )

    def test_remediation_recommends_surface_mutation_when_mlx_blocks_synthetic_prior(
        self,
    ) -> None:
        remediation = runner._candidate_search_remediation(
            failure_reason="portfolio_optimizer_produced_no_candidate",
            candidate_selection={
                "budget": {
                    "compiled_candidate_count": 12,
                    "unique_execution_signature_count": 12,
                    "eligible_candidate_count": 0,
                    "selected_count": 0,
                    "pre_replay_nonpositive_synthetic_candidate_count": 12,
                    "pre_replay_blocked_candidate_count": 12,
                    "max_candidates": 12,
                    "top_k": 8,
                    "exploration_slots_effective": 4,
                },
                "rows": [
                    {
                        "candidate_spec_id": "spec-negative-prior",
                        "selected_for_replay": False,
                        "selection_reason": "pre_replay_mlx_synthetic_nonpositive_expected_value",
                    }
                ],
            },
            evidence_bundles=(),
            false_positive_table=(),
            best_false_negative_table=(),
            replay_timeout_seconds=7200,
            max_frontier_candidates_per_spec=2,
        )

        self.assertEqual(
            remediation["next_actions"][0]["action"],
            "expand_or_mutate_strategy_surface_after_negative_mlx_prior",
        )
        self.assertEqual(
            remediation["next_actions"][0]["observed_selection_budget"][
                "pre_replay_nonpositive_synthetic_candidate_count"
            ],
            12,
        )

    def test_remediation_recommends_surface_mutation_when_feedback_blocks_all_candidates(
        self,
    ) -> None:
        remediation = runner._candidate_search_remediation(
            failure_reason="portfolio_optimizer_produced_no_candidate",
            candidate_selection={
                "budget": {
                    "compiled_candidate_count": 8,
                    "unique_execution_signature_count": 8,
                    "eligible_candidate_count": 0,
                    "selected_count": 0,
                    "pre_replay_feedback_blocked_candidate_count": 8,
                    "pre_replay_blocked_candidate_count": 8,
                    "max_candidates": 8,
                    "top_k": 4,
                    "exploration_slots_effective": 4,
                },
                "rows": [
                    {
                        "candidate_spec_id": "spec-feedback-blocked",
                        "selected_for_replay": False,
                        "selection_reason": "pre_replay_mlx_feedback_blocked",
                    }
                ],
            },
            evidence_bundles=(),
            false_positive_table=(),
            best_false_negative_table=(),
            replay_timeout_seconds=7200,
            max_frontier_candidates_per_spec=2,
        )

        self.assertEqual(
            remediation["next_actions"][0]["action"],
            "expand_or_mutate_strategy_surface_after_feedback_blocks_all_candidates",
        )
        self.assertEqual(
            remediation["next_actions"][0]["observed_selection_budget"][
                "pre_replay_feedback_blocked_candidate_count"
            ],
            8,
        )

    def test_next_epoch_plan_rejects_breadth_shrinking_remediation_flags(self) -> None:
        with TemporaryDirectory() as tmpdir:
            args = self._args(Path(tmpdir) / "epoch")
            args.max_candidates = 64
            args.top_k = 16
            args.exploration_slots = 8
            args.portfolio_size_min = 2
            args.replay_mode = "real"
            remediation = {
                "next_actions": [
                    {
                        "action": "increase_breadth_and_portfolio_diversity",
                        "recommended_flags": {
                            "--top-k": "11",
                            "--exploration-slots": "4",
                            "--portfolio-size-min": "3",
                        },
                    }
                ]
            }

            plan = runner._profitability_next_epoch_plan(
                args=args, target=Decimal("500"), remediation=remediation
            )

        self.assertEqual(plan["flags"]["--target-net-pnl-per-day"], "500")
        self.assertEqual(plan["flags"]["--replay-mode"], "real")
        self.assertEqual(plan["flags"]["--max-candidates"], "64")
        self.assertEqual(plan["flags"]["--top-k"], "16")
        self.assertEqual(plan["flags"]["--exploration-slots"], "8")
        self.assertEqual(plan["flags"]["--portfolio-size-min"], "3")
        self.assertIn(
            {
                "action": "increase_breadth_and_portfolio_diversity",
                "flag": "--top-k",
                "current_value": "16",
                "recommended_value": "11",
                "reason": "rejected_to_preserve_or_increase_search_breadth",
            },
            plan["rejected_recommended_flags"],
        )
        self.assertIn(
            {
                "action": "increase_breadth_and_portfolio_diversity",
                "flag": "--exploration-slots",
                "current_value": "8",
                "recommended_value": "4",
                "reason": "rejected_to_preserve_or_increase_search_breadth",
            },
            plan["rejected_recommended_flags"],
        )
        self.assertIn(
            "timeout remediation may reduce --max-frontier-candidates-per-spec only to finish complete evidence",
            plan["no_fast_path_policy"]["allowed_decreases"],
        )

    def test_next_epoch_plan_allows_timeout_frontier_shrink_only(self) -> None:
        with TemporaryDirectory() as tmpdir:
            args = self._args(Path(tmpdir) / "epoch")
            args.max_frontier_candidates_per_spec = 8
            remediation = {
                "next_actions": [
                    {
                        "action": "shrink_per_spec_frontier_or_extend_timeout",
                        "recommended_flags": {
                            "--max-frontier-candidates-per-spec": "2",
                            "--real-replay-timeout-seconds": "7200",
                        },
                    }
                ]
            }

            plan = runner._profitability_next_epoch_plan(
                args=args, target=Decimal("500"), remediation=remediation
            )

        self.assertEqual(plan["flags"]["--max-frontier-candidates-per-spec"], "2")
        self.assertEqual(plan["flags"]["--real-replay-timeout-seconds"], "7200")
        self.assertFalse(plan["rejected_recommended_flags"])

    def test_next_epoch_plan_preserves_runtime_flags_and_rejects_invalid_numbers(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            args = self._args(Path(tmpdir) / "epoch")
            args.max_candidates = "not-a-number"
            args.max_total_frontier_candidates = 24
            args.real_replay_timeout_seconds = 7200
            args.real_replay_shard_size = 2
            args.real_replay_shard_timeout_seconds = 1200
            args.real_replay_shard_workers = 3
            args.real_replay_failed_spec_retries = 2
            args.real_replay_retry_timeout_seconds = 1800
            args.real_replay_retry_max_frontier_candidates_per_spec = 3
            args.shadow_validation_artifact = Path("/tmp/shadow-validation.json")
            remediation = {
                "next_actions": [
                    {
                        "action": "increase_breadth_and_portfolio_diversity",
                        "recommended_flags": {
                            "--top-k": "not-a-number",
                            "--max-total-frontier-candidates": "48",
                            "--kubernetes-fanout": "32",
                            "--real-replay-shard-workers": "16",
                            "--real-replay-shard-timeout-seconds": "3600",
                        },
                    }
                ]
            }

            plan = runner._profitability_next_epoch_plan(
                args=args, target=Decimal("500"), remediation=remediation
            )
            flags = runner._profitability_next_epoch_flags(
                args=args, target=Decimal("500"), remediation=remediation
            )

        self.assertEqual(flags, plan["flags"])
        self.assertEqual(plan["flags"]["--max-candidates"], "64")
        self.assertEqual(plan["flags"]["--top-k"], "16")
        self.assertEqual(plan["flags"]["--max-total-frontier-candidates"], "48")
        self.assertEqual(plan["flags"]["--real-replay-timeout-seconds"], "7200")
        self.assertEqual(plan["flags"]["--real-replay-shard-size"], "2")
        self.assertEqual(plan["flags"]["--real-replay-shard-timeout-seconds"], "900")
        self.assertEqual(plan["flags"]["--real-replay-shard-workers"], "2")
        self.assertEqual(plan["flags"]["--real-replay-failed-spec-retries"], "2")
        self.assertEqual(plan["flags"]["--real-replay-retry-timeout-seconds"], "1800")
        self.assertEqual(
            plan["flags"]["--real-replay-retry-max-frontier-candidates-per-spec"],
            "3",
        )
        self.assertEqual(
            plan["flags"]["--shadow-validation-artifact"],
            str(Path("/tmp/shadow-validation.json")),
        )
        self.assertIn(
            {
                "action": "increase_breadth_and_portfolio_diversity",
                "flag": "--top-k",
                "current_value": "16",
                "recommended_value": "not-a-number",
                "reason": "rejected_invalid_numeric_remediation_flag",
            },
            plan["rejected_recommended_flags"],
        )
        self.assertIn(
            {
                "action": "increase_breadth_and_portfolio_diversity",
                "flag": "--kubernetes-fanout",
                "current_value": "",
                "recommended_value": "32",
                "reason": "rejected_unsafe_cluster_fanout_or_promotion_flag",
            },
            plan["rejected_recommended_flags"],
        )
        self.assertIn(
            {
                "action": "increase_breadth_and_portfolio_diversity",
                "flag": "--real-replay-shard-workers",
                "current_value": "2",
                "recommended_value": "16",
                "reason": "rejected_broad_replay_worker_fanout",
            },
            plan["rejected_recommended_flags"],
        )
        self.assertIn(
            {
                "flag": "--real-replay-shard-timeout-seconds",
                "requested_value": "1200",
                "capped_value": "900",
                "reason": "capped_to_local_shard_timeout_no_cluster_fanout",
            },
            plan["capped_runtime_flags"],
        )
        self.assertIn(
            {
                "action": "increase_breadth_and_portfolio_diversity",
                "flag": "--real-replay-shard-timeout-seconds",
                "requested_value": "3600",
                "capped_value": "900",
                "reason": "capped_to_local_shard_timeout_no_cluster_fanout",
            },
            plan["capped_runtime_flags"],
        )
        self.assertIn(
            {
                "action": "increase_breadth_and_portfolio_diversity",
                "flag": "--real-replay-shard-timeout-seconds",
                "value": "900",
            },
            plan["applied_recommended_flags"],
        )
        self.assertIn(
            {
                "flag": "--real-replay-shard-workers",
                "requested_value": "3",
                "capped_value": "2",
                "reason": "capped_to_local_worker_limit_no_kubernetes_fanout",
            },
            plan["capped_runtime_flags"],
        )
        self.assertTrue(plan["no_fast_path_policy"]["no_kubernetes_fanout"])
        self.assertEqual(
            plan["no_fast_path_policy"]["max_generated_real_replay_shard_workers"], 2
        )
        self.assertNotIn("--kubernetes-fanout", plan["flags"])

    def test_next_epoch_plan_rejects_invalid_shard_timeout_remediation(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            args = self._args(Path(tmpdir) / "epoch")
            remediation = {
                "next_actions": [
                    {
                        "action": "increase_breadth_and_portfolio_diversity",
                        "recommended_flags": {
                            "--real-replay-shard-timeout-seconds": "not-a-number",
                        },
                    }
                ]
            }

            plan = runner._profitability_next_epoch_plan(
                args=args, target=Decimal("500"), remediation=remediation
            )

        self.assertEqual(
            runner._bounded_real_replay_shard_timeout_seconds(0),
            runner._DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS,
        )
        self.assertEqual(
            runner._bounded_real_replay_shard_timeout_seconds(-1),
            runner._DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS,
        )
        self.assertEqual(plan["flags"]["--real-replay-shard-timeout-seconds"], "900")
        self.assertIn(
            {
                "action": "increase_breadth_and_portfolio_diversity",
                "flag": "--real-replay-shard-timeout-seconds",
                "current_value": "900",
                "recommended_value": "not-a-number",
                "reason": "rejected_invalid_numeric_remediation_flag",
            },
            plan["rejected_recommended_flags"],
        )

    def test_next_epoch_plan_applies_within_limit_shard_timeout_remediation(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            args = self._args(Path(tmpdir) / "epoch")
            args.real_replay_shard_timeout_seconds = 900
            remediation = {
                "next_actions": [
                    {
                        "action": "shrink_per_spec_frontier_or_extend_timeout",
                        "recommended_flags": {
                            "--real-replay-shard-timeout-seconds": "600",
                        },
                    }
                ]
            }

            plan = runner._profitability_next_epoch_plan(
                args=args, target=Decimal("500"), remediation=remediation
            )

        self.assertEqual(plan["flags"]["--real-replay-shard-timeout-seconds"], "600")
        self.assertFalse(plan["rejected_recommended_flags"])
        self.assertFalse(plan["capped_runtime_flags"])
        self.assertIn(
            {
                "action": "shrink_per_spec_frontier_or_extend_timeout",
                "flag": "--real-replay-shard-timeout-seconds",
                "value": "600",
            },
            plan["applied_recommended_flags"],
        )

    def test_train_ranker_script_main_writes_model_and_scores(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            payload = runner.run_whitepaper_autoresearch_profit_target(
                self._source_jsonl_args(output_dir)
            )
            model_output = Path(tmpdir) / "ranker" / "model.json"
            scores_output = Path(tmpdir) / "ranker" / "scores.jsonl"

            with (
                patch(
                    "sys.argv",
                    [
                        "train_mlx_autoresearch_ranker.py",
                        "--candidate-specs",
                        str(output_dir / "candidate-specs.jsonl"),
                        "--evidence-bundles",
                        str(output_dir / "candidate-evidence-bundles.jsonl"),
                        "--model-output",
                        str(model_output),
                        "--scores-output",
                        str(scores_output),
                        "--backend-preference",
                        "numpy-fallback",
                    ],
                ),
                patch("builtins.print") as mock_print,
            ):
                exit_code = ranker_trainer.main()

            model_payload = json.loads(model_output.read_text(encoding="utf-8"))
            score_rows = scores_output.read_text(encoding="utf-8").splitlines()

        self.assertEqual(exit_code, 0)
        self.assertEqual(model_payload["backend"], "numpy-fallback")
        self.assertIn("rank_bucket_lift", model_payload)
        self.assertEqual(len(score_rows), payload["candidate_spec_count"])
        self.assertIn("selection_reason", json.loads(score_rows[0]))
        self.assertTrue(mock_print.called)
