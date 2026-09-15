from __future__ import annotations

from tests.decisions.support import (
    Decimal,
    DecisionEngine,
    FeatureVectorV3,
    MarketSnapshot,
    PluginEvaluationResult,
    PriceFetcher,
    SignalEnvelope,
    Strategy,
    StrategyConfig,
    StrategyContext,
    StrategyIntent,
    StrategyRegistry,
    StrategyRuntime,
    TestCase,
    _BuyPlugin,
    _SellPlugin,
    _compose_strategy_description,
    datetime,
    patch,
    settings,
    timezone,
    uuid,
)


class TestDecisionEngineCore(TestCase):
    def test_missing_timeframe_skips_strategy(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            name="test",
            description=None,
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=None,
            max_position_pct_equity=None,
            max_notional_per_trade=None,
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={
                "macd": {"macd": Decimal("1.0"), "signal": Decimal("0.1")},
                "rsi14": Decimal("20"),
            },
            timeframe=None,
        )
        decisions = engine.evaluate(signal, [strategy])
        self.assertEqual(decisions, [])

    def test_timeframe_inferred_from_payload_window(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            name="test",
            description=None,
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=None,
            max_position_pct_equity=None,
            max_notional_per_trade=None,
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe=None,
            payload={
                "window_size": "1m",
                "macd": {"macd": Decimal("2.0"), "signal": Decimal("0.5")},
                "rsi14": Decimal("20"),
                "price": Decimal("100"),
            },
        )
        decisions = engine.evaluate(signal, [strategy])
        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].timeframe, "1Min")

    def test_price_snapshot_attached_when_fetched(self) -> None:
        class DummyFetcher(PriceFetcher):
            def fetch_price(self, signal: SignalEnvelope) -> Decimal | None:
                return None

            def fetch_market_snapshot(
                self, signal: SignalEnvelope
            ) -> MarketSnapshot | None:
                return MarketSnapshot(
                    symbol=signal.symbol,
                    as_of=signal.event_ts,
                    price=Decimal("101.5"),
                    spread=Decimal("0.02"),
                    source="ta_microbars",
                )

        engine = DecisionEngine(price_fetcher=DummyFetcher())
        strategy = Strategy(
            name="test",
            description=None,
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=None,
            max_position_pct_equity=None,
            max_notional_per_trade=None,
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={
                "macd": {"macd": Decimal("1.0"), "signal": Decimal("0.1")},
                "rsi14": Decimal("20"),
            },
            timeframe="1Min",
        )
        decisions = engine.evaluate(signal, [strategy])
        self.assertEqual(len(decisions), 1)
        decision = decisions[0]
        self.assertEqual(decision.params.get("price"), Decimal("101.5"))
        snapshot = decision.params.get("price_snapshot")
        assert isinstance(snapshot, dict)
        self.assertEqual(snapshot.get("source"), "ta_microbars")
        self.assertEqual(snapshot.get("price"), "101.5")
        self.assertEqual(snapshot.get("spread"), "0.02")

    def test_execution_features_attached_when_present_on_signal(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            name="test",
            description=None,
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=None,
            max_position_pct_equity=None,
            max_notional_per_trade=None,
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={
                "macd": {"macd": Decimal("1.0"), "signal": Decimal("0.1")},
                "rsi14": Decimal("20"),
                "price": Decimal("101.5"),
                "spread_bps": Decimal("3.2"),
                "recent_microprice_bias_bps_avg": Decimal("0.18"),
                "cross_section_continuation_rank": Decimal("0.81"),
            },
            timeframe="1Min",
        )

        decisions = engine.evaluate(signal, [strategy])

        self.assertEqual(len(decisions), 1)
        execution_features = decisions[0].params.get("execution_features")
        assert isinstance(execution_features, dict)
        self.assertEqual(execution_features.get("spread_bps"), Decimal("3.2"))
        self.assertEqual(
            execution_features.get("recent_microprice_bias_bps_avg"),
            Decimal("0.18"),
        )
        self.assertEqual(
            execution_features.get("cross_section_continuation_rank"),
            Decimal("0.81"),
        )

    def test_scheduler_macd_rsi_buy_supports_fractional_equity_qty_when_enabled(
        self,
    ) -> None:
        original_fractional = settings.trading_fractional_equities_enabled
        original_allow_shorts = settings.trading_allow_shorts
        settings.trading_fractional_equities_enabled = True
        settings.trading_allow_shorts = False
        try:
            engine = DecisionEngine(price_fetcher=None)
            strategy = Strategy(
                name="fractional-buy",
                description=None,
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=None,
                max_position_pct_equity=None,
                max_notional_per_trade=Decimal("50"),
            )
            signal = SignalEnvelope(
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": Decimal("1.0"), "signal": Decimal("0.1")},
                    "rsi14": Decimal("20"),
                    "price": Decimal("100"),
                },
                timeframe="1Min",
            )

            decisions = engine.evaluate(signal, [strategy])

            self.assertEqual(len(decisions), 1)
            self.assertEqual(decisions[0].qty, Decimal("0.5000"))
        finally:
            settings.trading_fractional_equities_enabled = original_fractional
            settings.trading_allow_shorts = original_allow_shorts

    def test_scheduler_macd_rsi_sell_without_inventory_defaults_to_integer_qty(
        self,
    ) -> None:
        original_fractional = settings.trading_fractional_equities_enabled
        original_allow_shorts = settings.trading_allow_shorts
        settings.trading_fractional_equities_enabled = True
        settings.trading_allow_shorts = True
        try:
            engine = DecisionEngine(price_fetcher=None)
            strategy = Strategy(
                name="integer-sell",
                description=None,
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=None,
                max_position_pct_equity=None,
                max_notional_per_trade=Decimal("150"),
            )
            signal = SignalEnvelope(
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": Decimal("0.1"), "signal": Decimal("1.0")},
                    "rsi14": Decimal("80"),
                    "price": Decimal("100"),
                },
                timeframe="1Min",
            )

            decisions = engine.evaluate(signal, [strategy], positions=None)

            self.assertEqual(len(decisions), 1)
            self.assertEqual(decisions[0].qty, Decimal("1"))
            sizing = decisions[0].params.get("sizing")
            assert isinstance(sizing, dict)
            quantity_resolution = sizing.get("quantity_resolution")
            assert isinstance(quantity_resolution, dict)
            self.assertFalse(quantity_resolution.get("fractional_allowed"))
            self.assertEqual(
                quantity_resolution.get("reason"),
                "sell_short_increasing_integer_only",
            )
        finally:
            settings.trading_fractional_equities_enabled = original_fractional
            settings.trading_allow_shorts = original_allow_shorts

    def test_scheduler_macd_rsi_sell_without_inventory_below_one_share_is_skipped(
        self,
    ) -> None:
        original_fractional = settings.trading_fractional_equities_enabled
        original_allow_shorts = settings.trading_allow_shorts
        settings.trading_fractional_equities_enabled = True
        settings.trading_allow_shorts = True
        try:
            engine = DecisionEngine(price_fetcher=None)
            strategy = Strategy(
                name="small-short-sell",
                description=None,
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=None,
                max_position_pct_equity=None,
                max_notional_per_trade=Decimal("50"),
            )
            signal = SignalEnvelope(
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": Decimal("0.1"), "signal": Decimal("1.0")},
                    "rsi14": Decimal("80"),
                    "price": Decimal("100"),
                },
                timeframe="1Min",
            )

            decisions = engine.evaluate(signal, [strategy], positions=None)

            self.assertEqual(decisions, [])
        finally:
            settings.trading_fractional_equities_enabled = original_fractional
            settings.trading_allow_shorts = original_allow_shorts

    def test_scheduler_macd_rsi_buy_at_symbol_cap_is_skipped(self) -> None:
        original_max_pct = settings.trading_max_position_pct_equity
        settings.trading_max_position_pct_equity = 0.08
        try:
            engine = DecisionEngine(price_fetcher=None)
            strategy = Strategy(
                name="capped-buy",
                description=None,
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=None,
                max_position_pct_equity=Decimal("0.08"),
                max_notional_per_trade=Decimal("100"),
            )
            signal = SignalEnvelope(
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": Decimal("1.0"), "signal": Decimal("0.1")},
                    "rsi14": Decimal("20"),
                    "price": Decimal("100"),
                },
                timeframe="1Min",
            )

            decisions = engine.evaluate(
                signal,
                [strategy],
                equity=Decimal("10000"),
                positions=[{"symbol": "AAPL", "qty": "8", "market_value": "800"}],
            )

            self.assertEqual(decisions, [])
        finally:
            settings.trading_max_position_pct_equity = original_max_pct

    def test_scheduler_macd_rsi_sell_reducing_long_can_remain_fractional(self) -> None:
        original_fractional = settings.trading_fractional_equities_enabled
        original_allow_shorts = settings.trading_allow_shorts
        settings.trading_fractional_equities_enabled = True
        settings.trading_allow_shorts = True
        try:
            engine = DecisionEngine(price_fetcher=None)
            strategy = Strategy(
                name="fractional-reduce-sell",
                description=None,
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=None,
                max_position_pct_equity=None,
                max_notional_per_trade=Decimal("50"),
            )
            signal = SignalEnvelope(
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": Decimal("0.1"), "signal": Decimal("1.0")},
                    "rsi14": Decimal("80"),
                    "price": Decimal("100"),
                },
                timeframe="1Min",
            )

            decisions = engine.evaluate(
                signal,
                [strategy],
                positions=[{"symbol": "AAPL", "qty": "1", "side": "long"}],
            )

            self.assertEqual(len(decisions), 1)
            self.assertEqual(decisions[0].qty, Decimal("0.5000"))
        finally:
            settings.trading_fractional_equities_enabled = original_fractional
            settings.trading_allow_shorts = original_allow_shorts

    def test_scheduler_runtime_mode_emits_aggregated_metadata(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            name="runtime",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="legacy_macd_rsi",
            universe_symbols=None,
            max_position_pct_equity=None,
            max_notional_per_trade=Decimal("500"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={
                "macd": {"macd": Decimal("1.0"), "signal": Decimal("0.1")},
                "rsi14": Decimal("20"),
                "price": 100,
            },
            timeframe="1Min",
        )
        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
        ):
            decisions = engine.evaluate(signal, [strategy])
            telemetry = engine.consume_runtime_telemetry()

        self.assertEqual(len(decisions), 1)
        self.assertTrue(telemetry.runtime_enabled)
        self.assertFalse(telemetry.fallback_to_legacy)
        runtime_meta = decisions[0].params.get("strategy_runtime")
        assert isinstance(runtime_meta, dict)
        self.assertTrue(runtime_meta.get("aggregated"))
        self.assertEqual(runtime_meta.get("mode"), "scheduler_v3")

    def test_scheduler_runtime_uses_contributing_strategies_for_source_and_sizing(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        engine.strategy_runtime = StrategyRuntime(
            registry=StrategyRegistry(
                plugins={
                    "buy_plugin": _BuyPlugin(),
                    "sell_plugin": _SellPlugin(),
                }
            )
        )
        buy_strategy = Strategy(
            id=uuid.UUID("ffffffff-ffff-ffff-ffff-ffffffffffff"),
            name="buy",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="buy_plugin",
            universe_symbols=None,
            max_position_pct_equity=None,
            max_notional_per_trade=Decimal("100"),
        )
        sell_strategy = Strategy(
            id=uuid.UUID("00000000-0000-0000-0000-000000000001"),
            name="sell",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="sell_plugin",
            universe_symbols=None,
            max_position_pct_equity=None,
            max_notional_per_trade=Decimal("900"),
        )
        off_timeframe_strategy = Strategy(
            id=uuid.UUID("00000000-0000-0000-0000-000000000002"),
            name="off-timeframe",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="5Min",
            universe_type="buy_plugin",
            universe_symbols=None,
            max_position_pct_equity=None,
            max_notional_per_trade=Decimal("1000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={
                "macd": {"macd": Decimal("1.0"), "signal": Decimal("0.1")},
                "rsi14": Decimal("20"),
                "price": 100,
            },
            timeframe="1Min",
        )
        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
        ):
            decisions = engine.evaluate(
                signal, [buy_strategy, sell_strategy, off_timeframe_strategy]
            )

        self.assertEqual(len(decisions), 1)
        decision = decisions[0]
        self.assertEqual(decision.strategy_id, str(buy_strategy.id))
        self.assertEqual(decision.qty, Decimal("1"))
        runtime_meta = decision.params.get("strategy_runtime")
        assert isinstance(runtime_meta, dict)
        self.assertEqual(
            runtime_meta.get("source_strategy_ids"),
            [str(buy_strategy.id)],
        )
        self.assertEqual(
            runtime_meta.get("primary_strategy_row_id"),
            str(buy_strategy.id),
        )
        self.assertEqual(
            runtime_meta.get("primary_declared_strategy_id"),
            "buy",
        )
        self.assertEqual(runtime_meta.get("compiler_sources"), ["legacy_runtime"])
        source_runtime = runtime_meta.get("source_strategy_runtime")
        assert isinstance(source_runtime, list)
        self.assertEqual(len(source_runtime), 1)
        self.assertEqual(source_runtime[0].get("strategy_row_id"), str(buy_strategy.id))
        self.assertEqual(
            source_runtime[0].get("declared_strategy_id"),
            "buy",
        )
        self.assertEqual(source_runtime[0].get("compiler_source"), "legacy_runtime")
        self.assertEqual(source_runtime[0].get("intent_target_notional"), "100")

    def test_scheduler_runtime_uses_runtime_target_notional_for_qty_resolution(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        engine.strategy_runtime = StrategyRuntime(
            registry=StrategyRegistry(
                plugins={
                    "buy_plugin": _BuyPlugin(),
                }
            )
        )
        strategy = Strategy(
            id=uuid.UUID("00000000-0000-0000-0000-000000000010"),
            name="buy",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="buy_plugin",
            universe_symbols=None,
            max_position_pct_equity=None,
            max_notional_per_trade=Decimal("1000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={
                "macd": {"macd": Decimal("1.0"), "signal": Decimal("0.1")},
                "rsi14": Decimal("20"),
                "price": 50,
            },
            timeframe="1Min",
        )
        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
        ):
            decisions = engine.evaluate(signal, [strategy])

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].qty, Decimal("2"))
        self.assertEqual(
            decisions[0].params["sizing"]["method"], "runtime_target_notional"
        )

    def test_scheduler_runtime_skips_non_executable_fractional_short_entry(
        self,
    ) -> None:
        class SmallShortPlugin:
            plugin_id = "small_short_plugin"
            version = "1.0.0"
            required_features = ("price",)

            def evaluate(
                self, context: StrategyContext, features: FeatureVectorV3
            ) -> PluginEvaluationResult:
                return PluginEvaluationResult(
                    intent=StrategyIntent(
                        strategy_id=context.strategy_id,
                        symbol=context.symbol,
                        direction="sell",
                        confidence=Decimal("0.40"),
                        target_notional=Decimal("50"),
                        horizon=context.timeframe,
                        explain=("sell_signal",),
                        feature_snapshot_hash=features.normalization_hash,
                        required_features=self.required_features,
                    )
                )

        engine = DecisionEngine(price_fetcher=None)
        engine.strategy_runtime = StrategyRuntime(
            registry=StrategyRegistry(
                plugins={
                    "small_short_plugin": SmallShortPlugin(),
                }
            )
        )
        strategy = Strategy(
            id=uuid.UUID("00000000-0000-0000-0000-000000000003"),
            name="sell",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="small_short_plugin",
            universe_symbols=None,
            max_position_pct_equity=None,
            max_notional_per_trade=Decimal("50"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={
                "macd": {"macd": Decimal("0.1"), "signal": Decimal("1.0")},
                "rsi14": Decimal("80"),
                "price": 100,
            },
            timeframe="1Min",
        )
        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_fractional_equities_enabled", True),
            patch.object(settings, "trading_allow_shorts", True),
        ):
            decisions = engine.evaluate(signal, [strategy], positions=None)

        self.assertEqual(decisions, [])

    def test_scheduler_runtime_skips_buy_when_symbol_cap_is_exhausted(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        engine.strategy_runtime = StrategyRuntime(
            registry=StrategyRegistry(
                plugins={
                    "buy_plugin": _BuyPlugin(),
                }
            )
        )
        strategy = Strategy(
            id=uuid.UUID("00000000-0000-0000-0000-000000000004"),
            name="buy",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="buy_plugin",
            universe_symbols=None,
            max_position_pct_equity=Decimal("0.08"),
            max_notional_per_trade=Decimal("100"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={
                "macd": {"macd": Decimal("1.0"), "signal": Decimal("0.1")},
                "rsi14": Decimal("20"),
                "price": 100,
            },
            timeframe="1Min",
        )
        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_max_position_pct_equity", 0.08),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                equity=Decimal("10000"),
                positions=[{"symbol": "AAPL", "qty": "8", "market_value": "800"}],
            )

        self.assertEqual(decisions, [])

    def test_scheduler_macd_rsi_buy_clips_to_residual_symbol_capacity(self) -> None:
        original_fractional = settings.trading_fractional_equities_enabled
        original_max_pct = settings.trading_max_position_pct_equity
        settings.trading_fractional_equities_enabled = True
        settings.trading_max_position_pct_equity = 0.08
        try:
            engine = DecisionEngine(price_fetcher=None)
            strategy = Strategy(
                name="residual-cap-buy",
                description=None,
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=None,
                max_position_pct_equity=Decimal("0.08"),
                max_notional_per_trade=Decimal("500"),
            )
            signal = SignalEnvelope(
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": Decimal("1.0"), "signal": Decimal("0.1")},
                    "rsi14": Decimal("20"),
                    "price": Decimal("100"),
                },
                timeframe="1Min",
            )

            decisions = engine.evaluate(
                signal,
                [strategy],
                equity=Decimal("10000"),
                positions=[{"symbol": "AAPL", "qty": "6.5", "market_value": "650"}],
            )

            self.assertEqual(len(decisions), 1)
            self.assertEqual(decisions[0].qty, Decimal("1.5000"))
            sizing = decisions[0].params.get("sizing")
            assert isinstance(sizing, dict)
            self.assertEqual(Decimal(str(sizing.get("requested_qty"))), Decimal("1.5"))
            self.assertTrue(sizing.get("symbol_capacity_limited"))
        finally:
            settings.trading_fractional_equities_enabled = original_fractional
            settings.trading_max_position_pct_equity = original_max_pct

    def test_scheduler_macd_rsi_buy_skips_when_residual_symbol_capacity_is_below_min_qty(
        self,
    ) -> None:
        original_fractional = settings.trading_fractional_equities_enabled
        original_max_pct = settings.trading_max_position_pct_equity
        settings.trading_fractional_equities_enabled = False
        settings.trading_max_position_pct_equity = 0.08
        try:
            engine = DecisionEngine(price_fetcher=None)
            strategy = Strategy(
                name="residual-cap-min-qty",
                description=None,
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=None,
                max_position_pct_equity=Decimal("0.08"),
                max_notional_per_trade=Decimal("500"),
            )
            signal = SignalEnvelope(
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": Decimal("1.0"), "signal": Decimal("0.1")},
                    "rsi14": Decimal("20"),
                    "price": Decimal("100"),
                },
                timeframe="1Min",
            )

            decisions = engine.evaluate(
                signal,
                [strategy],
                equity=Decimal("10000"),
                positions=[{"symbol": "AAPL", "qty": "7.95", "market_value": "795"}],
            )

            self.assertEqual(decisions, [])
        finally:
            settings.trading_fractional_equities_enabled = original_fractional
            settings.trading_max_position_pct_equity = original_max_pct

    def test_scheduler_runtime_intraday_tsmom_skips_same_direction_reentry(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom",
            description="version=1.1.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["NVDA"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("2500"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            symbol="NVDA",
            timeframe="1Sec",
            seq=7,
            payload={
                "price": 140.25,
                "ema12": 140.40,
                "ema26": 139.95,
                "macd": 0.45,
                "macd_signal": 0.30,
                "rsi14": 56,
                "vol_realized_w60s": 0.009,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                positions=[
                    {
                        "symbol": "NVDA",
                        "qty": "3",
                        "side": "long",
                        "market_value": "420.75",
                    }
                ],
            )

        self.assertEqual(decisions, [])

    def test_scheduler_runtime_position_isolation_skips_unowned_sell_intent(
        self,
    ) -> None:
        buy_strategy_id = uuid.uuid4()
        sell_strategy_id = uuid.uuid4()
        engine = DecisionEngine(price_fetcher=None)
        engine.strategy_runtime = StrategyRuntime(
            registry=StrategyRegistry(
                plugins={
                    "buy_plugin": _BuyPlugin(),
                    "sell_plugin": _SellPlugin(),
                }
            )
        )
        buy_strategy = Strategy(
            id=buy_strategy_id,
            name="isolated-buy",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="isolated-buy",
                    strategy_id="isolated-buy",
                    strategy_type="buy_plugin",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="breakout_continuation_long_v1",
                    universe_symbols=["AAPL"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("1000"),
                    params={"position_isolation_mode": "per_strategy"},
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("1000"),
        )
        sell_strategy = Strategy(
            id=sell_strategy_id,
            name="isolated-sell",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="isolated-sell",
                    strategy_id="isolated-sell",
                    strategy_type="sell_plugin",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="breakout_continuation_long_v1",
                    universe_symbols=["AAPL"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("1000"),
                    params={"position_isolation_mode": "per_strategy"},
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("1000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 101,
                "macd": Decimal("0.12"),
                "macd_signal": Decimal("0.08"),
                "rsi14": Decimal("52"),
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
        ):
            decisions = engine.evaluate(
                signal, [buy_strategy, sell_strategy], positions=[]
            )

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].action, "buy")
        runtime_payload = decisions[0].params.get("strategy_runtime")
        assert isinstance(runtime_payload, dict)
        self.assertEqual(runtime_payload.get("position_isolation_mode"), "per_strategy")

    def test_scheduler_runtime_defaults_research_sleeves_to_position_isolation(
        self,
    ) -> None:
        strategy_id = uuid.uuid4()
        engine = DecisionEngine(price_fetcher=None)
        engine.strategy_runtime = StrategyRuntime(
            registry=StrategyRegistry(plugins={"buy_plugin": _BuyPlugin()})
        )
        strategy = Strategy(
            id=strategy_id,
            name="isolated-default",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="isolated-default",
                    strategy_id="isolated-default",
                    strategy_type="buy_plugin",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="mean_reversion_rebound_long_v1",
                    universe_symbols=["AAPL"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("1000"),
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="mean_reversion_rebound_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("1000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 101,
                "macd": Decimal("0.12"),
                "macd_signal": Decimal("0.08"),
                "rsi14": Decimal("52"),
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
        ):
            decisions = engine.evaluate(signal, [strategy], positions=[])

        self.assertEqual(len(decisions), 1)
        runtime_payload = decisions[0].params.get("strategy_runtime")
        assert isinstance(runtime_payload, dict)
        self.assertEqual(runtime_payload.get("position_isolation_mode"), "per_strategy")
