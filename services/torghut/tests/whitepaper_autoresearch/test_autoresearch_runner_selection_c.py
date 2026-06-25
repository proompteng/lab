from __future__ import annotations

import app.trading.discovery.evidence_bundles as evidence_bundles
import app.trading.discovery.profit_target_oracle as profit_target_oracle
import scripts.whitepaper_autoresearch_runner.candidate_identity as candidate_identity
import scripts.whitepaper_autoresearch_runner.candidate_prior_scoring as candidate_prior_scoring
import scripts.whitepaper_autoresearch_runner.feedback_blocking_rules as feedback_blocking_rules
import scripts.whitepaper_autoresearch_runner.proposal_building as proposal_building

from tests.whitepaper_autoresearch.autoresearch_runner_base import (
    Any,
    Decimal,
    Path,
    TemporaryDirectory,
    WhitepaperAutoresearchRunnerTestCaseBase,
    cast,
    json,
    patch,
    replace,
    runner,
    sys,
)


class TestAutoresearchRunnerSelectionC(WhitepaperAutoresearchRunnerTestCaseBase):
    def test_candidate_selection_blocks_terminal_risk_profile_feedback(self) -> None:
        failed_spec = self._candidate_spec("spec-risk-terminal-source")
        matching_risk_probe = replace(
            failed_spec,
            candidate_spec_id="spec-risk-terminal-probe",
            hypothesis_id="hyp-spec-risk-terminal-probe",
            hard_vetoes={"required_min_daily_notional": "450000"},
            strategy_overrides={
                **failed_spec.strategy_overrides,
                "params": {
                    **cast(dict[str, Any], failed_spec.strategy_overrides["params"]),
                    "entry_minute_after_open": "90",
                },
            },
        )
        feedback_bundle = evidence_bundles.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=failed_spec.candidate_spec_id,
            candidate=candidate_prior_scoring._candidate_payload_with_feedback_metadata(
                spec=failed_spec,
                candidate={
                    "candidate_id": "cand-terminal-risk-feedback",
                    "objective_scorecard": {
                        "net_pnl_per_day": "-72.11",
                        "active_day_ratio": "0.8",
                        "positive_day_ratio": "0",
                        "negative_day_count": 4,
                        "best_day_share": "1",
                        "daily_net": {
                            "2026-05-04": "-287.72",
                            "2026-05-05": "-22.05",
                            "2026-05-06": "-13.51",
                            "2026-05-07": "-37.30",
                            "2026-05-12": "0",
                        },
                    },
                },
            ),
            dataset_snapshot_id="snap-terminal-risk-feedback",
            result_path="feedback://terminal-risk",
        )

        model, rows = proposal_building._pre_replay_proposal_model_and_rows(
            specs=(matching_risk_probe,),
            feedback_evidence_bundles=(feedback_bundle,),
        )

        self.assertEqual(model["feedback_risk_profile_matched_spec_count"], 1)
        self.assertEqual(rows[0]["training_source"], "feedback_risk_profile_prior")
        self.assertEqual(
            rows[0]["selection_reason"],
            "pre_replay_mlx_risk_profile_feedback_blocked",
        )
        self.assertLessEqual(
            Decimal(str(rows[0]["proposal_score"])), Decimal("-999999")
        )

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(matching_risk_probe,),
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

    def test_terminal_risk_profile_block_covers_capital_paths(self) -> None:
        self.assertFalse(
            feedback_blocking_rules._feedback_risk_profile_has_terminal_block({})
        )

        penalty_scorecard = {
            "profit_target_oracle": {
                "blockers": ["max_single_day_contribution_share_failed"]
            },
            "net_pnl_per_day": "250",
            "active_day_ratio": "1",
            "positive_day_ratio": "1",
            "best_day_share": "0.25",
        }
        self.assertTrue(
            feedback_blocking_rules._feedback_risk_profile_has_terminal_block(
                {
                    **penalty_scorecard,
                    "max_gross_exposure_pct_equity": "1.01",
                }
            )
        )
        self.assertTrue(
            feedback_blocking_rules._feedback_risk_profile_has_terminal_block(
                {
                    **penalty_scorecard,
                    "min_cash": "-0.01",
                }
            )
        )
        self.assertTrue(
            feedback_blocking_rules._feedback_risk_profile_has_terminal_block(
                {
                    **penalty_scorecard,
                    "negative_cash_observation_count": "1",
                }
            )
        )

    def test_feedback_risk_profile_uses_oracle_policy_and_allows_down_days(
        self,
    ) -> None:
        policy = profit_target_oracle.ProfitTargetOraclePolicy(
            min_active_day_ratio=Decimal("0.90"),
            min_positive_day_ratio=Decimal("0.60"),
            max_best_day_share=Decimal("0.25"),
            max_single_symbol_contribution_share=Decimal("0.35"),
            max_cluster_contribution_share=Decimal("0.40"),
            max_gross_exposure_pct_equity=Decimal("1.25"),
            min_cash=Decimal("-10"),
            max_negative_cash_observation_count=1,
        )
        scorecard = {
            "net_pnl_per_day": "250",
            "active_day_ratio": "0.95",
            "positive_day_ratio": "0.65",
            "best_day_share": "0.20",
            "max_single_day_contribution_share": "0.20",
            "max_single_symbol_contribution_share": "0.30",
            "max_cluster_contribution_share": "0.35",
            "max_gross_exposure_pct_equity": "1.10",
            "min_cash": "-5",
            "negative_cash_observation_count": "1",
            "negative_day_count": "1",
            "daily_net": {
                "2026-05-01": "-50",
                "2026-05-02": "300",
            },
        }

        self.assertFalse(
            feedback_blocking_rules._feedback_risk_profile_has_penalty(
                scorecard, oracle_policy=policy
            )
        )
        self.assertFalse(
            feedback_blocking_rules._feedback_is_blocked(
                scorecard, oracle_policy=policy
            )
        )
        self.assertFalse(
            feedback_blocking_rules._feedback_family_prior_has_hard_block(
                scorecard, oracle_policy=policy
            )
        )
        self.assertFalse(
            feedback_blocking_rules._feedback_risk_profile_has_terminal_block(
                {
                    **scorecard,
                    "profit_target_oracle": {
                        "blockers": ["max_single_day_contribution_share_failed"]
                    },
                },
                oracle_policy=policy,
            )
        )

        strict_policy = replace(
            policy,
            max_gross_exposure_pct_equity=Decimal("1.0"),
            min_cash=Decimal("0"),
            max_negative_cash_observation_count=0,
        )
        self.assertTrue(
            feedback_blocking_rules._feedback_is_blocked(
                scorecard, oracle_policy=strict_policy
            )
        )
        self.assertTrue(
            feedback_blocking_rules._feedback_risk_profile_has_penalty(
                {
                    "active_day_ratio": "1",
                    "positive_day_ratio": "1",
                    "best_day_share": "0.20",
                },
                oracle_policy=policy,
            )
        )

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
        feedback_bundle = evidence_bundles.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=failed_spec.candidate_spec_id,
            candidate=candidate_prior_scoring._candidate_payload_with_feedback_metadata(
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

        model, rows = proposal_building._pre_replay_proposal_model_and_rows(
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
        self.assertEqual(
            candidate_prior_scoring._candidate_spec_universe_key(invalid_universe_spec),
            "",
        )
        self.assertTrue(
            feedback_blocking_rules._feedback_scorecard_has_hard_veto(
                {
                    "profit_target_oracle": {
                        "blockers": ["positive_day_ratio_below_oracle"]
                    }
                }
            )
        )
        self.assertTrue(
            feedback_blocking_rules._feedback_scorecard_has_hard_veto(
                {"oracle_passed": False}
            )
        )
        self.assertFalse(
            feedback_blocking_rules._feedback_daily_net_has_loss({"daily_net": "bad"})
        )
        self.assertTrue(
            feedback_blocking_rules._feedback_family_prior_has_hard_block(
                {
                    "profit_target_oracle": {
                        "blockers": ["active_day_ratio_below_oracle"]
                    }
                }
            )
        )
        self.assertTrue(
            feedback_blocking_rules._feedback_family_prior_has_hard_block(
                {"positive_day_ratio": "0.5"}
            )
        )
        self.assertTrue(
            feedback_blocking_rules._feedback_family_prior_has_hard_block(
                {"best_day_share": "0.51"}
            )
        )
        self.assertTrue(
            feedback_blocking_rules._feedback_family_prior_has_hard_block(
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
            self.assertTrue(
                feedback_blocking_rules._feedback_risk_profile_has_penalty(scorecard)
            )
        self.assertEqual(
            feedback_blocking_rules._feedback_risk_profile_key_from_scorecard({}), ""
        )

        spec = self._candidate_spec("spec-empty-risk-key")
        orphan_bundle = evidence_bundles.evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-unmatched-risk-feedback",
            candidate={
                "candidate_id": "cand-unmatched-risk-feedback",
                "objective_scorecard": {"positive_day_ratio": "0.5"},
            },
            dataset_snapshot_id="snap-empty-risk-key",
            result_path="feedback://empty-risk-key",
        )
        model, rows = proposal_building._pre_replay_proposal_model_and_rows(
            specs=(spec,),
            feedback_evidence_bundles=(orphan_bundle,),
        )

        self.assertEqual(model["feedback_risk_profile_matched_spec_count"], 0)
        self.assertEqual(rows[0]["training_source"], "synthetic_prior")

    def test_real_replay_evidence_carries_feedback_shape_metadata(self) -> None:
        spec = self._candidate_spec("spec-real-replay-shape-metadata")
        with TemporaryDirectory() as tmpdir:
            result_path = Path(tmpdir) / "result.json"
            result_path.write_text(
                json.dumps(
                    {
                        "top": [
                            {
                                "candidate_id": "cand-real-replay-shape",
                                "objective_scorecard": {
                                    "net_pnl_per_day": "650",
                                    "active_day_ratio": "1",
                                    "positive_day_ratio": "1",
                                },
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )

            with patch.object(runner, "_current_code_commit", return_value="abc123"):
                replay = runner._real_replay_result_from_factory_payload(
                    {
                        "experiments": [
                            {
                                "candidate_spec_id": spec.candidate_spec_id,
                                "result_path": str(result_path),
                                "dataset_snapshot_id": "snap-real-replay-shape",
                            }
                        ]
                    },
                    specs_by_id={spec.candidate_spec_id: spec},
                )

        self.assertEqual(len(replay.evidence_bundles), 1)
        self.assertEqual(replay.evidence_bundles[0].code_commit, "abc123")
        scorecard = replay.evidence_bundles[0].objective_scorecard
        self.assertEqual(
            scorecard["feedback_shape_key"],
            candidate_prior_scoring._candidate_spec_feedback_shape_key(spec),
        )
        self.assertEqual(
            scorecard["feedback_risk_profile_key"],
            candidate_prior_scoring._candidate_spec_feedback_risk_profile_key(spec),
        )
        self.assertEqual(
            scorecard["execution_signature"],
            candidate_identity._candidate_spec_execution_signature(spec),
        )

    def test_current_code_commit_uses_git_when_env_commit_is_missing(self) -> None:
        rev_parse = runner.subprocess.CompletedProcess(
            args=("git", "rev-parse", "HEAD"),
            returncode=0,
            stdout="abc123\n",
        )
        clean_diff = runner.subprocess.CompletedProcess(
            args=("git", "diff", "--quiet"),
            returncode=0,
            stdout="",
        )
        with (
            patch.object(runner.os, "getenv", return_value=""),
            patch.object(
                runner.subprocess,
                "run",
                side_effect=[rev_parse, clean_diff, clean_diff],
            ) as run,
        ):
            self.assertEqual(runner._current_code_commit(), "abc123")

        self.assertEqual(run.call_count, 3)

    def test_current_code_commit_prefers_env_commit(self) -> None:
        with (
            patch.object(
                runner.os,
                "getenv",
                side_effect=lambda name: (
                    "env123" if name == "TORGHUT_CODE_COMMIT" else ""
                ),
            ),
            patch.object(runner.subprocess, "run") as run,
        ):
            self.assertEqual(runner._current_code_commit(), "env123")

        run.assert_not_called()

    def test_current_code_commit_handles_short_container_script_path(
        self,
    ) -> None:
        bad_rev_parse = runner.subprocess.CompletedProcess(
            args=("git", "rev-parse", "HEAD"),
            returncode=128,
            stdout="",
        )
        with (
            patch.object(runner.os, "getenv", return_value=""),
            patch.object(
                runner,
                "__file__",
                "/app/scripts/run_whitepaper_autoresearch_profit_target.py",
            ),
            patch.object(
                runner.subprocess,
                "run",
                return_value=bad_rev_parse,
            ) as run,
        ):
            self.assertEqual(runner._current_code_commit(), "unknown")

        self.assertEqual(run.call_args.args[0][0:3], ("git", "-C", "/"))

    def test_current_code_commit_marks_dirty_or_unknown_git_state(self) -> None:
        rev_parse = runner.subprocess.CompletedProcess(
            args=("git", "rev-parse", "HEAD"),
            returncode=0,
            stdout="abc123\n",
        )
        dirty_diff = runner.subprocess.CompletedProcess(
            args=("git", "diff", "--quiet"),
            returncode=1,
            stdout="",
        )
        bad_rev_parse = runner.subprocess.CompletedProcess(
            args=("git", "rev-parse", "HEAD"),
            returncode=128,
            stdout="",
        )
        with (
            patch.object(runner.os, "getenv", return_value=""),
            patch.object(
                runner.subprocess,
                "run",
                side_effect=[rev_parse, dirty_diff],
            ),
        ):
            self.assertEqual(runner._current_code_commit(), "abc123-dirty")
        with (
            patch.object(runner.os, "getenv", return_value=""),
            patch.object(runner.subprocess, "run", side_effect=OSError("git missing")),
        ):
            self.assertEqual(runner._current_code_commit(), "unknown")
        with (
            patch.object(runner.os, "getenv", return_value=""),
            patch.object(runner.subprocess, "run", return_value=bad_rev_parse),
        ):
            self.assertEqual(runner._current_code_commit(), "unknown")
        with (
            patch.object(runner.os, "getenv", return_value=""),
            patch.object(
                runner.subprocess,
                "run",
                side_effect=[rev_parse, OSError("diff missing")],
            ),
        ):
            self.assertEqual(runner._current_code_commit(), "abc123-dirty")

    def test_synthetic_replay_evidence_carries_code_commit(self) -> None:
        spec = self._candidate_spec("spec-synthetic-replay-code-commit")
        with TemporaryDirectory() as tmpdir:
            with patch.object(
                runner, "_current_code_commit", return_value="synthetic123"
            ):
                replay = runner._run_synthetic_replay(
                    specs=(spec,),
                    output_dir=Path(tmpdir),
                    max_candidates=1,
                )

        self.assertEqual(len(replay.evidence_bundles), 1)
        self.assertEqual(replay.evidence_bundles[0].code_commit, "synthetic123")

    def test_candidate_selection_blocks_synthetic_nonpositive_expected_value(
        self,
    ) -> None:
        spec = self._candidate_spec("spec-negative-synthetic-prior")

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(spec,),
            proposal_rows=[
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": 0.0,
                    "selection_reason": "pre_replay_mlx_rank",
                    "training_source": "synthetic_prior",
                    "feedback_evidence_context_count": 1,
                }
            ],
            top_k=1,
            exploration_slots=0,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [])
        self.assertEqual(selection["budget"]["eligible_candidate_count"], 0)
        self.assertEqual(
            selection["budget"]["pre_replay_nonpositive_synthetic_candidate_count"], 1
        )
        self.assertEqual(
            selection["rows"][0]["selection_reason"],
            "pre_replay_mlx_synthetic_nonpositive_expected_value",
        )

    def test_candidate_selection_uses_exploration_for_synthetic_nonpositive_prior(
        self,
    ) -> None:
        spec = self._candidate_spec("spec-negative-synthetic-prior-probe")

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(spec,),
            proposal_rows=[
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": -12.5,
                    "selection_reason": "pre_replay_mlx_rank",
                    "training_source": "synthetic_prior",
                    "feedback_evidence_context_count": 1,
                }
            ],
            top_k=1,
            exploration_slots=1,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [spec])
        self.assertEqual(selection["budget"]["eligible_candidate_count"], 0)
        self.assertEqual(
            selection["budget"]["pre_replay_nonpositive_synthetic_candidate_count"], 1
        )
        self.assertEqual(
            selection["budget"]["pre_replay_nonpositive_synthetic_exploration_count"],
            1,
        )
        self.assertEqual(selection["budget"]["pre_replay_blocked_candidate_count"], 0)
        self.assertEqual(
            selection["rows"][0]["selection_reason"],
            "synthetic_prior_exploration",
        )
        self.assertTrue(selection["rows"][0]["selected_for_replay"])

    def test_candidate_selection_blocks_capacity_short_synthetic_probe(
        self,
    ) -> None:
        spec = self._candidate_spec("spec-capacity-short-synthetic-prior-probe")

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(spec,),
            proposal_rows=[
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": -12.5,
                    "selection_reason": "pre_replay_mlx_rank",
                    "training_source": "synthetic_prior",
                    "feedback_evidence_context_count": 1,
                    "features": {
                        "configured_daily_notional_required_ratio": 0.2,
                    },
                }
            ],
            top_k=1,
            exploration_slots=1,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [])
        self.assertEqual(selection["budget"]["eligible_candidate_count"], 0)
        self.assertEqual(
            selection["budget"][
                "pre_replay_synthetic_capacity_insufficient_candidate_count"
            ],
            1,
        )
        self.assertEqual(
            selection["budget"]["pre_replay_nonpositive_synthetic_exploration_count"],
            0,
        )
        self.assertEqual(
            selection["rows"][0]["selection_reason"],
            "pre_replay_synthetic_capacity_insufficient",
        )

    def test_real_replay_evidence_promotes_summary_activity_counts(self) -> None:
        with TemporaryDirectory() as tmp:
            result_path = Path(tmp) / "result.json"
            result_path.write_text(
                json.dumps(
                    {
                        "summary": {
                            "decision_count": 0,
                            "filled_count": 0,
                            "orders_submitted_count": 0,
                            "avg_filled_notional_per_day": "0",
                        },
                        "top": [
                            {
                                "candidate_id": "cand-summary-activity",
                                "objective_scorecard": {
                                    "net_pnl_per_day": "0",
                                    "active_day_ratio": "0",
                                },
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            replay = runner._real_replay_result_from_factory_payload(
                {
                    "experiments": [
                        {
                            "result_path": str(result_path),
                            "candidate_spec_id": "spec-summary-activity",
                            "dataset_snapshot_id": "real-summary-activity",
                        }
                    ]
                }
            )

        self.assertEqual(len(replay.evidence_bundles), 1)
        scorecard = replay.evidence_bundles[0].objective_scorecard
        self.assertEqual(scorecard["decision_count"], 0)
        self.assertEqual(scorecard["filled_count"], 0)
        self.assertEqual(scorecard["orders_submitted_count"], 0)
        self.assertEqual(scorecard["avg_filled_notional_per_day"], "0")

    def test_real_replay_evidence_derives_activity_counts_from_decomposition(
        self,
    ) -> None:
        with TemporaryDirectory() as tmp:
            result_path = Path(tmp) / "result.json"
            result_path.write_text(
                json.dumps(
                    {
                        "top": [
                            {
                                "candidate_id": "cand-decomposition-activity",
                                "objective_scorecard": {
                                    "net_pnl_per_day": "-13.37",
                                    "active_day_ratio": "0",
                                },
                                "decomposition": {
                                    "families": {
                                        "opening_drive_leader_reclaim_v1": {
                                            "evaluations": 2,
                                            "fills": 2,
                                        }
                                    },
                                    "symbols": {
                                        "NVDA": {
                                            "filled_count": 2,
                                            "net_pnl": "-40.13",
                                        }
                                    },
                                },
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            replay = runner._real_replay_result_from_factory_payload(
                {
                    "experiments": [
                        {
                            "result_path": str(result_path),
                            "candidate_spec_id": "spec-decomposition-activity",
                            "dataset_snapshot_id": "real-decomposition-activity",
                        }
                    ]
                }
            )

        self.assertEqual(len(replay.evidence_bundles), 1)
        scorecard = replay.evidence_bundles[0].objective_scorecard
        self.assertEqual(scorecard["decision_count"], 2)
        self.assertEqual(scorecard["filled_count"], 2)
        self.assertEqual(scorecard["filled_order_count"], 2)

    def test_candidate_selection_ignores_malformed_feedback_context_for_synthetic_prior(
        self,
    ) -> None:
        spec = self._candidate_spec("spec-malformed-feedback-context")

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(spec,),
            proposal_rows=[
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": 0.0,
                    "selection_reason": "pre_replay_mlx_rank",
                    "training_source": "synthetic_prior",
                    "feedback_evidence_context_count": "bad-int",
                }
            ],
            top_k=1,
            exploration_slots=0,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [spec])
        self.assertEqual(selection["budget"]["eligible_candidate_count"], 1)
        self.assertEqual(
            selection["budget"]["pre_replay_nonpositive_synthetic_candidate_count"],
            0,
        )

    def test_candidate_selection_handles_scalar_universe_overrides(self) -> None:
        scalar_universe_spec = replace(
            self._candidate_spec("spec-scalar-universe"),
            strategy_overrides={
                "max_notional_per_trade": "7500",
                "max_position_pct_equity": "0.25",
                "params": {"entry_minute_after_open": "45"},
                "universe_symbols": "NVDA",
            },
        )

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(scalar_universe_spec,),
            proposal_rows=[
                {
                    "candidate_spec_id": scalar_universe_spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": 10.0,
                    "training_source": "synthetic_prior",
                }
            ],
            top_k=1,
            exploration_slots=0,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [scalar_universe_spec])
        self.assertEqual(selection["rows"][0]["universe_key"], "")

    def test_parse_args_defaults_strategy_configmap_to_runtime_env_path(self) -> None:
        with TemporaryDirectory() as tmpdir:
            with patch.dict(
                "os.environ",
                {"TRADING_STRATEGY_CONFIG_PATH": "/etc/torghut/strategies.yaml"},
            ):
                with patch.object(
                    sys,
                    "argv",
                    [
                        "run_whitepaper_autoresearch_profit_target.py",
                        "--output-dir",
                        tmpdir,
                    ],
                ):
                    args = runner._parse_args()

        self.assertEqual(args.strategy_configmap, Path("/etc/torghut/strategies.yaml"))
