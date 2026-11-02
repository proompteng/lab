from __future__ import annotations

import app.trading.discovery.evidence_bundles as evidence_bundles
import app.trading.discovery.portfolio_optimizer as portfolio_optimizer
from app.trading.discovery.candidate_specs import CandidateSpec
import scripts.whitepaper_autoresearch_runner.candidate_remediation as candidate_remediation
import scripts.whitepaper_autoresearch_runner.persisted_feedback_sources as persisted_feedback_sources

from dataclasses import replace
import json
from argparse import Namespace
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from sqlalchemy import select
from sqlalchemy.orm import Session

import scripts.run_whitepaper_autoresearch_profit_target as runner
import scripts.train_mlx_autoresearch_ranker as ranker_trainer
from scripts.whitepaper_autoresearch_runner import replay_shards
from scripts.whitepaper_autoresearch_runner import run_reporting
from app.models import (
    AutoresearchCandidateSpec,
    AutoresearchEpoch,
    AutoresearchPortfolioCandidate,
    AutoresearchProposalScore,
)
from tests.autoresearch_runner.helpers import (
    AutoresearchRunnerTestCase,
    _compact_recent_whitepaper_sources,
)
import scripts.whitepaper_autoresearch_runner.replay_models as replay_models


class TestAutoresearchRunnerEpochPersistenceRemediation(AutoresearchRunnerTestCase):
    def test_main_returns_nonzero_when_no_oracle_candidate_found(self) -> None:
        with (
            TemporaryDirectory() as tmpdir,
            patch.object(
                runner,
                "_parse_args",
                return_value=Namespace(
                    **{
                        **vars(self._source_jsonl_args(Path(tmpdir) / "epoch")),
                        "target_net_pnl_per_day": "999999",
                        "exploration_slots": 0,
                        "max_candidates": 1,
                        "max_frontier_candidates_per_spec": 1,
                        "max_total_frontier_candidates": 1,
                        "portfolio_size_min": 1,
                        "portfolio_size_max": 1,
                        "top_k": 1,
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
            summary["status_reason"], "portfolio_optimizer_produced_no_candidate"
        )
        self.assertFalse(summary["oracle_candidate_found"])
        self.assertIsNone(summary["profit_target_oracle"])
        self.assertEqual(
            summary["promotion_readiness"]["status"],
            "no_candidate",
        )
        self.assertEqual(
            remediation["schema_version"],
            "torghut.whitepaper-autoresearch-remediation.v1",
        )
        self.assertTrue(remediation["next_actions"])
        self.assertIn("candidate_search_remediation", summary["artifacts"])
        self.assertIn("profitability_search_goal", summary["artifacts"])
        self.assertEqual(
            summary["profitability_search_goal"]["objective"][
                "target_net_pnl_per_trading_day"
            ],
            "999999",
        )
        self.assertTrue(portfolio_report_exists)

    def test_seed_recent_whitepapers_persists_epoch_ledgers(self) -> None:
        with (
            TemporaryDirectory() as tmpdir,
            _compact_recent_whitepaper_sources(4),
            patch(
                "scripts.whitepaper_autoresearch_runner.persisted_feedback_sources.SessionLocal",
                side_effect=lambda: Session(self.engine),
            ),
        ):
            args = self._args(Path(tmpdir) / "epoch")
            args.max_frontier_candidates_per_spec = 2
            args.max_total_frontier_candidates = 6
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
        self.assertEqual(
            epoch.summary_json["candidate_evidence_bundle_payload_count"],
            len(epoch.summary_json["candidate_evidence_bundle_payloads"]),
        )

    def test_epoch_ledgers_allow_repeated_candidate_specs_across_epochs(
        self,
    ) -> None:
        candidate_spec = CandidateSpec(
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
            "scripts.whitepaper_autoresearch_runner.persisted_feedback_sources.SessionLocal",
            side_effect=lambda: Session(self.engine),
        ):
            for epoch_id in ("epoch-repeat-1", "epoch-repeat-2"):
                persisted_feedback_sources._persist_epoch_ledgers(
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

    def test_epoch_ledgers_persist_promotion_ready_only_from_readiness_payload(
        self,
    ) -> None:
        portfolio = portfolio_optimizer.PortfolioCandidateSpec(
            schema_version="torghut.portfolio-candidate-spec.v1",
            portfolio_candidate_id="portfolio-readiness-test",
            source_candidate_ids=("candidate-test",),
            target_net_pnl_per_day=Decimal("500"),
            sleeves=(),
            capital_budget={},
            correlation_budget={},
            drawdown_budget={},
            evidence_refs=(),
            objective_scorecard={"oracle_passed": True, "target_met": True},
            optimizer_report={},
        )
        started_at = datetime(2026, 5, 8, 17, 0, 0)
        completed_at = datetime(2026, 5, 8, 17, 1, 0)

        with patch(
            "scripts.whitepaper_autoresearch_runner.persisted_feedback_sources.SessionLocal",
            side_effect=lambda: Session(self.engine),
        ):
            persisted_feedback_sources._persist_epoch_ledgers(
                epoch_id="epoch-readiness-blocked",
                status="ok",
                target_net_pnl_per_day=Decimal("500"),
                paper_run_ids=[],
                sources=[],
                candidate_specs=[],
                proposal_rows=[],
                portfolio=portfolio,
                summary={
                    "promotion_readiness": {
                        "status": "blocked_pending_promotion_prerequisites",
                        "promotable": False,
                        "blockers": ["promotion_gate_report_denied"],
                    }
                },
                runner_config={},
                started_at=started_at,
                completed_at=completed_at,
            )
            persisted_feedback_sources._persist_epoch_ledgers(
                epoch_id="epoch-readiness-ready",
                status="ok",
                target_net_pnl_per_day=Decimal("500"),
                paper_run_ids=[],
                sources=[],
                candidate_specs=[],
                proposal_rows=[],
                portfolio=replace(
                    portfolio, portfolio_candidate_id="portfolio-readiness-ready"
                ),
                summary={
                    "promotion_readiness": {
                        "status": "promotion_ready",
                        "promotable": True,
                        "blockers": [],
                    }
                },
                runner_config={},
                started_at=started_at,
                completed_at=completed_at,
            )

        with Session(self.engine) as session:
            portfolios = (
                session.execute(
                    select(AutoresearchPortfolioCandidate).order_by(
                        AutoresearchPortfolioCandidate.portfolio_candidate_id.asc()
                    )
                )
                .scalars()
                .all()
            )

        self.assertEqual(
            [item.status for item in portfolios], ["promotion_ready", "target_met"]
        )
        blocked_payload = next(
            item
            for item in portfolios
            if item.portfolio_candidate_id == "portfolio-readiness-test"
        )
        self.assertEqual(
            blocked_payload.payload_json["promotion_readiness"]["blockers"],
            ["promotion_gate_report_denied"],
        )

    def test_epoch_ledgers_persist_target_met_oracle_failed_as_paper_probation(
        self,
    ) -> None:
        portfolio = portfolio_optimizer.PortfolioCandidateSpec(
            schema_version="torghut.portfolio-candidate-spec.v1",
            portfolio_candidate_id="portfolio-paper-probation",
            source_candidate_ids=("candidate-test",),
            target_net_pnl_per_day=Decimal("500"),
            sleeves=(),
            capital_budget={},
            correlation_budget={},
            drawdown_budget={},
            evidence_refs=(),
            objective_scorecard={"oracle_passed": False, "target_met": True},
            optimizer_report={},
        )
        started_at = datetime(2026, 5, 8, 17, 0, 0)
        completed_at = datetime(2026, 5, 8, 17, 1, 0)

        with patch(
            "scripts.whitepaper_autoresearch_runner.persisted_feedback_sources.SessionLocal",
            side_effect=lambda: Session(self.engine),
        ):
            persisted_feedback_sources._persist_epoch_ledgers(
                epoch_id="epoch-paper-probation",
                status="ok",
                target_net_pnl_per_day=Decimal("500"),
                paper_run_ids=[],
                sources=[],
                candidate_specs=[],
                proposal_rows=[],
                portfolio=portfolio,
                summary={
                    "promotion_readiness": {
                        "status": "blocked_pending_promotion_prerequisites",
                        "promotable": False,
                        "blockers": ["oracle_blocked"],
                    },
                    "candidate_board": {
                        "paper_probation_candidate": {
                            "candidate_id": "candidate-test",
                            "paper_probation_authorized": True,
                        }
                    },
                },
                runner_config={},
                started_at=started_at,
                completed_at=completed_at,
            )

        with Session(self.engine) as session:
            saved = session.execute(select(AutoresearchPortfolioCandidate)).scalar_one()

        self.assertEqual(saved.status, "paper_probation")
        self.assertFalse(saved.payload_json["promotion_readiness"]["promotable"])
        self.assertEqual(
            saved.payload_json["promotion_readiness"]["blockers"], ["oracle_blocked"]
        )

    def test_epoch_ledgers_keep_target_met_oracle_failed_blocked_without_paper_probation_authority(
        self,
    ) -> None:
        portfolio = portfolio_optimizer.PortfolioCandidateSpec(
            schema_version="torghut.portfolio-candidate-spec.v1",
            portfolio_candidate_id="portfolio-paper-probation-blocked",
            source_candidate_ids=("candidate-test",),
            target_net_pnl_per_day=Decimal("500"),
            sleeves=(),
            capital_budget={},
            correlation_budget={},
            drawdown_budget={},
            evidence_refs=(),
            objective_scorecard={"oracle_passed": False, "target_met": True},
            optimizer_report={},
        )
        started_at = datetime(2026, 5, 8, 17, 0, 0)
        completed_at = datetime(2026, 5, 8, 17, 1, 0)

        with patch(
            "scripts.whitepaper_autoresearch_runner.persisted_feedback_sources.SessionLocal",
            side_effect=lambda: Session(self.engine),
        ):
            persisted_feedback_sources._persist_epoch_ledgers(
                epoch_id="epoch-paper-probation-blocked",
                status="ok",
                target_net_pnl_per_day=Decimal("500"),
                paper_run_ids=[],
                sources=[],
                candidate_specs=[],
                proposal_rows=[],
                portfolio=portfolio,
                summary={
                    "promotion_readiness": {
                        "status": "blocked_pending_promotion_prerequisites",
                        "promotable": False,
                        "blockers": ["oracle_blocked"],
                    }
                },
                runner_config={},
                started_at=started_at,
                completed_at=completed_at,
            )

        with Session(self.engine) as session:
            saved = session.execute(select(AutoresearchPortfolioCandidate)).scalar_one()

        self.assertEqual(saved.status, "blocked")
        self.assertFalse(saved.payload_json["promotion_readiness"]["promotable"])

    def test_persistence_failure_preserves_artifacts_and_returns_infra_failure(
        self,
    ) -> None:
        with (
            TemporaryDirectory() as tmpdir,
            patch(
                "scripts.whitepaper_autoresearch_runner.persisted_feedback_sources.SessionLocal",
                side_effect=RuntimeError("db offline"),
            ),
        ):
            output_dir = Path(tmpdir) / "epoch"
            args = self._source_jsonl_args(output_dir)
            args.max_candidates = 1
            args.max_frontier_candidates_per_spec = 1
            args.max_total_frontier_candidates = 1
            args.portfolio_size_min = 1
            args.portfolio_size_max = 1
            args.top_k = 1
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
                self._source_jsonl_args(output_dir)
            )

            model_payload, scores = ranker_trainer.train_from_artifacts(
                candidate_specs_path=output_dir / "candidate-specs.jsonl",
                evidence_bundles_path=output_dir / "candidate-evidence-bundles.jsonl",
                backend_preference="numpy-fallback",
            )

        self.assertEqual(model_payload["schema_version"], "torghut.mlx-ranker.v7")
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
                        **vars(self._source_jsonl_args(Path(tmpdir) / "epoch")),
                        "replay_mode": "real",
                    }
                ),
            ),
            patch.object(
                replay_shards,
                "_run_real_replay_once_with_optional_timeout",
                side_effect=RuntimeError("forced replay failure"),
            ),
            patch.object(
                run_reporting,
                "_collect_partial_real_replay",
                return_value=replay_models.EpochReplayResult(
                    evidence_bundles=(
                        evidence_bundles.evidence_bundle_from_frontier_candidate(
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
        remediation = candidate_remediation._candidate_search_remediation(
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

    def test_remediation_surfaces_recent_trading_day_shortfall(self) -> None:
        remediation = candidate_remediation._candidate_search_remediation(
            failure_reason="ValueError:insufficient_recent_trading_days:9<11",
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
                    "evidence_status": "missing",
                    "failure_reasons": ["replay_evidence_missing"],
                },
            ),
            best_false_negative_table=(),
            replay_timeout_seconds=600,
            max_frontier_candidates_per_spec=1,
            current_train_days=6,
            current_holdout_days=3,
            current_second_oos_days=2,
        )

        self.assertEqual(
            remediation["recent_trading_days"]["available_recent_trading_days"],
            9,
        )
        self.assertEqual(
            remediation["recent_trading_days"]["required_recent_trading_days"],
            11,
        )
        self.assertEqual(
            remediation["recent_trading_days"]["required_window"],
            {"train_days": 6, "holdout_days": 3, "second_oos_days": 2},
        )
        day_action = remediation["next_actions"][0]
        self.assertEqual(
            day_action["action"], "inspect_or_backfill_recent_ta_signal_days"
        )
        self.assertIn("torghut.ta_signals", day_action["recommended_operator_probe"])
        self.assertIn(
            "torghut.ta_microbars",
            remediation["recent_trading_days"][
                "clickhouse_signal_microbar_coverage_query"
            ],
        )
        self.assertIn(
            "torghut.ta_microbars",
            remediation["recent_trading_days"][
                "clickhouse_signal_microbar_day_gap_query"
            ],
        )
        self.assertEqual(
            day_action["recommended_coverage_probe"],
            remediation["recent_trading_days"]["clickhouse_coverage_probe_queries"][
                "signal_microbar_coverage"
            ],
        )
        self.assertEqual(
            day_action["recommended_day_gap_probe"],
            remediation["recent_trading_days"]["clickhouse_coverage_probe_queries"][
                "signal_microbar_day_gap"
            ],
        )

    def test_remediation_surfaces_stale_tape_shortfall(self) -> None:
        remediation = candidate_remediation._candidate_search_remediation(
            failure_reason=(
                "ValueError:stale_tape:"
                "expected_last_trading_day=2026-05-19:end_day=2026-05-18"
            ),
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
                    "evidence_status": "missing",
                    "failure_reasons": ["replay_evidence_missing"],
                },
            ),
            best_false_negative_table=(),
            replay_timeout_seconds=600,
            max_frontier_candidates_per_spec=1,
        )

        self.assertEqual(
            remediation["stale_tape"],
            {
                "expected_last_trading_day": "2026-05-19",
                "available_end_day": "2026-05-18",
            },
        )
        stale_action = remediation["next_actions"][0]
        self.assertEqual(
            stale_action["action"], "inspect_or_backfill_latest_ta_signal_day"
        )
        self.assertIn("torghut.ta_signals", stale_action["recommended_operator_probe"])
        self.assertIn("2026-05-18", stale_action["diagnostic_replay_note"])

    def test_remediation_prioritizes_missing_promotion_proof(self) -> None:
        remediation = candidate_remediation._candidate_search_remediation(
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
        remediation = candidate_remediation._candidate_search_remediation(
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
        remediation = candidate_remediation._candidate_search_remediation(
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
