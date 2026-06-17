from __future__ import annotations

from tests.decisions.support import (
    Decimal,
    DecisionEngine,
    SignalEnvelope,
    Strategy,
    StrategyConfig,
    StrategyDecision,
    StrategyRegistry,
    StrategyRuntime,
    TestCase,
    _BuyPlugin,
    _SellPlugin,
    _compose_strategy_description,
    _passes_runtime_trade_policy,
    _record_runtime_trade_policy_decision,
    _resolve_strategy_time_in_force,
    datetime,
    patch,
    settings,
    timezone,
    uuid,
)


class TestDecisionEngineExitPolicyA(TestCase):
    def test_scheduler_runtime_position_isolation_allows_owned_sell_intent(
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
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
        ):
            decisions = engine.evaluate(
                signal,
                [buy_strategy, sell_strategy],
                positions=[
                    {
                        "symbol": "AAPL",
                        "strategy_id": str(sell_strategy_id),
                        "qty": "5",
                        "side": "long",
                        "market_value": "500",
                        "avg_entry_price": "100",
                        "opened_at": "2026-03-27T17:20:00+00:00",
                    }
                ],
            )

        self.assertEqual({decision.action for decision in decisions}, {"buy", "sell"})

    def test_scheduler_runtime_intraday_tsmom_skips_exit_only_sell_without_long_inventory(
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
            seq=8,
            payload={
                "price": 140.25,
                "ema12": 139.90,
                "ema26": 140.40,
                "macd": -0.205,
                "macd_signal": -0.18,
                "rsi14": 38,
                "vol_realized_w60s": 0.009,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
        ):
            decisions = engine.evaluate(signal, [strategy], positions=[])
            telemetry = engine.consume_runtime_telemetry()

        self.assertEqual(decisions, [])
        self.assertIsNotNone(telemetry.observation)
        assert telemetry.observation is not None
        self.assertEqual(
            telemetry.observation.strategy_intent_suppression_total,
            {
                f"{strategy.id}|exit_only_sell_without_long_position": 1,
            },
        )

    def test_scheduler_runtime_intraday_tsmom_caps_exit_only_sell_to_long_inventory(
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
            seq=9,
            payload={
                "price": 140.25,
                "ema12": 139.90,
                "ema26": 140.40,
                "macd": -0.205,
                "macd_signal": -0.18,
                "rsi14": 38,
                "vol_realized_w60s": 0.009,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
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

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].action, "sell")
        self.assertEqual(decisions[0].qty, Decimal("3"))

    def test_scheduler_runtime_intraday_tsmom_exit_only_sell_ignores_entry_notional_budget(
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
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("0.08"),
            max_notional_per_trade=Decimal("1000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=10,
            payload={
                "price": 528.29,
                "ema12": 527.90,
                "ema26": 528.40,
                "macd": -0.205,
                "macd_signal": -0.18,
                "rsi14": 38,
                "vol_realized_w60s": 0.009,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
            patch.object(settings, "trading_execution_prefer_limit", False),
            patch.object(settings, "trading_fractional_equities_enabled", True),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                positions=[
                    {
                        "symbol": "META",
                        "qty": "1.9091",
                        "side": "long",
                        "market_value": "1008.144239",
                    }
                ],
            )

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].action, "sell")
        self.assertEqual(decisions[0].qty, Decimal("1.9091"))

    def test_scheduler_runtime_intraday_tsmom_skips_signal_exit_at_entry_price(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-profit-protect",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-profit-protect",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("0.08"),
                    max_notional_per_trade=Decimal("1000"),
                    params={"require_positive_price_for_signal_exit": "true"},
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("0.08"),
            max_notional_per_trade=Decimal("1000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 17, 14, 29, 1, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=2,
            payload={
                "price": 629.575,
                "ema12": 629.10,
                "ema26": 629.30,
                "macd": -0.022,
                "macd_signal": -0.010,
                "rsi14": 41,
                "vol_realized_w60s": 0.00016,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
            patch.object(settings, "trading_execution_prefer_limit", False),
            patch.object(settings, "trading_fractional_equities_enabled", True),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                positions=[
                    {
                        "symbol": "META",
                        "qty": "1.5884",
                        "side": "long",
                        "market_value": "1000",
                        "avg_entry_price": "629.575",
                    }
                ],
            )

        self.assertEqual(decisions, [])

    def test_scheduler_runtime_intraday_tsmom_allows_signal_exit_above_entry_price(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-profit-protect",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-profit-protect",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("0.08"),
                    max_notional_per_trade=Decimal("1000"),
                    params={"require_positive_price_for_signal_exit": "true"},
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("0.08"),
            max_notional_per_trade=Decimal("1000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 18, 29, 10, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=11,
            payload={
                "price": 529.10,
                "ema12": 528.80,
                "ema26": 529.00,
                "macd": -0.012,
                "macd_signal": -0.004,
                "rsi14": 42,
                "vol_realized_w60s": 0.00018,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
            patch.object(settings, "trading_fractional_equities_enabled", True),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                positions=[
                    {
                        "symbol": "META",
                        "qty": "1.9091",
                        "side": "long",
                        "market_value": "1010.47281",
                        "avg_entry_price": "528.29",
                    }
                ],
            )

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].action, "sell")
        self.assertEqual(decisions[0].qty, Decimal("1.9091"))

    def test_scheduler_runtime_intraday_tsmom_skips_signal_exit_when_executable_limit_below_entry_price(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-profit-protect",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-profit-protect",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("0.08"),
                    max_notional_per_trade=Decimal("1000"),
                    params={"require_positive_price_for_signal_exit": "true"},
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("0.08"),
            max_notional_per_trade=Decimal("1000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 18, 29, 10, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=11,
            payload={
                "price": 529.10,
                "spread": 2.00,
                "ema12": 528.80,
                "ema26": 529.00,
                "macd": -0.012,
                "macd_signal": -0.004,
                "rsi14": 42,
                "vol_realized_w60s": 0.00018,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
            patch.object(settings, "trading_execution_prefer_limit", True),
            patch.object(settings, "trading_fractional_equities_enabled", True),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                positions=[
                    {
                        "symbol": "META",
                        "qty": "1.9091",
                        "side": "long",
                        "market_value": "1010.47281",
                        "avg_entry_price": "528.29",
                    }
                ],
            )

        self.assertEqual(decisions, [])

    def test_scheduler_runtime_breakout_continuation_skips_exit_only_sell_without_long_inventory(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-continuation",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 31, 10, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 522.85,
                "ema12": 523.20,
                "ema26": 523.05,
                "macd": -0.004,
                "macd_signal": 0.005,
                "rsi14": 55,
                "vol_realized_w60s": 0.00020,
                "vwap_session": 523.05,
                "spread": 0.04,
                "imbalance_bid_sz": 4100,
                "imbalance_ask_sz": 4900,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
        ):
            decisions = engine.evaluate(signal, [strategy], positions=[])

        self.assertEqual(decisions, [])

    def test_scheduler_runtime_washout_rebound_skips_exit_only_sell_without_long_inventory(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="washout-rebound",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="washout_rebound_long_v1",
            universe_symbols=["MSFT"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 31, 10, tzinfo=timezone.utc),
            symbol="MSFT",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 372.85,
                "ema12": 372.70,
                "ema26": 372.10,
                "macd": 0.002,
                "macd_signal": 0.006,
                "rsi14": 58,
                "vol_realized_w60s": 0.00020,
                "vwap_session": 372.60,
                "spread": 0.04,
                "imbalance_bid_sz": 4100,
                "imbalance_ask_sz": 4900,
                "price_vs_session_open_bps": 3,
                "price_position_in_session_range": 0.62,
                "price_vs_session_low_bps": 48,
                "recent_imbalance_pressure_avg": -0.03,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
        ):
            decisions = engine.evaluate(signal, [strategy], positions=[])

        self.assertEqual(decisions, [])

    def test_scheduler_runtime_late_day_continuation_skips_exit_only_sell_without_long_inventory(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="late-day-continuation",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="late_day_continuation_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 19, 8, 3, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 253.54,
                "ema12": 253.72,
                "ema26": 253.61,
                "macd": 0.010,
                "macd_signal": 0.016,
                "rsi14": 53,
                "vol_realized_w60s": 0.00018,
                "vwap_session": 253.68,
                "spread": 0.03,
                "imbalance_bid_sz": 4500,
                "imbalance_ask_sz": 4700,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
        ):
            decisions = engine.evaluate(signal, [strategy], positions=[])

        self.assertEqual(decisions, [])

    def test_scheduler_runtime_end_of_day_reversal_skips_exit_only_sell_without_long_inventory(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="end-of-day-reversal",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="end_of_day_reversal_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 19, 40, 3, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 253.44,
                "ema12": 253.30,
                "ema26": 253.12,
                "macd": 0.003,
                "macd_signal": 0.001,
                "rsi14": 57,
                "vol_realized_w60s": 0.00017,
                "vwap_session": 253.10,
                "spread": 0.03,
                "imbalance_bid_sz": 5200,
                "imbalance_ask_sz": 4500,
                "price_vs_session_open_bps": 8,
                "price_position_in_session_range": 0.68,
                "price_vs_opening_range_low_bps": 24,
                "session_range_bps": 74,
                "recent_spread_bps_avg": 0.72,
                "recent_spread_bps_max": 1.30,
                "recent_imbalance_pressure_avg": 0.06,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
        ):
            decisions = engine.evaluate(signal, [strategy], positions=[])

        self.assertEqual(decisions, [])

    def test_scheduler_runtime_mean_reversion_exhaustion_short_skips_exit_only_buy_without_short_inventory(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="mean-reversion-exhaustion-short",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="mean_reversion_exhaustion_short_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("12000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 24, 17, 26, 12, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=22,
            payload={
                "price": 595.80,
                "ema12": 596.20,
                "macd": 0.004,
                "macd_signal": 0.000,
                "rsi14": 41,
                "vol_realized_w60s": 0.00022,
                "vwap_session": 596.40,
                "spread": 0.05,
                "imbalance_bid_sz": 4700,
                "imbalance_ask_sz": 4300,
                "price_vs_session_open_bps": 8,
                "price_position_in_session_range": 0.38,
                "price_vs_opening_range_high_bps": -22,
                "session_range_bps": 88,
                "recent_spread_bps_avg": 0.82,
                "recent_spread_bps_max": 1.44,
                "recent_imbalance_pressure_avg": 0.04,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
        ):
            decisions = engine.evaluate(signal, [strategy], positions=[])

        self.assertEqual(decisions, [])

    def test_scheduler_runtime_mean_reversion_exhaustion_short_caps_exit_only_buy_to_short_inventory(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="mean-reversion-exhaustion-short",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="mean_reversion_exhaustion_short_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("12000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 24, 17, 26, 12, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=22,
            payload={
                "price": 595.80,
                "ema12": 596.20,
                "macd": 0.004,
                "macd_signal": 0.000,
                "rsi14": 41,
                "vol_realized_w60s": 0.00022,
                "vwap_session": 596.40,
                "spread": 0.05,
                "imbalance_bid_sz": 4700,
                "imbalance_ask_sz": 4300,
                "price_vs_session_open_bps": 8,
                "price_position_in_session_range": 0.38,
                "price_vs_opening_range_high_bps": -22,
                "session_range_bps": 88,
                "recent_spread_bps_avg": 0.82,
                "recent_spread_bps_max": 1.44,
                "recent_imbalance_pressure_avg": 0.04,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                positions=[
                    {
                        "symbol": "META",
                        "qty": "3",
                        "side": "short",
                        "market_value": "1787.40",
                        "avg_entry_price": "598.40",
                    }
                ],
            )

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].action, "buy")
        self.assertEqual(decisions[0].qty, Decimal("3"))

    def test_scheduler_runtime_mean_reversion_exhaustion_short_sell_respects_entry_policy(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="mean-reversion-exhaustion-short",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="mean-reversion-exhaustion-short",
                    strategy_id="mean_reversion_exhaustion_short_v1@policy",
                    strategy_type="sell_plugin",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="mean_reversion_exhaustion_short_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("12000"),
                    params={
                        "max_entries_per_session": "1",
                        "entry_time_in_force": "ioc",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="mean_reversion_exhaustion_short_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("12000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 24, 17, 18, 12, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=21,
            payload={"price": 598.40},
        )
        decision = StrategyDecision(
            strategy_id=str(strategy.id),
            symbol="META",
            event_ts=signal.event_ts,
            timeframe="1Sec",
            action="sell",
            qty=Decimal("20"),
            order_type="market",
            time_in_force="day",
            rationale="sell_signal",
            params={},
        )
        state = {}

        self.assertTrue(
            _passes_runtime_trade_policy(
                strategies=[strategy],
                last_emitted_action_at={},
                runtime_trade_policy_state=state,
                signal_ts=signal.event_ts,
                symbol="META",
                action="sell",
                position_owner="shared",
                positions=[],
                policy={"max_entries_per_session": 1},
            )
        )
        self.assertEqual(
            _resolve_strategy_time_in_force(strategies=[strategy], action="sell"),
            "ioc",
        )

        _record_runtime_trade_policy_decision(
            strategies=[strategy],
            runtime_trade_policy_state=state,
            signal_ts=signal.event_ts,
            symbol="META",
            position_owner="shared",
            action="sell",
            policy={"max_entries_per_session": 1},
            positions=[],
            signal=signal,
            price=Decimal("598.40"),
            decision=decision,
        )

        self.assertFalse(
            _passes_runtime_trade_policy(
                strategies=[strategy],
                last_emitted_action_at={},
                runtime_trade_policy_state=state,
                signal_ts=datetime(2026, 3, 24, 17, 19, 12, tzinfo=timezone.utc),
                symbol="META",
                action="sell",
                position_owner="shared",
                positions=[],
                policy={"max_entries_per_session": 1},
            )
        )
