from __future__ import annotations

from tests.profitability_frontier.search_frontier_base import (
    Decimal,
    Path,
    SearchConsistentProfitabilityFrontierTestCaseBase,
    SignalEnvelope,
    SimpleNamespace,
    TemporaryDirectory,
    build_source_query_digest,
    date,
    datetime,
    frontier,
    io,
    json,
    materialize_signal_tape,
    patch,
    redirect_stdout,
    timedelta,
    timezone,
    yaml,
)


class TestSearchFrontierMainA(SearchConsistentProfitabilityFrontierTestCaseBase):
    def test_main_prefers_consistent_candidate_over_prettier_holdout(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = self._write_sweep_config(root)
            json_output = root / "frontier.json"
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=json_output,
            )
            tape_path = root / "full-window-tape.jsonl"
            tape_rows = [
                SignalEnvelope(
                    event_ts=datetime(2026, 3, day, 17, 30, tzinfo=timezone.utc),
                    symbol=symbol,
                    timeframe="1Sec",
                    seq=seq,
                    source="ta",
                    payload={"price": Decimal("900.00")},
                )
                for seq, (day, symbol) in enumerate(
                    (
                        (18, "NVDA"),
                        (18, "AMAT"),
                        (19, "NVDA"),
                        (19, "AMAT"),
                        (20, "NVDA"),
                        (20, "AMAT"),
                        (21, "NVDA"),
                        (21, "AMAT"),
                        (22, "NVDA"),
                        (22, "AMAT"),
                        (23, "NVDA"),
                        (23, "AMAT"),
                    ),
                    start=1,
                )
            ]
            materialize_signal_tape(
                rows=tape_rows,
                tape_path=tape_path,
                dataset_snapshot_ref="snapshot-test",
                symbols=("NVDA", "AMAT"),
                start_date=date(2026, 3, 18),
                end_date=date(2026, 3, 23),
                source_query_digest=build_source_query_digest({"query": "frontier"}),
            )
            args.replay_tape_path = tape_path
            args.replay_tape_manifest = None

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
                if start_date == "2026-03-18" and end_date == "2026-03-20":
                    return self._payload(
                        start_date="2026-03-18",
                        end_date="2026-03-20",
                        daily_net={
                            "2026-03-18": "80",
                            "2026-03-19": "90",
                            "2026-03-20": "85",
                        },
                        decision_count=3,
                        filled_count=3,
                        wins=3,
                        losses=0,
                    )
                if start_date == "2026-03-21" and end_date == "2026-03-23":
                    if stop == "12":
                        return self._payload(
                            start_date="2026-03-21",
                            end_date="2026-03-23",
                            daily_net={
                                "2026-03-21": "450",
                                "2026-03-22": "0",
                                "2026-03-23": "0",
                            },
                            decision_count=1,
                            filled_count=1,
                            wins=1,
                            losses=0,
                        )
                    return self._payload(
                        start_date="2026-03-21",
                        end_date="2026-03-23",
                        daily_net={
                            "2026-03-21": "220",
                            "2026-03-22": "210",
                            "2026-03-23": "205",
                        },
                        decision_count=3,
                        filled_count=3,
                        wins=3,
                        losses=0,
                    )
                if stop == "12":
                    return self._payload(
                        start_date="2026-03-18",
                        end_date="2026-03-23",
                        daily_net={
                            "2026-03-18": "80",
                            "2026-03-19": "90",
                            "2026-03-20": "85",
                            "2026-03-21": "450",
                            "2026-03-22": "0",
                            "2026-03-23": "0",
                        },
                        decision_count=4,
                        filled_count=4,
                        wins=4,
                        losses=0,
                    )
                return self._payload(
                    start_date="2026-03-18",
                    end_date="2026-03-23",
                    daily_net={
                        "2026-03-18": "80",
                        "2026-03-19": "90",
                        "2026-03-20": "85",
                        "2026-03-21": "220",
                        "2026-03-22": "210",
                        "2026-03-23": "205",
                    },
                    decision_count=6,
                    filled_count=6,
                    wins=6,
                    losses=0,
                )

            stdout = io.StringIO()
            with (
                patch(
                    "scripts.search_consistent_profitability_frontier._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.consistent_profitability_frontier.workflow_setup._resolve_recent_trading_days",
                    side_effect=AssertionError("unexpected ClickHouse recent-day call"),
                ),
                patch(
                    "scripts.consistent_profitability_frontier.workflow_setup.build_dataset_snapshot_receipt",
                    side_effect=AssertionError("unexpected ClickHouse snapshot call"),
                ),
                patch(
                    "scripts.consistent_profitability_frontier.workflow_orchestration.run_replay",
                    side_effect=fake_run_replay,
                ),
                redirect_stdout(stdout),
            ):
                exit_code = frontier.main()

            self.assertEqual(exit_code, 0)
            payload = json.loads(json_output.read_text(encoding="utf-8"))
            stdout_payload = json.loads(stdout.getvalue())
            self.assertEqual(payload, stdout_payload)
            top = payload["top"][0]
            self.assertEqual(top["replay_config"]["params"]["long_stop_loss_bps"], "18")
            self.assertEqual(top["full_window"]["active_days"], 6)
            self.assertEqual(
                payload["dataset_snapshot_receipt"]["snapshot_id"], "snapshot-test"
            )
            self.assertEqual(
                payload["dataset_snapshot_receipt"]["source"], "replay_tape"
            )
            self.assertEqual(payload["replay_tape"]["status"], "valid")
            self.assertEqual(payload["replay_tape"]["selected_row_count"], 12)
            self.assertEqual(top["ranking"]["method"], "pareto_frontier_v2")
            self.assertEqual(top["family_template_id"], "intraday_tsmom_v2")

    def test_run_frontier_vetoes_candidate_that_fails_second_oos(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = self._write_sweep_config(root)
            json_output = root / "frontier.json"
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=json_output,
            )
            args.second_oos_days = 2
            args.collect_train_gate_diagnostics = True
            recent_days = tuple(
                date(2026, 3, 18) + timedelta(days=index) for index in range(8)
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
                stop = str(strategy["params"]["long_stop_loss_bps"])
                start_date = str(getattr(config, "start_date"))
                end_date = str(getattr(config, "end_date"))
                if start_date == "2026-03-24" and end_date == "2026-03-25":
                    if stop == "12":
                        return self._payload(
                            start_date=start_date,
                            end_date=end_date,
                            daily_net={"2026-03-24": "-250", "2026-03-25": "0"},
                            daily_liquidity_notional={
                                "2026-03-24": "1000000",
                                "2026-03-25": "1000000",
                            },
                            decision_count=1,
                            filled_count=1,
                            wins=0,
                            losses=1,
                        )
                    return self._payload(
                        start_date=start_date,
                        end_date=end_date,
                        daily_net={"2026-03-24": "240", "2026-03-25": "230"},
                        daily_liquidity_notional={
                            "2026-03-24": "1000000",
                            "2026-03-25": "1000000",
                        },
                        decision_count=2,
                        filled_count=2,
                        wins=2,
                        losses=0,
                    )
                if start_date == "2026-03-21" and end_date == "2026-03-23":
                    return self._payload(
                        start_date=start_date,
                        end_date=end_date,
                        daily_net=(
                            {
                                "2026-03-21": "500",
                                "2026-03-22": "510",
                                "2026-03-23": "520",
                            }
                            if stop == "12"
                            else {
                                "2026-03-21": "220",
                                "2026-03-22": "210",
                                "2026-03-23": "205",
                            }
                        ),
                        daily_liquidity_notional={
                            "2026-03-21": "1000000",
                            "2026-03-22": "1000000",
                            "2026-03-23": "1000000",
                        },
                        decision_count=3,
                        filled_count=3,
                        wins=3,
                        losses=0,
                    )
                if start_date == "2026-03-18" and end_date == "2026-03-20":
                    return self._payload(
                        start_date=start_date,
                        end_date=end_date,
                        daily_net={
                            "2026-03-18": "90",
                            "2026-03-19": "95",
                            "2026-03-20": "100",
                        },
                        daily_liquidity_notional={
                            "2026-03-18": "1000000",
                            "2026-03-19": "1000000",
                            "2026-03-20": "1000000",
                        },
                        decision_count=3,
                        filled_count=3,
                        wins=3,
                        losses=0,
                    )
                return self._payload(
                    start_date=start_date,
                    end_date=end_date,
                    daily_net=(
                        {
                            "2026-03-18": "90",
                            "2026-03-19": "95",
                            "2026-03-20": "100",
                            "2026-03-21": "500",
                            "2026-03-22": "510",
                            "2026-03-23": "520",
                            "2026-03-24": "-250",
                            "2026-03-25": "0",
                        }
                        if stop == "12"
                        else {
                            "2026-03-18": "90",
                            "2026-03-19": "95",
                            "2026-03-20": "100",
                            "2026-03-21": "220",
                            "2026-03-22": "210",
                            "2026-03-23": "205",
                            "2026-03-24": "240",
                            "2026-03-25": "230",
                        }
                    ),
                    daily_liquidity_notional={
                        "2026-03-18": "1000000",
                        "2026-03-19": "1000000",
                        "2026-03-20": "1000000",
                        "2026-03-21": "1000000",
                        "2026-03-22": "1000000",
                        "2026-03-23": "1000000",
                        "2026-03-24": "1000000",
                        "2026-03-25": "1000000",
                    },
                    decision_count=8,
                    filled_count=8,
                    wins=7,
                    losses=1 if stop == "12" else 0,
                )

            snapshot_receipt = SimpleNamespace(
                snapshot_id="snap-second-oos",
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    "snapshot_id": "snap-second-oos",
                    "source": "ta",
                    "window_size": "PT1S",
                    "start_day": "2026-03-18",
                    "end_day": "2026-03-25",
                    "expected_last_trading_day": "2026-03-25",
                    "is_fresh": True,
                    "missing_days": [],
                    "row_count": 123,
                    "stale_override_used": False,
                    "witnesses": [],
                },
            )
            with (
                patch(
                    "scripts.consistent_profitability_frontier.workflow_setup._resolve_recent_trading_days",
                    return_value=recent_days,
                ),
                patch(
                    "scripts.consistent_profitability_frontier.workflow_setup.build_dataset_snapshot_receipt",
                    return_value=snapshot_receipt,
                ),
                patch(
                    "scripts.consistent_profitability_frontier.workflow_setup.ensure_fresh_snapshot"
                ),
                patch(
                    "scripts.consistent_profitability_frontier.workflow_orchestration.run_replay",
                    side_effect=fake_run_replay,
                ),
            ):
                payload = frontier.run_consistent_profitability_frontier(args)

            self.assertEqual(
                payload["window"]["second_oos_days"], ["2026-03-24", "2026-03-25"]
            )
            self.assertEqual(
                payload["constraints"]["second_oos"]["min_independent_window_count"],
                2,
            )
            top_by_stop = {
                str(row["replay_config"]["params"]["long_stop_loss_bps"]): row
                for row in payload["top"]
            }
            self.assertTrue(top_by_stop["18"]["second_oos"]["passed"])
            self.assertEqual(
                top_by_stop["18"]["second_oos_gate_diagnostics"]["status"],
                "no_runtime_trace_evaluations",
            )
            self.assertTrue(
                top_by_stop["18"]["full_window"][
                    "market_impact_liquidity_evidence_present"
                ]
            )
            self.assertEqual(
                top_by_stop["18"]["full_window"]["market_impact_liquidity_day_count"],
                8,
            )
            self.assertEqual(
                top_by_stop["18"]["second_oos"]["market_impact_liquidity_day_count"],
                2,
            )
            self.assertTrue(
                top_by_stop["18"]["objective_scorecard"][
                    "market_impact_liquidity_evidence_present"
                ]
            )
            self.assertEqual(
                top_by_stop["18"]["objective_scorecard"]["market_impact_stress_model"],
                "square_root",
            )
            self.assertEqual(
                top_by_stop["18"]["objective_scorecard"][
                    "market_impact_stress_components"
                ]["source_marker"],
                "realistic_market_impact_arxiv_2603_29086_2026",
            )
            self.assertIn(
                "double_square_root_impact_arxiv_2502_16246_2025",
                top_by_stop["18"]["objective_scorecard"][
                    "market_impact_stress_components"
                ]["source_markers"],
            )
            self.assertTrue(
                top_by_stop["18"]["objective_scorecard"][
                    "nonlinear_market_impact_stress_passed"
                ]
            )
            self.assertIn(
                "market_impact_stress_net_pnl_per_day",
                top_by_stop["18"]["objective_scorecard"],
            )
            self.assertEqual(
                top_by_stop["18"]["objective_scorecard"][
                    "delay_adjusted_depth_stress_model"
                ],
                "latency_depth_haircut",
            )
            self.assertIn(
                "delay_adjusted_depth_stress_net_pnl_per_day",
                top_by_stop["18"]["objective_scorecard"],
            )
            self.assertTrue(
                top_by_stop["18"]["objective_scorecard"]["double_oos_passed"]
            )
            self.assertFalse(top_by_stop["12"]["second_oos"]["passed"])
            self.assertIn(
                "second_oos_net_per_day_below_target",
                top_by_stop["12"]["hard_vetoes"],
            )
            self.assertEqual(
                top_by_stop["12"]["objective_scorecard"][
                    "double_oos_independent_window_count"
                ],
                2,
            )

    def test_run_frontier_writes_partial_json_output_between_candidates(self) -> None:
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
            json_output = root / "frontier.json"
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=json_output,
            )
            args.min_train_screen_net_per_day = "1"
            args.collect_train_gate_diagnostics = True
            recent_days = tuple(
                date(2026, 3, 18) + timedelta(days=index) for index in range(6)
            )
            snapshot_receipt = SimpleNamespace(
                snapshot_id="snap-partial",
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    "snapshot_id": "snap-partial",
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
            replay_call_count = {"count": 0}

            def fake_run_replay(config: object) -> dict[str, object]:
                replay_call_count["count"] += 1
                if replay_call_count["count"] == 4:
                    partial_payload = json.loads(
                        json_output.read_text(encoding="utf-8")
                    )
                    self.assertEqual(partial_payload["status"], "running")
                    self.assertEqual(partial_payload["candidate_count"], 1)
                    self.assertEqual(
                        partial_payload["progress"]["evaluated_candidates"], 1
                    )
                    self.assertGreaterEqual(
                        partial_payload["progress"]["pending_candidates"], 0
                    )
                    self.assertEqual(len(partial_payload["top"]), 1)

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
                if start_date == "2026-03-18" and end_date == "2026-03-20":
                    daily_net = (
                        {"2026-03-18": "90", "2026-03-19": "95", "2026-03-20": "100"}
                        if stop == "18"
                        else {
                            "2026-03-18": "60",
                            "2026-03-19": "55",
                            "2026-03-20": "50",
                        }
                    )
                elif start_date == "2026-03-21" and end_date == "2026-03-23":
                    daily_net = (
                        {"2026-03-21": "220", "2026-03-22": "210", "2026-03-23": "205"}
                        if stop == "18"
                        else {
                            "2026-03-21": "120",
                            "2026-03-22": "115",
                            "2026-03-23": "110",
                        }
                    )
                else:
                    daily_net = (
                        {
                            "2026-03-18": "90",
                            "2026-03-19": "95",
                            "2026-03-20": "100",
                            "2026-03-21": "220",
                            "2026-03-22": "210",
                            "2026-03-23": "205",
                        }
                        if stop == "18"
                        else {
                            "2026-03-18": "60",
                            "2026-03-19": "55",
                            "2026-03-20": "50",
                            "2026-03-21": "120",
                            "2026-03-22": "115",
                            "2026-03-23": "110",
                        }
                    )
                replay_payload = self._payload(
                    start_date=start_date,
                    end_date=end_date,
                    daily_net=daily_net,
                    decision_count=3,
                    filled_count=3,
                    wins=3,
                    losses=0,
                )
                if getattr(config, "capture_trace_funnel", False):
                    replay_payload["funnel"] = {
                        "buckets": [
                            {
                                "strategy_evaluations": 2,
                                "passed_trace_count": 0,
                                "first_failed_gate_counts": {
                                    "breakout:confirmation": 2
                                },
                            }
                        ]
                    }
                return replay_payload

            with (
                patch(
                    "scripts.consistent_profitability_frontier.workflow_setup._resolve_recent_trading_days",
                    return_value=recent_days,
                ),
                patch(
                    "scripts.consistent_profitability_frontier.workflow_setup.build_dataset_snapshot_receipt",
                    return_value=snapshot_receipt,
                ),
                patch(
                    "scripts.consistent_profitability_frontier.workflow_setup.ensure_fresh_snapshot"
                ),
                patch(
                    "scripts.consistent_profitability_frontier.workflow_orchestration.run_replay",
                    side_effect=fake_run_replay,
                ),
            ):
                payload = frontier.run_consistent_profitability_frontier(args)

            self.assertEqual(payload["status"], "completed")
            self.assertEqual(payload["candidate_count"], 2)
            self.assertEqual(
                payload["top"][0]["train_gate_diagnostics"]["status"], "available"
            )
            self.assertEqual(
                payload["top"][0]["holdout_gate_diagnostics"]["status"], "available"
            )
            self.assertEqual(
                payload["top"][0]["full_window_gate_diagnostics"]["status"],
                "available",
            )
            persisted = json.loads(json_output.read_text(encoding="utf-8"))
            self.assertEqual(persisted["status"], "completed")
            self.assertEqual(persisted["candidate_count"], 2)

    def test_run_frontier_train_screen_skips_dead_candidate_expensive_replays(
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
            args.min_train_screen_net_per_day = "1"
            recent_days = tuple(
                date(2026, 3, 18) + timedelta(days=index) for index in range(6)
            )
            snapshot_receipt = SimpleNamespace(
                snapshot_id="snap-screen",
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    "snapshot_id": "snap-screen",
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

            with (
                patch(
                    "scripts.consistent_profitability_frontier.workflow_setup._resolve_recent_trading_days",
                    return_value=recent_days,
                ),
                patch(
                    "scripts.consistent_profitability_frontier.workflow_setup.build_dataset_snapshot_receipt",
                    return_value=snapshot_receipt,
                ),
                patch(
                    "scripts.consistent_profitability_frontier.workflow_setup.ensure_fresh_snapshot"
                ),
                patch(
                    "scripts.consistent_profitability_frontier.workflow_orchestration.run_replay",
                    side_effect=fake_run_replay,
                ),
            ):
                payload = frontier.run_consistent_profitability_frontier(args)

            self.assertEqual(replay_calls, [("2026-03-18", "2026-03-20")])
            self.assertEqual(payload["candidate_count"], 1)
            top = payload["top"][0]
            self.assertEqual(top["screening"]["status"], "rejected")
            self.assertTrue(top["screening"]["holdout_replay_skipped"])
            self.assertTrue(top["screening"]["full_window_replay_skipped"])
            self.assertIn("train_no_decisions", top["hard_vetoes"])
            self.assertIn("train_net_per_day_below_screen", top["hard_vetoes"])
