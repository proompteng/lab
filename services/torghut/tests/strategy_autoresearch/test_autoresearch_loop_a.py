from __future__ import annotations

from tests.strategy_autoresearch.support import (
    Decimal,
    Namespace,
    Path,
    SignalEnvelope,
    StrategyAutoresearchTestCase,
    StrategyObjective,
    TemporaryDirectory,
    UTC,
    build_strategy_discovery_history_notebook,
    build_strategy_factory_history_notebook,
    candidate_meets_objective,
    copy,
    date,
    datetime,
    json,
    patch,
    runner,
    write_autoresearch_notebooks,
    write_strategy_factory_notebooks,
    yaml,
)


class TestStrategyAutoresearchLoopA(StrategyAutoresearchTestCase):
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
                    "scripts.strategy_autoresearch_loop.run_strategy_autoresearch_loop.run_consistent_profitability_frontier",
                    side_effect=responses,
                ),
                patch(
                    "scripts.strategy_autoresearch_loop.load_yaml.replay_mod._iter_signal_rows",
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
                    "scripts.strategy_autoresearch_loop.load_yaml._select_effective_replay_tape_window",
                    return_value=(
                        date(2026, 3, 23),
                        date(2026, 3, 23),
                        selected_receipt,
                    ),
                ) as select_window,
                patch(
                    "scripts.strategy_autoresearch_loop.load_yaml.replay_mod._iter_signal_rows",
                    return_value=iter(signal_rows),
                ),
                patch(
                    "scripts.strategy_autoresearch_loop.run_strategy_autoresearch_loop.run_consistent_profitability_frontier",
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
                "scripts.strategy_autoresearch_loop.run_strategy_autoresearch_loop.run_consistent_profitability_frontier",
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
