from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.strategy_runtime.support import *


class TestStrategyRuntimeLateDayB(TestCase):
    def test_late_day_continuation_plugin_blocks_gap_only_strength_without_same_day_opening_drive(
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
                        "min_same_day_opening_window_return_bps": "8",
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
            event_ts=datetime(2026, 3, 26, 18, 7, 12, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=212,
            payload={
                "price": 254.755,
                "ema12": 254.63,
                "ema26": 254.38,
                "macd": 0.031,
                "macd_signal": 0.014,
                "rsi14": 64,
                "vol_realized_w60s": 0.00018,
                "spread": 0.03,
                "vwap_w5m": 254.55,
                "imbalance_bid_sz": 5600,
                "imbalance_ask_sz": 4700,
                "price_vs_session_open_bps": 38.6,
                "price_vs_prev_session_close_bps": 52.0,
                "opening_window_return_bps": 0,
                "opening_window_return_from_prev_close_bps": 31.0,
                "price_position_in_session_range": 0.82,
                "session_high_price": 254.97,
                "opening_range_high": 253.78,
                "price_vs_opening_range_high_bps": 38.6,
                "price_vs_opening_window_close_bps": 38.6,
                "price_vs_vwap_w5m_bps": 7.9,
                "recent_spread_bps_avg": 18.4,
                "recent_imbalance_pressure_avg": 0.03,
                "recent_microprice_bias_bps_avg": 0.88,
                "recent_quote_invalid_ratio": 0.06,
                "recent_above_opening_range_high_ratio": 1.0,
                "recent_above_opening_window_close_ratio": 1.0,
                "recent_above_vwap_w5m_ratio": 0.93,
                "session_range_bps": 52,
                "cross_section_positive_session_open_ratio": 1.0,
                "cross_section_positive_prev_session_close_ratio": 1.0,
                "cross_section_positive_opening_window_return_ratio": 0.0,
                "cross_section_positive_opening_window_return_from_prev_close_ratio": 1.0,
                "cross_section_above_vwap_w5m_ratio": 0.75,
                "cross_section_continuation_breadth": 0.75,
                "cross_section_opening_window_return_rank": 0.15,
                "cross_section_opening_window_return_from_prev_close_rank": 0.92,
                "cross_section_continuation_rank": 0.91,
            },
        )

        runtime = StrategyRuntime()
        decision = runtime.evaluate(
            strategy,
            normalize_feature_vector_v3(signal),
            timeframe="1Sec",
        )

        self.assertIsNone(decision)

    def test_late_day_continuation_plugin_allows_late_isolated_leader_with_relaxed_drive_requirements(
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
                        "min_session_open_drive_bps": "35",
                        "late_session_min_session_open_drive_bps": "18",
                        "min_opening_window_return_bps": "20",
                        "late_session_min_opening_window_return_bps": "10",
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
            event_ts=datetime(2026, 3, 26, 19, 6, 3, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=91,
            payload={
                "price": 253.98,
                "ema12": 253.85,
                "ema26": 253.62,
                "macd": 0.029,
                "macd_signal": 0.014,
                "rsi14": 63,
                "vol_realized_w60s": 0.00018,
                "spread": 0.03,
                "vwap_w5m": 253.90,
                "imbalance_bid_sz": 5600,
                "imbalance_ask_sz": 4700,
                "price_vs_session_open_bps": 19,
                "opening_window_return_bps": 10,
                "price_position_in_session_range": 0.92,
                "session_high_price": 254.03,
                "opening_range_high": 254.00,
                "price_vs_opening_range_high_bps": -1,
                "price_vs_opening_window_close_bps": 12,
                "recent_spread_bps_avg": 0.61,
                "recent_imbalance_pressure_avg": 0.04,
                "recent_microprice_bias_bps_avg": 0.92,
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

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "buy")
        self.assertEqual(decision.plugin_id, "late_day_continuation_long")

    def test_late_day_continuation_plugin_allows_isolated_flow_without_clean_orh_rebreak(
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
                        "min_session_high_above_opening_range_high_bps": "4",
                        "min_price_vs_opening_range_high_bps": "-10",
                        "max_price_vs_opening_window_close_bps": "18",
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
            event_ts=datetime(2026, 3, 26, 19, 1, 3, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=88,
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
                "price_position_in_session_range": 0.91,
                "session_high_price": 254.00,
                "opening_range_high": 253.98,
                "price_vs_opening_range_high_bps": -1.574927159618867627372233170,
                "price_vs_opening_window_close_bps": 23,
                "recent_spread_bps_avg": 0.61,
                "recent_imbalance_pressure_avg": 0.04,
                "recent_microprice_bias_bps_avg": 0.92,
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

    def test_late_day_continuation_plugin_allows_isolated_leader_near_high_shape(
        self,
    ) -> None:
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
                "session_high_price": 253.98,
                "opening_range_high": 253.98,
                "price_vs_opening_range_high_bps": -12,
                "price_vs_opening_window_close_bps": 36,
                "recent_spread_bps_avg": 0.61,
                "recent_imbalance_pressure_avg": 0.04,
                "recent_microprice_bias_bps_avg": 0.92,
                "session_range_bps": 48,
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

    def test_late_day_continuation_plugin_relaxes_recent_microstructure_for_isolated_leader(
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
                        "hard_max_recent_quote_invalid_ratio": "0.22",
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
                "vwap_w5m": 253.99,
                "imbalance_bid_sz": 5600,
                "imbalance_ask_sz": 4700,
                "price_vs_session_open_bps": 52,
                "opening_window_return_bps": 22,
                "session_high_price": 254.16,
                "opening_range_high": 254.20,
                "price_vs_opening_range_high_bps": -4,
                "price_vs_opening_window_close_bps": 10,
                "session_range_bps": 44,
                "price_position_in_session_range": 0.93,
                "recent_spread_bps_avg": 7.7,
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
        self.assertEqual(decision.plugin_id, "late_day_continuation_long")

    def test_late_day_continuation_plugin_skips_quote_unstable_symbol(self) -> None:
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
            seq=7,
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
                "recent_quote_invalid_ratio": 0.42,
                "recent_quote_jump_bps_max": 91,
                "recent_microprice_bias_bps_avg": 1.7,
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

        self.assertIsNone(decision)

    def test_late_day_continuation_plugin_respects_breadth_floor(self) -> None:
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
                        "min_cross_section_positive_opening_window_return_ratio": "0.40",
                        "min_cross_section_above_vwap_w5m_ratio": "0.45",
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
            seq=8,
            payload={
                "price": 253.93,
                "ema12": 253.82,
                "ema26": 253.60,
                "macd": 0.028,
                "macd_signal": 0.014,
                "rsi14": 63,
                "vol_realized_w60s": 0.00019,
                "spread": 0.03,
                "vwap_w5m": 253.98,
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
                "cross_section_positive_session_open_ratio": 0.25,
                "cross_section_positive_opening_window_return_ratio": 0.33,
                "cross_section_above_vwap_w5m_ratio": 0.41,
                "cross_section_continuation_breadth": 0.37,
                "cross_section_opening_window_return_rank": 0.88,
                "cross_section_continuation_rank": 0.84,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNone(decision)

    def test_late_day_continuation_plugin_emits_sell_on_late_failure(self) -> None:
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
            seq=6,
            payload={
                "price": 253.54,
                "ema12": 253.72,
                "ema26": 253.61,
                "macd": 0.010,
                "macd_signal": 0.016,
                "rsi14": 53,
                "vol_realized_w60s": 0.00018,
                "spread": 0.03,
                "vwap_w5m": 253.66,
                "imbalance_bid_sz": 4500,
                "imbalance_ask_sz": 4700,
                "price_vs_session_open_bps": 12,
                "opening_window_return_bps": 24,
                "price_position_in_session_range": 0.38,
                "session_high_price": 253.90,
                "opening_range_high": 253.78,
                "price_vs_opening_range_high_bps": -9.5,
                "price_vs_opening_window_close_bps": -18,
                "recent_spread_bps_avg": 0.88,
                "recent_imbalance_pressure_avg": -0.05,
                "session_range_bps": 33,
                "cross_section_opening_window_return_rank": 0.82,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "sell")
        self.assertEqual(decision.plugin_id, "late_day_continuation_long")
        self.assertIn("late_day_failure", decision.intent.rationale)

    def test_breakout_continuation_plugin_uses_spread_bps_when_spread_is_absent(
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
            seq=7,
            payload={
                "price": 523.25,
                "ema12": 523.10,
                "ema26": 522.90,
                "macd": 0.031,
                "macd_signal": 0.012,
                "rsi14": 62,
                "vol_realized_w60s": 0.00017,
                "spread_bps": 24,
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

    def test_mean_reversion_rebound_plugin_emits_buy_after_controlled_selloff(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="mean-reversion-rebound",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="mean_reversion_rebound_long_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("12000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 24, 17, 14, 12, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 593.90,
                "ema12": 595.10,
                "macd": 0.010,
                "macd_signal": 0.004,
                "rsi14": 45,
                "vol_realized_w60s": 0.00022,
                "vwap_session": 596.40,
                "spread": 0.05,
                "imbalance_bid_sz": 4700,
                "imbalance_ask_sz": 4300,
                "price_vs_session_open_bps": -42,
                "price_position_in_session_range": 0.14,
                "price_vs_opening_range_low_bps": 3,
                "session_range_bps": 88,
                "recent_spread_bps_avg": 0.82,
                "recent_spread_bps_max": 1.44,
                "recent_imbalance_pressure_avg": 0.05,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "buy")
        self.assertEqual(decision.plugin_id, "mean_reversion_rebound_long")
        self.assertIn("oversold_rebound", decision.intent.rationale)

    def test_mean_reversion_rebound_plugin_can_use_session_open_reference_basis(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 24, 17, 14, 12, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=11,
            payload={
                "price": 593.90,
                "ema12": 595.10,
                "macd": 0.010,
                "macd_signal": 0.004,
                "rsi14": 45,
                "vol_realized_w60s": 0.00022,
                "vwap_session": 596.40,
                "spread": 0.05,
                "imbalance_bid_sz": 4700,
                "imbalance_ask_sz": 4300,
                "price_vs_session_open_bps": -42,
                "price_vs_prev_session_close_bps": -8,
                "opening_window_return_bps": -12,
                "opening_window_return_from_prev_close_bps": 4,
                "cross_section_opening_window_return_rank": 0.32,
                "cross_section_opening_window_return_from_prev_close_rank": 0.82,
                "price_position_in_session_range": 0.14,
                "price_vs_opening_range_low_bps": 3,
                "session_range_bps": 88,
                "recent_spread_bps_avg": 0.82,
                "recent_spread_bps_max": 1.44,
                "recent_imbalance_pressure_avg": 0.05,
            },
        )

        default_strategy = Strategy(
            id=uuid.uuid4(),
            name="mean-reversion-rebound-default",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="mean_reversion_rebound_long_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("12000"),
        )
        session_open_strategy = Strategy(
            id=uuid.uuid4(),
            name="mean-reversion-rebound-session-open",
            description=_compose_strategy_description(
                StrategyCatalogConfig(
                    strategies=[
                        StrategyConfig(
                            name="mean-reversion-rebound-session-open",
                            strategy_id="mean_reversion_rebound_long_v1@research",
                            strategy_type="mean_reversion_rebound_long_v1",
                            version="1.0.0",
                            params={
                                "drive_reference_basis": "session_open",
                                "opening_window_reference_basis": "session_open",
                                "opening_window_rank_reference_basis": "session_open",
                            },
                            base_timeframe="1Sec",
                            universe_type="mean_reversion_rebound_long_v1",
                            universe_symbols=["META"],
                        )
                    ]
                ).strategies[0]
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="mean_reversion_rebound_long_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("12000"),
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        default_decision = runtime.evaluate(
            default_strategy, feature_contract, timeframe="1Sec"
        )
        session_open_decision = runtime.evaluate(
            session_open_strategy, feature_contract, timeframe="1Sec"
        )

        self.assertIsNone(default_decision)
        self.assertIsNotNone(session_open_decision)
        assert session_open_decision is not None
        self.assertEqual(session_open_decision.intent.action, "buy")
