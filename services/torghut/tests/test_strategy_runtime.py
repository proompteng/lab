from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from app.models import Strategy
from app.strategies.catalog import StrategyConfig, _compose_strategy_description
from app.trading.features import FeatureNormalizationError, normalize_feature_vector_v3
from app.trading.models import SignalEnvelope
from app.trading.strategy_runtime import (
    LegacyMacdRsiPlugin,
    StrategyContext,
    StrategyIntent,
    StrategyRegistry,
    StrategyRuntime,
)


class _FailingPlugin:
    plugin_id = "failing"
    version = "1.0.0"
    required_features = ("macd",)

    def evaluate(self, context: StrategyContext, features):  # type: ignore[no-untyped-def]
        _ = context
        _ = features
        raise RuntimeError("boom")


class _BuyPlugin:
    plugin_id = "buy_plugin"
    version = "1.0.0"
    required_features = ("price",)

    def evaluate(  # type: ignore[no-untyped-def]
        self, context: StrategyContext, features
    ) -> StrategyIntent:
        return StrategyIntent(
            strategy_id=context.strategy_id,
            symbol=context.symbol,
            direction="buy",
            confidence=Decimal("0.90"),
            target_notional=Decimal("100"),
            horizon=context.timeframe,
            explain=("buy_signal",),
            feature_snapshot_hash=features.normalization_hash,
            required_features=self.required_features,
        )


class _SellPlugin:
    plugin_id = "sell_plugin"
    version = "1.0.0"
    required_features = ("price",)

    def evaluate(  # type: ignore[no-untyped-def]
        self, context: StrategyContext, features
    ) -> StrategyIntent:
        return StrategyIntent(
            strategy_id=context.strategy_id,
            symbol=context.symbol,
            direction="sell",
            confidence=Decimal("0.40"),
            target_notional=Decimal("200"),
            horizon=context.timeframe,
            explain=("sell_signal",),
            feature_snapshot_hash=features.normalization_hash,
            required_features=self.required_features,
        )


class TestStrategyRuntime(TestCase):
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

    def test_intraday_tsmom_plugin_skips_buy_when_recent_spread_is_unstable(self) -> None:
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

    def test_intraday_tsmom_plugin_skips_buy_when_price_is_above_ema12_band(self) -> None:
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

    def test_breakout_continuation_plugin_respects_cross_section_rank_floor(self) -> None:
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
                        "min_cross_section_opening_window_return_rank": "0.70",
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
        decision = runtime.evaluate(strategy, normalize_feature_vector_v3(signal), timeframe="1Sec")

        self.assertIsNone(decision)

    def test_breakout_continuation_plugin_prefers_prev_close_opening_drive(self) -> None:
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
        decision = runtime.evaluate(strategy, normalize_feature_vector_v3(signal), timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "buy")
        self.assertEqual(decision.plugin_id, "breakout_continuation_long")

    def test_breakout_continuation_plugin_does_not_exit_on_single_reference_loss(self) -> None:
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
        runtime = StrategyRuntime()
        decision = runtime.evaluate(strategy, feature_contract, timeframe="1Sec")

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.intent.action, "sell")
        self.assertEqual(decision.plugin_id, "breakout_continuation_long")
        self.assertIn("breakout_failed", decision.intent.rationale)

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

    def test_breakout_continuation_plugin_uses_spread_bps_when_spread_is_absent(self) -> None:
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

    def test_mean_reversion_rebound_plugin_emits_buy_after_controlled_selloff(self) -> None:
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

    def test_mean_reversion_rebound_plugin_skips_when_liquidity_has_not_normalized(self) -> None:
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

    def test_end_of_day_reversal_plugin_emits_sell_after_reversion_completes(self) -> None:
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

    def test_runtime_skips_strategy_when_signal_symbol_is_outside_universe(self) -> None:
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

        self.assertIsNone(runtime.evaluate(strategy, feature_contract, timeframe="1Sec"))

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
