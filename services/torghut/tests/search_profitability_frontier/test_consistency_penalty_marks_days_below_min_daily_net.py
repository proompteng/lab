from __future__ import annotations

from tests.search_profitability_frontier.support import (
    Decimal,
    Path,
    TemporaryDirectory,
    _TestSearchProfitabilityFrontierBase,
    apply_candidate_to_configmap,
    consistent_frontier,
    date,
    frontier,
    io,
    iter_parameter_candidates,
    json,
    patch,
    redirect_stdout,
    resolve_sweep_window,
    sys,
    timedelta,
    yaml,
)


class TestConsistencyPenaltyMarksDaysBelowMinDailyNet(
    _TestSearchProfitabilityFrontierBase
):
    def test_consistency_penalty_marks_days_below_min_daily_net(self) -> None:
        penalty, summary = consistent_frontier._consistency_penalty(
            full_window_payload={
                "start_date": "2026-04-01",
                "end_date": "2026-04-03",
                "net_pnl": "1200",
                "daily": {
                    "2026-04-01": {"net_pnl": "600", "filled_count": 1},
                    "2026-04-02": {"net_pnl": "299.99", "filled_count": 1},
                    "2026-04-03": {"net_pnl": "300.01", "filled_count": 1},
                },
            },
            policy=consistent_frontier.FullWindowConsistencyPolicy(
                target_net_per_day=Decimal("300"),
                min_daily_net_pnl=Decimal("300"),
                min_active_days=3,
                min_active_ratio=Decimal("1"),
                min_positive_days=3,
                max_worst_day_loss=Decimal("0"),
                max_negative_days=0,
                max_drawdown=Decimal("0"),
                max_best_day_share_of_total_pnl=Decimal("0.60"),
                min_avg_filled_notional_per_day=Decimal("0"),
                min_avg_filled_notional_per_active_day=Decimal("0"),
                require_every_day_active=True,
            ),
        )

        self.assertGreater(penalty, Decimal("0"))
        self.assertEqual(summary["daily_net_below_min_count"], 1)
        self.assertEqual(summary["min_daily_net_pnl"], "299.99")

    def test_resolve_sweep_window_uses_latest_train_and_holdout_days(self) -> None:
        days = [date(2026, 3, 2) + timedelta(days=index) for index in range(20)]

        window = resolve_sweep_window(days, train_days=10, holdout_days=5)

        self.assertEqual(len(window.train_days), 10)
        self.assertEqual(len(window.holdout_days), 5)
        self.assertEqual(window.train_days[0], days[5])
        self.assertEqual(window.train_days[-1], days[14])
        self.assertEqual(window.holdout_days[0], days[15])
        self.assertEqual(window.holdout_days[-1], days[19])

    def test_iter_parameter_candidates_is_deterministic(self) -> None:
        candidates = iter_parameter_candidates(
            {
                "min_rank": ["0.4", "0.5"],
                "min_hold_ratio": ["0.6", "0.7"],
            }
        )

        self.assertEqual(
            candidates,
            [
                {"min_rank": "0.4", "min_hold_ratio": "0.6"},
                {"min_rank": "0.4", "min_hold_ratio": "0.7"},
                {"min_rank": "0.5", "min_hold_ratio": "0.6"},
                {"min_rank": "0.5", "min_hold_ratio": "0.7"},
            ],
        )

    def test_iter_parameter_candidates_rejects_scalar_sequence_values(self) -> None:
        with self.assertRaisesRegex(
            ValueError, "parameter_values_not_sequence:min_rank"
        ):
            iter_parameter_candidates({"min_rank": "0.55"})

    def test_iter_parameter_candidates_rejects_mapping_values(self) -> None:
        with self.assertRaisesRegex(
            ValueError, "parameter_values_not_sequence:min_rank"
        ):
            iter_parameter_candidates({"min_rank": {"value": "0.55"}})

    def test_iter_parameter_candidates_rejects_non_iterable_values(self) -> None:
        invalid_grid: dict[str, object] = {"min_rank": 55}
        with self.assertRaisesRegex(
            ValueError, "parameter_values_not_iterable:min_rank"
        ):
            iter_parameter_candidates(invalid_grid)

    def test_iter_parameter_candidates_returns_single_empty_candidate_for_empty_grid(
        self,
    ) -> None:
        self.assertEqual(iter_parameter_candidates({}), [{}])

    def test_frontier_ranking_helpers_cover_sparse_and_invalid_payloads(self) -> None:
        self.assertEqual(frontier._daily_decimal_mapping({}, field="net_pnl"), {})
        self.assertEqual(
            frontier._daily_decimal_mapping(
                {"daily": {"2026-03-21": "not-a-mapping"}}, field="net_pnl"
            ),
            {},
        )
        self.assertEqual(
            frontier._total_filled_notional(
                holdout_payload={"filled_notional": "999"},
                daily_filled_notional={"2026-03-21": Decimal("250")},
            ),
            Decimal("250"),
        )
        self.assertEqual(frontier._median_decimal([]), Decimal("0"))
        self.assertEqual(
            frontier._median_decimal([Decimal("10"), Decimal("20")]), Decimal("15")
        )
        self.assertEqual(frontier._quantile_floor([], Decimal("0.10")), Decimal("0"))
        self.assertEqual(
            frontier._best_day_share({"2026-03-21": Decimal("-1")}), Decimal("1")
        )
        self.assertEqual(frontier._decimal_or_zero("not-a-decimal"), Decimal("0"))

    def test_apply_candidate_to_configmap_updates_target_and_disables_others(
        self,
    ) -> None:
        configmap_payload = {
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "data": {
                "strategies.yaml": yaml.safe_dump(
                    {
                        "strategies": [
                            {
                                "name": "breakout-continuation-long-v1",
                                "enabled": False,
                                "params": {
                                    "min_cross_section_continuation_rank": "0.55"
                                },
                            },
                            {
                                "name": "late-day-continuation-long-v1",
                                "enabled": True,
                                "params": {"min_recent_microprice_bias_bps": "0.20"},
                            },
                        ]
                    },
                    sort_keys=False,
                )
            },
        }

        updated = apply_candidate_to_configmap(
            configmap_payload=configmap_payload,
            strategy_name="breakout-continuation-long-v1",
            candidate_params={
                "min_cross_section_continuation_rank": "0.65",
                "min_recent_above_opening_window_close_ratio": "0.75",
            },
            strategy_overrides={
                "universe_symbols": ["NVDA", "AVGO"],
                "max_notional_per_trade": "6000",
                "normalization_regime": "local_only_research_feature",
            },
            disable_other_strategies=True,
        )

        catalog = yaml.safe_load(updated["data"]["strategies.yaml"])
        strategies = {item["name"]: item for item in catalog["strategies"]}
        self.assertTrue(strategies["breakout-continuation-long-v1"]["enabled"])
        self.assertEqual(
            strategies["breakout-continuation-long-v1"]["params"][
                "min_cross_section_continuation_rank"
            ],
            "0.65",
        )
        self.assertEqual(
            strategies["breakout-continuation-long-v1"]["params"][
                "min_recent_above_opening_window_close_ratio"
            ],
            "0.75",
        )
        self.assertEqual(
            strategies["breakout-continuation-long-v1"]["params"][
                "position_isolation_mode"
            ],
            "per_strategy",
        )
        self.assertEqual(
            strategies["breakout-continuation-long-v1"]["universe_symbols"],
            ["NVDA", "AVGO"],
        )
        self.assertEqual(
            strategies["breakout-continuation-long-v1"]["max_notional_per_trade"],
            "6000",
        )
        self.assertNotIn(
            "normalization_regime",
            strategies["breakout-continuation-long-v1"],
        )
        self.assertFalse(strategies["late-day-continuation-long-v1"]["enabled"])

    def test_apply_candidate_to_configmap_rejects_reserved_params_override(
        self,
    ) -> None:
        configmap_payload = {
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "data": {
                "strategies.yaml": yaml.safe_dump(
                    {
                        "strategies": [
                            {
                                "name": "breakout-continuation-long-v1",
                                "enabled": False,
                                "params": {},
                            }
                        ]
                    },
                    sort_keys=False,
                )
            },
        }

        with self.assertRaisesRegex(
            ValueError, "strategy_override_key_reserved:params"
        ):
            apply_candidate_to_configmap(
                configmap_payload=configmap_payload,
                strategy_name="breakout-continuation-long-v1",
                candidate_params={},
                strategy_overrides={"params": {"long_stop_loss_bps": "12"}},
                disable_other_strategies=False,
            )

    def test_apply_candidate_to_configmap_accepts_mounted_strategy_catalog(
        self,
    ) -> None:
        updated = apply_candidate_to_configmap(
            configmap_payload={
                "strategies": [
                    {
                        "name": "breakout-continuation-long-v1",
                        "enabled": False,
                        "params": {"min_cross_section_continuation_rank": "0.55"},
                    }
                ]
            },
            strategy_name="breakout-continuation-long-v1",
            candidate_params={"min_cross_section_continuation_rank": "0.65"},
            disable_other_strategies=False,
        )

        self.assertEqual(updated["kind"], "ConfigMap")
        catalog = yaml.safe_load(updated["data"]["strategies.yaml"])
        strategy = catalog["strategies"][0]
        self.assertTrue(strategy["enabled"])
        self.assertEqual(
            strategy["params"]["min_cross_section_continuation_rank"], "0.65"
        )

    def test_apply_candidate_to_configmap_coerces_non_mapping_params(self) -> None:
        configmap_payload = {
            "data": {
                "strategies.yaml": yaml.safe_dump(
                    {
                        "strategies": [
                            {
                                "name": "breakout-continuation-long-v1",
                                "enabled": True,
                                "params": ["not-a-mapping"],
                            }
                        ]
                    },
                    sort_keys=False,
                )
            }
        }

        updated = apply_candidate_to_configmap(
            configmap_payload=configmap_payload,
            strategy_name="breakout-continuation-long-v1",
            candidate_params={"min_cross_section_continuation_rank": "0.65"},
            disable_other_strategies=False,
        )

        catalog = yaml.safe_load(updated["data"]["strategies.yaml"])
        strategy = catalog["strategies"][0]
        self.assertEqual(
            strategy["params"], {"min_cross_section_continuation_rank": "0.65"}
        )

    def test_apply_candidate_to_configmap_raises_for_missing_strategy(self) -> None:
        with self.assertRaisesRegex(ValueError, "strategy_not_found:missing"):
            apply_candidate_to_configmap(
                configmap_payload={
                    "data": {
                        "strategies.yaml": yaml.safe_dump(
                            {"strategies": []}, sort_keys=False
                        ),
                    }
                },
                strategy_name="missing",
                candidate_params={},
                disable_other_strategies=False,
            )

    def test_apply_candidate_to_configmap_rejects_invalid_shapes(self) -> None:
        with self.assertRaisesRegex(ValueError, "strategy_configmap_missing_data"):
            apply_candidate_to_configmap(
                configmap_payload={},
                strategy_name="breakout-continuation-long-v1",
                candidate_params={},
                disable_other_strategies=False,
            )
        with self.assertRaisesRegex(
            ValueError, "strategy_configmap_missing_strategies_yaml"
        ):
            apply_candidate_to_configmap(
                configmap_payload={"data": {}},
                strategy_name="breakout-continuation-long-v1",
                candidate_params={},
                disable_other_strategies=False,
            )
        with self.assertRaisesRegex(ValueError, "strategy_catalog_not_mapping"):
            apply_candidate_to_configmap(
                configmap_payload={
                    "data": {
                        "strategies.yaml": yaml.safe_dump(["bad"], sort_keys=False)
                    }
                },
                strategy_name="breakout-continuation-long-v1",
                candidate_params={},
                disable_other_strategies=False,
            )
        with self.assertRaisesRegex(ValueError, "strategy_catalog_missing_strategies"):
            apply_candidate_to_configmap(
                configmap_payload={
                    "data": {"strategies.yaml": yaml.safe_dump({}, sort_keys=False)}
                },
                strategy_name="breakout-continuation-long-v1",
                candidate_params={},
                disable_other_strategies=False,
            )

    def test_parse_args_uses_frontier_defaults(self) -> None:
        with patch.object(sys, "argv", ["search_profitability_frontier.py"]):
            args = frontier._parse_args()

        self.assertEqual(
            args.clickhouse_http_url,
            "http://torghut-clickhouse.torghut.svc.cluster.local:8123",
        )
        self.assertEqual(args.clickhouse_username, "torghut")
        self.assertEqual(args.clickhouse_password, "")
        self.assertEqual(args.start_equity, "31590.02")
        self.assertEqual(args.chunk_minutes, 10)
        self.assertEqual(args.symbols, "")
        self.assertEqual(args.progress_log_seconds, 30)
        self.assertEqual(args.train_days, 10)
        self.assertEqual(args.holdout_days, 5)
        self.assertEqual(args.top_n, 10)
        self.assertIsNone(args.json_output)

    def test_parse_args_uses_clickhouse_env_defaults(self) -> None:
        with (
            patch.dict(
                "os.environ",
                {
                    "TA_CLICKHOUSE_URL": "http://clickhouse.example:8123",
                    "TA_CLICKHOUSE_USERNAME": "env-user",
                    "TA_CLICKHOUSE_PASSWORD": "env-secret",
                },
                clear=False,
            ),
            patch.object(sys, "argv", ["search_profitability_frontier.py"]),
        ):
            args = frontier._parse_args()

        self.assertEqual(args.clickhouse_http_url, "http://clickhouse.example:8123")
        self.assertEqual(args.clickhouse_username, "env-user")
        self.assertEqual(args.clickhouse_password, "env-secret")

    def test_resolve_recent_trading_days_uses_qualified_signal_query(self) -> None:
        with patch(
            "scripts.search_profitability_frontier._http_query",
            return_value="2026-03-27\n2026-03-26\n",
        ) as query:
            days = frontier._resolve_recent_trading_days(
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                limit=2,
                latest_trading_day=date(2026, 3, 27),
            )

        self.assertEqual(days, (date(2026, 3, 26), date(2026, 3, 27)))
        sql = query.call_args.kwargs["query"]
        self.assertIn("FROM torghut.ta_signals", sql)
        self.assertIn("source = 'ta'", sql)
        self.assertIn("window_size = 'PT1S'", sql)
        self.assertIn("toDate(event_ts) <= toDate('2026-03-27')", sql)

    def test_resolve_recent_trading_days_filters_partial_trading_day(self) -> None:
        with (
            patch(
                "scripts.search_profitability_frontier.resolve_expected_last_trading_day",
                return_value=date(2026, 5, 21),
            ),
            patch(
                "scripts.search_profitability_frontier._http_query",
                return_value="2026-05-22\n2026-05-21\n2026-05-20\n",
            ) as query,
        ):
            days = frontier._resolve_recent_trading_days(
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                limit=3,
            )

        self.assertEqual(days, (date(2026, 5, 20), date(2026, 5, 21)))
        sql = query.call_args.kwargs["query"]
        self.assertIn("toDate(event_ts) <= toDate('2026-05-21')", sql)

    def test_load_sweep_config_rejects_non_mapping_payload(self) -> None:
        with TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "invalid-sweep.yaml"
            path.write_text("- nope\n", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "sweep_config_not_mapping"):
                frontier._load_sweep_config(path)

    def test_load_sweep_config_rejects_invalid_schema(self) -> None:
        with TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "invalid-sweep.yaml"
            path.write_text(
                yaml.safe_dump({"schema_version": "wrong"}), encoding="utf-8"
            )

            with self.assertRaisesRegex(
                ValueError, "sweep_config_schema_version_invalid:wrong"
            ):
                frontier._load_sweep_config(path)

    def test_main_writes_frontier_json_and_stdout_payload(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = self._write_sweep_config(root, ranks=["0.45", "0.55"])
            json_output = root / "frontier.json"
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=json_output,
            )
            recent_days = tuple(
                date(2026, 3, 16) + timedelta(days=index) for index in range(10)
            )

            def fake_run_replay(config: object) -> dict[str, object]:
                replay_config = config
                configmap_path = Path(getattr(replay_config, "strategy_configmap_path"))
                payload = yaml.safe_load(configmap_path.read_text(encoding="utf-8"))
                strategies = yaml.safe_load(payload["data"]["strategies.yaml"])[
                    "strategies"
                ]
                params = next(
                    item["params"]
                    for item in strategies
                    if item["name"] == "breakout-continuation-long-v1"
                )
                rank = str(params["min_cross_section_continuation_rank"])
                start_date = str(getattr(replay_config, "start_date"))
                if start_date == "2026-03-16":
                    return self._payload(
                        start_date="2026-03-16",
                        end_date="2026-03-20",
                        daily_net={
                            "2026-03-16": "0",
                            "2026-03-17": "10",
                            "2026-03-18": "0",
                            "2026-03-19": "0",
                            "2026-03-20": "0",
                        },
                        decision_count=2,
                        filled_count=1,
                        wins=1,
                        losses=0,
                    )
                if rank == "0.45":
                    return self._payload(
                        start_date="2026-03-21",
                        end_date="2026-03-25",
                        daily_net={
                            "2026-03-21": "0",
                            "2026-03-22": "50",
                            "2026-03-23": "0",
                            "2026-03-24": "0",
                            "2026-03-25": "0",
                        },
                        decision_count=2,
                        filled_count=1,
                        wins=1,
                        losses=0,
                    )
                return self._payload(
                    start_date="2026-03-21",
                    end_date="2026-03-25",
                    daily_net={
                        "2026-03-21": "0",
                        "2026-03-22": "400",
                        "2026-03-23": "300",
                        "2026-03-24": "350",
                        "2026-03-25": "0",
                    },
                    decision_count=6,
                    filled_count=3,
                    wins=3,
                    losses=0,
                )

            stdout = io.StringIO()
            with (
                patch(
                    "scripts.search_profitability_frontier._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.search_profitability_frontier._resolve_recent_trading_days",
                    return_value=recent_days,
                ),
                patch(
                    "scripts.search_profitability_frontier.run_replay",
                    side_effect=fake_run_replay,
                ),
                redirect_stdout(stdout),
            ):
                exit_code = frontier.main()

            self.assertEqual(exit_code, 0)
            payload = json.loads(json_output.read_text(encoding="utf-8"))
            stdout_payload = json.loads(stdout.getvalue())
            self.assertEqual(payload, stdout_payload)
            self.assertEqual(
                payload["schema_version"], "torghut.replay-frontier-sweep.v1"
            )
            self.assertEqual(payload["family"], "breakout_continuation")
            self.assertEqual(payload["strategy_name"], "breakout-continuation-long-v1")
            self.assertEqual(
                payload["window"],
                {
                    "train_days": [
                        "2026-03-16",
                        "2026-03-17",
                        "2026-03-18",
                        "2026-03-19",
                        "2026-03-20",
                    ],
                    "holdout_days": [
                        "2026-03-21",
                        "2026-03-22",
                        "2026-03-23",
                        "2026-03-24",
                        "2026-03-25",
                    ],
                },
            )
            self.assertEqual(payload["candidate_count"], 2)
            self.assertGreaterEqual(len(payload["top"]), 2)
            top_scores = [float(item["score"]) for item in payload["top"]]
            self.assertEqual(top_scores, sorted(top_scores, reverse=True))
            self.assertEqual(
                payload["top"][0]["replay_config"]["params"][
                    "min_cross_section_continuation_rank"
                ],
                "0.55",
            )
            self.assertTrue(
                payload["frontier_ranking_policy"][
                    "prefers_distribution_over_single_lucky_day"
                ]
            )
            ranking = payload["top"][0]["frontier_ranking"]
            self.assertEqual(ranking["median_daily_net_pnl"], "300")
            self.assertEqual(ranking["p10_daily_net_pnl"], "0")
            self.assertIn("best_day_share", ranking)
            self.assertIn("drawdown", ranking)
            self.assertEqual(ranking["closed_trade_count"], 3)
            self.assertIn("filled_notional", ranking)
            self.assertIn("target_implied_notional", ranking)
            self.assertIn("filled_notional_missing", ranking["blockers"])

    def test_main_ranks_three_candidates_deterministically(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = self._write_sweep_config(
                root, ranks=["0.45", "0.55", "0.65"]
            )
            json_output = root / "frontier.json"
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=json_output,
            )
            recent_days = tuple(
                date(2026, 3, 16) + timedelta(days=index) for index in range(10)
            )
            holdout_payloads = {
                "0.45": self._payload(
                    start_date="2026-03-21",
                    end_date="2026-03-25",
                    daily_net={
                        "2026-03-21": "0",
                        "2026-03-22": "120",
                        "2026-03-23": "0",
                        "2026-03-24": "0",
                        "2026-03-25": "0",
                    },
                    decision_count=2,
                    filled_count=1,
                    wins=1,
                    losses=0,
                ),
                "0.55": self._payload(
                    start_date="2026-03-21",
                    end_date="2026-03-25",
                    daily_net={
                        "2026-03-21": "0",
                        "2026-03-22": "300",
                        "2026-03-23": "300",
                        "2026-03-24": "0",
                        "2026-03-25": "0",
                    },
                    decision_count=4,
                    filled_count=2,
                    wins=2,
                    losses=0,
                ),
                "0.65": self._payload(
                    start_date="2026-03-21",
                    end_date="2026-03-25",
                    daily_net={
                        "2026-03-21": "0",
                        "2026-03-22": "500",
                        "2026-03-23": "500",
                        "2026-03-24": "500",
                        "2026-03-25": "0",
                    },
                    decision_count=6,
                    filled_count=3,
                    wins=3,
                    losses=0,
                ),
            }

            def fake_run_replay(config: object) -> dict[str, object]:
                replay_config = config
                configmap_path = Path(getattr(replay_config, "strategy_configmap_path"))
                payload = yaml.safe_load(configmap_path.read_text(encoding="utf-8"))
                strategies = yaml.safe_load(payload["data"]["strategies.yaml"])[
                    "strategies"
                ]
                params = next(
                    item["params"]
                    for item in strategies
                    if item["name"] == "breakout-continuation-long-v1"
                )
                rank = str(params["min_cross_section_continuation_rank"])
                start_date = str(getattr(replay_config, "start_date"))
                if start_date == "2026-03-16":
                    return self._payload(
                        start_date="2026-03-16",
                        end_date="2026-03-20",
                        daily_net={
                            "2026-03-16": "0",
                            "2026-03-17": "20",
                            "2026-03-18": "0",
                            "2026-03-19": "0",
                            "2026-03-20": "0",
                        },
                        decision_count=2,
                        filled_count=1,
                        wins=1,
                        losses=0,
                    )
                return holdout_payloads[rank]

            with (
                patch(
                    "scripts.search_profitability_frontier._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.search_profitability_frontier._resolve_recent_trading_days",
                    return_value=recent_days,
                ),
                patch(
                    "scripts.search_profitability_frontier.run_replay",
                    side_effect=fake_run_replay,
                ),
                redirect_stdout(io.StringIO()),
            ):
                frontier.main()

            payload = json.loads(json_output.read_text(encoding="utf-8"))
            ranked = [
                item["replay_config"]["params"]["min_cross_section_continuation_rank"]
                for item in payload["top"][:3]
            ]
            self.assertEqual(ranked, ["0.65", "0.55", "0.45"])
