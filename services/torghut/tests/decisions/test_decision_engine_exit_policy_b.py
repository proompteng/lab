from __future__ import annotations

from tests.decisions.support import (
    Decimal,
    DecisionEngine,
    SignalEnvelope,
    Strategy,
    StrategyConfig,
    StrategyRegistry,
    StrategyRuntime,
    TestCase,
    _SellPlugin,
    _compose_strategy_description,
    _count_open_short_positions,
    _exit_position_side_for_strategies,
    _is_entry_action_for_strategies,
    _is_exit_action_for_strategies,
    _resolve_qty,
    _resolve_qty_for_aggregated,
    datetime,
    patch,
    settings,
    timezone,
    uuid,
)


class TestDecisionEngineExitPolicyB(TestCase):
    def test_short_side_runtime_helpers_cover_exit_only_and_short_position_fallbacks(
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

        blocked_qty, blocked_meta = _resolve_qty(
            strategy,
            symbol="META",
            action="buy",
            price=Decimal("100"),
            equity=Decimal("10000"),
            positions=[{"symbol": "META", "qty": "2", "side": "long"}],
        )
        self.assertEqual(blocked_qty, Decimal("0"))
        self.assertEqual(blocked_meta["reason"], "exit_only_buy_without_short_position")

        cover_qty, cover_meta = _resolve_qty(
            strategy,
            symbol="META",
            action="buy",
            price=Decimal("100"),
            equity=Decimal("10000"),
            positions=[{"symbol": "META", "qty": "3", "side": "short"}],
        )
        self.assertEqual(cover_qty, Decimal("3"))
        self.assertEqual(cover_meta["method"], "min(max_notional,pct_equity)")

        self.assertFalse(
            _is_entry_action_for_strategies(strategies=[strategy], action="hold")
        )
        self.assertFalse(
            _is_exit_action_for_strategies(strategies=[strategy], action="hold")
        )
        self.assertIsNone(
            _exit_position_side_for_strategies(strategies=[strategy], action="hold")
        )

        self.assertEqual(_count_open_short_positions(None), 0)
        self.assertEqual(
            _count_open_short_positions(
                [
                    {"symbol": "META", "qty": "3", "side": "short"},
                    {"symbol": "", "qty": "2", "side": "short"},
                    {
                        "symbol": "AAPL",
                        "qty": "bad",
                        "side": "short",
                        "market_value": "-50",
                    },
                    {
                        "symbol": "NVDA",
                        "qty": "bad",
                        "side": "short",
                        "market_value": "bad",
                    },
                    {"symbol": "MSFT", "side": "short", "market_value": "0"},
                    {"symbol": "TSLA", "qty": "1", "side": "long"},
                ]
            ),
            2,
        )

    def test_scheduler_runtime_breakout_continuation_skips_exit_only_sell_for_pending_entry_only(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
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
                "vwap_session": 523.05,
                "spread": 0.04,
                "imbalance_bid_sz": 4100,
                "imbalance_ask_sz": 4900,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
        ):
            decisions = engine.evaluate(
                signal,
                [strategy],
                positions=[
                    {
                        "symbol": "META",
                        "strategy_id": str(strategy.id),
                        "qty": "26.4",
                        "side": "long",
                        "market_value": "13803.24",
                        "avg_entry_price": "522.85",
                        "pending_entry": True,
                    }
                ],
            )

        self.assertEqual(decisions, [])

    def test_scheduler_runtime_research_sleeve_buy_respects_entry_cooldown(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-continuation",
            description=(
                "version=1.0.0\n[catalog_metadata]\n"
                '{"params":{"entry_cooldown_seconds":"300","bullish_hist_min":"0.001","min_bull_rsi":"50","max_bull_rsi":"80","max_spread_bps":"100","min_session_open_drive_bps":"0","min_opening_window_return_bps":"0","min_session_open_return_efficiency":"0","min_session_high_above_opening_range_high_bps":"0","min_price_vs_opening_range_high_bps":"-100","max_price_vs_opening_range_high_bps":"100","min_price_vs_opening_window_close_bps":"-100","max_price_vs_opening_window_close_bps":"100","min_opening_range_width_bps":"0","min_session_range_bps":"0","min_session_range_position":"0","min_price_vs_vwap_w5m_bps":"-100","max_price_vs_vwap_w5m_bps":"100","max_recent_spread_bps":"100","max_recent_spread_bps_max":"200","max_recent_quote_jump_bps":"200","min_recent_imbalance_pressure":"-1"},"strategy_type":"breakout_continuation_long_v1","version":"1.0.0"}'
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
                "imbalance_bid_px": 523.23,
                "imbalance_ask_px": 523.27,
                "vwap_w5m": 523.10,
                "imbalance_bid_sz": 20000,
                "imbalance_ask_sz": 1000,
                "price_vs_session_open_bps": 46,
                "price_vs_prev_session_close_bps": 46,
                "opening_window_return_from_prev_close_bps": 28,
                "session_high_price": 523.70,
                "opening_range_high": 523.10,
                "price_vs_opening_range_high_bps": 3,
                "opening_range_width_bps": 22,
                "session_range_bps": 61,
                "price_position_in_session_range": 0.89,
                "recent_spread_bps_avg": 0.76,
                "recent_spread_bps_max": 1.32,
                "recent_imbalance_pressure_avg": 0.09,
                "recent_quote_invalid_ratio": 0.02,
                "recent_quote_jump_bps_max": 8,
                "recent_microprice_bias_bps_avg": 0.65,
                "cross_section_opening_window_return_from_prev_close_rank": 0.82,
                "cross_section_continuation_rank": 0.84,
                "cross_section_continuation_breadth": 0.61,
            },
        )
        seed_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 14, 0, 3, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=0,
            payload={
                "price": 521.40,
                "ema12": 521.30,
                "ema26": 521.10,
                "macd": 0.010,
                "macd_signal": 0.008,
                "rsi14": 58,
                "vol_realized_w60s": 0.00015,
                "spread": 0.03,
                "imbalance_bid_px": 521.385,
                "imbalance_ask_px": 521.415,
                "vwap_w5m": 521.28,
                "imbalance_bid_sz": 20000,
                "imbalance_ask_sz": 1000,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
        ):
            engine.evaluate(seed_signal, [strategy], positions=[])
            first = engine.evaluate(signal, [strategy], positions=[])
            second = engine.evaluate(signal, [strategy], positions=[])

        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])

    def test_scheduler_runtime_continuation_buy_defaults_to_ioc_time_in_force(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-continuation",
            description=(
                "version=1.0.0\n[catalog_metadata]\n"
                '{"params":{"bullish_hist_min":"0.001","min_bull_rsi":"50","max_bull_rsi":"80","max_spread_bps":"100","min_session_open_drive_bps":"0","min_opening_window_return_bps":"0","min_session_open_return_efficiency":"0","min_session_high_above_opening_range_high_bps":"0","min_price_vs_opening_range_high_bps":"-100","max_price_vs_opening_range_high_bps":"100","min_price_vs_opening_window_close_bps":"-100","max_price_vs_opening_window_close_bps":"100","min_opening_range_width_bps":"0","min_session_range_bps":"0","min_session_range_position":"0","min_price_vs_vwap_w5m_bps":"-100","max_price_vs_vwap_w5m_bps":"100","max_recent_spread_bps":"100","max_recent_spread_bps_max":"200","max_recent_quote_jump_bps":"200","min_recent_imbalance_pressure":"-1"},"strategy_type":"breakout_continuation_long_v1","version":"1.0.0"}'
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        seed_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 14, 0, 3, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=0,
            payload={
                "price": 521.40,
                "ema12": 521.30,
                "ema26": 521.10,
                "macd": 0.010,
                "macd_signal": 0.008,
                "rsi14": 58,
                "vol_realized_w60s": 0.00015,
                "spread": 0.03,
                "imbalance_bid_px": 521.385,
                "imbalance_ask_px": 521.415,
                "vwap_w5m": 521.28,
                "imbalance_bid_sz": 20000,
                "imbalance_ask_sz": 1000,
            },
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
                "imbalance_bid_px": 523.23,
                "imbalance_ask_px": 523.27,
                "vwap_w5m": 523.10,
                "imbalance_bid_sz": 20000,
                "imbalance_ask_sz": 1000,
                "price_vs_session_open_bps": 46,
                "price_vs_prev_session_close_bps": 46,
                "opening_window_return_from_prev_close_bps": 28,
                "session_high_price": 523.70,
                "opening_range_high": 523.10,
                "price_vs_opening_range_high_bps": 3,
                "opening_range_width_bps": 22,
                "session_range_bps": 61,
                "price_position_in_session_range": 0.89,
                "recent_spread_bps_avg": 0.76,
                "recent_spread_bps_max": 1.32,
                "recent_imbalance_pressure_avg": 0.09,
                "recent_quote_invalid_ratio": 0.02,
                "recent_quote_jump_bps_max": 8,
                "recent_microprice_bias_bps_avg": 0.65,
                "cross_section_opening_window_return_from_prev_close_rank": 0.82,
                "cross_section_continuation_rank": 0.84,
                "cross_section_continuation_breadth": 0.61,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
        ):
            engine.evaluate(seed_signal, [strategy], positions=[])
            decisions = engine.evaluate(signal, [strategy], positions=[])

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].time_in_force, "ioc")

    def test_scheduler_runtime_research_sleeve_buy_respects_max_entries_per_session(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        strategy = Strategy(
            id=uuid.uuid4(),
            name="breakout-continuation",
            description=(
                "version=1.0.0\n[catalog_metadata]\n"
                '{"params":{"max_entries_per_session":"1","bullish_hist_min":"0.001","min_bull_rsi":"50","max_bull_rsi":"80","max_spread_bps":"100","min_session_open_drive_bps":"0","min_opening_window_return_bps":"0","min_session_open_return_efficiency":"0","min_session_high_above_opening_range_high_bps":"0","min_price_vs_opening_range_high_bps":"-100","max_price_vs_opening_range_high_bps":"100","min_price_vs_opening_window_close_bps":"-100","max_price_vs_opening_window_close_bps":"100","min_opening_range_width_bps":"0","min_session_range_bps":"0","min_session_range_position":"0","min_price_vs_vwap_w5m_bps":"-100","max_price_vs_vwap_w5m_bps":"100","max_recent_spread_bps":"100","max_recent_spread_bps_max":"200","max_recent_quote_jump_bps":"200","min_recent_imbalance_pressure":"-1"},"strategy_type":"breakout_continuation_long_v1","version":"1.0.0"}'
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="breakout_continuation_long_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("14000"),
        )
        seed_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 14, 0, 3, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=0,
            payload={
                "price": 521.40,
                "ema12": 521.30,
                "ema26": 521.10,
                "macd": 0.010,
                "macd_signal": 0.008,
                "rsi14": 58,
                "vol_realized_w60s": 0.00015,
                "spread": 0.03,
                "imbalance_bid_px": 521.385,
                "imbalance_ask_px": 521.415,
                "vwap_w5m": 521.28,
                "imbalance_bid_sz": 20000,
                "imbalance_ask_sz": 1000,
            },
        )
        first_signal = SignalEnvelope(
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
                "imbalance_bid_px": 523.23,
                "imbalance_ask_px": 523.27,
                "vwap_w5m": 523.10,
                "imbalance_bid_sz": 20000,
                "imbalance_ask_sz": 1000,
                "price_vs_session_open_bps": 46,
                "price_vs_prev_session_close_bps": 46,
                "opening_window_return_from_prev_close_bps": 28,
                "session_high_price": 523.70,
                "opening_range_high": 523.10,
                "price_vs_opening_range_high_bps": 3,
                "opening_range_width_bps": 22,
                "session_range_bps": 61,
                "price_position_in_session_range": 0.89,
                "recent_spread_bps_avg": 0.76,
                "recent_spread_bps_max": 1.32,
                "recent_imbalance_pressure_avg": 0.09,
                "recent_quote_invalid_ratio": 0.02,
                "recent_quote_jump_bps_max": 8,
                "recent_microprice_bias_bps_avg": 0.65,
                "cross_section_opening_window_return_from_prev_close_rank": 0.82,
                "cross_section_continuation_rank": 0.84,
                "cross_section_continuation_breadth": 0.61,
            },
        )
        second_signal = first_signal.model_copy(
            update={
                "event_ts": datetime(2026, 3, 27, 18, 0, 3, tzinfo=timezone.utc),
                "seq": 2,
            }
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
        ):
            engine.evaluate(seed_signal, [strategy], positions=[])
            first = engine.evaluate(first_signal, [strategy], positions=[])
            second = engine.evaluate(second_signal, [strategy], positions=[])

        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])

    def test_scheduler_runtime_microbar_long_sell_does_not_open_short_when_flat(
        self,
    ) -> None:
        engine = DecisionEngine(price_fetcher=None)
        engine.strategy_runtime = StrategyRuntime(
            registry=StrategyRegistry(
                plugins={
                    "sell_plugin": _SellPlugin(),
                }
            )
        )
        strategy = Strategy(
            id=uuid.uuid4(),
            name="microbar-long-flat-exit",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="microbar-long-flat-exit",
                    strategy_id="microbar_cross_sectional_long_v1@research",
                    strategy_type="sell_plugin",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="microbar_cross_sectional_long_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("15000"),
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="microbar_cross_sectional_long_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("15000"),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 30, 14, 20, 0, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 525.00,
                "spread": 0.20,
            },
        )

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_fractional_equities_enabled", True),
        ):
            decisions = engine.evaluate(signal, [strategy], positions=[])

        self.assertEqual(decisions, [])

    def test_resolve_qty_for_aggregated_blocks_flat_microbar_long_time_exit(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="microbar-long-flat-exit",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="microbar-long-flat-exit",
                    strategy_id="microbar_cross_sectional_long_v1@research",
                    strategy_type="microbar_cross_sectional_long_v1",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="microbar_cross_sectional_long_v1",
                    universe_symbols=["NVDA"],
                    max_notional_per_trade=Decimal("15000"),
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="microbar_cross_sectional_long_v1",
            universe_symbols=["NVDA"],
            max_position_pct_equity=None,
            max_notional_per_trade=Decimal("15000"),
        )

        qty, sizing_meta = _resolve_qty_for_aggregated(
            [strategy],
            symbol="NVDA",
            action="sell",
            price=Decimal("167.90"),
            equity=None,
            positions=[],
            capacity_positions=[],
            runtime_target_notional=Decimal("15000"),
        )

        self.assertEqual(qty, Decimal("0"))
        self.assertEqual(
            sizing_meta.get("reason"), "exit_only_sell_without_long_position"
        )

    def test_microbar_pairs_uses_catalog_strategy_type_for_directional_exit_semantics(
        self,
    ) -> None:
        long_strategy = Strategy(
            id=uuid.uuid4(),
            name="microbar-pairs-long-leg",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="microbar-pairs-long-leg",
                    strategy_id="microbar_cross_sectional_pairs_v1@research:long",
                    strategy_type="microbar_cross_sectional_long_v1",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="microbar_cross_sectional_pairs_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("50000"),
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="microbar_cross_sectional_pairs_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("50000"),
        )
        short_strategy = Strategy(
            id=uuid.uuid4(),
            name="microbar-pairs-short-leg",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="microbar-pairs-short-leg",
                    strategy_id="microbar_cross_sectional_pairs_v1@research:short",
                    strategy_type="microbar_cross_sectional_short_v1",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="microbar_cross_sectional_pairs_v1",
                    universe_symbols=["META"],
                    max_position_pct_equity=Decimal("1.0"),
                    max_notional_per_trade=Decimal("50000"),
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="microbar_cross_sectional_pairs_v1",
            universe_symbols=["META"],
            max_position_pct_equity=Decimal("1.0"),
            max_notional_per_trade=Decimal("50000"),
        )

        self.assertTrue(
            _is_entry_action_for_strategies(strategies=[long_strategy], action="buy")
        )
        self.assertFalse(
            _is_exit_action_for_strategies(strategies=[long_strategy], action="buy")
        )
        self.assertTrue(
            _is_exit_action_for_strategies(strategies=[long_strategy], action="sell")
        )
        self.assertEqual(
            _exit_position_side_for_strategies(
                strategies=[long_strategy], action="sell"
            ),
            "long",
        )
        self.assertTrue(
            _is_entry_action_for_strategies(strategies=[short_strategy], action="sell")
        )
        self.assertTrue(
            _is_exit_action_for_strategies(strategies=[short_strategy], action="buy")
        )
        self.assertEqual(
            _exit_position_side_for_strategies(
                strategies=[short_strategy], action="buy"
            ),
            "short",
        )

    def test_scheduler_runtime_microbar_pairs_signal_exit_sells_long_leg_quantity(
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
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": 101,
                "spread": 0.02,
                "imbalance_bid_px": 100.99,
                "imbalance_ask_px": 101.01,
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
            patch.object(settings, "trading_fractional_equities_enabled", True),
        ):
            engine.evaluate(
                signal.model_copy(
                    update={
                        "symbol": "AMZN",
                        "payload": {
                            **signal.payload,
                            "price": 99,
                            "imbalance_bid_px": 98.99,
                            "imbalance_ask_px": 99.01,
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
                        "strategy_id": str(strategy_id),
                        "symbol": "AAPL",
                        "qty": "0.25",
                        "side": "long",
                        "market_value": "25.25",
                        "avg_entry_price": "100",
                    }
                ],
            )

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].action, "sell")
        self.assertEqual(decisions[0].qty, Decimal("0.25"))
        self.assertIn("microbar_cross_sectional_pair_exit", decisions[0].rationale)
        position_exit = decisions[0].params.get("position_exit")
        assert isinstance(position_exit, dict)
        self.assertEqual(position_exit.get("type"), "runtime_signal_exit")
        self.assertEqual(position_exit.get("position_side"), "long")

    def test_scheduler_runtime_microbar_pairs_materializes_aapl_amzn_entries_with_broader_feature_universe(
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
                    max_notional_per_trade=Decimal("100"),
                    params={
                        "entry_minute_after_open": "60",
                        "exit_minute_after_open": "120",
                        "signal_motif": "vwap_close_continuation",
                        "rank_feature": "cross_section_vwap_w5m_rank",
                        "selection_mode": "continuation",
                        "top_n": "1",
                        "max_pair_legs": "2",
                        "position_isolation_mode": "per_strategy",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="microbar_cross_sectional_pairs_v1",
            universe_symbols=["AAPL", "AMZN"],
            max_position_pct_equity=Decimal("6.0"),
            max_notional_per_trade=Decimal("100"),
        )
        base_payload = {
            "spread": 0.02,
            "imbalance_bid_px": 99.99,
            "imbalance_ask_px": 100.01,
            "macd": 0.010,
            "macd_signal": 0.008,
            "rsi14": 56.4,
            "vwap_w5m": 100,
            "session_minutes_elapsed": 60,
            "cross_section_continuation_breadth": 0.5,
            "cross_section_session_open_rank": 0.5,
        }
        engine = DecisionEngine(price_fetcher=None)

        with (
            patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
            patch.object(settings, "trading_fractional_equities_enabled", False),
            patch.object(settings, "trading_allow_shorts", True),
        ):
            for index, (symbol, price) in enumerate(
                (
                    ("INTC", 95),
                    ("AMZN", 98),
                    ("AAPL", 102),
                    ("NVDA", 105),
                ),
                start=1,
            ):
                engine.evaluate(
                    SignalEnvelope(
                        event_ts=datetime(2026, 3, 27, 14, 29, 59, tzinfo=timezone.utc),
                        symbol=symbol,
                        timeframe="1Sec",
                        seq=index,
                        payload=base_payload | {"price": price},
                    ),
                    [strategy],
                    positions=[],
                )
            aapl_decisions = engine.evaluate(
                SignalEnvelope(
                    event_ts=datetime(2026, 3, 27, 14, 30, 0, tzinfo=timezone.utc),
                    symbol="AAPL",
                    timeframe="1Sec",
                    seq=1,
                    payload=base_payload | {"price": 102},
                ),
                [strategy],
                positions=[],
            )
            amzn_decisions = engine.evaluate(
                SignalEnvelope(
                    event_ts=datetime(2026, 3, 27, 14, 30, 1, tzinfo=timezone.utc),
                    symbol="AMZN",
                    timeframe="1Sec",
                    seq=2,
                    payload=base_payload | {"price": 98},
                ),
                [strategy],
                positions=[],
            )

        self.assertEqual(len(aapl_decisions), 1)
        self.assertEqual(len(amzn_decisions), 1)
        self.assertEqual(aapl_decisions[0].action, "buy")
        self.assertEqual(amzn_decisions[0].action, "sell")
        self.assertEqual(aapl_decisions[0].qty, Decimal("1"))
        self.assertEqual(amzn_decisions[0].qty, Decimal("1"))
        self.assertIn("pair_side:high_rank", aapl_decisions[0].rationale)
        self.assertIn("pair_side:low_rank", amzn_decisions[0].rationale)
        runtime_payload = aapl_decisions[0].params.get("strategy_runtime")
        assert isinstance(runtime_payload, dict)
        self.assertEqual(runtime_payload.get("compiler_sources"), ["spec_v2"])
        source_runtime = runtime_payload.get("source_strategy_runtime")
        assert isinstance(source_runtime, list)
        self.assertEqual(
            source_runtime[0]
            .get("compiled_targets", {})
            .get("live_runtime_config", {})
            .get("strategy_type"),
            "microbar_cross_sectional_pairs_v1",
        )

    def test_scheduler_runtime_microbar_pairs_signal_exit_covers_short_leg_quantity(
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
                        "strategy_id": str(strategy_id),
                        "symbol": "AMZN",
                        "qty": "0.25",
                        "side": "short",
                        "market_value": "-24.75",
                        "avg_entry_price": "100",
                    }
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
