from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.decisions.support import *


class TestDecisionEnginePositions(TestCase):
    def test_scheduler_runtime_microbar_pairs_signal_exit_uses_isolated_short_when_account_long(
        self,
    ) -> None:
        strategy_id = uuid.uuid4()
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=strategy_id,
            name="microbar-pairs-runtime",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="microbar-pairs-runtime",
                    strategy_id="microbar_cross_sectional_pairs_v1@research",
                    strategy_type="microbar_cross_sectional_pairs_v1",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="microbar_cross_sectional_pairs_v1",
                    universe_symbols=["AAPL", "AMZN"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("100"),
                    params={
                        "entry_minute_after_open": "60",
                        "exit_minute_after_open": "120",
                        "signal_motif": "vwap_close_continuation",
                        "rank_feature": "cross_section_vwap_w5m_rank",
                        "selection_mode": "continuation",
                        "max_pair_legs": "2",
                        "position_isolation_mode": "per_strategy",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="microbar_cross_sectional_pairs_v1",
            universe_symbols=["AAPL", "AMZN"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("100"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 15, 30, 0, tzinfo=timezone.utc),
            symbol="AMZN",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 99,
                "spread": 0.02,
                "imbalance_bid_px": 98.99,
                "imbalance_ask_px": 99.01,
                "macd": 0.010,
                "macd_signal": 0.008,
                "rsi14": 56.4,
                "vwap_w5m": 100,
                "session_minutes_elapsed": 120,
                "cross_section_continuation_breadth": 0.5,
                "cross_section_session_open_rank": 0.5,
                "cross_section_vwap_w5m_rank": 0.5,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
            patch.object(settings, "trading_fractional_equities_enabled", True),
            patch.object(settings, "trading_allow_shorts", True),
        ):
            engine.evaluate(
                signal.model_copy(
                    update={
                        "symbol": "AAPL",
                        "payload": {
                            **signal.payload,
                            "price": 101,
                            "imbalance_bid_px": 100.99,
                            "imbalance_ask_px": 101.01,
                            "vwap_w5m": 100,
                        },
                    }
                ),
                [strategy],
                positions=[],
            )
            decisions = engine.evaluate(
                signal,
                [strategy],
                positions=[
                    {
                        "strategy_id": "route-acquisition-probe",
                        "symbol": "AMZN",
                        "qty": "1.00",
                        "side": "long",
                        "market_value": "99",
                        "avg_entry_price": "99",
                    },
                    {
                        "strategy_id": str(strategy_id),
                        "symbol": "AMZN",
                        "qty": "0.25",
                        "side": "short",
                        "market_value": "-24.75",
                        "avg_entry_price": "100",
                    },
                ],
            )

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].action, "buy")
        self.assertEqual(decisions[0].qty, Decimal("0.25"))
        self.assertIn("microbar_cross_sectional_pair_exit", decisions[0].rationale)
        position_exit = decisions[0].params.get("position_exit")
        assert isinstance(position_exit, dict)
        self.assertEqual(position_exit.get("type"), "runtime_signal_exit")
        self.assertEqual(position_exit.get("position_side"), "short")
        runtime_params = decisions[0].params.get("strategy_runtime")
        assert isinstance(runtime_params, dict)
        self.assertEqual(runtime_params.get("position_isolation_mode"), "per_strategy")

    def test_scheduler_runtime_isolated_buy_cooldown_is_scoped_per_strategy(
        self,
    ) -> None:
        first_strategy_id = uuid.uuid4()
        second_strategy_id = uuid.uuid4()
        engine = DecisionEngine(price_fetcher=None)
        engine.strategy_runtime = StrategyRuntime(
            registry=StrategyRegistry(
                plugins={
                    "buy_plugin": _BuyPlugin(),
                }
            )
        )
        first_strategy = Strategy(
            id=first_strategy_id,
            name="isolated-buy-one",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="isolated-buy-one",
                    strategy_id="isolated-buy-one",
                    strategy_type="buy_plugin",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="breakout_continuation_long_v1",
                    universe_symbols=["AAPL"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("1000"),
                    params={
                        "position_isolation_mode": "per_strategy",
                        "entry_cooldown_seconds": "300",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("1000"),
        )
        second_strategy = Strategy(
            id=second_strategy_id,
            name="isolated-buy-two",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="isolated-buy-two",
                    strategy_id="isolated-buy-two",
                    strategy_type="buy_plugin",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="breakout_continuation_long_v1",
                    universe_symbols=["AAPL"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("1000"),
                    params={
                        "position_isolation_mode": "per_strategy",
                        "entry_cooldown_seconds": "300",
                    },
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
                [first_strategy, second_strategy],
                positions=[],
            )

        self.assertEqual(len(decisions), 2)
        self.assertCountEqual(
            [decision.strategy_id for decision in decisions],
            [str(first_strategy_id), str(second_strategy_id)],
        )

    def test_scheduler_runtime_research_sleeve_buy_respects_stop_loss_lockout(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
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
                        "bullish_hist_min": "0.001",
                        "min_bull_rsi": "50",
                        "max_bull_rsi": "80",
                        "max_spread_bps": "100",
                        "min_session_open_drive_bps": "0",
                        "min_session_high_above_opening_range_high_bps": "0",
                        "min_price_vs_opening_range_high_bps": "-100",
                        "max_price_vs_opening_range_high_bps": "100",
                        "min_opening_range_width_bps": "0",
                        "min_session_range_bps": "0",
                        "min_session_range_position": "0",
                        "min_price_vs_vwap_w5m_bps": "-100",
                        "max_price_vs_vwap_w5m_bps": "100",
                        "max_recent_spread_bps": "100",
                        "max_recent_spread_bps_max": "200",
                        "min_recent_imbalance_pressure": "-1",
                        "long_stop_loss_bps": "25",
                        "stop_loss_lockout_seconds": "1800",
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
        stop_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 520.00,
                "ema12": 521.00,
                "ema26": 520.80,
                "macd": 0.010,
                "macd_signal": 0.008,
                "rsi14": 55,
                "vol_realized_w60s": 0.00017,
                "spread": 0.04,
            },
        )
        buy_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 10, 0, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=2,
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

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
            patch.object(settings, "trading_fractional_equities_enabled", True),
        ):
            stop_decisions = engine.evaluate(
                stop_signal,
                [strategy],
                positions=[
                    {
                        "symbol": "META",
                        "strategy_id": str(strategy.id),
                        "qty": "10",
                        "side": "long",
                        "market_value": "5200",
                        "avg_entry_price": "523.00",
                    }
                ],
            )
            locked_out = engine.evaluate(buy_signal, [strategy], positions=[])

        self.assertEqual(len(stop_decisions), 1)
        self.assertEqual(stop_decisions[0].rationale, "position_stop_loss_exit")
        self.assertEqual(locked_out, [])

    def test_scheduler_runtime_observed_wide_spread_blocks_later_breakout_entry(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-continuation",
            description=(
                "version=1.0.0\n[catalog_metadata]\n"
                '{"params":{"bullish_hist_min":"0.001","min_bull_rsi":"50","max_bull_rsi":"80","max_spread_bps":"100","min_session_open_drive_bps":"0","min_session_high_above_opening_range_high_bps":"0","min_price_vs_opening_range_high_bps":"-100","max_price_vs_opening_range_high_bps":"100","min_opening_range_width_bps":"0","min_session_range_bps":"0","min_session_range_position":"0","min_price_vs_vwap_w5m_bps":"-100","max_price_vs_vwap_w5m_bps":"100","max_recent_spread_bps":"100","max_recent_spread_bps_max":"20","min_recent_imbalance_pressure":"-1"},"strategy_type":"breakout_continuation_long_v1","version":"1.0.0"}'
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["AAPL"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        unstable_quote = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 29, 0, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "imbalance_bid_px": 254.97,
                "imbalance_ask_px": 256.60,
                "price": 255.785,
                "ema12": 254.99,
                "ema26": 254.97,
                "macd": 0.018,
                "macd_signal": 0.025,
                "rsi14": 52.7,
                "vol_realized_w60s": 0.00028,
                "vwap_w5m": 254.72,
                "imbalance_bid_sz": 100,
                "imbalance_ask_sz": 100,
            },
        )
        candidate_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=2,
            payload={
                "imbalance_bid_px": 255.37,
                "imbalance_ask_px": 255.40,
                "price": 255.385,
                "ema12": 255.239,
                "ema26": 255.140,
                "macd": 0.099,
                "macd_signal": 0.064,
                "rsi14": 73.0,
                "vol_realized_w60s": 0.000196,
                "vwap_w5m": 254.832,
                "imbalance_bid_sz": 200,
                "imbalance_ask_sz": 200,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
        ):
            engine.observe_signal(unstable_quote)
            decisions = engine.evaluate(candidate_signal, [strategy], positions=[])

        self.assertEqual(decisions, [])

    def test_scheduler_runtime_research_sleeve_sell_respects_min_hold(self) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-continuation",
            description=(
                "version=1.0.0\n[catalog_metadata]\n"
                '{"params":{"min_hold_seconds":"120"},"strategy_type":"breakout_continuation_long_v1","version":"1.0.0"}'
            ),
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
                "spread": 0.04,
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
                        "qty": "10",
                        "side": "long",
                        "market_value": "5228.5",
                        "opened_at": "2026-03-27T17:30:40+00:00",
                    }
                ],
            )

        self.assertEqual(decisions, [])

    def test_scheduler_runtime_research_sleeve_buy_respects_max_concurrent_positions(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-continuation",
            description=(
                "version=1.0.0\n[catalog_metadata]\n"
                '{"params":{"max_concurrent_positions":"1"},"strategy_type":"breakout_continuation_long_v1","version":"1.0.0"}'
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["META", "NVDA"],
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
                        "qty": "75.0000",
                        "side": "long",
                        "market_value": "13650.00",
                        "opened_at": "2026-03-27T17:20:00+00:00",
                    }
                ],
            )

        self.assertEqual(decisions, [])

    def test_scheduler_runtime_intraday_tsmom_caps_buy_to_portfolio_gross_limit(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-levered",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-levered",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("3.0"),
                    max_notional_per_trade=Decimal("30000"),
                    params={
                        "bullish_hist_min": "0.01",
                        "min_bull_rsi": "55",
                        "max_bull_rsi": "60",
                        "vol_ceil": "0.01",
                        "max_price_above_ema12_bps": "0",
                        "min_price_below_ema12_bps": "0",
                        "max_price_below_ema12_bps": "20",
                        "max_gross_exposure_pct_equity": "1.5",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("3.0"),
            max_notional_per_trade=Decimal("30000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 100.0,
                "ema12": 100.05,
                "ema26": 99.95,
                "macd": 0.05,
                "macd_signal": 0.01,
                "rsi14": 56,
                "vol_realized_w60s": 0.0002,
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
                equity=Decimal("10000"),
                positions=[
                    {
                        "symbol": "AAPL",
                        "qty": "100",
                        "side": "long",
                        "market_value": "10000",
                    }
                ],
            )

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].action, "buy")
        self.assertEqual(decisions[0].qty, Decimal("50"))
        sizing = decisions[0].params["sizing"]
        self.assertEqual(sizing["portfolio_gross_cap"], "15000.0")
        self.assertTrue(sizing["portfolio_gross_limited"])

    def test_scheduler_runtime_intraday_tsmom_skips_buy_when_portfolio_gross_is_exhausted(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-levered",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-levered",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("3.0"),
                    max_notional_per_trade=Decimal("30000"),
                    params={
                        "bullish_hist_min": "0.01",
                        "min_bull_rsi": "55",
                        "max_bull_rsi": "60",
                        "vol_ceil": "0.01",
                        "max_price_above_ema12_bps": "0",
                        "min_price_below_ema12_bps": "0",
                        "max_price_below_ema12_bps": "20",
                        "max_gross_exposure_pct_equity": "1.5",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="intraday_tsmom_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("3.0"),
            max_notional_per_trade=Decimal("30000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 100.0,
                "ema12": 100.05,
                "ema26": 99.95,
                "macd": 0.05,
                "macd_signal": 0.01,
                "rsi14": 56,
                "vol_realized_w60s": 0.0002,
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
                equity=Decimal("10000"),
                positions=[
                    {
                        "symbol": "AAPL",
                        "qty": "150",
                        "side": "long",
                        "market_value": "15000",
                    }
                ],
            )

        self.assertEqual(decisions, [])

    def test_scheduler_runtime_intraday_tsmom_emits_stop_loss_exit_overlay(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-stop",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-stop",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("0.08"),
                    max_notional_per_trade=Decimal("1000"),
                    params={"long_stop_loss_bps": "25"},
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
                "price": 526.70,
                "ema12": 526.90,
                "ema26": 526.85,
                "macd": 0.010,
                "macd_signal": 0.008,
                "rsi14": 56.4,
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
                        "market_value": "1005.12497",
                        "avg_entry_price": "528.29",
                    }
                ],
            )

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].action, "sell")
        self.assertEqual(decisions[0].qty, Decimal("1.9091"))
        self.assertEqual(decisions[0].rationale, "position_stop_loss_exit")
        position_exit = decisions[0].params.get("position_exit")
        assert isinstance(position_exit, dict)
        self.assertEqual(position_exit.get("type"), "long_stop_loss_bps")

    def test_scheduler_runtime_microbar_pairs_emits_short_stop_loss_cover_overlay(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="microbar-pairs-short-stop",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="microbar-pairs-short-stop",
                    strategy_id="microbar_cross_sectional_pairs_v1@research",
                    strategy_type="microbar_cross_sectional_short_v1",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="microbar_cross_sectional_pairs_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("50000"),
                    params={"short_stop_loss_bps": "25"},
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="microbar_cross_sectional_pairs_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("50000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 18, 29, 10, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=12,
            payload={
                "price": 101.00,
                "spread": 0.02,
                "macd": 0.010,
                "macd_signal": 0.008,
                "rsi14": 56.4,
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
                        "qty": "10",
                        "side": "short",
                        "market_value": "-1010",
                        "avg_entry_price": "100",
                    }
                ],
            )

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].action, "buy")
        self.assertEqual(decisions[0].qty, Decimal("10"))
        self.assertEqual(decisions[0].rationale, "position_stop_loss_exit")
        position_exit = decisions[0].params.get("position_exit")
        assert isinstance(position_exit, dict)
        self.assertEqual(position_exit.get("type"), "short_stop_loss_bps")

    def test_scheduler_runtime_position_exit_overlay_skips_hard_stop_on_wide_spread(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-stop",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-stop",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("0.08"),
                    max_notional_per_trade=Decimal("1000"),
                    params={
                        "long_stop_loss_bps": "25",
                        "long_stop_loss_spread_bps_multiplier": "0.50",
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
            event_ts=datetime(2026, 3, 27, 18, 29, 10, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=11,
            payload={
                "price": 526.70,
                "spread": 5.00,
                "ema12": 526.90,
                "ema26": 526.85,
                "macd": 0.010,
                "macd_signal": 0.008,
                "rsi14": 56.4,
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
                        "market_value": "1005.12497",
                        "avg_entry_price": "528.29",
                    }
                ],
            )

        self.assertEqual(decisions, [])

    def test_scheduler_runtime_position_trailing_stop_exit_after_peak_drawdown(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="intraday-tsmom-trailing-stop",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="intraday-tsmom-trailing-stop",
                    strategy_id="intraday_tsmom_v1@prod",
                    strategy_type="intraday_tsmom_v1",
                    version="1.1.0",
                    base_timeframe="1Sec",
                    universe_type="intraday_tsmom_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("0.08"),
                    max_notional_per_trade=Decimal("1000"),
                    params={
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
            }
        ]

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_strategy_scheduler_enabled", True),
            patch.object(settings, "trading_fractional_equities_enabled", True),
        ):
            initial_decisions = engine.evaluate(
                peak_signal, [strategy], positions=positions
            )
            trailing_decisions = engine.evaluate(
                trailing_signal, [strategy], positions=positions
            )

        self.assertEqual(initial_decisions, [])
        self.assertEqual(len(trailing_decisions), 1)
        self.assertEqual(trailing_decisions[0].action, "sell")
        self.assertEqual(trailing_decisions[0].rationale, "position_trailing_stop_exit")
        trailing_exit = trailing_decisions[0].params.get("position_exit")
        assert isinstance(trailing_exit, dict)
        self.assertEqual(trailing_exit.get("type"), "long_trailing_stop_bps")
