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


class TestStrategyRuntimeBreakoutA(TestCase):
    def test_breakout_continuation_plugin_prefers_live_structure_rank_late_in_session(
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
                        "min_opening_window_return_bps": "20",
                        "min_cross_section_opening_window_return_rank": "0.65",
                        "min_cross_section_continuation_rank": "0.75",
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
            event_ts=datetime(2026, 3, 23, 17, 30, 3, tzinfo=timezone.utc),
            symbol="NVDA",
            timeframe="1Sec",
            seq=31,
            payload={
                "price": 969.40,
                "ema12": 968.92,
                "ema26": 968.35,
                "macd": 0.044,
                "macd_signal": 0.018,
                "rsi14": 64,
                "vol_realized_w60s": 0.00020,
                "spread": 0.08,
                "vwap_w5m": 968.95,
                "imbalance_bid_sz": 6800,
                "imbalance_ask_sz": 5200,
                "price_vs_session_open_bps": 63,
                "opening_window_return_bps": 12,
                "session_high_price": 969.90,
                "opening_range_high": 968.70,
                "price_vs_opening_range_high_bps": 7,
                "price_vs_opening_window_close_bps": 14,
                "opening_range_width_bps": 24,
                "session_range_bps": 66,
                "price_position_in_session_range": 0.93,
                "recent_spread_bps_avg": 0.82,
                "recent_spread_bps_max": 1.41,
                "recent_imbalance_pressure_avg": 0.09,
                "recent_microprice_bias_bps_avg": 1.2,
                "cross_section_session_open_rank": 0.45,
                "cross_section_opening_window_return_rank": 0.35,
                "cross_section_range_position_rank": 0.98,
                "cross_section_vwap_w5m_rank": 0.94,
                "cross_section_recent_imbalance_rank": 0.92,
                "cross_section_continuation_rank": 0.40,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "buy")
        self.assertEqual(decision.plugin_id, "breakout_continuation_long")
        self.assertIn("opening_range_breakout", decision.intent.rationale)

    def test_breakout_continuation_plugin_preserves_stronger_fallback_rank(
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
                        "min_cross_section_continuation_rank": "0.80",
                        "min_cross_section_opening_window_return_rank": "0.55",
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
            event_ts=datetime(2026, 3, 24, 17, 48, 3, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=77,
            payload={
                "price": 523.40,
                "ema12": 523.18,
                "ema26": 522.84,
                "macd": 0.028,
                "macd_signal": 0.011,
                "rsi14": 62,
                "vol_realized_w60s": 0.00016,
                "spread": 0.04,
                "vwap_w5m": 523.22,
                "imbalance_bid_sz": 4900,
                "imbalance_ask_sz": 4200,
                "price_vs_session_open_bps": 44,
                "opening_window_return_bps": 22,
                "session_high_price": 523.62,
                "opening_range_high": 523.05,
                "price_vs_opening_range_high_bps": 7,
                "price_vs_opening_window_close_bps": 11,
                "opening_range_width_bps": 24,
                "session_range_bps": 62,
                "price_position_in_session_range": 0.88,
                "recent_spread_bps_avg": 0.80,
                "recent_spread_bps_max": 1.36,
                "recent_imbalance_pressure_avg": 0.06,
                "recent_microprice_bias_bps_avg": 0.92,
                "cross_section_positive_session_open_ratio": 0.34,
                "cross_section_positive_opening_window_return_ratio": 0.46,
                "cross_section_above_vwap_w5m_ratio": 0.50,
                "cross_section_continuation_breadth": 0.52,
                "cross_section_session_open_rank": 0.46,
                "cross_section_opening_window_return_rank": 0.57,
                "cross_section_range_position_rank": 0.67,
                "cross_section_vwap_w5m_rank": 0.69,
                "cross_section_recent_imbalance_rank": 0.66,
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

    def test_breakout_continuation_plugin_skips_weak_opening_window_drive(self) -> None:
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
                        "late_session_min_opening_window_return_bps": "15",
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
            seq=8,
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
                "opening_window_return_bps": 6,
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
                "cross_section_opening_window_return_rank": 0.35,
            },
        )

        runtime = StrategyRuntime()
        decision = runtime.evaluate(
            strategy, normalize_feature_vector_v3(signal), timeframe="1Sec"
        )

        self.assertIsNone(decision)

    def test_breakout_continuation_plugin_allows_late_isolated_leader_with_relaxed_drive_requirements(
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
                        "min_session_open_drive_bps": "35",
                        "late_session_min_session_open_drive_bps": "18",
                        "min_opening_window_return_bps": "20",
                        "late_session_min_opening_window_return_bps": "10",
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
            event_ts=datetime(2026, 3, 24, 18, 6, 3, tzinfo=timezone.utc),
            symbol="NVDA",
            timeframe="1Sec",
            seq=58,
            payload={
                "price": 969.32,
                "ema12": 968.98,
                "ema26": 968.20,
                "macd": 0.046,
                "macd_signal": 0.019,
                "rsi14": 64,
                "vol_realized_w60s": 0.00020,
                "spread": 0.08,
                "vwap_w5m": 968.99,
                "imbalance_bid_sz": 7100,
                "imbalance_ask_sz": 5000,
                "price_vs_session_open_bps": 21,
                "opening_window_return_bps": 10,
                "session_high_price": 969.70,
                "opening_range_high": 968.84,
                "price_vs_opening_range_high_bps": 5,
                "price_vs_opening_window_close_bps": 14,
                "opening_range_width_bps": 24,
                "session_range_bps": 64,
                "price_position_in_session_range": 0.91,
                "recent_spread_bps_avg": 0.82,
                "recent_spread_bps_max": 1.41,
                "recent_imbalance_pressure_avg": 0.08,
                "recent_microprice_bias_bps_avg": 1.1,
                "cross_section_range_position_rank": 0.97,
                "cross_section_vwap_w5m_rank": 0.94,
                "cross_section_recent_imbalance_rank": 0.92,
                "cross_section_continuation_rank": 0.83,
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

    def test_breakout_continuation_plugin_allows_isolated_flow_breakout_when_breadth_is_middling(
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
                        "min_cross_section_positive_session_open_ratio": "0.50",
                        "min_cross_section_positive_opening_window_return_ratio": "0.55",
                        "min_cross_section_above_vwap_w5m_ratio": "0.60",
                        "min_cross_section_continuation_breadth": "0.65",
                        "isolated_flow_session_open_ratio_relaxation": "0.12",
                        "isolated_flow_opening_window_ratio_relaxation": "0.15",
                        "isolated_flow_above_vwap_ratio_relaxation": "0.15",
                        "isolated_flow_continuation_breadth_relaxation": "0.15",
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
            event_ts=datetime(2026, 3, 23, 17, 30, 3, tzinfo=timezone.utc),
            symbol="NVDA",
            timeframe="1Sec",
            seq=41,
            payload={
                "price": 969.40,
                "ema12": 968.92,
                "ema26": 968.35,
                "macd": 0.044,
                "macd_signal": 0.018,
                "rsi14": 64,
                "vol_realized_w60s": 0.00020,
                "spread": 0.08,
                "vwap_w5m": 968.95,
                "imbalance_bid_sz": 6800,
                "imbalance_ask_sz": 5200,
                "price_vs_session_open_bps": 63,
                "opening_window_return_bps": 24,
                "session_high_price": 969.90,
                "opening_range_high": 968.70,
                "price_vs_opening_range_high_bps": 7,
                "price_vs_opening_window_close_bps": 14,
                "opening_range_width_bps": 24,
                "session_range_bps": 66,
                "price_position_in_session_range": 0.93,
                "recent_spread_bps_avg": 0.82,
                "recent_spread_bps_max": 1.41,
                "recent_imbalance_pressure_avg": 0.09,
                "recent_microprice_bias_bps_avg": 1.2,
                "cross_section_positive_session_open_ratio": 0.42,
                "cross_section_positive_opening_window_return_ratio": 0.42,
                "cross_section_above_vwap_w5m_ratio": 0.48,
                "cross_section_continuation_breadth": 0.50,
                "cross_section_session_open_rank": 0.45,
                "cross_section_opening_window_return_rank": 0.55,
                "cross_section_range_position_rank": 0.98,
                "cross_section_vwap_w5m_rank": 0.94,
                "cross_section_recent_imbalance_rank": 0.92,
                "cross_section_continuation_rank": 0.77,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "buy")
        self.assertEqual(decision.plugin_id, "breakout_continuation_long")
        self.assertIn("opening_range_breakout", decision.intent.rationale)

    def test_breakout_continuation_plugin_allows_isolated_same_day_leader_when_breadth_is_weak(
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
                        "min_cross_section_positive_session_open_ratio": "0.50",
                        "min_cross_section_positive_opening_window_return_ratio": "0.55",
                        "min_cross_section_above_vwap_w5m_ratio": "0.60",
                        "min_cross_section_continuation_breadth": "0.65",
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
            event_ts=datetime(2026, 3, 24, 14, 22, 3, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=142,
            payload={
                "price": 255.14,
                "ema12": 255.02,
                "ema26": 254.84,
                "macd": 0.032,
                "macd_signal": 0.014,
                "rsi14": 63,
                "vol_realized_w60s": 0.00018,
                "spread": 0.07,
                "vwap_w5m": 255.02,
                "imbalance_bid_sz": 6200,
                "imbalance_ask_sz": 5600,
                "price_vs_session_open_bps": 48,
                "opening_window_return_bps": 29,
                "session_high_price": 255.20,
                "opening_range_high": 254.95,
                "price_vs_opening_range_high_bps": 7.45,
                "price_vs_opening_window_close_bps": 11.5,
                "opening_range_width_bps": 23,
                "session_range_bps": 57,
                "price_position_in_session_range": 0.86,
                "recent_spread_bps_avg": 0.78,
                "recent_spread_bps_max": 1.22,
                "recent_imbalance_pressure_avg": 0.03,
                "recent_microprice_bias_bps_avg": 0.46,
                "recent_above_opening_range_high_ratio": 0.42,
                "recent_above_opening_window_close_ratio": 0.72,
                "recent_above_vwap_w5m_ratio": 0.68,
                "cross_section_positive_session_open_ratio": 0.17,
                "cross_section_positive_opening_window_return_ratio": 0.25,
                "cross_section_above_vwap_w5m_ratio": 0.33,
                "cross_section_continuation_breadth": 0.25,
                "cross_section_session_open_rank": 0.96,
                "cross_section_opening_window_return_rank": 0.92,
                "cross_section_range_position_rank": 0.60,
                "cross_section_vwap_w5m_rank": 0.58,
                "cross_section_recent_imbalance_rank": 0.52,
                "cross_section_continuation_rank": 0.91,
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
        self.assertEqual(decision.plugin_id, "breakout_continuation_long")

    def test_breakout_continuation_plugin_allows_guarded_leader_reclaim_after_open(
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
                    universe_symbols=["AMAT"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("14000"),
                    params={
                        "entry_start_minute_utc": "845",
                        "bullish_hist_min": "0.003",
                        "min_bull_rsi": "54",
                        "max_bull_rsi": "74",
                        "vol_ceil": "0.00045",
                        "max_spread_bps": "20",
                        "max_recent_spread_bps": "18",
                        "max_recent_spread_bps_max": "60",
                        "min_imbalance_pressure": "-0.18",
                        "min_recent_imbalance_pressure": "-0.12",
                        "min_cross_section_continuation_rank": "0.72",
                        "min_cross_section_opening_window_return_rank": "0.60",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["AMAT"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 24, 15, 21, 27, tzinfo=timezone.utc),
            symbol="AMAT",
            timeframe="1Sec",
            seq=911,
            payload={
                "price": 374.58,
                "ema12": 374.12,
                "ema26": 373.96,
                "macd": 0.18714994068979438,
                "macd_signal": 0.2293658653363894,
                "rsi14": 53.76915985001121,
                "vol_realized_w60s": 0.0005671340738954782,
                "spread": 0.29,
                "vwap_w5m": 373.9075,
                "imbalance_bid_sz": 200,
                "imbalance_ask_sz": 400,
                "price_vs_session_open_bps": 93,
                "opening_window_return_bps": 81,
                "session_high_price": 374.65,
                "opening_range_high": 374.20,
                "price_vs_opening_range_high_bps": 10.15,
                "price_vs_opening_window_close_bps": 18.3,
                "opening_range_width_bps": 17,
                "session_range_bps": 96,
                "price_position_in_session_range": 0.94,
                "recent_spread_bps_avg": 7.70,
                "recent_spread_bps_max": 34.78,
                "recent_imbalance_pressure_avg": 0.2714285714285714,
                "recent_microprice_bias_bps_avg": 2.3427932913269284,
                "recent_above_opening_range_high_ratio": 0.22,
                "recent_above_opening_window_close_ratio": 1.0,
                "recent_above_vwap_w5m_ratio": 0.9666666666666667,
                "cross_section_positive_session_open_ratio": 0.83,
                "cross_section_positive_opening_window_return_ratio": 0.83,
                "cross_section_above_vwap_w5m_ratio": 1.0,
                "cross_section_continuation_breadth": 0.83,
                "cross_section_session_open_rank": 1.0,
                "cross_section_opening_window_return_rank": 1.0,
                "cross_section_range_position_rank": 0.92,
                "cross_section_vwap_w5m_rank": 0.95,
                "cross_section_recent_imbalance_rank": 0.94,
                "cross_section_continuation_rank": 1.0,
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
        self.assertEqual(decision.plugin_id, "breakout_continuation_long")
        self.assertIn("leader_reclaim_confirmed", decision.intent.rationale)

    def test_breakout_continuation_plugin_rejects_leader_reclaim_without_recent_flow_confirmation(
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
                    universe_symbols=["AMAT"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("14000"),
                    params={
                        "entry_start_minute_utc": "845",
                        "bullish_hist_min": "0.003",
                        "min_bull_rsi": "54",
                        "max_bull_rsi": "74",
                        "vol_ceil": "0.00045",
                        "max_spread_bps": "20",
                        "max_recent_spread_bps": "18",
                        "max_recent_spread_bps_max": "60",
                        "min_imbalance_pressure": "-0.18",
                        "min_recent_imbalance_pressure": "-0.12",
                        "min_cross_section_continuation_rank": "0.72",
                        "min_cross_section_opening_window_return_rank": "0.60",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["AMAT"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 24, 15, 21, 27, tzinfo=timezone.utc),
            symbol="AMAT",
            timeframe="1Sec",
            seq=912,
            payload={
                "price": 374.58,
                "ema12": 374.12,
                "ema26": 373.96,
                "macd": 0.18714994068979438,
                "macd_signal": 0.2293658653363894,
                "rsi14": 53.76915985001121,
                "vol_realized_w60s": 0.0005671340738954782,
                "spread": 0.29,
                "vwap_w5m": 373.9075,
                "imbalance_bid_sz": 200,
                "imbalance_ask_sz": 400,
                "price_vs_session_open_bps": 93,
                "opening_window_return_bps": 81,
                "session_high_price": 374.65,
                "opening_range_high": 374.20,
                "price_vs_opening_range_high_bps": 10.15,
                "price_vs_opening_window_close_bps": 18.3,
                "opening_range_width_bps": 17,
                "session_range_bps": 96,
                "price_position_in_session_range": 0.94,
                "recent_spread_bps_avg": 7.70,
                "recent_spread_bps_max": 34.78,
                "recent_imbalance_pressure_avg": 0.02,
                "recent_microprice_bias_bps_avg": 0.04,
                "recent_above_opening_range_high_ratio": 0.22,
                "recent_above_opening_window_close_ratio": 0.62,
                "recent_above_vwap_w5m_ratio": 0.70,
                "cross_section_positive_session_open_ratio": 0.83,
                "cross_section_positive_opening_window_return_ratio": 0.83,
                "cross_section_above_vwap_w5m_ratio": 1.0,
                "cross_section_continuation_breadth": 0.83,
                "cross_section_session_open_rank": 1.0,
                "cross_section_opening_window_return_rank": 1.0,
                "cross_section_range_position_rank": 0.92,
                "cross_section_vwap_w5m_rank": 0.95,
                "cross_section_recent_imbalance_rank": 0.94,
                "cross_section_continuation_rank": 1.0,
            },
        )

        runtime = StrategyRuntime()
        decision = runtime.evaluate(
            strategy,
            normalize_feature_vector_v3(signal),
            timeframe="1Sec",
        )

        self.assertIsNone(decision)
