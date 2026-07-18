from __future__ import annotations

from scripts.intraday_tsmom_replay.cli_args import _parse_args

from tests.local_intraday_tsmom_replay.support import (
    json,
    os,
    sys,
    Namespace,
    datetime,
    timezone,
    Decimal,
    Path,
    TemporaryDirectory,
    patch,
    TransactionCostModel,
    GateTrace,
    NearMissRecord,
    StrategyTrace,
    ThresholdTrace,
    StrategyDecision,
    PositionState,
    ReplayConfig,
    _SHARED_POSITION_OWNER,
    _apply_filled_decision,
    _build_near_miss,
    _init_funnel_stats,
    _insert_near_miss,
    _parse_signal_row,
    _record_trace_for_funnel,
    replay_main,
    _TestLocalIntradayTsmomReplayBase,
)


class TestTraceFunnelNearMissesAndCli(_TestLocalIntradayTsmomReplayBase):
    def test_programmatic_replay_config_uses_runtime_policy_pin(self) -> None:
        configured_path = "/tmp/runtime-economic-policy.json"
        configured_digest = "sha256:" + "b" * 64
        with patch.dict(
            os.environ,
            {
                "TRADING_ECONOMIC_POLICY_PATH": configured_path,
                "TRADING_ECONOMIC_POLICY_EXPECTED_DIGEST": configured_digest,
            },
        ):
            config = ReplayConfig(
                strategy_configmap_path=Path("/tmp/strategies.yaml"),
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username=None,
                clickhouse_password=None,
                start_date=datetime(2026, 3, 26, tzinfo=timezone.utc).date(),
                end_date=datetime(2026, 3, 27, tzinfo=timezone.utc).date(),
                chunk_minutes=10,
                flatten_eod=True,
                start_equity=Decimal("10000"),
            )

        self.assertEqual(config.economic_policy_path, Path(configured_path))
        self.assertEqual(
            config.economic_policy_expected_digest,
            configured_digest,
        )

    def test_parse_signal_row_preserves_vwap_and_imbalance_sizes(self) -> None:
        parsed = _parse_signal_row(
            [
                "META",
                "2026-03-27 17:30:24.000",
                "12",
                "0.031",
                "0.019",
                "523.10",
                "522.80",
                "57",
                "523.25",
                "523.22",
                "523.28",
                "0.06",
                "1200",
                "800",
                "0.06",
                "522.95",
                "523.05",
                "0.00018",
                "18200",
            ]
        )

        assert parsed is not None
        self.assertEqual(parsed.payload["vwap_session"], Decimal("522.95"))
        self.assertEqual(parsed.payload["vwap_w5m"], Decimal("523.05"))
        self.assertEqual(parsed.payload["microbar_volume"], Decimal("18200"))
        self.assertEqual(parsed.payload["imbalance_bid_sz"], Decimal("1200"))
        self.assertEqual(parsed.payload["imbalance_ask_sz"], Decimal("800"))
        imbalance = parsed.payload["imbalance"]
        assert isinstance(imbalance, dict)
        self.assertEqual(imbalance["bid_sz"], Decimal("1200"))
        self.assertEqual(imbalance["ask_sz"], Decimal("800"))

    def test_record_trace_for_funnel_stops_at_first_failed_gate(self) -> None:
        funnel = _init_funnel_stats()
        trace = StrategyTrace(
            strategy_id="breakout@prod",
            strategy_type="breakout_continuation_long",
            symbol="META",
            event_ts="2026-03-27T17:30:24+00:00",
            timeframe="1Sec",
            passed=False,
            action=None,
            first_failed_gate="feed_quality",
            gates=(
                GateTrace(
                    gate="structure",
                    category="structure",
                    passed=True,
                    thresholds=(),
                ),
                GateTrace(
                    gate="feed_quality",
                    category="feed_quality",
                    passed=False,
                    thresholds=(
                        ThresholdTrace(
                            metric="recent_quote_invalid_ratio",
                            comparator="max_lte",
                            value=Decimal("0.20"),
                            threshold=Decimal("0.10"),
                            passed=False,
                            missing_policy="fail_closed",
                            distance_to_pass=Decimal("0.10"),
                        ),
                    ),
                ),
            ),
        )

        _record_trace_for_funnel(funnel, trace)

        self.assertEqual(funnel["strategy_evaluations"], 1)
        self.assertEqual(
            dict(funnel["first_failed_gate_counts"]),
            {"breakout_continuation_long:feed_quality": 1},
        )
        self.assertEqual(
            dict(funnel["failing_threshold_counts"]),
            {"breakout_continuation_long:feed_quality:recent_quote_invalid_ratio": 1},
        )
        self.assertEqual(funnel["passed_trace_count"], 0)
        self.assertEqual(
            dict(funnel["gate_pass_counts"]),
            {"breakout_continuation_long:structure": 1},
        )

    def test_record_trace_for_funnel_handles_missing_failed_gate(self) -> None:
        funnel = _init_funnel_stats()
        trace = StrategyTrace(
            strategy_id="short@prod",
            strategy_type="mean_reversion_short",
            symbol="META",
            event_ts="2026-03-27T17:30:24+00:00",
            timeframe="1Sec",
            passed=False,
            action=None,
            first_failed_gate="confirmation",
            gates=(
                GateTrace(
                    gate="structure",
                    category="structure",
                    passed=True,
                    thresholds=(),
                ),
            ),
        )

        _record_trace_for_funnel(funnel, trace)

        self.assertEqual(funnel["strategy_evaluations"], 1)
        self.assertEqual(
            dict(funnel["first_failed_gate_counts"]),
            {"mean_reversion_short:confirmation": 1},
        )
        self.assertEqual(dict(funnel["failing_threshold_counts"]), {})
        self.assertEqual(
            dict(funnel["gate_pass_counts"]),
            {"mean_reversion_short:structure": 1},
        )

    def test_build_near_miss_uses_failed_gate_thresholds(self) -> None:
        trace = StrategyTrace(
            strategy_id="breakout@prod",
            strategy_type="breakout_continuation_long",
            symbol="AAPL",
            event_ts="2026-03-26T18:07:12+00:00",
            timeframe="1Sec",
            passed=False,
            action=None,
            first_failed_gate="confirmation",
            gates=(
                GateTrace(
                    gate="confirmation",
                    category="confirmation",
                    passed=False,
                    thresholds=(
                        ThresholdTrace(
                            metric="cross_section_continuation_breadth",
                            comparator="min_gte",
                            value=Decimal("0.42"),
                            threshold=Decimal("0.50"),
                            passed=False,
                            missing_policy="fail_closed",
                            distance_to_pass=Decimal("0.08"),
                        ),
                    ),
                ),
            ),
        )

        near_miss = _build_near_miss(trace, trading_day="2026-03-26")

        self.assertIsNotNone(near_miss)
        assert near_miss is not None
        self.assertEqual(near_miss.symbol, "AAPL")
        self.assertEqual(near_miss.first_failed_gate, "confirmation")
        self.assertEqual(near_miss.distance_score, Decimal("0.08"))
        self.assertEqual(len(near_miss.thresholds), 1)

    def test_build_near_miss_returns_none_for_non_rejectable_traces(self) -> None:
        passed_trace = StrategyTrace(
            strategy_id="breakout@prod",
            strategy_type="breakout_continuation_long",
            symbol="AAPL",
            event_ts="2026-03-26T18:07:12+00:00",
            timeframe="1Sec",
            passed=True,
            action="buy",
            first_failed_gate=None,
            gates=(),
        )
        missing_gate_trace = StrategyTrace(
            strategy_id="breakout@prod",
            strategy_type="breakout_continuation_long",
            symbol="AAPL",
            event_ts="2026-03-26T18:07:12+00:00",
            timeframe="1Sec",
            passed=False,
            action=None,
            first_failed_gate="confirmation",
            gates=(),
        )
        no_thresholds_trace = StrategyTrace(
            strategy_id="breakout@prod",
            strategy_type="breakout_continuation_long",
            symbol="AAPL",
            event_ts="2026-03-26T18:07:12+00:00",
            timeframe="1Sec",
            passed=False,
            action=None,
            first_failed_gate="confirmation",
            gates=(
                GateTrace(
                    gate="confirmation",
                    category="confirmation",
                    passed=False,
                    thresholds=(),
                ),
            ),
        )

        self.assertIsNone(_build_near_miss(passed_trace, trading_day="2026-03-26"))
        self.assertIsNone(
            _build_near_miss(missing_gate_trace, trading_day="2026-03-26")
        )
        self.assertIsNone(
            _build_near_miss(no_thresholds_trace, trading_day="2026-03-26")
        )

    def test_insert_near_miss_sorts_and_limits_bucket(self) -> None:
        near_misses: dict[str, list[NearMissRecord]] = {}
        for symbol, score in [("MSFT", "0.30"), ("AAPL", "0.10"), ("NVDA", "0.20")]:
            _insert_near_miss(
                near_misses,
                NearMissRecord(
                    trading_day="2026-03-27",
                    symbol=symbol,
                    strategy_id=f"{symbol.lower()}@prod",
                    strategy_type="breakout_continuation_long",
                    event_ts=f"2026-03-27T18:0{len(near_misses)}:00+00:00",
                    action="buy",
                    first_failed_gate="confirmation",
                    distance_score=Decimal(score),
                    thresholds=(),
                ),
                limit=2,
            )

        self.assertEqual(
            [item.symbol for item in near_misses["2026-03-27"]],
            ["AAPL", "NVDA"],
        )

    def test_apply_filled_decision_updates_symbol_bucket_for_buy_and_sell(self) -> None:
        signal = self._signal(bid="523.22", ask="523.28", price="523.25")
        positions: dict[tuple[str, str], PositionState] = {}
        day_bucket = {
            "decision_count": 1,
            "filled_count": 0,
            "filled_notional": Decimal("0"),
            "gross_pnl": Decimal("0"),
            "net_pnl": Decimal("0"),
            "cost_total": Decimal("0"),
            "wins": 0,
            "losses": 0,
            "closed_trades": [],
        }
        symbol_bucket = _init_funnel_stats()

        cash = _apply_filled_decision(
            decision=self._decision(
                action="buy", order_type="limit", limit_price="523.28"
            ),
            signal=signal,
            fill_price=Decimal("523.28"),
            filled_at=signal.event_ts,
            created_at=signal.event_ts,
            positions=positions,
            day_bucket=day_bucket,
            symbol_bucket=symbol_bucket,
            cost_model=TransactionCostModel(),
            cash=Decimal("10000"),
            all_closed_trades=[],
        )

        self.assertEqual(symbol_bucket["filled_count"], 1)
        self.assertEqual(symbol_bucket["filled_notional"], Decimal("5232.80"))
        self.assertGreaterEqual(symbol_bucket["cost_total"], Decimal("0"))

        cash = _apply_filled_decision(
            decision=self._decision(action="sell", order_type="market"),
            signal=signal,
            fill_price=Decimal("523.22"),
            filled_at=signal.event_ts,
            created_at=signal.event_ts,
            positions=positions,
            day_bucket=day_bucket,
            symbol_bucket=symbol_bucket,
            cost_model=TransactionCostModel(),
            cash=cash,
            all_closed_trades=[],
        )

        self.assertGreater(symbol_bucket["gross_pnl"], Decimal("-1"))
        self.assertNotEqual(symbol_bucket["net_pnl"], Decimal("0"))
        self.assertEqual(symbol_bucket["closed_trade_count"], 1)
        self.assertEqual(symbol_bucket["filled_notional"], Decimal("10465.00"))
        self.assertGreater(cash, Decimal("0"))

    def test_apply_filled_decision_partial_buy_cover_updates_symbol_bucket_and_losses(
        self,
    ) -> None:
        signal = self._signal(bid="523.90", ask="524.00", price="523.95")
        positions = {
            ("META", _SHARED_POSITION_OWNER): PositionState(
                strategy_id=_SHARED_POSITION_OWNER,
                qty=Decimal("-10"),
                avg_entry_price=Decimal("523.22"),
                opened_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
                entry_cost_total=Decimal("1.00"),
                decision_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
            )
        }
        day_bucket = {
            "decision_count": 1,
            "filled_count": 0,
            "filled_notional": Decimal("0"),
            "gross_pnl": Decimal("0"),
            "net_pnl": Decimal("0"),
            "cost_total": Decimal("0"),
            "wins": 0,
            "losses": 0,
            "closed_trades": [],
        }
        symbol_bucket = _init_funnel_stats()
        partial_cover = StrategyDecision(
            strategy_id="intraday_tsmom_v1@prod",
            symbol="META",
            event_ts=signal.event_ts,
            timeframe="1Sec",
            action="buy",
            qty=Decimal("4"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("524.00"),
            rationale="test",
            params={},
        )
        all_closed_trades: list[object] = []

        cash = _apply_filled_decision(
            decision=partial_cover,
            signal=signal,
            fill_price=Decimal("524.00"),
            filled_at=signal.event_ts,
            created_at=signal.event_ts,
            positions=positions,
            day_bucket=day_bucket,
            symbol_bucket=symbol_bucket,
            cost_model=TransactionCostModel(),
            cash=Decimal("15231.20"),
            all_closed_trades=all_closed_trades,
        )

        self.assertIn(("META", _SHARED_POSITION_OWNER), positions)
        self.assertEqual(positions[("META", _SHARED_POSITION_OWNER)].qty, Decimal("-6"))
        self.assertLess(day_bucket["net_pnl"], Decimal("0"))
        self.assertEqual(day_bucket["losses"], 1)
        self.assertEqual(symbol_bucket["closed_trade_count"], 1)
        self.assertLess(symbol_bucket["net_pnl"], Decimal("0"))
        self.assertEqual(len(all_closed_trades), 1)
        self.assertLess(cash, Decimal("15231.20"))

    def test_apply_filled_decision_sell_adds_to_existing_short(self) -> None:
        signal = self._signal(bid="523.90", ask="524.00", price="523.95")
        decision = StrategyDecision(
            strategy_id="intraday_tsmom_v1@prod",
            symbol="META",
            event_ts=signal.event_ts,
            timeframe="1Sec",
            action="sell",
            qty=Decimal("5"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("523.90"),
            rationale="test",
            params={},
        )
        positions = {
            ("META", _SHARED_POSITION_OWNER): PositionState(
                strategy_id=_SHARED_POSITION_OWNER,
                qty=Decimal("-10"),
                avg_entry_price=Decimal("523.22"),
                opened_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
                entry_cost_total=Decimal("1.00"),
                decision_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
            )
        }
        day_bucket = {
            "decision_count": 1,
            "filled_count": 0,
            "filled_notional": Decimal("0"),
            "gross_pnl": Decimal("0"),
            "net_pnl": Decimal("0"),
            "cost_total": Decimal("0"),
            "wins": 0,
            "losses": 0,
            "closed_trades": [],
        }

        cash = _apply_filled_decision(
            decision=decision,
            signal=signal,
            fill_price=Decimal("523.90"),
            filled_at=signal.event_ts,
            created_at=signal.event_ts,
            positions=positions,
            day_bucket=day_bucket,
            cost_model=TransactionCostModel(),
            cash=Decimal("15231.20"),
            all_closed_trades=[],
        )

        self.assertEqual(
            positions[("META", _SHARED_POSITION_OWNER)].qty, Decimal("-15")
        )
        self.assertEqual(
            positions[("META", _SHARED_POSITION_OWNER)].avg_entry_price,
            Decimal("523.4466666666666666666666667"),
        )
        self.assertEqual(day_bucket["filled_count"], 1)
        self.assertEqual(day_bucket["filled_notional"], Decimal("2619.50"))
        self.assertGreater(cash, Decimal("15231.20"))

    def test_replay_main_writes_trace_funnel_and_near_miss_outputs(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            trace_output = root / "trace.jsonl"
            funnel_output = root / "funnel.json"
            near_misses_output = root / "near-misses.json"

            args = Namespace(
                strategy_configmap="/tmp/strategies.yaml",
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="",
                clickhouse_password="",
                start_date="2026-03-26",
                end_date="2026-03-27",
                chunk_minutes=10,
                no_flatten_eod=False,
                start_equity="31590.02",
                symbols="",
                progress_log_seconds=30,
                max_executable_spread_bps="12",
                max_quote_mid_jump_bps="150",
                max_jump_with_wide_spread_bps="40",
                log_level="INFO",
                trace_output=trace_output,
                funnel_output=funnel_output,
                near_misses_output=near_misses_output,
                json=False,
            )

            payload = {
                "trace": [{"strategy_id": "breakout@prod", "passed": True}],
                "funnel": {"schema_version": "torghut.replay-funnel.v1", "buckets": []},
                "near_misses": [{"symbol": "AAPL"}],
            }
            with (
                patch(
                    "scripts.intraday_tsmom_replay.cli._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.intraday_tsmom_replay.cli.run_replay",
                    return_value=payload,
                ),
                patch("builtins.print"),
            ):
                replay_main()

            self.assertEqual(
                trace_output.read_text(encoding="utf-8"),
                json.dumps(payload["trace"][0], sort_keys=True) + "\n",
            )
            self.assertEqual(
                json.loads(funnel_output.read_text(encoding="utf-8")),
                payload["funnel"],
            )
            self.assertEqual(
                json.loads(near_misses_output.read_text(encoding="utf-8")),
                payload["near_misses"],
            )

    def test_parse_args_accepts_collect_traces_flag(self) -> None:
        with patch.object(
            sys, "argv", ["local_intraday_tsmom_replay.py", "--collect-traces"]
        ):
            args = _parse_args()

        self.assertTrue(args.collect_traces)

    def test_parse_args_prefers_ta_clickhouse_env_defaults(self) -> None:
        with patch.dict(
            os.environ,
            {
                "TA_CLICKHOUSE_URL": "http://clickhouse.example:8123",
                "TA_CLICKHOUSE_USERNAME": "env-user",
                "TA_CLICKHOUSE_PASSWORD": "env-secret",
                "TRADING_ECONOMIC_POLICY_EXPECTED_DIGEST": "sha256:" + "a" * 64,
            },
            clear=False,
        ):
            with patch.object(sys, "argv", ["local_intraday_tsmom_replay.py"]):
                args = _parse_args()

        self.assertEqual(args.clickhouse_http_url, "http://clickhouse.example:8123")
        self.assertEqual(args.clickhouse_username, "env-user")
        self.assertEqual(args.clickhouse_password, "env-secret")
        self.assertEqual(
            args.economic_policy_expected_digest,
            "sha256:" + "a" * 64,
        )

    def test_parse_args_uses_repo_root_strategy_configmap_by_default(self) -> None:
        with patch.object(sys, "argv", ["local_intraday_tsmom_replay.py"]):
            args = _parse_args()

        expected = (
            next(
                parent
                for parent in Path(__file__).resolve().parents
                if (
                    parent / "argocd/applications/torghut/strategy-configmap.yaml"
                ).is_file()
            )
            / "argocd/applications/torghut/strategy-configmap.yaml"
        )
        self.assertEqual(args.strategy_configmap, expected)
        self.assertTrue(args.strategy_configmap.exists())

    def test_replay_main_enables_trace_capture_for_funnel_and_near_miss_outputs(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            funnel_output = root / "funnel.json"
            near_misses_output = root / "near-misses.json"

            args = Namespace(
                strategy_configmap="/tmp/strategies.yaml",
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="",
                clickhouse_password="",
                start_date="2026-03-26",
                end_date="2026-03-27",
                chunk_minutes=10,
                no_flatten_eod=False,
                start_equity="31590.02",
                symbols="",
                progress_log_seconds=30,
                max_executable_spread_bps="12",
                max_quote_mid_jump_bps="150",
                max_jump_with_wide_spread_bps="40",
                log_level="INFO",
                trace_output=None,
                funnel_output=funnel_output,
                near_misses_output=near_misses_output,
                collect_traces=False,
                json=False,
            )

            payload = {
                "trace": [],
                "funnel": {"schema_version": "torghut.replay-funnel.v1", "buckets": []},
                "near_misses": [],
            }

            with (
                patch(
                    "scripts.intraday_tsmom_replay.cli._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.intraday_tsmom_replay.cli.run_replay",
                    return_value=payload,
                ) as run_replay_mock,
                patch("builtins.print"),
            ):
                replay_main()

            replay_config = run_replay_mock.call_args.args[0]
            self.assertTrue(replay_config.capture_traces)
            self.assertEqual(
                json.loads(funnel_output.read_text(encoding="utf-8")),
                payload["funnel"],
            )
            self.assertEqual(
                json.loads(near_misses_output.read_text(encoding="utf-8")),
                payload["near_misses"],
            )
