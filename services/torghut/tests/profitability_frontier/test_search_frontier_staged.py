from __future__ import annotations

# ruff: noqa: F403,F405
from tests.profitability_frontier.search_frontier_base import *


class TestSearchFrontierStaged(SearchConsistentProfitabilityFrontierTestCaseBase):
    def test_staged_search_continues_screening_after_full_replay_budget(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = root / "sweep.yaml"
            sweep_config.write_text(
                yaml.safe_dump(
                    {
                        "schema_version": "torghut.replay-frontier-sweep.v1",
                        "family": "intraday_tsmom_consistent",
                        "strategy_name": "intraday-tsmom-profit-v3",
                        "disable_other_strategies": True,
                        "constraints": {
                            "holdout_target_net_per_day": "1",
                            "min_active_holdout_days": 1,
                            "max_worst_holdout_day_loss": "200",
                            "min_profit_factor": "1.0",
                        },
                        "consistency_constraints": {
                            "target_net_per_day": "1",
                            "min_active_days": 1,
                            "max_worst_day_loss": "300",
                            "max_negative_days": 1,
                            "max_drawdown": "400",
                            "require_every_day_active": False,
                        },
                        "strategy_overrides": {
                            "universe_symbols": [["NVDA"]],
                        },
                        "parameters": {
                            "long_stop_loss_bps": ["12", "14", "16"],
                        },
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=root / "frontier.json",
            )
            args.max_candidates_to_evaluate = 1
            args.staged_train_screen_multiplier = 3
            args.capture_positive_rejected_full_window_ledgers = 1
            args.min_train_screen_net_per_day = "1"
            recent_days = tuple(
                date(2026, 3, 18) + timedelta(days=index) for index in range(6)
            )
            snapshot_receipt = SimpleNamespace(
                snapshot_id="snap-budget-discard-proof",
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    "snapshot_id": "snap-budget-discard-proof",
                    "source": "ta",
                    "window_size": "PT1S",
                    "start_day": "2026-03-18",
                    "end_day": "2026-03-23",
                    "expected_last_trading_day": "2026-03-23",
                    "is_fresh": True,
                    "missing_days": [],
                    "row_count": 123,
                    "stale_override_used": False,
                    "witnesses": [],
                },
            )
            replay_calls: list[tuple[str, str, bool]] = []

            def fake_run_replay(config: object) -> dict[str, object]:
                start_date = str(getattr(config, "start_date"))
                end_date = str(getattr(config, "end_date"))
                capture_ledger = bool(
                    getattr(config, "capture_exact_replay_ledger", False)
                )
                replay_calls.append((start_date, end_date, capture_ledger))
                daily_net = {
                    day.isoformat(): "10"
                    for day in (
                        date.fromisoformat(start_date) + timedelta(days=index)
                        for index in range(
                            (
                                date.fromisoformat(end_date)
                                - date.fromisoformat(start_date)
                            ).days
                            + 1
                        )
                    )
                }
                payload = self._payload(
                    start_date=start_date,
                    end_date=end_date,
                    daily_net=daily_net,
                    decision_count=len(daily_net),
                    filled_count=len(daily_net),
                    wins=len(daily_net),
                    losses=0,
                )
                if capture_ledger:
                    payload["exact_replay_ledger"] = {
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
                        "account_label": "TORGHUT_REPLAY",
                        "execution_policy_hash": "policy-sha",
                        "cost_model_hash": "cost-sha",
                        "lineage_hash": "ledger-lineage-sha",
                        "fill_row_count": 2,
                        "runtime_ledger_rows": _authoritative_exact_replay_rows(),
                    }
                return payload

            with (
                patch(
                    "scripts.search_consistent_profitability_frontier._resolve_recent_trading_days",
                    return_value=recent_days,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.build_dataset_snapshot_receipt",
                    return_value=snapshot_receipt,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.ensure_fresh_snapshot"
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.run_replay",
                    side_effect=fake_run_replay,
                ),
            ):
                payload = frontier.run_consistent_profitability_frontier(args)

            self.assertEqual(payload["status"], "candidate_budget_exhausted")
            self.assertEqual(payload["candidate_count"], 3)
            self.assertEqual(
                replay_calls,
                [
                    ("2026-03-18", "2026-03-20", False),
                    ("2026-03-18", "2026-03-20", False),
                    ("2026-03-18", "2026-03-20", False),
                    ("2026-03-21", "2026-03-23", False),
                    ("2026-03-18", "2026-03-23", True),
                    ("2026-03-18", "2026-03-23", True),
                ],
            )
            staged = payload["progress"]["staged_search"]
            self.assertEqual(staged["full_replay_budget_discarded_candidates"], 2)
            self.assertEqual(staged["proof_only_full_window_replay_captures"], 1)
            budget_items = [
                item
                for item in payload["top"]
                if "full_replay_candidate_budget_exhausted" in item["hard_vetoes"]
            ]
            self.assertEqual(len(budget_items), 2)
            self.assertEqual(
                [item["staged_search"]["stage"] for item in budget_items],
                [
                    "full_replay_budget_exhausted_full_window_proof",
                    "train_screen_passed_full_replay_budget_exhausted",
                ],
            )
            self.assertTrue(
                budget_items[0]["screening"]["proof_only_full_window_replay_captured"]
            )
            exact_ledger_ref = Path(
                budget_items[0]["objective_scorecard"][
                    "exact_replay_ledger_artifact_ref"
                ]
            )
            artifact = json.loads(exact_ledger_ref.read_text(encoding="utf-8"))
            self.assertEqual(
                artifact["proof_only_reason"],
                "full_replay_budget_exhausted_positive_train_screen",
            )

    def test_run_frontier_staged_train_screen_expands_cheap_stage(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = root / "sweep.yaml"
            sweep_config.write_text(
                yaml.safe_dump(
                    {
                        "schema_version": "torghut.replay-frontier-sweep.v1",
                        "family": "intraday_tsmom_consistent",
                        "strategy_name": "intraday-tsmom-profit-v3",
                        "disable_other_strategies": True,
                        "constraints": {
                            "holdout_target_net_per_day": "200",
                            "min_active_holdout_days": 2,
                            "max_worst_holdout_day_loss": "200",
                            "min_profit_factor": "1.0",
                        },
                        "consistency_constraints": {
                            "target_net_per_day": "200",
                            "min_active_days": 2,
                            "max_worst_day_loss": "300",
                            "max_negative_days": 1,
                            "max_drawdown": "400",
                            "require_every_day_active": True,
                        },
                        "strategy_overrides": {
                            "universe_symbols": [["NVDA"]],
                        },
                        "parameters": {
                            "long_stop_loss_bps": ["12", "14", "16", "18"],
                        },
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
            json_output = root / "frontier.json"
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=json_output,
            )
            args.max_candidates_to_evaluate = 1
            args.staged_train_screen_multiplier = 3
            args.min_train_screen_net_per_day = "1"
            recent_days = tuple(
                date(2026, 3, 18) + timedelta(days=index) for index in range(6)
            )
            snapshot_receipt = SimpleNamespace(
                snapshot_id="snap-staged",
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    "snapshot_id": "snap-staged",
                    "source": "ta",
                    "window_size": "PT1S",
                    "start_day": "2026-03-18",
                    "end_day": "2026-03-23",
                    "expected_last_trading_day": "2026-03-23",
                    "is_fresh": True,
                    "missing_days": [],
                    "row_count": 123,
                    "stale_override_used": False,
                    "witnesses": [],
                },
            )
            replay_calls: list[tuple[str, str]] = []

            def fake_run_replay(config: object) -> dict[str, object]:
                replay_calls.append(
                    (
                        str(getattr(config, "start_date")),
                        str(getattr(config, "end_date")),
                    )
                )
                if len(replay_calls) <= 2:
                    return self._payload(
                        start_date="2026-03-18",
                        end_date="2026-03-20",
                        daily_net={
                            "2026-03-18": "0",
                            "2026-03-19": "0",
                            "2026-03-20": "0",
                        },
                        decision_count=0,
                        filled_count=0,
                        wins=0,
                        losses=0,
                    )
                return self._payload(
                    start_date=str(getattr(config, "start_date")),
                    end_date=str(getattr(config, "end_date")),
                    daily_net={
                        "2026-03-18": "220",
                        "2026-03-19": "230",
                        "2026-03-20": "240",
                    },
                    decision_count=3,
                    filled_count=3,
                    wins=3,
                    losses=0,
                )

            with (
                patch(
                    "scripts.search_consistent_profitability_frontier._resolve_recent_trading_days",
                    return_value=recent_days,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.build_dataset_snapshot_receipt",
                    return_value=snapshot_receipt,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.ensure_fresh_snapshot"
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.run_replay",
                    side_effect=fake_run_replay,
                ),
            ):
                payload = frontier.run_consistent_profitability_frontier(args)

            staged = payload["progress"]["staged_search"]
            self.assertEqual(payload["status"], "candidate_budget_exhausted")
            self.assertEqual(payload["candidate_count"], 3)
            self.assertEqual(staged["train_screen_candidate_budget"], 3)
            self.assertEqual(staged["full_replay_candidate_budget"], 1)
            self.assertEqual(staged["full_replay_candidates_started"], 1)
            self.assertEqual(staged["train_screen_only_candidates"], 2)
            self.assertEqual(
                [item["staged_search"]["stage"] for item in payload["top"]],
                ["full_replay", "train_screen_only", "train_screen_only"],
            )
            self.assertEqual(len(replay_calls), 5)

    def test_staged_search_ranks_train_survivors_before_full_replay(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = root / "sweep.yaml"
            sweep_config.write_text(
                yaml.safe_dump(
                    {
                        "schema_version": "torghut.replay-frontier-sweep.v1",
                        "family": "intraday_tsmom_consistent",
                        "strategy_name": "intraday-tsmom-profit-v3",
                        "disable_other_strategies": True,
                        "constraints": {
                            "holdout_target_net_per_day": "1",
                            "min_active_holdout_days": 1,
                            "max_worst_holdout_day_loss": "200",
                            "min_profit_factor": "1.0",
                        },
                        "consistency_constraints": {
                            "target_net_per_day": "1",
                            "min_active_days": 1,
                            "max_worst_day_loss": "300",
                            "max_negative_days": 1,
                            "max_drawdown": "400",
                            "require_every_day_active": False,
                        },
                        "strategy_overrides": {
                            "universe_symbols": [["NVDA"]],
                        },
                        "parameters": {
                            "long_stop_loss_bps": ["12", "14", "16"],
                        },
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=root / "frontier.json",
            )
            args.max_candidates_to_evaluate = 1
            args.staged_train_screen_multiplier = 3
            args.min_train_screen_net_per_day = "1"
            recent_days = tuple(
                date(2026, 3, 18) + timedelta(days=index) for index in range(6)
            )
            snapshot_receipt = SimpleNamespace(
                snapshot_id="snap-ranked-staged",
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    "snapshot_id": "snap-ranked-staged",
                    "source": "ta",
                    "window_size": "PT1S",
                    "start_day": "2026-03-18",
                    "end_day": "2026-03-23",
                    "expected_last_trading_day": "2026-03-23",
                    "is_fresh": True,
                    "missing_days": [],
                    "row_count": 123,
                    "stale_override_used": False,
                    "witnesses": [],
                },
            )
            full_replay_bps: list[str] = []

            def candidate_bps(config: object) -> str:
                configmap_path = Path(str(getattr(config, "strategy_configmap_path")))
                configmap = yaml.safe_load(configmap_path.read_text(encoding="utf-8"))
                strategy_payload = yaml.safe_load(configmap["data"]["strategies.yaml"])
                strategy = next(
                    item
                    for item in strategy_payload["strategies"]
                    if item["name"] == "intraday-tsmom-profit-v3"
                )
                return str(strategy["params"]["long_stop_loss_bps"])

            def fake_run_replay(config: object) -> dict[str, object]:
                start_date = str(getattr(config, "start_date"))
                end_date = str(getattr(config, "end_date"))
                bps = candidate_bps(config)
                train_net_per_day = {"12": "10", "14": "150", "16": "75"}[bps]
                daily_value = train_net_per_day if end_date == "2026-03-20" else "50"
                if end_date != "2026-03-20":
                    full_replay_bps.append(bps)
                daily_net = {
                    day.isoformat(): daily_value
                    for day in (
                        date.fromisoformat(start_date) + timedelta(days=index)
                        for index in range(
                            (
                                date.fromisoformat(end_date)
                                - date.fromisoformat(start_date)
                            ).days
                            + 1
                        )
                    )
                }
                payload = self._payload(
                    start_date=start_date,
                    end_date=end_date,
                    daily_net=daily_net,
                    decision_count=len(daily_net),
                    filled_count=len(daily_net),
                    wins=len(daily_net),
                    losses=0,
                )
                if bool(getattr(config, "capture_exact_replay_ledger", False)):
                    payload["exact_replay_ledger"] = {
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
                        "account_label": "TORGHUT_REPLAY",
                        "execution_policy_hash": "policy-sha",
                        "cost_model_hash": "cost-sha",
                        "lineage_hash": "ledger-lineage-sha",
                        "fill_row_count": 2,
                        "runtime_ledger_rows": _authoritative_exact_replay_rows(),
                    }
                return payload

            with (
                patch(
                    "scripts.search_consistent_profitability_frontier._resolve_recent_trading_days",
                    return_value=recent_days,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.build_dataset_snapshot_receipt",
                    return_value=snapshot_receipt,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.ensure_fresh_snapshot"
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.run_replay",
                    side_effect=fake_run_replay,
                ),
            ):
                payload = frontier.run_consistent_profitability_frontier(args)

            self.assertEqual(full_replay_bps, ["14", "14"])
            staged = payload["progress"]["staged_search"]
            self.assertEqual(staged["train_screen_candidates_started"], 3)
            self.assertEqual(staged["full_replay_candidates_started"], 1)
            full_replay_items = [
                item
                for item in payload["top"]
                if item["staged_search"]["stage"] == "full_replay"
            ]
            self.assertEqual(len(full_replay_items), 1)
            self.assertEqual(
                full_replay_items[0]["replay_config"]["params"]["long_stop_loss_bps"],
                "14",
            )
            self.assertEqual(
                full_replay_items[0]["staged_search"]["train_screen_survivor_rank"],
                1,
            )
            self.assertTrue(
                full_replay_items[0]["staged_search"][
                    "full_replay_selected_after_train_rank"
                ]
            )

    def test_run_frontier_respects_candidate_budget(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = self._write_sweep_config(root)
            json_output = root / "nested" / "frontier.json"
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=json_output,
            )
            args.max_candidates_to_evaluate = 1
            recent_days = tuple(
                date(2026, 3, 18) + timedelta(days=index) for index in range(6)
            )
            snapshot_receipt = SimpleNamespace(
                snapshot_id="snap-budget",
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    "snapshot_id": "snap-budget",
                    "source": "ta",
                    "window_size": "PT1S",
                    "start_day": "2026-03-18",
                    "end_day": "2026-03-23",
                    "expected_last_trading_day": "2026-03-23",
                    "is_fresh": True,
                    "missing_days": [],
                    "row_count": 123,
                    "stale_override_used": False,
                    "witnesses": [],
                },
            )

            def fake_run_replay(config: object) -> dict[str, object]:
                return self._payload(
                    start_date=str(getattr(config, "start_date")),
                    end_date=str(getattr(config, "end_date")),
                    daily_net={
                        "2026-03-18": "100",
                        "2026-03-19": "110",
                        "2026-03-20": "120",
                    },
                    decision_count=3,
                    filled_count=3,
                    wins=3,
                    losses=0,
                )

            with (
                patch(
                    "scripts.search_consistent_profitability_frontier._resolve_recent_trading_days",
                    return_value=recent_days,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.build_dataset_snapshot_receipt",
                    return_value=snapshot_receipt,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.ensure_fresh_snapshot"
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.run_replay",
                    side_effect=fake_run_replay,
                ),
            ):
                payload = frontier.run_consistent_profitability_frontier(args)

            self.assertEqual(payload["status"], "candidate_budget_exhausted")
            self.assertEqual(payload["candidate_count"], 1)
            self.assertGreater(payload["progress"]["pending_candidates"], 0)
            persisted = json.loads(json_output.read_text(encoding="utf-8"))
            self.assertEqual(persisted["status"], "candidate_budget_exhausted")

    def test_initial_worklist_streams_large_parameter_product(self) -> None:
        candidates = frontier._iter_initial_worklist_candidates(
            parameter_grid={
                "min_recent_microprice_bias_bps": list(range(10_000)),
                "min_late_day_continuation_bps": list(range(10_000)),
            },
            override_candidates=[{"universe_symbols": ["NVDA"]}],
        )

        first = next(candidates)
        second = next(candidates)

        self.assertEqual(
            first.params_candidate,
            {"min_recent_microprice_bias_bps": 0, "min_late_day_continuation_bps": 0},
        )
        self.assertEqual(
            second.params_candidate,
            {"min_recent_microprice_bias_bps": 1, "min_late_day_continuation_bps": 0},
        )
        self.assertEqual(first.strategy_overrides, {"universe_symbols": ["NVDA"]})
        self.assertEqual(second.strategy_overrides, {"universe_symbols": ["NVDA"]})
        self.assertEqual(first.search_iteration, 0)
        self.assertEqual(second.search_iteration, 0)
        self.assertEqual(first.symbol_prune_iteration, 0)
        self.assertEqual(first.loss_repair_iteration, 0)
        self.assertEqual(first.consistency_repair_iteration, 0)
        self.assertIsNone(first.pruned_symbol)
        self.assertIsNone(second.pruned_symbol)
        self.assertIsNone(first.repair_reason)
        self.assertIsNone(second.repair_reason)
        self.assertIsNone(first.parent_candidate_id)
        self.assertIsNone(second.parent_candidate_id)

    def test_parameter_stream_prioritizes_entry_gates_for_small_budgets(self) -> None:
        candidates = frontier._iter_parameter_candidates(
            {
                "long_stop_loss_bps": ["20", "24"],
                "min_cross_section_continuation_rank": ["0.60", "0.70"],
                "entry_cooldown_seconds": ["3600", "7200"],
            }
        )

        first = next(candidates)
        second = next(candidates)
        third = next(candidates)

        self.assertEqual(first["min_cross_section_continuation_rank"], "0.60")
        self.assertEqual(second["min_cross_section_continuation_rank"], "0.70")
        self.assertEqual(second["long_stop_loss_bps"], "20")
        self.assertEqual(third["long_stop_loss_bps"], "24")

    def test_parameter_stream_prioritizes_entry_hypotheses_before_thresholds(
        self,
    ) -> None:
        self.assertEqual(frontier._parameter_exploration_priority("bullish_hist"), 3)
        candidates = frontier._iter_parameter_candidates(
            {
                "min_cross_section_continuation_rank": ["0.60", "0.70"],
                "rank_feature": [
                    "cross_section_vwap_w5m_rank",
                    "cross_section_session_open_rank",
                ],
                "top_n": ["1", "5"],
                "signal_motif": [
                    "vwap_close_continuation",
                    "open_window_continuation",
                ],
                "entry_cooldown_seconds": ["600", "900"],
            }
        )

        first = next(candidates)
        second = next(candidates)
        third = next(candidates)
        fourth = next(candidates)
        fifth = next(candidates)

        self.assertEqual(first["rank_feature"], "cross_section_vwap_w5m_rank")
        self.assertEqual(second["rank_feature"], "cross_section_session_open_rank")
        self.assertEqual(third["top_n"], "5")
        self.assertEqual(fourth["signal_motif"], "open_window_continuation")
        self.assertEqual(fifth["min_cross_section_continuation_rank"], "0.70")
