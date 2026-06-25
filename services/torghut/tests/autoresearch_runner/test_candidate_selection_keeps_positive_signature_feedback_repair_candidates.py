from __future__ import annotations

import app.trading.discovery.evidence_bundles as evidence_bundles
import scripts.whitepaper_autoresearch_runner.artifact_io as artifact_io
import scripts.whitepaper_autoresearch_runner.candidate_identity as candidate_identity
import scripts.whitepaper_autoresearch_runner.candidate_prior_scoring as candidate_prior_scoring
import scripts.whitepaper_autoresearch_runner.feedback_blocking_rules as feedback_blocking_rules
import scripts.whitepaper_autoresearch_runner.proposal_building as proposal_building

from dataclasses import replace
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, cast
from unittest.mock import patch


from tests.autoresearch_runner.helpers import (
    AutoresearchRunnerTestCase,
)
import scripts.whitepaper_autoresearch_runner.replay_execution as replay_execution
import scripts.whitepaper_autoresearch_runner.replay_selection as replay_selection


class TestCandidateSelectionKeepsPositiveSignatureFeedbackRepairCandidates(
    AutoresearchRunnerTestCase
):
    def test_candidate_selection_keeps_positive_signature_feedback_repair_candidates(
        self,
    ) -> None:
        source_spec = self._candidate_spec("spec-positive-signature-source")
        matching_spec = self._candidate_spec("spec-positive-signature-match")
        feedback_bundle = evidence_bundles.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=source_spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-positive-signature-source",
                "family_template_id": source_spec.family_template_id,
                "runtime_family": source_spec.runtime_family,
                "runtime_strategy_name": source_spec.runtime_strategy_name,
                "execution_signature": candidate_identity._candidate_spec_execution_signature(
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

        _model, rows = proposal_building._pre_replay_proposal_model_and_rows(
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

        selected, selection = replay_selection._select_candidate_specs_for_replay(
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

        selected, selection = replay_selection._select_candidate_specs_for_replay(
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

    def test_current_code_commit_uses_git_when_env_commit_is_missing(self) -> None:
        rev_parse = artifact_io.subprocess.CompletedProcess(
            args=("git", "rev-parse", "HEAD"),
            returncode=0,
            stdout="abc123\n",
        )
        clean_diff = artifact_io.subprocess.CompletedProcess(
            args=("git", "diff", "--quiet"),
            returncode=0,
            stdout="",
        )
        with (
            patch.object(artifact_io.os, "getenv", return_value=""),
            patch.object(
                artifact_io.subprocess,
                "run",
                side_effect=[rev_parse, clean_diff, clean_diff],
            ) as run,
        ):
            self.assertEqual(artifact_io._current_code_commit(), "abc123")

        self.assertEqual(run.call_count, 3)

    def test_current_code_commit_prefers_env_commit(self) -> None:
        with (
            patch.object(
                artifact_io.os,
                "getenv",
                side_effect=lambda name: (
                    "env123" if name == "TORGHUT_CODE_COMMIT" else ""
                ),
            ),
            patch.object(artifact_io.subprocess, "run") as run,
        ):
            self.assertEqual(artifact_io._current_code_commit(), "env123")

        run.assert_not_called()

    def test_current_code_commit_handles_short_container_script_path(
        self,
    ) -> None:
        bad_rev_parse = artifact_io.subprocess.CompletedProcess(
            args=("git", "rev-parse", "HEAD"),
            returncode=128,
            stdout="",
        )
        with (
            patch.object(artifact_io.os, "getenv", return_value=""),
            patch.object(
                artifact_io,
                "__file__",
                "/app/scripts/run_whitepaper_autoresearch_profit_target.py",
            ),
            patch.object(
                artifact_io.subprocess,
                "run",
                return_value=bad_rev_parse,
            ) as run,
        ):
            self.assertEqual(artifact_io._current_code_commit(), "unknown")

        self.assertEqual(run.call_args.args[0][0:3], ("git", "-C", "/"))

    def test_current_code_commit_marks_dirty_or_unknown_git_state(self) -> None:
        rev_parse = artifact_io.subprocess.CompletedProcess(
            args=("git", "rev-parse", "HEAD"),
            returncode=0,
            stdout="abc123\n",
        )
        dirty_diff = artifact_io.subprocess.CompletedProcess(
            args=("git", "diff", "--quiet"),
            returncode=1,
            stdout="",
        )
        bad_rev_parse = artifact_io.subprocess.CompletedProcess(
            args=("git", "rev-parse", "HEAD"),
            returncode=128,
            stdout="",
        )
        with (
            patch.object(artifact_io.os, "getenv", return_value=""),
            patch.object(
                artifact_io.subprocess,
                "run",
                side_effect=[rev_parse, dirty_diff],
            ),
        ):
            self.assertEqual(artifact_io._current_code_commit(), "abc123-dirty")
        with (
            patch.object(artifact_io.os, "getenv", return_value=""),
            patch.object(
                artifact_io.subprocess, "run", side_effect=OSError("git missing")
            ),
        ):
            self.assertEqual(artifact_io._current_code_commit(), "unknown")
        with (
            patch.object(artifact_io.os, "getenv", return_value=""),
            patch.object(artifact_io.subprocess, "run", return_value=bad_rev_parse),
        ):
            self.assertEqual(artifact_io._current_code_commit(), "unknown")
        with (
            patch.object(artifact_io.os, "getenv", return_value=""),
            patch.object(
                artifact_io.subprocess,
                "run",
                side_effect=[rev_parse, OSError("diff missing")],
            ),
        ):
            self.assertEqual(artifact_io._current_code_commit(), "abc123-dirty")

    def test_synthetic_replay_evidence_carries_code_commit(self) -> None:
        spec = self._candidate_spec("spec-synthetic-replay-code-commit")
        with TemporaryDirectory() as tmpdir:
            with patch.object(
                replay_execution, "_current_code_commit", return_value="synthetic123"
            ):
                replay = replay_execution._run_synthetic_replay(
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

        selected, selection = replay_selection._select_candidate_specs_for_replay(
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

        selected, selection = replay_selection._select_candidate_specs_for_replay(
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

        selected, selection = replay_selection._select_candidate_specs_for_replay(
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

    def test_candidate_selection_ignores_malformed_feedback_context_for_synthetic_prior(
        self,
    ) -> None:
        spec = self._candidate_spec("spec-malformed-feedback-context")

        selected, selection = replay_selection._select_candidate_specs_for_replay(
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

        selected, selection = replay_selection._select_candidate_specs_for_replay(
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
