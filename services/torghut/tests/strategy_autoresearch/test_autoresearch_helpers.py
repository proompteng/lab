from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.strategy_autoresearch.support import *


class TestStrategyAutoresearchHelpers(StrategyAutoresearchTestCase):
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
        self.assertIn("exact_replay_ledger_artifact_ref_missing", blocker_names)
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
                            "exact_replay_ledger_artifact_row_count": "6",
                            "exact_replay_ledger_artifact_fill_count": "2",
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
                target["exact_replay_ledger_artifact_row_count"],
                "6",
            )
            self.assertEqual(
                target["exact_replay_ledger_artifact_fill_count"],
                "2",
            )
            self.assertNotIn("runtime_ledger_artifact_ref", target)
            self.assertNotIn("runtime_ledger_artifact_refs", target)
            self.assertNotIn("runtime_ledger_artifact_row_count", target)
            self.assertNotIn("runtime_ledger_artifact_fill_count", target)
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
                                    "runtime_ledger_artifact_ref": "runtime-ledger.json",
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
