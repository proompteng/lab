from __future__ import annotations

import json
from argparse import Namespace
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

import scripts.compile_whitepaper_claims as claim_compiler_script
import scripts.run_whitepaper_autoresearch_profit_target as runner
import scripts.train_mlx_autoresearch_ranker as ranker_trainer
from app.models import (
    AutoresearchCandidateSpec,
    AutoresearchEpoch,
    AutoresearchPortfolioCandidate,
    AutoresearchProposalScore,
    Base,
)


class TestRunWhitepaperAutoresearchProfitTarget(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine)

    def tearDown(self) -> None:
        self.engine.dispose()

    def _args(self, output_dir: Path) -> Namespace:
        return Namespace(
            output_dir=output_dir,
            paper_run_id=[],
            seed_recent_whitepapers=True,
            target_net_pnl_per_day="500",
            max_candidates=8,
            top_k=4,
            exploration_slots=2,
            portfolio_size_min=2,
            portfolio_size_max=4,
            replay_mode="synthetic",
            program=Path(
                "config/trading/research-programs/strict-daily-profit-autoresearch-v1.yaml"
            ),
            strategy_configmap=Path(
                "argocd/applications/torghut/strategy-configmap.yaml"
            ),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
            clickhouse_http_url="http://example.invalid:8123",
            clickhouse_username="torghut",
            clickhouse_password="secret",
            start_equity="31590.02",
            chunk_minutes=10,
            symbols="AAPL,NVDA,MSFT,AMAT",
            progress_log_seconds=30,
            train_days=6,
            holdout_days=3,
            full_window_start_date="2026-02-23",
            full_window_end_date="2026-02-27",
            expected_last_trading_day="",
            allow_stale_tape=False,
            prefetch_full_window_rows=False,
            persist_results=False,
        )

    def test_seed_recent_whitepapers_runs_end_to_end_and_writes_artifacts(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            payload = runner.run_whitepaper_autoresearch_profit_target(
                self._args(output_dir)
            )

            self.assertEqual(payload["status"], "ok")
            self.assertGreaterEqual(payload["source_count"], 4)
            self.assertGreaterEqual(payload["candidate_spec_count"], 4)
            self.assertIsNotNone(payload["best_portfolio_candidate"])
            self.assertFalse(payload["promotion_readiness"]["promotable"])

            summary = json.loads(
                (output_dir / "summary.json").read_text(encoding="utf-8")
            )
            self.assertEqual(summary["epoch_id"], payload["epoch_id"])
            self.assertEqual(
                summary["false_positive_table"], payload["false_positive_table"]
            )
            self.assertEqual(
                summary["best_false_negative_table"],
                payload["best_false_negative_table"],
            )
            self.assertTrue((output_dir / "hypothesis-cards.jsonl").exists())
            self.assertTrue((output_dir / "candidate-specs.jsonl").exists())
            self.assertTrue((output_dir / "candidate-compiler-report.json").exists())
            self.assertTrue((output_dir / "candidate-selection-manifest.json").exists())
            self.assertTrue((output_dir / "pre-replay-mlx-ranker-model.json").exists())
            self.assertTrue(
                (output_dir / "pre-replay-mlx-proposal-scores.jsonl").exists()
            )
            self.assertTrue((output_dir / "mlx-ranker-model.json").exists())
            self.assertTrue((output_dir / "mlx-proposal-scores.jsonl").exists())
            self.assertTrue((output_dir / "candidate-evidence-bundles.jsonl").exists())
            self.assertTrue((output_dir / "portfolio-candidates.jsonl").exists())
            self.assertTrue((output_dir / "runtime-closure" / "summary.json").exists())
            self.assertTrue(
                (
                    output_dir
                    / "runtime-closure"
                    / "replay"
                    / "candidate-configmap.yaml"
                ).exists()
            )
            runtime_summary = json.loads(
                (output_dir / "runtime-closure" / "summary.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(runtime_summary["status"], "pending_runtime_parity")
            self.assertTrue(runtime_summary["candidate_configmap_path"])
            replay_plan = json.loads(
                (
                    output_dir
                    / "runtime-closure"
                    / "replay"
                    / "runtime-replay-plan.json"
                ).read_text(encoding="utf-8")
            )
            self.assertIsNotNone(replay_plan["execution_context"])
            self.assertFalse(
                replay_plan["runtime_closure_policy"]["execute_parity_replay"]
            )
            self.assertFalse(
                replay_plan["runtime_closure_policy"]["execute_approval_replay"]
            )
            self.assertTrue(
                (output_dir / "whitepaper-autoresearch-diagnostics.ipynb").exists()
            )
            model_payload = json.loads(
                (output_dir / "mlx-ranker-model.json").read_text(encoding="utf-8")
            )
            pre_replay_model_payload = json.loads(
                (output_dir / "pre-replay-mlx-ranker-model.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(pre_replay_model_payload["proposal_stage"], "pre_replay")
            self.assertEqual(
                pre_replay_model_payload["row_count"], payload["candidate_spec_count"]
            )
            self.assertEqual(model_payload["schema_version"], "torghut.mlx-ranker.v1")
            self.assertEqual(
                model_payload["row_count"], payload["candidate_spec_count"]
            )
            self.assertIn("rank_bucket_lift", model_payload)
            selection = json.loads(
                (output_dir / "candidate-selection-manifest.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(
                selection["budget"]["selected_count"],
                payload["replay_candidate_spec_count"],
            )
            self.assertEqual(
                payload["evidence_bundle_count"], payload["replay_candidate_spec_count"]
            )
            self.assertEqual(
                selection["proposal_model"]["proposal_stage"], "pre_replay"
            )

            portfolio = payload["best_portfolio_candidate"]
            self.assertTrue(portfolio["objective_scorecard"]["target_met"])
            self.assertTrue(portfolio["objective_scorecard"]["oracle_passed"])
            self.assertTrue(payload["oracle_candidate_found"])
            self.assertEqual(payload["profit_target_oracle"]["blockers"], [])
            self.assertGreaterEqual(
                float(portfolio["objective_scorecard"]["net_pnl_per_day"]), 500.0
            )
            self.assertTrue(payload["false_positive_table"])
            false_positive_reasons = {
                reason
                for row in payload["false_positive_table"]
                for reason in row["failure_reasons"]
            }
            self.assertIn("active_day_ratio_below_oracle", false_positive_reasons)
            self.assertEqual(payload["best_false_negative_table"], [])

    def test_seed_recent_whitepapers_honors_top_k_and_exploration_budget(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            args = self._args(output_dir)
            args.top_k = 1
            args.exploration_slots = 1
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

        self.assertEqual(payload["status"], "ok")
        self.assertEqual(selection["proposal_score_confidence"]["confidence"], "low")
        self.assertEqual(selection["budget"]["exploration_slots_requested"], 1)
        self.assertEqual(selection["budget"]["exploration_slots_effective"], 2)
        self.assertEqual(selection["budget"]["selected_count"], 3)
        self.assertEqual(payload["replay_candidate_spec_count"], 3)
        self.assertEqual(payload["evidence_bundle_count"], 3)
        self.assertEqual(payload["candidate_spec_count"], 4)
        self.assertEqual(payload["false_positive_table"], [])
        self.assertEqual(len(payload["best_false_negative_table"]), 1)
        self.assertEqual(
            payload["best_false_negative_table"][0]["evidence_status"], "not_replayed"
        )
        self.assertFalse(payload["best_false_negative_table"][0]["selected_for_replay"])
        selected_rows = [row for row in selection["rows"] if row["selected_for_replay"]]
        self.assertEqual(
            {row["selection_reason"] for row in selected_rows},
            {"exploitation", "exploration"},
        )
        proposal_selected = [row for row in proposal_rows if row["selected_for_replay"]]
        self.assertEqual(len(proposal_selected), 3)
        self.assertEqual(
            {row["replay_selection_reason"] for row in proposal_selected},
            {"exploitation", "exploration"},
        )
        self.assertEqual(len(pre_replay_rows), payload["candidate_spec_count"])
        self.assertEqual(
            {row["selection_reason"] for row in pre_replay_rows},
            {"pre_replay_mlx_rank"},
        )

    def test_main_returns_nonzero_when_no_oracle_candidate_found(self) -> None:
        with (
            TemporaryDirectory() as tmpdir,
            patch.object(
                runner,
                "_parse_args",
                return_value=Namespace(
                    **{
                        **vars(self._args(Path(tmpdir) / "epoch")),
                        "target_net_pnl_per_day": "999999",
                    }
                ),
            ),
            patch("builtins.print"),
        ):
            exit_code = runner.main()
            output_dir = Path(tmpdir) / "epoch"
            summary = json.loads(
                (output_dir / "summary.json").read_text(encoding="utf-8")
            )
            portfolio_report_exists = (
                output_dir / "portfolio-optimizer-report.json"
            ).exists()

        self.assertEqual(exit_code, 2)
        self.assertEqual(summary["status"], "no_profit_target_candidate")
        self.assertEqual(
            summary["status_reason"], "portfolio_candidate_failed_profit_target_oracle"
        )
        self.assertFalse(summary["oracle_candidate_found"])
        self.assertIn(
            "portfolio_post_cost_net_pnl_per_day_failed",
            summary["profit_target_oracle"]["blockers"],
        )
        self.assertTrue(portfolio_report_exists)

    def test_seed_recent_whitepapers_persists_epoch_ledgers(self) -> None:
        with (
            TemporaryDirectory() as tmpdir,
            patch(
                "scripts.run_whitepaper_autoresearch_profit_target.SessionLocal",
                side_effect=lambda: Session(self.engine),
            ),
        ):
            args = self._args(Path(tmpdir) / "epoch")
            args.persist_results = True
            payload = runner.run_whitepaper_autoresearch_profit_target(args)

            with Session(self.engine) as session:
                epoch = session.execute(select(AutoresearchEpoch)).scalar_one()
                specs = (
                    session.execute(select(AutoresearchCandidateSpec)).scalars().all()
                )
                proposals = (
                    session.execute(select(AutoresearchProposalScore)).scalars().all()
                )
                portfolios = (
                    session.execute(select(AutoresearchPortfolioCandidate))
                    .scalars()
                    .all()
                )

        self.assertEqual(epoch.epoch_id, payload["epoch_id"])
        self.assertEqual(epoch.status, "ok")
        self.assertEqual(len(specs), payload["candidate_spec_count"])
        self.assertEqual(len(proposals), payload["proposal_score_count"])
        self.assertEqual(len(portfolios), 1)
        self.assertEqual(portfolios[0].status, "target_met")

    def test_train_ranker_script_helper_reads_runner_artifacts(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            runner.run_whitepaper_autoresearch_profit_target(self._args(output_dir))

            model_payload, scores = ranker_trainer.train_from_artifacts(
                candidate_specs_path=output_dir / "candidate-specs.jsonl",
                evidence_bundles_path=output_dir / "candidate-evidence-bundles.jsonl",
                backend_preference="numpy-fallback",
            )

        self.assertEqual(model_payload["schema_version"], "torghut.mlx-ranker.v1")
        self.assertEqual(model_payload["backend"], "numpy-fallback")
        self.assertEqual(len(scores), 4)
        self.assertEqual(scores[0]["rank"], 1)

    def test_replay_failures_write_error_summary_and_exit_code_three(self) -> None:
        with (
            TemporaryDirectory() as tmpdir,
            patch.object(
                runner,
                "_parse_args",
                return_value=Namespace(
                    **{
                        **vars(self._args(Path(tmpdir) / "epoch")),
                        "replay_mode": "real",
                    }
                ),
            ),
            patch.object(
                runner,
                "_run_real_replay",
                side_effect=RuntimeError("forced replay failure"),
            ),
            patch("builtins.print"),
        ):
            exit_code = runner.main()
            summary = json.loads(
                (Path(tmpdir) / "epoch" / "error-summary.json").read_text(
                    encoding="utf-8"
                )
            )

        self.assertEqual(exit_code, 3)
        self.assertEqual(summary["status"], "replay_failed")

    def test_train_ranker_script_main_writes_model_and_scores(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            runner.run_whitepaper_autoresearch_profit_target(self._args(output_dir))
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
        self.assertEqual(len(score_rows), 4)
        self.assertTrue(mock_print.called)

    def test_compile_claims_script_main_writes_recent_seed_cards(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / "claims" / "hypothesis-cards.jsonl"
            with (
                patch(
                    "sys.argv",
                    [
                        "compile_whitepaper_claims.py",
                        "--output",
                        str(output_path),
                        "--seed-recent-whitepapers",
                    ],
                ),
                patch("builtins.print") as mock_print,
            ):
                parsed = claim_compiler_script._parse_args()
                exit_code = claim_compiler_script.main()

            rows = output_path.read_text(encoding="utf-8").splitlines()

        self.assertEqual(parsed.output, output_path)
        self.assertTrue(parsed.seed_recent_whitepapers)
        self.assertEqual(exit_code, 0)
        self.assertGreaterEqual(len(rows), 4)
        self.assertTrue(mock_print.called)

    def test_runner_parse_args_covers_cli_defaults_and_flags(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            with patch(
                "sys.argv",
                [
                    "run_whitepaper_autoresearch_profit_target.py",
                    "--output-dir",
                    str(output_dir),
                    "--seed-recent-whitepapers",
                    "--replay-mode",
                    "synthetic",
                    "--no-persist-results",
                ],
            ):
                parsed = runner._parse_args()

        self.assertEqual(parsed.output_dir, output_dir)
        self.assertTrue(parsed.seed_recent_whitepapers)
        self.assertEqual(parsed.replay_mode, "synthetic")
        self.assertFalse(parsed.persist_results)

    def test_real_replay_builds_evidence_and_skips_incomplete_results(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "real"
            empty_result_path = Path(tmpdir) / "empty.json"
            valid_result_path = Path(tmpdir) / "valid.json"
            empty_result_path.write_text(json.dumps({"top": []}), encoding="utf-8")
            valid_result_path.write_text(
                json.dumps(
                    {
                        "top": [
                            {
                                "candidate_id": "cand-real",
                                "objective_scorecard": {
                                    "net_pnl_per_day": "250",
                                    "active_day_ratio": "1.0",
                                    "positive_day_ratio": "0.8",
                                },
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            factory_payload = {
                "experiments": [
                    {"experiment_id": "missing-path"},
                    {
                        "experiment_id": "empty-top",
                        "result_path": str(empty_result_path),
                    },
                    {
                        "experiment_id": "spec-real",
                        "dataset_snapshot_id": "snap-real",
                        "result_path": str(valid_result_path),
                        "promotion_readiness": {"status": "blocked"},
                    },
                ]
            }

            with patch.object(
                runner.strategy_factory_runner,
                "run_strategy_factory_v2",
                return_value=factory_payload,
            ):
                result = runner._run_real_replay(
                    self._args(output_dir), output_dir=output_dir
                )

        self.assertEqual(len(result.evidence_bundles), 1)
        self.assertEqual(result.evidence_bundles[0].candidate_spec_id, "spec-real")
        self.assertEqual(result.evidence_bundles[0].dataset_snapshot_id, "snap-real")

    def test_main_returns_nonzero_without_sources(self) -> None:
        with (
            TemporaryDirectory() as tmpdir,
            patch.object(
                runner,
                "_parse_args",
                return_value=Namespace(
                    **{
                        **vars(self._args(Path(tmpdir) / "epoch")),
                        "seed_recent_whitepapers": False,
                        "paper_run_id": [],
                    }
                ),
            ),
            patch("builtins.print") as mock_print,
        ):
            exit_code = runner.main()

        self.assertEqual(exit_code, 2)
        self.assertTrue(mock_print.called)
