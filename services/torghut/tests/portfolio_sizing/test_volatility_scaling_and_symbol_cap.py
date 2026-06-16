from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.portfolio_sizing.support import (
    ALLOCATOR_CLIP_SYMBOL_CAPACITY,
    AllocationConfig,
    Decimal,
    PortfolioAllocator,
    PortfolioSizer,
    PortfolioSizingConfig,
    Strategy,
    StrategyDecision,
    _TestPortfolioSizingBase,
    config,
    datetime,
    sizer_from_settings,
    timezone,
)


class TestVolatilityScalingAndSymbolCap(_TestPortfolioSizingBase):
    def test_volatility_scaling_and_symbol_cap(self) -> None:
        sizer = PortfolioSizer(
            PortfolioSizingConfig(
                notional_per_position=Decimal("10000"),
                volatility_target=Decimal("0.2"),
                volatility_floor=Decimal("0.1"),
                max_positions=None,
                max_notional_per_symbol=Decimal("4000"),
                max_position_pct_equity=None,
                max_gross_exposure=None,
                max_net_exposure=None,
            )
        )
        decision = StrategyDecision(
            strategy_id="s1",
            symbol="AAPL",
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            order_type="market",
            time_in_force="day",
            params={"price": Decimal("100"), "volatility": Decimal("0.4")},
        )
        result = sizer.size(decision, account={"equity": "50000"}, positions=[])
        self.assertTrue(result.approved)
        self.assertEqual(result.decision.qty, Decimal("40"))

    def test_volatility_scaling_keeps_fractional_crypto_qty(self) -> None:
        sizer = PortfolioSizer(
            PortfolioSizingConfig(
                notional_per_position=Decimal("1000"),
                volatility_target=None,
                volatility_floor=Decimal("0"),
                max_positions=None,
                max_notional_per_symbol=None,
                max_position_pct_equity=None,
                max_gross_exposure=None,
                max_net_exposure=None,
            )
        )
        decision = StrategyDecision(
            strategy_id="s1",
            symbol="BTC/USD",
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            order_type="market",
            time_in_force="day",
            params={"price": Decimal("100000")},
        )
        result = sizer.size(decision, account={"equity": "50000"}, positions=[])
        self.assertTrue(result.approved)
        self.assertEqual(result.decision.qty, Decimal("0.01000000"))

    def test_max_positions_blocks_new_symbol(self) -> None:
        sizer = PortfolioSizer(
            PortfolioSizingConfig(
                notional_per_position=Decimal("1000"),
                volatility_target=None,
                volatility_floor=Decimal("0"),
                max_positions=2,
                max_notional_per_symbol=None,
                max_position_pct_equity=None,
                max_gross_exposure=None,
                max_net_exposure=None,
            )
        )
        decision = StrategyDecision(
            strategy_id="s1",
            symbol="TSLA",
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            order_type="market",
            time_in_force="day",
            params={"price": Decimal("100")},
        )
        positions = [
            {"symbol": "AAPL", "qty": "5", "market_value": "500"},
            {"symbol": "MSFT", "qty": "3", "market_value": "300"},
        ]
        result = sizer.size(decision, account={"equity": "10000"}, positions=positions)
        self.assertFalse(result.approved)
        self.assertIn("max_positions_exceeded", result.reasons)

    def test_gross_exposure_cap_reduces_notional(self) -> None:
        sizer = PortfolioSizer(
            PortfolioSizingConfig(
                notional_per_position=None,
                volatility_target=None,
                volatility_floor=Decimal("0"),
                max_positions=None,
                max_notional_per_symbol=None,
                max_position_pct_equity=None,
                max_gross_exposure=Decimal("10000"),
                max_net_exposure=Decimal("20000"),
            )
        )
        decision = StrategyDecision(
            strategy_id="s1",
            symbol="NVDA",
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("30"),
            order_type="market",
            time_in_force="day",
            params={"price": Decimal("100")},
        )
        positions = [
            {"symbol": "AAPL", "qty": "60", "market_value": "6000"},
            {"symbol": "MSFT", "qty": "30", "market_value": "3000"},
        ]
        result = sizer.size(decision, account={"equity": "10000"}, positions=positions)
        self.assertTrue(result.approved)
        self.assertEqual(result.decision.qty, Decimal("10"))

    def test_symbol_cap_uses_remaining_capacity_for_existing_position(self) -> None:
        sizer = PortfolioSizer(
            PortfolioSizingConfig(
                notional_per_position=None,
                volatility_target=None,
                volatility_floor=Decimal("0"),
                max_positions=None,
                max_notional_per_symbol=None,
                max_position_pct_equity=Decimal("0.10"),
                max_gross_exposure=None,
                max_net_exposure=None,
            )
        )
        decision = StrategyDecision(
            strategy_id="s1",
            symbol="NVDA",
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("20"),
            order_type="market",
            time_in_force="day",
            params={"price": Decimal("100")},
        )
        positions = [{"symbol": "NVDA", "qty": "5", "market_value": "500"}]

        result = sizer.size(decision, account={"equity": "10000"}, positions=positions)

        self.assertTrue(result.approved)
        self.assertEqual(result.decision.qty, Decimal("5"))

    def test_symbol_capacity_exhaustion_reports_capacity_reason_not_qty_min(
        self,
    ) -> None:
        sizer = PortfolioSizer(
            PortfolioSizingConfig(
                notional_per_position=None,
                volatility_target=None,
                volatility_floor=Decimal("0"),
                max_positions=None,
                max_notional_per_symbol=Decimal("1000"),
                max_position_pct_equity=Decimal("0.10"),
                max_gross_exposure=None,
                max_net_exposure=None,
            )
        )
        decision = StrategyDecision(
            strategy_id="s1",
            symbol="NVDA",
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            order_type="market",
            time_in_force="day",
            params={"price": Decimal("100")},
        )
        positions = [{"symbol": "NVDA", "qty": "15", "market_value": "1500"}]

        result = sizer.size(decision, account={"equity": "10000"}, positions=positions)

        self.assertFalse(result.approved)
        self.assertIn("symbol_capacity_exhausted", result.reasons)
        self.assertNotIn("qty_below_min", result.reasons)
        portfolio_output = result.audit.get("output", {})
        self.assertEqual(portfolio_output.get("status"), "rejected")
        self.assertIn("cap_per_symbol_zero", portfolio_output.get("methods", []))

    def test_symbol_capacity_clip_below_one_share_reports_capacity_reason(self) -> None:
        config.settings.trading_fractional_equities_enabled = False
        sizer = PortfolioSizer(
            PortfolioSizingConfig(
                notional_per_position=None,
                volatility_target=None,
                volatility_floor=Decimal("0"),
                max_positions=None,
                max_notional_per_symbol=Decimal("1000"),
                max_position_pct_equity=None,
                max_gross_exposure=None,
                max_net_exposure=None,
            )
        )
        decision = StrategyDecision(
            strategy_id="s1",
            symbol="NVDA",
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("2"),
            order_type="market",
            time_in_force="day",
            params={"price": Decimal("100")},
        )
        positions = [{"symbol": "NVDA", "qty": "9.5", "market_value": "950"}]

        result = sizer.size(decision, account={"equity": "10000"}, positions=positions)

        self.assertFalse(result.approved)
        self.assertIn("symbol_capacity_exhausted", result.reasons)
        self.assertNotIn("qty_below_min", result.reasons)
        portfolio_output = result.audit.get("output", {})
        self.assertIn("cap_per_symbol", portfolio_output.get("methods", []))
        self.assertEqual(
            portfolio_output.get("limiting_constraint"), "symbol_capacity_exhausted"
        )

    def test_sell_inventory_clip_below_one_share_reports_inventory_reason(self) -> None:
        original_allow_shorts = config.settings.trading_allow_shorts
        config.settings.trading_allow_shorts = False
        config.settings.trading_fractional_equities_enabled = False
        try:
            sizer = PortfolioSizer(
                PortfolioSizingConfig(
                    notional_per_position=None,
                    volatility_target=None,
                    volatility_floor=Decimal("0"),
                    max_positions=None,
                    max_notional_per_symbol=None,
                    max_position_pct_equity=None,
                    max_gross_exposure=None,
                    max_net_exposure=None,
                )
            )
            decision = StrategyDecision(
                strategy_id="s1",
                symbol="NVDA",
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("2"),
                order_type="market",
                time_in_force="day",
                params={"price": Decimal("100")},
            )
            positions = [{"symbol": "NVDA", "qty": "0.5", "market_value": "50"}]

            result = sizer.size(
                decision, account={"equity": "10000"}, positions=positions
            )

            self.assertFalse(result.approved)
            self.assertIn("sell_inventory_unavailable", result.reasons)
            self.assertNotIn("qty_below_min", result.reasons)
            portfolio_output = result.audit.get("output", {})
            self.assertIn("cap_sell_inventory", portfolio_output.get("methods", []))
            self.assertEqual(
                portfolio_output.get("limiting_constraint"),
                "sell_inventory_unavailable",
            )
        finally:
            config.settings.trading_allow_shorts = original_allow_shorts

    def test_allocator_clips_fractional_crypto_qty(self) -> None:
        allocator = PortfolioAllocator(
            AllocationConfig(
                enabled=True,
                default_regime="neutral",
                default_budget_multiplier=Decimal("1.0"),
                default_capacity_multiplier=Decimal("1.0"),
                min_multiplier=Decimal("0"),
                max_multiplier=Decimal("2"),
                max_symbol_pct_equity=Decimal("0.10"),
                max_symbol_notional=None,
                max_gross_exposure=None,
                strategy_notional_caps={},
                symbol_notional_caps={},
                correlation_group_caps={},
                symbol_correlation_groups={},
                regime_budget_multipliers={},
                regime_capacity_multipliers={},
            )
        )
        decision = StrategyDecision(
            strategy_id="s1",
            symbol="BTC/USD",
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("0.10000000"),
            order_type="market",
            time_in_force="day",
            params={"price": Decimal("100000")},
        )
        results = allocator.allocate(
            [decision],
            account={"equity": "10000", "buying_power": "10000", "cash": "10000"},
            positions=[],
            regime_label="neutral",
        )
        self.assertEqual(len(results), 1)
        self.assertTrue(results[0].approved)
        self.assertIn(ALLOCATOR_CLIP_SYMBOL_CAPACITY, results[0].reason_codes)
        self.assertEqual(results[0].decision.qty, Decimal("0.01000000"))

    def test_sell_without_inventory_rejected_when_shorts_disabled(self) -> None:
        original_allow_shorts = config.settings.trading_allow_shorts
        config.settings.trading_allow_shorts = False
        try:
            sizer = PortfolioSizer(
                PortfolioSizingConfig(
                    notional_per_position=None,
                    volatility_target=None,
                    volatility_floor=Decimal("0"),
                    max_positions=None,
                    max_notional_per_symbol=None,
                    max_position_pct_equity=None,
                    max_gross_exposure=None,
                    max_net_exposure=None,
                )
            )
            decision = StrategyDecision(
                strategy_id="s1",
                symbol="NVDA",
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("5"),
                order_type="market",
                time_in_force="day",
                params={"price": Decimal("100")},
            )

            result = sizer.size(decision, account={"equity": "10000"}, positions=[])

            self.assertFalse(result.approved)
            self.assertIn("shorts_not_allowed", result.reasons)
            self.assertEqual(result.decision.qty, Decimal("0"))
        finally:
            config.settings.trading_allow_shorts = original_allow_shorts

    def test_sizer_allows_fractional_equity_buy_when_enabled(self) -> None:
        original_allow_shorts = config.settings.trading_allow_shorts
        config.settings.trading_allow_shorts = False
        config.settings.trading_fractional_equities_enabled = True
        try:
            sizer = PortfolioSizer(
                PortfolioSizingConfig(
                    notional_per_position=None,
                    volatility_target=None,
                    volatility_floor=Decimal("0"),
                    max_positions=None,
                    max_notional_per_symbol=None,
                    max_position_pct_equity=None,
                    max_gross_exposure=None,
                    max_net_exposure=None,
                )
            )
            decision = StrategyDecision(
                strategy_id="s1",
                symbol="NVDA",
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("0.5"),
                order_type="market",
                time_in_force="day",
                params={"price": Decimal("100")},
            )

            result = sizer.size(decision, account={"equity": "10000"}, positions=[])

            self.assertTrue(result.approved)
            self.assertEqual(result.decision.qty, Decimal("0.5"))
        finally:
            config.settings.trading_allow_shorts = original_allow_shorts

    def test_sizer_blocks_fractional_short_increasing_sell_when_enabled(self) -> None:
        original_allow_shorts = config.settings.trading_allow_shorts
        config.settings.trading_allow_shorts = True
        config.settings.trading_fractional_equities_enabled = True
        try:
            sizer = PortfolioSizer(
                PortfolioSizingConfig(
                    notional_per_position=None,
                    volatility_target=None,
                    volatility_floor=Decimal("0"),
                    max_positions=None,
                    max_notional_per_symbol=None,
                    max_position_pct_equity=None,
                    max_gross_exposure=None,
                    max_net_exposure=None,
                )
            )
            decision = StrategyDecision(
                strategy_id="s1",
                symbol="NVDA",
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("0.5"),
                order_type="market",
                time_in_force="day",
                params={"price": Decimal("100")},
            )

            result = sizer.size(decision, account={"equity": "10000"}, positions=[])

            self.assertFalse(result.approved)
            self.assertIn("qty_below_min", result.reasons)
        finally:
            config.settings.trading_allow_shorts = original_allow_shorts

    def test_sizer_allows_fractional_sell_to_reduce_long_when_enabled(self) -> None:
        original_allow_shorts = config.settings.trading_allow_shorts
        config.settings.trading_allow_shorts = True
        config.settings.trading_fractional_equities_enabled = True
        try:
            sizer = PortfolioSizer(
                PortfolioSizingConfig(
                    notional_per_position=None,
                    volatility_target=None,
                    volatility_floor=Decimal("0"),
                    max_positions=None,
                    max_notional_per_symbol=None,
                    max_position_pct_equity=None,
                    max_gross_exposure=None,
                    max_net_exposure=None,
                )
            )
            decision = StrategyDecision(
                strategy_id="s1",
                symbol="NVDA",
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("0.5"),
                order_type="market",
                time_in_force="day",
                params={"price": Decimal("100")},
            )

            result = sizer.size(
                decision,
                account={"equity": "10000"},
                positions=[{"symbol": "NVDA", "qty": "1", "market_value": "100"}],
            )

            self.assertTrue(result.approved)
            self.assertEqual(result.decision.qty, Decimal("0.5"))
        finally:
            config.settings.trading_allow_shorts = original_allow_shorts

    def test_sizer_allows_fractional_sell_after_inventory_clip_when_enabled(
        self,
    ) -> None:
        original_allow_shorts = config.settings.trading_allow_shorts
        config.settings.trading_allow_shorts = False
        config.settings.trading_fractional_equities_enabled = True
        try:
            sizer = PortfolioSizer(
                PortfolioSizingConfig(
                    notional_per_position=None,
                    volatility_target=None,
                    volatility_floor=Decimal("0"),
                    max_positions=None,
                    max_notional_per_symbol=None,
                    max_position_pct_equity=None,
                    max_gross_exposure=None,
                    max_net_exposure=None,
                )
            )
            decision = StrategyDecision(
                strategy_id="s1",
                symbol="NVDA",
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("1"),
                order_type="market",
                time_in_force="day",
                params={"price": Decimal("100")},
            )

            result = sizer.size(
                decision,
                account={"equity": "10000"},
                positions=[{"symbol": "NVDA", "qty": "0.5", "market_value": "50"}],
            )

            self.assertTrue(result.approved)
            self.assertEqual(result.decision.qty, Decimal("0.5000"))
        finally:
            config.settings.trading_allow_shorts = original_allow_shorts

    def test_sell_clipped_to_inventory_when_shorts_disabled(self) -> None:
        original_allow_shorts = config.settings.trading_allow_shorts
        config.settings.trading_allow_shorts = False
        try:
            sizer = PortfolioSizer(
                PortfolioSizingConfig(
                    notional_per_position=None,
                    volatility_target=None,
                    volatility_floor=Decimal("0"),
                    max_positions=None,
                    max_notional_per_symbol=None,
                    max_position_pct_equity=None,
                    max_gross_exposure=None,
                    max_net_exposure=None,
                )
            )
            decision = StrategyDecision(
                strategy_id="s1",
                symbol="NVDA",
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("10"),
                order_type="market",
                time_in_force="day",
                params={"price": Decimal("100")},
            )
            positions = [{"symbol": "NVDA", "qty": "3", "market_value": "300"}]

            result = sizer.size(
                decision, account={"equity": "10000"}, positions=positions
            )

            self.assertTrue(result.approved)
            self.assertEqual(result.decision.qty, Decimal("3"))
        finally:
            config.settings.trading_allow_shorts = original_allow_shorts

    def test_allocator_allows_fractional_sell_after_capacity_clip_when_enabled(
        self,
    ) -> None:
        original_allow_shorts = config.settings.trading_allow_shorts
        config.settings.trading_allow_shorts = False
        config.settings.trading_fractional_equities_enabled = True
        try:
            allocator = PortfolioAllocator(
                AllocationConfig(
                    enabled=True,
                    default_regime="neutral",
                    default_budget_multiplier=Decimal("1.0"),
                    default_capacity_multiplier=Decimal("1.0"),
                    min_multiplier=Decimal("0"),
                    max_multiplier=Decimal("2"),
                    max_symbol_pct_equity=Decimal("0.005"),
                    max_symbol_notional=None,
                    max_gross_exposure=None,
                    strategy_notional_caps={},
                    symbol_notional_caps={},
                    correlation_group_caps={},
                    symbol_correlation_groups={},
                    regime_budget_multipliers={},
                    regime_capacity_multipliers={},
                )
            )
            decision = StrategyDecision(
                strategy_id="s1",
                symbol="NVDA",
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("1"),
                order_type="market",
                time_in_force="day",
                params={"price": Decimal("100")},
            )

            results = allocator.allocate(
                [decision],
                account={"equity": "10000", "buying_power": "10000", "cash": "10000"},
                positions=[{"symbol": "NVDA", "qty": "0.5", "market_value": "50"}],
                regime_label="neutral",
            )

            self.assertEqual(len(results), 1)
            result = results[0]
            self.assertTrue(result.approved)
            self.assertTrue(result.clipped)
            self.assertIn(ALLOCATOR_CLIP_SYMBOL_CAPACITY, result.reason_codes)
            self.assertEqual(result.decision.qty, Decimal("0.5000"))
        finally:
            config.settings.trading_allow_shorts = original_allow_shorts

    def test_portfolio_sizing_cannot_exceed_allocator_approved_notional(self) -> None:
        sizer = PortfolioSizer(
            PortfolioSizingConfig(
                notional_per_position=Decimal("10000"),
                volatility_target=None,
                volatility_floor=Decimal("0"),
                max_positions=None,
                max_notional_per_symbol=None,
                max_position_pct_equity=None,
                max_gross_exposure=None,
                max_net_exposure=None,
            )
        )
        decision = StrategyDecision(
            strategy_id="s1",
            symbol="AAPL",
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            order_type="market",
            time_in_force="day",
            params={
                "price": Decimal("100"),
                "allocator": {
                    "approved_notional": "300",
                    "budget_multiplier": "1.0",
                    "capacity_multiplier": "1.0",
                },
            },
        )
        result = sizer.size(decision, account={"equity": "50000"}, positions=[])
        self.assertTrue(result.approved)
        self.assertEqual(result.decision.qty, Decimal("3"))

    def test_sizer_from_settings_does_not_couple_per_trade_cap_to_symbol_capacity(
        self,
    ) -> None:
        original_max_position_pct_equity = (
            config.settings.trading_max_position_pct_equity
        )
        original_max_notional_per_symbol = (
            config.settings.trading_portfolio_max_notional_per_symbol
        )
        config.settings.trading_max_position_pct_equity = None
        config.settings.trading_portfolio_max_notional_per_symbol = None
        try:
            strategy = Strategy(
                name="intraday-tsmom-profit-v2",
                description="test",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="intraday_tsmom_v1",
                max_notional_per_trade=Decimal("1000"),
                max_position_pct_equity=Decimal("0.08"),
            )
            sizer = sizer_from_settings(strategy, Decimal("31069.96"))
            decision = StrategyDecision(
                strategy_id="s1",
                symbol="GOOG",
                event_ts=datetime(2026, 3, 3, tzinfo=timezone.utc),
                timeframe="1Sec",
                action="buy",
                qty=Decimal("3"),
                order_type="market",
                time_in_force="day",
                params={"price": Decimal("305.400178673442")},
            )

            result = sizer.size(
                decision,
                account={"equity": "31069.96"},
                positions=[{"symbol": "GOOG", "qty": "7", "market_value": "2093"}],
            )

            self.assertTrue(result.approved)
            self.assertGreater(result.decision.qty, Decimal("0"))
            self.assertNotIn("symbol_capacity_exhausted", result.reasons)
        finally:
            config.settings.trading_max_position_pct_equity = (
                original_max_position_pct_equity
            )
            config.settings.trading_portfolio_max_notional_per_symbol = (
                original_max_notional_per_symbol
            )
