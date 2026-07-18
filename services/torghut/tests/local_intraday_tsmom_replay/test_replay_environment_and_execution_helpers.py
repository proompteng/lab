from __future__ import annotations

from tests.local_intraday_tsmom_replay.support import (
    os,
    subprocess,
    Namespace,
    datetime,
    timezone,
    Decimal,
    Path,
    TemporaryDirectory,
    Any,
    patch,
    CostModelConfig,
    FetchChunkRequest,
    TransactionCostModel,
    StrategyDecision,
    PendingOrder,
    PositionState,
    TraceBlockContext,
    _SHARED_POSITION_OWNER,
    _apply_filled_decision,
    _append_decimal_sample,
    _decision_exit_reason,
    _decision_market_order_spread_bps_max,
    _decision_position_owner,
    _decision_spread_bps,
    _estimate_trade_cost,
    _estimate_trade_cost_lineage,
    _fetch_chunk,
    _http_query,
    _latency_bucket,
    _load_strategies,
    _pending_censor_time,
    _record_capital_snapshot,
    _resolve_repo_root,
    _reconcile_pending_order_before_immediate_fill,
    _resolve_passed_trace_block_reason,
    _resolve_pending_fill_price,
    _signal_mid_jump_bps,
    _signal_spread_bps,
    _kubectl_clickhouse_query,
    _TestLocalIntradayTsmomReplayBase,
)


class TestReplayEnvironmentAndExecutionHelpers(_TestLocalIntradayTsmomReplayBase):
    def test_resolve_repo_root_accepts_container_app_layout(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "app"
            (root / "app").mkdir(parents=True)
            (root / "scripts").mkdir()
            script_path = root / "scripts" / "local_intraday_tsmom_replay.py"
            script_path.touch()

            self.assertEqual(_resolve_repo_root(script_path), root.resolve())

    def test_resolve_repo_root_keeps_legacy_parent_fallback(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            script_path = root / "one" / "two" / "three" / "four" / "script.py"
            script_path.parent.mkdir(parents=True)
            script_path.touch()

            self.assertEqual(
                _resolve_repo_root(script_path), script_path.resolve().parents[3]
            )

    def test_default_strategy_configmap_prefers_runtime_env_path(self) -> None:
        from scripts import local_intraday_tsmom_replay as replay

        with patch.dict(
            os.environ,
            {"TRADING_STRATEGY_CONFIG_PATH": "/etc/torghut/strategies.yaml"},
        ):
            self.assertEqual(
                replay.default_strategy_configmap_path(),
                Path("/etc/torghut/strategies.yaml"),
            )

    def test_force_position_isolation_owns_decision_by_strategy_id(self) -> None:
        decision = StrategyDecision(
            strategy_id="candidate-strategy-1",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="buy",
            qty=Decimal("1"),
            order_type="market",
            time_in_force="day",
            params={},
        )

        self.assertEqual(_decision_position_owner(decision), _SHARED_POSITION_OWNER)
        self.assertEqual(
            _decision_position_owner(decision, force_position_isolation=True),
            "candidate-strategy-1",
        )

    def test_order_lifecycle_helpers_cover_defensive_branches(self) -> None:
        samples: dict[str, object] = {}
        _append_decimal_sample(samples, "spread_bps_samples", None)
        self.assertEqual(samples, {})
        self.assertEqual(_latency_bucket(50), "1-50ms")
        self.assertEqual(_latency_bucket(151), "151-250ms")

        decision = StrategyDecision(
            strategy_id="candidate-strategy-1",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="buy",
            qty=Decimal("1"),
            order_type="limit",
            time_in_force="day",
            params={},
            limit_price=Decimal("100"),
        )
        signal = self._signal(bid="99.90", ask="100.00", price="99.95")
        before_close = PendingOrder(
            decision=decision,
            created_at=datetime(2026, 3, 27, 17, 30, tzinfo=timezone.utc),
            signal=signal,
        )
        after_close = PendingOrder(
            decision=decision,
            created_at=datetime(2026, 3, 27, 21, 30, tzinfo=timezone.utc),
            signal=signal,
        )
        fallback = datetime(2026, 3, 27, 22, 0, tzinfo=timezone.utc)

        self.assertEqual(
            _pending_censor_time(pending=before_close, fallback=fallback),
            datetime(2026, 3, 27, 20, 0, tzinfo=timezone.utc),
        )
        self.assertEqual(
            _pending_censor_time(pending=after_close, fallback=fallback), fallback
        )
        self.assertIsNone(
            _reconcile_pending_order_before_immediate_fill(
                decision=decision,
                pending_orders={},
                created_at=signal.event_ts,
            )
        )

    def test_kubectl_clickhouse_query_validates_target_and_reports_failure(
        self,
    ) -> None:
        with self.assertRaisesRegex(RuntimeError, "clickhouse_kubectl_url_invalid"):
            _kubectl_clickhouse_query(
                url="kubectl://galactic-lan/torghut",
                username="torghut",
                password="secret",
                query="SELECT 1",
            )

        with patch(
            "scripts.intraday_tsmom_replay.strategy_loading.subprocess.run",
            return_value=Namespace(returncode=1, stdout="", stderr="denied"),
        ):
            with self.assertRaisesRegex(
                RuntimeError, "clickhouse_kubectl_query_failed: denied"
            ):
                _kubectl_clickhouse_query(
                    url="kubectl://galactic-lan/torghut/clickhouse-0",
                    username="torghut",
                    password="secret",
                    query="SELECT 1",
                )

        with patch(
            "scripts.intraday_tsmom_replay.strategy_loading.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd=["kubectl"], timeout=2),
        ):
            with self.assertRaisesRegex(
                RuntimeError, "clickhouse_kubectl_query_timeout:2s"
            ):
                _kubectl_clickhouse_query(
                    url="kubectl://galactic-lan/torghut/clickhouse-0",
                    username="torghut",
                    password="secret",
                    query="SELECT 1",
                    timeout_seconds=2,
                )

    def test_execution_spread_helpers_fall_back_on_invalid_payloads(self) -> None:
        decision = StrategyDecision(
            strategy_id="candidate-strategy-1",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="buy",
            qty=Decimal("1"),
            order_type="market",
            time_in_force="day",
            params={
                "market_order_spread_bps_max": "not-a-decimal",
                "execution_features": {"spread_bps": "not-a-decimal"},
            },
        )

        self.assertEqual(_decision_market_order_spread_bps_max(decision), Decimal("12"))
        self.assertIsNone(
            _decision_spread_bps(decision, price=Decimal("0"), spread=Decimal("1"))
        )

    def test_load_strategies_rejects_invalid_configmap_shapes(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            not_mapping = root / "not-mapping.yaml"
            missing_data = root / "missing-data.yaml"
            missing_strategies = root / "missing-strategies.yaml"
            not_mapping.write_text("- bad\n", encoding="utf-8")
            missing_data.write_text("apiVersion: v1\n", encoding="utf-8")
            missing_strategies.write_text(
                "data:\n  other.yaml: '{}'\n", encoding="utf-8"
            )

            with self.assertRaisesRegex(RuntimeError, "strategy_configmap_not_mapping"):
                _load_strategies(not_mapping)
            with self.assertRaisesRegex(
                RuntimeError, "strategy_configmap_missing_data"
            ):
                _load_strategies(missing_data)
            with self.assertRaisesRegex(
                RuntimeError, "strategy_configmap_missing_strategies_yaml"
            ):
                _load_strategies(missing_strategies)

    def test_fetch_chunk_filters_symbols_and_parses_rows(self) -> None:
        captured_queries: list[str] = []

        def fake_http_query(
            *,
            url: str,
            username: str | None,
            password: str | None,
            timeout_seconds: int,
            query: str,
        ) -> str:
            self.assertEqual(url, "http://clickhouse")
            self.assertEqual(username, "reader")
            self.assertEqual(password, "secret")
            self.assertEqual(timeout_seconds, 7)
            captured_queries.append(query)
            return "\t".join(
                [
                    "META",
                    "2026-03-27 17:30:24.000",
                    "12",
                    "2026-03-27 17:30:24.250",
                    "2026-03-27 17:30:24.200",
                    "2026-03-27 17:30:24.250",
                    "7",
                    "9",
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

        with patch(
            "scripts.intraday_tsmom_replay.signal_rows._http_query",
            side_effect=fake_http_query,
        ):
            rows = _fetch_chunk(
                FetchChunkRequest(
                    http_url="http://clickhouse",
                    username="reader",
                    password="secret",
                    timeout_seconds=7,
                    chunk_start=datetime(2026, 3, 27, 17, 0, tzinfo=timezone.utc),
                    chunk_end=datetime(2026, 3, 27, 18, 0, tzinfo=timezone.utc),
                    symbols=("META", "NVDA"),
                )
            )

        self.assertEqual([row.symbol for row in rows], ["META"])
        self.assertEqual(
            rows[0].ingest_ts,
            datetime(2026, 3, 27, 17, 30, 24, 250000, tzinfo=timezone.utc),
        )
        self.assertEqual(
            rows[0].payload["_source_ingest_ts"],
            {
                "ta_signals": datetime(
                    2026, 3, 27, 17, 30, 24, 200000, tzinfo=timezone.utc
                ),
                "ta_microbars": datetime(
                    2026, 3, 27, 17, 30, 24, 250000, tzinfo=timezone.utc
                ),
            },
        )
        self.assertEqual(
            rows[0].payload["_source_versions"],
            {"ta_signals": 7, "ta_microbars": 9},
        )
        self.assertEqual(captured_queries[0].count("symbol IN ('META', 'NVDA')"), 2)
        self.assertIn("s.seq = m.seq", captured_queries[0])
        self.assertIn("ingest_ts <= toDateTime64", captured_queries[0])
        self.assertIn("LIMIT 1 BY symbol, event_ts, seq", captured_queries[0])
        self.assertNotIn("ANY LEFT JOIN", captured_queries[0])

    def test_fetch_chunk_rejects_naive_observation_cutoff(self) -> None:
        with self.assertRaisesRegex(
            ValueError,
            "replay_observation_cutoff_timezone_missing",
        ):
            _fetch_chunk(
                FetchChunkRequest(
                    http_url="http://clickhouse",
                    username=None,
                    password=None,
                    chunk_start=datetime(2026, 3, 27, 17, 0, tzinfo=timezone.utc),
                    chunk_end=datetime(2026, 3, 27, 18, 0, tzinfo=timezone.utc),
                    observation_cutoff=datetime(2026, 3, 27, 18, 0),
                )
            )

    def test_http_query_supports_kubectl_clickhouse_transport(self) -> None:
        completed = type(
            "Completed",
            (),
            {
                "returncode": 0,
                "stdout": "2026-05-18\n",
                "stderr": "",
            },
        )()

        with patch(
            "scripts.intraday_tsmom_replay.strategy_loading.subprocess.run",
            return_value=completed,
        ) as run_mock:
            output = _http_query(
                url="kubectl://galactic-lan/torghut/chi-torghut-clickhouse-default-0-0-0",
                username="torghut",
                password="secret",
                timeout_seconds=5,
                query="SELECT 1 FORMAT TSVRaw",
            )

        self.assertEqual(output, "2026-05-18\n")
        cmd = run_mock.call_args.args[0]
        self.assertEqual(run_mock.call_args.kwargs["timeout"], 5)
        self.assertEqual(
            cmd[:7],
            [
                "kubectl",
                "--context",
                "galactic-lan",
                "exec",
                "-n",
                "torghut",
                "chi-torghut-clickhouse-default-0-0-0",
            ],
        )
        self.assertIn("--user", cmd)
        self.assertIn("torghut", cmd)
        self.assertEqual(cmd[-2:], ["--query", "SELECT 1 FORMAT TSVRaw"])

    def test_limit_sell_does_not_fill_below_limit(self) -> None:
        decision = self._decision(
            action="sell", order_type="limit", limit_price="524.10"
        )
        signal = self._signal(bid="523.22", ask="523.28", price="523.25")

        fill_price = _resolve_pending_fill_price(decision, signal)

        self.assertIsNone(fill_price)

    def test_limit_sell_fills_at_bid_when_bid_crosses_limit(self) -> None:
        decision = self._decision(
            action="sell", order_type="limit", limit_price="524.10"
        )
        signal = self._signal(bid="524.18", ask="524.24", price="524.21")

        fill_price = _resolve_pending_fill_price(decision, signal)

        self.assertEqual(fill_price, Decimal("524.18"))

    def test_limit_buy_fills_at_ask_when_ask_is_inside_limit(self) -> None:
        decision = self._decision(
            action="buy", order_type="limit", limit_price="593.95"
        )
        signal = self._signal(bid="593.70", ask="593.80", price="593.75")

        fill_price = _resolve_pending_fill_price(decision, signal)

        self.assertEqual(fill_price, Decimal("593.80"))

    def test_market_buy_uses_ask_without_limit_price(self) -> None:
        decision = self._decision(action="buy", order_type="market")
        signal = self._signal(bid="593.70", ask="593.80", price="593.75")

        fill_price = _resolve_pending_fill_price(decision, signal)

        self.assertEqual(fill_price, Decimal("593.80"))

    def test_quote_metric_helpers_return_positive_bps(self) -> None:
        signal = self._signal(bid="593.70", ask="593.80", price="593.75")

        self.assertEqual(
            _signal_spread_bps(signal=signal, price=Decimal("593.75")),
            Decimal("1.684210526315789473684210526"),
        )
        self.assertEqual(
            _signal_mid_jump_bps(
                price=Decimal("593.75"),
                reference_price=Decimal("590.00"),
            ),
            Decimal("63.55932203389830508474576271"),
        )

    def test_decision_exit_reason_prefers_runtime_exit_then_rationale(self) -> None:
        stop_loss = StrategyDecision(
            strategy_id="intraday_tsmom_v1@prod",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 11, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="sell",
            qty=Decimal("10"),
            order_type="market",
            time_in_force="day",
            rationale="signal_exit",
            params={"position_exit": {"type": "long_stop_loss_bps"}},
        )
        rationale_exit = StrategyDecision(
            strategy_id="intraday_tsmom_v1@prod",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 12, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="sell",
            qty=Decimal("10"),
            order_type="market",
            time_in_force="day",
            rationale="microbar_exit,score=0.2",
            params={},
        )
        fallback_exit = StrategyDecision(
            strategy_id="intraday_tsmom_v1@prod",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 13, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="sell",
            qty=Decimal("10"),
            order_type="market",
            time_in_force="day",
            params={},
        )

        self.assertEqual(_decision_exit_reason(stop_loss), "long_stop_loss_bps")
        self.assertEqual(_decision_exit_reason(rationale_exit), "microbar_exit")
        self.assertEqual(_decision_exit_reason(fallback_exit), "signal_exit")

    def test_resolve_passed_trace_block_reason_reports_post_runtime_filter(
        self,
    ) -> None:
        reason = _resolve_passed_trace_block_reason(
            "candidate-a",
            TraceBlockContext(
                runtime_intent_strategy_ids={"candidate-a"},
                runtime_suppression_reason_by_strategy_id={},
                raw_decision_strategy_ids={"candidate-a"},
                allocation_reject_reason_by_strategy_id={},
                sizing_reject_reason_by_strategy_id={},
                emitted_strategy_ids=set(),
            ),
        )

        self.assertEqual(reason, "post_runtime_filter_rejected")

    def test_resolve_passed_trace_block_reason_reports_runtime_suppression(
        self,
    ) -> None:
        reason = _resolve_passed_trace_block_reason(
            "candidate-a",
            TraceBlockContext(
                runtime_intent_strategy_ids={"candidate-a"},
                runtime_suppression_reason_by_strategy_id={
                    "candidate-a": "runtime_trade_policy_blocked"
                },
                raw_decision_strategy_ids=set(),
                allocation_reject_reason_by_strategy_id={},
                sizing_reject_reason_by_strategy_id={},
                emitted_strategy_ids=set(),
            ),
        )

        self.assertEqual(reason, "runtime_trade_policy_blocked")

    def test_resolve_passed_trace_block_reason_reports_no_runtime_intent(
        self,
    ) -> None:
        reason = _resolve_passed_trace_block_reason(
            "candidate-a",
            TraceBlockContext(
                runtime_intent_strategy_ids=set(),
                runtime_suppression_reason_by_strategy_id={},
                raw_decision_strategy_ids=set(),
                allocation_reject_reason_by_strategy_id={},
                sizing_reject_reason_by_strategy_id={},
                emitted_strategy_ids=set(),
            ),
        )

        self.assertEqual(reason, "engine_runtime_no_intent")

    def test_resolve_passed_trace_block_reason_reports_intent_not_emitted(
        self,
    ) -> None:
        reason = _resolve_passed_trace_block_reason(
            "candidate-a",
            TraceBlockContext(
                runtime_intent_strategy_ids={"candidate-a"},
                runtime_suppression_reason_by_strategy_id={},
                raw_decision_strategy_ids=set(),
                allocation_reject_reason_by_strategy_id={},
                sizing_reject_reason_by_strategy_id={},
                emitted_strategy_ids=set(),
            ),
        )

        self.assertEqual(reason, "engine_runtime_intent_not_emitted")

    def test_apply_filled_decision_opens_position_on_same_signal(self) -> None:
        signal = self._signal(bid="523.22", ask="523.28", price="523.25")
        decision = self._decision(
            action="buy", order_type="limit", limit_price="523.28"
        )
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

        cash = _apply_filled_decision(
            decision=decision,
            signal=signal,
            fill_price=Decimal("523.28"),
            filled_at=signal.event_ts,
            created_at=signal.event_ts,
            positions=positions,
            day_bucket=day_bucket,
            cost_model=TransactionCostModel(),
            cash=Decimal("10000"),
            all_closed_trades=[],
        )

        self.assertIn(("META", _SHARED_POSITION_OWNER), positions)
        position = positions[("META", _SHARED_POSITION_OWNER)]
        self.assertEqual(position.avg_entry_price, Decimal("523.28"))
        self.assertEqual(position.qty, Decimal("10"))
        self.assertEqual(day_bucket["filled_count"], 1)
        self.assertEqual(day_bucket["filled_notional"], Decimal("5232.80"))
        self.assertLess(cash, Decimal("10000"))

    def test_record_capital_snapshot_tracks_cash_and_exposure(self) -> None:
        positions = {
            ("META", _SHARED_POSITION_OWNER): PositionState(
                strategy_id=_SHARED_POSITION_OWNER,
                qty=Decimal("3"),
                avg_entry_price=Decimal("100"),
                opened_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
                entry_cost_total=Decimal("1.00"),
                decision_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
            ),
            ("NVDA", _SHARED_POSITION_OWNER): PositionState(
                strategy_id=_SHARED_POSITION_OWNER,
                qty=Decimal("-2"),
                avg_entry_price=Decimal("50"),
                opened_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
                entry_cost_total=Decimal("1.00"),
                decision_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
            ),
        }
        bucket: dict[str, object] = {}

        equity = _record_capital_snapshot(
            bucket=bucket,
            cash=Decimal("-25"),
            positions=positions,
            last_prices={"META": Decimal("110"), "NVDA": Decimal("45")},
        )

        self.assertEqual(equity, Decimal("215"))
        self.assertEqual(bucket["min_cash"], Decimal("-25"))
        self.assertEqual(bucket["min_equity"], Decimal("215"))
        self.assertEqual(bucket["max_gross_exposure"], Decimal("420"))
        self.assertEqual(bucket["max_net_exposure_abs"], Decimal("240"))
        self.assertEqual(
            bucket["max_gross_exposure_pct_equity"], Decimal("420") / Decimal("215")
        )
        self.assertEqual(bucket["negative_cash_observation_count"], 1)
        self.assertEqual(bucket["capital_snapshot_count"], 1)

    def test_apply_filled_decision_backfills_missing_stats_bucket_fields(self) -> None:
        signal = self._signal(bid="523.22", ask="523.28", price="523.25")
        decision = self._decision(
            action="buy", order_type="limit", limit_price="523.28"
        )
        positions: dict[tuple[str, str], PositionState] = {}
        day_bucket = {
            "decision_count": 1,
            "filled_count": 0,
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
            fill_price=Decimal("523.28"),
            filled_at=signal.event_ts,
            created_at=signal.event_ts,
            positions=positions,
            day_bucket=day_bucket,
            cost_model=TransactionCostModel(),
            cash=Decimal("10000"),
            all_closed_trades=[],
        )

        self.assertEqual(day_bucket["filled_count"], 1)
        self.assertEqual(day_bucket["filled_notional"], Decimal("5232.80"))
        self.assertLess(cash, Decimal("10000"))

    def test_estimate_trade_cost_uses_observed_adv_for_square_root_impact(
        self,
    ) -> None:
        signal = self._signal(bid="99.99", ask="100.01", price="100")
        decision = StrategyDecision(
            strategy_id="impact-aware",
            symbol="META",
            event_ts=signal.event_ts,
            timeframe="1Sec",
            action="buy",
            qty=Decimal("100"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("100"),
            params={},
        )
        cost_model = TransactionCostModel(
            CostModelConfig(
                impact_bps_at_full_participation=Decimal("100"),
                max_participation_rate=Decimal("1"),
            )
        )

        cost_without_adv = _estimate_trade_cost(
            model=cost_model,
            decision=decision,
            signal=signal,
        )
        cost_with_adv = _estimate_trade_cost(
            model=cost_model,
            decision=decision,
            signal=signal,
            symbol_bucket={"daily_adv_notional": Decimal("40000")},
        )

        self.assertEqual(cost_without_adv, Decimal("0"))
        self.assertEqual(cost_with_adv, Decimal("50"))

    def test_estimate_trade_cost_falls_back_to_signal_payload_adv(self) -> None:
        signal = self._signal(bid="99.99", ask="100.01", price="100")
        signal.payload["adv"] = "40000"
        decision = StrategyDecision(
            strategy_id="impact-aware",
            symbol="META",
            event_ts=signal.event_ts,
            timeframe="1Sec",
            action="buy",
            qty=Decimal("100"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("100"),
            params={},
        )

        cost = _estimate_trade_cost(
            model=TransactionCostModel(
                CostModelConfig(
                    impact_bps_at_full_participation=Decimal("100"),
                    max_participation_rate=Decimal("1"),
                )
            ),
            decision=decision,
            signal=signal,
            symbol_bucket={"daily_adv_notional": "not-a-number"},
        )

        self.assertEqual(cost, Decimal("50"))

    def test_estimate_trade_cost_lineage_exposes_adv_and_capacity_warnings(
        self,
    ) -> None:
        signal = self._signal(bid="99.99", ask="100.01", price="100")
        decision = StrategyDecision(
            strategy_id="impact-aware",
            symbol="META",
            event_ts=signal.event_ts,
            timeframe="1Sec",
            action="buy",
            qty=Decimal("100"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("100"),
            params={},
        )

        lineage = _estimate_trade_cost_lineage(
            model=TransactionCostModel(
                CostModelConfig(
                    impact_bps_at_full_participation=Decimal("100"),
                    max_participation_rate=Decimal("0.1"),
                )
            ),
            decision=decision,
            signal=signal,
            symbol_bucket={"daily_adv_notional": Decimal("40000")},
        )

        self.assertEqual(lineage.adv_notional, Decimal("40000"))
        self.assertEqual(lineage.adv_source, "symbol_bucket.daily_adv_notional")
        self.assertEqual(lineage.participation_rate, Decimal("0.25"))
        self.assertEqual(lineage.total_cost, Decimal("50"))
        self.assertEqual(lineage.warnings, ("participation_exceeds_max",))

    def test_apply_filled_decision_prefers_symbol_adv_for_impact_cost(self) -> None:
        signal = self._signal(bid="9.99", ask="10.01", price="10")
        decision = StrategyDecision(
            strategy_id="impact-aware",
            symbol="META",
            event_ts=signal.event_ts,
            timeframe="1Sec",
            action="buy",
            qty=Decimal("100"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("10"),
            params={},
        )
        positions: dict[tuple[str, str], PositionState] = {}
        day_bucket: dict[str, Any] = {
            "daily_adv_notional": Decimal("1000000"),
        }
        symbol_bucket: dict[str, Any] = {
            "daily_adv_notional": Decimal("4000"),
        }

        cash = _apply_filled_decision(
            decision=decision,
            signal=signal,
            fill_price=Decimal("10"),
            filled_at=signal.event_ts,
            created_at=signal.event_ts,
            positions=positions,
            day_bucket=day_bucket,
            symbol_bucket=symbol_bucket,
            cost_model=TransactionCostModel(
                CostModelConfig(
                    impact_bps_at_full_participation=Decimal("100"),
                    max_participation_rate=Decimal("1"),
                )
            ),
            cash=Decimal("10000"),
            all_closed_trades=[],
        )

        self.assertEqual(day_bucket["cost_total"], Decimal("5"))
        self.assertEqual(symbol_bucket["cost_total"], Decimal("5"))
        self.assertEqual(cash, Decimal("8995"))

    def test_apply_filled_decision_opens_short_position_on_sell_entry(self) -> None:
        signal = self._signal(bid="523.22", ask="523.28", price="523.25")
        decision = self._decision(
            action="sell", order_type="limit", limit_price="523.22"
        )
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

        cash = _apply_filled_decision(
            decision=decision,
            signal=signal,
            fill_price=Decimal("523.22"),
            filled_at=signal.event_ts,
            created_at=signal.event_ts,
            positions=positions,
            day_bucket=day_bucket,
            cost_model=TransactionCostModel(),
            cash=Decimal("10000"),
            all_closed_trades=[],
        )

        self.assertIn(("META", _SHARED_POSITION_OWNER), positions)
        position = positions[("META", _SHARED_POSITION_OWNER)]
        self.assertEqual(position.avg_entry_price, Decimal("523.22"))
        self.assertEqual(position.qty, Decimal("-10"))
        self.assertEqual(day_bucket["filled_count"], 1)
        self.assertEqual(day_bucket["filled_notional"], Decimal("5232.20"))
        self.assertGreater(cash, Decimal("10000"))
