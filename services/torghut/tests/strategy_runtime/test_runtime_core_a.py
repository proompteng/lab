from __future__ import annotations

from tests.strategy_runtime.support import (
    Decimal,
    FeatureNormalizationError,
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


class TestStrategyRuntimeCoreA(TestCase):
    def test_runtime_is_deterministic_for_same_input(self) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="deterministic",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="legacy_macd_rsi",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("2500"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=42,
            payload={"macd": {"macd": 1.2, "signal": 0.3}, "rsi14": 25, "price": 101.5},
        )
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()

        decision_a = runtime.evaluate(strategy, feature_contract, timeframe="1Min")
        decision_b = runtime.evaluate(strategy, feature_contract, timeframe="1Min")

        self.assertIsNotNone(decision_a)
        self.assertIsNotNone(decision_b)
        assert decision_a is not None
        assert decision_b is not None
        self.assertEqual(decision_a.intent.action, "buy")
        self.assertEqual(decision_a.parameter_hash, decision_b.parameter_hash)
        self.assertEqual(decision_a.feature_hash, decision_b.feature_hash)

    def test_runtime_missing_required_features_fails_closed(self) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="invalid",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="legacy_macd_rsi",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("2500"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            payload={"price": 101.5},
        )
        runtime = StrategyRuntime()
        with self.assertRaises(FeatureNormalizationError):
            feature_vector = normalize_feature_vector_v3(signal)
            runtime.evaluate(strategy, feature_vector, timeframe="1Min")

    def test_intraday_tsmom_plugin_emits_buy_on_trend(self) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["NVDA"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("2500"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            symbol="NVDA",
            timeframe="1Min",
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
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()

        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Min")
        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "buy")
        self.assertIn("tsmom_trend_up", decision.intent.rationale)
        self.assertIn("momentum_confirmed", decision.intent.rationale)
        self.assertEqual(decision.plugin_id, "intraday_tsmom")

    def test_intraday_tsmom_plugin_emits_sell_on_downtrend(self) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["NVDA"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("2500"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            symbol="NVDA",
            timeframe="1Min",
            seq=9,
            payload={
                "price": 140.05,
                "ema12": 139.90,
                "ema26": 140.35,
                "macd": -0.40,
                "macd_signal": -0.25,
                "rsi14": 72,
                "vol_realized_w60s": 0.011,
            },
        )
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()

        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Min")
        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "sell")
        self.assertIn("tsmom_trend_down", decision.intent.rationale)
        self.assertIn("momentum_reversal_exit", decision.intent.rationale)

    def test_intraday_tsmom_plugin_emits_buy_for_one_second_profile(self) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-1sec",
            description="version=1.1.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["MSFT"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("2500"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 13, 13, 33, 46, tzinfo=timezone.utc),
            symbol="MSFT",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 395.5129,
                "ema12": 395.51296737223805,
                "ema26": 395.50678734700955,
                "macd": 0.0061800252285331625,
                "macd_signal": -0.0207157904036421,
                "rsi14": 60.84685352855714,
                "vol_realized_w60s": 0.00009809491242978304,
            },
        )
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()

        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "buy")
        self.assertIn("tsmom_trend_up", decision.intent.rationale)

    def test_runtime_decision_metadata_includes_trace_when_enabled(self) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-trace",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["NVDA"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("2500"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            symbol="NVDA",
            timeframe="1Min",
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
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime(trace_enabled=True)

        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Min")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertIsNotNone(decision.trace)
        metadata = decision.metadata()
        self.assertIn("strategy_trace", metadata)
        strategy_trace = metadata["strategy_trace"]
        assert isinstance(strategy_trace, dict)
        self.assertEqual(strategy_trace["strategy_id"], str(strategy.id))
        self.assertTrue(strategy_trace["passed"])

    def test_intraday_tsmom_plugin_skips_buy_outside_entry_window(self) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-1sec-window",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-1sec-window",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("0.08"),
                    max_notional_per_trade=Decimal("1000"),
                    params={"entry_end_minute_utc": "1180"},
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
            event_ts=datetime(2026, 3, 24, 19, 45, 55, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 593.625,
                "ema12": 593.70,
                "ema26": 593.40,
                "macd": 0.020,
                "macd_signal": 0.010,
                "rsi14": 57.0,
                "vol_realized_w60s": 0.00018,
            },
        )
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()

        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNone(decision)

    def test_intraday_tsmom_plugin_skips_buy_when_spread_exceeds_cap(self) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-1sec-spread-cap",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-1sec-spread-cap",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("0.08"),
                    max_notional_per_trade=Decimal("1000"),
                    params={"max_spread_bps": "60"},
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
            event_ts=datetime(2026, 3, 23, 19, 17, 55, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 604.815,
                "spread": 5.77,
                "ema12": 606.3602961607454,
                "ema26": 606.3534338611167,
                "macd": 0.006862299628771475,
                "macd_signal": -0.04526378862269545,
                "rsi14": 57.80709380988871,
                "vol_realized_w60s": 0.00017176690067199733,
            },
        )
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()

        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNone(decision)

    def test_intraday_tsmom_plugin_prefers_prev_session_close_drive(self) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-1sec-prev-close-drive",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-1sec-prev-close-drive",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("0.08"),
                    max_notional_per_trade=Decimal("1000"),
                    params={
                        "min_session_open_drive_bps": "30",
                    },
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
            event_ts=datetime(2026, 3, 24, 18, 17, 55, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=9,
            payload={
                "price": 593.62,
                "ema12": 593.70,
                "ema26": 593.40,
                "macd": 0.020,
                "macd_signal": 0.010,
                "rsi14": 57.0,
                "vol_realized_w60s": 0.00018,
                "price_vs_session_open_bps": 8,
                "price_vs_prev_session_close_bps": 44,
            },
        )
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()

        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "buy")

    def test_intraday_tsmom_plugin_emits_buy_with_session_context_filters(self) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-1sec-session-aware",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-1sec-session-aware",
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
                        "entry_end_minute_utc": "1020",
                        "min_session_open_drive_bps": "45",
                        "min_session_range_bps": "40",
                        "min_session_range_position": "0.65",
                        "min_price_vs_vwap_w5m_bps": "0",
                        "max_price_vs_vwap_w5m_bps": "16",
                        "min_price_vs_opening_range_high_bps": "-6",
                        "max_price_vs_opening_range_high_bps": "18",
                        "max_recent_spread_bps": "12",
                        "max_recent_spread_bps_max": "40",
                        "min_recent_imbalance_pressure": "0.02",
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
            event_ts=datetime(2026, 3, 24, 16, 16, 44, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 254.02,
                "spread": 0.20,
                "ema12": 254.08,
                "ema26": 253.90,
                "vwap_w5m": 253.90,
                "macd": 0.065,
                "macd_signal": 0.020,
                "rsi14": 57.1,
                "vol_realized_w60s": 0.00017,
                "price_vs_session_open_bps": 52,
                "session_range_bps": 64,
                "price_position_in_session_range": 0.74,
                "price_vs_opening_range_high_bps": 2,
                "recent_spread_bps_avg": 5,
                "recent_spread_bps_max": 9,
                "recent_imbalance_pressure_avg": 0.04,
            },
        )
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()

        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "buy")
        self.assertIn("tsmom_trend_up", decision.intent.rationale)

    def test_intraday_tsmom_plugin_emits_buy_with_prev_close_opening_and_cross_section_filters(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-1sec-research-filters",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-1sec-research-filters",
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
                        "entry_end_minute_utc": "1020",
                        "min_session_open_drive_bps": "30",
                        "min_opening_window_return_bps": "20",
                        "min_cross_section_opening_window_return_rank": "0.70",
                        "min_cross_section_continuation_rank": "0.75",
                        "min_cross_section_continuation_breadth": "0.55",
                        "min_recent_microprice_bias_bps": "0.40",
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
            event_ts=datetime(2026, 3, 24, 16, 16, 44, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 254.02,
                "spread": 0.20,
                "ema12": 254.08,
                "ema26": 253.90,
                "vwap_w5m": 253.90,
                "macd": 0.065,
                "macd_signal": 0.020,
                "rsi14": 57.1,
                "vol_realized_w60s": 0.00017,
                "price_vs_session_open_bps": 12,
                "price_vs_prev_session_close_bps": 52,
                "opening_window_return_bps": 6,
                "opening_window_return_from_prev_close_bps": 28,
                "session_range_bps": 64,
                "price_position_in_session_range": 0.74,
                "price_vs_opening_range_high_bps": 2,
                "recent_spread_bps_avg": 5,
                "recent_spread_bps_max": 9,
                "recent_imbalance_pressure_avg": 0.04,
                "recent_quote_invalid_ratio": 0.02,
                "recent_quote_jump_bps_max": 8,
                "recent_microprice_bias_bps_avg": 0.65,
                "cross_section_opening_window_return_rank": 0.32,
                "cross_section_opening_window_return_from_prev_close_rank": 0.82,
                "cross_section_continuation_rank": 0.84,
                "cross_section_continuation_breadth": 0.61,
            },
        )
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()

        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "buy")

    def test_intraday_tsmom_plugin_skips_buy_when_quote_state_is_unstable(self) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-1sec-quote-quality",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-1sec-quote-quality",
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
                        "entry_end_minute_utc": "1020",
                        "min_session_open_drive_bps": "30",
                        "max_recent_quote_invalid_ratio": "0.10",
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
            event_ts=datetime(2026, 3, 24, 16, 16, 44, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 254.02,
                "spread": 0.20,
                "ema12": 254.08,
                "ema26": 253.90,
                "vwap_w5m": 253.90,
                "macd": 0.065,
                "macd_signal": 0.020,
                "rsi14": 57.1,
                "vol_realized_w60s": 0.00017,
                "price_vs_prev_session_close_bps": 52,
                "session_range_bps": 64,
                "price_position_in_session_range": 0.74,
                "price_vs_opening_range_high_bps": 2,
                "recent_spread_bps_avg": 5,
                "recent_spread_bps_max": 9,
                "recent_imbalance_pressure_avg": 0.04,
                "recent_quote_invalid_ratio": 0.25,
            },
        )
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()

        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNone(decision)

    def test_intraday_tsmom_plugin_skips_buy_when_recent_spread_is_unstable(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-1sec-recent-spread",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-1sec-recent-spread",
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
                        "entry_end_minute_utc": "1020",
                        "min_session_open_drive_bps": "45",
                        "min_session_range_bps": "40",
                        "min_session_range_position": "0.65",
                        "min_price_vs_vwap_w5m_bps": "0",
                        "max_price_vs_vwap_w5m_bps": "16",
                        "max_recent_spread_bps_max": "40",
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
            event_ts=datetime(2026, 3, 24, 16, 16, 44, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 254.02,
                "spread": 0.20,
                "ema12": 254.08,
                "ema26": 253.90,
                "vwap_w5m": 253.90,
                "macd": 0.065,
                "macd_signal": 0.020,
                "rsi14": 57.1,
                "vol_realized_w60s": 0.00017,
                "price_vs_session_open_bps": 52,
                "session_range_bps": 64,
                "price_position_in_session_range": 0.74,
                "recent_spread_bps_max": 80,
            },
        )
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()

        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNone(decision)

    def test_intraday_tsmom_plugin_skips_buy_when_price_is_above_ema12_band(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-1sec-band",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-1sec-band",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("0.08"),
                    max_notional_per_trade=Decimal("1000"),
                    params={"max_price_above_ema12_bps": "0"},
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
            event_ts=datetime(2026, 3, 27, 18, 27, 27, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 528.29,
                "ema12": 523.7876786224246,
                "ema26": 523.7686581843907,
                "macd": 0.019020438033943658,
                "macd_signal": -0.03527149321001294,
                "rsi14": 58.25782645382979,
                "vol_realized_w60s": 0.00019104321463884983,
            },
        )
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()

        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNone(decision)

    def test_intraday_tsmom_plugin_skips_buy_when_pullback_is_too_shallow(self) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-1sec-pullback",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-1sec-pullback",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("0.08"),
                    max_notional_per_trade=Decimal("1000"),
                    params={"min_price_below_ema12_bps": "2"},
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
            event_ts=datetime(2026, 3, 27, 18, 27, 36, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 523.78,
                "ema12": 523.8487984735763,
                "ema26": 523.8048007992227,
                "macd": 0.04399767435360296,
                "macd_signal": 0.001197208657777601,
                "rsi14": 56.28545201421526,
                "vol_realized_w60s": 0.00018957788471576266,
            },
        )
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()

        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNone(decision)

    def test_intraday_tsmom_plugin_skips_buy_when_bullish_hist_is_too_hot(self) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-1sec-hot-hist",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-1sec-hot-hist",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("0.08"),
                    max_notional_per_trade=Decimal("1000"),
                    params={"bullish_hist_cap": "0.055"},
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
            event_ts=datetime(2026, 3, 24, 16, 56, 49, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 594.62,
                "ema12": 595.2109424468129,
                "ema26": 595.1980527414847,
                "macd": 0.012889705328175226,
                "macd_signal": -0.05243924370763675,
                "rsi14": 57.950805218453446,
                "vol_realized_w60s": 0.000188712908208969,
            },
        )
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()

        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNone(decision)

    def test_intraday_tsmom_plugin_decays_early_drive_floors_late_session(self) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-1sec-late-session-decay",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-1sec-late-session-decay",
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
                        "min_session_open_drive_bps": "40",
                        "min_opening_window_return_bps": "20",
                        "late_session_floor_multiplier": "0.5",
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
            event_ts=datetime(2026, 3, 24, 18, 30, 44, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 254.02,
                "ema12": 254.08,
                "ema26": 253.90,
                "macd": 0.062,
                "macd_signal": 0.020,
                "rsi14": 57.0,
                "vol_realized_w60s": 0.00017,
                "price_vs_prev_session_close_bps": 24,
                "opening_window_return_from_prev_close_bps": 11,
            },
        )
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()

        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "buy")
