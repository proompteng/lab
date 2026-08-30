from __future__ import annotations

from tests.strategy_autoresearch.support import (
    Namespace,
    Path,
    SignalEnvelope,
    StrategyAutoresearchTestCase,
    TemporaryDirectory,
    UTC,
    datetime,
    json,
    patch,
    runner,
    yaml,
)


class TestStrategyAutoresearchLoopB(StrategyAutoresearchTestCase):
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
                    "scripts.strategy_autoresearch_loop.run_strategy_autoresearch_loop.run_consistent_profitability_frontier",
                    side_effect=responses,
                ),
                patch(
                    "scripts.strategy_autoresearch_loop.load_yaml.replay_mod._iter_signal_rows",
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
                "scripts.strategy_autoresearch_loop.run_strategy_autoresearch_loop.run_consistent_profitability_frontier",
                side_effect=_frontier_side_effect,
            ):
                payload = runner.run_strategy_autoresearch_loop(args)

            self.assertEqual(payload["status"], "ok")
            self.assertEqual(frontier_call_count["count"], 2)

    def test_run_strategy_autoresearch_loop_continues_when_discarded_candidate_meets_objective(
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
                                "universe_symbols": ["AMAT", "NVDA"],
                                "max_position_pct_equity": "0.10",
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
                                "universe_symbols": ["AMAT", "NVDA"],
                                "max_position_pct_equity": "2.0",
                            },
                        },
                    },
                ],
            }

            with patch(
                "scripts.strategy_autoresearch_loop.run_strategy_autoresearch_loop.run_consistent_profitability_frontier",
                side_effect=[
                    frontier_payload,
                    {
                        "dataset_snapshot_receipt": {"snapshot_id": "snap-1"},
                        "top": [],
                    },
                ],
            ):
                payload = runner.run_strategy_autoresearch_loop(args)

            self.assertEqual(payload["status"], "ok")
            self.assertFalse(payload["objective_met"])
            self.assertEqual(payload["frontier_run_count"], 2)
            summary = json.loads(
                (Path(payload["run_root"]) / "summary.json").read_text(encoding="utf-8")
            )
            self.assertFalse(summary["objective_met"])
            run_root = Path(payload["run_root"])
            history = [
                json.loads(line)
                for line in (run_root / "history.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
            ]
            discarded = next(
                item
                for item in history
                if item["candidate_id"] == "discarded-objective-hit"
            )
            self.assertTrue(discarded["raw_objective_met"])
            self.assertFalse(discarded["objective_met"])
            self.assertEqual(discarded["terminal_validation_status"], "discarded")
            self.assertEqual(
                discarded["terminal_validation_reason"], "candidate_not_selected"
            )
            self.assertEqual(discarded["search_action"], "continue")
            search_decisions = [
                json.loads(line)
                for line in (run_root / "search-decisions.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
            ]
            discarded_decision = next(
                item
                for item in search_decisions
                if item.get("candidate_id") == "discarded-objective-hit"
            )
            self.assertEqual(discarded_decision["reason"], "candidate_not_selected")
            self.assertEqual(discarded_decision["action"], "continue")
            self.assertTrue((run_root / "checkpoint.json").is_file())

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
                "scripts.strategy_autoresearch_loop.run_strategy_autoresearch_loop.run_consistent_profitability_frontier",
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

    def test_run_strategy_autoresearch_loop_records_and_skips_duplicate_sweeps(
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
                max_frontier_runs=0,
                json_output=None,
            )
            frontier_payload = {
                "dataset_snapshot_receipt": {"snapshot_id": "snap-1"},
                "top": [],
            }

            with patch(
                "scripts.strategy_autoresearch_loop.run_strategy_autoresearch_loop.run_consistent_profitability_frontier",
                return_value=frontier_payload,
            ) as mock_frontier:
                payload = runner.run_strategy_autoresearch_loop(args)

            self.assertEqual(payload["status"], "ok")
            self.assertEqual(payload["frontier_run_count"], 1)
            mock_frontier.assert_called_once()
            decisions = [
                json.loads(line)
                for line in (Path(payload["run_root"]) / "search-decisions.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
            ]
            self.assertIn(
                "duplicate_sweep_identity",
                [item["reason"] for item in decisions],
            )

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
                "scripts.strategy_autoresearch_loop.run_strategy_autoresearch_loop.run_consistent_profitability_frontier",
                side_effect=frontier_responses,
            ):
                payload = runner.run_strategy_autoresearch_loop(args)

            self.assertEqual(payload["frontier_run_count"], 2)
            history = [
                json.loads(line)
                for line in (Path(payload["run_root"]) / "history.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
            ]
            vetoed = next(
                item for item in history if item["candidate_id"] == "vetoed-seed"
            )
            self.assertFalse(vetoed["objective_met"])
            self.assertEqual(vetoed["terminal_validation_status"], "invalid")
            self.assertEqual(vetoed["terminal_validation_reason"], "candidate_vetoed")
            self.assertEqual(vetoed["search_action"], "continue")
