from __future__ import annotations

import scripts.whitepaper_autoresearch_runner.artifact_io as artifact_io
import scripts.whitepaper_autoresearch_runner.proposal_training as proposal_training

from tests.whitepaper_autoresearch.autoresearch_runner_base import (
    Decimal,
    Namespace,
    Path,
    TemporaryDirectory,
    WhitepaperAutoresearchRunnerTestCaseBase,
    _CHIP_UNIVERSE,
    _compact_recent_whitepaper_sources,
    json,
    runner,
)
import scripts.whitepaper_autoresearch_runner.candidate_board_paper_probation as candidate_board_paper_probation
import scripts.whitepaper_autoresearch_runner.candidate_board_runtime_windows as candidate_board_runtime_windows


class TestAutoresearchRunnerPaperProbationB(WhitepaperAutoresearchRunnerTestCaseBase):
    def test_candidate_board_single_paper_probation_fallback_blocker(self) -> None:
        row = {
            "candidate_spec_id": "spec-single-probation",
            "candidate_id": "cand-single-probation",
            "hypothesis_id": "H-MICRO-01",
            "runtime_family": "microstructure_breakout",
            "runtime_strategy_name": "microbar-volume-continuation-long-top2-chip-v1",
            "has_replay_evidence": True,
            "oracle_passed": False,
            "target_met": False,
            "decision_count": 4,
            "submitted_order_count": 4,
            "filled_order_count": 4,
            "exact_replay_ledger_artifact_ref": "single-exact-replay-ledger.json",
            "exact_replay_ledger_artifact_row_count": 12,
            "exact_replay_ledger_artifact_fill_count": 4,
            "runtime_window_start": "2026-05-18",
            "runtime_window_end": "2026-05-20",
            "net_pnl_per_day": "215",
            "market_impact_stress_passed": True,
            "market_impact_stress_net_pnl_per_day": "190",
            "delay_adjusted_depth_stress_passed": True,
            "delay_adjusted_depth_stress_net_pnl_per_day": "180",
            "post_cost_net_pnl_after_queue_position_survival_fill_stress": "170",
            "double_oos_passed": True,
            "double_oos_cost_shock_net_pnl_per_day": "175",
            "implementation_uncertainty_stability_passed": True,
            "implementation_uncertainty_lower_net_pnl_per_day": "165",
            "conformal_tail_risk_passed": True,
            "conformal_tail_risk_adjusted_net_pnl_per_day": "160",
            "delay_adjusted_depth_fill_survival_evidence_present": True,
            "delay_adjusted_depth_fill_survival_sample_count": 4,
            "delay_adjusted_depth_fill_survival_rate": "0.85",
            "queue_position_survival_fill_curve_evidence_present": True,
            "queue_position_survival_sample_count": 4,
            "queue_position_survival_fill_rate": "0.85",
            "queue_position_survival_queue_ratio_p95": "0.25",
            "queue_position_survival_queue_ahead_depletion_evidence_present": True,
            "queue_position_survival_queue_ahead_depletion_sample_count": 4,
            "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
            "delay_adjusted_depth_queue_ahead_depletion_sample_count": 4,
            "queue_ahead_depletion_evidence_present": True,
            "queue_ahead_depletion_sample_count": 4,
            "blockers": [],
        }

        candidate = (
            candidate_board_paper_probation._candidate_board_paper_probation_candidate(
                [row],
                target=Decimal("500"),
            )
        )

        self.assertIsNotNone(candidate)
        assert candidate is not None
        self.assertEqual(candidate["candidate_id"], "cand-single-probation")
        self.assertEqual(
            candidate["final_promotion_blockers"],
            ["final_promotion_requires_runtime_governance"],
        )
        self.assertFalse(candidate["final_promotion_allowed"])
        self.assertIsNone(
            candidate_board_paper_probation._candidate_board_paper_probation_candidate(
                [],
                target=Decimal("500"),
            )
        )

    def test_candidate_board_runtime_window_plan_dedupes_and_blocks_incomplete_targets(
        self,
    ) -> None:
        row = {
            "candidate_spec_id": "spec-runtime-plan",
            "candidate_id": "cand-runtime-plan",
            "hypothesis_id": "H-MICRO-01",
            "runtime_family": "microstructure_breakout",
            "runtime_strategy_name": "microbar-volume-continuation-long-top2-chip-v1",
            "dataset_snapshot_id": "snapshot-runtime-plan",
            "replay_artifact_refs": [
                "paper-runtime-plan.json",
                "paper-runtime-plan-exact-replay-ledger.json",
            ],
            "exact_replay_ledger_artifact_ref": "paper-runtime-plan-exact-replay-ledger.json",
            "exact_replay_ledger_artifact_row_count": 36,
            "exact_replay_ledger_artifact_fill_count": 12,
            "runtime_window_start": "2026-05-18T13:30:00+00:00",
            "runtime_window_end": "2026-05-20T20:00:00+00:00",
            "account_label": "TORGHUT_REPLAY",
            "blockers": ["delay_adjusted_depth_tail_coverage_passed_failed"],
        }
        fallback_row = {
            "candidate_spec_id": "spec-runtime-plan-fallback",
            "candidate_id": "cand-runtime-plan-fallback",
            "hypothesis_id": "H-MICRO-02",
            "runtime_family": "microstructure_breakout",
            "runtime_strategy_name": "microbar-volume-continuation-long-top2-chip-v1",
            "dataset_snapshot_id": "snapshot-runtime-plan-fallback",
            "exact_replay_ledger_artifact_refs": "fallback-exact-replay-ledger.json",
            "runtime_window_start": "2026-05-21T13:30:00+00:00",
            "runtime_window_end": "2026-05-21T20:00:00+00:00",
        }

        plan = (
            candidate_board_runtime_windows._candidate_board_runtime_window_import_plan(
                rows=(row,),
                paper_probation_candidate=row,
                promotion_subject={
                    "target_met": True,
                    "sleeve_candidate_spec_ids": ["spec-runtime-plan"],
                },
            )
        )
        fallback_plan = (
            candidate_board_runtime_windows._candidate_board_runtime_window_import_plan(
                rows=(),
                paper_probation_candidate=fallback_row,
                promotion_subject=None,
            )
        )
        incomplete_plan = candidate_board_runtime_windows._candidate_board_runtime_window_import_plan(
            rows=(),
            paper_probation_candidate={
                "candidate_spec_id": "spec-incomplete",
                "candidate_id": "",
                "hypothesis_id": "",
                "runtime_family": "microstructure_breakout",
                "runtime_strategy_name": "microbar-volume-continuation-long-top2-chip-v1",
            },
            promotion_subject=None,
        )

        self.assertEqual(
            candidate_board_runtime_windows._candidate_board_hypothesis_manifest_ref(
                None
            ),
            "",
        )
        self.assertEqual(
            candidate_board_runtime_windows._candidate_board_runtime_window_bounds(
                {
                    "runtime_window_start": "2026-05-01",
                    "runtime_window_end": "2026-05-02",
                }
            ),
            ("2026-05-01", "2026-05-02"),
        )
        self.assertEqual(plan["target_count"], 1)
        self.assertEqual(
            plan["targets"][0]["source_manifest_ref"],
            "config/trading/hypotheses/h-micro-01.json",
        )
        self.assertEqual(plan["targets"][0]["candidate_blockers"], row["blockers"])
        self.assertEqual(
            plan["targets"][0]["exact_replay_ledger_artifact_refs"],
            ["paper-runtime-plan-exact-replay-ledger.json"],
        )
        self.assertNotIn("runtime_ledger_artifact_refs", plan["targets"][0])
        self.assertEqual(
            plan["targets"][0]["window_start"], "2026-05-18T13:30:00+00:00"
        )
        self.assertEqual(plan["targets"][0]["window_end"], "2026-05-20T20:00:00+00:00")
        self.assertEqual(plan["targets"][0]["account_label"], "TORGHUT_REPLAY")
        self.assertIn(
            "paper-runtime-plan-exact-replay-ledger.json",
            plan["targets"][0]["import_command_args"],
        )
        self.assertIn(
            "--target-metadata-json",
            plan["targets"][0]["import_command_args"],
        )
        metadata_arg_index = (
            plan["targets"][0]["import_command_args"].index("--target-metadata-json")
            + 1
        )
        import_metadata = json.loads(
            plan["targets"][0]["import_command_args"][metadata_arg_index]
        )
        self.assertEqual(
            import_metadata["exact_replay_ledger_artifact_refs"],
            ["paper-runtime-plan-exact-replay-ledger.json"],
        )
        self.assertNotIn("runtime_ledger_artifact_refs", import_metadata)
        self.assertEqual(import_metadata["exact_replay_ledger_artifact_row_count"], 36)
        self.assertEqual(import_metadata["exact_replay_ledger_artifact_fill_count"], 12)
        self.assertEqual(import_metadata["window_start"], "2026-05-18T13:30:00+00:00")
        self.assertEqual(import_metadata["window_end"], "2026-05-20T20:00:00+00:00")
        self.assertEqual(fallback_plan["status"], "ready")
        self.assertEqual(fallback_plan["target_count"], 1)
        self.assertEqual(
            fallback_plan["targets"][0]["exact_replay_ledger_artifact_refs"],
            ["fallback-exact-replay-ledger.json"],
        )
        self.assertEqual(
            fallback_plan["targets"][0]["exact_replay_ledger_artifact_ref"],
            "fallback-exact-replay-ledger.json",
        )
        self.assertNotIn("runtime_ledger_artifact_ref", fallback_plan["targets"][0])
        self.assertEqual(
            fallback_plan["targets"][0]["account_label"],
            "TORGHUT_REPLAY",
        )
        self.assertEqual(incomplete_plan["status"], "blocked")
        self.assertEqual(incomplete_plan["target_count"], 0)
        self.assertEqual(
            incomplete_plan["blockers"][0]["missing_fields"],
            [
                "candidate_id",
                "hypothesis_id",
                "window_start",
                "window_end",
                "account_label",
            ],
        )

    def test_candidate_universe_symbols_default_to_chip_coverage_when_empty(
        self,
    ) -> None:
        symbols = artifact_io._candidate_universe_symbols_from_args(
            Namespace(symbols="MSFT,SHOP")
        )

        self.assertEqual(symbols, tuple(_CHIP_UNIVERSE))

    def test_full_chip_universe_is_compile_allowlist_not_profile_override(
        self,
    ) -> None:
        self.assertEqual(
            artifact_io._candidate_universe_symbols_for_compilation(
                Namespace(symbols=",".join(_CHIP_UNIVERSE))
            ),
            (),
        )
        self.assertEqual(
            artifact_io._candidate_universe_symbols_for_compilation(
                Namespace(symbols="MSFT,SHOP")
            ),
            (),
        )
        self.assertEqual(
            artifact_io._candidate_universe_symbols_for_compilation(
                Namespace(symbols="NVDA,AMAT,AAPL")
            ),
            ("NVDA", "AAPL"),
        )

    def test_rejects_candidate_universe_larger_than_twelve_symbols(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            args = self._args(output_dir)
            args.symbols = "A,B,C,D,E,F,G,H,I,J,K,L,M"

            payload = runner.run_whitepaper_autoresearch_profit_target(args)

        self.assertEqual(payload["status"], "invalid_universe")
        self.assertEqual(payload["failure_reason"], "candidate_universe_too_large:13")
        self.assertFalse((output_dir / "candidate-specs.jsonl").exists())

    def test_seed_recent_whitepapers_honors_top_k_and_exploration_budget(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir, _compact_recent_whitepaper_sources(4):
            output_dir = Path(tmpdir) / "epoch"
            args = self._args(output_dir)
            args.top_k = 1
            args.exploration_slots = 1
            args.max_frontier_candidates_per_spec = 2
            args.max_total_frontier_candidates = 6
            payload = runner.run_whitepaper_autoresearch_profit_target(args)

            selection = json.loads(
                (output_dir / "candidate-selection-manifest.json").read_text(
                    encoding="utf-8"
                )
            )
            proposal_rows = [
                json.loads(line)
                for line in (output_dir / "mlx-proposal-scores.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
                if line
            ]
            pre_replay_rows = [
                json.loads(line)
                for line in (output_dir / "pre-replay-mlx-proposal-scores.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
                if line
            ]

        self.assertEqual(payload["status"], "no_profit_target_candidate")
        self.assertEqual(
            payload["profit_target_oracle_policy"]["min_daily_net_pnl"], "-999999999"
        )
        self.assertEqual(selection["budget"]["exploration_slots_requested"], 1)
        self.assertGreaterEqual(selection["budget"]["exploration_slots_effective"], 1)
        self.assertEqual(selection["budget"]["selected_count"], 3)
        self.assertEqual(payload["replay_candidate_spec_count"], 3)
        self.assertEqual(payload["evidence_bundle_count"], 3)
        self.assertGreater(payload["candidate_spec_count"], args.max_candidates)
        self.assertEqual(
            selection["budget"]["compiled_candidate_count"],
            payload["candidate_spec_count"],
        )
        self.assertTrue(payload["best_false_negative_table"])
        self.assertEqual(
            payload["best_false_negative_table"][0]["evidence_status"], "not_replayed"
        )
        self.assertFalse(payload["best_false_negative_table"][0]["selected_for_replay"])
        selected_rows = [row for row in selection["rows"] if row["selected_for_replay"]]
        self.assertGreater(selection["budget"]["capital_feasible_candidate_count"], 0)
        self.assertTrue(
            all(row["capital_budget"]["capital_feasible"] for row in selected_rows)
        )
        selected_reasons = {row["selection_reason"] for row in selected_rows}
        self.assertIn("runtime_strategy_floor", selected_reasons)
        self.assertLessEqual(
            selected_reasons,
            {
                "runtime_strategy_floor",
                "exploitation",
                "exploration",
                "budget_backfill",
            },
        )
        proposal_selected = [row for row in proposal_rows if row["selected_for_replay"]]
        self.assertEqual(len(proposal_selected), 3)
        proposal_reasons = {row["replay_selection_reason"] for row in proposal_selected}
        self.assertIn("runtime_strategy_floor", proposal_reasons)
        self.assertLessEqual(
            proposal_reasons,
            {
                "runtime_strategy_floor",
                "exploitation",
                "exploration",
                "budget_backfill",
            },
        )
        self.assertEqual(len(pre_replay_rows), payload["candidate_spec_count"])
        self.assertEqual(
            {row["selection_reason"] for row in pre_replay_rows},
            {"pre_replay_mlx_rank"},
        )

    def test_best_false_negative_table_excludes_pre_replay_blocked_specs(self) -> None:
        table = proposal_training._best_false_negative_table(
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": "spec-feedback-blocked",
                        "rank": 1,
                        "selected_for_replay": False,
                        "selection_reason": "pre_replay_mlx_feedback_blocked",
                    },
                    {
                        "candidate_spec_id": "spec-capital-blocked",
                        "rank": 2,
                        "selected_for_replay": False,
                        "selection_reason": "pre_replay_capital_budget_blocked",
                    },
                    {
                        "candidate_spec_id": "spec-negative-prior",
                        "rank": 3,
                        "selected_for_replay": False,
                        "selection_reason": "pre_replay_mlx_synthetic_nonpositive_expected_value",
                    },
                    {
                        "candidate_spec_id": "spec-duplicate",
                        "rank": 4,
                        "selected_for_replay": False,
                        "selection_reason": "duplicate_execution_signature",
                    },
                    {
                        "candidate_spec_id": "spec-clean-budget-miss",
                        "rank": 5,
                        "selected_for_replay": False,
                        "selection_reason": "not_selected_budget",
                    },
                ]
            },
            pre_replay_proposal_rows=[
                {
                    "candidate_spec_id": "spec-clean-budget-miss",
                    "proposal_score": 25,
                }
            ],
            evidence_bundles=(),
        )

        self.assertEqual(len(table), 1)
        self.assertEqual(table[0]["candidate_spec_id"], "spec-clean-budget-miss")
        self.assertEqual(table[0]["reason"], "not_replayed_budget")

    def test_seed_recent_whitepapers_diversifies_exploitation_slots(self) -> None:
        with TemporaryDirectory() as tmpdir, _compact_recent_whitepaper_sources(4):
            output_dir = Path(tmpdir) / "epoch"
            args = self._args(output_dir)
            args.top_k = 3
            args.exploration_slots = 0
            args.max_frontier_candidates_per_spec = 2
            args.max_total_frontier_candidates = 6
            payload = runner.run_whitepaper_autoresearch_profit_target(args)

            selection = json.loads(
                (output_dir / "candidate-selection-manifest.json").read_text(
                    encoding="utf-8"
                )
            )

        self.assertEqual(payload["status"], "no_profit_target_candidate")
        replay_rows = sorted(
            [row for row in selection["rows"] if row["selected_for_replay"]],
            key=lambda row: row["replay_order"],
        )
        self.assertEqual(len(replay_rows), 3)
        self.assertGreater(
            sum(
                1
                for row in replay_rows
                if row["selection_reason"] == "runtime_strategy_floor"
            ),
            0,
        )
        self.assertGreater(
            len({row["runtime_strategy_name"] for row in replay_rows}),
            1,
        )
        self.assertEqual(
            selection["selected_candidate_spec_ids"],
            [row["candidate_spec_id"] for row in replay_rows],
        )
        self.assertEqual([row["replay_order"] for row in replay_rows], [1, 2, 3])
        self.assertGreater(
            len({row["family_template_id"] for row in replay_rows[:2]}),
            1,
        )
