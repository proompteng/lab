from __future__ import annotations

from tests.strategy_runtime.support import (
    Decimal,
    SignalEnvelope,
    Strategy,
    StrategyConfig,
    StrategyRuntime,
    TestCase,
    _compose_strategy_description,
    datetime,
    normalize_feature_vector_v3,
    timezone,
    uuid,
)


class TestStrategyRuntimeCoreB(TestCase):
    def test_intraday_tsmom_plugin_allows_late_isolated_leader_above_ema12(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-1sec-isolated-extension",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-1sec-isolated-extension",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["AAPL"],
                    max_position_pct_equity=Decimal("3.0"),
                    max_notional_per_trade=Decimal("94770"),
                    params={
                        "entry_start_minute_utc": "845",
                        "entry_end_minute_utc": "1160",
                        "max_price_above_ema12_bps": "0",
                        "min_price_below_ema12_bps": "2",
                        "min_session_open_drive_bps": "45",
                        "min_opening_window_return_bps": "20",
                        "min_cross_section_opening_window_return_rank": "0.70",
                        "min_cross_section_continuation_rank": "0.75",
                        "min_cross_section_continuation_breadth": "0.55",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("3.0"),
            max_notional_per_trade=Decimal("94770"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 24, 18, 16, 44, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 254.18,
                "spread": 0.14,
                "ema12": 254.08,
                "ema26": 253.90,
                "vwap_w5m": 254.02,
                "macd": 0.062,
                "macd_signal": 0.020,
                "rsi14": 56.9,
                "vol_realized_w60s": 0.00017,
                "price_vs_prev_session_close_bps": 32,
                "opening_window_return_from_prev_close_bps": 12,
                "session_range_bps": 64,
                "price_position_in_session_range": 0.86,
                "price_vs_opening_range_high_bps": 4,
                "recent_spread_bps_avg": 5,
                "recent_spread_bps_max": 9,
                "recent_imbalance_pressure_avg": 0.05,
                "recent_quote_invalid_ratio": 0.01,
                "recent_quote_jump_bps_max": 6,
                "recent_microprice_bias_bps_avg": 0.45,
                "cross_section_opening_window_return_from_prev_close_rank": 0.55,
                "cross_section_continuation_rank": 0.88,
                "cross_section_continuation_breadth": 0.42,
                "cross_section_range_position_rank": 0.94,
                "cross_section_vwap_w5m_rank": 0.91,
                "cross_section_recent_imbalance_rank": 0.83,
            },
        )
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()

        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "buy")

    def test_intraday_tsmom_plugin_allows_isolated_leader_with_hot_hist_and_vol(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-1sec-isolated-hot",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-1sec-isolated-hot",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["AAPL"],
                    max_position_pct_equity=Decimal("3.0"),
                    max_notional_per_trade=Decimal("94770"),
                    params={
                        "entry_start_minute_utc": "845",
                        "entry_end_minute_utc": "1160",
                        "bullish_hist_min": "0.04",
                        "bullish_hist_cap": "0.055",
                        "vol_ceil": "0.00019",
                        "max_price_above_ema12_bps": "0",
                        "min_price_below_ema12_bps": "2",
                        "min_session_open_drive_bps": "45",
                        "min_opening_window_return_bps": "20",
                        "min_cross_section_opening_window_return_rank": "0.70",
                        "min_cross_section_continuation_rank": "0.75",
                        "min_cross_section_continuation_breadth": "0.55",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("3.0"),
            max_notional_per_trade=Decimal("94770"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 24, 18, 18, 44, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 254.20,
                "spread": 0.14,
                "ema12": 254.08,
                "ema26": 253.90,
                "vwap_w5m": 254.03,
                "macd": 0.090,
                "macd_signal": 0.020,
                "rsi14": 57.2,
                "vol_realized_w60s": 0.00027,
                "price_vs_prev_session_close_bps": 38,
                "opening_window_return_from_prev_close_bps": 14,
                "session_range_bps": 72,
                "price_position_in_session_range": 0.88,
                "price_vs_opening_range_high_bps": 6,
                "recent_spread_bps_avg": 5,
                "recent_spread_bps_max": 10,
                "recent_imbalance_pressure_avg": 0.06,
                "recent_quote_invalid_ratio": 0.01,
                "recent_quote_jump_bps_max": 6,
                "recent_microprice_bias_bps_avg": 0.55,
                "cross_section_opening_window_return_from_prev_close_rank": 0.58,
                "cross_section_continuation_rank": 0.91,
                "cross_section_continuation_breadth": 0.43,
                "cross_section_range_position_rank": 0.96,
                "cross_section_vwap_w5m_rank": 0.92,
                "cross_section_recent_imbalance_rank": 0.84,
            },
        )
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()

        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "buy")

    def test_intraday_tsmom_plugin_emits_sell_for_one_second_profile(self) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-1sec",
            description="version=1.1.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["PLTR"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("2500"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 13, 13, 36, 38, tzinfo=timezone.utc),
            symbol="PLTR",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 150.9813,
                "ema12": 150.98135382176636,
                "ema26": 150.9861471734885,
                "macd": -0.004793351722122387,
                "macd_signal": -0.000495365185694872,
                "rsi14": 39.013689684962074,
                "vol_realized_w60s": 0.00011776977395581281,
            },
        )
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()

        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "sell")
        self.assertIn("tsmom_trend_down", decision.intent.rationale)

    def test_momentum_pullback_plugin_emits_buy_for_controlled_pullback(self) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="momentum-pullback",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="momentum_pullback_long_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 24, 19, 45, 55, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 593.62,
                "ema12": 594.10,
                "ema26": 593.70,
                "macd": 0.041,
                "macd_signal": 0.022,
                "rsi14": 59,
                "vol_realized_w60s": 0.00018,
                "spread": 0.05,
                "imbalance_bid_sz": 4200,
                "imbalance_ask_sz": 3800,
                "price_vs_session_open_bps": 88,
                "recent_spread_bps_avg": 0.84,
                "recent_imbalance_pressure_avg": 0.06,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "buy")
        self.assertEqual(decision.plugin_id, "momentum_pullback_long")
        self.assertIn("pullback_entry", decision.intent.rationale)

    def test_momentum_pullback_plugin_emits_sell_outside_entry_window_when_exit_triggers(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="momentum-pullback",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="momentum_pullback_long_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 24, 20, 10, 0, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 593.20,
                "ema12": 593.10,
                "ema26": 593.40,
                "macd": -0.010,
                "macd_signal": -0.004,
                "rsi14": 44,
                "vol_realized_w60s": 0.00018,
                "spread": 0.05,
                "imbalance_bid_sz": 3800,
                "imbalance_ask_sz": 4200,
                "price_vs_session_open_bps": 88,
                "recent_spread_bps_avg": 0.84,
                "recent_imbalance_pressure_avg": -0.04,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "sell")
        self.assertEqual(decision.plugin_id, "momentum_pullback_long")
        self.assertIn("momentum_pullback_exit", decision.intent.rationale)

    def test_momentum_pullback_plugin_skips_outside_entry_window_without_exit_trigger(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="momentum-pullback",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="momentum_pullback_long_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 24, 20, 10, 0, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=2,
            payload={
                "price": 593.62,
                "ema12": 594.10,
                "ema26": 593.70,
                "macd": 0.041,
                "macd_signal": 0.022,
                "rsi14": 59,
                "vol_realized_w60s": 0.00018,
                "spread": 0.05,
                "imbalance_bid_sz": 4200,
                "imbalance_ask_sz": 3800,
                "price_vs_session_open_bps": 88,
                "recent_spread_bps_avg": 0.84,
                "recent_imbalance_pressure_avg": 0.06,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNone(decision)

    def test_breakout_continuation_plugin_emits_buy_with_vwap_and_imbalance_confirmation(
        self,
    ) -> None:
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
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 523.25,
                "ema12": 523.10,
                "ema26": 522.90,
                "macd": 0.031,
                "macd_signal": 0.012,
                "rsi14": 62,
                "vol_realized_w60s": 0.00017,
                "spread": 0.04,
                "vwap_w5m": 523.10,
                "imbalance_bid_sz": 5200,
                "imbalance_ask_sz": 4300,
                "price_vs_session_open_bps": 46,
                "opening_window_return_bps": 28,
                "session_high_price": 523.70,
                "opening_range_high": 523.10,
                "price_vs_opening_range_high_bps": 3,
                "price_vs_opening_window_close_bps": 11,
                "opening_range_width_bps": 22,
                "session_range_bps": 61,
                "price_position_in_session_range": 0.89,
                "recent_spread_bps_avg": 0.76,
                "recent_spread_bps_max": 1.32,
                "recent_imbalance_pressure_avg": 0.09,
                "cross_section_opening_window_return_rank": 0.82,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "buy")
        self.assertEqual(decision.plugin_id, "breakout_continuation_long")
        self.assertIn("imbalance_confirmed", decision.intent.rationale)

    def test_breakout_continuation_plugin_skips_early_breakout_without_elite_rank_or_microstructure(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-continuation",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="breakout-continuation",
                    strategy_id="breakout_continuation_long_v1@research",
                    strategy_type="breakout_continuation_long_v1",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="breakout_continuation_long_v1",
                    universe_symbols=["INTC"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("14000"),
                    params={
                        "entry_start_minute_utc": "845",
                        "max_spread_bps": "20",
                        "max_recent_spread_bps": "18",
                        "max_recent_spread_bps_max": "60",
                        "min_recent_imbalance_pressure": "-0.12",
                        "min_cross_section_continuation_rank": "0.72",
                        "min_cross_section_opening_window_return_rank": "0.60",
                        "early_breakout_elite_continuation_rank": "0.90",
                        "min_early_breakout_continuation_breadth": "0.75",
                        "min_early_breakout_microprice_bias_bps": "0.60",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["INTC"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 23, 14, 47, 24, tzinfo=timezone.utc),
            symbol="INTC",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 45.335,
                "ema12": 45.30,
                "ema26": 45.22,
                "macd": 0.012,
                "macd_signal": 0.003,
                "rsi14": 61,
                "vol_realized_w60s": 0.00028951446164855916,
                "spread": 0.016,
                "vwap_w5m": 45.30,
                "imbalance_bid_sz": 1800,
                "imbalance_ask_sz": 300,
                "price_vs_session_open_bps": 178.49,
                "opening_window_return_bps": 127.97,
                "session_high_price": 45.47,
                "opening_range_high": 45.20,
                "price_vs_opening_range_high_bps": 29.86,
                "price_vs_opening_window_close_bps": 49.87,
                "opening_range_width_bps": 228.55,
                "session_range_bps": 289.65,
                "price_position_in_session_range": 0.8945,
                "recent_spread_bps_avg": 3.53,
                "recent_spread_bps_max": 11.02,
                "recent_imbalance_pressure_avg": 0.209,
                "recent_quote_invalid_ratio": 0,
                "recent_quote_jump_bps_max": 11.04,
                "recent_microprice_bias_bps_avg": 0.52,
                "cross_section_opening_window_return_rank": 0.82,
                "cross_section_session_open_rank": 0.82,
                "cross_section_continuation_rank": 0.87,
                "cross_section_continuation_breadth": 0.67,
                "cross_section_above_vwap_w5m_ratio": 0.75,
                "cross_section_range_position_rank": 1,
                "cross_section_vwap_w5m_rank": 0.82,
                "cross_section_recent_imbalance_rank": 0.91,
            },
        )

        runtime = StrategyRuntime()
        decision = runtime.evaluate(
            strategy, normalize_feature_vector_v3(signal), timeframe="1Sec"
        )

        self.assertIsNone(decision)

    def test_breakout_continuation_plugin_accepts_open_close_hold_when_orh_hold_is_weak(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-continuation",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="breakout-continuation",
                    strategy_id="breakout_continuation_long_v1@research",
                    strategy_type="breakout_continuation_long_v1",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="breakout_continuation_long_v1",
                    universe_symbols=["AAPL"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("14000"),
                    params={
                        "min_recent_above_opening_range_high_ratio": "0.45",
                        "min_recent_above_opening_window_close_ratio": "0.75",
                        "min_recent_above_vwap_w5m_ratio": "0.60",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 15, 12, 3, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=18,
            payload={
                "price": 254.12,
                "ema12": 254.00,
                "ema26": 253.84,
                "macd": 0.027,
                "macd_signal": 0.011,
                "rsi14": 61,
                "vol_realized_w60s": 0.00018,
                "spread": 0.03,
                "vwap_w5m": 254.00,
                "imbalance_bid_sz": 5200,
                "imbalance_ask_sz": 4700,
                "price_vs_session_open_bps": 54,
                "opening_window_return_bps": 22,
                "session_high_price": 254.28,
                "opening_range_high": 253.98,
                "price_vs_opening_range_high_bps": 5.5,
                "price_vs_opening_window_close_bps": 13,
                "opening_range_width_bps": 18,
                "session_range_bps": 52,
                "price_position_in_session_range": 0.86,
                "recent_spread_bps_avg": 0.74,
                "recent_spread_bps_max": 1.26,
                "recent_imbalance_pressure_avg": 0.05,
                "recent_microprice_bias_bps_avg": 0.72,
                "recent_above_opening_range_high_ratio": 0.20,
                "recent_above_opening_window_close_ratio": 0.88,
                "recent_above_vwap_w5m_ratio": 0.83,
                "cross_section_positive_session_open_ratio": 0.58,
                "cross_section_positive_opening_window_return_ratio": 0.67,
                "cross_section_above_vwap_w5m_ratio": 0.51,
                "cross_section_continuation_breadth": 0.60,
                "cross_section_opening_window_return_rank": 0.82,
                "cross_section_continuation_rank": 0.84,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "buy")
        self.assertEqual(decision.plugin_id, "breakout_continuation_long")

    def test_breakout_continuation_plugin_allows_early_breakout_with_strong_microstructure_confirmation(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-continuation",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="breakout-continuation",
                    strategy_id="breakout_continuation_long_v1@research",
                    strategy_type="breakout_continuation_long_v1",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="breakout_continuation_long_v1",
                    universe_symbols=["AAPL"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("14000"),
                    params={
                        "entry_start_minute_utc": "845",
                        "max_spread_bps": "20",
                        "max_recent_spread_bps": "18",
                        "max_recent_spread_bps_max": "60",
                        "min_recent_imbalance_pressure": "-0.12",
                        "min_cross_section_continuation_rank": "0.72",
                        "min_cross_section_opening_window_return_rank": "0.60",
                        "early_breakout_elite_continuation_rank": "0.90",
                        "min_early_breakout_continuation_breadth": "0.75",
                        "min_early_breakout_microprice_bias_bps": "0.60",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 14, 13, 8, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 254.79,
                "ema12": 254.62,
                "ema26": 254.11,
                "macd": 0.019,
                "macd_signal": 0.007,
                "rsi14": 64,
                "vol_realized_w60s": 0.0002841520287386722,
                "spread": 0.12,
                "vwap_w5m": 254.70,
                "imbalance_bid_sz": 200,
                "imbalance_ask_sz": 100,
                "price_vs_session_open_bps": 396.62,
                "opening_window_return_bps": 376.63,
                "session_high_price": 254.80,
                "opening_range_high": 254.30,
                "price_vs_opening_range_high_bps": 19.27,
                "price_vs_opening_window_close_bps": 19.27,
                "opening_range_width_bps": 376.63,
                "session_range_bps": 397.03,
                "price_position_in_session_range": 0.999,
                "recent_spread_bps_avg": 8.18,
                "recent_spread_bps_max": 23.56,
                "recent_imbalance_pressure_avg": 0.139,
                "recent_quote_invalid_ratio": 0.0667,
                "recent_quote_jump_bps_max": 10.99,
                "recent_microprice_bias_bps_avg": 0.80,
                "cross_section_opening_window_return_rank": 1.0,
                "cross_section_session_open_rank": 1.0,
                "cross_section_continuation_rank": 0.88,
                "cross_section_continuation_breadth": 0.82,
                "cross_section_above_vwap_w5m_ratio": 1.0,
                "cross_section_range_position_rank": 1.0,
                "cross_section_vwap_w5m_rank": 1.0,
                "cross_section_recent_imbalance_rank": 1.0,
            },
        )

        runtime = StrategyRuntime()
        decision = runtime.evaluate(
            strategy, normalize_feature_vector_v3(signal), timeframe="1Sec"
        )

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "buy")
        self.assertEqual(decision.plugin_id, "breakout_continuation_long")

    def test_breakout_continuation_plugin_scales_target_notional_by_cross_section_rank(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-continuation",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="breakout-continuation",
                    strategy_id="breakout_continuation_long_v1@research",
                    strategy_type="breakout_continuation_long_v1",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="breakout_continuation_long_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("14000"),
                    params={
                        "min_cross_section_continuation_rank": "0.70",
                        "entry_notional_min_multiplier": "0.15",
                        "entry_notional_rank_floor": "0.70",
                        "entry_notional_rank_ceiling": "0.95",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal_payload = {
            "price": 523.25,
            "ema12": 523.10,
            "ema26": 522.90,
            "macd": 0.031,
            "macd_signal": 0.012,
            "rsi14": 62,
            "vol_realized_w60s": 0.00017,
            "spread": 0.04,
            "vwap_w5m": 523.10,
            "imbalance_bid_sz": 5200,
            "imbalance_ask_sz": 4300,
            "price_vs_session_open_bps": 46,
            "opening_window_return_bps": 28,
            "session_high_price": 523.70,
            "opening_range_high": 523.10,
            "price_vs_opening_range_high_bps": 3,
            "price_vs_opening_window_close_bps": 11,
            "opening_range_width_bps": 22,
            "session_range_bps": 61,
            "price_position_in_session_range": 0.89,
            "recent_spread_bps_avg": 0.76,
            "recent_spread_bps_max": 1.32,
            "recent_imbalance_pressure_avg": 0.09,
            "cross_section_opening_window_return_rank": 0.82,
        }
        weak_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=21,
            payload=signal_payload | {"cross_section_continuation_rank": 0.72},
        )
        strong_signal = weak_signal.model_copy(
            update={
                "seq": 22,
                "payload": signal_payload | {"cross_section_continuation_rank": 0.95},
            }
        )

        runtime = StrategyRuntime()
        weak_decision = runtime.evaluate(
            strategy, normalize_feature_vector_v3(weak_signal), timeframe="1Sec"
        )
        strong_decision = runtime.evaluate(
            strategy, normalize_feature_vector_v3(strong_signal), timeframe="1Sec"
        )

        self.assertIsNotNone(weak_decision)
        self.assertIsNotNone(strong_decision)
        assert weak_decision is not None
        assert strong_decision is not None
        self.assertLess(
            weak_decision.intent.target_notional,
            strong_decision.intent.target_notional,
        )
        self.assertLess(weak_decision.intent.target_notional, Decimal("14000"))
        self.assertLessEqual(strong_decision.intent.target_notional, Decimal("14000"))

    def test_breakout_continuation_plugin_respects_cross_section_rank_floor(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-continuation",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="breakout-continuation",
                    strategy_id="breakout_continuation_long_v1@research",
                    strategy_type="breakout_continuation_long_v1",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="breakout_continuation_long_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("14000"),
                    params={"min_cross_section_continuation_rank": "0.90"},
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=11,
            payload={
                "price": 523.25,
                "ema12": 523.10,
                "ema26": 522.90,
                "macd": 0.031,
                "macd_signal": 0.012,
                "rsi14": 62,
                "vol_realized_w60s": 0.00017,
                "spread": 0.04,
                "vwap_w5m": 523.10,
                "imbalance_bid_sz": 5200,
                "imbalance_ask_sz": 4300,
                "price_vs_session_open_bps": 46,
                "session_high_price": 523.70,
                "opening_range_high": 523.10,
                "price_vs_opening_range_high_bps": 3,
                "opening_range_width_bps": 22,
                "session_range_bps": 61,
                "price_position_in_session_range": 0.89,
                "recent_spread_bps_avg": 0.76,
                "recent_spread_bps_max": 1.32,
                "recent_imbalance_pressure_avg": 0.09,
                "cross_section_continuation_rank": 0.40,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNone(decision)
