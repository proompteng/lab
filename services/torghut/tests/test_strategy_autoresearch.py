from __future__ import annotations

import copy
import json
import sys
from argparse import Namespace
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

import yaml

import app.trading.discovery.autoresearch as autoresearch
from app.trading.discovery.autoresearch import (
    FamilyAutoresearchPlan,
    MutationSpace,
    StrategyObjective,
    apply_program_objective,
    build_mutated_sweep_config,
    candidate_meets_objective,
    load_strategy_autoresearch_program,
)
from app.trading.discovery.autoresearch_notebooks import (
    build_strategy_discovery_history_notebook,
    build_strategy_factory_history_notebook,
    write_autoresearch_notebooks,
    write_strategy_factory_notebooks,
)
from app.trading.discovery.family_templates import FamilyTemplate
from app.trading.models import SignalEnvelope
import scripts.search_consistent_profitability_frontier as frontier
import scripts.run_strategy_autoresearch_loop as runner


def _family_template() -> FamilyTemplate:
    return FamilyTemplate(
        family_id="breakout_reclaim_v2",
        economic_mechanism="Breakout reclaim.",
        supported_markets=("us_equities_intraday",),
        required_features=("quote_quality",),
        allowed_normalizations=("price_scaled", "opening_window_scaled"),
        entry_motifs=("breakout_reclaim",),
        exit_motifs=("trailing_stop",),
        risk_controls=("stop_loss",),
        activity_model={"min_active_day_ratio": "0.50", "min_daily_notional": "200000"},
        liquidity_assumptions={"max_spread_bps": "30"},
        regime_activation_rules=(),
        day_veto_rules=(),
        default_hard_vetoes={"required_max_best_day_share": "0.45"},
        default_selection_objectives={"target_net_pnl_per_day": "300"},
        runtime_harness={
            "family": "breakout_continuation_consistent",
            "strategy_name": "breakout-continuation-long-v1",
            "disable_other_strategies": True,
        },
    )


class TestStrategyAutoresearch(TestCase):
    def test_autoresearch_helper_branches_cover_edge_cases(self) -> None:
        self.assertEqual(autoresearch._string_list("not-a-list"), ())
        self.assertEqual(autoresearch._string_list(["", " NVDA ", None]), ("NVDA",))
        self.assertEqual(
            autoresearch._stable_value_key({"b": 2, "a": 1}),
            '{"a":1,"b":2}',
        )
        self.assertIsNone(autoresearch._decimal_from_candidate(None))
        self.assertIsNone(autoresearch._decimal_from_candidate("not-a-number"))
        self.assertEqual(
            autoresearch._format_numeric_like(Decimal("3"), current_value="2"),
            "3",
        )
        self.assertEqual(
            autoresearch._format_numeric_like(Decimal("3.125"), current_value="2.00"),
            "3.12",
        )
        self.assertEqual(
            autoresearch._format_numeric_like(Decimal("3.1400"), current_value=""),
            "3.14",
        )

    def test_apply_objective_capital_limits_clamps_legacy_seed_leverage(self) -> None:
        limited = runner._apply_objective_capital_limits(
            sweep_config={
                "parameters": {
                    "max_entries_per_session": ["2", "8"],
                    "top_n": ["3"],
                    "max_gross_exposure_pct_equity": ["10.0"],
                },
                "strategy_overrides": {
                    "max_position_pct_equity": ["10.0"],
                    "max_notional_per_trade": ["315900.20"],
                },
            },
            max_gross_exposure_pct_equity=Decimal("1.0"),
            start_equity=Decimal("31590.02"),
        )

        self.assertEqual(
            limited["parameters"]["max_gross_exposure_pct_equity"], ["0.98"]
        )
        self.assertEqual(
            limited["strategy_overrides"]["max_position_pct_equity"], ["0.326666"]
        )
        self.assertEqual(
            limited["strategy_overrides"]["max_notional_per_trade"], ["10319.4"]
        )

    def test_apply_objective_capital_limits_keeps_turnover_separate_from_exposure(
        self,
    ) -> None:
        limited = runner._apply_objective_capital_limits(
            sweep_config={
                "parameters": {
                    "max_entries_per_session": ["12"],
                    "max_gross_exposure_pct_equity": ["10.0"],
                },
                "strategy_overrides": {
                    "max_position_pct_equity": ["10.0"],
                    "max_notional_per_trade": ["315900.20"],
                },
            },
            max_gross_exposure_pct_equity=Decimal("1.0"),
            start_equity=Decimal("31590.02"),
        )

        self.assertEqual(
            limited["parameters"]["max_gross_exposure_pct_equity"], ["0.98"]
        )
        self.assertEqual(
            limited["strategy_overrides"]["max_position_pct_equity"], ["0.98"]
        )
        self.assertEqual(
            limited["strategy_overrides"]["max_notional_per_trade"], ["30958.21"]
        )
        self.assertEqual(limited["parameters"]["max_entries_per_session"], ["12"])

    def test_exact_replay_guidance_updates_next_sweep_label(self) -> None:
        sweep, label = runner._apply_exact_replay_guidance_to_next_sweep(
            sweep_config={
                "parameters": {
                    "max_entries_per_session": ["1"],
                },
            },
            mutation_label="parent=candidate-1; mutate=max_entries_per_session",
            remediation_report={
                "status": "blocked_pending_search_remediation",
                "candidate_id": "candidate-1",
                "promotion_blockers": ["avg_filled_notional_per_day_below_min"],
                "runtime_ledger_blockers": [],
                "recommended_search_actions": [{"required_multiplier": "2.0"}],
            },
        )

        self.assertEqual(sweep["parameters"]["max_entries_per_session"], ["1", "2"])
        self.assertEqual(
            label,
            "parent=candidate-1; mutate=max_entries_per_session; replay-guidance=breadth",
        )

    def test_exact_replay_guidance_keeps_label_when_no_search_blocker(self) -> None:
        sweep, label = runner._apply_exact_replay_guidance_to_next_sweep(
            sweep_config={"parameters": {"max_entries_per_session": ["1"]}},
            mutation_label="parent=candidate-1; mutate=max_entries_per_session",
            remediation_report={
                "promotion_blockers": ["replay_artifact_only_not_live"],
                "runtime_ledger_blockers": [],
            },
        )

        self.assertEqual(sweep["parameters"]["max_entries_per_session"], ["1"])
        self.assertEqual(
            label,
            "parent=candidate-1; mutate=max_entries_per_session",
        )

    def test_runtime_window_plan_helpers_surface_missing_handoffs(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            with patch.object(runner, "_REPO_ROOT", root):
                self.assertEqual(runner._hypothesis_manifest_rows(), [])

            hypothesis_dir = root / "services/torghut/config/trading/hypotheses"
            hypothesis_dir.mkdir(parents=True)
            (hypothesis_dir / "bad.json").write_text("{", encoding="utf-8")
            (hypothesis_dir / "missing-id.json").write_text(
                json.dumps({"strategy_id": "ignored_v1@research"}),
                encoding="utf-8",
            )
            (hypothesis_dir / "by-family.json").write_text(
                json.dumps(
                    {
                        "hypothesis_id": "H-BY-FAMILY",
                        "strategy_id": "other_v1@research",
                        "strategy_family": "runtime_family_match",
                        "dataset_snapshot_ref": "snapshot-family",
                    }
                ),
                encoding="utf-8",
            )
            (hypothesis_dir / "by-name.json").write_text(
                json.dumps(
                    {
                        "hypothesis_id": "H-BY-NAME",
                        "strategy_id": "name_match_v1@research",
                    }
                ),
                encoding="utf-8",
            )

            with patch.object(runner, "_REPO_ROOT", root):
                rows = runner._hypothesis_manifest_rows()
                self.assertEqual(
                    [row["hypothesis_id"] for row in rows],
                    ["H-BY-FAMILY", "H-BY-NAME"],
                )
                self.assertEqual(
                    runner._hypothesis_manifest_for_history_row(
                        {
                            "family_template_id": "",
                            "runtime_family": "runtime_family_match",
                            "runtime_strategy_name": "",
                        }
                    )["hypothesis_id"],
                    "H-BY-FAMILY",
                )
                self.assertEqual(
                    runner._hypothesis_manifest_for_history_row(
                        {
                            "family_template_id": "",
                            "runtime_family": "",
                            "runtime_strategy_name": "name-match-v1",
                        }
                    )["hypothesis_id"],
                    "H-BY-NAME",
                )

        self.assertIsNone(
            runner._exact_replay_history_row(history=[], candidate_id="missing")
        )
        no_candidate_blockers = runner._exact_replay_runtime_window_blockers(
            best_exact_replay_ledger_candidate=None,
            history_row=None,
            hypothesis_manifest={},
            artifact_refs=[],
            promotion_blockers=[],
            runtime_ledger_blockers=[],
        )
        self.assertEqual(
            no_candidate_blockers[0]["blocker"],
            "exact_replay_ledger_candidate_missing",
        )
        missing_handoff_blockers = runner._exact_replay_runtime_window_blockers(
            best_exact_replay_ledger_candidate={"candidate_id": "candidate-1"},
            history_row={},
            hypothesis_manifest={},
            artifact_refs=[],
            promotion_blockers=[],
            runtime_ledger_blockers=[],
        )
        blocker_names = {item["blocker"] for item in missing_handoff_blockers}
        self.assertIn("hypothesis_manifest_missing", blocker_names)
        self.assertIn("runtime_harness_metadata_missing", blocker_names)
        self.assertIn("runtime_ledger_artifact_ref_missing", blocker_names)
        missing_history_blockers = runner._exact_replay_runtime_window_blockers(
            best_exact_replay_ledger_candidate={"candidate_id": "candidate-1"},
            history_row=None,
            hypothesis_manifest={},
            artifact_refs=[],
            promotion_blockers=[],
            runtime_ledger_blockers=[],
        )
        self.assertIn(
            "candidate_history_row_missing",
            {item["blocker"] for item in missing_history_blockers},
        )

    def test_runtime_closure_candidate_rejects_failed_or_vetoed_candidates(
        self,
    ) -> None:
        self.assertIsNone(runner._runtime_closure_candidate(None))
        self.assertIsNone(
            runner._runtime_closure_candidate(
                {"candidate_id": "failed", "objective_met": False, "hard_vetoes": []}
            )
        )
        self.assertIsNone(
            runner._runtime_closure_candidate(
                {
                    "candidate_id": "vetoed",
                    "objective_met": True,
                    "hard_vetoes": ["daily_net_below_min"],
                }
            )
        )
        eligible = {
            "candidate_id": "eligible",
            "objective_met": True,
            "hard_vetoes": [],
        }

        self.assertIs(runner._runtime_closure_candidate(eligible), eligible)

    def test_runtime_closure_subject_prefers_oracle_passed_portfolio(
        self,
    ) -> None:
        single = {
            "candidate_id": "single-1",
            "objective_met": True,
            "hard_vetoes": [],
        }
        portfolio = runner.PortfolioCandidateSpec(
            schema_version="torghut.portfolio-candidate-spec.v1",
            portfolio_candidate_id="port-1",
            source_candidate_ids=("sleeve-1", "sleeve-2"),
            target_net_pnl_per_day=Decimal("500"),
            sleeves=(),
            capital_budget={},
            correlation_budget={},
            drawdown_budget={},
            evidence_refs=("bundle-1", "bundle-2"),
            objective_scorecard={"target_met": True, "oracle_passed": True},
            optimizer_report={"oracle_passed": True},
        )

        self.assertIs(
            runner._runtime_closure_subject(
                best_candidate=single,
                portfolio=portfolio,
            ),
            portfolio,
        )
        readiness = runner._summary_promotion_readiness_for_outputs(
            best_candidate=single,
            portfolio=portfolio,
            runtime_closure={
                "status": "ready_for_promotion_review",
                "next_required_steps": ["promotion_review"],
                "promotion_prerequisites": {"allowed": True, "reasons": []},
            },
        )

        self.assertEqual(readiness["candidate_id"], "port-1")
        self.assertEqual(readiness["status"], "promotion_ready")
        self.assertTrue(readiness["promotable"])
        self.assertEqual(readiness["blockers"], [])

    def test_runtime_closure_subject_keeps_blockers_for_denied_portfolio(
        self,
    ) -> None:
        portfolio = runner.PortfolioCandidateSpec(
            schema_version="torghut.portfolio-candidate-spec.v1",
            portfolio_candidate_id="port-blocked",
            source_candidate_ids=("sleeve-1", "sleeve-2"),
            target_net_pnl_per_day=Decimal("500"),
            sleeves=(),
            capital_budget={},
            correlation_budget={},
            drawdown_budget={},
            evidence_refs=("bundle-1", "bundle-2"),
            objective_scorecard={"target_met": True, "oracle_passed": True},
            optimizer_report={"oracle_passed": True},
        )

        readiness = runner._summary_promotion_readiness_for_outputs(
            best_candidate=None,
            portfolio=portfolio,
            runtime_closure={
                "status": "pending_runtime_parity",
                "next_required_steps": [
                    "scheduler_v3_parity_replay",
                    "scheduler_v3_approval_replay",
                    "live_shadow_validation",
                ],
                "promotion_prerequisites": {
                    "allowed": False,
                    "reasons": ["gate_report_missing"],
                },
            },
        )

        self.assertEqual(readiness["candidate_id"], "port-blocked")
        self.assertFalse(readiness["promotable"])
        self.assertEqual(readiness["status"], "blocked_pending_promotion_prerequisites")
        self.assertEqual(
            readiness["blockers"],
            [
                "scheduler_v3_parity_replay",
                "scheduler_v3_approval_replay",
                "live_shadow_validation",
                "gate_report_missing",
            ],
        )

    def test_persist_run_outputs_uses_oracle_passed_portfolio_for_runtime_closure(
        self,
    ) -> None:
        class RuntimeSummary:
            def to_payload(self) -> dict[str, object]:
                return {
                    "status": "ready_for_promotion_review",
                    "candidate_id": "port-1",
                    "portfolio_optimizer_evidence_path": "runtime-closure/promotion/portfolio-optimizer-evidence.json",
                    "next_required_steps": ["promotion_review"],
                    "promotion_prerequisites": {"allowed": True, "reasons": []},
                    "rollback_readiness": {"ready": True},
                }

        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path, family_dir = self._write_program_fixture(root)
            program_payload = yaml.safe_load(program_path.read_text(encoding="utf-8"))
            program = load_strategy_autoresearch_program(
                program_path, family_dir=family_dir
            )
            run_root = root / "run"
            run_root.mkdir()
            manifest = runner.MlxSnapshotManifest(
                snapshot_id="snap-1",
                created_at="2026-05-20T00:00:00+00:00",
                source_window_start="2026-05-01",
                source_window_end="2026-05-15",
                train_days=6,
                holdout_days=3,
                full_window_days=9,
                symbols=("AMAT", "NVDA"),
                bar_interval="1Sec",
                quote_quality_policy_id="quote-quality-v1",
                feature_set_id="torghut.mlx-autoresearch.v1",
                cross_sectional_feature_flags={},
                prior_day_feature_flags={},
                tape_freshness_receipts=(),
                row_counts={},
                tensor_bundle_paths={},
                manifest_hash="hash-1",
            )
            history = [
                {
                    "experiment_index": 0,
                    "iteration": 0,
                    "family_template_id": "breakout_reclaim_v2",
                    "candidate_id": "single-1",
                    "net_pnl_per_day": "620",
                    "active_day_ratio": "0.85",
                    "best_day_share": "0.30",
                    "max_drawdown": "850",
                    "status": "keep",
                    "mutation_label": "seed",
                    "hard_vetoes": [],
                    "pareto_tier": 1,
                    "proposal_score": 0.0,
                    "proposal_rank": 0,
                }
            ]
            portfolio = runner.PortfolioCandidateSpec(
                schema_version="torghut.portfolio-candidate-spec.v1",
                portfolio_candidate_id="port-1",
                source_candidate_ids=("sleeve-1", "sleeve-2"),
                target_net_pnl_per_day=Decimal("500"),
                sleeves=(),
                capital_budget={},
                correlation_budget={},
                drawdown_budget={},
                evidence_refs=("bundle-1", "bundle-2"),
                objective_scorecard={"target_met": True, "oracle_passed": True},
                optimizer_report={"oracle_passed": True},
            )
            portfolio_outputs = {
                "portfolio_candidates_path": str(
                    run_root / "portfolio-candidates.jsonl"
                ),
                "candidate_evidence_bundles_path": str(
                    run_root / "candidate-evidence-bundles.jsonl"
                ),
                "portfolio_optimizer_report_path": str(
                    run_root / "portfolio-optimizer-report.json"
                ),
                "portfolio_candidate_count": 1,
                "candidate_evidence_bundle_count": 2,
                "portfolio_optimizer_report": {"oracle_passed": True},
            }

            with (
                patch(
                    "scripts.run_strategy_autoresearch_loop._write_portfolio_outputs",
                    return_value=(portfolio, portfolio_outputs),
                ),
                patch(
                    "scripts.run_strategy_autoresearch_loop.write_runtime_closure_bundle",
                    return_value=RuntimeSummary(),
                ) as write_runtime_closure,
                patch(
                    "scripts.run_strategy_autoresearch_loop.write_mlx_notebook_exports",
                    return_value={},
                ),
                patch(
                    "scripts.run_strategy_autoresearch_loop.write_autoresearch_notebooks",
                    return_value=[],
                ),
            ):
                summary = runner._persist_run_outputs(
                    run_root=run_root,
                    program=program,
                    program_payload=program_payload,
                    runner_run_id="strategy-autoresearch-test",
                    program_id=program.program_id,
                    frontier_runs=1,
                    objective_met=True,
                    history=history,
                    manifest=manifest,
                    descriptors=[],
                    proposal_scores=[],
                    worklist=[],
                    status="ok",
                )
            promotion_readiness_file = json.loads(
                Path(summary["promotion_readiness_path"]).read_text(encoding="utf-8")
            )

            runtime_kwargs = write_runtime_closure.call_args.kwargs
            self.assertIs(runtime_kwargs["best_candidate"], portfolio)
            self.assertEqual(summary["runtime_closure"]["candidate_id"], "port-1")
            self.assertEqual(summary["promotion_readiness"]["candidate_id"], "port-1")
            self.assertTrue(summary["promotion_readiness"]["promotable"])
            self.assertEqual(promotion_readiness_file["candidate_id"], "port-1")

    def test_persist_run_outputs_surfaces_exact_replay_ledger_ranking(self) -> None:
        class RuntimeSummary:
            def to_payload(self) -> dict[str, object]:
                return {
                    "status": "pending_runtime_parity",
                    "next_required_steps": ["scheduler_v3_parity_replay"],
                    "promotion_prerequisites": {
                        "allowed": False,
                        "reasons": ["gate_report_missing"],
                    },
                    "rollback_readiness": {"ready": False},
                }

        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path, family_dir = self._write_program_fixture(root)
            program_payload = yaml.safe_load(program_path.read_text(encoding="utf-8"))
            program = load_strategy_autoresearch_program(
                program_path, family_dir=family_dir
            )
            run_root = root / "run"
            artifact_path = (
                run_root
                / "experiments"
                / "001-breakout-iter-1"
                / "frontier-artifacts"
                / "result"
                / "candidate-0001-exact-replay-ledger.json"
            )
            artifact_path.parent.mkdir(parents=True)
            artifact_path.write_text(
                json.dumps(
                    {
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
                        "candidate_id": "ledger-ranked-1",
                        "window_start": "2026-05-18",
                        "window_end": "2026-05-22",
                        "account_label": "TORGHUT_REPLAY",
                        "cost_basis": "local_replay_transaction_cost_model",
                        "execution_policy_hash": "policy-sha",
                        "cost_model_hash": "cost-sha",
                        "lineage_hash": "lineage-sha",
                        "promotion_authority": "replay_artifact_only_not_live",
                        "stage": "replay",
                        "source": "local_intraday_tsmom_replay",
                        "runtime_ledger_rows": [
                            {
                                "event_type": "decision",
                                "executed_at": "2026-05-18T14:30:00+00:00",
                                "decision_id": "buy-decision",
                                "symbol": "NVDA",
                            },
                            {
                                "event_type": "order_submitted",
                                "executed_at": "2026-05-18T14:31:00+00:00",
                                "decision_id": "buy-decision",
                                "order_id": "buy-order",
                                "symbol": "NVDA",
                            },
                            {
                                "event_type": "fill",
                                "executed_at": "2026-05-18T14:32:00+00:00",
                                "decision_id": "buy-decision",
                                "order_id": "buy-order",
                                "symbol": "NVDA",
                                "side": "buy",
                                "filled_qty": "10",
                                "avg_fill_price": "100",
                                "cost_amount": "1",
                            },
                            {
                                "event_type": "decision",
                                "executed_at": "2026-05-18T14:40:00+00:00",
                                "decision_id": "sell-decision",
                                "symbol": "NVDA",
                            },
                            {
                                "event_type": "order_submitted",
                                "executed_at": "2026-05-18T14:41:00+00:00",
                                "decision_id": "sell-decision",
                                "order_id": "sell-order",
                                "symbol": "NVDA",
                            },
                            {
                                "event_type": "fill",
                                "executed_at": "2026-05-18T14:42:00+00:00",
                                "decision_id": "sell-decision",
                                "order_id": "sell-order",
                                "symbol": "NVDA",
                                "side": "sell",
                                "filled_qty": "10",
                                "avg_fill_price": "130",
                                "cost_amount": "1",
                            },
                        ],
                    },
                    sort_keys=True,
                ),
                encoding="utf-8",
            )
            manifest = runner.MlxSnapshotManifest(
                snapshot_id="snap-1",
                created_at="2026-05-20T00:00:00+00:00",
                source_window_start="2026-05-01",
                source_window_end="2026-05-15",
                train_days=6,
                holdout_days=3,
                full_window_days=9,
                symbols=("NVDA",),
                bar_interval="1Sec",
                quote_quality_policy_id="quote-quality-v1",
                feature_set_id="torghut.mlx-autoresearch.v1",
                cross_sectional_feature_flags={},
                prior_day_feature_flags={},
                tape_freshness_receipts=(),
                row_counts={},
                tensor_bundle_paths={},
                manifest_hash="hash-1",
            )

            with (
                patch(
                    "scripts.run_strategy_autoresearch_loop._write_portfolio_outputs",
                    return_value=(None, {}),
                ),
                patch(
                    "scripts.run_strategy_autoresearch_loop.write_runtime_closure_bundle",
                    return_value=RuntimeSummary(),
                ),
                patch(
                    "scripts.run_strategy_autoresearch_loop.write_mlx_notebook_exports",
                    return_value={},
                ),
                patch(
                    "scripts.run_strategy_autoresearch_loop.write_autoresearch_notebooks",
                    return_value=[],
                ),
            ):
                summary = runner._persist_run_outputs(
                    run_root=run_root,
                    program=program,
                    program_payload=program_payload,
                    runner_run_id="strategy-autoresearch-test",
                    program_id=program.program_id,
                    frontier_runs=1,
                    objective_met=False,
                    history=[
                        {
                            "runner_run_id": "strategy-autoresearch-test",
                            "experiment_index": 1,
                            "iteration": 1,
                            "family_template_id": "microbar_cross_sectional_pairs_v1",
                            "candidate_id": "ledger-ranked-1",
                            "parent_candidate_id": None,
                            "status": "keep",
                            "objective_met": False,
                            "mutation_label": "seed",
                            "dataset_snapshot_id": "snapshot-exact",
                            "sweep_config_path": "sweep.yaml",
                            "result_path": "result.json",
                            "candidate_params": {},
                            "candidate_strategy_overrides": {},
                            "disable_other_strategies": True,
                            "train_start_date": "",
                            "train_end_date": "",
                            "holdout_start_date": "",
                            "holdout_end_date": "",
                            "full_window_start_date": "2026-05-18",
                            "full_window_end_date": "2026-05-22",
                            "normalization_regime": "",
                            "net_pnl_per_day": "59.6",
                            "deployable_lower_bound_net_pnl_per_day": "59.6",
                            "deployable_lower_bound_missing_count": 0,
                            "deployable_lower_bound_failed_gate_count": 0,
                            "active_day_ratio": "0.2",
                            "best_day_share": "1",
                            "max_drawdown": "0",
                            "hard_vetoes": [],
                            "pareto_tier": 1,
                            "runtime_family": "microbar_cross_sectional_pairs",
                            "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                            "exact_replay_ledger_artifact_ref": str(artifact_path),
                            "runtime_ledger_artifact_ref": str(artifact_path),
                            "exact_replay_ledger_artifact_row_count": "6",
                            "exact_replay_ledger_artifact_fill_count": "2",
                            "runtime_ledger_artifact_row_count": "6",
                            "runtime_ledger_artifact_fill_count": "2",
                        }
                    ],
                    manifest=manifest,
                    descriptors=[],
                    proposal_scores=[],
                    worklist=[],
                    status="ok",
                )

            ranking_path = Path(summary["exact_replay_ledger_ranking_path"])
            remediation_path = Path(summary["exact_replay_ledger_remediation_path"])
            ranking = json.loads(ranking_path.read_text(encoding="utf-8"))
            remediation = json.loads(remediation_path.read_text(encoding="utf-8"))

            self.assertEqual(ranking["candidate_count"], 1)
            self.assertEqual(ranking["failure_count"], 0)
            self.assertEqual(
                remediation["candidate_id"],
                "ledger-ranked-1",
            )
            self.assertFalse(remediation["promotion_allowed"])
            self.assertEqual(
                summary["exact_replay_ledger_remediation"]["candidate_id"],
                "ledger-ranked-1",
            )
            self.assertEqual(
                summary["live_progress"]["exact_replay_ledger_remediation"][
                    "candidate_id"
                ],
                "ledger-ranked-1",
            )
            self.assertEqual(
                summary["best_exact_replay_ledger_candidate"]["candidate_id"],
                "ledger-ranked-1",
            )
            self.assertEqual(
                summary["live_progress"]["best_exact_replay_ledger_candidate"][
                    "candidate_id"
                ],
                "ledger-ranked-1",
            )
            self.assertIn(
                "replay_artifact_only_not_live",
                summary["best_exact_replay_ledger_candidate"]["promotion_blockers"],
            )
            plan = summary["runtime_window_import_plan"]
            self.assertFalse(plan["promotion_allowed"])
            self.assertEqual(len(plan["targets"]), 1)
            target = plan["targets"][0]
            self.assertEqual(target["candidate_id"], "ledger-ranked-1")
            self.assertEqual(target["hypothesis_id"], "H-PAIRS-01")
            self.assertEqual(len(target["artifact_refs"]), 1)
            self.assertEqual(
                Path(target["artifact_refs"][0]).resolve(strict=False),
                artifact_path.resolve(strict=False),
            )
            self.assertEqual(
                target["runtime_ledger_artifact_row_count"],
                "6",
            )
            self.assertFalse(target["promotion_allowed"])
            self.assertFalse(target["final_promotion_authorized"])
            self.assertEqual(
                summary["candidate_board"]["runtime_window_import_plan"]["targets"][0][
                    "candidate_id"
                ],
                "ledger-ranked-1",
            )

    def test_exact_replay_ledger_paths_collects_refs_and_skips_bad_results(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            run_root = root / "run"
            experiment_root = run_root / "experiments" / "001-breakout"
            artifact_path = (
                experiment_root
                / "frontier-artifacts"
                / "result"
                / "candidate-0001-exact-replay-ledger.json"
            )
            artifact_path.parent.mkdir(parents=True)
            artifact_path.write_text("{}", encoding="utf-8")
            absolute_path = root / "absolute-exact-replay-ledger.json"
            relative_runtime_ref = "runtime-ledger.json"
            result_path = experiment_root / "result.json"
            result_path.write_text(
                json.dumps(
                    {
                        "top": [
                            {
                                "exact_replay_ledger_artifact_ref": str(artifact_path),
                                "exact_replay_ledger_artifact_refs": [
                                    str(absolute_path),
                                    "",
                                ],
                                "nested": {
                                    "runtime_ledger_artifact_ref": relative_runtime_ref,
                                    "runtime_ledger_artifact_refs": "scalar-runtime-ledger.json",
                                },
                            }
                        ],
                    },
                    sort_keys=True,
                ),
                encoding="utf-8",
            )
            bad_result_path = run_root / "experiments" / "bad" / "result.json"
            bad_result_path.parent.mkdir(parents=True)
            bad_result_path.write_text("{", encoding="utf-8")

            paths = runner._exact_replay_ledger_paths(run_root)

            self.assertEqual(
                paths,
                (
                    artifact_path,
                    absolute_path,
                    experiment_root / relative_runtime_ref,
                    experiment_root / "scalar-runtime-ledger.json",
                ),
            )

    def test_load_mutation_space_rejects_invalid_mode(self) -> None:
        with self.assertRaisesRegex(ValueError, "autoresearch_mutation_mode_invalid"):
            autoresearch._load_mutation_space({"mode": "bad-mode"})

    def test_resolve_seed_sweep_path_keeps_absolute_path(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            absolute = root / "seed.yaml"
            resolved = autoresearch._resolve_seed_sweep_path(
                program_path=root / "program.yaml",
                raw_path=str(absolute),
            )

        self.assertEqual(resolved, absolute)

    def test_parse_args_defaults_strategy_configmap_to_repo_root(self) -> None:
        with patch.object(
            sys,
            "argv",
            [
                "run_strategy_autoresearch_loop.py",
                "--program",
                "program.yaml",
                "--output-dir",
                "/tmp/out",
                "--materialize-replay-tape",
                "--replay-tape-path",
                "/tmp/tape.jsonl",
                "--replay-tape-manifest",
                "/tmp/tape.manifest.json",
            ],
        ):
            args = runner._parse_args()

        self.assertEqual(
            args.strategy_configmap,
            runner._REPO_ROOT / "argocd/applications/torghut/strategy-configmap.yaml",
        )
        self.assertIsNone(args.shadow_validation_artifact)
        self.assertTrue(args.materialize_replay_tape)
        self.assertEqual(args.replay_tape_path, Path("/tmp/tape.jsonl"))
        self.assertEqual(args.replay_tape_manifest, Path("/tmp/tape.manifest.json"))
        self.assertEqual(args.latest_complete_window_min_days, 0)
        self.assertIsNone(args.latest_complete_window_receipt_output)
        self.assertIsNone(args.coverage_diagnostic_output)
        self.assertEqual(args.min_executable_rows_per_symbol_day, 18000)
        self.assertEqual(args.min_quote_valid_ratio, "0.90")
        self.assertEqual(args.max_coverage_spread_bps, "50")
        self.assertEqual(args.max_executable_gap_seconds, 120)
        self.assertEqual(args.staged_train_screen_multiplier, 0)

    def test_parse_args_prefers_clickhouse_http_url_env(self) -> None:
        with (
            patch.dict(
                "os.environ",
                {
                    "TA_CLICKHOUSE_URL": "jdbc:clickhouse://clickhouse/torghut",
                    "CLICKHOUSE_HTTP_URL": "http://127.0.0.1:8123",
                    "TA_CLICKHOUSE_USERNAME": "reader",
                    "TA_CLICKHOUSE_PASSWORD": "reader-secret",
                },
            ),
            patch.object(
                sys,
                "argv",
                [
                    "run_strategy_autoresearch_loop.py",
                    "--program",
                    "program.yaml",
                    "--output-dir",
                    "/tmp/out",
                ],
            ),
        ):
            args = runner._parse_args()

        self.assertEqual(args.clickhouse_http_url, "http://127.0.0.1:8123")
        self.assertEqual(args.clickhouse_username, "reader")
        self.assertEqual(args.clickhouse_password, "reader-secret")

    def test_latest_complete_window_requirement_keeps_objective_as_floor(
        self,
    ) -> None:
        self.assertEqual(
            runner._latest_complete_window_requirement(
                Namespace(latest_complete_window_min_days=2),
                objective_min_observed_trading_days=20,
            ),
            runner.LatestCompleteWindowRequirement(
                min_days=20,
                source="objective_min_observed_trading_days_floor",
                cli_min_days=2,
                objective_min_days=20,
            ),
        )
        self.assertEqual(
            runner._latest_complete_window_requirement(
                Namespace(latest_complete_window_min_days=30),
                objective_min_observed_trading_days=20,
            ),
            runner.LatestCompleteWindowRequirement(
                min_days=30,
                source="cli",
                cli_min_days=30,
                objective_min_days=20,
            ),
        )
        self.assertEqual(
            runner._latest_complete_window_requirement(
                Namespace(latest_complete_window_min_days=0),
                objective_min_observed_trading_days=20,
            ),
            runner.LatestCompleteWindowRequirement(
                min_days=20,
                source="objective_min_observed_trading_days",
                cli_min_days=0,
                objective_min_days=20,
            ),
        )
        self.assertEqual(
            runner._latest_complete_window_requirement(
                Namespace(),
                objective_min_observed_trading_days=0,
            ),
            runner.LatestCompleteWindowRequirement(
                min_days=0,
                source="disabled",
                cli_min_days=0,
                objective_min_days=0,
            ),
        )

    def test_program_defaults_include_mlx_contract(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path, family_dir = self._write_program_fixture(root)

            program = load_strategy_autoresearch_program(
                program_path, family_dir=family_dir
            )

        self.assertEqual(
            program.snapshot_policy.feature_set_id, "torghut.mlx-autoresearch.v1"
        )
        self.assertTrue(program.proposal_model_policy.enabled)
        self.assertEqual(program.proposal_model_policy.mode, "ranking_only")
        self.assertEqual(program.promotion_policy, "research_only")
        self.assertIn("scheduler_v3_parity_replay", program.parity_requirements)
        self.assertFalse(program.runtime_closure_policy.enabled)
        self.assertEqual(program.runtime_closure_policy.parity_window, "full_window")
        self.assertEqual(program.runtime_closure_policy.approval_window, "holdout")
        self.assertEqual(program.replay_budget.max_candidates_per_frontier_run, 96)
        self.assertEqual(program.replay_budget.staged_train_screen_multiplier, 1)
        self.assertTrue(program.ledger_policy["append_only"])

    def test_frontier_args_forwards_second_oos_days(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path, family_dir = self._write_program_fixture(root)
            program_payload = yaml.safe_load(program_path.read_text(encoding="utf-8"))
            program_payload["replay_budget"] = {"staged_train_screen_multiplier": 3}
            program_path.write_text(
                yaml.safe_dump(program_payload, sort_keys=False), encoding="utf-8"
            )
            program = load_strategy_autoresearch_program(
                program_path, family_dir=family_dir
            )
            args = Namespace(
                strategy_configmap=root / "strategy-configmap.yaml",
                family_template_dir=family_dir,
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_equity="31590.02",
                chunk_minutes=10,
                symbols="",
                progress_log_seconds=30,
                train_days=6,
                holdout_days=3,
                second_oos_days=4,
                full_window_start_date="",
                full_window_end_date="",
                expected_last_trading_day="",
                allow_stale_tape=False,
                prefetch_full_window_rows=False,
                replay_tape_path=root / "tape.jsonl",
                replay_tape_manifest=root / "tape.manifest.json",
                max_candidates_per_frontier_run=0,
                staged_train_screen_multiplier=0,
            )

            frontier_args = runner._frontier_args(
                args=args,
                program=program,
                family_plan=program.families[0],
                sweep_config_path=root / "sweep.yaml",
                json_output_path=root / "result.json",
            )
            args.staged_train_screen_multiplier = 5
            override_frontier_args = runner._frontier_args(
                args=args,
                program=program,
                family_plan=program.families[0],
                sweep_config_path=root / "sweep.yaml",
                json_output_path=root / "override-result.json",
            )

        self.assertEqual(frontier_args.second_oos_days, 4)
        self.assertEqual(
            frontier_args.replay_tape_path, (root / "tape.jsonl").resolve()
        )
        self.assertEqual(
            frontier_args.replay_tape_manifest,
            (root / "tape.manifest.json").resolve(),
        )
        self.assertEqual(frontier_args.loss_repair_iterations, 1)
        self.assertEqual(frontier_args.loss_repair_candidates, 1)
        self.assertEqual(frontier_args.consistency_repair_iterations, 1)
        self.assertEqual(frontier_args.consistency_repair_candidates, 2)
        self.assertEqual(frontier_args.staged_train_screen_multiplier, 3)
        self.assertEqual(override_frontier_args.staged_train_screen_multiplier, 5)

    def test_frontier_staged_search_budget_expands_train_screen_only_stage(
        self,
    ) -> None:
        payload = frontier._staged_search_budget_payload(
            args=Namespace(train_screening=True, staged_train_screen_multiplier=3),
            candidate_budget=96,
            full_replay_candidates_started=12,
            train_screen_only_candidates=40,
        )

        self.assertTrue(payload["enabled"])
        self.assertEqual(payload["train_screen_candidate_budget"], 288)
        self.assertEqual(payload["full_replay_candidate_budget"], 96)
        self.assertEqual(payload["full_replay_candidates_started"], 12)
        self.assertEqual(payload["train_screen_only_candidates"], 40)

    def test_frontier_staged_search_budget_does_not_expand_without_train_screen(
        self,
    ) -> None:
        payload = frontier._staged_search_budget_payload(
            args=Namespace(train_screening=False, staged_train_screen_multiplier=3),
            candidate_budget=96,
        )

        self.assertFalse(payload["enabled"])
        self.assertEqual(payload["train_screen_candidate_budget"], 96)
        self.assertEqual(payload["full_replay_candidate_budget"], 96)

    def test_frontier_staged_search_budget_marks_unbounded_as_disabled(
        self,
    ) -> None:
        payload = frontier._staged_search_budget_payload(
            args=Namespace(train_screening=True, staged_train_screen_multiplier=3),
            candidate_budget=0,
        )

        self.assertFalse(payload["enabled"])
        self.assertEqual(payload["train_screen_candidate_budget"], 0)
        self.assertEqual(payload["full_replay_candidate_budget"], 0)

    def test_history_record_flattens_staged_search_metadata(self) -> None:
        record = runner._history_record(
            runner_run_id="run-1",
            experiment_index=1,
            family_plan=FamilyAutoresearchPlan(
                family_template=_family_template(),
                seed_sweep_config=Path("/tmp/example.yaml"),
                max_iterations=1,
                keep_top_candidates=1,
                frontier_top_n=1,
                force_keep_top_candidate_if_all_vetoed=True,
                symbol_prune_iterations=0,
                symbol_prune_candidates=1,
                symbol_prune_min_universe_size=2,
                loss_repair_iterations=0,
                loss_repair_candidates=1,
                consistency_repair_iterations=0,
                consistency_repair_candidates=2,
                parameter_mutations={},
                strategy_override_mutations={},
            ),
            iteration=1,
            mutation_label="seed",
            parent_candidate_id=None,
            sweep_config_path=Path("/tmp/sweep.yaml"),
            result_path=Path("/tmp/result.json"),
            candidate_payload={
                "candidate_id": "candidate-1",
                "hard_vetoes": [],
                "ranking": {"pareto_tier": 1, "tie_breaker_score": "10"},
                "objective_scorecard": {"net_pnl_per_day": "500"},
                "full_window": {},
                "replay_config": {},
                "staged_search": {
                    "stage": "full_replay",
                    "train_screen_multiplier": 3,
                    "full_replay_candidate_budget": 96,
                    "full_replay_candidates_started": 7,
                },
            },
            rank=1,
            status="keep",
            objective_met=False,
            dataset_snapshot_id="snap-1",
        )

        self.assertEqual(record["staged_search_stage"], "full_replay")
        self.assertEqual(record["staged_train_screen_multiplier"], 3)
        self.assertEqual(record["staged_full_replay_candidate_budget"], "96")
        self.assertEqual(record["staged_full_replay_candidates_started"], 7)

    def test_materialize_run_replay_tape_writes_bundle_and_receipt(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            configmap_path = root / "strategy-configmap.yaml"
            configmap_path.write_text("apiVersion: v1\nkind: ConfigMap\n")
            bundle_paths = runner._mlx_bundle_paths(root)
            args = Namespace(
                strategy_configmap=configmap_path,
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_equity="31590.02",
                chunk_minutes=10,
                progress_log_seconds=30,
                materialize_replay_tape=True,
                replay_tape_path=None,
            )
            signal_rows = [
                SignalEnvelope(
                    event_ts=datetime(2026, 3, 20, 13, 30, tzinfo=UTC),
                    symbol="AMAT",
                    seq=1,
                    source="ta",
                    timeframe="1Sec",
                    payload={"price": "180.10"},
                )
            ]

            with patch(
                "scripts.run_strategy_autoresearch_loop.replay_mod._iter_signal_rows",
                return_value=iter(signal_rows),
            ):
                stats, receipt = runner._maybe_materialize_run_replay_tape(
                    args=args,
                    runner_run_id="strategy-autoresearch-test",
                    snapshot_symbols=("AMAT",),
                    bundle_paths=bundle_paths,
                    full_window_start_date="2026-03-20",
                    full_window_end_date="2026-03-20",
                    existing_signal_bundle=None,
                )
            assert receipt is not None
            tape_exists = Path(receipt["tape_path"]).exists()
            manifest_exists = Path(receipt["manifest_path"]).exists()

        assert stats is not None
        self.assertEqual(stats.row_count, 1)
        self.assertEqual(receipt["status"], "materialized")
        self.assertEqual(receipt["row_count"], 1)
        self.assertTrue(tape_exists)
        self.assertTrue(manifest_exists)

    def test_write_signal_bundle_uses_supplied_replay_tape_without_clickhouse(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            configmap_path = root / "strategy-configmap.yaml"
            configmap_path.write_text("apiVersion: v1\nkind: ConfigMap\n")
            bundle_paths = runner._mlx_bundle_paths(root)
            tape_path = root / "provided-tape.jsonl"
            signal_row = SignalEnvelope(
                event_ts=datetime(2026, 3, 20, 13, 30, tzinfo=UTC),
                symbol="AMAT",
                seq=1,
                source="ta",
                timeframe="1Sec",
                payload={"price": "180.10"},
            )
            manifest = runner.materialize_signal_tape(
                rows=[signal_row],
                tape_path=tape_path,
                dataset_snapshot_ref="provided-snapshot",
                symbols=("AMAT",),
                start_date=date(2026, 3, 20),
                end_date=date(2026, 3, 20),
                source_query_digest="digest",
            )
            args = Namespace(
                strategy_configmap=configmap_path,
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_equity="31590.02",
                chunk_minutes=10,
                progress_log_seconds=30,
                replay_tape_path=tape_path,
                replay_tape_manifest=runner.default_manifest_path(tape_path),
                allow_stale_tape=False,
            )

            with patch(
                "scripts.run_strategy_autoresearch_loop.replay_mod._http_query",
                side_effect=AssertionError("clickhouse should not be queried"),
            ):
                stats = runner._maybe_write_signal_bundle(
                    args=args,
                    snapshot_symbols=("AMAT",),
                    bundle_paths=bundle_paths,
                    full_window_start_date="2026-03-20",
                    full_window_end_date="2026-03-20",
                    existing=None,
                )

        assert stats is not None
        self.assertEqual(stats.row_count, manifest.row_count)
        self.assertEqual(stats.symbol_count, 1)

    def test_materialize_run_replay_tape_selects_latest_complete_window(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            configmap_path = root / "strategy-configmap.yaml"
            configmap_path.write_text("apiVersion: v1\nkind: ConfigMap\n")
            bundle_paths = runner._mlx_bundle_paths(root)
            args = Namespace(
                strategy_configmap=configmap_path,
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_equity="31590.02",
                chunk_minutes=10,
                progress_log_seconds=30,
                materialize_replay_tape=True,
                replay_tape_path=None,
                allow_stale_tape=False,
                latest_complete_window_min_days=1,
                latest_complete_window_receipt_output=None,
                coverage_diagnostic_output=None,
            )
            signal_rows = [
                SignalEnvelope(
                    event_ts=datetime(2026, 3, 23, 13, 30, tzinfo=UTC),
                    symbol="AMAT",
                    seq=1,
                    source="ta",
                    timeframe="1Sec",
                    payload={"price": "180.10"},
                )
            ]
            latest_window_receipt = {
                "schema_version": "torghut.replay-latest-complete-window.v1",
                "requested_start_date": "2026-03-20",
                "requested_end_date": "2026-03-23",
                "effective_start_date": "2026-03-23",
                "effective_end_date": "2026-03-23",
                "selected_trading_days": ["2026-03-23"],
            }

            with (
                patch(
                    "scripts.run_strategy_autoresearch_loop._select_effective_replay_tape_window",
                    return_value=(
                        date(2026, 3, 23),
                        date(2026, 3, 23),
                        latest_window_receipt,
                    ),
                ) as select_window,
                patch(
                    "scripts.run_strategy_autoresearch_loop.replay_mod._iter_signal_rows",
                    return_value=iter(signal_rows),
                ),
            ):
                stats, receipt = runner._maybe_materialize_run_replay_tape(
                    args=args,
                    runner_run_id="strategy-autoresearch-test",
                    snapshot_symbols=("AMAT",),
                    bundle_paths=bundle_paths,
                    full_window_start_date="2026-03-20",
                    full_window_end_date="2026-03-23",
                    existing_signal_bundle=None,
                )

            select_kwargs = select_window.call_args.kwargs
            self.assertEqual(select_kwargs["requested_start_date"], date(2026, 3, 20))
            self.assertEqual(select_kwargs["requested_end_date"], date(2026, 3, 23))
            self.assertEqual(select_kwargs["symbols"], ("AMAT",))
            self.assertEqual(
                select_kwargs["args"].latest_complete_window_receipt_output,
                Path(bundle_paths["replay_tape_latest_complete_window_receipt_json"]),
            )
            self.assertEqual(
                select_kwargs["args"].coverage_diagnostic_output,
                Path(bundle_paths["replay_tape_coverage_diagnostics_json"]),
            )

        assert stats is not None
        assert receipt is not None
        self.assertEqual(stats.row_count, 1)
        self.assertEqual(receipt["requested_full_window_start_date"], "2026-03-20")
        self.assertEqual(receipt["requested_full_window_end_date"], "2026-03-23")
        self.assertEqual(receipt["effective_full_window_start_date"], "2026-03-23")
        self.assertEqual(receipt["effective_full_window_end_date"], "2026-03-23")
        self.assertEqual(receipt["latest_complete_window"], latest_window_receipt)
        self.assertEqual(receipt["row_count"], 1)

    def test_materialize_run_replay_tape_defaults_latest_window_to_objective(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            configmap_path = root / "strategy-configmap.yaml"
            configmap_path.write_text("apiVersion: v1\nkind: ConfigMap\n")
            bundle_paths = runner._mlx_bundle_paths(root)
            selected_days: list[date] = []
            current_day = date(2026, 3, 2)
            while current_day <= date(2026, 3, 27):
                if current_day.weekday() < 5:
                    selected_days.append(current_day)
                current_day += timedelta(days=1)
            self.assertEqual(len(selected_days), 20)
            args = Namespace(
                strategy_configmap=configmap_path,
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_equity="31590.02",
                chunk_minutes=10,
                progress_log_seconds=30,
                materialize_replay_tape=True,
                replay_tape_path=None,
                allow_stale_tape=False,
                latest_complete_window_min_days=0,
                latest_complete_window_receipt_output=None,
                coverage_diagnostic_output=None,
            )
            signal_rows = [
                SignalEnvelope(
                    event_ts=datetime(
                        trading_day.year,
                        trading_day.month,
                        trading_day.day,
                        13,
                        30,
                        tzinfo=UTC,
                    ),
                    symbol="AMAT",
                    seq=index,
                    source="ta",
                    timeframe="1Sec",
                    payload={"price": "180.10"},
                )
                for index, trading_day in enumerate(selected_days, start=1)
            ]
            latest_window_receipt = {
                "schema_version": "torghut.replay-latest-complete-window.v1",
                "requested_start_date": "2026-03-02",
                "requested_end_date": "2026-03-27",
                "effective_start_date": "2026-03-02",
                "effective_end_date": "2026-03-27",
                "selected_trading_days": [
                    trading_day.isoformat() for trading_day in selected_days
                ],
            }

            with (
                patch(
                    "scripts.run_strategy_autoresearch_loop._select_effective_replay_tape_window",
                    return_value=(
                        date(2026, 3, 2),
                        date(2026, 3, 27),
                        latest_window_receipt,
                    ),
                ) as select_window,
                patch(
                    "scripts.run_strategy_autoresearch_loop.replay_mod._iter_signal_rows",
                    return_value=iter(signal_rows),
                ),
            ):
                stats, receipt = runner._maybe_materialize_run_replay_tape(
                    args=args,
                    runner_run_id="strategy-autoresearch-test",
                    snapshot_symbols=("AMAT",),
                    bundle_paths=bundle_paths,
                    full_window_start_date="2026-03-02",
                    full_window_end_date="2026-03-27",
                    existing_signal_bundle=None,
                    objective_min_observed_trading_days=20,
                )

            select_kwargs = select_window.call_args.kwargs
            self.assertEqual(select_kwargs["args"].latest_complete_window_min_days, 20)

        assert stats is not None
        assert receipt is not None
        self.assertEqual(stats.row_count, 20)
        self.assertEqual(receipt["trading_day_count"], 20)
        self.assertEqual(receipt["objective_min_observed_trading_days"], 20)
        self.assertEqual(receipt["latest_complete_window_min_days"], 20)
        self.assertEqual(
            receipt["latest_complete_window_min_days_source"],
            "objective_min_observed_trading_days",
        )
        self.assertEqual(receipt["latest_complete_window_cli_min_days"], 0)
        self.assertEqual(receipt["latest_complete_window_objective_min_days"], 20)

    def test_materialize_run_replay_tape_does_not_let_cli_lower_objective_window(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            configmap_path = root / "strategy-configmap.yaml"
            configmap_path.write_text("apiVersion: v1\nkind: ConfigMap\n")
            bundle_paths = runner._mlx_bundle_paths(root)
            selected_days: list[date] = []
            current_day = date(2026, 3, 2)
            while current_day <= date(2026, 3, 27):
                if current_day.weekday() < 5:
                    selected_days.append(current_day)
                current_day += timedelta(days=1)
            self.assertEqual(len(selected_days), 20)
            args = Namespace(
                strategy_configmap=configmap_path,
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_equity="31590.02",
                chunk_minutes=10,
                progress_log_seconds=30,
                materialize_replay_tape=True,
                replay_tape_path=None,
                allow_stale_tape=False,
                latest_complete_window_min_days=2,
                latest_complete_window_receipt_output=None,
                coverage_diagnostic_output=None,
            )
            signal_rows = [
                SignalEnvelope(
                    event_ts=datetime(
                        trading_day.year,
                        trading_day.month,
                        trading_day.day,
                        13,
                        30,
                        tzinfo=UTC,
                    ),
                    symbol="AMAT",
                    seq=index,
                    source="ta",
                    timeframe="1Sec",
                    payload={"price": "180.10"},
                )
                for index, trading_day in enumerate(selected_days, start=1)
            ]
            latest_window_receipt = {
                "schema_version": "torghut.replay-latest-complete-window.v1",
                "requested_start_date": "2026-03-02",
                "requested_end_date": "2026-03-27",
                "effective_start_date": "2026-03-02",
                "effective_end_date": "2026-03-27",
                "selected_trading_days": [
                    trading_day.isoformat() for trading_day in selected_days
                ],
            }

            with (
                patch(
                    "scripts.run_strategy_autoresearch_loop._select_effective_replay_tape_window",
                    return_value=(
                        date(2026, 3, 2),
                        date(2026, 3, 27),
                        latest_window_receipt,
                    ),
                ) as select_window,
                patch(
                    "scripts.run_strategy_autoresearch_loop.replay_mod._iter_signal_rows",
                    return_value=iter(signal_rows),
                ),
            ):
                stats, receipt = runner._maybe_materialize_run_replay_tape(
                    args=args,
                    runner_run_id="strategy-autoresearch-test",
                    snapshot_symbols=("AMAT",),
                    bundle_paths=bundle_paths,
                    full_window_start_date="2026-03-02",
                    full_window_end_date="2026-03-27",
                    existing_signal_bundle=None,
                    objective_min_observed_trading_days=20,
                )

            select_kwargs = select_window.call_args.kwargs
            self.assertEqual(select_kwargs["args"].latest_complete_window_min_days, 20)

        assert stats is not None
        assert receipt is not None
        self.assertEqual(stats.row_count, 20)
        self.assertEqual(receipt["latest_complete_window_min_days"], 20)
        self.assertEqual(
            receipt["latest_complete_window_min_days_source"],
            "objective_min_observed_trading_days_floor",
        )
        self.assertEqual(receipt["latest_complete_window_cli_min_days"], 2)
        self.assertEqual(receipt["latest_complete_window_objective_min_days"], 20)

    def test_materialize_run_replay_tape_fails_closed_on_missing_days(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            configmap_path = root / "strategy-configmap.yaml"
            configmap_path.write_text("apiVersion: v1\nkind: ConfigMap\n")
            bundle_paths = runner._mlx_bundle_paths(root)
            args = Namespace(
                strategy_configmap=configmap_path,
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_equity="31590.02",
                chunk_minutes=10,
                progress_log_seconds=30,
                materialize_replay_tape=True,
                replay_tape_path=None,
                allow_stale_tape=False,
            )
            signal_rows = [
                SignalEnvelope(
                    event_ts=datetime(2026, 3, 20, 13, 30, tzinfo=UTC),
                    symbol="AMAT",
                    seq=1,
                    source="ta",
                    timeframe="1Sec",
                    payload={"price": "180.10"},
                )
            ]

            with patch(
                "scripts.run_strategy_autoresearch_loop.replay_mod._iter_signal_rows",
                return_value=iter(signal_rows),
            ):
                with self.assertRaisesRegex(
                    ValueError,
                    "replay_tape_incomplete_coverage:missing_days=2026-03-23",
                ):
                    runner._maybe_materialize_run_replay_tape(
                        args=args,
                        runner_run_id="strategy-autoresearch-test",
                        snapshot_symbols=("AMAT",),
                        bundle_paths=bundle_paths,
                        full_window_start_date="2026-03-20",
                        full_window_end_date="2026-03-23",
                        existing_signal_bundle=None,
                    )

            self.assertFalse(Path(bundle_paths["replay_tape_jsonl"]).exists())
            self.assertFalse(Path(bundle_paths["replay_tape_manifest_json"]).exists())

    def test_provided_replay_tape_receipt_reads_manifest_and_handles_missing(
        self,
    ) -> None:
        signal_row = SignalEnvelope(
            event_ts=datetime(2026, 3, 20, 13, 30, tzinfo=UTC),
            symbol="AMAT",
            seq=1,
            source="ta",
            timeframe="1Sec",
            payload={"price": "180.10"},
        )
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            tape_path = root / "provided-tape.jsonl"
            missing_tape_path = root / "missing-tape.jsonl"
            manifest = runner.materialize_signal_tape(
                rows=[signal_row],
                tape_path=tape_path,
                dataset_snapshot_ref="provided-snapshot",
                symbols=("AMAT",),
                start_date=date(2026, 3, 20),
                end_date=date(2026, 3, 20),
                source_query_digest="digest",
            )

            missing_receipt = runner._provided_replay_tape_receipt(
                tape_path=missing_tape_path, manifest_path=None
            )
            receipt = runner._provided_replay_tape_receipt(
                tape_path=tape_path, manifest_path=None
            )

        self.assertIsNone(missing_receipt)
        assert receipt is not None
        self.assertEqual(receipt["status"], "provided")
        self.assertEqual(receipt["row_count"], manifest.row_count)
        self.assertEqual(receipt["dataset_snapshot_ref"], "provided-snapshot")

    def test_materialize_run_replay_tape_skips_when_supplied_or_unresolved(
        self,
    ) -> None:
        existing_stats = runner.MlxSignalBundleStats(
            path="/tmp/existing.jsonl",
            row_count=7,
            symbol_count=1,
            first_event_ts="2026-03-20T13:30:00+00:00",
            last_event_ts="2026-03-20T13:31:00+00:00",
        )
        args = Namespace(
            materialize_replay_tape=True,
            replay_tape_path=Path("/tmp/provided-tape.jsonl"),
        )

        stats, receipt = runner._maybe_materialize_run_replay_tape(
            args=args,
            runner_run_id="strategy-autoresearch-test",
            snapshot_symbols=("AMAT",),
            bundle_paths={},
            full_window_start_date="2026-03-20",
            full_window_end_date="2026-03-20",
            existing_signal_bundle=existing_stats,
        )
        self.assertIs(stats, existing_stats)
        self.assertIsNone(receipt)

        args.replay_tape_path = None
        stats, receipt = runner._maybe_materialize_run_replay_tape(
            args=args,
            runner_run_id="strategy-autoresearch-test",
            snapshot_symbols=("AMAT",),
            bundle_paths={},
            full_window_start_date="",
            full_window_end_date="2026-03-20",
            existing_signal_bundle=existing_stats,
        )
        self.assertIs(stats, existing_stats)
        self.assertIsNone(receipt)

    def _write_program_fixture(self, root: Path) -> tuple[Path, Path]:
        family_dir = root / "families"
        family_dir.mkdir()
        (family_dir / "breakout_reclaim_v2.yaml").write_text(
            yaml.safe_dump(
                {
                    "schema_version": "torghut.family-template.v1",
                    "family_id": "breakout_reclaim_v2",
                    "economic_mechanism": "Breakout reclaim.",
                    "supported_markets": ["us_equities_intraday"],
                    "required_features": ["quote_quality"],
                    "allowed_normalizations": ["price_scaled", "opening_window_scaled"],
                    "entry_motifs": ["breakout_reclaim"],
                    "exit_motifs": ["trailing_stop"],
                    "risk_controls": ["stop_loss"],
                    "activity_model": {
                        "min_active_day_ratio": "0.50",
                        "min_daily_notional": "200000",
                    },
                    "liquidity_assumptions": {"max_spread_bps": "30"},
                    "regime_activation_rules": [],
                    "day_veto_rules": [],
                    "default_hard_vetoes": {"required_max_best_day_share": "0.45"},
                    "default_selection_objectives": {"target_net_pnl_per_day": "300"},
                    "runtime_harness": {
                        "family": "breakout_continuation_consistent",
                        "strategy_name": "breakout-continuation-long-v1",
                        "disable_other_strategies": True,
                    },
                },
                sort_keys=False,
            ),
            encoding="utf-8",
        )
        sweep_path = root / "profitability-frontier-consistent-breakout.yaml"
        sweep_path.write_text(
            yaml.safe_dump(
                {
                    "schema_version": "torghut.replay-frontier-sweep.v1",
                    "family": "breakout_continuation_consistent",
                    "family_template_id": "breakout_reclaim_v2",
                    "strategy_name": "breakout-continuation-long-v1",
                    "disable_other_strategies": True,
                    "constraints": {"holdout_target_net_per_day": "300"},
                    "consistency_constraints": {"target_net_per_day": "300"},
                    "strategy_overrides": {
                        "universe_symbols": [["AMAT", "NVDA"]],
                        "max_position_pct_equity": ["10.0"],
                    },
                    "parameters": {
                        "max_entries_per_session": ["2"],
                        "entry_cooldown_seconds": ["600"],
                    },
                },
                sort_keys=False,
            ),
            encoding="utf-8",
        )
        program_path = root / "program.yaml"
        program_path.write_text(
            yaml.safe_dump(
                {
                    "schema_version": "torghut.strategy-autoresearch.v1",
                    "program_id": "daily-profit",
                    "description": "Program fixture.",
                    "objective": {
                        "target_net_pnl_per_day": "500",
                        "min_active_day_ratio": "0.80",
                        "min_positive_day_ratio": "0.55",
                        "min_daily_notional": "300000",
                        "max_best_day_share": "0.35",
                        "max_worst_day_loss": "450",
                        "max_drawdown": "1000",
                        "min_regime_slice_pass_rate": "0.40",
                        "max_gross_exposure_pct_equity": "1.25",
                        "min_cash": "0",
                    },
                    "runtime_closure_policy": {
                        "enabled": False,
                        "execute_parity_replay": True,
                        "execute_approval_replay": True,
                        "parity_window": "full_window",
                        "approval_window": "holdout",
                        "shadow_validation_mode": "require_live_evidence",
                        "promotion_target": "shadow",
                    },
                    "research_sources": [
                        {
                            "source_id": "paper-1",
                            "title": "Paper 1",
                            "url": "https://example.com/paper-1",
                            "published_at": "2026-01-01",
                            "claims": [
                                {
                                    "claim_id": "claim-1",
                                    "summary": "Use realistic replay.",
                                    "implication": "Prefer day-level diagnostics.",
                                }
                            ],
                        }
                    ],
                    "families": [
                        {
                            "family_template_id": "breakout_reclaim_v2",
                            "seed_sweep_config": "./profitability-frontier-consistent-breakout.yaml",
                            "max_iterations": 2,
                            "keep_top_candidates": 1,
                            "frontier_top_n": 2,
                            "symbol_prune_iterations": 1,
                            "symbol_prune_candidates": 1,
                            "symbol_prune_min_universe_size": 2,
                            "loss_repair_iterations": 1,
                            "loss_repair_candidates": 1,
                            "consistency_repair_iterations": 1,
                            "consistency_repair_candidates": 2,
                            "parameter_mutations": {
                                "max_entries_per_session": {
                                    "mode": "numeric_step",
                                    "deltas": ["-1", "0", "1"],
                                    "minimum": "1",
                                    "maximum": "4",
                                }
                            },
                            "strategy_override_mutations": {
                                "normalization_regime": {
                                    "mode": "allowed_normalizations"
                                }
                            },
                        }
                    ],
                },
                sort_keys=False,
            ),
            encoding="utf-8",
        )
        return program_path, family_dir

    def test_load_program_and_apply_objective(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path, family_dir = self._write_program_fixture(root)

            program = load_strategy_autoresearch_program(
                program_path, family_dir=family_dir
            )
            self.assertEqual(program.program_id, "daily-profit")
            self.assertEqual(program.objective.target_net_pnl_per_day, Decimal("500"))
            self.assertEqual(
                program.objective.max_gross_exposure_pct_equity, Decimal("1.25")
            )
            self.assertEqual(program.objective.min_cash, Decimal("0"))
            self.assertEqual(
                program.families[0].family_template.family_id, "breakout_reclaim_v2"
            )
            self.assertEqual(
                program.families[0]
                .strategy_override_mutations["normalization_regime"]
                .mode,
                "allowed_normalizations",
            )

            sweep_payload = yaml.safe_load(
                (root / "profitability-frontier-consistent-breakout.yaml").read_text(
                    encoding="utf-8"
                )
            )
            updated = apply_program_objective(
                sweep_config=sweep_payload,
                objective=program.objective,
                holdout_day_count=3,
                full_window_day_count=9,
            )
            self.assertEqual(
                updated["constraints"]["holdout_target_net_per_day"], "500"
            )
            self.assertEqual(
                updated["consistency_constraints"]["min_daily_net_pnl"], "0"
            )
            self.assertEqual(
                updated["consistency_constraints"]["max_best_day_share_of_total_pnl"],
                "0.35",
            )
            self.assertEqual(
                updated["consistency_constraints"]["max_gross_exposure_pct_equity"],
                "1.25",
            )
            self.assertEqual(updated["consistency_constraints"]["min_cash"], "0")
            self.assertEqual(updated["consistency_constraints"]["min_active_days"], 8)

    def test_checked_in_300_daily_profit_program_targets_daily_net(self) -> None:
        program_path = Path(
            "config/trading/research-programs/strict-daily-profit-autoresearch-300-v1.yaml"
        )

        program = load_strategy_autoresearch_program(
            program_path,
            family_dir=Path("config/trading/families"),
        )

        self.assertEqual(program.program_id, "strict_daily_profit_autoresearch_300_v1")
        self.assertEqual(program.objective.target_net_pnl_per_day, Decimal("300"))
        self.assertEqual(program.objective.min_daily_net_pnl, Decimal("300"))
        self.assertEqual(program.objective.min_positive_day_ratio, Decimal("1.0"))
        self.assertEqual(program.objective.max_worst_day_loss, Decimal("0"))
        self.assertTrue(program.objective.require_every_day_active)
        self.assertEqual(program.runtime_closure_policy.promotion_target, "shadow")
        self.assertIn("scheduler_v3_parity_replay", program.parity_requirements)
        self.assertGreaterEqual(len(program.research_sources), 4)
        self.assertTrue(
            all(
                source.published_at.startswith(("2025", "2026"))
                for source in program.research_sources
            )
        )

    def test_checked_in_500_portfolio_profit_program_allows_bounded_down_days(
        self,
    ) -> None:
        program_path = Path(
            "config/trading/research-programs/portfolio-profit-autoresearch-500-v1.yaml"
        )

        program = load_strategy_autoresearch_program(
            program_path,
            family_dir=Path("config/trading/families"),
        )

        self.assertEqual(program.program_id, "portfolio_profit_autoresearch_500_v1")
        self.assertEqual(program.objective.target_net_pnl_per_day, Decimal("500"))
        self.assertEqual(program.objective.min_daily_net_pnl, Decimal("-999999999"))
        self.assertEqual(program.objective.min_active_day_ratio, Decimal("0.90"))
        self.assertEqual(program.objective.min_positive_day_ratio, Decimal("0.60"))
        self.assertEqual(program.objective.min_profit_factor, Decimal("1.50"))
        self.assertEqual(program.objective.max_worst_day_loss, Decimal("999999999"))
        self.assertEqual(program.objective.max_drawdown, Decimal("999999999"))
        self.assertEqual(
            program.objective.max_worst_day_loss_pct_equity, Decimal("0.05")
        )
        self.assertEqual(program.objective.max_drawdown_pct_equity, Decimal("0.08"))
        self.assertEqual(
            program.objective.extended_max_worst_day_loss_pct_equity,
            Decimal("0.08"),
        )
        self.assertEqual(
            program.objective.extended_max_drawdown_pct_equity, Decimal("0.12")
        )
        self.assertEqual(
            program.objective.min_total_net_pnl_to_drawdown_ratio, Decimal("3.00")
        )
        self.assertFalse(program.objective.require_every_day_active)
        self.assertEqual(
            program.objective.max_gross_exposure_pct_equity, Decimal("1.0")
        )
        self.assertEqual(program.objective.min_cash, Decimal("0"))
        self.assertEqual(program.objective.min_observed_trading_days, 20)
        self.assertEqual(program.replay_budget.staged_train_screen_multiplier, 3)

        policy = runner._portfolio_oracle_policy(program)
        self.assertEqual(policy.min_profit_factor, Decimal("1.50"))
        self.assertEqual(policy.max_worst_day_loss, Decimal("999999999"))
        self.assertEqual(policy.max_drawdown, Decimal("999999999"))
        self.assertEqual(policy.default_start_equity, Decimal("31590.02"))
        self.assertEqual(policy.max_worst_day_loss_pct_equity, Decimal("0.05"))
        self.assertEqual(policy.max_drawdown_pct_equity, Decimal("0.08"))
        self.assertEqual(policy.extended_max_worst_day_loss_pct_equity, Decimal("0.08"))
        self.assertEqual(policy.extended_max_drawdown_pct_equity, Decimal("0.12"))
        self.assertEqual(policy.min_total_net_pnl_to_drawdown_ratio, Decimal("3.00"))
        self.assertEqual(policy.max_gross_exposure_pct_equity, Decimal("1.0"))
        self.assertEqual(policy.min_cash, Decimal("0"))
        self.assertEqual(policy.min_observed_trading_days, 20)

    def test_checked_in_500_portfolio_profit_program_includes_reversal_surfaces(
        self,
    ) -> None:
        program_path = Path(
            "config/trading/research-programs/portfolio-profit-autoresearch-500-v1.yaml"
        )

        program = load_strategy_autoresearch_program(
            program_path,
            family_dir=Path("config/trading/families"),
        )

        source_ids = {source.source_id for source in program.research_sources}
        self.assertTrue(
            {
                "intraday_residual_reversal_2024",
                "intraday_return_autocorrelation_term_structure_2025",
                "intraday_time_series_reversal_2025",
                "end_of_day_reversal_2024",
                "overnight_jump_intraday_reversal_2026",
                "intraday_cross_section_patterns_2010",
                "attention_factors_stat_arb_2025",
                "asymmetric_ofi_hmm_regime_2025",
                "opening_range_breakout_stocks_in_play_2024",
                "realistic_market_impact_rl_envs_2026",
                "overreaction_intraday_momentum_aapl_2026",
                "vwap_regime_classification_intraday_2026",
                "intramonth_momentum_cycle_2026",
                "structural_limits_ohlcv_intraday_2026",
                "latent_microstructure_regime_detection_2026",
                "explainable_crypto_microstructure_patterns_2026",
                "unified_order_flow_impact_volatility_2026",
                "closing_auction_market_making_2026",
                "algorithmic_retail_options_intraday_2026",
                "learning_from_book_short_run_efficiency_2026",
                "idiosyncratic_trade_imbalance_2026",
                "intraday_price_asymmetry_sp500_2026",
                "market_depth_execution_delays_2026",
            }.issubset(source_ids)
        )
        impact_source = next(
            source
            for source in program.research_sources
            if source.source_id == "realistic_market_impact_rl_envs_2026"
        )
        self.assertEqual(impact_source.claims[0].claim_type, "feature_recipe")
        self.assertIn("route_tca", impact_source.claims[0].data_requirements)
        self.assertEqual(impact_source.claims[0].horizon_scope, "intraday_execution")
        depth_delay_source = next(
            source
            for source in program.research_sources
            if source.source_id == "market_depth_execution_delays_2026"
        )
        self.assertEqual(depth_delay_source.claims[0].claim_type, "feature_recipe")
        self.assertIn("market_depth", depth_delay_source.claims[0].data_requirements)
        self.assertIn("execution_delay", depth_delay_source.claims[0].data_requirements)
        self.assertEqual(
            depth_delay_source.claims[0].horizon_scope, "intraday_execution"
        )
        attention_factor_source = next(
            source
            for source in program.research_sources
            if source.source_id == "attention_factors_stat_arb_2025"
        )
        self.assertEqual(
            attention_factor_source.claims[0].claim_type, "signal_mechanism"
        )
        self.assertIn(
            "residual_portfolio_returns",
            attention_factor_source.claims[0].data_requirements,
        )
        self.assertIn(
            "runtime_ledger_profit_proof",
            attention_factor_source.claims[2].data_requirements,
        )

        microbar_seed_names = {
            plan.seed_sweep_config.name
            for plan in program.families
            if plan.family_template.family_id == "microbar_cross_sectional_pairs_v1"
        }
        self.assertTrue(
            {
                "profitability-frontier-strict-daily-microbar-eod-loser-reversal.yaml",
                "profitability-frontier-strict-daily-microbar-vwap-reversal.yaml",
                "profitability-frontier-strict-daily-microbar-prev-day-open60-short-top1.yaml",
                "profitability-frontier-strict-daily-microbar-recent15-reversal-short.yaml",
                "profitability-frontier-strict-daily-microbar-vwap-stretch-reversal-long-top4.yaml",
                "profitability-frontier-portfolio-coverage-microbar-overnight-gap-reversal.yaml",
                "profitability-frontier-portfolio-coverage-microbar-opening-prev-close-reversal.yaml",
                "profitability-frontier-portfolio-coverage-microbar-tug-of-war-reversal.yaml",
            }.issubset(microbar_seed_names)
        )
        coverage_seed_payloads = {
            plan.seed_sweep_config.name: yaml.safe_load(
                plan.seed_sweep_config.read_text(encoding="utf-8")
            )
            for plan in program.families
            if plan.seed_sweep_config.name.startswith(
                "profitability-frontier-portfolio-coverage-microbar-"
            )
        }
        self.assertEqual(
            {
                "overnight_gap_reversal",
                "opening_window_prev_close_reversal",
                "intraday_tug_of_war_reversal",
            },
            {
                payload["parameters"]["signal_motif"][0]
                for payload in coverage_seed_payloads.values()
            },
        )
        for payload in coverage_seed_payloads.values():
            self.assertFalse(
                payload["consistency_constraints"]["require_every_day_active"]
            )
            self.assertEqual(
                payload["parameters"]["gate_feature"],
                ["cross_section_positive_opening_window_return_from_prev_close_ratio"],
            )
            self.assertLessEqual(
                Decimal(payload["strategy_overrides"]["max_position_pct_equity"][0]),
                Decimal("1.0"),
            )
            self.assertLessEqual(
                Decimal(payload["strategy_overrides"]["max_notional_per_trade"][0]),
                Decimal("30000"),
            )
        self.assertEqual(program.promotion_policy, "research_only")
        self.assertIn("scheduler_v3_parity_replay", program.parity_requirements)

    def test_load_program_rejects_non_mapping_schema_and_missing_families(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path = root / "program.yaml"

            program_path.write_text("- item\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "autoresearch_program_not_mapping"):
                load_strategy_autoresearch_program(program_path, family_dir=root)

            program_path.write_text(
                yaml.safe_dump(
                    {"schema_version": "wrong", "families": []}, sort_keys=False
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                ValueError, "autoresearch_program_schema_invalid"
            ):
                load_strategy_autoresearch_program(program_path, family_dir=root)

            program_path.write_text(
                yaml.safe_dump(
                    {
                        "schema_version": "torghut.strategy-autoresearch.v1",
                        "program_id": "empty",
                        "description": "missing families",
                        "objective": {},
                        "families": [],
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                ValueError, "autoresearch_program_missing_families"
            ):
                load_strategy_autoresearch_program(program_path, family_dir=root)

    def test_load_program_rejects_invalid_runtime_closure_policy_values(self) -> None:
        invalid_cases = [
            (
                {"parity_window": "bad"},
                "autoresearch_runtime_closure_parity_window_invalid",
            ),
            (
                {"approval_window": "bad"},
                "autoresearch_runtime_closure_approval_window_invalid",
            ),
            (
                {"shadow_validation_mode": "bad"},
                "autoresearch_runtime_closure_shadow_validation_mode_invalid",
            ),
            (
                {"promotion_target": "bad"},
                "autoresearch_runtime_closure_promotion_target_invalid",
            ),
        ]

        for overrides, expected_error in invalid_cases:
            with self.subTest(overrides=overrides):
                with TemporaryDirectory() as tmpdir:
                    root = Path(tmpdir)
                    program_path, family_dir = self._write_program_fixture(root)
                    payload = yaml.safe_load(program_path.read_text(encoding="utf-8"))
                    payload["runtime_closure_policy"] = {
                        "enabled": False,
                        "execute_parity_replay": True,
                        "execute_approval_replay": True,
                        "parity_window": "full_window",
                        "approval_window": "holdout",
                        "shadow_validation_mode": "require_live_evidence",
                        "promotion_target": "shadow",
                    }
                    payload["runtime_closure_policy"].update(overrides)
                    program_path.write_text(
                        yaml.safe_dump(payload, sort_keys=False), encoding="utf-8"
                    )

                    with self.assertRaisesRegex(ValueError, expected_error):
                        load_strategy_autoresearch_program(
                            program_path, family_dir=family_dir
                        )

    def test_load_program_skips_invalid_source_and_claim_entries(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            family_dir = root / "families"
            family_dir.mkdir()
            (family_dir / "breakout_reclaim_v2.yaml").write_text(
                yaml.safe_dump(
                    {
                        "schema_version": "torghut.family-template.v1",
                        "family_id": "breakout_reclaim_v2",
                        "economic_mechanism": "Breakout reclaim.",
                        "supported_markets": ["us_equities_intraday"],
                        "required_features": ["quote_quality"],
                        "allowed_normalizations": ["price_scaled"],
                        "entry_motifs": ["breakout_reclaim"],
                        "exit_motifs": ["trailing_stop"],
                        "risk_controls": ["stop_loss"],
                        "activity_model": {
                            "min_active_day_ratio": "0.50",
                            "min_daily_notional": "200000",
                        },
                        "liquidity_assumptions": {"max_spread_bps": "30"},
                        "regime_activation_rules": [],
                        "day_veto_rules": [],
                        "default_hard_vetoes": {},
                        "default_selection_objectives": {},
                        "runtime_harness": {
                            "family": "breakout",
                            "strategy_name": "breakout-v1",
                        },
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
            sweep_path = root / "seed.yaml"
            sweep_path.write_text(
                "schema_version: torghut.replay-frontier-sweep.v1\n", encoding="utf-8"
            )
            program_path = root / "program.yaml"
            program_path.write_text(
                yaml.safe_dump(
                    {
                        "schema_version": "torghut.strategy-autoresearch.v1",
                        "program_id": "valid-ish",
                        "description": "fixture",
                        "objective": {},
                        "research_sources": [
                            "skip-me",
                            {
                                "source_id": "",
                                "title": "missing id",
                                "claims": [{"claim_id": "claim-ignored"}],
                            },
                            {
                                "source_id": "paper-1",
                                "title": "Paper 1",
                                "url": "https://example.com",
                                "published_at": "2026-01-01",
                                "claims": [
                                    "skip-claim",
                                    {"claim_id": "", "summary": "missing id"},
                                    {
                                        "claim_id": "claim-1",
                                        "summary": "ok",
                                        "implication": "use it",
                                    },
                                ],
                            },
                        ],
                        "families": [
                            "skip-family",
                            {
                                "family_template_id": "breakout_reclaim_v2",
                                "seed_sweep_config": str(sweep_path),
                            },
                        ],
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )

            program = load_strategy_autoresearch_program(
                program_path, family_dir=family_dir
            )

        self.assertEqual(len(program.research_sources), 1)
        self.assertEqual(program.research_sources[0].source_id, "paper-1")
        self.assertEqual(len(program.research_sources[0].claims), 1)
        self.assertEqual(program.research_sources[0].claims[0].claim_id, "claim-1")

    def test_apply_program_objective_skips_full_window_counts_when_unknown(
        self,
    ) -> None:
        updated = apply_program_objective(
            sweep_config={"constraints": {}, "consistency_constraints": {}},
            objective=StrategyObjective(
                target_net_pnl_per_day=Decimal("500"),
                min_active_day_ratio=Decimal("0.80"),
                min_positive_day_ratio=Decimal("0.55"),
                min_daily_notional=Decimal("300000"),
                max_best_day_share=Decimal("0.35"),
                max_worst_day_loss=Decimal("450"),
                max_drawdown=Decimal("1000"),
                require_every_day_active=False,
                min_regime_slice_pass_rate=Decimal("0.40"),
                stop_when_objective_met=False,
            ),
            holdout_day_count=3,
            full_window_day_count=None,
        )
        self.assertNotIn("min_active_days", updated["consistency_constraints"])
        self.assertNotIn("min_positive_days", updated["consistency_constraints"])

    def test_build_mutated_sweep_config_keeps_current_values_and_mutates_neighbors(
        self,
    ) -> None:
        family_plan = FamilyAutoresearchPlan(
            family_template=_family_template(),
            seed_sweep_config=Path("/tmp/example.yaml"),
            max_iterations=2,
            keep_top_candidates=1,
            frontier_top_n=2,
            force_keep_top_candidate_if_all_vetoed=True,
            symbol_prune_iterations=1,
            symbol_prune_candidates=1,
            symbol_prune_min_universe_size=2,
            loss_repair_iterations=1,
            loss_repair_candidates=1,
            consistency_repair_iterations=1,
            consistency_repair_candidates=2,
            parameter_mutations={
                "max_entries_per_session": MutationSpace(
                    mode="numeric_step",
                    deltas=(Decimal("-1"), Decimal("0"), Decimal("1")),
                    minimum=Decimal("1"),
                    maximum=Decimal("4"),
                )
            },
            strategy_override_mutations={
                "normalization_regime": MutationSpace(mode="allowed_normalizations")
            },
        )
        base_sweep = {
            "parameters": {
                "max_entries_per_session": ["2"],
                "entry_cooldown_seconds": ["600"],
            },
            "strategy_overrides": {
                "universe_symbols": [["AMAT", "NVDA"]],
                "max_position_pct_equity": ["10.0"],
            },
        }
        candidate = {
            "candidate_id": "candidate-1",
            "replay_config": {
                "params": {
                    "max_entries_per_session": "2",
                    "entry_cooldown_seconds": "600",
                },
                "strategy_overrides": {
                    "universe_symbols": ["AMAT", "NVDA"],
                    "max_position_pct_equity": "10.0",
                },
            },
        }

        mutated, description = build_mutated_sweep_config(
            base_sweep_config=base_sweep,
            candidate_payload=candidate,
            family_plan=family_plan,
        )

        self.assertEqual(mutated["parameters"]["entry_cooldown_seconds"], ["600"])
        self.assertEqual(
            mutated["parameters"]["max_entries_per_session"], ["2", "1", "3"]
        )
        self.assertEqual(
            mutated["strategy_overrides"]["universe_symbols"], [["AMAT", "NVDA"]]
        )
        self.assertEqual(
            mutated["strategy_overrides"]["normalization_regime"],
            ["price_scaled", "opening_window_scaled"],
        )
        self.assertIn("max_entries_per_session", description)

    def test_build_mutated_sweep_config_falls_back_when_mutation_values_are_filtered_out(
        self,
    ) -> None:
        family_plan = FamilyAutoresearchPlan(
            family_template=_family_template(),
            seed_sweep_config=Path("/tmp/example.yaml"),
            max_iterations=2,
            keep_top_candidates=1,
            frontier_top_n=2,
            force_keep_top_candidate_if_all_vetoed=True,
            symbol_prune_iterations=0,
            symbol_prune_candidates=1,
            symbol_prune_min_universe_size=2,
            loss_repair_iterations=0,
            loss_repair_candidates=1,
            consistency_repair_iterations=0,
            consistency_repair_candidates=2,
            parameter_mutations={
                "entry_cooldown_seconds": MutationSpace(
                    mode="numeric_step",
                    deltas=(Decimal("-1000"),),
                    minimum=Decimal("1"),
                    maximum=Decimal("1200"),
                ),
                "normalization_regime": MutationSpace(
                    mode="explicit_values",
                    values=("matched_filter",),
                ),
            },
            strategy_override_mutations={
                "max_position_pct_equity": MutationSpace(
                    mode="numeric_step",
                    deltas=(Decimal("100"),),
                    minimum=Decimal("0"),
                    maximum=Decimal("20"),
                )
            },
        )
        base_sweep = {
            "parameters": {
                "entry_cooldown_seconds": ["600"],
            },
            "strategy_overrides": {
                "max_position_pct_equity": ["10.0"],
            },
        }
        candidate = {
            "candidate_id": "candidate-2",
            "replay_config": {
                "params": {
                    "entry_cooldown_seconds": "600",
                },
                "strategy_overrides": {
                    "max_position_pct_equity": "10.0",
                },
            },
        }

        mutated, description = build_mutated_sweep_config(
            base_sweep_config=base_sweep,
            candidate_payload=candidate,
            family_plan=family_plan,
        )

        self.assertEqual(mutated["parameters"]["entry_cooldown_seconds"], ["600"])
        self.assertEqual(
            mutated["parameters"]["normalization_regime"], ["matched_filter"]
        )
        self.assertEqual(
            mutated["strategy_overrides"]["max_position_pct_equity"], ["10.0"]
        )
        self.assertIn("candidate-2", description)

    def test_candidate_meets_objective_respects_vetoes(self) -> None:
        objective = StrategyObjective(
            target_net_pnl_per_day=Decimal("500"),
            min_active_day_ratio=Decimal("0.80"),
            min_positive_day_ratio=Decimal("0.55"),
            min_daily_notional=Decimal("300000"),
            max_best_day_share=Decimal("0.35"),
            max_worst_day_loss=Decimal("450"),
            max_drawdown=Decimal("1000"),
            require_every_day_active=False,
            min_regime_slice_pass_rate=Decimal("0.40"),
            stop_when_objective_met=False,
            max_gross_exposure_pct_equity=Decimal("1.50"),
            min_cash=Decimal("0"),
        )
        candidate = {
            "hard_vetoes": [],
            "objective_scorecard": {
                "net_pnl_per_day": "600",
                "active_day_ratio": "0.80",
                "positive_day_ratio": "0.60",
                "avg_filled_notional_per_day": "350000",
                "best_day_share": "0.30",
                "worst_day_loss": "300",
                "max_drawdown": "900",
                "regime_slice_pass_rate": "0.45",
                "max_gross_exposure_pct_equity": "1.25",
                "min_cash": "2500",
            },
            "full_window": {"trading_day_count": 9, "active_days": 7},
        }
        self.assertTrue(candidate_meets_objective(candidate, objective=objective))
        over_levered = copy.deepcopy(candidate)
        over_levered["objective_scorecard"]["max_gross_exposure_pct_equity"] = "1.51"
        self.assertFalse(candidate_meets_objective(over_levered, objective=objective))
        negative_cash = copy.deepcopy(candidate)
        negative_cash["objective_scorecard"]["min_cash"] = "-0.01"
        self.assertFalse(candidate_meets_objective(negative_cash, objective=objective))
        vetoed = dict(candidate)
        vetoed["hard_vetoes"] = ["best_day_share_above_max"]
        self.assertFalse(candidate_meets_objective(vetoed, objective=objective))

    def test_candidate_meets_objective_allows_return_adjusted_drawdown(self) -> None:
        objective = StrategyObjective(
            target_net_pnl_per_day=Decimal("500"),
            min_active_day_ratio=Decimal("0.80"),
            min_positive_day_ratio=Decimal("0.60"),
            min_daily_notional=Decimal("300000"),
            max_best_day_share=Decimal("0.35"),
            max_worst_day_loss=Decimal("999999999"),
            max_drawdown=Decimal("999999999"),
            require_every_day_active=False,
            min_regime_slice_pass_rate=Decimal("0.40"),
            stop_when_objective_met=False,
            max_gross_exposure_pct_equity=Decimal("1.50"),
            min_cash=Decimal("0"),
        )
        candidate = {
            "hard_vetoes": [],
            "objective_scorecard": {
                "net_pnl_per_day": "9666.67",
                "active_day_ratio": "1",
                "positive_day_ratio": "0.67",
                "avg_filled_notional_per_day": "700000",
                "best_day_share": "0.30",
                "worst_day_loss": "2400",
                "max_drawdown": "3000",
                "regime_slice_pass_rate": "0.45",
                "max_gross_exposure_pct_equity": "1.25",
                "min_cash": "2500",
            },
            "full_window": {
                "trading_day_count": 3,
                "active_days": 3,
                "daily_net": {
                    "2026-04-01": "-2400",
                    "2026-04-02": "17000",
                    "2026-04-03": "15000",
                },
            },
        }

        self.assertTrue(candidate_meets_objective(candidate, objective=objective))

    def test_candidate_meets_objective_requires_daily_minimum_when_configured(
        self,
    ) -> None:
        objective = StrategyObjective(
            target_net_pnl_per_day=Decimal("300"),
            min_daily_net_pnl=Decimal("300"),
            min_active_day_ratio=Decimal("1.0"),
            min_positive_day_ratio=Decimal("1.0"),
            min_daily_notional=Decimal("300000"),
            max_best_day_share=Decimal("0.60"),
            max_worst_day_loss=Decimal("0"),
            max_drawdown=Decimal("0"),
            require_every_day_active=True,
            min_regime_slice_pass_rate=Decimal("0.40"),
            stop_when_objective_met=False,
        )
        candidate = {
            "hard_vetoes": [],
            "objective_scorecard": {
                "net_pnl_per_day": "500",
                "active_day_ratio": "1",
                "positive_day_ratio": "1",
                "avg_filled_notional_per_day": "350000",
                "best_day_share": "0.40",
                "worst_day_loss": "0",
                "max_drawdown": "0",
                "regime_slice_pass_rate": "0.45",
            },
            "full_window": {
                "trading_day_count": 3,
                "active_days": 3,
                "daily_net": {
                    "2026-04-01": "900",
                    "2026-04-02": "300",
                    "2026-04-03": "300",
                },
            },
        }
        self.assertTrue(candidate_meets_objective(candidate, objective=objective))

        weak_day = copy.deepcopy(candidate)
        weak_day["full_window"]["daily_net"]["2026-04-02"] = "299.99"
        self.assertFalse(candidate_meets_objective(weak_day, objective=objective))

    def test_candidate_meets_objective_requires_configured_observed_days(
        self,
    ) -> None:
        objective = StrategyObjective(
            target_net_pnl_per_day=Decimal("500"),
            min_active_day_ratio=Decimal("0.80"),
            min_positive_day_ratio=Decimal("0.55"),
            min_daily_notional=Decimal("300000"),
            max_best_day_share=Decimal("0.35"),
            max_worst_day_loss=Decimal("450"),
            max_drawdown=Decimal("1000"),
            require_every_day_active=False,
            min_regime_slice_pass_rate=Decimal("0.40"),
            stop_when_objective_met=False,
            min_observed_trading_days=20,
            max_gross_exposure_pct_equity=Decimal("1.50"),
            min_cash=Decimal("0"),
        )
        candidate = {
            "hard_vetoes": [],
            "objective_scorecard": {
                "net_pnl_per_day": "600",
                "active_day_ratio": "0.90",
                "positive_day_ratio": "0.60",
                "avg_filled_notional_per_day": "350000",
                "best_day_share": "0.30",
                "worst_day_loss": "300",
                "max_drawdown": "900",
                "regime_slice_pass_rate": "0.45",
                "max_gross_exposure_pct_equity": "1.25",
                "min_cash": "2500",
            },
            "full_window": {"trading_day_count": 4, "active_days": 4},
        }
        self.assertFalse(candidate_meets_objective(candidate, objective=objective))

        enough_days = copy.deepcopy(candidate)
        enough_days["full_window"]["trading_day_count"] = 20
        enough_days["full_window"]["active_days"] = 18
        self.assertTrue(candidate_meets_objective(enough_days, objective=objective))

    def test_write_autoresearch_notebooks_outputs_ipynb_files(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "summary.json").write_text(
                json.dumps(
                    {
                        "best_candidate": {"candidate_id": "c-1"},
                        "program_id": "program-1",
                        "promotion_readiness": {
                            "candidate_id": "c-1",
                            "status": "blocked_pending_runtime_parity",
                            "stage": "research_candidate",
                            "promotable": False,
                            "runtime_family": "breakout_continuation_consistent",
                            "runtime_strategy_name": "breakout-continuation-long-v1",
                            "reason": "research only",
                            "blockers": ["scheduler_v3_parity_missing"],
                        },
                    }
                ),
                encoding="utf-8",
            )
            (root / "research_dossier.json").write_text(
                json.dumps(
                    {
                        "program_id": "program-1",
                        "objective": {"target_net_pnl_per_day": "500"},
                        "research_sources": [],
                        "families": [],
                    }
                ),
                encoding="utf-8",
            )
            (root / "history.jsonl").write_text(
                json.dumps(
                    {
                        "experiment_index": 1,
                        "iteration": 1,
                        "family_template_id": "breakout_reclaim_v2",
                        "candidate_id": "c-1",
                        "status": "keep",
                        "net_pnl_per_day": "600",
                        "active_day_ratio": "0.80",
                        "positive_day_ratio": "0.60",
                        "avg_filled_notional_per_day": "300000",
                        "best_day_share": "0.30",
                        "max_drawdown": "900",
                        "pareto_tier": 1,
                        "mutation_label": "seed",
                        "hard_vetoes": [],
                        "daily_net": {"2026-04-01": "600"},
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            (root / "results.tsv").write_text("header\n", encoding="utf-8")

            history_nb, dossier_nb, mlx_nb = write_autoresearch_notebooks(root)
            self.assertTrue(history_nb.exists())
            self.assertTrue(dossier_nb.exists())
            self.assertTrue(mlx_nb.exists())
            payload = json.loads(history_nb.read_text(encoding="utf-8"))
            self.assertEqual(payload["nbformat"], 4)
            joined_source = "".join(payload["cells"][1]["source"])
            self.assertIn(str(root), joined_source)
            self.assertIn("except ModuleNotFoundError", joined_source)
            all_sources = "\n".join(
                "".join(cell.get("source", [])) for cell in payload["cells"]
            )
            self.assertIn("Live Experiment Snapshots", all_sources)
            self.assertIn("Promotion Guardrail", all_sources)
            self.assertIn("research candidates only", all_sources)
            mlx_payload = json.loads(mlx_nb.read_text(encoding="utf-8"))
            mlx_sources = "\n".join(
                "".join(cell.get("source", [])) for cell in mlx_payload["cells"]
            )
            self.assertIn("MLX Autoresearch Diagnostics", mlx_sources)
            self.assertIn("Scheduler-v3 replay remains the authority", mlx_sources)

    def test_generated_history_notebook_avoids_hard_pandas_dependency(self) -> None:
        payload = build_strategy_discovery_history_notebook(Path("/tmp/example-run"))
        joined_source = "\n".join(
            "".join(cell.get("source", []))
            for cell in payload["cells"]
            if cell.get("cell_type") == "code"
        )
        self.assertIn("except ModuleNotFoundError", joined_source)
        self.assertNotIn("sources_df = pd.DataFrame", joined_source)

    def test_write_strategy_factory_notebooks_outputs_ipynb_files(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "summary.json").write_text(
                json.dumps(
                    {
                        "runner_run_id": "factory-1",
                        "status": "ok",
                        "best_candidate": {"candidate_id": "cand-1"},
                    }
                ),
                encoding="utf-8",
            )
            (root / "research_dossier.json").write_text(
                json.dumps(
                    {
                        "runner_run_id": "factory-1",
                        "objective": {"mode": "strategy_factory_v2"},
                        "source_experiments": [],
                        "families": [],
                        "dataset_snapshots": [],
                    }
                ),
                encoding="utf-8",
            )
            (root / "history.jsonl").write_text(
                json.dumps(
                    {
                        "experiment_id": "exp-1",
                        "source_run_id": "paper-1",
                        "family_template_id": "breakout_reclaim_v2",
                        "candidate_id": "cand-1",
                        "status": "keep",
                        "net_pnl_per_day": "600",
                        "active_day_ratio": "0.80",
                        "best_day_share": "0.30",
                        "max_drawdown": "900",
                        "pareto_tier": 1,
                        "hard_vetoes": [],
                        "decomposition": {"symbols": {"NVDA": {"net_pnl": "600"}}},
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            (root / "results.tsv").write_text("header\n", encoding="utf-8")

            history_nb, dossier_nb = write_strategy_factory_notebooks(root)
            self.assertTrue(history_nb.exists())
            self.assertTrue(dossier_nb.exists())
            payload = json.loads(history_nb.read_text(encoding="utf-8"))
            self.assertEqual(payload["nbformat"], 4)
            joined_source = "\n".join(
                "".join(cell.get("source", []))
                for cell in payload["cells"]
                if cell.get("cell_type") == "code"
            )
            self.assertIn("Best Candidate Decomposition", joined_source)

    def test_generated_strategy_factory_history_notebook_avoids_hard_pandas_dependency(
        self,
    ) -> None:
        payload = build_strategy_factory_history_notebook(Path("/tmp/factory-run"))
        joined_source = "\n".join(
            "".join(cell.get("source", []))
            for cell in payload["cells"]
            if cell.get("cell_type") == "code"
        )
        self.assertIn("except ModuleNotFoundError", joined_source)

    def test_run_strategy_autoresearch_loop_writes_history_results_and_notebooks(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path, family_dir = self._write_program_fixture(root)
            configmap_path = root / "strategy-configmap.yaml"
            configmap_path.write_text(
                yaml.safe_dump(
                    {
                        "apiVersion": "v1",
                        "kind": "ConfigMap",
                        "data": {"strategies.yaml": "strategies: []\n"},
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
            output_dir = root / "out"

            responses = [
                {
                    "dataset_snapshot_receipt": {"snapshot_id": "snap-1"},
                    "window": {
                        "full_window_start_date": "2026-03-20",
                        "full_window_end_date": "2026-04-09",
                    },
                    "top": [
                        {
                            "candidate_id": "seed-1",
                            "hard_vetoes": [],
                            "ranking": {
                                "pareto_tier": 1,
                                "tie_breaker_score": "10",
                                "vetoed": False,
                            },
                            "objective_scorecard": {
                                "net_pnl_per_day": "450",
                                "active_day_ratio": "0.70",
                                "positive_day_ratio": "0.55",
                                "avg_filled_notional_per_day": "290000",
                                "avg_filled_notional_per_active_day": "360000",
                                "best_day_share": "0.40",
                                "worst_day_loss": "350",
                                "max_drawdown": "900",
                                "regime_slice_pass_rate": "0.45",
                                "market_impact_stress_passed": True,
                                "market_impact_stress_net_pnl_per_day": "430",
                                "delay_adjusted_depth_stress_passed": True,
                                "delay_adjusted_depth_stress_net_pnl_per_day": "420",
                                "delay_adjusted_depth_fill_survival_evidence_present": True,
                                "delay_adjusted_depth_fill_survival_sample_count": 6,
                                "delay_adjusted_depth_fill_survival_rate": "0.85",
                                "queue_position_survival_fill_curve_evidence_present": True,
                                "queue_position_survival_sample_count": 6,
                                "queue_position_survival_fill_rate": "0.85",
                                "queue_position_survival_queue_ratio_p95": "0.25",
                                "queue_position_survival_queue_ahead_depletion_evidence_present": True,
                                "queue_position_survival_queue_ahead_depletion_sample_count": 6,
                                "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
                                "delay_adjusted_depth_queue_ahead_depletion_sample_count": 6,
                                "queue_ahead_depletion_evidence_present": True,
                                "queue_ahead_depletion_sample_count": 6,
                                "post_cost_net_pnl_after_queue_position_survival_fill_stress": "420",
                                "double_oos_passed": True,
                                "double_oos_cost_shock_net_pnl_per_day": "410",
                                "implementation_uncertainty_stability_passed": True,
                                "implementation_uncertainty_lower_net_pnl_per_day": "405",
                                "conformal_tail_risk_passed": True,
                                "conformal_tail_risk_adjusted_net_pnl_per_day": "405",
                            },
                            "full_window": {
                                "net_per_day": "450",
                                "trading_day_count": 9,
                                "active_days": 6,
                                "daily_net": {"2026-04-01": "450"},
                                "daily_filled_notional": {"2026-04-01": "290000"},
                            },
                            "replay_config": {
                                "params": {
                                    "max_entries_per_session": "2",
                                    "entry_cooldown_seconds": "600",
                                },
                                "strategy_overrides": {
                                    "universe_symbols": ["AMAT", "NVDA"]
                                },
                            },
                        }
                    ],
                },
                {
                    "dataset_snapshot_receipt": {"snapshot_id": "snap-2"},
                    "window": {
                        "full_window_start_date": "2026-03-20",
                        "full_window_end_date": "2026-04-09",
                    },
                    "top": [
                        {
                            "candidate_id": "mutated-1",
                            "hard_vetoes": [],
                            "ranking": {
                                "pareto_tier": 1,
                                "tie_breaker_score": "11",
                                "vetoed": False,
                            },
                            "objective_scorecard": {
                                "net_pnl_per_day": "620",
                                "active_day_ratio": "0.85",
                                "positive_day_ratio": "0.60",
                                "avg_filled_notional_per_day": "340000",
                                "avg_filled_notional_per_active_day": "400000",
                                "best_day_share": "0.30",
                                "worst_day_loss": "300",
                                "max_drawdown": "850",
                                "regime_slice_pass_rate": "0.50",
                                "market_impact_stress_passed": True,
                                "market_impact_stress_net_pnl_per_day": "600",
                                "delay_adjusted_depth_stress_passed": True,
                                "delay_adjusted_depth_stress_net_pnl_per_day": "590",
                                "delay_adjusted_depth_fill_survival_evidence_present": True,
                                "delay_adjusted_depth_fill_survival_sample_count": 8,
                                "delay_adjusted_depth_fill_survival_rate": "0.85",
                                "queue_position_survival_fill_curve_evidence_present": True,
                                "queue_position_survival_sample_count": 8,
                                "queue_position_survival_fill_rate": "0.85",
                                "queue_position_survival_queue_ratio_p95": "0.25",
                                "queue_position_survival_queue_ahead_depletion_evidence_present": True,
                                "queue_position_survival_queue_ahead_depletion_sample_count": 8,
                                "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
                                "delay_adjusted_depth_queue_ahead_depletion_sample_count": 8,
                                "queue_ahead_depletion_evidence_present": True,
                                "queue_ahead_depletion_sample_count": 8,
                                "post_cost_net_pnl_after_queue_position_survival_fill_stress": "590",
                                "double_oos_passed": True,
                                "double_oos_cost_shock_net_pnl_per_day": "580",
                                "implementation_uncertainty_stability_passed": True,
                                "implementation_uncertainty_lower_net_pnl_per_day": "570",
                                "conformal_tail_risk_passed": True,
                                "conformal_tail_risk_adjusted_net_pnl_per_day": "570",
                            },
                            "full_window": {
                                "net_per_day": "620",
                                "trading_day_count": 9,
                                "active_days": 8,
                                "daily_net": {"2026-04-02": "620"},
                                "daily_filled_notional": {"2026-04-02": "340000"},
                            },
                            "replay_config": {
                                "params": {
                                    "max_entries_per_session": "1",
                                    "entry_cooldown_seconds": "600",
                                },
                                "strategy_overrides": {
                                    "universe_symbols": ["AMAT", "NVDA"]
                                },
                            },
                        }
                    ],
                },
            ]
            signal_rows = [
                SignalEnvelope(
                    event_ts=datetime(2026, 3, 20, 13, 30, tzinfo=UTC),
                    symbol="AMAT",
                    seq=1,
                    source="ta",
                    timeframe="1Sec",
                    payload={"price": "180.10"},
                ),
                SignalEnvelope(
                    event_ts=datetime(2026, 3, 20, 13, 31, tzinfo=UTC),
                    symbol="NVDA",
                    seq=2,
                    source="ta",
                    timeframe="1Sec",
                    payload={"price": "900.10"},
                ),
            ]

            args = Namespace(
                program=program_path,
                output_dir=output_dir,
                strategy_configmap=configmap_path,
                family_template_dir=family_dir,
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_equity="31590.02",
                chunk_minutes=10,
                symbols="",
                progress_log_seconds=30,
                shadow_validation_artifact=None,
                train_days=6,
                holdout_days=3,
                full_window_start_date="2026-03-20",
                full_window_end_date="2026-03-20",
                expected_last_trading_day="",
                allow_stale_tape=False,
                prefetch_full_window_rows=False,
                replay_tape_path=None,
                replay_tape_manifest=None,
                materialize_replay_tape=True,
                max_frontier_runs=0,
                json_output=None,
            )

            with (
                patch(
                    "scripts.run_strategy_autoresearch_loop.run_consistent_profitability_frontier",
                    side_effect=responses,
                ),
                patch(
                    "scripts.run_strategy_autoresearch_loop.replay_mod._iter_signal_rows",
                    return_value=iter(signal_rows),
                ),
            ):
                payload = runner.run_strategy_autoresearch_loop(args)

            self.assertEqual(payload["status"], "ok")
            self.assertEqual(payload["frontier_run_count"], 2)
            self.assertTrue(payload["objective_met"])
            run_root = Path(payload["run_root"])
            self.assertTrue((run_root / "history.jsonl").exists())
            self.assertTrue((run_root / "results.tsv").exists())
            self.assertTrue((run_root / "strategy-discovery-history.ipynb").exists())
            self.assertTrue((run_root / "mlx-autoresearch-diagnostics.ipynb").exists())
            self.assertTrue((run_root / "promotion_readiness.json").exists())
            self.assertTrue((run_root / "mlx-snapshot-manifest.json").exists())
            self.assertTrue((run_root / "mlx-snapshot-signals.jsonl").exists())
            self.assertTrue((run_root / "replay-tape.jsonl").exists())
            self.assertTrue((run_root / "replay-tape.jsonl.manifest.json").exists())
            self.assertTrue((run_root / "mlx-candidate-descriptors.jsonl").exists())
            self.assertTrue((run_root / "mlx-proposal-scores.jsonl").exists())
            summary = json.loads(
                (run_root / "summary.json").read_text(encoding="utf-8")
            )
            self.assertEqual(summary["best_candidate"]["candidate_id"], "mutated-1")
            self.assertEqual(summary["objective_scope"], "research_only")
            self.assertFalse(summary["promotion_readiness"]["promotable"])
            self.assertEqual(
                summary["promotion_readiness"]["stage"], "research_candidate"
            )
            self.assertIn(
                "scheduler_v3_parity_missing",
                summary["promotion_readiness"]["blockers"],
            )
            self.assertEqual(
                summary["best_candidate"]["promotion_status"],
                "blocked_pending_runtime_parity",
            )
            self.assertEqual(
                summary["best_candidate"]["runtime_strategy_name"],
                "breakout-continuation-long-v1",
            )
            self.assertIn("mlx_exports", summary)
            self.assertIn("snapshot_manifest_path", summary)
            self.assertIn("runtime_closure", summary)
            self.assertIn("live_progress", summary)
            self.assertEqual(summary["live_progress"]["frontier_runs_started"], 2)
            self.assertGreaterEqual(summary["live_progress"]["proposal_score_count"], 2)
            self.assertEqual(
                summary["live_progress"]["best_experiment_candidate"][
                    "top_candidate_id"
                ],
                "mutated-1",
            )
            self.assertIn("descriptor_id", summary["best_candidate"])
            self.assertIn("proposal_score", summary["best_candidate"])
            self.assertEqual(
                summary["best_candidate"]["candidate_params"],
                {"max_entries_per_session": "1", "entry_cooldown_seconds": "600"},
            )
            self.assertEqual(
                summary["best_candidate"]["candidate_strategy_overrides"],
                {"universe_symbols": ["AMAT", "NVDA"]},
            )
            self.assertEqual(
                summary["runtime_closure"]["status"], "pending_runtime_parity"
            )
            self.assertFalse(
                summary["runtime_closure"]["promotion_prerequisites"]["allowed"]
            )
            self.assertFalse(summary["runtime_closure"]["rollback_readiness"]["ready"])
            mlx_notebook = (run_root / "mlx-autoresearch-diagnostics.ipynb").read_text(
                encoding="utf-8"
            )
            self.assertIn("Runtime closure evidence", mlx_notebook)
            self.assertIn("RUNTIME_SHADOW_VALIDATION", mlx_notebook)
            self.assertTrue((run_root / "runtime-closure" / "summary.json").exists())
            self.assertTrue(
                (
                    run_root
                    / "runtime-closure"
                    / "promotion"
                    / "promotion-prerequisites.json"
                ).exists()
            )
            manifest = json.loads(
                (run_root / "mlx-snapshot-manifest.json").read_text(encoding="utf-8")
            )
            self.assertEqual(manifest["symbols"], ["AMAT", "NVDA"])
            self.assertEqual(manifest["row_counts"]["signal_row_count"], 2)
            self.assertEqual(
                manifest["tape_freshness_receipts"][0]["status"],
                "materialized",
            )
            self.assertEqual(
                manifest["tape_freshness_receipts"][0]["row_count"],
                2,
            )
            self.assertEqual(
                manifest["tensor_bundle_paths"]["signal_rows_jsonl"],
                str(run_root / "mlx-snapshot-signals.jsonl"),
            )
            promotion_readiness = json.loads(
                (run_root / "promotion_readiness.json").read_text(encoding="utf-8")
            )
            self.assertEqual(promotion_readiness["candidate_id"], "mutated-1")
            self.assertFalse(promotion_readiness["promotable"])

    def test_run_strategy_autoresearch_loop_forwards_selected_replay_window(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path, family_dir = self._write_program_fixture(root)
            program_payload = yaml.safe_load(program_path.read_text(encoding="utf-8"))
            program_payload["objective"]["min_observed_trading_days"] = 1
            program_path.write_text(
                yaml.safe_dump(program_payload, sort_keys=False),
                encoding="utf-8",
            )
            configmap_path = root / "strategy-configmap.yaml"
            configmap_path.write_text(
                yaml.safe_dump(
                    {
                        "apiVersion": "v1",
                        "kind": "ConfigMap",
                        "data": {"strategies.yaml": "strategies: []\n"},
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
            output_dir = root / "out"
            response = {
                "dataset_snapshot_receipt": {"snapshot_id": "snap-selected"},
                "window": {
                    "full_window_start_date": "2026-03-23",
                    "full_window_end_date": "2026-03-23",
                },
                "top": [],
            }
            signal_rows = [
                SignalEnvelope(
                    event_ts=datetime(2026, 3, 23, 13, 30, tzinfo=UTC),
                    symbol="AMAT",
                    seq=1,
                    source="ta",
                    timeframe="1Sec",
                    payload={"price": "180.10"},
                ),
                SignalEnvelope(
                    event_ts=datetime(2026, 3, 23, 13, 31, tzinfo=UTC),
                    symbol="NVDA",
                    seq=2,
                    source="ta",
                    timeframe="1Sec",
                    payload={"price": "900.10"},
                ),
            ]
            selected_receipt = {
                "schema_version": "torghut.replay-latest-complete-window.v1",
                "status": "selected",
                "selected_trading_days": ["2026-03-23"],
            }
            args = Namespace(
                program=program_path,
                output_dir=output_dir,
                strategy_configmap=configmap_path,
                family_template_dir=family_dir,
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_equity="31590.02",
                chunk_minutes=10,
                symbols="",
                progress_log_seconds=30,
                shadow_validation_artifact=None,
                train_days=1,
                holdout_days=1,
                full_window_start_date="2026-03-20",
                full_window_end_date="2026-03-24",
                expected_last_trading_day="",
                allow_stale_tape=False,
                prefetch_full_window_rows=False,
                replay_tape_path=None,
                replay_tape_manifest=None,
                materialize_replay_tape=True,
                latest_complete_window_min_days=0,
                latest_complete_window_receipt_output=None,
                coverage_diagnostic_output=None,
                min_executable_rows_per_symbol_day=10,
                min_quote_valid_ratio="0.90",
                max_coverage_spread_bps="50",
                max_executable_gap_seconds=120,
                max_frontier_runs=1,
                json_output=None,
            )

            captured_frontier_args: list[Namespace] = []

            def run_frontier(frontier_args: Namespace) -> dict[str, object]:
                captured_frontier_args.append(frontier_args)
                return response

            with (
                patch(
                    "scripts.run_strategy_autoresearch_loop._select_effective_replay_tape_window",
                    return_value=(
                        date(2026, 3, 23),
                        date(2026, 3, 23),
                        selected_receipt,
                    ),
                ) as select_window,
                patch(
                    "scripts.run_strategy_autoresearch_loop.replay_mod._iter_signal_rows",
                    return_value=iter(signal_rows),
                ),
                patch(
                    "scripts.run_strategy_autoresearch_loop.run_consistent_profitability_frontier",
                    side_effect=run_frontier,
                ),
            ):
                payload = runner.run_strategy_autoresearch_loop(args)

        self.assertEqual(payload["status"], "ok")
        self.assertEqual(
            select_window.call_args.kwargs["args"].latest_complete_window_min_days,
            1,
        )
        self.assertEqual(len(captured_frontier_args), 1)
        self.assertEqual(
            captured_frontier_args[0].full_window_start_date,
            "2026-03-23",
        )
        self.assertEqual(
            captured_frontier_args[0].full_window_end_date,
            "2026-03-23",
        )
        self.assertEqual(
            captured_frontier_args[0].expected_last_trading_day, "2026-03-23"
        )

    def test_run_strategy_autoresearch_loop_records_missing_runtime_strategy_as_skip(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path, family_dir = self._write_program_fixture(root)
            configmap_path = root / "strategy-configmap.yaml"
            configmap_path.write_text(
                yaml.safe_dump(
                    {
                        "apiVersion": "v1",
                        "kind": "ConfigMap",
                        "data": {"strategies.yaml": "strategies: []\n"},
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
            signal_row = SignalEnvelope(
                event_ts=datetime(2026, 3, 20, 13, 30, tzinfo=UTC),
                symbol="AMAT",
                seq=1,
                source="ta",
                timeframe="1Sec",
                payload={"price": "180.10"},
            )
            tape_path = root / "provided-tape.jsonl"
            manifest_path = root / "provided-tape.jsonl.manifest.json"
            runner.materialize_signal_tape(
                rows=[signal_row],
                tape_path=tape_path,
                manifest_path=manifest_path,
                dataset_snapshot_ref="provided-snapshot",
                symbols=("AMAT",),
                start_date=date(2026, 3, 20),
                end_date=date(2026, 3, 20),
                source_query_digest="digest",
            )
            output_dir = root / "out"
            args = Namespace(
                program=program_path,
                output_dir=output_dir,
                strategy_configmap=configmap_path,
                family_template_dir=family_dir,
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_equity="31590.02",
                chunk_minutes=10,
                symbols="",
                progress_log_seconds=30,
                shadow_validation_artifact=None,
                train_days=6,
                holdout_days=3,
                full_window_start_date="",
                full_window_end_date="",
                expected_last_trading_day="",
                allow_stale_tape=False,
                prefetch_full_window_rows=False,
                replay_tape_path=tape_path,
                replay_tape_manifest=manifest_path,
                materialize_replay_tape=False,
                max_frontier_runs=0,
                json_output=None,
            )

            with patch(
                "scripts.run_strategy_autoresearch_loop.run_consistent_profitability_frontier",
                side_effect=ValueError(
                    "strategy_not_found:breakout-continuation-long-v1"
                ),
            ):
                payload = runner.run_strategy_autoresearch_loop(args)

            self.assertEqual(payload["status"], "ok")
            self.assertEqual(payload["frontier_run_count"], 1)
            self.assertFalse(payload["objective_met"])
            run_root = Path(payload["run_root"])
            history_rows = [
                json.loads(line)
                for line in (run_root / "history.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
            ]
            self.assertEqual(len(history_rows), 1)
            self.assertEqual(history_rows[0]["status"], "skip")
            self.assertIn("runtime_strategy_missing", history_rows[0]["hard_vetoes"])
            snapshot_manifest = json.loads(
                (run_root / "mlx-snapshot-manifest.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                snapshot_manifest["tape_freshness_receipts"][0]["status"],
                "provided",
            )
            self.assertEqual(
                history_rows[0]["proposal_selection_reason"], "runtime_strategy_missing"
            )
            result_payload = json.loads(
                next((run_root / "experiments").glob("*/result.json")).read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(
                result_payload["status"], "skipped_runtime_strategy_missing"
            )
            self.assertEqual(
                result_payload["top"][0]["runtime_availability"]["reason"],
                "strategy_not_found:breakout-continuation-long-v1",
            )

    def test_run_strategy_autoresearch_loop_applies_replay_budget_and_candidate_specific_scores(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path, family_dir = self._write_program_fixture(root)
            program_payload = yaml.safe_load(program_path.read_text(encoding="utf-8"))
            program_payload["families"][0]["keep_top_candidates"] = 2
            program_payload["replay_budget"] = {
                "max_candidates_per_round": 1,
                "exploration_slots": 1,
            }
            program_payload["proposal_model_policy"] = {
                "enabled": True,
                "mode": "ranking_only",
                "backend_preference": "numpy-fallback",
                "top_k": 4,
                "exploration_slots": 1,
                "minimum_history_rows": 1,
            }
            program_path.write_text(
                yaml.safe_dump(program_payload, sort_keys=False), encoding="utf-8"
            )
            configmap_path = root / "strategy-configmap.yaml"
            configmap_path.write_text(
                yaml.safe_dump(
                    {
                        "apiVersion": "v1",
                        "kind": "ConfigMap",
                        "data": {"strategies.yaml": "strategies: []\n"},
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
            output_dir = root / "out"
            signal_rows = [
                SignalEnvelope(
                    event_ts=datetime(2026, 3, 20, 13, 30, tzinfo=UTC),
                    symbol="AMAT",
                    seq=1,
                    source="ta",
                    timeframe="1Sec",
                    payload={"price": "180.10"},
                )
            ]
            responses = [
                {
                    "dataset_snapshot_receipt": {"snapshot_id": "snap-1"},
                    "window": {
                        "full_window_start_date": "2026-03-20",
                        "full_window_end_date": "2026-04-09",
                    },
                    "top": [
                        {
                            "candidate_id": "seed-1",
                            "hard_vetoes": [],
                            "ranking": {
                                "pareto_tier": 1,
                                "tie_breaker_score": "10",
                                "vetoed": False,
                            },
                            "objective_scorecard": {
                                "net_pnl_per_day": "450",
                                "active_day_ratio": "0.70",
                                "positive_day_ratio": "0.55",
                                "avg_filled_notional_per_day": "290000",
                                "avg_filled_notional_per_active_day": "360000",
                                "best_day_share": "0.40",
                                "worst_day_loss": "350",
                                "max_drawdown": "900",
                                "regime_slice_pass_rate": "0.45",
                                "market_impact_stress_passed": True,
                                "market_impact_stress_net_pnl_per_day": "430",
                                "delay_adjusted_depth_stress_passed": True,
                                "delay_adjusted_depth_stress_net_pnl_per_day": "420",
                                "delay_adjusted_depth_fill_survival_evidence_present": True,
                                "delay_adjusted_depth_fill_survival_sample_count": 6,
                                "delay_adjusted_depth_fill_survival_rate": "0.85",
                                "queue_position_survival_fill_curve_evidence_present": True,
                                "queue_position_survival_sample_count": 6,
                                "queue_position_survival_fill_rate": "0.85",
                                "queue_position_survival_queue_ratio_p95": "0.25",
                                "queue_position_survival_queue_ahead_depletion_evidence_present": True,
                                "queue_position_survival_queue_ahead_depletion_sample_count": 6,
                                "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
                                "delay_adjusted_depth_queue_ahead_depletion_sample_count": 6,
                                "queue_ahead_depletion_evidence_present": True,
                                "queue_ahead_depletion_sample_count": 6,
                                "post_cost_net_pnl_after_queue_position_survival_fill_stress": "420",
                                "double_oos_passed": True,
                                "double_oos_cost_shock_net_pnl_per_day": "410",
                                "implementation_uncertainty_stability_passed": True,
                                "implementation_uncertainty_lower_net_pnl_per_day": "405",
                                "conformal_tail_risk_passed": True,
                                "conformal_tail_risk_adjusted_net_pnl_per_day": "405",
                            },
                            "full_window": {
                                "net_per_day": "450",
                                "trading_day_count": 9,
                                "active_days": 6,
                                "daily_net": {"2026-04-01": "450"},
                                "daily_filled_notional": {"2026-04-01": "290000"},
                            },
                            "replay_config": {
                                "params": {
                                    "max_entries_per_session": "2",
                                    "entry_cooldown_seconds": "600",
                                },
                                "strategy_overrides": {
                                    "universe_symbols": ["AMAT", "NVDA"]
                                },
                            },
                        }
                    ],
                },
                {
                    "dataset_snapshot_receipt": {"snapshot_id": "snap-2"},
                    "window": {
                        "full_window_start_date": "2026-03-20",
                        "full_window_end_date": "2026-04-09",
                    },
                    "top": [
                        {
                            "candidate_id": "mutated-1",
                            "hard_vetoes": [],
                            "ranking": {
                                "pareto_tier": 1,
                                "tie_breaker_score": "11",
                                "vetoed": False,
                            },
                            "objective_scorecard": {
                                "net_pnl_per_day": "620",
                                "active_day_ratio": "0.85",
                                "positive_day_ratio": "0.60",
                                "avg_filled_notional_per_day": "340000",
                                "avg_filled_notional_per_active_day": "400000",
                                "best_day_share": "0.30",
                                "worst_day_loss": "300",
                                "max_drawdown": "850",
                                "regime_slice_pass_rate": "0.50",
                                "market_impact_stress_passed": True,
                                "market_impact_stress_net_pnl_per_day": "600",
                                "delay_adjusted_depth_stress_passed": True,
                                "delay_adjusted_depth_stress_net_pnl_per_day": "590",
                                "delay_adjusted_depth_fill_survival_evidence_present": True,
                                "delay_adjusted_depth_fill_survival_sample_count": 8,
                                "delay_adjusted_depth_fill_survival_rate": "0.85",
                                "queue_position_survival_fill_curve_evidence_present": True,
                                "queue_position_survival_sample_count": 8,
                                "queue_position_survival_fill_rate": "0.85",
                                "queue_position_survival_queue_ratio_p95": "0.25",
                                "queue_position_survival_queue_ahead_depletion_evidence_present": True,
                                "queue_position_survival_queue_ahead_depletion_sample_count": 8,
                                "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
                                "delay_adjusted_depth_queue_ahead_depletion_sample_count": 8,
                                "queue_ahead_depletion_evidence_present": True,
                                "queue_ahead_depletion_sample_count": 8,
                                "post_cost_net_pnl_after_queue_position_survival_fill_stress": "590",
                                "double_oos_passed": True,
                                "double_oos_cost_shock_net_pnl_per_day": "580",
                                "implementation_uncertainty_stability_passed": True,
                                "implementation_uncertainty_lower_net_pnl_per_day": "570",
                                "conformal_tail_risk_passed": True,
                                "conformal_tail_risk_adjusted_net_pnl_per_day": "570",
                            },
                            "full_window": {
                                "net_per_day": "620",
                                "trading_day_count": 9,
                                "active_days": 8,
                                "daily_net": {"2026-04-02": "620"},
                                "daily_filled_notional": {"2026-04-02": "340000"},
                            },
                            "replay_config": {
                                "params": {
                                    "max_entries_per_session": "1",
                                    "top_n": "1",
                                    "entry_cooldown_seconds": "600",
                                },
                                "strategy_overrides": {
                                    "universe_symbols": ["AMAT", "NVDA"]
                                },
                            },
                        },
                        {
                            "candidate_id": "mutated-2",
                            "hard_vetoes": [],
                            "ranking": {
                                "pareto_tier": 1,
                                "tie_breaker_score": "10.5",
                                "vetoed": False,
                            },
                            "objective_scorecard": {
                                "net_pnl_per_day": "600",
                                "active_day_ratio": "0.82",
                                "positive_day_ratio": "0.58",
                                "avg_filled_notional_per_day": "330000",
                                "avg_filled_notional_per_active_day": "395000",
                                "best_day_share": "0.31",
                                "worst_day_loss": "305",
                                "max_drawdown": "845",
                                "regime_slice_pass_rate": "0.49",
                                "market_impact_stress_passed": True,
                                "market_impact_stress_net_pnl_per_day": "570",
                                "delay_adjusted_depth_stress_passed": True,
                                "delay_adjusted_depth_stress_net_pnl_per_day": "560",
                                "delay_adjusted_depth_fill_survival_evidence_present": True,
                                "delay_adjusted_depth_fill_survival_sample_count": 8,
                                "delay_adjusted_depth_fill_survival_rate": "0.85",
                                "queue_position_survival_fill_curve_evidence_present": True,
                                "queue_position_survival_sample_count": 8,
                                "queue_position_survival_fill_rate": "0.85",
                                "queue_position_survival_queue_ratio_p95": "0.25",
                                "queue_position_survival_queue_ahead_depletion_evidence_present": True,
                                "queue_position_survival_queue_ahead_depletion_sample_count": 8,
                                "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
                                "delay_adjusted_depth_queue_ahead_depletion_sample_count": 8,
                                "queue_ahead_depletion_evidence_present": True,
                                "queue_ahead_depletion_sample_count": 8,
                                "post_cost_net_pnl_after_queue_position_survival_fill_stress": "560",
                                "double_oos_passed": True,
                                "double_oos_cost_shock_net_pnl_per_day": "550",
                                "implementation_uncertainty_stability_passed": True,
                                "implementation_uncertainty_lower_net_pnl_per_day": "540",
                                "conformal_tail_risk_passed": True,
                                "conformal_tail_risk_adjusted_net_pnl_per_day": "540",
                            },
                            "full_window": {
                                "net_per_day": "600",
                                "trading_day_count": 9,
                                "active_days": 8,
                                "daily_net": {"2026-04-02": "600"},
                                "daily_filled_notional": {"2026-04-02": "330000"},
                            },
                            "replay_config": {
                                "params": {
                                    "max_entries_per_session": "3",
                                    "top_n": "2",
                                    "entry_cooldown_seconds": "600",
                                },
                                "strategy_overrides": {
                                    "universe_symbols": ["AMAT", "NVDA"]
                                },
                            },
                        },
                    ],
                },
            ]

            args = Namespace(
                program=program_path,
                output_dir=output_dir,
                strategy_configmap=configmap_path,
                family_template_dir=family_dir,
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_equity="31590.02",
                chunk_minutes=10,
                symbols="",
                progress_log_seconds=30,
                shadow_validation_artifact=None,
                train_days=6,
                holdout_days=3,
                full_window_start_date="",
                full_window_end_date="",
                expected_last_trading_day="",
                allow_stale_tape=False,
                prefetch_full_window_rows=False,
                max_frontier_runs=0,
                json_output=None,
            )

            with (
                patch(
                    "scripts.run_strategy_autoresearch_loop.run_consistent_profitability_frontier",
                    side_effect=responses,
                ),
                patch(
                    "scripts.run_strategy_autoresearch_loop.replay_mod._iter_signal_rows",
                    return_value=iter(signal_rows),
                ),
            ):
                payload = runner.run_strategy_autoresearch_loop(args)

            history_rows = [
                json.loads(line)
                for line in (Path(payload["run_root"]) / "history.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
                if line.strip()
            ]
            diagnostics = json.loads(
                (Path(payload["run_root"]) / "mlx-proposal-diagnostics.json").read_text(
                    encoding="utf-8"
                )
            )
            round_two_rows = [
                row for row in history_rows if row["experiment_index"] == 2
            ]
            self.assertEqual(len(round_two_rows), 2)
            keep_rows = [row for row in round_two_rows if row["status"] == "keep"]
            self.assertEqual(len(keep_rows), 1)
            self.assertTrue(keep_rows[0]["proposal_selected"])
            self.assertEqual(keep_rows[0]["proposal_selection_reason"], "exploitation")
            score_by_candidate = {
                row["candidate_id"]: row["proposal_score"] for row in round_two_rows
            }
            self.assertNotEqual(
                score_by_candidate["mutated-1"], score_by_candidate["mutated-2"]
            )
            self.assertEqual(diagnostics["parity_matrix"]["replayed_count"], 3)
            self.assertIn(
                keep_rows[0]["candidate_id"],
                [row["candidate_id"] for row in diagnostics["selected_candidates"]],
            )

    def test_run_strategy_autoresearch_loop_flushes_visible_progress_between_experiments(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path, family_dir = self._write_program_fixture(root)
            configmap_path = root / "strategy-configmap.yaml"
            configmap_path.write_text(
                yaml.safe_dump(
                    {
                        "apiVersion": "v1",
                        "kind": "ConfigMap",
                        "data": {"strategies.yaml": "strategies: []\n"},
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
            output_dir = root / "out"

            responses = [
                {
                    "dataset_snapshot_receipt": {"snapshot_id": "snap-1"},
                    "top": [
                        {
                            "candidate_id": "seed-1",
                            "hard_vetoes": [],
                            "ranking": {
                                "pareto_tier": 1,
                                "tie_breaker_score": "10",
                                "vetoed": False,
                            },
                            "objective_scorecard": {
                                "net_pnl_per_day": "450",
                                "active_day_ratio": "0.70",
                                "positive_day_ratio": "0.55",
                                "avg_filled_notional_per_day": "290000",
                                "avg_filled_notional_per_active_day": "360000",
                                "best_day_share": "0.40",
                                "worst_day_loss": "350",
                                "max_drawdown": "900",
                                "regime_slice_pass_rate": "0.45",
                            },
                            "full_window": {
                                "net_per_day": "450",
                                "trading_day_count": 9,
                                "active_days": 6,
                                "daily_net": {"2026-04-01": "450"},
                                "daily_filled_notional": {"2026-04-01": "290000"},
                            },
                            "replay_config": {
                                "params": {
                                    "max_entries_per_session": "2",
                                    "entry_cooldown_seconds": "600",
                                },
                                "strategy_overrides": {
                                    "universe_symbols": ["AMAT", "NVDA"]
                                },
                            },
                        }
                    ],
                },
                {
                    "dataset_snapshot_receipt": {"snapshot_id": "snap-2"},
                    "top": [
                        {
                            "candidate_id": "mutated-1",
                            "hard_vetoes": [],
                            "ranking": {
                                "pareto_tier": 1,
                                "tie_breaker_score": "11",
                                "vetoed": False,
                            },
                            "objective_scorecard": {
                                "net_pnl_per_day": "620",
                                "active_day_ratio": "0.85",
                                "positive_day_ratio": "0.60",
                                "avg_filled_notional_per_day": "340000",
                                "avg_filled_notional_per_active_day": "400000",
                                "best_day_share": "0.30",
                                "worst_day_loss": "300",
                                "max_drawdown": "850",
                                "regime_slice_pass_rate": "0.50",
                            },
                            "full_window": {
                                "net_per_day": "620",
                                "trading_day_count": 9,
                                "active_days": 8,
                                "daily_net": {"2026-04-02": "620"},
                                "daily_filled_notional": {"2026-04-02": "340000"},
                            },
                            "replay_config": {
                                "params": {
                                    "max_entries_per_session": "1",
                                    "entry_cooldown_seconds": "600",
                                },
                                "strategy_overrides": {
                                    "universe_symbols": ["AMAT", "NVDA"]
                                },
                            },
                        }
                    ],
                },
            ]

            args = Namespace(
                program=program_path,
                output_dir=output_dir,
                strategy_configmap=configmap_path,
                family_template_dir=family_dir,
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_equity="31590.02",
                chunk_minutes=10,
                symbols="",
                progress_log_seconds=30,
                shadow_validation_artifact=None,
                train_days=6,
                holdout_days=3,
                full_window_start_date="",
                full_window_end_date="",
                expected_last_trading_day="",
                allow_stale_tape=False,
                prefetch_full_window_rows=False,
                max_frontier_runs=0,
                json_output=None,
            )

            frontier_call_count = {"count": 0}

            def _frontier_side_effect(_: Namespace) -> dict[str, object]:
                if frontier_call_count["count"] == 1:
                    run_roots = [path for path in output_dir.iterdir() if path.is_dir()]
                    self.assertEqual(len(run_roots), 1)
                    run_root = run_roots[0]
                    summary = json.loads(
                        (run_root / "summary.json").read_text(encoding="utf-8")
                    )
                    self.assertEqual(summary["status"], "running")
                    self.assertEqual(summary["frontier_run_count"], 2)
                    self.assertEqual(
                        summary["live_progress"]["frontier_runs_started"], 2
                    )
                    self.assertTrue(
                        summary["live_progress"]["selected_for_replay"]["candidate_id"]
                    )
                    self.assertEqual(
                        summary["live_progress"]["selected_for_replay"][
                            "family_template_id"
                        ],
                        "breakout_reclaim_v2",
                    )
                    self.assertEqual(
                        summary["live_progress"]["latest_experiment"][
                            "top_candidate_id"
                        ],
                        "seed-1",
                    )
                    history_lines = (
                        (run_root / "history.jsonl")
                        .read_text(encoding="utf-8")
                        .splitlines()
                    )
                    self.assertEqual(len(history_lines), 1)
                    self.assertTrue(
                        (run_root / "strategy-discovery-history.ipynb").exists()
                    )
                response = responses[frontier_call_count["count"]]
                frontier_call_count["count"] += 1
                return response

            with patch(
                "scripts.run_strategy_autoresearch_loop.run_consistent_profitability_frontier",
                side_effect=_frontier_side_effect,
            ):
                payload = runner.run_strategy_autoresearch_loop(args)

            self.assertEqual(payload["status"], "ok")
            self.assertEqual(frontier_call_count["count"], 2)

    def test_run_strategy_autoresearch_loop_stops_when_discarded_candidate_meets_objective(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path, family_dir = self._write_program_fixture(root)
            program_payload = yaml.safe_load(program_path.read_text(encoding="utf-8"))
            program_payload["objective"]["stop_when_objective_met"] = True
            program_path.write_text(
                yaml.safe_dump(program_payload, sort_keys=False), encoding="utf-8"
            )
            configmap_path = root / "strategy-configmap.yaml"
            configmap_path.write_text(
                yaml.safe_dump(
                    {
                        "apiVersion": "v1",
                        "kind": "ConfigMap",
                        "data": {"strategies.yaml": "strategies: []\n"},
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
            output_dir = root / "out"

            args = Namespace(
                program=program_path,
                output_dir=output_dir,
                strategy_configmap=configmap_path,
                family_template_dir=family_dir,
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_equity="31590.02",
                chunk_minutes=10,
                symbols="",
                progress_log_seconds=30,
                shadow_validation_artifact=None,
                train_days=6,
                holdout_days=3,
                full_window_start_date="",
                full_window_end_date="",
                expected_last_trading_day="",
                allow_stale_tape=False,
                prefetch_full_window_rows=False,
                max_frontier_runs=0,
                json_output=None,
            )

            frontier_payload = {
                "dataset_snapshot_receipt": {"snapshot_id": "snap-1"},
                "top": [
                    {
                        "candidate_id": "keep-1",
                        "hard_vetoes": [],
                        "ranking": {
                            "pareto_tier": 1,
                            "tie_breaker_score": "10",
                            "vetoed": False,
                        },
                        "objective_scorecard": {
                            "net_pnl_per_day": "420",
                            "active_day_ratio": "0.70",
                            "positive_day_ratio": "0.55",
                            "avg_filled_notional_per_day": "290000",
                            "avg_filled_notional_per_active_day": "360000",
                            "best_day_share": "0.40",
                            "worst_day_loss": "350",
                            "max_drawdown": "900",
                            "regime_slice_pass_rate": "0.45",
                        },
                        "full_window": {
                            "net_per_day": "420",
                            "trading_day_count": 9,
                            "active_days": 6,
                            "daily_net": {"2026-04-01": "420"},
                            "daily_filled_notional": {"2026-04-01": "290000"},
                        },
                        "replay_config": {
                            "params": {
                                "max_entries_per_session": "2",
                                "entry_cooldown_seconds": "600",
                            },
                            "strategy_overrides": {
                                "universe_symbols": ["AMAT", "NVDA"]
                            },
                        },
                    },
                    {
                        "candidate_id": "discarded-objective-hit",
                        "hard_vetoes": [],
                        "ranking": {
                            "pareto_tier": 2,
                            "tie_breaker_score": "9",
                            "vetoed": False,
                        },
                        "objective_scorecard": {
                            "net_pnl_per_day": "620",
                            "active_day_ratio": "0.85",
                            "positive_day_ratio": "0.65",
                            "avg_filled_notional_per_day": "340000",
                            "avg_filled_notional_per_active_day": "400000",
                            "best_day_share": "0.30",
                            "worst_day_loss": "300",
                            "max_drawdown": "850",
                            "regime_slice_pass_rate": "0.50",
                        },
                        "full_window": {
                            "net_per_day": "620",
                            "trading_day_count": 9,
                            "active_days": 8,
                            "daily_net": {"2026-04-02": "620"},
                            "daily_filled_notional": {"2026-04-02": "340000"},
                        },
                        "replay_config": {
                            "params": {
                                "max_entries_per_session": "1",
                                "entry_cooldown_seconds": "600",
                            },
                            "strategy_overrides": {
                                "universe_symbols": ["AMAT", "NVDA"]
                            },
                        },
                    },
                ],
            }

            with patch(
                "scripts.run_strategy_autoresearch_loop.run_consistent_profitability_frontier",
                side_effect=[
                    frontier_payload,
                    AssertionError("loop should stop after discarded objective hit"),
                ],
            ):
                payload = runner.run_strategy_autoresearch_loop(args)

            self.assertEqual(payload["status"], "ok")
            self.assertTrue(payload["objective_met"])
            self.assertEqual(payload["frontier_run_count"], 1)
            summary = json.loads(
                (Path(payload["run_root"]) / "summary.json").read_text(encoding="utf-8")
            )
            self.assertTrue(summary["objective_met"])

    def test_run_strategy_autoresearch_loop_persists_error_artifacts(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path, family_dir = self._write_program_fixture(root)
            configmap_path = root / "strategy-configmap.yaml"
            configmap_path.write_text(
                yaml.safe_dump(
                    {
                        "apiVersion": "v1",
                        "kind": "ConfigMap",
                        "data": {"strategies.yaml": "strategies: []\n"},
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
            output_dir = root / "out"

            args = Namespace(
                program=program_path,
                output_dir=output_dir,
                strategy_configmap=configmap_path,
                family_template_dir=family_dir,
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_equity="31590.02",
                chunk_minutes=10,
                symbols="",
                progress_log_seconds=30,
                shadow_validation_artifact=None,
                train_days=6,
                holdout_days=3,
                full_window_start_date="",
                full_window_end_date="",
                expected_last_trading_day="",
                allow_stale_tape=False,
                prefetch_full_window_rows=False,
                max_frontier_runs=0,
                json_output=None,
            )

            with patch(
                "scripts.run_strategy_autoresearch_loop.run_consistent_profitability_frontier",
                side_effect=RuntimeError("frontier blew up"),
            ):
                payload = runner.run_strategy_autoresearch_loop(args)

            self.assertEqual(payload["status"], "error")
            self.assertEqual(payload["error"]["type"], "RuntimeError")
            self.assertIn("frontier blew up", payload["error"]["message"])
            run_root = Path(payload["run_root"])
            self.assertTrue((run_root / "summary.json").exists())
            self.assertTrue((run_root / "history.jsonl").exists())
            self.assertTrue((run_root / "results.tsv").exists())
            self.assertTrue((run_root / "research_dossier.json").exists())
            self.assertTrue((run_root / "strategy-discovery-history.ipynb").exists())
            self.assertTrue((run_root / "promotion_readiness.json").exists())
            promotion_readiness = json.loads(
                (run_root / "promotion_readiness.json").read_text(encoding="utf-8")
            )
            self.assertEqual(promotion_readiness["status"], "blocked_no_candidate")
            self.assertIn("best_candidate_missing", promotion_readiness["blockers"])

    def test_run_strategy_autoresearch_loop_honors_max_frontier_runs_and_dedupes_seen_sweeps(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path, family_dir = self._write_program_fixture(root)
            program_payload = yaml.safe_load(program_path.read_text(encoding="utf-8"))
            program_payload["families"].append(dict(program_payload["families"][0]))
            program_path.write_text(
                yaml.safe_dump(program_payload, sort_keys=False), encoding="utf-8"
            )
            configmap_path = root / "strategy-configmap.yaml"
            configmap_path.write_text(
                yaml.safe_dump(
                    {
                        "apiVersion": "v1",
                        "kind": "ConfigMap",
                        "data": {"strategies.yaml": "strategies: []\n"},
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
            args = Namespace(
                program=program_path,
                output_dir=root / "out",
                strategy_configmap=configmap_path,
                family_template_dir=family_dir,
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_equity="31590.02",
                chunk_minutes=10,
                symbols="",
                progress_log_seconds=30,
                shadow_validation_artifact=None,
                train_days=6,
                holdout_days=3,
                full_window_start_date="2026-03-20",
                full_window_end_date="",
                expected_last_trading_day="",
                allow_stale_tape=False,
                prefetch_full_window_rows=False,
                max_frontier_runs=1,
                json_output=None,
            )
            frontier_payload = {
                "dataset_snapshot_receipt": {"snapshot_id": "snap-1"},
                "top": [],
            }

            with patch(
                "scripts.run_strategy_autoresearch_loop.run_consistent_profitability_frontier",
                return_value=frontier_payload,
            ) as mock_frontier:
                payload = runner.run_strategy_autoresearch_loop(args)

        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["frontier_run_count"], 1)
        mock_frontier.assert_called_once()

    def test_run_strategy_autoresearch_loop_force_keeps_top_candidate_when_all_vetoed(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path, family_dir = self._write_program_fixture(root)
            configmap_path = root / "strategy-configmap.yaml"
            configmap_path.write_text(
                yaml.safe_dump(
                    {
                        "apiVersion": "v1",
                        "kind": "ConfigMap",
                        "data": {"strategies.yaml": "strategies: []\n"},
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
            args = Namespace(
                program=program_path,
                output_dir=root / "out",
                strategy_configmap=configmap_path,
                family_template_dir=family_dir,
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_equity="31590.02",
                chunk_minutes=10,
                symbols="",
                progress_log_seconds=30,
                shadow_validation_artifact=None,
                train_days=6,
                holdout_days=3,
                full_window_start_date="",
                full_window_end_date="",
                expected_last_trading_day="",
                allow_stale_tape=False,
                prefetch_full_window_rows=False,
                max_frontier_runs=2,
                json_output=None,
            )
            frontier_responses = [
                {
                    "dataset_snapshot_receipt": {"snapshot_id": "snap-1"},
                    "top": [
                        {
                            "candidate_id": "vetoed-seed",
                            "hard_vetoes": ["bad"],
                            "ranking": {
                                "pareto_tier": 1,
                                "tie_breaker_score": "1",
                                "vetoed": True,
                            },
                            "objective_scorecard": {
                                "net_pnl_per_day": "0",
                                "active_day_ratio": "0",
                                "positive_day_ratio": "0",
                                "avg_filled_notional_per_day": "0",
                                "avg_filled_notional_per_active_day": "0",
                                "best_day_share": "1",
                                "worst_day_loss": "999",
                                "max_drawdown": "999",
                                "regime_slice_pass_rate": "0",
                            },
                            "full_window": {
                                "trading_day_count": 9,
                                "active_days": 0,
                                "daily_net": {},
                                "daily_filled_notional": {},
                            },
                            "replay_config": {
                                "params": {
                                    "max_entries_per_session": "2",
                                    "entry_cooldown_seconds": "600",
                                },
                                "strategy_overrides": {
                                    "universe_symbols": ["AMAT", "NVDA"]
                                },
                            },
                        }
                    ],
                },
                {
                    "dataset_snapshot_receipt": {"snapshot_id": "snap-2"},
                    "top": [],
                },
            ]

            with patch(
                "scripts.run_strategy_autoresearch_loop.run_consistent_profitability_frontier",
                side_effect=frontier_responses,
            ):
                payload = runner.run_strategy_autoresearch_loop(args)

            self.assertEqual(payload["frontier_run_count"], 2)
            history = (Path(payload["run_root"]) / "history.jsonl").read_text(
                encoding="utf-8"
            )
            self.assertIn('"candidate_id": "vetoed-seed"', history)

    def test_main_writes_json_output_and_returns_nonzero_for_error_payload(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path = root / "program.yaml"
            program_path.write_text(
                "schema_version: torghut.strategy-autoresearch.v1\nfamilies: []\n",
                encoding="utf-8",
            )
            output_dir = root / "out"
            json_output = root / "summary.json"

            with (
                patch.object(
                    sys,
                    "argv",
                    [
                        "run_strategy_autoresearch_loop.py",
                        "--program",
                        str(program_path),
                        "--output-dir",
                        str(output_dir),
                        "--json-output",
                        str(json_output),
                    ],
                ),
                patch.object(
                    runner,
                    "run_strategy_autoresearch_loop",
                    return_value={"status": "error", "run_root": str(output_dir)},
                ),
            ):
                exit_code = runner.main()

            self.assertEqual(exit_code, 1)
            self.assertEqual(
                json.loads(json_output.read_text(encoding="utf-8"))["status"], "error"
            )
