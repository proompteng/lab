from __future__ import annotations

import json
import sys
from argparse import Namespace
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Sequence, cast
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
    WhitepaperAnalysisRun,
    WhitepaperClaim,
    WhitepaperClaimRelation,
    WhitepaperDocument,
    WhitepaperDocumentVersion,
)

_CHIP_UNIVERSE = list(runner.LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE)


def _source_jsonl_payload() -> dict[str, object]:
    return {
        "run_id": "paper-jsonl-2026",
        "title": "Fresh 2026 Microstructure Paper",
        "source_url": "https://example.test/fresh-2026.pdf",
        "published_at": "2026-04-01",
        "claims": [
            {
                "claim_id": "claim-order-flow-signal",
                "claim_type": "signal_mechanism",
                "claim_text": "Order-flow clustering can predict short-horizon continuation.",
                "data_requirements": ["order_flow_imbalance", "spread_bps"],
                "confidence": "0.8",
            },
            {
                "claim_id": "claim-liquidity-risk",
                "claim_type": "risk_constraint",
                "claim_text": "Sizing should be reduced during spread-widening regimes.",
                "data_requirements": ["spread_bps"],
                "confidence": "0.75",
            },
            {
                "claim_id": "claim-holdout-validation",
                "claim_type": "validation_requirement",
                "claim_text": "Validate the signal on held-out liquidity stress windows.",
                "data_requirements": ["spread_bps"],
                "confidence": "0.7",
            },
        ],
        "claim_relations": [
            {
                "relation_id": "rel-support",
                "relation_type": "supports",
                "source_claim_id": "claim-holdout-validation",
                "target_claim_id": "claim-order-flow-signal",
            }
        ],
    }


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
            source_jsonl=[],
            seed_recent_whitepapers=True,
            target_net_pnl_per_day="300",
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
            symbols=",".join(_CHIP_UNIVERSE),
            progress_log_seconds=30,
            max_frontier_candidates_per_spec=runner._DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC,
            max_total_frontier_candidates=0,
            real_replay_timeout_seconds=0,
            real_replay_shard_size=0,
            real_replay_shard_timeout_seconds=0,
            real_replay_shard_workers=1,
            train_days=6,
            holdout_days=3,
            full_window_start_date="2026-02-23",
            full_window_end_date="2026-02-27",
            expected_last_trading_day="",
            allow_stale_tape=False,
            prefetch_full_window_rows=False,
            persist_results=False,
        )

    def test_parse_args_defaults_to_300_daily_profit_program(self) -> None:
        with TemporaryDirectory() as tmpdir:
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

        self.assertEqual(args.target_net_pnl_per_day, "300")
        self.assertEqual(
            args.program,
            Path(
                "config/trading/research-programs/strict-daily-profit-autoresearch-300-v1.yaml"
            ),
        )
        self.assertEqual(args.symbols.split(","), _CHIP_UNIVERSE)

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

    def test_seed_recent_whitepapers_runs_end_to_end_and_writes_artifacts(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            payload = runner.run_whitepaper_autoresearch_profit_target(
                self._args(output_dir)
            )

            self.assertEqual(payload["status"], "no_profit_target_candidate")
            self.assertEqual(
                payload["status_reason"],
                "portfolio_candidate_failed_profit_target_oracle",
            )
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
            self.assertTrue((output_dir / "whitepaper-sources.jsonl").exists())
            self.assertTrue((output_dir / "candidate-specs.jsonl").exists())
            self.assertTrue((output_dir / "candidate-compiler-report.json").exists())
            self.assertTrue((output_dir / "candidate-selection-manifest.json").exists())
            self.assertTrue((output_dir / "pre-replay-mlx-ranker-model.json").exists())
            self.assertTrue(
                (output_dir / "pre-replay-mlx-proposal-scores.jsonl").exists()
            )
            self.assertTrue((output_dir / "mlx-snapshot-manifest.json").exists())
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
            snapshot_manifest = json.loads(
                (output_dir / "mlx-snapshot-manifest.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                replay_plan["dataset_snapshot_ref"], snapshot_manifest["snapshot_id"]
            )
            self.assertEqual(
                snapshot_manifest["row_counts"]["candidate_specs"],
                payload["candidate_spec_count"],
            )
            self.assertEqual(
                snapshot_manifest["row_counts"]["candidate_evidence_bundles"],
                payload["evidence_bundle_count"],
            )
            self.assertEqual(
                snapshot_manifest["row_counts"]["pre_replay_proposal_scores"],
                payload["pre_replay_proposal_score_count"],
            )
            self.assertEqual(
                snapshot_manifest["tensor_bundle_paths"][
                    "candidate_selection_manifest_json"
                ],
                str((output_dir / "candidate-selection-manifest.json").resolve()),
            )
            self.assertEqual(
                payload["artifacts"]["mlx_snapshot_manifest"],
                str((output_dir / "mlx-snapshot-manifest.json").resolve()),
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
            candidate_specs = [
                json.loads(line)
                for line in (output_dir / "candidate-specs.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
                if line
            ]
            self.assertTrue(candidate_specs)
            candidate_universes = [
                spec["strategy_overrides"]["universe_symbols"]
                for spec in candidate_specs
            ]
            self.assertTrue(
                all(
                    set(symbols) <= set(_CHIP_UNIVERSE)
                    for symbols in candidate_universes
                )
            )
            self.assertTrue(
                any(symbols != _CHIP_UNIVERSE for symbols in candidate_universes)
            )

            portfolio = payload["best_portfolio_candidate"]
            self.assertTrue(portfolio["objective_scorecard"]["target_met"])
            self.assertFalse(portfolio["objective_scorecard"]["oracle_passed"])
            self.assertFalse(payload["oracle_candidate_found"])
            self.assertIn(
                "executable_replay_passed_failed",
                payload["profit_target_oracle"]["blockers"],
            )
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
            self.assertLess(
                selection["budget"]["unique_execution_signature_count"],
                payload["candidate_spec_count"],
            )
            self.assertTrue(
                any(
                    row["selection_reason"] == "duplicate_execution_signature"
                    for row in selection["rows"]
                )
            )

    def test_candidate_universe_symbols_filter_to_live_chip_coverage(self) -> None:
        symbols = runner._candidate_universe_symbols_from_args(
            Namespace(symbols="NVDA,AAPL,MSFT,AMAT,TSM,nvda")
        )

        self.assertEqual(symbols, ("NVDA", "AAPL"))

    def test_program_research_sources_feed_whitepaper_claim_compiler(self) -> None:
        with TemporaryDirectory() as tmpdir:
            args = self._args(Path(tmpdir) / "epoch")
            args.program = Path(
                "config/trading/research-programs/strict-daily-profit-autoresearch-300-v1.yaml"
            )
            program = runner._load_epoch_program(args)
            sources = runner._program_whitepaper_sources(program)

        source_ids = {source.run_id for source in sources}
        self.assertIn("weighted_microprice_momentum_2026", source_ids)
        self.assertIn("macro_announcement_intraday_momentum_2025", source_ids)

        weighted_microprice = next(
            source
            for source in sources
            if source.run_id == "weighted_microprice_momentum_2026"
        )
        claim_types = {str(claim["claim_type"]) for claim in weighted_microprice.claims}
        self.assertIn("feature_recipe", claim_types)
        self.assertIn("validation_requirement", claim_types)
        self.assertTrue(
            runner.compile_sources_to_hypothesis_cards([weighted_microprice])
        )

    def test_runtime_closure_replay_is_disabled_when_candidate_already_failed_oracle(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            args = self._args(Path(tmpdir) / "epoch")
            args.program = Path(
                "config/trading/research-programs/strict-daily-profit-autoresearch-300-v1.yaml"
            )
            program = runner._load_epoch_program(args)

        manifest = runner.MlxSnapshotManifest(
            snapshot_id="mlx-snap-test",
            created_at="2026-05-06T00:00:00+00:00",
            source_window_start="",
            source_window_end="",
            train_days=6,
            holdout_days=3,
            full_window_days=9,
            symbols=tuple(_CHIP_UNIVERSE),
            bar_interval="PT1S",
            quote_quality_policy_id="scheduler_v3_default",
            feature_set_id="torghut.mlx-autoresearch.v1",
            cross_sectional_feature_flags={},
            prior_day_feature_flags={},
            tape_freshness_receipts=(),
            row_counts={},
            tensor_bundle_paths={},
            manifest_hash="hash",
        )
        portfolio = runner.PortfolioCandidateSpec(
            schema_version="torghut.portfolio-candidate-spec.v1",
            portfolio_candidate_id="portfolio-test",
            source_candidate_ids=("candidate-test",),
            target_net_pnl_per_day=Decimal("300"),
            sleeves=(),
            capital_budget={},
            correlation_budget={},
            drawdown_budget={},
            evidence_refs=(),
            objective_scorecard={"oracle_passed": False},
            optimizer_report={},
        )

        runtime_program = runner._runtime_closure_program_for_candidate(
            program=program,
            manifest=manifest,
            portfolio=portfolio,
            oracle_candidate_found=False,
        )

        self.assertFalse(runtime_program.runtime_closure_policy.execute_parity_replay)
        self.assertFalse(runtime_program.runtime_closure_policy.execute_approval_replay)

    def test_candidate_universe_symbols_default_to_chip_coverage_when_empty(
        self,
    ) -> None:
        symbols = runner._candidate_universe_symbols_from_args(
            Namespace(symbols="MSFT,SHOP")
        )

        self.assertEqual(symbols, tuple(_CHIP_UNIVERSE))

    def test_full_chip_universe_is_compile_allowlist_not_profile_override(
        self,
    ) -> None:
        self.assertEqual(
            runner._candidate_universe_symbols_for_compilation(
                Namespace(symbols=",".join(_CHIP_UNIVERSE))
            ),
            (),
        )
        self.assertEqual(
            runner._candidate_universe_symbols_for_compilation(
                Namespace(symbols="MSFT,SHOP")
            ),
            (),
        )
        self.assertEqual(
            runner._candidate_universe_symbols_for_compilation(
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

        self.assertEqual(payload["status"], "no_profit_target_candidate")
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
        self.assertEqual(
            {row["selection_reason"] for row in selected_rows},
            {"exploitation", "exploration", "budget_backfill"},
        )
        proposal_selected = [row for row in proposal_rows if row["selected_for_replay"]]
        self.assertEqual(len(proposal_selected), 3)
        self.assertEqual(
            {row["replay_selection_reason"] for row in proposal_selected},
            {"exploitation", "exploration", "budget_backfill"},
        )
        self.assertEqual(len(pre_replay_rows), payload["candidate_spec_count"])
        self.assertEqual(
            {row["selection_reason"] for row in pre_replay_rows},
            {"pre_replay_mlx_rank"},
        )

    def test_seed_recent_whitepapers_diversifies_exploitation_slots(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            args = self._args(output_dir)
            args.top_k = 3
            args.exploration_slots = 0
            payload = runner.run_whitepaper_autoresearch_profit_target(args)

            selection = json.loads(
                (output_dir / "candidate-selection-manifest.json").read_text(
                    encoding="utf-8"
                )
            )

        self.assertEqual(payload["status"], "no_profit_target_candidate")
        exploitation_rows = [
            row
            for row in selection["rows"]
            if row["selected_for_replay"] and row["selection_reason"] == "exploitation"
        ]
        replay_rows = sorted(
            [row for row in selection["rows"] if row["selected_for_replay"]],
            key=lambda row: row["replay_order"],
        )
        self.assertEqual(len(exploitation_rows), 3)
        self.assertGreater(
            len({row["family_template_id"] for row in exploitation_rows}),
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

    def test_seed_recent_whitepapers_dedupes_execution_signatures(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            args = self._args(output_dir)
            args.top_k = 6
            args.exploration_slots = 4
            payload = runner.run_whitepaper_autoresearch_profit_target(args)

            selection = json.loads(
                (output_dir / "candidate-selection-manifest.json").read_text(
                    encoding="utf-8"
                )
            )

        self.assertEqual(payload["status"], "no_profit_target_candidate")
        selected_rows = [row for row in selection["rows"] if row["selected_for_replay"]]
        duplicate_rows = [
            row
            for row in selection["rows"]
            if row["selection_reason"] == "duplicate_execution_signature"
        ]
        self.assertEqual(
            len({row["execution_signature"] for row in selected_rows}),
            len(selected_rows),
        )
        self.assertGreater(len(duplicate_rows), 0)
        self.assertEqual(
            selection["budget"]["unique_execution_signature_count"],
            len(selected_rows),
        )
        self.assertEqual(payload["replay_candidate_spec_count"], len(selected_rows))

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
            remediation = json.loads(
                (output_dir / "candidate-search-remediation.json").read_text(
                    encoding="utf-8"
                )
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
        self.assertEqual(
            remediation["schema_version"],
            "torghut.whitepaper-autoresearch-remediation.v1",
        )
        self.assertTrue(remediation["next_actions"])
        self.assertIn("candidate_search_remediation", summary["artifacts"])
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
        self.assertEqual(epoch.status, "no_profit_target_candidate")
        self.assertEqual(len(specs), payload["candidate_spec_count"])
        self.assertEqual(len(proposals), payload["proposal_score_count"])
        self.assertEqual(len(portfolios), 1)
        self.assertEqual(portfolios[0].status, "blocked")

    def test_epoch_ledgers_allow_repeated_candidate_specs_across_epochs(
        self,
    ) -> None:
        candidate_spec = runner.CandidateSpec(
            schema_version="torghut.candidate-spec.v1",
            candidate_spec_id="spec-repeatable",
            hypothesis_id="hyp-repeatable",
            family_template_id="microbar_cross_sectional_pairs_v1",
            candidate_kind="sleeve",
            runtime_family="microbar_cross_sectional_pairs_v1",
            runtime_strategy_name="microbar_cross_sectional_pairs",
            feature_contract={"mechanism": "repeatable deterministic spec"},
            parameter_space={},
            strategy_overrides={},
            objective={"target_net_pnl_per_day": "300"},
            hard_vetoes={},
            expected_failure_modes=(),
            promotion_contract={},
        )
        started_at = datetime(2026, 5, 8, 17, 0, 0)
        completed_at = datetime(2026, 5, 8, 17, 1, 0)

        with patch(
            "scripts.run_whitepaper_autoresearch_profit_target.SessionLocal",
            side_effect=lambda: Session(self.engine),
        ):
            for epoch_id in ("epoch-repeat-1", "epoch-repeat-2"):
                runner._persist_epoch_ledgers(
                    epoch_id=epoch_id,
                    status="no_profit_target_candidate",
                    target_net_pnl_per_day=Decimal("300"),
                    paper_run_ids=[],
                    sources=[],
                    candidate_specs=[candidate_spec],
                    proposal_rows=[],
                    portfolio=None,
                    summary={},
                    runner_config={},
                    started_at=started_at,
                    completed_at=completed_at,
                )

        with Session(self.engine) as session:
            specs = (
                session.execute(
                    select(AutoresearchCandidateSpec).order_by(
                        AutoresearchCandidateSpec.epoch_id.asc()
                    )
                )
                .scalars()
                .all()
            )

        self.assertEqual(
            [spec.epoch_id for spec in specs],
            ["epoch-repeat-1", "epoch-repeat-2"],
        )
        self.assertEqual(
            {spec.candidate_spec_id for spec in specs}, {"spec-repeatable"}
        )

    def test_persistence_failure_preserves_artifacts_and_returns_infra_failure(
        self,
    ) -> None:
        with (
            TemporaryDirectory() as tmpdir,
            patch(
                "scripts.run_whitepaper_autoresearch_profit_target.SessionLocal",
                side_effect=RuntimeError("db offline"),
            ),
        ):
            output_dir = Path(tmpdir) / "epoch"
            args = self._args(output_dir)
            args.persist_results = True
            payload = runner.run_whitepaper_autoresearch_profit_target(args)
            summary = json.loads(
                (output_dir / "summary.json").read_text(encoding="utf-8")
            )
            persistence_error = json.loads(
                (output_dir / "persistence-error-summary.json").read_text(
                    encoding="utf-8"
                )
            )
            evidence_artifact_exists = (
                output_dir / "candidate-evidence-bundles.jsonl"
            ).exists()
            portfolio_artifact_exists = (
                output_dir / "portfolio-candidates.jsonl"
            ).exists()
            notebook_exists = (
                output_dir / "whitepaper-autoresearch-diagnostics.ipynb"
            ).exists()

        self.assertEqual(payload["status"], "persistence_failed")
        self.assertEqual(
            payload["pre_persistence_status"], "no_profit_target_candidate"
        )
        self.assertEqual(payload["persistence_status"], "failed")
        self.assertIn("db offline", payload["persistence_error"])
        self.assertEqual(summary["status"], "persistence_failed")
        self.assertEqual(persistence_error["epoch_id"], payload["epoch_id"])
        self.assertTrue(evidence_artifact_exists)
        self.assertTrue(portfolio_artifact_exists)
        self.assertTrue(notebook_exists)

    def test_main_returns_infra_failure_when_persistence_fails(self) -> None:
        with (
            patch.object(runner, "_parse_args", return_value=Namespace()),
            patch.object(
                runner,
                "run_whitepaper_autoresearch_profit_target",
                return_value={"status": "persistence_failed"},
            ),
            patch("builtins.print"),
        ):
            exit_code = runner.main()

        self.assertEqual(exit_code, 1)

    def test_train_ranker_script_helper_reads_runner_artifacts(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            payload = runner.run_whitepaper_autoresearch_profit_target(
                self._args(output_dir)
            )

            model_payload, scores = ranker_trainer.train_from_artifacts(
                candidate_specs_path=output_dir / "candidate-specs.jsonl",
                evidence_bundles_path=output_dir / "candidate-evidence-bundles.jsonl",
                backend_preference="numpy-fallback",
            )

        self.assertEqual(model_payload["schema_version"], "torghut.mlx-ranker.v1")
        self.assertEqual(model_payload["backend"], "numpy-fallback")
        self.assertIn("rank_bucket_lift", model_payload)
        self.assertIn(model_payload["model_status"], {"active", "demoted_to_heuristic"})
        self.assertEqual(len(scores), payload["candidate_spec_count"])
        self.assertEqual(scores[0]["rank"], 1)
        self.assertIn(
            scores[0]["selection_reason"],
            {"exploitation", "heuristic_negative_lift_fallback"},
        )

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
            patch.object(
                runner,
                "_collect_partial_real_replay",
                return_value=runner.EpochReplayResult(
                    evidence_bundles=(
                        runner.evidence_bundle_from_frontier_candidate(
                            candidate_spec_id="spec-partial",
                            candidate={
                                "candidate_id": "cand-partial",
                                "objective_scorecard": {
                                    "net_pnl_per_day": "-1",
                                    "active_day_ratio": "0.4",
                                    "positive_day_ratio": "0.2",
                                },
                            },
                            dataset_snapshot_id="snap-partial",
                            result_path="/tmp/partial-result.json",
                        ),
                    ),
                    replay_results=({"status": "partial_replay_artifacts_collected"},),
                ),
            ),
            patch("builtins.print"),
        ):
            exit_code = runner.main()
            partial_artifact_exists = (
                Path(tmpdir) / "epoch" / "candidate-evidence-bundles.partial.jsonl"
            ).exists()
            remediation_path = (
                Path(tmpdir) / "epoch" / "candidate-search-remediation.json"
            )
            remediation_exists = remediation_path.exists()
            remediation = json.loads(remediation_path.read_text(encoding="utf-8"))
            notebook_exists = (
                Path(tmpdir) / "epoch" / "whitepaper-autoresearch-diagnostics.ipynb"
            ).exists()
            summary = json.loads(
                (Path(tmpdir) / "epoch" / "error-summary.json").read_text(
                    encoding="utf-8"
                )
            )

        self.assertEqual(exit_code, 3)
        self.assertEqual(summary["status"], "replay_failed")
        self.assertEqual(summary["partial_evidence_bundle_count"], 1)
        self.assertTrue(partial_artifact_exists)
        self.assertTrue(remediation_exists)
        self.assertTrue(notebook_exists)
        self.assertGreater(remediation["selected_missing_evidence_count"], 0)
        self.assertTrue(
            any(
                row.get("evidence_status") == "missing"
                for row in summary["false_positive_table"]
            )
        )
        self.assertEqual(
            remediation["schema_version"],
            "torghut.whitepaper-autoresearch-remediation.v1",
        )
        self.assertTrue(remediation["next_actions"])
        self.assertIn("candidate_search_remediation", summary)

    def test_timeout_remediation_recommends_smaller_replay_frontier(self) -> None:
        remediation = runner._candidate_search_remediation(
            failure_reason="TimeoutError:real_replay_timeout_seconds:3600",
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": "spec-selected",
                        "selected_for_replay": True,
                    }
                ]
            },
            evidence_bundles=(),
            false_positive_table=(),
            best_false_negative_table=(),
            replay_timeout_seconds=3600,
            max_frontier_candidates_per_spec=8,
        )

        timeout_action = remediation["next_actions"][0]
        self.assertEqual(
            timeout_action["action"], "shrink_per_spec_frontier_or_extend_timeout"
        )
        self.assertEqual(
            timeout_action["recommended_flags"]["--max-frontier-candidates-per-spec"],
            "2",
        )
        self.assertEqual(
            timeout_action["recommended_flags"]["--real-replay-timeout-seconds"],
            "7200",
        )

    def test_remediation_prioritizes_missing_promotion_proof(self) -> None:
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
                        "shadow_parity_status_not_within_budget",
                        "executable_replay_not_passed",
                        "executable_replay_artifact_missing",
                        "executable_replay_account_buying_power_missing",
                        "executable_replay_max_notional_missing",
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
            "complete_executable_replay_and_shadow_parity_evidence",
        )
        self.assertEqual(
            proof_action["blocking_failure_counts"]["executable_replay_not_passed"],
            1,
        )
        self.assertIn(
            "executable_replay_artifact_ref",
            proof_action["required_scorecard_fields"],
        )

    def test_train_ranker_script_main_writes_model_and_scores(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            payload = runner.run_whitepaper_autoresearch_profit_target(
                self._args(output_dir)
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

    def test_compile_claims_script_reads_source_jsonl(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            source_path = root / "sources.jsonl"
            source_path.write_text(
                json.dumps(_source_jsonl_payload(), sort_keys=True) + "\n",
                encoding="utf-8",
            )
            output_path = root / "hypothesis-cards.jsonl"
            with (
                patch(
                    "sys.argv",
                    [
                        "compile_whitepaper_claims.py",
                        "--source-jsonl",
                        str(source_path),
                        "--output",
                        str(output_path),
                    ],
                ),
                patch("builtins.print") as mock_print,
            ):
                parsed = claim_compiler_script._parse_args()
                exit_code = claim_compiler_script.main()

            rows = output_path.read_text(encoding="utf-8").splitlines()

        self.assertEqual(parsed.source_jsonl, [source_path])
        self.assertEqual(exit_code, 0)
        self.assertEqual(len(rows), 1)
        self.assertTrue(mock_print.called)

    def test_compile_claims_script_loads_completed_persisted_run_claims(
        self,
    ) -> None:
        with Session(self.engine) as session:
            document = WhitepaperDocument(
                source="arxiv",
                source_identifier="2501.00001",
                title="Persisted Claims Paper",
                metadata_json={"source_url": "https://example.test/paper.pdf"},
            )
            version = WhitepaperDocumentVersion(
                document=document,
                version_number=1,
                checksum_sha256="a" * 64,
                ceph_bucket="whitepapers",
                ceph_object_key="paper.pdf",
            )
            run = WhitepaperAnalysisRun(
                run_id="paper-run-db",
                document=document,
                document_version=version,
                status="completed",
            )
            session.add_all(
                [
                    document,
                    version,
                    run,
                    WhitepaperClaim(
                        analysis_run=run,
                        claim_id="claim-flow",
                        claim_type="signal_mechanism",
                        claim_text="Order-flow bursts can predict short-horizon continuation.",
                        data_requirements_json=["order_flow_imbalance"],
                        confidence="0.82",
                    ),
                    WhitepaperClaim(
                        analysis_run=run,
                        claim_id="claim-validation",
                        claim_type="validation_requirement",
                        claim_text="The signal must pass held-out liquidity stress windows.",
                        data_requirements_json=["spread_bps"],
                        confidence="0.76",
                    ),
                    WhitepaperClaimRelation(
                        analysis_run=run,
                        relation_id="rel-supports",
                        relation_type="supports",
                        source_claim_id="claim-validation",
                        target_claim_id="claim-flow",
                    ),
                ]
            )
            session.commit()

        with (
            TemporaryDirectory() as tmpdir,
            patch(
                "scripts.compile_whitepaper_claims.SessionLocal",
                side_effect=lambda: Session(self.engine),
            ),
            patch(
                "sys.argv",
                [
                    "compile_whitepaper_claims.py",
                    "--paper-run-id",
                    "paper-run-db",
                    "--output",
                    str(Path(tmpdir) / "hypothesis-cards.jsonl"),
                    "--sources-output",
                    str(Path(tmpdir) / "sources.jsonl"),
                ],
            ),
            patch("builtins.print") as mock_print,
        ):
            exit_code = claim_compiler_script.main()
            card_rows = (
                (Path(tmpdir) / "hypothesis-cards.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
            )
            source_rows = (
                (Path(tmpdir) / "sources.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
            )

        self.assertEqual(exit_code, 0)
        self.assertEqual(len(card_rows), 1)
        self.assertEqual(len(source_rows), 1)
        source_payload = json.loads(source_rows[0])
        self.assertEqual(source_payload["run_id"], "paper-run-db")
        self.assertEqual(len(source_payload["claims"]), 2)
        self.assertEqual(len(source_payload["claim_relations"]), 1)
        self.assertTrue(mock_print.called)

    def test_runner_db_source_loader_ignores_incomplete_whitepaper_runs(
        self,
    ) -> None:
        with Session(self.engine) as session:
            completed_document = WhitepaperDocument(
                source="arxiv",
                source_identifier="2501.00002",
                title="Completed Claims Paper",
                metadata_json={"source_url": "https://example.test/completed.pdf"},
            )
            completed_version = WhitepaperDocumentVersion(
                document=completed_document,
                version_number=1,
                checksum_sha256="b" * 64,
                ceph_bucket="whitepapers",
                ceph_object_key="completed.pdf",
            )
            completed_run = WhitepaperAnalysisRun(
                run_id="paper-completed",
                document=completed_document,
                document_version=completed_version,
                status="completed",
            )
            running_document = WhitepaperDocument(
                source="arxiv",
                source_identifier="2501.00003",
                title="Running Claims Paper",
                metadata_json={"source_url": "https://example.test/running.pdf"},
            )
            running_version = WhitepaperDocumentVersion(
                document=running_document,
                version_number=1,
                checksum_sha256="c" * 64,
                ceph_bucket="whitepapers",
                ceph_object_key="running.pdf",
            )
            running_run = WhitepaperAnalysisRun(
                run_id="paper-running",
                document=running_document,
                document_version=running_version,
                status="running",
            )
            session.add_all(
                [
                    completed_document,
                    completed_version,
                    completed_run,
                    WhitepaperClaim(
                        analysis_run=completed_run,
                        claim_id="claim-completed",
                        claim_type="signal_mechanism",
                        claim_text="Completed paper claim.",
                        data_requirements_json=["order_flow_imbalance"],
                    ),
                    running_document,
                    running_version,
                    running_run,
                    WhitepaperClaim(
                        analysis_run=running_run,
                        claim_id="claim-running",
                        claim_type="signal_mechanism",
                        claim_text="Running paper claim.",
                        data_requirements_json=["order_flow_imbalance"],
                    ),
                ]
            )
            session.commit()

        with patch(
            "scripts.run_whitepaper_autoresearch_profit_target.SessionLocal",
            side_effect=lambda: Session(self.engine),
        ):
            sources = runner._load_sources_from_db(["paper-completed", "paper-running"])

        self.assertEqual([source.run_id for source in sources], ["paper-completed"])

    def test_runner_parse_args_covers_cli_defaults_and_flags(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            source_path = Path(tmpdir) / "sources.jsonl"
            with patch(
                "sys.argv",
                [
                    "run_whitepaper_autoresearch_profit_target.py",
                    "--output-dir",
                    str(output_dir),
                    "--seed-recent-whitepapers",
                    "--replay-mode",
                    "synthetic",
                    "--source-jsonl",
                    str(source_path),
                    "--clickhouse-password-env",
                    "TORGHUT_CLICKHOUSE_PASSWORD",
                    "--max-total-frontier-candidates",
                    "7",
                    "--no-persist-results",
                ],
            ):
                parsed = runner._parse_args()

        self.assertEqual(parsed.output_dir, output_dir)
        self.assertTrue(parsed.seed_recent_whitepapers)
        self.assertEqual(parsed.replay_mode, "synthetic")
        self.assertEqual(parsed.source_jsonl, [source_path])
        self.assertEqual(parsed.clickhouse_password_env, "TORGHUT_CLICKHOUSE_PASSWORD")
        self.assertEqual(parsed.symbols, ",".join(_CHIP_UNIVERSE))
        self.assertEqual(
            parsed.max_frontier_candidates_per_spec,
            runner._DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC,
        )
        self.assertEqual(parsed.max_total_frontier_candidates, 7)
        self.assertEqual(parsed.real_replay_shard_size, 0)
        self.assertEqual(parsed.real_replay_shard_timeout_seconds, 0)
        self.assertEqual(parsed.real_replay_shard_workers, 1)
        self.assertFalse(parsed.persist_results)

    def test_clickhouse_password_env_resolution_keeps_secret_out_of_argv(
        self,
    ) -> None:
        with patch.dict("os.environ", {"TORGHUT_TEST_CLICKHOUSE_PASSWORD": "from-env"}):
            resolved = runner._resolved_clickhouse_password(
                Namespace(
                    clickhouse_password="",
                    clickhouse_password_env="TORGHUT_TEST_CLICKHOUSE_PASSWORD",
                )
            )
            direct = runner._resolved_clickhouse_password(
                Namespace(
                    clickhouse_password="direct",
                    clickhouse_password_env="TORGHUT_TEST_CLICKHOUSE_PASSWORD",
                )
            )

        self.assertEqual(resolved, "from-env")
        self.assertEqual(direct, "direct")

    def test_runner_reads_source_jsonl_end_to_end(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            source_path = root / "sources.jsonl"
            source_path.write_text(
                json.dumps(_source_jsonl_payload(), sort_keys=True) + "\n",
                encoding="utf-8",
            )
            output_dir = root / "epoch"
            args = self._args(output_dir)
            args.seed_recent_whitepapers = False
            args.source_jsonl = [source_path]
            args.persist_results = False
            payload = runner.run_whitepaper_autoresearch_profit_target(args)

            manifest = json.loads(
                (output_dir / "epoch-manifest.json").read_text(encoding="utf-8")
            )
            sources = [
                json.loads(line)
                for line in (output_dir / "whitepaper-sources.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
            ]

        self.assertEqual(payload["status"], "no_profit_target_candidate")
        self.assertEqual(payload["source_count"], 1)
        self.assertEqual(manifest["paper_sources"][0]["run_id"], "paper-jsonl-2026")
        self.assertEqual(sources[0]["run_id"], "paper-jsonl-2026")

    def test_candidate_budget_does_not_truncate_compiled_hypothesis_universe(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            source_path = root / "sources.jsonl"
            rows: list[dict[str, object]] = []
            for index in range(6):
                payload = dict(_source_jsonl_payload())
                payload["run_id"] = f"paper-jsonl-coverage-{index}"
                payload["title"] = f"Coverage Paper {index}"
                payload["source_url"] = f"https://example.test/coverage-{index}.pdf"
                claims = [
                    dict(item)
                    for item in cast(list[dict[str, object]], payload["claims"])
                ]
                claims[0]["claim_text"] = (
                    f"Order-flow momentum continuation signal {index} with late-day reversal validation."
                )
                payload["claims"] = claims
                rows.append(payload)
            source_path.write_text(
                "\n".join(json.dumps(row, sort_keys=True) for row in rows) + "\n",
                encoding="utf-8",
            )
            output_dir = root / "epoch"
            args = self._args(output_dir)
            args.seed_recent_whitepapers = False
            args.source_jsonl = [source_path]
            args.max_candidates = 2
            args.top_k = 1
            args.exploration_slots = 1
            args.persist_results = False

            payload = runner.run_whitepaper_autoresearch_profit_target(args)
            selection = json.loads(
                (output_dir / "candidate-selection-manifest.json").read_text(
                    encoding="utf-8"
                )
            )

        self.assertGreater(payload["candidate_spec_count"], args.max_candidates)
        self.assertEqual(
            selection["budget"]["compiled_candidate_count"],
            payload["candidate_spec_count"],
        )
        self.assertEqual(
            selection["budget"]["selected_count"],
            payload["replay_candidate_spec_count"],
        )
        self.assertLessEqual(
            payload["replay_candidate_spec_count"], args.max_candidates
        )

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
                            },
                            {
                                "candidate_id": "cand-real-diversifier",
                                "objective_scorecard": {
                                    "net_pnl_per_day": "175",
                                    "active_day_ratio": "1.0",
                                    "positive_day_ratio": "0.8",
                                },
                            },
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

        self.assertEqual(len(result.evidence_bundles), 2)
        self.assertEqual(result.evidence_bundles[0].candidate_spec_id, "spec-real")
        self.assertEqual(result.evidence_bundles[1].candidate_spec_id, "spec-real")
        self.assertEqual(
            result.evidence_bundles[1].candidate_id, "cand-real-diversifier"
        )
        self.assertEqual(result.evidence_bundles[0].dataset_snapshot_id, "snap-real")

    def test_real_replay_uses_spec_universe_instead_of_global_symbols(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            result_path = output_dir / "result.json"
            result_path.parent.mkdir(parents=True)
            result_path.write_text(
                json.dumps(
                    {
                        "top": [
                            {
                                "candidate_id": "cand-real",
                                "objective_scorecard": {
                                    "net_pnl_per_day": "1",
                                    "active_day_ratio": "1",
                                    "positive_day_ratio": "1",
                                },
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            factory_payload = {
                "experiments": [
                    {
                        "experiment_id": "spec-real-exp",
                        "dataset_snapshot_id": "snap-real",
                        "result_path": str(result_path),
                    }
                ]
            }
            captured_symbols: list[str] = []

            def fake_run(
                factory_args: Namespace, *, source_specs: object
            ) -> dict[str, object]:
                captured_symbols.append(str(factory_args.symbols))
                return factory_payload

            with patch.object(
                runner.strategy_factory_runner,
                "run_strategy_factory_v2_from_specs",
                side_effect=fake_run,
            ):
                cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                    [runner.RECENT_WHITEPAPER_SEEDS[0]]
                )
                compilation = runner.compile_whitepaper_candidate_specs(
                    hypothesis_cards=cards,
                    family_template_dir=Path("config/trading/families"),
                    seed_sweep_dir=Path("config/trading"),
                )
                result = runner._run_real_replay(
                    self._args(output_dir),
                    output_dir=output_dir,
                    specs=compilation.executable_specs[:1],
                )

        self.assertEqual(captured_symbols, [""])
        self.assertEqual(len(result.evidence_bundles), 1)

    def test_real_replay_passes_global_frontier_candidate_budget(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            result_path = output_dir / "result.json"
            result_path.parent.mkdir(parents=True)
            result_path.write_text(
                json.dumps(
                    {
                        "top": [
                            {
                                "candidate_id": "cand-real",
                                "objective_scorecard": {
                                    "net_pnl_per_day": "1",
                                    "active_day_ratio": "1",
                                    "positive_day_ratio": "1",
                                },
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            factory_payload = {
                "experiments": [
                    {
                        "experiment_id": "spec-real-exp",
                        "dataset_snapshot_id": "snap-real",
                        "result_path": str(result_path),
                    }
                ]
            }
            captured_budget: list[int] = []

            def fake_run(
                factory_args: Namespace, *, source_specs: object
            ) -> dict[str, object]:
                captured_budget.append(
                    int(factory_args.max_total_candidates_to_evaluate)
                )
                return factory_payload

            with patch.object(
                runner.strategy_factory_runner,
                "run_strategy_factory_v2_from_specs",
                side_effect=fake_run,
            ):
                cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                    [runner.RECENT_WHITEPAPER_SEEDS[0]]
                )
                compilation = runner.compile_whitepaper_candidate_specs(
                    hypothesis_cards=cards,
                    family_template_dir=Path("config/trading/families"),
                    seed_sweep_dir=Path("config/trading"),
                )
                args = self._args(output_dir)
                args.max_candidates = 24
                args.max_total_frontier_candidates = 11
                result = runner._run_real_replay(
                    args,
                    output_dir=output_dir,
                    specs=compilation.executable_specs[:1],
                )

        self.assertEqual(captured_budget, [11])
        self.assertEqual(len(result.evidence_bundles), 1)

    def test_real_replay_defaults_global_frontier_budget_to_candidate_budget(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            result_path = output_dir / "result.json"
            result_path.parent.mkdir(parents=True)
            result_path.write_text(
                json.dumps({"top": []}),
                encoding="utf-8",
            )
            factory_payload = {
                "experiments": [
                    {
                        "experiment_id": "spec-real-exp",
                        "dataset_snapshot_id": "snap-real",
                        "result_path": str(result_path),
                    }
                ]
            }
            captured_budget: list[int] = []

            def fake_run(
                factory_args: Namespace, *, source_specs: object
            ) -> dict[str, object]:
                captured_budget.append(
                    int(factory_args.max_total_candidates_to_evaluate)
                )
                return factory_payload

            with patch.object(
                runner.strategy_factory_runner,
                "run_strategy_factory_v2_from_specs",
                side_effect=fake_run,
            ):
                cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                    [runner.RECENT_WHITEPAPER_SEEDS[0]]
                )
                compilation = runner.compile_whitepaper_candidate_specs(
                    hypothesis_cards=cards,
                    family_template_dir=Path("config/trading/families"),
                    seed_sweep_dir=Path("config/trading"),
                )
                args = self._args(output_dir)
                args.max_candidates = 24
                args.max_frontier_candidates_per_spec = 8
                args.max_total_frontier_candidates = 0
                result = runner._run_real_replay(
                    args,
                    output_dir=output_dir,
                    specs=compilation.executable_specs[:1],
                )

        self.assertEqual(captured_budget, [24])
        self.assertEqual(len(result.evidence_bundles), 0)

    def test_sharded_real_replay_continues_after_candidate_timeout(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                [runner.RECENT_WHITEPAPER_SEEDS[0]]
            )
            compilation = runner.compile_whitepaper_candidate_specs(
                hypothesis_cards=cards,
                family_template_dir=Path("config/trading/families"),
                seed_sweep_dir=Path("config/trading"),
            )
            specs = compilation.executable_specs[:3]
            calls: list[list[str]] = []

            def fake_replay(
                _args: Namespace,
                *,
                output_dir: Path,
                specs: Sequence[runner.CandidateSpec],
            ) -> runner.EpochReplayResult:
                spec_ids = [spec.candidate_spec_id for spec in specs]
                calls.append(spec_ids)
                if len(calls) == 2:
                    raise TimeoutError("real_replay_timeout_seconds:7")
                bundle = runner.evidence_bundle_from_frontier_candidate(
                    candidate_spec_id=spec_ids[0],
                    candidate={
                        "candidate_id": f"cand-{spec_ids[0]}",
                        "objective_scorecard": {
                            "net_pnl_per_day": "10",
                            "active_day_ratio": "1",
                            "positive_day_ratio": "1",
                        },
                    },
                    dataset_snapshot_id="snap-shard",
                    result_path=str(output_dir / f"{spec_ids[0]}.json"),
                )
                return runner.EpochReplayResult(
                    evidence_bundles=(bundle,),
                    replay_results=({"status": "ok", "spec_ids": spec_ids},),
                )

            args = self._args(output_dir)
            args.replay_mode = "real"
            args.real_replay_shard_size = 1
            args.real_replay_shard_timeout_seconds = 7
            with patch.object(runner, "_run_real_replay", side_effect=fake_replay):
                result = runner._run_replay_with_optional_timeout(
                    args=args,
                    output_dir=output_dir,
                    specs=specs,
                )

        self.assertEqual(len(calls), 3)
        self.assertTrue(result.incomplete)
        self.assertEqual(len(result.evidence_bundles), 2)
        self.assertTrue(
            any(
                item.get("status") == "partial_replay_shards_interrupted"
                for item in result.replay_results
            )
        )
        shard_summary = next(
            item
            for item in result.replay_results
            if item.get("status") == "partial_replay_shards_interrupted"
        )
        self.assertEqual(shard_summary["shard_workers"], 1)
        self.assertIn(
            "TimeoutError:real_replay_timeout_seconds:7", result.failure_reasons
        )

    def test_real_replay_shards_use_isolated_output_dirs_and_bounded_budget(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                [runner.RECENT_WHITEPAPER_SEEDS[0]]
            )
            compilation = runner.compile_whitepaper_candidate_specs(
                hypothesis_cards=cards,
                family_template_dir=Path("config/trading/families"),
                seed_sweep_dir=Path("config/trading"),
            )
            specs = compilation.executable_specs[:3]
            args = self._args(output_dir)
            args.max_candidates = 24
            args.top_k = 12
            args.max_frontier_candidates_per_spec = 2
            args.max_total_frontier_candidates = 5

            plans = runner._build_real_replay_shards(
                args=args,
                output_dir=output_dir,
                specs=specs,
                shard_size=1,
                shard_timeout_seconds=7,
            )

        self.assertEqual(len(plans), 3)
        self.assertEqual(
            [plan.output_dir.name for plan in plans],
            ["shard-001", "shard-002", "shard-003"],
        )
        self.assertTrue(
            all(
                plan.output_dir.parent == output_dir / "strategy-factory-shards"
                for plan in plans
            )
        )
        self.assertEqual(
            [plan.args.max_total_frontier_candidates for plan in plans],
            [2, 2, 2],
        )
        self.assertEqual([plan.args.top_k for plan in plans], [1, 1, 1])

    def test_real_replay_shards_runs_bounded_worker_pool(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                [runner.RECENT_WHITEPAPER_SEEDS[0]]
            )
            compilation = runner.compile_whitepaper_candidate_specs(
                hypothesis_cards=cards,
                family_template_dir=Path("config/trading/families"),
                seed_sweep_dir=Path("config/trading"),
            )
            specs = compilation.executable_specs[:3]
            args = self._args(output_dir)
            args.real_replay_shard_workers = 8
            workers_seen: list[int] = []
            submitted: list[tuple[Any, runner._ReplayShardPlan]] = []

            class _FakeFuture:
                def __init__(self, outcome: runner._ReplayShardOutcome) -> None:
                    self._outcome = outcome

                def result(self) -> runner._ReplayShardOutcome:
                    return self._outcome

            class _FakeExecutor:
                def __init__(self, max_workers: int) -> None:
                    workers_seen.append(max_workers)

                def __enter__(self) -> _FakeExecutor:
                    return self

                def __exit__(self, *_args: object) -> None:
                    return None

                def submit(
                    self,
                    fn: Any,
                    plan: runner._ReplayShardPlan,
                ) -> _FakeFuture:
                    submitted.append((fn, plan))
                    return _FakeFuture(
                        runner._ReplayShardOutcome(
                            shard_index=plan.shard_index,
                            candidate_spec_ids=tuple(
                                spec.candidate_spec_id for spec in plan.specs
                            ),
                            result=runner.EpochReplayResult(
                                evidence_bundles=(),
                                replay_results=(
                                    {
                                        "status": "ok",
                                        "shard_index": plan.shard_index,
                                    },
                                ),
                            ),
                        )
                    )

            def fake_as_completed(futures: object) -> list[_FakeFuture]:
                return list(cast(Sequence[_FakeFuture], list(futures)))[::-1]

            with (
                patch.object(runner, "ProcessPoolExecutor", _FakeExecutor),
                patch.object(runner, "as_completed", side_effect=fake_as_completed),
            ):
                result = runner._run_real_replay_shards(
                    args=args,
                    output_dir=output_dir,
                    specs=specs,
                    shard_size=1,
                    shard_timeout_seconds=7,
                )

        self.assertEqual(workers_seen, [3])
        self.assertEqual(len(submitted), 3)
        self.assertTrue(
            all(fn is runner._execute_real_replay_shard for fn, _plan in submitted)
        )
        self.assertEqual(
            [item["shard_index"] for item in result.replay_results],
            [1, 2, 3],
        )

    def test_incomplete_sharded_replay_cannot_report_oracle_candidate_found(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"

            def fake_replay(
                *,
                args: Namespace,
                output_dir: Path,
                specs: Sequence[runner.CandidateSpec],
            ) -> runner.EpochReplayResult:
                spec = specs[0]
                bundle = runner.evidence_bundle_from_frontier_candidate(
                    candidate_spec_id=spec.candidate_spec_id,
                    candidate={
                        "candidate_id": "cand-incomplete",
                        "objective_scorecard": {
                            "net_pnl_per_day": "400",
                            "active_day_ratio": "1",
                            "positive_day_ratio": "1",
                            "daily_net": {
                                "2026-02-23": "400",
                                "2026-02-24": "400",
                                "2026-02-25": "400",
                                "2026-02-26": "400",
                            },
                            "avg_filled_notional_per_day": "350000",
                        },
                    },
                    dataset_snapshot_id="snap-incomplete",
                    result_path=str(output_dir / "incomplete.json"),
                )
                return runner.EpochReplayResult(
                    evidence_bundles=(bundle,),
                    replay_results=({"status": "partial_replay_shards_interrupted"},),
                    incomplete=True,
                    failure_reasons=("TimeoutError:real_replay_timeout_seconds:7",),
                )

            args = self._args(output_dir)
            args.replay_mode = "real"
            args.portfolio_size_min = 1
            with patch.object(
                runner, "_run_replay_with_optional_timeout", side_effect=fake_replay
            ):
                payload = runner.run_whitepaper_autoresearch_profit_target(args)

        self.assertEqual(payload["status"], "no_profit_target_candidate")
        self.assertEqual(payload["status_reason"], "selected_replay_incomplete")
        self.assertTrue(payload["replay_incomplete"])
        self.assertFalse(payload["oracle_candidate_found"])
        self.assertIn(
            "selected_replay_incomplete", payload["promotion_readiness"]["blockers"]
        )

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
