from __future__ import annotations

import json
from argparse import Namespace
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

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
            self.assertTrue((output_dir / "hypothesis-cards.jsonl").exists())
            self.assertTrue((output_dir / "candidate-specs.jsonl").exists())
            self.assertTrue((output_dir / "mlx-ranker-model.json").exists())
            self.assertTrue((output_dir / "mlx-proposal-scores.jsonl").exists())
            self.assertTrue((output_dir / "candidate-evidence-bundles.jsonl").exists())
            self.assertTrue((output_dir / "portfolio-candidates.jsonl").exists())
            self.assertTrue((output_dir / "runtime-closure" / "summary.json").exists())
            model_payload = json.loads(
                (output_dir / "mlx-ranker-model.json").read_text(encoding="utf-8")
            )
            self.assertEqual(model_payload["schema_version"], "torghut.mlx-ranker.v1")
            self.assertEqual(
                model_payload["row_count"], payload["candidate_spec_count"]
            )

            portfolio = payload["best_portfolio_candidate"]
            self.assertTrue(portfolio["objective_scorecard"]["target_met"])
            self.assertGreaterEqual(
                float(portfolio["objective_scorecard"]["net_pnl_per_day"]), 500.0
            )

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
