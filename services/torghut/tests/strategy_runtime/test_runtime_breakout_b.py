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


class TestStrategyRuntimeBreakoutB(TestCase):
    def test_breakout_continuation_plugin_allows_isolated_flow_without_clean_orh_rebreak(
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
                    universe_symbols=["NVDA"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("14000"),
                    params={
                        "min_session_high_above_opening_range_high_bps": "4",
                        "min_price_vs_opening_range_high_bps": "-12",
                        "max_price_vs_opening_window_close_bps": "18",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["NVDA"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 24, 18, 3, 3, tzinfo=timezone.utc),
            symbol="NVDA",
            timeframe="1Sec",
            seq=57,
            payload={
                "price": 969.28,
                "ema12": 968.96,
                "ema26": 968.25,
                "macd": 0.047,
                "macd_signal": 0.018,
                "rsi14": 65,
                "vol_realized_w60s": 0.00019,
                "spread": 0.08,
                "vwap_w5m": 968.98,
                "imbalance_bid_sz": 7200,
                "imbalance_ask_sz": 5100,
                "price_vs_session_open_bps": 56,
                "opening_window_return_bps": 20,
                "session_high_price": 969.44,
                "opening_range_high": 969.40,
                "price_vs_opening_range_high_bps": -12.38208687933863171653008561,
                "price_vs_opening_window_close_bps": 24.0,
                "opening_range_width_bps": 24,
                "session_range_bps": 63,
                "price_position_in_session_range": 0.92,
                "recent_spread_bps_avg": 0.82,
                "recent_spread_bps_max": 1.41,
                "recent_imbalance_pressure_avg": 0.10,
                "recent_microprice_bias_bps_avg": 1.15,
                "cross_section_positive_session_open_ratio": 0.42,
                "cross_section_positive_opening_window_return_ratio": 0.46,
                "cross_section_above_vwap_w5m_ratio": 0.48,
                "cross_section_continuation_breadth": 0.52,
                "cross_section_session_open_rank": 0.48,
                "cross_section_opening_window_return_rank": 0.54,
                "cross_section_range_position_rank": 0.98,
                "cross_section_vwap_w5m_rank": 0.95,
                "cross_section_recent_imbalance_rank": 0.93,
                "cross_section_continuation_rank": 0.79,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "buy")
        self.assertEqual(decision.plugin_id, "breakout_continuation_long")

    def test_breakout_continuation_plugin_allows_isolated_leader_near_high_shape(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-continuation",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["NVDA"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 24, 18, 8, 3, tzinfo=timezone.utc),
            symbol="NVDA",
            timeframe="1Sec",
            seq=61,
            payload={
                "price": 969.28,
                "ema12": 968.96,
                "ema26": 968.25,
                "macd": 0.047,
                "macd_signal": 0.018,
                "rsi14": 65,
                "vol_realized_w60s": 0.00019,
                "spread": 0.08,
                "vwap_w5m": 968.98,
                "imbalance_bid_sz": 7200,
                "imbalance_ask_sz": 5100,
                "price_vs_session_open_bps": 56,
                "opening_window_return_bps": 20,
                "session_high_price": 969.40,
                "opening_range_high": 969.40,
                "price_vs_opening_range_high_bps": -17.5,
                "price_vs_opening_window_close_bps": 44.0,
                "opening_range_width_bps": 24,
                "session_range_bps": 63,
                "price_position_in_session_range": 0.94,
                "recent_spread_bps_avg": 0.82,
                "recent_spread_bps_max": 1.41,
                "recent_imbalance_pressure_avg": 0.10,
                "recent_microprice_bias_bps_avg": 1.15,
                "cross_section_session_open_rank": 0.48,
                "cross_section_opening_window_return_rank": 0.54,
                "cross_section_range_position_rank": 0.98,
                "cross_section_vwap_w5m_rank": 0.95,
                "cross_section_recent_imbalance_rank": 0.93,
                "cross_section_continuation_rank": 0.79,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "buy")
        self.assertEqual(decision.plugin_id, "breakout_continuation_long")

    def test_breakout_continuation_plugin_allows_relaxed_isolated_strength_thresholds(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-continuation",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["NVDA"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 24, 18, 11, 3, tzinfo=timezone.utc),
            symbol="NVDA",
            timeframe="1Sec",
            seq=63,
            payload={
                "price": 969.36,
                "ema12": 968.98,
                "ema26": 968.31,
                "macd": 0.046,
                "macd_signal": 0.018,
                "rsi14": 65,
                "vol_realized_w60s": 0.00019,
                "spread": 0.08,
                "vwap_w5m": 969.02,
                "imbalance_bid_sz": 7000,
                "imbalance_ask_sz": 5100,
                "price_vs_session_open_bps": 55,
                "opening_window_return_bps": 20,
                "session_high_price": 969.40,
                "opening_range_high": 969.40,
                "price_vs_opening_range_high_bps": -17.5,
                "price_vs_opening_window_close_bps": 42.0,
                "opening_range_width_bps": 24,
                "session_range_bps": 63,
                "price_position_in_session_range": 0.92,
                "recent_spread_bps_avg": 0.82,
                "recent_spread_bps_max": 1.41,
                "recent_imbalance_pressure_avg": 0.10,
                "recent_microprice_bias_bps_avg": 1.15,
                "cross_section_session_open_rank": 0.48,
                "cross_section_opening_window_return_rank": 0.54,
                "cross_section_range_position_rank": 0.86,
                "cross_section_vwap_w5m_rank": 0.76,
                "cross_section_recent_imbalance_rank": 0.77,
                "cross_section_continuation_rank": 0.79,
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

    def test_breakout_continuation_plugin_relaxes_recent_microstructure_for_isolated_leader(
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
                        "hard_max_recent_quote_invalid_ratio": "0.22",
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
            event_ts=datetime(2026, 3, 24, 16, 7, 34, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=62,
            payload={
                "price": 254.10,
                "ema12": 253.96,
                "ema26": 253.70,
                "macd": 0.036,
                "macd_signal": 0.018,
                "rsi14": 64,
                "vol_realized_w60s": 0.00014,
                "spread": 0.03,
                "vwap_w5m": 253.99,
                "imbalance_bid_sz": 5600,
                "imbalance_ask_sz": 4700,
                "price_vs_session_open_bps": 52,
                "opening_window_return_bps": 20,
                "session_high_price": 254.16,
                "opening_range_high": 254.20,
                "price_vs_opening_range_high_bps": -4,
                "price_vs_opening_window_close_bps": 10,
                "opening_range_width_bps": 20,
                "session_range_bps": 44,
                "price_position_in_session_range": 0.93,
                "recent_spread_bps_avg": 7.7,
                "recent_spread_bps_max": 24.4,
                "recent_imbalance_pressure_avg": 0.05,
                "recent_quote_invalid_ratio": 0.20,
                "recent_quote_jump_bps_max": 12.8,
                "recent_microprice_bias_bps_avg": 0.37,
                "cross_section_range_position_rank": 0.95,
                "cross_section_vwap_w5m_rank": 0.93,
                "cross_section_recent_imbalance_rank": 0.91,
                "cross_section_continuation_rank": 0.89,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "buy")
        self.assertEqual(decision.plugin_id, "breakout_continuation_long")

    def test_breakout_continuation_plugin_blocks_isolated_leader_with_hard_invalid_quote_ratio(
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
                        "hard_max_recent_quote_invalid_ratio": "0.12",
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
            event_ts=datetime(2026, 3, 24, 16, 7, 34, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=63,
            payload={
                "price": 254.10,
                "ema12": 253.96,
                "ema26": 253.70,
                "macd": 0.036,
                "macd_signal": 0.018,
                "rsi14": 64,
                "vol_realized_w60s": 0.00014,
                "spread": 0.03,
                "vwap_w5m": 253.99,
                "imbalance_bid_sz": 5600,
                "imbalance_ask_sz": 4700,
                "price_vs_session_open_bps": 52,
                "opening_window_return_bps": 20,
                "session_high_price": 254.16,
                "opening_range_high": 254.20,
                "price_vs_opening_range_high_bps": -4,
                "price_vs_opening_window_close_bps": 10,
                "opening_range_width_bps": 20,
                "session_range_bps": 44,
                "price_position_in_session_range": 0.93,
                "recent_spread_bps_avg": 7.7,
                "recent_spread_bps_max": 24.4,
                "recent_imbalance_pressure_avg": 0.05,
                "recent_quote_invalid_ratio": 0.20,
                "recent_quote_jump_bps_max": 12.8,
                "recent_microprice_bias_bps_avg": 0.37,
                "cross_section_range_position_rank": 0.95,
                "cross_section_vwap_w5m_rank": 0.93,
                "cross_section_recent_imbalance_rank": 0.91,
                "cross_section_continuation_rank": 0.89,
            },
        )

        runtime = StrategyRuntime()
        decision = runtime.evaluate(
            strategy, normalize_feature_vector_v3(signal), timeframe="1Sec"
        )

        self.assertIsNone(decision)

    def test_breakout_continuation_plugin_prefers_prev_close_opening_drive(
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
                        "min_opening_window_return_bps": "20",
                        "min_cross_section_opening_window_return_rank": "0.70",
                        "late_session_min_session_open_return_efficiency": "0.20",
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
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=18,
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
                "price_vs_session_open_bps": 18,
                "price_vs_prev_session_close_bps": 51,
                "opening_window_return_bps": 6,
                "opening_window_return_from_prev_close_bps": 28,
                "session_high_price": 523.70,
                "opening_range_high": 523.10,
                "price_vs_opening_range_high_bps": 3,
                "price_vs_opening_window_close_bps": 2,
                "opening_range_width_bps": 22,
                "session_range_bps": 61,
                "price_position_in_session_range": 0.89,
                "recent_spread_bps_avg": 0.76,
                "recent_spread_bps_max": 1.32,
                "recent_imbalance_pressure_avg": 0.09,
                "cross_section_positive_session_open_ratio": 0.33,
                "cross_section_positive_prev_session_close_ratio": 0.67,
                "cross_section_positive_opening_window_return_ratio": 0.35,
                "cross_section_positive_opening_window_return_from_prev_close_ratio": 0.75,
                "cross_section_above_vwap_w5m_ratio": 0.58,
                "cross_section_continuation_breadth": 0.62,
                "cross_section_opening_window_return_rank": 0.35,
                "cross_section_opening_window_return_from_prev_close_rank": 0.83,
                "cross_section_continuation_rank": 0.84,
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

    def test_breakout_continuation_plugin_does_not_exit_on_single_reference_loss(
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
            event_ts=datetime(2026, 3, 27, 18, 4, 3, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=2,
            payload={
                "price": 523.00,
                "ema12": 523.10,
                "ema26": 522.90,
                "macd": 0.014,
                "macd_signal": 0.015,
                "rsi14": 58,
                "vol_realized_w60s": 0.00017,
                "spread": 0.04,
                "vwap_w5m": 523.05,
                "imbalance_bid_sz": 5200,
                "imbalance_ask_sz": 4300,
                "price_vs_session_open_bps": 39,
                "price_vs_opening_range_high_bps": -1,
                "session_high_price": 523.40,
                "opening_range_high": 523.05,
                "opening_range_width_bps": 20,
                "session_range_bps": 49,
                "price_position_in_session_range": 0.70,
                "recent_spread_bps_avg": 0.79,
                "recent_spread_bps_max": 1.40,
                "recent_imbalance_pressure_avg": 0.05,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNone(decision)

    def test_breakout_continuation_plugin_emits_sell_on_confirmed_breakout_failure(
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
            event_ts=datetime(2026, 3, 27, 18, 5, 3, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=3,
            payload={
                "price": 522.90,
                "ema12": 523.10,
                "ema26": 522.95,
                "macd": 0.010,
                "macd_signal": 0.012,
                "rsi14": 54,
                "vol_realized_w60s": 0.00017,
                "spread": 0.04,
                "vwap_w5m": 523.15,
                "imbalance_bid_sz": 4700,
                "imbalance_ask_sz": 5000,
                "price_vs_session_open_bps": 34,
                "price_vs_opening_range_high_bps": -9,
                "session_high_price": 523.60,
                "opening_range_high": 523.15,
                "opening_range_width_bps": 22,
                "session_range_bps": 55,
                "price_position_in_session_range": 0.40,
                "recent_spread_bps_avg": 1.05,
                "recent_spread_bps_max": 1.88,
                "recent_imbalance_pressure_avg": -0.04,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime(trace_enabled=True)
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "sell")
        self.assertEqual(decision.plugin_id, "breakout_continuation_long")
        self.assertIn("breakout_failed", decision.intent.rationale)
        self.assertIsNotNone(decision.trace)
        assert decision.trace is not None
        exit_gate = decision.trace.gates[-1]
        self.assertTrue(exit_gate.passed)
        self.assertTrue(exit_gate.context["reasons"]["breakout_failure_confirmed"])

    def test_breakout_continuation_plugin_does_not_exit_on_momentum_rollover_above_structure(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-continuation",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 14, 18, 40, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=4,
            payload={
                "price": 255.415,
                "ema12": 255.4872,
                "ema26": 255.4381,
                "macd": 0.0491,
                "macd_signal": 0.0600,
                "rsi14": 47.16,
                "vol_realized_w60s": 0.000167,
                "spread": 0.03,
                "vwap_w5m": 255.1747,
                "imbalance_bid_sz": 100,
                "imbalance_ask_sz": 200,
                "price_vs_session_open_bps": 68,
                "price_vs_opening_range_high_bps": 6,
                "session_high_price": 255.74,
                "opening_range_high": 255.26,
                "opening_range_width_bps": 376.63,
                "session_range_bps": 508.52,
                "price_position_in_session_range": 0.83,
                "recent_spread_bps_avg": 6.38,
                "recent_spread_bps_max": 23.56,
                "recent_imbalance_pressure_avg": 0.07,
                "recent_microprice_bias_bps_avg": 0.54,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNone(decision)

    def test_breakout_continuation_plugin_does_not_exit_on_negative_imbalance_above_structure(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-continuation",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 14, 18, 55, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=5,
            payload={
                "price": 255.42,
                "ema12": 255.4845,
                "ema26": 255.4544,
                "macd": 0.0301,
                "macd_signal": 0.0372,
                "rsi14": 52.05,
                "vol_realized_w60s": 0.000167,
                "spread": 0.03,
                "vwap_w5m": 255.1920,
                "imbalance_bid_sz": 100,
                "imbalance_ask_sz": 200,
                "price_vs_session_open_bps": 68,
                "price_vs_opening_range_high_bps": 6,
                "session_high_price": 255.74,
                "opening_range_high": 255.26,
                "opening_range_width_bps": 376.63,
                "session_range_bps": 508.52,
                "price_position_in_session_range": 0.83,
                "recent_spread_bps_avg": 6.38,
                "recent_spread_bps_max": 23.56,
                "recent_imbalance_pressure_avg": -0.04,
                "recent_microprice_bias_bps_avg": 0.54,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNone(decision)

    def test_breakout_continuation_plugin_does_not_exit_on_vwap_dip_above_structure(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-continuation",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 14, 19, 23, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=6,
            payload={
                "price": 255.21,
                "ema12": 255.3729,
                "ema26": 255.4043,
                "macd": -0.0313,
                "macd_signal": -0.0057,
                "rsi14": 31.4,
                "vol_realized_w60s": 0.00017,
                "spread": 0.03,
                "vwap_w5m": 255.2437,
                "imbalance_bid_sz": 100,
                "imbalance_ask_sz": 200,
                "price_vs_session_open_bps": 413.76,
                "price_vs_opening_range_high_bps": 35.78,
                "session_high_price": 255.765,
                "opening_range_high": 254.3,
                "opening_range_width_bps": 376.63,
                "session_range_bps": 436.41,
                "price_position_in_session_range": 0.948,
                "recent_spread_bps_avg": 6.95,
                "recent_spread_bps_max": 28.16,
                "recent_imbalance_pressure_avg": -0.111,
                "recent_microprice_bias_bps_avg": -0.074,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNone(decision)

    def test_breakout_continuation_plugin_exits_on_negative_imbalance_after_structure_loss(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-continuation",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 14, 24, 5, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=6,
            payload={
                "price": 255.16,
                "ema12": 255.10,
                "ema26": 255.22,
                "macd": 0.028,
                "macd_signal": 0.026,
                "rsi14": 58.2,
                "vol_realized_w60s": 0.000170,
                "spread": 0.03,
                "vwap_w5m": 255.19,
                "imbalance_bid_sz": 100,
                "imbalance_ask_sz": 200,
                "price_vs_session_open_bps": 54,
                "price_vs_opening_range_high_bps": 2,
                "session_high_price": 255.74,
                "opening_range_high": 255.26,
                "opening_range_width_bps": 376.63,
                "session_range_bps": 508.52,
                "price_position_in_session_range": 0.74,
                "recent_spread_bps_avg": 5.9,
                "recent_spread_bps_max": 12.5,
                "recent_imbalance_pressure_avg": -0.05,
                "recent_microprice_bias_bps_avg": 0.12,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "sell")
        self.assertEqual(decision.plugin_id, "breakout_continuation_long")
        self.assertIn("session_strength_reversal", decision.intent.rationale)

    def test_breakout_continuation_plugin_does_not_exit_when_orh_distance_missing(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-continuation",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 14, 24, 5, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=6,
            payload={
                "price": 255.16,
                "ema12": 255.10,
                "ema26": 255.22,
                "macd": 0.028,
                "macd_signal": 0.026,
                "rsi14": 58.2,
                "vol_realized_w60s": 0.000170,
                "spread": 0.03,
                "vwap_w5m": 255.22,
                "imbalance_bid_sz": 160,
                "imbalance_ask_sz": 120,
                "price_vs_session_open_bps": 54,
                "session_high_price": 255.74,
                "opening_range_high": 255.26,
                "opening_range_width_bps": 376.63,
                "session_range_bps": 508.52,
                "price_position_in_session_range": 0.74,
                "recent_spread_bps_avg": 5.9,
                "recent_spread_bps_max": 12.5,
                "recent_imbalance_pressure_avg": 0.01,
                "recent_microprice_bias_bps_avg": 0.12,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNone(decision)
