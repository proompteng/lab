from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.strategy_runtime.support import *


class TestStrategyRuntimeReversionAndRegistry(TestCase):
    def test_mean_reversion_rebound_plugin_skips_when_liquidity_has_not_normalized(
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
            seq=2,
            payload={
                "price": 593.90,
                "ema12": 595.10,
                "macd": 0.010,
                "macd_signal": 0.004,
                "rsi14": 45,
                "vol_realized_w60s": 0.00022,
                "vwap_session": 596.40,
                "spread": 0.60,
                "imbalance_bid_sz": 4700,
                "imbalance_ask_sz": 4300,
                "price_vs_session_open_bps": -42,
                "price_position_in_session_range": 0.14,
                "price_vs_opening_range_low_bps": 3,
                "session_range_bps": 88,
                "recent_spread_bps_avg": 22,
                "recent_spread_bps_max": 31,
                "recent_imbalance_pressure_avg": 0.05,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNone(decision)

    def test_washout_rebound_plugin_emits_buy_after_active_selloff_recovery(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="washout-rebound",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="washout_rebound_long_v1",
            universe_symbols=["AMD"],
            max_position_pct_equity=Decimal("1.5"),
            max_notional_per_trade=Decimal("18000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 25, 15, 12, 24, tzinfo=timezone.utc),
            symbol="AMD",
            timeframe="1Sec",
            seq=3,
            payload={
                "price": 101.40,
                "ema12": 101.85,
                "macd": -0.006,
                "macd_signal": -0.010,
                "rsi14": 42,
                "vol_realized_w60s": 0.00022,
                "vwap_session": 102.10,
                "spread": 0.04,
                "imbalance_bid_sz": 5800,
                "imbalance_ask_sz": 4300,
                "price_vs_session_open_bps": -55,
                "opening_window_return_bps": -18,
                "price_position_in_session_range": 0.18,
                "price_vs_session_low_bps": 9,
                "price_vs_opening_range_low_bps": 6,
                "session_range_bps": 82,
                "recent_spread_bps_avg": 3.2,
                "recent_spread_bps_max": 7.8,
                "recent_imbalance_pressure_avg": 0.06,
                "recent_quote_invalid_ratio": 0.03,
                "recent_quote_jump_bps_max": 12,
                "recent_microprice_bias_bps_avg": 0.45,
                "recent_above_vwap_w5m_ratio": 0.22,
                "cross_section_opening_window_return_rank": 0.22,
                "cross_section_continuation_rank": 0.38,
                "cross_section_reversal_rank": 0.89,
                "cross_section_recent_imbalance_rank": 0.76,
                "cross_section_positive_recent_imbalance_ratio": 0.58,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "buy")
        self.assertEqual(decision.plugin_id, "washout_rebound_long")
        self.assertIn("activity_gated", decision.intent.rationale)

    def test_washout_rebound_plugin_skips_without_bid_recovery_confirmation(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="washout-rebound",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="washout_rebound_long_v1",
            universe_symbols=["AMD"],
            max_position_pct_equity=Decimal("1.5"),
            max_notional_per_trade=Decimal("18000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 25, 15, 12, 24, tzinfo=timezone.utc),
            symbol="AMD",
            timeframe="1Sec",
            seq=4,
            payload={
                "price": 101.40,
                "ema12": 101.85,
                "macd": -0.006,
                "macd_signal": -0.010,
                "rsi14": 42,
                "vol_realized_w60s": 0.00022,
                "vwap_session": 102.10,
                "spread": 0.04,
                "imbalance_bid_sz": 4200,
                "imbalance_ask_sz": 5600,
                "price_vs_session_open_bps": -55,
                "opening_window_return_bps": -18,
                "price_position_in_session_range": 0.18,
                "price_vs_session_low_bps": 9,
                "price_vs_opening_range_low_bps": 6,
                "session_range_bps": 82,
                "recent_spread_bps_avg": 3.2,
                "recent_spread_bps_max": 7.8,
                "recent_imbalance_pressure_avg": -0.02,
                "recent_quote_invalid_ratio": 0.03,
                "recent_quote_jump_bps_max": 12,
                "recent_microprice_bias_bps_avg": -0.10,
                "recent_above_vwap_w5m_ratio": 0.22,
                "cross_section_opening_window_return_rank": 0.22,
                "cross_section_continuation_rank": 0.38,
                "cross_section_reversal_rank": 0.51,
                "cross_section_recent_imbalance_rank": 0.24,
                "cross_section_positive_recent_imbalance_ratio": 0.18,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNone(decision)

    def test_washout_rebound_plugin_does_not_exit_on_shallow_recovery_touch(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="washout-rebound",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="washout_rebound_long_v1",
            universe_symbols=["AMD"],
            max_position_pct_equity=Decimal("1.5"),
            max_notional_per_trade=Decimal("18000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 25, 16, 4, 12, tzinfo=timezone.utc),
            symbol="AMD",
            timeframe="1Sec",
            seq=5,
            payload={
                "price": 101.88,
                "ema12": 101.70,
                "macd": -0.011,
                "macd_signal": -0.009,
                "rsi14": 51,
                "vol_realized_w60s": 0.00022,
                "vwap_session": 101.82,
                "spread": 0.04,
                "imbalance_bid_sz": 5100,
                "imbalance_ask_sz": 4700,
                "price_vs_session_open_bps": -11,
                "opening_window_return_bps": -18,
                "price_position_in_session_range": 0.34,
                "price_vs_session_low_bps": 16,
                "price_vs_opening_range_low_bps": 10,
                "session_range_bps": 82,
                "recent_spread_bps_avg": 3.2,
                "recent_spread_bps_max": 7.8,
                "recent_imbalance_pressure_avg": 0.03,
                "recent_quote_invalid_ratio": 0.03,
                "recent_quote_jump_bps_max": 12,
                "recent_microprice_bias_bps_avg": 0.14,
                "recent_above_vwap_w5m_ratio": 0.28,
                "cross_section_opening_window_return_rank": 0.22,
                "cross_section_continuation_rank": 0.38,
                "cross_section_reversal_rank": 0.89,
                "cross_section_recent_imbalance_rank": 0.76,
                "cross_section_positive_recent_imbalance_ratio": 0.58,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNone(decision)

    def test_mean_reversion_exhaustion_short_plugin_emits_sell_after_controlled_extension(
        self,
    ) -> None:
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
            event_ts=datetime(2026, 3, 24, 17, 18, 12, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=21,
            payload={
                "price": 598.40,
                "ema12": 596.90,
                "macd": 0.002,
                "macd_signal": -0.002,
                "rsi14": 58,
                "vol_realized_w60s": 0.00022,
                "vwap_session": 595.90,
                "spread": 0.05,
                "imbalance_bid_sz": 4300,
                "imbalance_ask_sz": 4700,
                "price_vs_session_open_bps": 42,
                "price_position_in_session_range": 0.86,
                "price_vs_opening_range_high_bps": 4,
                "session_range_bps": 88,
                "recent_spread_bps_avg": 0.82,
                "recent_spread_bps_max": 1.44,
                "recent_imbalance_pressure_avg": -0.05,
                "recent_microprice_bias_bps_avg": -0.20,
                "cross_section_opening_window_return_rank": 0.86,
                "cross_section_continuation_rank": 0.38,
                "cross_section_reversal_rank": 0.80,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "sell")
        self.assertEqual(decision.plugin_id, "mean_reversion_exhaustion_short")
        self.assertIn("overbought_fade", decision.intent.rationale)

    def test_mean_reversion_exhaustion_short_plugin_emits_buy_after_fade_completes(
        self,
    ) -> None:
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

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "buy")
        self.assertEqual(decision.plugin_id, "mean_reversion_exhaustion_short")

    def test_end_of_day_reversal_plugin_emits_buy_for_late_intraday_loser(self) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="end-of-day-reversal",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="end_of_day_reversal_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("12000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 19, 28, 12, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 252.30,
                "ema12": 252.95,
                "ema26": 253.18,
                "macd": -0.006,
                "macd_signal": -0.002,
                "rsi14": 41,
                "vol_realized_w60s": 0.00023,
                "vwap_session": 253.00,
                "spread": 0.04,
                "imbalance_bid_sz": 5500,
                "imbalance_ask_sz": 4700,
                "price_vs_session_open_bps": -58,
                "price_position_in_session_range": 0.31,
                "price_vs_opening_range_low_bps": 4,
                "session_range_bps": 86,
                "recent_spread_bps_avg": 0.79,
                "recent_spread_bps_max": 1.46,
                "recent_imbalance_pressure_avg": 0.07,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "buy")
        self.assertEqual(decision.plugin_id, "end_of_day_reversal_long")
        self.assertIn("close_reversion_setup", decision.intent.rationale)

    def test_end_of_day_reversal_plugin_emits_sell_after_reversion_completes(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="end-of-day-reversal",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="end_of_day_reversal_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("12000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 19, 28, 12, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=2,
            payload={
                "price": 253.40,
                "ema12": 253.10,
                "ema26": 252.98,
                "macd": 0.004,
                "macd_signal": 0.002,
                "rsi14": 57,
                "vol_realized_w60s": 0.00023,
                "vwap_session": 253.00,
                "spread": 0.04,
                "imbalance_bid_sz": 5500,
                "imbalance_ask_sz": 4700,
                "price_vs_session_open_bps": 12,
                "price_position_in_session_range": 0.72,
                "price_vs_opening_range_low_bps": 28,
                "session_range_bps": 86,
                "recent_spread_bps_avg": 0.79,
                "recent_spread_bps_max": 1.46,
                "recent_imbalance_pressure_avg": 0.07,
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "sell")
        self.assertEqual(decision.plugin_id, "end_of_day_reversal_long")

    def test_runtime_isolates_plugin_failures_and_continues(self) -> None:
        healthy = Strategy(
            id=uuid.uuid4(),
            name="healthy",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="legacy_macd_rsi",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("2000"),
        )
        broken = Strategy(
            id=uuid.uuid4(),
            name="broken",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="failing",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("2000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=5,
            payload={"macd": {"macd": 1.2, "signal": 0.3}, "rsi14": 24, "price": 101.5},
        )
        feature_contract = normalize_feature_vector_v3(signal)

        registry = StrategyRegistry(
            plugins={
                "legacy_macd_rsi": LegacyMacdRsiPlugin(),
                "failing": _FailingPlugin(),
            }
        )
        runtime = StrategyRuntime(registry=registry)
        evaluation = runtime.evaluate_all(
            [healthy, broken], feature_contract, timeframe="1Min"
        )

        self.assertEqual(len(evaluation.intents), 1)
        self.assertEqual(evaluation.intents[0].direction, "buy")
        self.assertEqual(len(evaluation.errors), 1)
        self.assertEqual(evaluation.errors[0].strategy_id, str(broken.id))
        self.assertEqual(
            evaluation.observation.strategy_errors_total.get(str(broken.id)), 1
        )

    def test_runtime_replay_is_deterministic_for_fixed_fixture(self) -> None:
        strategy_a = Strategy(
            id=uuid.uuid4(),
            name="legacy-a",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="legacy_macd_rsi",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("1000"),
        )
        strategy_b = Strategy(
            id=uuid.uuid4(),
            name="legacy-b",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="legacy_macd_rsi",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("2000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 10, 14, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=88,
            payload={"macd": {"macd": 1.5, "signal": 0.4}, "rsi14": 22, "price": 130.1},
        )
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()

        evaluation_a = runtime.evaluate_all(
            [strategy_a, strategy_b], feature_contract, timeframe="1Min"
        )
        evaluation_b = runtime.evaluate_all(
            [strategy_a, strategy_b], feature_contract, timeframe="1Min"
        )

        self.assertEqual(len(evaluation_a.intents), 1)
        self.assertEqual(len(evaluation_b.intents), 1)
        self.assertEqual(evaluation_a.intents[0].symbol, evaluation_b.intents[0].symbol)
        self.assertEqual(
            evaluation_a.intents[0].direction, evaluation_b.intents[0].direction
        )
        self.assertEqual(
            evaluation_a.intents[0].confidence, evaluation_b.intents[0].confidence
        )
        self.assertEqual(
            evaluation_a.intents[0].target_notional,
            evaluation_b.intents[0].target_notional,
        )
        self.assertEqual(
            evaluation_a.intents[0].source_strategy_ids,
            evaluation_b.intents[0].source_strategy_ids,
        )

    def test_runtime_aggregates_source_ids_only_from_winning_direction(self) -> None:
        buy_strategy = Strategy(
            id=uuid.UUID("ffffffff-ffff-ffff-ffff-ffffffffffff"),
            name="buy",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="buy_plugin",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("100"),
        )
        sell_strategy = Strategy(
            id=uuid.UUID("00000000-0000-0000-0000-000000000001"),
            name="sell",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="sell_plugin",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("900"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=99,
            payload={"macd": {"macd": 1.2, "signal": 0.3}, "rsi14": 24, "price": 101.5},
        )
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime(
            registry=StrategyRegistry(
                plugins={
                    "buy_plugin": _BuyPlugin(),
                    "sell_plugin": _SellPlugin(),
                }
            )
        )

        evaluation = runtime.evaluate_all(
            [buy_strategy, sell_strategy], feature_contract, timeframe="1Min"
        )

        self.assertEqual(len(evaluation.intents), 1)
        self.assertEqual(evaluation.intents[0].direction, "buy")
        self.assertEqual(
            evaluation.intents[0].source_strategy_ids,
            (str(buy_strategy.id),),
        )

    def test_runtime_skips_strategy_when_signal_symbol_is_outside_universe(
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
            event_ts=datetime(2026, 3, 24, 19, 45, 55, tzinfo=timezone.utc),
            symbol="AAPL",
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
            },
        )

        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime()

        self.assertIsNone(
            runtime.evaluate(strategy, feature_contract, timeframe="1Sec")
        )

    def test_runtime_rejects_plugin_with_undeclared_contract_feature(self) -> None:
        class InvalidPlugin:
            plugin_id = "invalid_plugin"
            version = "1.0.0"
            required_features = ("price", "not_in_feature_contract")

            def evaluate(self, context, features):  # type: ignore[no-untyped-def]
                _ = context
                _ = features
                return None

        strategy = Strategy(
            id=uuid.uuid4(),
            name="invalid-plugin",
            description="version=1.0.0",
            enabled=True,
            base_timeframe="1Min",
            universe_type="invalid",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("2500"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            payload={"macd": {"macd": 1.2, "signal": 0.3}, "rsi14": 25, "price": 101.5},
        )
        feature_contract = normalize_feature_vector_v3(signal)
        runtime = StrategyRuntime(
            registry=StrategyRegistry(plugins={"invalid": InvalidPlugin()})
        )

        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Min")
        self.assertIsNone(decision)

    def test_definition_from_strategy_uses_catalog_metadata_bridge_for_compiled_identity(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-db-row",
            description=(
                "intraday compiled spec\n[catalog_metadata]\n"
                '{"compiled_targets":{"promotion_metadata":{"promotion_policy_ref":"torghut-promotion/vnext-default-v1"}},'
                '"compiler_source":"spec_v2",'
                '"params":{"qty":3,"bullish_hist_min":"0.03"},'
                '"strategy_id":"intraday_tsmom_v1@prod",'
                '"strategy_spec_v2":{"feature_view_spec_ref":"features/intraday-momentum-v1","semantic_version":"1.1.0","strategy_id":"intraday_tsmom_v1@prod","universe":{"symbols":["NVDA"],"strategy_type":"intraday_tsmom_v1"}},'
                '"strategy_type":"intraday_tsmom_v1",'
                '"version":"1.1.0"}'
            ),
            enabled=True,
            base_timeframe="1Min",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["NVDA"],
            max_position_pct_equity=Decimal("0.02"),
            max_notional_per_trade=Decimal("2500"),
        )

        definition = StrategyRuntime.definition_from_strategy(strategy)

        self.assertEqual(definition.strategy_id, str(strategy.id))
        self.assertEqual(definition.declared_strategy_id, "intraday_tsmom_v1@prod")
        self.assertEqual(definition.version, "1.1.0")
        self.assertEqual(definition.params["qty"], 3)
        self.assertEqual(definition.compiler_source, "spec_v2")
        self.assertEqual(
            definition.strategy_spec["feature_view_spec_ref"],
            "features/intraday-momentum-v1",
        )

    def test_definition_from_strategy_materializes_hpairs_spec_v2_targets(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="microbar-cross-sectional-pairs-v1",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="microbar-cross-sectional-pairs-v1",
                    strategy_id="microbar_cross_sectional_pairs_v1@research",
                    strategy_type="microbar_cross_sectional_pairs_v1",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="microbar_cross_sectional_pairs_v1",
                    universe_symbols=["AAPL", "AMZN"],
                    max_position_pct_equity=Decimal("6.0"),
                    max_notional_per_trade=Decimal("75000"),
                    params={
                        "entry_minute_after_open": "60",
                        "exit_minute_after_open": "120",
                        "rank_feature": "cross_section_vwap_w5m_rank",
                        "selection_mode": "continuation",
                        "max_pair_legs": "2",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="microbar_cross_sectional_pairs_v1",
            universe_symbols=["AAPL", "AMZN"],
            max_position_pct_equity=Decimal("6.0"),
            max_notional_per_trade=Decimal("75000"),
        )

        definition = StrategyRuntime.definition_from_strategy(strategy)

        self.assertEqual(definition.compiler_source, "spec_v2")
        self.assertEqual(
            definition.declared_strategy_id,
            "microbar_cross_sectional_pairs_v1@research",
        )
        self.assertEqual(
            definition.strategy_spec["feature_view_spec_ref"],
            "features/microbar-cross-sectional-pairs-v1",
        )
        self.assertEqual(
            definition.strategy_spec["universe"],
            {
                "base_timeframe": "1Sec",
                "symbols": ["AAPL", "AMZN"],
                "strategy_type": "microbar_cross_sectional_pairs_v1",
            },
        )
        self.assertEqual(
            definition.compiled_targets["live_runtime_config"]["strategy_type"],
            "microbar_cross_sectional_pairs_v1",
        )

    def test_trace_suppression_reason_falls_back_to_gate_or_default(self) -> None:
        trace = StrategyTrace(
            strategy_id="microbar_cross_sectional_pairs_v1@research",
            strategy_type="microbar_cross_sectional_pairs_v1",
            symbol="AAPL",
            event_ts="2026-03-24T14:30:00+00:00",
            timeframe="1Sec",
            passed=False,
            action=None,
            gates=(
                GateTrace(
                    gate="pair_rank_selection",
                    category="confirmation",
                    passed=False,
                ),
            ),
        )
        empty_trace = trace.with_updates(gates=())

        self.assertEqual(_trace_suppression_reason(trace), "pair_rank_selection")
        self.assertEqual(_trace_suppression_reason(empty_trace), "no_runtime_intent")
