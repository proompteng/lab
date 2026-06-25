from __future__ import annotations

import app.trading.discovery.mlx_snapshot as mlx_snapshot
import app.trading.discovery.portfolio_optimizer as portfolio_optimizer
import app.trading.discovery.profit_target_oracle as profit_target_oracle

from dataclasses import replace
import json
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch


import scripts.run_whitepaper_autoresearch_profit_target as runner
from tests.autoresearch_runner.helpers import (
    AutoresearchRunnerTestCase,
    _CHIP_UNIVERSE,
    _authoritative_exact_replay_ledger_rows,
)


class TestAutoresearchRunnerRuntimeClosure(AutoresearchRunnerTestCase):
    def test_runtime_closure_replay_is_disabled_when_candidate_already_failed_oracle(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            args = self._args(Path(tmpdir) / "epoch")
            args.program = Path(
                "config/trading/research-programs/portfolio-profit-autoresearch-500-v1.yaml"
            )
            program = runner._load_epoch_program(args)

        manifest = mlx_snapshot.MlxSnapshotManifest(
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
        portfolio = portfolio_optimizer.PortfolioCandidateSpec(
            schema_version="torghut.portfolio-candidate-spec.v1",
            portfolio_candidate_id="portfolio-test",
            source_candidate_ids=("candidate-test",),
            target_net_pnl_per_day=Decimal("500"),
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

    def test_runtime_closure_replay_stays_enabled_for_proof_only_oracle_failure(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            args = self._args(Path(tmpdir) / "epoch")
            args.program = Path(
                "config/trading/research-programs/portfolio-profit-autoresearch-500-v1.yaml"
            )
            args.replay_mode = "real"
            program = runner._load_epoch_program(args)

        manifest = mlx_snapshot.MlxSnapshotManifest(
            snapshot_id="mlx-snap-test",
            created_at="2026-05-06T00:00:00+00:00",
            source_window_start="2026-03-20",
            source_window_end="2026-04-09",
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
        portfolio = portfolio_optimizer.PortfolioCandidateSpec(
            schema_version="torghut.portfolio-candidate-spec.v1",
            portfolio_candidate_id="portfolio-test",
            source_candidate_ids=("candidate-test",),
            target_net_pnl_per_day=Decimal("500"),
            sleeves=(),
            capital_budget={},
            correlation_budget={},
            drawdown_budget={},
            evidence_refs=(),
            objective_scorecard={
                "target_met": True,
                "oracle_passed": False,
                "profit_target_oracle": {
                    "passed": False,
                    "blockers": [
                        "shadow_parity_status_failed",
                        "executable_replay_passed_failed",
                        "executable_replay_artifact_present_failed",
                    ],
                },
            },
            optimizer_report={},
        )

        runtime_program = runner._runtime_closure_program_for_candidate(
            program=program,
            manifest=manifest,
            portfolio=portfolio,
            oracle_candidate_found=False,
        )

        self.assertTrue(runtime_program.runtime_closure_policy.execute_parity_replay)
        self.assertTrue(runtime_program.runtime_closure_policy.execute_approval_replay)

    def test_runtime_closure_exact_replay_ledger_rejects_summary_counts_without_rows(
        self,
    ) -> None:
        self.assertIsNone(runner._runtime_closure_ledger_datetime(None))
        self.assertIsNone(runner._runtime_closure_ledger_datetime("not-a-date"))
        self.assertEqual(
            runner._runtime_closure_ledger_datetime("2026-05-20T14:00:00"),
            datetime(2026, 5, 20, 14, tzinfo=timezone.utc),
        )
        self.assertEqual(
            runner._runtime_closure_ledger_datetime("2026-05-20T14:00:00-04:00"),
            datetime(2026, 5, 20, 18, tzinfo=timezone.utc),
        )
        self.assertIsNone(
            runner._runtime_closure_exact_replay_bucket(
                ledger={"window_start": "2026-05-20", "window_end": "2026-05-19"},
                rows=_authoritative_exact_replay_ledger_rows(),
            )
        )
        with patch(
            "scripts.whitepaper_autoresearch_runner.runtime_closure.build_runtime_ledger_buckets",
            return_value=[],
        ):
            self.assertIsNone(
                runner._runtime_closure_exact_replay_bucket(
                    ledger={
                        "window_start": "2026-05-20",
                        "window_end": "2026-05-20",
                    },
                    rows=_authoritative_exact_replay_ledger_rows(),
                )
            )
        with TemporaryDirectory() as tmpdir:
            artifact_path = Path(tmpdir) / "ledger.json"
            artifact_path.write_text(
                json.dumps(
                    {
                        "artifact_kind": "runtime_summary",
                        "row_count": 99,
                        "filled_count": 99,
                        "summary": {"filled_count": 99},
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            self.assertEqual(
                runner._runtime_closure_exact_replay_ledger_update(
                    {"exact_replay_ledger_artifact_path": str(artifact_path)}
                ),
                {},
            )

            artifact_path.write_text(
                json.dumps(
                    {
                        "artifact_kind": "exact_replay_ledger",
                        "schema_version": "torghut.runtime_summary.v1",
                        "runtime_ledger_rows": [{"id": 1}],
                        "fill_row_count": 1,
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            self.assertEqual(
                runner._runtime_closure_exact_replay_ledger_update(
                    {"exact_replay_ledger_artifact_path": str(artifact_path)}
                ),
                {},
            )

            artifact_path.write_text(
                json.dumps(
                    {
                        "artifact_kind": "exact_replay_ledger",
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
                        "row_count": 99,
                        "filled_count": 99,
                        "summary": {"filled_count": 99},
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            self.assertEqual(
                runner._runtime_closure_exact_replay_ledger_update(
                    {"exact_replay_ledger_artifact_path": str(artifact_path)}
                ),
                {},
            )

            artifact_path.write_text(
                json.dumps(
                    {
                        "artifact_kind": "exact_replay_ledger",
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
                        "runtime_ledger_rows": ["not-a-row"],
                        "fill_row_count": 1,
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            self.assertEqual(
                runner._runtime_closure_exact_replay_ledger_update(
                    {"exact_replay_ledger_artifact_path": str(artifact_path)}
                ),
                {},
            )

            artifact_path.write_text(
                json.dumps(
                    {
                        "artifact_kind": "exact_replay_ledger",
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
                        "runtime_ledger_rows": [{"id": 1}],
                        "window_start": "2026-05-20",
                        "window_end": "2026-05-20",
                        "row_count": 99,
                        "fill_row_count": 1,
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            self.assertEqual(
                runner._runtime_closure_exact_replay_ledger_update(
                    {"exact_replay_ledger_artifact_path": str(artifact_path)}
                ),
                {},
            )

            artifact_path.write_text(
                json.dumps(
                    {
                        "artifact_kind": "exact_replay_ledger",
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
                        "window_start": "2026-05-20",
                        "window_end": "2026-05-20",
                        "fill_row_count": 1,
                        "runtime_ledger_rows": _authoritative_exact_replay_ledger_rows(),
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            self.assertEqual(
                runner._runtime_closure_exact_replay_ledger_update(
                    {"exact_replay_ledger_artifact_path": str(artifact_path)}
                ),
                {},
            )

            artifact_path.write_text(
                json.dumps(
                    {
                        "artifact_kind": "exact_replay_ledger",
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
                        "window_start": "2026-05-20",
                        "window_end": "2026-05-20",
                        "fill_row_count": 2,
                        "runtime_ledger_rows": _authoritative_exact_replay_ledger_rows(),
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            update = runner._runtime_closure_exact_replay_ledger_update(
                {"exact_replay_ledger_artifact_path": str(artifact_path)}
            )

        self.assertEqual(update, {})

    def test_runtime_closure_proof_blocks_oracle_without_source_runtime_ledger(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            run_root = Path(tmpdir)
            runtime_root = run_root / "runtime-closure"
            replay_dir = runtime_root / "replay"
            gates_dir = runtime_root / "gates"
            promotion_dir = runtime_root / "promotion"
            replay_dir.mkdir(parents=True)
            gates_dir.mkdir(parents=True)
            promotion_dir.mkdir(parents=True)
            parity_replay_path = replay_dir / "scheduler-v3-parity-replay.json"
            approval_replay_path = replay_dir / "scheduler-v3-approval-replay.json"
            parity_report_path = replay_dir / "scheduler-v3-parity-report.json"
            approval_report_path = replay_dir / "scheduler-v3-approval-report.json"
            shadow_path = replay_dir / "shadow-validation-plan.json"
            replay_plan_path = replay_dir / "runtime-replay-plan.json"
            exact_ledger_path = replay_dir / "exact-replay-ledger.json"
            market_impact_path = replay_dir / "market-impact-stress.json"
            delay_depth_path = replay_dir / "delay-adjusted-depth-stress.json"
            double_oos_path = replay_dir / "double-oos-walkforward.json"
            gate_path = gates_dir / "gate-evaluation.json"
            proof_path = promotion_dir / "portfolio-proof-receipt.json"
            summary_path = runtime_root / "summary.json"
            for artifact_path in (
                parity_replay_path,
                approval_replay_path,
                gate_path,
                proof_path,
                summary_path,
            ):
                artifact_path.write_text("{}\n", encoding="utf-8")
            parity_report_path.write_text(
                json.dumps(
                    {
                        "objective_met": True,
                        "summary": {"filled_count": 3, "decision_count": 4},
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            approval_report_path.write_text(
                json.dumps(
                    {
                        "objective_met": True,
                        "summary": {"filled_count": 2, "decision_count": 3},
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            shadow_path.write_text(
                json.dumps(
                    {
                        "schema_version": "torghut.runtime-closure-shadow-validation-plan.v1",
                        "status": "within_budget",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            replay_plan_path.write_text(
                json.dumps({"execution_context": {"start_equity": "31590.02"}}) + "\n",
                encoding="utf-8",
            )
            exact_ledger_path.write_text(
                json.dumps(
                    {
                        "artifact_kind": "exact_replay_ledger",
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
                        "window_start": "2026-05-20",
                        "window_end": "2026-05-20",
                        "runtime_ledger_rows": _authoritative_exact_replay_ledger_rows(),
                        "fill_row_count": 2,
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            market_impact_path.write_text(
                json.dumps(
                    {
                        "objective_met": True,
                        "model": "square_root",
                        "impact_cost_bps": "5",
                        "liquidity_evidence_present": True,
                        "net_pnl_per_day": "999",
                        "post_impact_net_pnl_per_day": "610",
                        "source_markers": [
                            "double_square_root_impact_arxiv_2502_16246_2025",
                            "realistic_market_impact_arxiv_2603_29086_2026",
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            delay_depth_path.write_text(
                json.dumps(
                    {
                        "objective_met": True,
                        "model": "latency_depth_haircut",
                        "stress_delay_ms": "250",
                        "case_count": 2,
                        "generated_at": "2026-05-19T13:00:00Z",
                        "fillable_notional_per_day": "300000",
                        "fill_survival_evidence_present": True,
                        "fill_survival_sample_count": 2,
                        "fill_survival_rate": "0.85",
                        "queue_position_survival_fill_curve_evidence_present": True,
                        "queue_position_survival_sample_count": 2,
                        "queue_position_survival_fill_rate": "0.85",
                        "queue_position_survival_queue_ratio_p95": "0.25",
                        "queue_position_survival_queue_ahead_depletion_evidence_present": True,
                        "queue_position_survival_queue_ahead_depletion_sample_count": 2,
                        "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
                        "delay_adjusted_depth_queue_ahead_depletion_sample_count": 2,
                        "post_cost_net_pnl_after_queue_position_survival_fill_stress": "605",
                        "post_delay_depth_net_pnl_per_day": "605",
                        "source_markers": [
                            "lob_simulation_reality_gap_arxiv_2603_24137_2026"
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            double_oos_path.write_text(
                json.dumps(
                    {
                        "objective_met": True,
                        "independent_window_count": 2,
                        "pass_rate": "1.00",
                        "post_double_oos_net_pnl_per_day": "615",
                        "post_cost_shock_net_pnl_per_day": "575",
                        "source_markers": [
                            "double_oos_walkforward_arxiv_2602_10785_2026"
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            policy = profit_target_oracle.ProfitTargetOraclePolicy(
                min_observed_trading_days=2
            )
            scorecard: dict[str, object] = {
                "net_pnl_per_day": "620",
                "portfolio_post_cost_net_pnl_per_day": "620",
                "target_met": True,
                "active_day_ratio": "1",
                "positive_day_ratio": "1",
                "daily_net": {"2026-03-20": "620", "2026-03-21": "620"},
                "trading_day_count": 2,
                "best_day_share": "0.25",
                "max_single_day_contribution_share": "0.25",
                "max_cluster_contribution_share": "0.30",
                "max_single_symbol_contribution_share": "0.30",
                "worst_day_loss": "0",
                "max_drawdown": "0",
                "avg_filled_notional_per_day": "300000",
                "regime_slice_pass_rate": "0.60",
                "posterior_edge_lower": "0.01",
                "shadow_parity_status": "missing",
                "executable_replay_passed": False,
                "executable_replay_artifact_ref": "",
                "executable_replay_order_count": 0,
                "executable_replay_account_buying_power": "0",
                "executable_replay_max_notional_per_trade": "0",
            }
            scorecard["profit_target_oracle"] = (
                profit_target_oracle.evaluate_profit_target_oracle(
                    scorecard,
                    target_net_pnl_per_day=Decimal("500"),
                    policy=policy,
                )
            )
            scorecard["oracle_passed"] = False
            self.assertIn(
                "market_impact_stress_artifact_present_failed",
                scorecard["profit_target_oracle"]["blockers"],
            )
            portfolio = portfolio_optimizer.PortfolioCandidateSpec(
                schema_version="torghut.portfolio-candidate-spec.v1",
                portfolio_candidate_id="portfolio-test",
                source_candidate_ids=("candidate-test",),
                target_net_pnl_per_day=Decimal("500"),
                sleeves=(
                    {
                        "candidate_id": "candidate-test",
                        "candidate_spec_id": "spec-test",
                        "runtime_family": "breakout_continuation_consistent",
                        "runtime_strategy_name": "breakout-sleeve-1",
                        "weight": "0.5",
                    },
                ),
                capital_budget={},
                correlation_budget={},
                drawdown_budget={},
                evidence_refs=(),
                objective_scorecard=scorecard,
                optimizer_report={},
            )

            updated = runner._portfolio_with_runtime_closure_proof(
                portfolio=portfolio,
                runtime_closure={
                    "status": "ready_for_promotion_review",
                    "root": str(runtime_root),
                    "gate_report_path": str(gate_path),
                    "parity_replay_path": str(parity_replay_path),
                    "parity_report_path": str(parity_report_path),
                    "approval_replay_path": str(approval_replay_path),
                    "approval_report_path": str(approval_report_path),
                    "shadow_validation_path": str(shadow_path),
                    "portfolio_proof_receipt_path": str(proof_path),
                    "replay_plan_path": str(replay_plan_path),
                    "exact_replay_ledger_artifact_path": str(exact_ledger_path),
                    "market_impact_stress_report_path": str(market_impact_path),
                    "delay_adjusted_depth_stress_report_path": str(delay_depth_path),
                    "double_oos_report_path": str(double_oos_path),
                },
                target=Decimal("500"),
                oracle_policy=policy,
            )

        self.assertFalse(updated.objective_scorecard["oracle_passed"])
        self.assertFalse(updated.objective_scorecard["profit_target_oracle"]["passed"])
        oracle_blockers = updated.objective_scorecard["profit_target_oracle"][
            "blockers"
        ]
        self.assertIn("exact_replay_ledger_artifact_present_failed", oracle_blockers)
        self.assertIn("exact_replay_ledger_artifact_row_count_failed", oracle_blockers)
        self.assertIn("exact_replay_ledger_artifact_fill_count_failed", oracle_blockers)
        self.assertIn("portfolio_post_cost_net_pnl_basis_failed", oracle_blockers)
        self.assertIn("portfolio_post_cost_net_pnl_source_failed", oracle_blockers)
        self.assertTrue(updated.objective_scorecard["executable_replay_passed"])
        self.assertEqual(
            updated.objective_scorecard["shadow_parity_status"], "within_budget"
        )
        self.assertEqual(
            updated.objective_scorecard["executable_replay_order_count"], 2
        )
        self.assertEqual(
            updated.objective_scorecard["executable_replay_artifact_ref"],
            str(approval_replay_path),
        )
        self.assertNotIn(
            "exact_replay_ledger_artifact_ref", updated.objective_scorecard
        )
        self.assertNotIn(
            "exact_replay_ledger_artifact_row_count",
            updated.objective_scorecard,
        )
        self.assertNotIn(
            "exact_replay_ledger_artifact_fill_count",
            updated.objective_scorecard,
        )
        self.assertEqual(
            updated.objective_scorecard["market_impact_stress_artifact_ref"],
            str(market_impact_path),
        )
        self.assertEqual(
            updated.objective_scorecard["market_impact_stress_model"], "square_root"
        )
        self.assertEqual(
            updated.objective_scorecard["market_impact_stress_net_pnl_per_day"],
            "610",
        )
        self.assertEqual(
            updated.objective_scorecard["market_impact_stress_source_markers"],
            [
                "double_square_root_impact_arxiv_2502_16246_2025",
                "realistic_market_impact_arxiv_2603_29086_2026",
            ],
        )
        self.assertIn(
            "double_square_root_impact_arxiv_2502_16246_2025",
            updated.objective_scorecard["market_impact_stress_components"][
                "source_markers"
            ],
        )
        self.assertEqual(
            updated.objective_scorecard["delay_adjusted_depth_stress_checks_total"],
            2,
        )
        self.assertEqual(
            updated.objective_scorecard["delay_adjusted_depth_stress_checked_at"],
            "2026-05-19T13:00:00Z",
        )
        self.assertTrue(
            updated.objective_scorecard["delay_adjusted_depth_stress_passed"]
        )
        self.assertTrue(
            updated.objective_scorecard[
                "delay_adjusted_depth_fill_survival_evidence_present"
            ]
        )
        self.assertEqual(
            updated.objective_scorecard[
                "delay_adjusted_depth_fill_survival_sample_count"
            ],
            2,
        )
        self.assertEqual(
            updated.objective_scorecard["delay_adjusted_depth_fill_survival_rate"],
            "0.85",
        )
        self.assertTrue(
            updated.objective_scorecard[
                "queue_position_survival_fill_curve_evidence_present"
            ]
        )
        self.assertEqual(
            updated.objective_scorecard["queue_position_survival_sample_count"],
            2,
        )
        self.assertTrue(
            updated.objective_scorecard[
                "queue_position_survival_queue_ahead_depletion_evidence_present"
            ]
        )
        self.assertEqual(
            updated.objective_scorecard[
                "queue_position_survival_queue_ahead_depletion_sample_count"
            ],
            2,
        )
        self.assertEqual(
            updated.objective_scorecard[
                "post_cost_net_pnl_after_queue_position_survival_fill_stress"
            ],
            "605",
        )
        self.assertEqual(
            updated.objective_scorecard["delay_adjusted_depth_stress_source_markers"],
            ["lob_simulation_reality_gap_arxiv_2603_24137_2026"],
        )
        self.assertEqual(
            updated.objective_scorecard["double_oos_artifact_ref"],
            str(double_oos_path),
        )
        self.assertEqual(
            updated.objective_scorecard["double_oos_independent_window_count"],
            2,
        )
        self.assertEqual(updated.objective_scorecard["double_oos_pass_rate"], "1.00")
        self.assertEqual(
            updated.objective_scorecard["double_oos_cost_shock_net_pnl_per_day"],
            "575",
        )
        self.assertEqual(
            updated.objective_scorecard["double_oos_source_markers"],
            ["double_oos_walkforward_arxiv_2602_10785_2026"],
        )
        self.assertEqual(
            updated.objective_scorecard["runtime_closure_source_markers"],
            [
                "double_oos_walkforward_arxiv_2602_10785_2026",
                "double_square_root_impact_arxiv_2502_16246_2025",
                "lob_simulation_reality_gap_arxiv_2603_24137_2026",
                "realistic_market_impact_arxiv_2603_29086_2026",
            ],
        )
        self.assertIn(str(approval_replay_path), updated.evidence_refs)

    def test_runtime_closure_proof_helpers_stay_fail_closed_on_edge_inputs(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            invalid_json_path = Path(tmpdir) / "invalid.json"
            invalid_json_path.write_text("{", encoding="utf-8")
            args = self._args(Path(tmpdir) / "epoch")
            program = runner._load_epoch_program(args)

        portfolio = portfolio_optimizer.PortfolioCandidateSpec(
            schema_version="torghut.portfolio-candidate-spec.v1",
            portfolio_candidate_id="portfolio-test",
            source_candidate_ids=("candidate-test",),
            target_net_pnl_per_day=Decimal("500"),
            sleeves=(
                {"candidate_id": "candidate-test", "max_notional_per_trade": "123"},
                {"candidate_id": "candidate-two", "weight": "-1"},
            ),
            capital_budget={},
            correlation_budget={},
            drawdown_budget={},
            evidence_refs=(),
            objective_scorecard={"target_met": True, "oracle_passed": True},
            optimizer_report={},
        )
        manifest = mlx_snapshot.MlxSnapshotManifest(
            snapshot_id="mlx-snap-test",
            created_at="2026-05-06T00:00:00+00:00",
            source_window_start="2026-03-20",
            source_window_end="2026-04-09",
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

        self.assertEqual(runner._oracle_blockers({}), frozenset())
        self.assertEqual(runner._load_json_mapping_artifact(invalid_json_path), {})
        self.assertEqual(
            runner._runtime_report_summary_int(
                {"summary": {"filled_count": "bad"}}, "filled_count", default=7
            ),
            7,
        )
        self.assertEqual(runner._runtime_report_int("bad", default=11), 11)
        self.assertEqual(
            runner._portfolio_executable_max_notional(portfolio), Decimal("50000")
        )
        self.assertFalse(runner._portfolio_needs_runtime_closure_proof(portfolio))
        market_impact_only_portfolio = replace(
            portfolio,
            objective_scorecard={
                "target_met": True,
                "oracle_passed": False,
                "profit_target_oracle": {
                    "passed": False,
                    "blockers": [
                        "market_impact_stress_passed_failed",
                        "market_impact_stress_artifact_present_failed",
                        "market_impact_liquidity_evidence_present_failed",
                        "market_impact_stress_model_failed",
                        "market_impact_stress_cost_bps_failed",
                        "market_impact_stress_net_pnl_per_day_failed",
                    ],
                },
            },
        )
        self.assertTrue(
            runner._portfolio_needs_runtime_closure_proof(market_impact_only_portfolio)
        )
        self.assertIs(
            runner._runtime_closure_program_for_candidate(
                program=program,
                manifest=manifest,
                portfolio=None,
                oracle_candidate_found=False,
            ),
            program,
        )

    def test_runtime_closure_market_impact_source_marker_fallbacks(self) -> None:
        with TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            default_marker_path = tmp_path / "impact-default-marker.json"
            default_marker_path.write_text(
                json.dumps(
                    {
                        "objective_met": True,
                        "model": "square_root",
                        "impact_cost_bps": "7",
                        "post_impact_net_pnl_per_day": "512",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            default_marker_update = runner._runtime_closure_market_impact_stress_update(
                {"market_impact_stress_report_path": str(default_marker_path)}
            )
            self.assertEqual(
                default_marker_update["market_impact_stress_source_markers"],
                [
                    "double_square_root_impact_arxiv_2502_16246_2025",
                    "realistic_market_impact_arxiv_2603_29086_2026",
                ],
            )
            self.assertEqual(
                default_marker_update["market_impact_stress_components"][
                    "source_markers"
                ],
                [
                    "double_square_root_impact_arxiv_2502_16246_2025",
                    "realistic_market_impact_arxiv_2603_29086_2026",
                ],
            )

            component_marker_path = tmp_path / "impact-component-marker.json"
            component_marker_path.write_text(
                json.dumps(
                    {
                        "objective_met": True,
                        "model": "square_root",
                        "impact_cost_bps": "8",
                        "post_impact_net_pnl_per_day": "513",
                        "source_markers": [
                            "double_square_root_impact_arxiv_2502_16246_2025",
                            "realistic_market_impact_arxiv_2603_29086_2026",
                        ],
                        "market_impact_stress_components": {
                            "source_marker": "realistic_market_impact_arxiv_2603_29086_2026",
                            "selected_model": "square_root",
                            "selected_cost_bps": "8",
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            component_marker_update = (
                runner._runtime_closure_market_impact_stress_update(
                    {"market_impact_stress_report_path": str(component_marker_path)}
                )
            )
            self.assertIn(
                "double_square_root_impact_arxiv_2502_16246_2025",
                component_marker_update["market_impact_stress_components"][
                    "source_markers"
                ],
            )
