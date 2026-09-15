from __future__ import annotations

from tests.decisions.support import (
    Decimal,
    DecisionEngine,
    SignalEnvelope,
    SimpleNamespace,
    Strategy,
    StrategyConfig,
    TestCase,
    build_runtime_position_exit_overlay,
    _compose_strategy_description,
    datetime,
    extract_signal_features,
    patch,
    settings,
    timezone,
    uuid,
)


class TestDecisionEngineOverlays(TestCase):
    def test_scheduler_runtime_position_trailing_stop_respects_min_hold(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-trailing-stop-min-hold",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-trailing-stop-min-hold",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("0.08"),
                    max_notional_per_trade=Decimal("1000"),
                    params={
                        "min_hold_seconds": "120",
                        "long_trailing_stop_activation_profit_bps": "20",
                        "long_trailing_stop_drawdown_bps": "15",
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
        peak_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 18, 29, 10, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=11,
            payload={
                "price": 530.00,
                "spread": 0.04,
                "ema12": 529.50,
                "ema26": 529.10,
                "macd": 0.015,
                "macd_signal": 0.010,
                "rsi14": 58.0,
                "vol_realized_w60s": 0.00018,
            },
        )
        trailing_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 18, 30, 10, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=12,
            payload={
                "price": 529.00,
                "spread": 0.04,
                "ema12": 529.30,
                "ema26": 529.05,
                "macd": 0.012,
                "macd_signal": 0.009,
                "rsi14": 56.5,
                "vol_realized_w60s": 0.00018,
            },
        )
        positions = [
            {
                "symbol": "META",
                "qty": "1.9091",
                "side": "long",
                "market_value": "1009.5123",
                "avg_entry_price": "528.29",
                "opened_at": "2026-03-27T18:28:50+00:00",
            }
        ]

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_fractional_equities_enabled", True),
        ):
            initial_decisions = engine.evaluate(
                peak_signal, [strategy], positions=positions
            )
            trailing_decisions = engine.evaluate(
                trailing_signal, [strategy], positions=positions
            )

        self.assertEqual(initial_decisions, [])
        self.assertEqual(trailing_decisions, [])

    def test_scheduler_runtime_position_trailing_stop_skips_non_profitable_exit(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-trailing-stop-profit-floor",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-trailing-stop-profit-floor",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("0.08"),
                    max_notional_per_trade=Decimal("1000"),
                    params={
                        "require_positive_price_for_signal_exit": "true",
                        "long_trailing_stop_activation_profit_bps": "20",
                        "long_trailing_stop_drawdown_bps": "15",
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
        peak_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 18, 29, 10, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=11,
            payload={
                "price": 530.00,
                "spread": 0.04,
                "ema12": 529.50,
                "ema26": 529.10,
                "macd": 0.015,
                "macd_signal": 0.010,
                "rsi14": 58.0,
                "vol_realized_w60s": 0.00018,
            },
        )
        trailing_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 18, 30, 10, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=12,
            payload={
                "price": 528.40,
                "spread": 0.30,
                "ema12": 529.10,
                "ema26": 528.95,
                "macd": 0.012,
                "macd_signal": 0.009,
                "rsi14": 56.5,
                "vol_realized_w60s": 0.00018,
            },
        )
        positions = [
            {
                "symbol": "META",
                "qty": "1.9091",
                "side": "long",
                "market_value": "1009.5123",
                "avg_entry_price": "528.29",
            }
        ]

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_execution_prefer_limit", True),
            patch.object(settings, "trading_fractional_equities_enabled", True),
        ):
            initial_decisions = engine.evaluate(
                peak_signal, [strategy], positions=positions
            )
            trailing_decisions = engine.evaluate(
                trailing_signal, [strategy], positions=positions
            )

        self.assertEqual(initial_decisions, [])
        self.assertEqual(trailing_decisions, [])

    def test_scheduler_runtime_breakout_trailing_stop_holds_above_structure(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-trailing-stop-structure-aware",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="breakout-trailing-stop-structure-aware",
                    strategy_id="breakout_continuation_long_v1@research",
                    strategy_type="breakout_continuation_long_v1",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="breakout_continuation_long_v1",
                    universe_symbols=["AAPL"],
                    max_position_pct_equity=Decimal("1.5"),
                    max_notional_per_trade=Decimal("14000"),
                    params={
                        "long_trailing_stop_activation_profit_bps": "18",
                        "long_trailing_stop_drawdown_bps": "10",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.5"),
            max_notional_per_trade=Decimal("14000"),
        )
        trailing_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 14, 19, 7, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=22,
            payload={
                "price": 255.32,
                "spread": 0.03,
                "ema12": 255.18,
                "ema26": 255.10,
                "macd": 0.028,
                "macd_signal": 0.026,
                "rsi14": 58.2,
                "vol_realized_w60s": 0.00017,
                "vwap_w5m": 255.18,
                "opening_range_high": 255.26,
                "price_vs_session_open_bps": 60,
                "price_position_in_session_range": 0.95,
                "recent_imbalance_pressure_avg": 0.02,
            },
        )
        positions = [
            {
                "symbol": "AAPL",
                "strategy_id": str(strategy.id),
                "qty": "138.8497",
                "side": "long",
                "market_value": "35443.5014",
                "avg_entry_price": "254.69",
                "opened_at": "2026-03-26T14:13:18+00:00",
            }
        ]

        decision = build_runtime_position_exit_overlay(
            signal=trailing_signal,
            strategies=[strategy],
            timeframe="1Sec",
            decisions=[],
            positions=positions,
            equity=Decimal("31590.02"),
            price=Decimal("255.32"),
            features=extract_signal_features(trailing_signal),
            snapshot=None,
            raw_runtime_by_strategy_id={},
            runtime_eval=SimpleNamespace(
                observation=SimpleNamespace(intent_conflicts_total=0),
                errors=[],
            ),
            position_peak_price=Decimal("255.80"),
            aggregated=False,
            position_isolation_mode="per_strategy",
        )

        self.assertIsNone(decision)

    def test_scheduler_runtime_breakout_trailing_stop_exits_after_structure_loss(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-trailing-stop-structure-loss",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="breakout-trailing-stop-structure-loss",
                    strategy_id="breakout_continuation_long_v1@research",
                    strategy_type="breakout_continuation_long_v1",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="breakout_continuation_long_v1",
                    universe_symbols=["AAPL"],
                    max_position_pct_equity=Decimal("1.5"),
                    max_notional_per_trade=Decimal("14000"),
                    params={
                        "long_trailing_stop_activation_profit_bps": "18",
                        "long_trailing_stop_drawdown_bps": "10",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.5"),
            max_notional_per_trade=Decimal("14000"),
        )
        trailing_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 14, 19, 7, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=24,
            payload={
                "price": 255.30,
                "spread": 0.03,
                "ema12": 255.18,
                "ema26": 255.10,
                "macd": 0.028,
                "macd_signal": 0.026,
                "rsi14": 58.2,
                "vol_realized_w60s": 0.00017,
                "vwap_w5m": 255.36,
                "opening_range_high": 255.26,
                "price_vs_session_open_bps": 60,
                "price_position_in_session_range": 0.70,
                "recent_imbalance_pressure_avg": 0.02,
            },
        )
        positions = [
            {
                "symbol": "AAPL",
                "strategy_id": str(strategy.id),
                "qty": "138.8497",
                "side": "long",
                "market_value": "35440.7244",
                "avg_entry_price": "254.69",
                "opened_at": "2026-03-26T14:13:18+00:00",
            }
        ]

        decision = build_runtime_position_exit_overlay(
            signal=trailing_signal,
            strategies=[strategy],
            timeframe="1Sec",
            decisions=[],
            positions=positions,
            equity=Decimal("31590.02"),
            price=Decimal("255.30"),
            features=extract_signal_features(trailing_signal),
            snapshot=None,
            raw_runtime_by_strategy_id={},
            runtime_eval=SimpleNamespace(
                observation=SimpleNamespace(intent_conflicts_total=0),
                errors=[],
            ),
            position_peak_price=Decimal("255.80"),
            aggregated=False,
            position_isolation_mode="per_strategy",
        )

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.action, "sell")
        self.assertEqual(decision.rationale, "position_trailing_stop_exit")
        trailing_exit = decision.params.get("position_exit")
        assert isinstance(trailing_exit, dict)
        self.assertEqual(trailing_exit.get("type"), "long_trailing_stop_bps")

    def test_scheduler_runtime_position_exit_overlay_falls_through_to_max_hold_when_trailing_stop_fails_profit_floor(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="momentum-pullback-max-hold-fallback",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="momentum-pullback-max-hold-fallback",
                    strategy_id="momentum_pullback_long_v1@research",
                    strategy_type="momentum_pullback_long_v1",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="momentum_pullback_long_v1",
                    universe_symbols=["GOOG"],
                    max_position_pct_equity=Decimal("2.0"),
                    max_notional_per_trade=Decimal("63180"),
                    params={
                        "position_isolation_mode": "per_strategy",
                        "long_trailing_stop_activation_profit_bps": "8",
                        "long_trailing_stop_drawdown_bps": "4",
                        "max_hold_seconds": "420",
                        "require_positive_price_for_signal_exit": "true",
                        "min_signal_exit_profit_bps": "8",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="momentum_pullback_long_v1",
            universe_symbols=["GOOG"],
            max_position_pct_equity=Decimal("2.0"),
            max_notional_per_trade=Decimal("63180"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 14, 57, 51, tzinfo=timezone.utc),
            symbol="GOOG",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 284.975,
                "spread": 0.07,
                "ema12": 285.04,
                "ema26": 285.02,
                "macd": 0.010,
                "macd_signal": 0.008,
                "rsi14": 53.2,
                "vol_realized_w60s": 0.00019,
            },
        )
        positions = [
            {
                "symbol": "GOOG",
                "strategy_id": str(strategy.id),
                "qty": "170.7465",
                "side": "long",
                "market_value": "48658.4838375",
                "avg_entry_price": "285.45",
                "opened_at": "2026-03-26T14:50:46+00:00",
            }
        ]

        decision = build_runtime_position_exit_overlay(
            signal=signal,
            strategies=[strategy],
            timeframe="1Sec",
            decisions=[],
            positions=positions,
            equity=Decimal("31590.02"),
            price=Decimal("284.975"),
            features=extract_signal_features(signal),
            snapshot=None,
            raw_runtime_by_strategy_id={},
            runtime_eval=SimpleNamespace(
                observation=SimpleNamespace(intent_conflicts_total=0),
                errors=[],
            ),
            position_peak_price=Decimal("285.76"),
            aggregated=False,
            position_isolation_mode="per_strategy",
        )

        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision.action, "sell")
        self.assertEqual(decision.rationale, "position_time_exit")
        position_exit = decision.params.get("position_exit")
        assert isinstance(position_exit, dict)
        self.assertEqual(position_exit.get("type"), "max_hold_seconds")

    def test_scheduler_runtime_position_exit_overlay_emits_session_flatten_exit(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-session-flatten",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-session-flatten",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("0.08"),
                    max_notional_per_trade=Decimal("1000"),
                    params={
                        "session_flatten_start_minute_utc": "1170",
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
            event_ts=datetime(2026, 3, 27, 19, 30, 0, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=13,
            payload={
                "price": 525.10,
                "spread": 0.20,
                "ema12": 525.30,
                "ema26": 525.25,
                "macd": 0.001,
                "macd_signal": 0.001,
                "rsi14": 50.0,
                "vol_realized_w60s": 0.00012,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
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
                        "market_value": "1002.63",
                        "avg_entry_price": "524.50",
                    }
                ],
            )

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].action, "sell")
        self.assertEqual(decisions[0].rationale, "session_flatten_exit")
        session_exit = decisions[0].params.get("position_exit")
        assert isinstance(session_exit, dict)
        self.assertEqual(session_exit.get("type"), "session_flatten_minute_utc")

    def test_scheduler_runtime_position_exit_overlay_flattens_pair_long_leg(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
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
                    max_position_pct_equity=Decimal("0.06"),
                    max_notional_per_trade=Decimal("75000"),
                    params={
                        "session_flatten_start_minute_utc": "1170",
                        "position_isolation_mode": "per_strategy",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="microbar_cross_sectional_pairs_v1",
            universe_symbols=["AAPL", "AMZN"],
            max_position_pct_equity=Decimal("0.06"),
            max_notional_per_trade=Decimal("75000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 19, 30, 0, tzinfo=timezone.utc),
            symbol="AMZN",
            timeframe="1Sec",
            seq=13,
            payload={
                "price": 190.10,
                "spread": 0.03,
                "ema12": 190.12,
                "ema26": 190.08,
                "macd": 0.001,
                "macd_signal": 0.001,
                "rsi14": 50.0,
                "vol_realized_w60s": 0.00012,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_fractional_equities_enabled", True),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                positions=[
                    {
                        "symbol": "AMZN",
                        "strategy_id": str(strategy.id),
                        "qty": "2.5",
                        "side": "long",
                        "market_value": "475.25",
                        "avg_entry_price": "189.80",
                    }
                ],
            )

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].action, "sell")
        self.assertEqual(decisions[0].rationale, "session_flatten_exit")
        session_exit = decisions[0].params.get("position_exit")
        assert isinstance(session_exit, dict)
        self.assertEqual(session_exit.get("type"), "session_flatten_minute_utc")

    def test_scheduler_runtime_position_exit_overlay_flattens_pair_short_leg(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
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
                    max_position_pct_equity=Decimal("0.06"),
                    max_notional_per_trade=Decimal("75000"),
                    params={
                        "session_flatten_start_minute_utc": "1170",
                        "position_isolation_mode": "per_strategy",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="microbar_cross_sectional_pairs_v1",
            universe_symbols=["AAPL", "AMZN"],
            max_position_pct_equity=Decimal("0.06"),
            max_notional_per_trade=Decimal("75000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 19, 30, 0, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=13,
            payload={
                "price": 225.10,
                "spread": 0.02,
                "ema12": 225.12,
                "ema26": 225.08,
                "macd": 0.001,
                "macd_signal": 0.001,
                "rsi14": 50.0,
                "vol_realized_w60s": 0.00012,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_fractional_equities_enabled", True),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                positions=[
                    {
                        "symbol": "AAPL",
                        "strategy_id": str(strategy.id),
                        "qty": "-3",
                        "side": "short",
                        "market_value": "-675.30",
                        "avg_entry_price": "224.50",
                    }
                ],
            )

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].action, "buy")
        self.assertEqual(decisions[0].rationale, "session_flatten_exit")
        session_exit = decisions[0].params.get("position_exit")
        assert isinstance(session_exit, dict)
        self.assertEqual(session_exit.get("type"), "session_flatten_minute_utc")

    def test_scheduler_runtime_position_exit_overlay_session_flatten_bypasses_min_hold(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-session-flatten-min-hold",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-session-flatten-min-hold",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("0.08"),
                    max_notional_per_trade=Decimal("1000"),
                    params={
                        "min_hold_seconds": "3600",
                        "session_flatten_start_minute_utc": "1170",
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
            event_ts=datetime(2026, 3, 27, 19, 30, 0, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=13,
            payload={
                "price": 525.10,
                "spread": 0.20,
                "ema12": 525.30,
                "ema26": 525.25,
                "macd": 0.001,
                "macd_signal": 0.001,
                "rsi14": 50.0,
                "vol_realized_w60s": 0.00012,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
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
                        "market_value": "1002.63",
                        "avg_entry_price": "524.50",
                        "opened_at": "2026-03-27T19:29:15+00:00",
                    }
                ],
            )

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].action, "sell")
        self.assertEqual(decisions[0].rationale, "session_flatten_exit")
        session_exit = decisions[0].params.get("position_exit")
        assert isinstance(session_exit, dict)
        self.assertEqual(session_exit.get("type"), "session_flatten_minute_utc")

    def test_scheduler_runtime_position_exit_overlay_session_flatten_bypasses_profit_floor(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-session-flatten-loss",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-session-flatten-loss",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("0.08"),
                    max_notional_per_trade=Decimal("1000"),
                    params={
                        "session_flatten_start_minute_utc": "1170",
                        "require_positive_price_for_signal_exit": "true",
                        "min_signal_exit_profit_bps": "8",
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
            event_ts=datetime(2026, 3, 27, 19, 30, 0, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=13,
            payload={
                "price": 523.90,
                "spread": 0.20,
                "ema12": 524.20,
                "ema26": 524.15,
                "macd": -0.001,
                "macd_signal": 0.001,
                "rsi14": 48.0,
                "vol_realized_w60s": 0.00012,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
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
                        "market_value": "1000.00",
                        "avg_entry_price": "524.50",
                        "opened_at": "2026-03-27T18:15:00+00:00",
                    }
                ],
            )

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].action, "sell")
        self.assertEqual(decisions[0].rationale, "session_flatten_exit")

    def test_scheduler_runtime_position_exit_overlay_emits_max_hold_exit(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-continuation-max-hold",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="breakout-continuation-max-hold",
                    strategy_id="breakout_continuation_long_v1@research",
                    strategy_type="breakout_continuation_long_v1",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="breakout_continuation_long_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("14000"),
                    params={
                        "max_hold_seconds": "300",
                        "require_positive_price_for_signal_exit": "true",
                        "min_signal_exit_profit_bps": "8",
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
            event_ts=datetime(2026, 3, 27, 17, 35, 30, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=14,
            payload={
                "price": 522.90,
                "spread": 0.08,
                "ema12": 523.40,
                "ema26": 523.10,
                "macd": 0.006,
                "macd_signal": 0.004,
                "rsi14": 55.0,
                "vol_realized_w60s": 0.00015,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_fractional_equities_enabled", True),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                positions=[
                    {
                        "symbol": "META",
                        "strategy_id": str(strategy.id),
                        "qty": "26.7624",
                        "side": "long",
                        "market_value": "13995.02",
                        "avg_entry_price": "523.40",
                        "opened_at": "2026-03-27T17:30:00+00:00",
                    }
                ],
            )

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].action, "sell")
        self.assertEqual(decisions[0].rationale, "position_time_exit")
        max_hold_exit = decisions[0].params.get("position_exit")
        assert isinstance(max_hold_exit, dict)
        self.assertEqual(max_hold_exit.get("type"), "max_hold_seconds")

    def test_scheduler_runtime_position_exit_overlay_emits_max_hold_exit_for_isolated_strategy(
        self,
    ) -> None:
        strategy_id = uuid.uuid4()
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=strategy_id,
            name="breakout-continuation-max-hold-isolated",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="breakout-continuation-max-hold-isolated",
                    strategy_id="breakout_continuation_long_v1@research",
                    strategy_type="breakout_continuation_long_v1",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="breakout_continuation_long_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("14000"),
                    params={
                        "position_isolation_mode": "per_strategy",
                        "max_hold_seconds": "300",
                        "require_positive_price_for_signal_exit": "true",
                        "min_signal_exit_profit_bps": "8",
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
            event_ts=datetime(2026, 3, 27, 17, 35, 30, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=15,
            payload={
                "price": 522.90,
                "spread": 0.08,
                "ema12": 523.40,
                "ema26": 523.10,
                "macd": 0.006,
                "macd_signal": 0.004,
                "rsi14": 55.0,
                "vol_realized_w60s": 0.00015,
                "vwap_session": 523.05,
                "imbalance_bid_sz": 4100,
                "imbalance_ask_sz": 3900,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_fractional_equities_enabled", True),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                positions=[
                    {
                        "symbol": "META",
                        "strategy_id": str(strategy_id),
                        "qty": "26.7624",
                        "side": "long",
                        "market_value": "13995.02",
                        "avg_entry_price": "523.40",
                        "opened_at": "2026-03-27T17:30:00+00:00",
                    }
                ],
            )

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].action, "sell")
        self.assertEqual(decisions[0].rationale, "position_time_exit")
        runtime_payload = decisions[0].params.get("strategy_runtime")
        assert isinstance(runtime_payload, dict)
        self.assertEqual(runtime_payload.get("position_isolation_mode"), "per_strategy")
        max_hold_exit = decisions[0].params.get("position_exit")
        assert isinstance(max_hold_exit, dict)
        self.assertEqual(max_hold_exit.get("type"), "max_hold_seconds")
