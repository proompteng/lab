from __future__ import annotations

# ruff: noqa: F403,F405
from tests.profitability_frontier.search_frontier_base import *


class TestSearchFrontierMainB(SearchConsistentProfitabilityFrontierTestCaseBase):
    def test_run_frontier_interleaves_initial_grid_with_repair_worklist(self) -> None:
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
                            "long_stop_loss_bps": ["12", "18"],
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
            args.max_candidates_to_evaluate = 3
            args.consistency_repair_iterations = 1
            args.consistency_repair_candidates = 2
            recent_days = tuple(
                date(2026, 3, 18) + timedelta(days=index) for index in range(6)
            )
            snapshot_receipt = SimpleNamespace(
                snapshot_id="snap-interleave",
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    "snapshot_id": "snap-interleave",
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
            full_window_stops: list[str] = []

            def fake_run_replay(config: object) -> dict[str, object]:
                configmap_path = Path(getattr(config, "strategy_configmap_path"))
                payload = yaml.safe_load(configmap_path.read_text(encoding="utf-8"))
                strategy = next(
                    item
                    for item in yaml.safe_load(payload["data"]["strategies.yaml"])[
                        "strategies"
                    ]
                    if item["name"] == "intraday-tsmom-profit-v3"
                )
                stop = str(strategy["params"]["long_stop_loss_bps"])
                start_date = str(getattr(config, "start_date"))
                end_date = str(getattr(config, "end_date"))
                if start_date == "2026-03-18" and end_date == "2026-03-23":
                    full_window_stops.append(stop)
                start = date.fromisoformat(start_date)
                end = date.fromisoformat(end_date)
                days = {
                    (start + timedelta(days=index)).isoformat(): "100"
                    for index in range((end - start).days + 1)
                }
                return self._payload(
                    start_date=start_date,
                    end_date=end_date,
                    daily_net=days,
                    decision_count=len(days),
                    filled_count=len(days),
                    wins=len(days),
                    losses=0,
                )

            def fake_consistency_children(
                **kwargs: object,
            ) -> list[tuple[str, dict[str, str], dict[str, object]]]:
                params = cast(dict[str, object], kwargs["params_candidate"])
                if params.get("long_stop_loss_bps") != "12":
                    return []
                return [
                    (
                        "consistency_signal_thresholds:active_day_ratio_below_min",
                        {"long_stop_loss_bps": "13"},
                        {},
                    ),
                    (
                        "consistency_breadth:active_day_ratio_below_min",
                        {"long_stop_loss_bps": "14"},
                        {},
                    ),
                ]

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
                patch(
                    "scripts.search_consistent_profitability_frontier._generate_consistency_repair_children",
                    side_effect=fake_consistency_children,
                ),
            ):
                payload = frontier.run_consistent_profitability_frontier(args)

        self.assertEqual(payload["status"], "candidate_budget_exhausted")
        self.assertEqual(full_window_stops, ["12", "13", "18"])

    def test_main_symbol_pruning_promotes_pruned_universe(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = root / "sweep.yaml"
            sweep_config.write_text(
                yaml.safe_dump(
                    {
                        "schema_version": "torghut.replay-frontier-sweep.v1",
                        "family": "breakout_reclaim",
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
                            "require_every_day_active": False,
                        },
                        "strategy_overrides": {
                            "universe_symbols": [["NVDA", "AVGO"]],
                        },
                        "parameters": {
                            "long_stop_loss_bps": ["12"],
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
            args.symbol_prune_iterations = 1
            args.symbol_prune_candidates = 1
            args.symbol_prune_min_universe_size = 1
            recent_days = tuple(
                date(2026, 3, 18) + timedelta(days=index) for index in range(6)
            )
            snapshot_receipt = SimpleNamespace(
                snapshot_id="snap-prune",
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    "snapshot_id": "snap-prune",
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
                configmap_path = Path(getattr(config, "strategy_configmap_path"))
                payload = yaml.safe_load(configmap_path.read_text(encoding="utf-8"))
                strategy = next(
                    item
                    for item in yaml.safe_load(payload["data"]["strategies.yaml"])[
                        "strategies"
                    ]
                    if item["name"] == "intraday-tsmom-profit-v3"
                )
                universe = tuple(strategy.get("universe_symbols") or [])
                start_date = str(getattr(config, "start_date"))
                end_date = str(getattr(config, "end_date"))

                if universe == ("NVDA",):
                    daily_net = {
                        "2026-03-18": "240",
                        "2026-03-19": "260",
                        "2026-03-20": "250",
                        "2026-03-21": "280",
                        "2026-03-22": "270",
                        "2026-03-23": "275",
                    }
                    funnel = {
                        "buckets": [
                            {
                                "trading_day": day,
                                "symbol": "NVDA",
                                "filled_count": 1,
                                "net_pnl": value,
                                "cost_total": "5",
                            }
                            for day, value in daily_net.items()
                        ]
                    }
                else:
                    daily_net = {
                        "2026-03-18": "240",
                        "2026-03-19": "260",
                        "2026-03-20": "250",
                        "2026-03-21": "60",
                        "2026-03-22": "-220",
                        "2026-03-23": "290",
                    }
                    funnel = {
                        "buckets": [
                            {
                                "trading_day": "2026-03-22",
                                "symbol": "AVGO",
                                "filled_count": 1,
                                "net_pnl": "-260",
                                "cost_total": "10",
                            },
                            {
                                "trading_day": "2026-03-21",
                                "symbol": "AVGO",
                                "filled_count": 1,
                                "net_pnl": "20",
                                "cost_total": "5",
                            },
                            {
                                "trading_day": "2026-03-18",
                                "symbol": "NVDA",
                                "filled_count": 1,
                                "net_pnl": "240",
                                "cost_total": "5",
                            },
                        ]
                    }

                if start_date == "2026-03-18" and end_date == "2026-03-20":
                    subset = {
                        day: daily_net[day]
                        for day in ("2026-03-18", "2026-03-19", "2026-03-20")
                    }
                elif start_date == "2026-03-21" and end_date == "2026-03-23":
                    subset = {
                        day: daily_net[day]
                        for day in ("2026-03-21", "2026-03-22", "2026-03-23")
                    }
                else:
                    subset = daily_net
                payload = self._payload(
                    start_date=start_date,
                    end_date=end_date,
                    daily_net=subset,
                    decision_count=3,
                    filled_count=3,
                    wins=2,
                    losses=1,
                )
                payload["funnel"] = funnel
                return payload

            stdout = io.StringIO()
            with (
                patch(
                    "scripts.search_consistent_profitability_frontier._parse_args",
                    return_value=args,
                ),
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
                redirect_stdout(stdout),
            ):
                exit_code = frontier.main()

            self.assertEqual(exit_code, 0)
            payload = json.loads(json_output.read_text(encoding="utf-8"))
            top = payload["top"][0]
            self.assertEqual(
                top["replay_config"]["strategy_overrides"]["universe_symbols"], ["NVDA"]
            )
            self.assertEqual(top["search_iteration"], 1)
            self.assertEqual(top["pruned_symbol"], "AVGO")

    def test_main_chains_loss_repair_into_consistency_repair_with_one_iteration_each(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = root / "strategy-configmap.yaml"
            strategy_configmap.write_text(
                yaml.safe_dump(
                    {
                        "apiVersion": "v1",
                        "kind": "ConfigMap",
                        "data": {
                            "strategies.yaml": yaml.safe_dump(
                                {
                                    "strategies": [
                                        {
                                            "name": "intraday-tsmom-profit-v3",
                                            "enabled": True,
                                            "max_notional_per_trade": "25000",
                                            "max_position_pct_equity": "0.50",
                                            "universe_symbols": ["NVDA", "AMAT"],
                                            "params": {
                                                "long_stop_loss_bps": "12",
                                                "max_gross_exposure_pct_equity": "1.0",
                                                "max_entries_per_session": "1",
                                                "top_n": "2",
                                                "entry_cooldown_seconds": "300",
                                            },
                                        }
                                    ]
                                },
                                sort_keys=False,
                            )
                        },
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
            sweep_config = root / "sweep.yaml"
            sweep_config.write_text(
                yaml.safe_dump(
                    {
                        "schema_version": "torghut.replay-frontier-sweep.v1",
                        "family": "intraday_tsmom_consistent",
                        "strategy_name": "intraday-tsmom-profit-v3",
                        "disable_other_strategies": True,
                        "constraints": {
                            "holdout_target_net_per_day": "100",
                            "min_active_holdout_days": 1,
                            "max_worst_holdout_day_loss": "300",
                            "min_profit_factor": "1.0",
                        },
                        "consistency_constraints": {
                            "target_net_per_day": "100",
                            "min_active_days": 6,
                            "min_active_ratio": "1",
                            "max_worst_day_loss": "200",
                            "max_negative_days": 0,
                            "max_drawdown": "300",
                            "max_best_day_share_of_total_pnl": "1",
                            "max_gross_exposure_pct_equity": "1",
                            "min_cash": "0",
                            "require_every_day_active": True,
                        },
                        "strategy_overrides": {
                            "universe_symbols": [["NVDA", "AMAT"]],
                        },
                        "parameters": {
                            "long_stop_loss_bps": ["12"],
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
            args.max_candidates_to_evaluate = 4
            args.loss_repair_iterations = 1
            args.loss_repair_candidates = 1
            args.consistency_repair_iterations = 1
            args.consistency_repair_candidates = 2
            args.train_screening = False
            recent_days = tuple(
                date(2026, 3, 18) + timedelta(days=index) for index in range(6)
            )
            snapshot_receipt = SimpleNamespace(
                snapshot_id="snap-repair-chain",
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    "snapshot_id": "snap-repair-chain",
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
                configmap_path = Path(getattr(config, "strategy_configmap_path"))
                payload = yaml.safe_load(configmap_path.read_text(encoding="utf-8"))
                strategy = next(
                    item
                    for item in yaml.safe_load(payload["data"]["strategies.yaml"])[
                        "strategies"
                    ]
                    if item["name"] == "intraday-tsmom-profit-v3"
                )
                params = strategy.get("params") or {}
                stop_loss = str(params.get("long_stop_loss_bps") or "")
                max_entries = str(params.get("max_entries_per_session") or "")
                top_n = str(params.get("top_n") or "")
                start_date = str(getattr(config, "start_date"))
                end_date = str(getattr(config, "end_date"))
                full_window = start_date == "2026-03-18" and end_date == "2026-03-23"

                if full_window and stop_loss == "12":
                    daily_net = {
                        "2026-03-18": "350",
                        "2026-03-19": "350",
                        "2026-03-20": "350",
                        "2026-03-21": "350",
                        "2026-03-22": "350",
                        "2026-03-23": "-500",
                    }
                    max_gross = "1.40"
                    min_cash = "-100"
                elif full_window and (max_entries == "2" or top_n == "3"):
                    daily_net = {
                        "2026-03-18": "130",
                        "2026-03-19": "130",
                        "2026-03-20": "130",
                        "2026-03-21": "130",
                        "2026-03-22": "130",
                        "2026-03-23": "130",
                    }
                    max_gross = "0.80"
                    min_cash = "500"
                elif full_window:
                    daily_net = {
                        "2026-03-18": "180",
                        "2026-03-19": "180",
                        "2026-03-20": "180",
                        "2026-03-21": "0",
                        "2026-03-22": "0",
                        "2026-03-23": "0",
                    }
                    max_gross = "0.80"
                    min_cash = "500"
                else:
                    daily_net = {
                        "2026-03-18": "140",
                        "2026-03-19": "140",
                        "2026-03-20": "140",
                        "2026-03-21": "140",
                        "2026-03-22": "140",
                        "2026-03-23": "140",
                    }
                    max_gross = "0.80"
                    min_cash = "500"

                subset = {
                    day: value
                    for day, value in daily_net.items()
                    if start_date <= day <= end_date
                }
                replay_payload = self._payload(
                    start_date=start_date,
                    end_date=end_date,
                    daily_net=subset,
                    daily_filled_notional={
                        day: "200000" if value != "0" else "0"
                        for day, value in subset.items()
                    },
                    decision_count=max(1, len(subset)),
                    filled_count=sum(1 for value in subset.values() if value != "0"),
                    wins=sum(1 for value in subset.values() if float(value) > 0),
                    losses=sum(1 for value in subset.values() if float(value) < 0),
                )
                replay_payload["max_gross_exposure_pct_equity"] = max_gross
                replay_payload["min_cash"] = min_cash
                replay_payload["negative_cash_observation_count"] = 0
                return replay_payload

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

            by_id = {str(item["candidate_id"]): item for item in payload["top"]}
            consistency_reasons = {
                item.get("consistency_repair_reason") for item in payload["top"]
            }
            self.assertIn(
                "consistency_entries:active_day_ratio_below_min",
                consistency_reasons,
            )
            self.assertIn(
                "consistency_breadth:active_day_ratio_below_min",
                consistency_reasons,
            )
            chained = next(
                item
                for item in payload["top"]
                if item.get("consistency_repair_reason")
                == "consistency_entries:active_day_ratio_below_min"
            )
            parent = by_id[str(chained["parent_candidate_id"])]
            self.assertEqual(parent["loss_repair_iteration"], 1)
            self.assertEqual(parent["consistency_repair_iteration"], 0)
            self.assertEqual(chained["loss_repair_iteration"], 1)
            self.assertEqual(chained["consistency_repair_iteration"], 1)
            self.assertEqual(chained["search_iteration"], 2)

    def test_main_adds_concentration_hard_vetoes(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = root / "sweep.yaml"
            sweep_config.write_text(
                yaml.safe_dump(
                    {
                        "schema_version": "torghut.replay-frontier-sweep.v1",
                        "family": "breakout_reclaim",
                        "strategy_name": "intraday-tsmom-profit-v3",
                        "disable_other_strategies": True,
                        "constraints": {
                            "holdout_target_net_per_day": "100",
                            "min_active_holdout_days": 1,
                            "max_worst_holdout_day_loss": "500",
                            "min_profit_factor": "1.0",
                        },
                        "consistency_constraints": {
                            "target_net_per_day": "100",
                            "min_active_days": 1,
                            "max_worst_day_loss": "500",
                            "max_negative_days": 3,
                            "max_drawdown": "800",
                            "require_every_day_active": False,
                            "max_symbol_concentration_share": "0.50",
                            "max_entry_family_contribution_share": "0.50",
                        },
                        "strategy_overrides": {
                            "universe_symbols": [["NVDA", "AMAT"]],
                        },
                        "parameters": {
                            "long_stop_loss_bps": ["12"],
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
            recent_days = tuple(
                date(2026, 3, 18) + timedelta(days=index) for index in range(6)
            )
            snapshot_receipt = SimpleNamespace(
                snapshot_id="snap-veto",
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    "snapshot_id": "snap-veto",
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
                start_date = str(getattr(config, "start_date"))
                end_date = str(getattr(config, "end_date"))
                if start_date == "2026-03-18" and end_date == "2026-03-20":
                    daily_net = {
                        "2026-03-18": "200",
                        "2026-03-19": "180",
                        "2026-03-20": "160",
                    }
                else:
                    daily_net = {
                        "2026-03-21": "220",
                        "2026-03-22": "210",
                        "2026-03-23": "205",
                    }
                payload = self._payload(
                    start_date=start_date,
                    end_date=end_date,
                    daily_net=daily_net,
                    decision_count=3,
                    filled_count=3,
                    wins=3,
                    losses=0,
                )
                payload["trace"] = []
                return payload

            fake_decomposition = SimpleNamespace(
                to_payload=lambda: {"families": {}, "symbols": {}},
            )
            stdout = io.StringIO()
            with (
                patch(
                    "scripts.search_consistent_profitability_frontier._parse_args",
                    return_value=args,
                ),
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
                patch(
                    "scripts.search_consistent_profitability_frontier.build_replay_decomposition",
                    return_value=fake_decomposition,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.regime_slice_pass_rate",
                    return_value=Decimal("1"),
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.max_symbol_concentration_share",
                    return_value=Decimal("0.90"),
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.max_family_contribution_share",
                    return_value=Decimal("0.90"),
                ),
                redirect_stdout(stdout),
            ):
                exit_code = frontier.main()

            self.assertEqual(exit_code, 0)
            payload = json.loads(json_output.read_text(encoding="utf-8"))
            self.assertIn(
                "symbol_concentration_above_max", payload["top"][0]["hard_vetoes"]
            )
            self.assertIn(
                "entry_family_contribution_above_max", payload["top"][0]["hard_vetoes"]
            )

    def test_main_keeps_min_active_days_disabled_for_widened_full_window(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = root / "widened-sweep.yaml"
            sweep_config.write_text(
                yaml.safe_dump(
                    {
                        "schema_version": "torghut.replay-frontier-sweep.v1",
                        "family": "intraday_tsmom_consistent",
                        "strategy_name": "intraday-tsmom-profit-v3",
                        "disable_other_strategies": True,
                        "constraints": {
                            "holdout_target_net_per_day": "100",
                            "min_active_holdout_days": 1,
                            "max_worst_holdout_day_loss": "500",
                            "min_profit_factor": "1.0",
                        },
                        "consistency_constraints": {
                            "target_net_per_day": "100",
                            "min_active_ratio": "0",
                            "max_worst_day_loss": "500",
                            "max_negative_days": 7,
                            "max_drawdown": "900",
                            "require_every_day_active": False,
                        },
                        "strategy_overrides": {
                            "universe_symbols": [["NVDA"]],
                        },
                        "parameters": {
                            "long_stop_loss_bps": ["12"],
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
            args.full_window_start_date = "2026-03-17"
            args.full_window_end_date = "2026-03-23"
            recent_days = tuple(
                date(2026, 3, 18) + timedelta(days=index) for index in range(6)
            )
            snapshot_receipt = SimpleNamespace(
                snapshot_id="snap-wide",
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    "snapshot_id": "snap-wide",
                    "source": "ta",
                    "window_size": "PT1S",
                    "start_day": "2026-03-17",
                    "end_day": "2026-03-23",
                    "expected_last_trading_day": "2026-03-23",
                    "is_fresh": True,
                    "missing_days": [],
                    "row_count": 321,
                    "stale_override_used": False,
                    "witnesses": [],
                },
            )

            daily_net = {
                "2026-03-17": "90",
                "2026-03-18": "110",
                "2026-03-19": "95",
                "2026-03-20": "120",
                "2026-03-21": "130",
                "2026-03-22": "115",
                "2026-03-23": "125",
            }

            def fake_run_replay(config: object) -> dict[str, object]:
                start_date = str(getattr(config, "start_date"))
                end_date = str(getattr(config, "end_date"))
                subset = {
                    day: value
                    for day, value in daily_net.items()
                    if start_date <= day <= end_date
                }
                return self._payload(
                    start_date=start_date,
                    end_date=end_date,
                    daily_net=subset,
                    decision_count=max(1, len(subset)),
                    filled_count=max(1, len(subset)),
                    wins=max(1, len(subset)),
                    losses=0,
                )

            stdout = io.StringIO()
            with (
                patch(
                    "scripts.search_consistent_profitability_frontier._parse_args",
                    return_value=args,
                ),
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
                redirect_stdout(stdout),
            ):
                exit_code = frontier.main()

            self.assertEqual(exit_code, 0)
            payload = json.loads(json_output.read_text(encoding="utf-8"))
            self.assertEqual(
                payload["constraints"]["consistency"]["min_active_days"], 0
            )
