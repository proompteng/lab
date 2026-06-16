from __future__ import annotations

# ruff: noqa: F401,F403,F405
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


class TestStrategyRuntimeLateDayA(TestCase):
    def test_breakout_continuation_plugin_skips_late_entry_near_flatten(self) -> None:
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
                        "entry_start_minute_utc": "840",
                        "entry_end_minute_utc": "1170",
                        "session_flatten_start_minute_utc": "1170",
                        "min_entry_minutes_before_flatten": "15",
                        "min_price_vs_vwap_w5m_bps": "-6",
                        "max_price_vs_vwap_w5m_bps": "18",
                        "min_imbalance_pressure": "0.02",
                        "max_spread_bps": "6",
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
            event_ts=datetime(2026, 3, 27, 19, 20, 3, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=4,
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
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNone(decision)

    def test_breakout_continuation_plugin_respects_latest_breakout_entry_end(
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
                        "entry_end_minute_utc": "990",
                        "latest_breakout_entry_end_minute_utc": "980",
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
            event_ts=datetime(2026, 3, 24, 16, 26, 28, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=61,
            payload={
                "price": 255.00,
                "ema12": 254.86,
                "ema26": 254.62,
                "macd": 0.036,
                "macd_signal": 0.018,
                "rsi14": 64,
                "vol_realized_w60s": 0.00014,
                "spread": 0.03,
                "vwap_w5m": 254.92,
                "imbalance_bid_sz": 5600,
                "imbalance_ask_sz": 4700,
                "price_vs_session_open_bps": 52,
                "opening_window_return_bps": 20,
                "session_high_price": 255.06,
                "opening_range_high": 255.04,
                "price_vs_opening_range_high_bps": -1.6,
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

    def test_late_day_continuation_plugin_emits_buy_on_late_strength(self) -> None:
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
            event_ts=datetime(2026, 3, 26, 18, 58, 3, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=5,
            payload={
                "price": 253.93,
                "ema12": 253.82,
                "ema26": 253.60,
                "macd": 0.028,
                "macd_signal": 0.014,
                "rsi14": 63,
                "vol_realized_w60s": 0.00019,
                "spread": 0.03,
                "vwap_w5m": 253.88,
                "imbalance_bid_sz": 5400,
                "imbalance_ask_sz": 5000,
                "price_vs_session_open_bps": 58,
                "opening_window_return_bps": 32,
                "price_position_in_session_range": 0.92,
                "session_high_price": 254.02,
                "opening_range_high": 253.86,
                "price_vs_opening_range_high_bps": 2.8,
                "price_vs_opening_window_close_bps": 9.5,
                "recent_spread_bps_avg": 0.61,
                "recent_imbalance_pressure_avg": 0.03,
                "session_range_bps": 48,
                "cross_section_positive_session_open_ratio": 0.58,
                "cross_section_positive_opening_window_return_ratio": 0.66,
                "cross_section_above_vwap_w5m_ratio": 0.50,
                "cross_section_continuation_breadth": 0.62,
                "cross_section_opening_window_return_rank": 0.88,
                "cross_section_continuation_rank": 0.84,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "buy")
        self.assertEqual(decision.plugin_id, "late_day_continuation_long")
        self.assertIn("late_day_strength", decision.intent.rationale)

    def test_late_day_continuation_plugin_prefers_live_structure_rank(self) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="late-day-continuation",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="late-day-continuation",
                    strategy_id="late_day_continuation_long_v1@research",
                    strategy_type="late_day_continuation_long_v1",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="late_day_continuation_long_v1",
                    universe_symbols=["AAPL"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("14000"),
                    params={
                        "min_opening_window_return_bps": "18",
                        "min_cross_section_opening_window_return_rank": "0.65",
                        "min_cross_section_continuation_rank": "0.78",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="late_day_continuation_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 18, 58, 3, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=55,
            payload={
                "price": 253.93,
                "ema12": 253.82,
                "ema26": 253.60,
                "macd": 0.028,
                "macd_signal": 0.014,
                "rsi14": 63,
                "vol_realized_w60s": 0.00019,
                "spread": 0.03,
                "vwap_w5m": 253.88,
                "imbalance_bid_sz": 5400,
                "imbalance_ask_sz": 5000,
                "price_vs_session_open_bps": 58,
                "opening_window_return_bps": 24,
                "price_position_in_session_range": 0.92,
                "session_high_price": 254.02,
                "opening_range_high": 253.86,
                "price_vs_opening_range_high_bps": 2.8,
                "price_vs_opening_window_close_bps": 9.5,
                "recent_spread_bps_avg": 0.61,
                "recent_imbalance_pressure_avg": 0.03,
                "recent_microprice_bias_bps_avg": 0.9,
                "session_range_bps": 48,
                "cross_section_positive_session_open_ratio": 0.58,
                "cross_section_positive_opening_window_return_ratio": 0.66,
                "cross_section_above_vwap_w5m_ratio": 0.50,
                "cross_section_continuation_breadth": 0.62,
                "cross_section_session_open_rank": 0.42,
                "cross_section_opening_window_return_rank": 0.35,
                "cross_section_range_position_rank": 0.95,
                "cross_section_vwap_w5m_rank": 0.93,
                "cross_section_recent_imbalance_rank": 0.91,
                "cross_section_continuation_rank": 0.45,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "buy")
        self.assertEqual(decision.plugin_id, "late_day_continuation_long")
        self.assertIn("late_day_strength", decision.intent.rationale)

    def test_late_day_continuation_plugin_respects_recent_hold_quality(self) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="late-day-continuation",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="late-day-continuation",
                    strategy_id="late_day_continuation_long_v1@research",
                    strategy_type="late_day_continuation_long_v1",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="late_day_continuation_long_v1",
                    universe_symbols=["AAPL"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("14000"),
                    params={
                        "min_recent_above_opening_range_high_ratio": "0.45",
                        "min_recent_above_vwap_w5m_ratio": "0.70",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="late_day_continuation_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        strong_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 18, 58, 3, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=56,
            payload={
                "price": 253.93,
                "ema12": 253.82,
                "ema26": 253.60,
                "macd": 0.028,
                "macd_signal": 0.014,
                "rsi14": 63,
                "vol_realized_w60s": 0.00019,
                "spread": 0.03,
                "vwap_w5m": 253.88,
                "imbalance_bid_sz": 5400,
                "imbalance_ask_sz": 5000,
                "price_vs_session_open_bps": 58,
                "opening_window_return_bps": 32,
                "price_position_in_session_range": 0.92,
                "session_high_price": 254.02,
                "opening_range_high": 253.86,
                "price_vs_opening_range_high_bps": 2.8,
                "price_vs_opening_window_close_bps": 9.5,
                "recent_spread_bps_avg": 0.61,
                "recent_imbalance_pressure_avg": 0.03,
                "recent_microprice_bias_bps_avg": 0.9,
                "recent_above_opening_range_high_ratio": 0.65,
                "recent_above_vwap_w5m_ratio": 0.90,
                "session_range_bps": 48,
                "cross_section_positive_session_open_ratio": 0.58,
                "cross_section_positive_opening_window_return_ratio": 0.66,
                "cross_section_above_vwap_w5m_ratio": 0.50,
                "cross_section_continuation_breadth": 0.62,
                "cross_section_opening_window_return_rank": 0.88,
                "cross_section_continuation_rank": 0.84,
            },
        )
        weak_signal = strong_signal.model_copy(
            update={
                "seq": 57,
                "payload": {
                    **strong_signal.payload,
                    "recent_above_opening_range_high_ratio": Decimal("0.20"),
                    "recent_above_vwap_w5m_ratio": Decimal("0.40"),
                },
            }
        )

        runtime = StrategyRuntime()

        strong_decision = runtime.evaluate(
            strategy,
            normalize_feature_vector_v3(strong_signal),
            timeframe="1Sec",
        )
        weak_decision = runtime.evaluate(
            strategy,
            normalize_feature_vector_v3(weak_signal),
            timeframe="1Sec",
        )

        self.assertIsNotNone(strong_decision)
        assert strong_decision is not None
        self.assertEqual(strong_decision.intent.action, "buy")
        self.assertIsNone(weak_decision)

    def test_late_day_continuation_plugin_accepts_open_close_hold_when_orh_hold_is_weak(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="late-day-continuation",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="late-day-continuation",
                    strategy_id="late_day_continuation_long_v1@research",
                    strategy_type="late_day_continuation_long_v1",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="late_day_continuation_long_v1",
                    universe_symbols=["AAPL"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("14000"),
                    params={
                        "min_recent_above_opening_range_high_ratio": "0.45",
                        "min_recent_above_opening_window_close_ratio": "0.80",
                        "min_recent_above_vwap_w5m_ratio": "0.70",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="late_day_continuation_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 18, 58, 3, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=156,
            payload={
                "price": 253.93,
                "ema12": 253.82,
                "ema26": 253.60,
                "macd": 0.028,
                "macd_signal": 0.014,
                "rsi14": 63,
                "vol_realized_w60s": 0.00019,
                "spread": 0.03,
                "vwap_w5m": 253.88,
                "imbalance_bid_sz": 5400,
                "imbalance_ask_sz": 5000,
                "price_vs_session_open_bps": 58,
                "opening_window_return_bps": 32,
                "price_position_in_session_range": 0.92,
                "session_high_price": 254.02,
                "opening_range_high": 253.86,
                "price_vs_opening_range_high_bps": 2.8,
                "price_vs_opening_window_close_bps": 9.5,
                "recent_spread_bps_avg": 0.61,
                "recent_imbalance_pressure_avg": 0.03,
                "recent_microprice_bias_bps_avg": 0.9,
                "recent_above_opening_range_high_ratio": 0.22,
                "recent_above_opening_window_close_ratio": 0.92,
                "recent_above_vwap_w5m_ratio": 0.90,
                "session_range_bps": 48,
                "cross_section_positive_session_open_ratio": 0.58,
                "cross_section_positive_opening_window_return_ratio": 0.66,
                "cross_section_above_vwap_w5m_ratio": 0.50,
                "cross_section_continuation_breadth": 0.62,
                "cross_section_opening_window_return_rank": 0.88,
                "cross_section_continuation_rank": 0.84,
            },
        )

        runtime = StrategyRuntime()
        decision = runtime.evaluate(
            strategy,
            normalize_feature_vector_v3(signal),
            timeframe="1Sec",
        )

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "buy")
        self.assertEqual(decision.plugin_id, "late_day_continuation_long")

    def test_late_day_continuation_plugin_blocks_when_open_close_hold_is_weak(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="late-day-continuation",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="late-day-continuation",
                    strategy_id="late_day_continuation_long_v1@research",
                    strategy_type="late_day_continuation_long_v1",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="late_day_continuation_long_v1",
                    universe_symbols=["AAPL"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("14000"),
                    params={
                        "min_recent_above_opening_range_high_ratio": "0.45",
                        "min_recent_above_opening_window_close_ratio": "0.80",
                        "min_recent_above_vwap_w5m_ratio": "0.70",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="late_day_continuation_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 18, 58, 3, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=157,
            payload={
                "price": 253.93,
                "ema12": 253.82,
                "ema26": 253.60,
                "macd": 0.028,
                "macd_signal": 0.014,
                "rsi14": 63,
                "vol_realized_w60s": 0.00019,
                "spread": 0.03,
                "vwap_w5m": 253.88,
                "imbalance_bid_sz": 5400,
                "imbalance_ask_sz": 5000,
                "price_vs_session_open_bps": 58,
                "opening_window_return_bps": 32,
                "price_position_in_session_range": 0.92,
                "session_high_price": 254.02,
                "opening_range_high": 253.86,
                "price_vs_opening_range_high_bps": 2.8,
                "price_vs_opening_window_close_bps": 9.5,
                "recent_spread_bps_avg": 0.61,
                "recent_imbalance_pressure_avg": 0.03,
                "recent_microprice_bias_bps_avg": 0.9,
                "recent_above_opening_range_high_ratio": 0.88,
                "recent_above_opening_window_close_ratio": 0.62,
                "recent_above_vwap_w5m_ratio": 0.90,
                "session_range_bps": 48,
                "cross_section_positive_session_open_ratio": 0.58,
                "cross_section_positive_opening_window_return_ratio": 0.66,
                "cross_section_above_vwap_w5m_ratio": 0.50,
                "cross_section_continuation_breadth": 0.62,
                "cross_section_opening_window_return_rank": 0.88,
                "cross_section_continuation_rank": 0.84,
            },
        )

        runtime = StrategyRuntime()
        decision = runtime.evaluate(
            strategy,
            normalize_feature_vector_v3(signal),
            timeframe="1Sec",
        )

        self.assertIsNone(decision)

    def test_late_day_continuation_plugin_relaxes_breadth_for_strong_opening_drive(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="late-day-continuation",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="late-day-continuation",
                    strategy_id="late_day_continuation_long_v1@research",
                    strategy_type="late_day_continuation_long_v1",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="late_day_continuation_long_v1",
                    universe_symbols=["AAPL"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("14000"),
                    params={
                        "min_cross_section_positive_session_open_ratio": "0.25",
                        "min_cross_section_positive_opening_window_return_ratio": "0.40",
                        "min_cross_section_above_vwap_w5m_ratio": "0.45",
                        "min_cross_section_continuation_breadth": "0.40",
                        "min_cross_section_opening_window_return_rank": "0.65",
                        "min_cross_section_continuation_rank": "0.70",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="late_day_continuation_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 18, 46, 3, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=176,
            payload={
                "price": 253.96,
                "ema12": 253.84,
                "ema26": 253.63,
                "macd": 0.027,
                "macd_signal": 0.013,
                "rsi14": 62,
                "vol_realized_w60s": 0.00018,
                "spread": 0.03,
                "vwap_w5m": 253.89,
                "imbalance_bid_sz": 5300,
                "imbalance_ask_sz": 5000,
                "price_vs_session_open_bps": 61,
                "opening_window_return_bps": 34,
                "price_position_in_session_range": 0.90,
                "session_high_price": 254.04,
                "opening_range_high": 253.88,
                "price_vs_opening_range_high_bps": 3.2,
                "price_vs_opening_window_close_bps": 10.8,
                "recent_spread_bps_avg": 0.62,
                "recent_imbalance_pressure_avg": 0.03,
                "recent_microprice_bias_bps_avg": 0.88,
                "recent_above_opening_range_high_ratio": 0.22,
                "recent_above_opening_window_close_ratio": 0.94,
                "recent_above_vwap_w5m_ratio": 0.87,
                "session_range_bps": 49,
                "cross_section_positive_session_open_ratio": 0.16,
                "cross_section_positive_opening_window_return_ratio": 0.28,
                "cross_section_above_vwap_w5m_ratio": 0.37,
                "cross_section_continuation_breadth": 0.30,
                "cross_section_opening_window_return_rank": 0.58,
                "cross_section_continuation_rank": 0.61,
            },
        )

        runtime = StrategyRuntime()
        decision = runtime.evaluate(
            strategy,
            normalize_feature_vector_v3(signal),
            timeframe="1Sec",
        )

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "buy")
        self.assertEqual(decision.plugin_id, "late_day_continuation_long")

    def test_late_day_continuation_plugin_blocks_isolated_overextension_above_open_close(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="late-day-continuation",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="late-day-continuation",
                    strategy_id="late_day_continuation_long_v1@research",
                    strategy_type="late_day_continuation_long_v1",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="late_day_continuation_long_v1",
                    universe_symbols=["AAPL"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("14000"),
                    params={
                        "isolated_flow_max_late_day_price_vs_opening_range_high_bps": "30",
                        "isolated_flow_max_late_day_price_vs_opening_window_close_bps": "40",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="late_day_continuation_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 19, 4, 3, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=89,
            payload={
                "price": 253.94,
                "ema12": 253.82,
                "ema26": 253.61,
                "macd": 0.030,
                "macd_signal": 0.014,
                "rsi14": 63,
                "vol_realized_w60s": 0.00018,
                "spread": 0.03,
                "vwap_w5m": 253.88,
                "imbalance_bid_sz": 5600,
                "imbalance_ask_sz": 4700,
                "price_vs_session_open_bps": 58,
                "opening_window_return_bps": 22,
                "price_position_in_session_range": 0.93,
                "session_high_price": 254.15,
                "opening_range_high": 253.18,
                "price_vs_opening_range_high_bps": 29,
                "price_vs_opening_window_close_bps": 42,
                "recent_spread_bps_avg": 0.61,
                "recent_imbalance_pressure_avg": 0.04,
                "recent_microprice_bias_bps_avg": 0.92,
                "recent_quote_invalid_ratio": 0.05,
                "session_range_bps": 48,
                "cross_section_range_position_rank": 0.95,
                "cross_section_vwap_w5m_rank": 0.93,
                "cross_section_recent_imbalance_rank": 0.91,
                "cross_section_continuation_rank": 0.86,
            },
        )

        runtime = StrategyRuntime()
        decision = runtime.evaluate(
            strategy, normalize_feature_vector_v3(signal), timeframe="1Sec"
        )

        self.assertIsNone(decision)

    def test_late_day_continuation_plugin_blocks_isolated_leader_with_hard_invalid_quote_ratio(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="late-day-continuation",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="late-day-continuation",
                    strategy_id="late_day_continuation_long_v1@research",
                    strategy_type="late_day_continuation_long_v1",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="late_day_continuation_long_v1",
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
            universe_type="late_day_continuation_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 19, 7, 34, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=90,
            payload={
                "price": 254.10,
                "ema12": 253.96,
                "ema26": 253.70,
                "macd": 0.030,
                "macd_signal": 0.014,
                "rsi14": 64,
                "vol_realized_w60s": 0.00014,
                "spread": 0.03,
                "vwap_w5m": 253.98,
                "imbalance_bid_sz": 5600,
                "imbalance_ask_sz": 4700,
                "price_vs_session_open_bps": 58,
                "opening_window_return_bps": 22,
                "price_position_in_session_range": 0.93,
                "session_high_price": 254.12,
                "opening_range_high": 254.02,
                "price_vs_opening_range_high_bps": 3.9,
                "price_vs_opening_window_close_bps": 18,
                "recent_spread_bps_avg": 0.61,
                "recent_imbalance_pressure_avg": 0.04,
                "recent_microprice_bias_bps_avg": 0.92,
                "recent_quote_invalid_ratio": 0.13,
                "session_range_bps": 48,
                "cross_section_range_position_rank": 0.95,
                "cross_section_vwap_w5m_rank": 0.93,
                "cross_section_recent_imbalance_rank": 0.91,
                "cross_section_continuation_rank": 0.86,
            },
        )

        runtime = StrategyRuntime()
        decision = runtime.evaluate(
            strategy, normalize_feature_vector_v3(signal), timeframe="1Sec"
        )

        self.assertIsNone(decision)
