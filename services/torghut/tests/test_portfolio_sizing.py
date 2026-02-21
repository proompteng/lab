from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from app import config
from app.trading.models import StrategyDecision
from app.trading.portfolio import (
    ALLOCATOR_CLIP_CORRELATION_CAPACITY,
    ALLOCATOR_CLIP_SYMBOL_CAPACITY,
    ALLOCATOR_CLIP_SYMBOL_BUDGET,
    ALLOCATOR_CLIP_STRATEGY_BUDGET,
    ALLOCATOR_REJECT_CORRELATION_CAPACITY,
    ALLOCATOR_REJECT_SYMBOL_CAPACITY,
    AllocationConfig,
    IntentAggregator,
    PortfolioAllocator,
    PortfolioSizingConfig,
    PortfolioSizer,
    allocator_from_settings,
)


class TestPortfolioSizing(TestCase):
    def test_intent_aggregator_merges_conflicting_intents_deterministically(
        self,
    ) -> None:
        aggregator = IntentAggregator()
        decisions = [
            StrategyDecision(
                strategy_id="s2",
                symbol="AAPL",
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("3"),
                order_type="market",
                time_in_force="day",
                params={"price": Decimal("100")},
            ),
            StrategyDecision(
                strategy_id="s1",
                symbol="AAPL",
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("10"),
                order_type="market",
                time_in_force="day",
                params={"price": Decimal("100")},
            ),
        ]

        aggregated = aggregator.aggregate(decisions)

        self.assertEqual(len(aggregated), 1)
        self.assertEqual(aggregated[0].decision.action, "buy")
        self.assertEqual(aggregated[0].decision.qty, Decimal("7"))
        self.assertTrue(aggregated[0].had_conflict)

    def test_allocator_clips_symbol_concentration_and_records_reason(self) -> None:
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
            symbol="AAPL",
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("20"),
            order_type="market",
            time_in_force="day",
            params={"price": Decimal("100")},
        )

        results = allocator.allocate(
            [decision],
            account={"equity": "10000", "buying_power": "10000", "cash": "10000"},
            positions=[],
            regime_label="neutral",
        )

        self.assertEqual(len(results), 1)
        result = results[0]
        self.assertTrue(result.approved)
        self.assertTrue(result.clipped)
        self.assertIn(ALLOCATOR_CLIP_SYMBOL_CAPACITY, result.reason_codes)
        self.assertEqual(result.decision.qty, Decimal("10"))

    def test_allocator_regime_multiplier_can_force_reject(self) -> None:
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
                regime_budget_multipliers={
                    "vol=high|trend=flat|liq=liquid": Decimal("0.0")
                },
                regime_capacity_multipliers={},
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
            params={"price": Decimal("100")},
        )

        results = allocator.allocate(
            [decision],
            account={"equity": "10000", "buying_power": "10000", "cash": "10000"},
            positions=[],
            regime_label="vol=high|trend=flat|liq=liquid",
        )

        self.assertEqual(len(results), 1)
        result = results[0]
        self.assertFalse(result.approved)
        self.assertIn(ALLOCATOR_REJECT_SYMBOL_CAPACITY, result.reason_codes)
        self.assertEqual(result.decision.qty, Decimal("0"))

    def test_allocator_clips_by_strategy_budget(self) -> None:
        allocator = PortfolioAllocator(
            AllocationConfig(
                enabled=True,
                default_regime="neutral",
                default_budget_multiplier=Decimal("1.0"),
                default_capacity_multiplier=Decimal("1.0"),
                min_multiplier=Decimal("0"),
                max_multiplier=Decimal("2"),
                max_symbol_pct_equity=None,
                max_symbol_notional=None,
                max_gross_exposure=None,
                strategy_notional_caps={"s1": Decimal("200"), "s2": Decimal("400")},
                symbol_notional_caps={},
                correlation_group_caps={},
                symbol_correlation_groups={},
                regime_budget_multipliers={},
                regime_capacity_multipliers={},
            )
        )
        decisions = [
            StrategyDecision(
                strategy_id="s1",
                symbol="AAPL",
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("3"),
                order_type="market",
                time_in_force="day",
                params={"price": Decimal("100")},
            ),
            StrategyDecision(
                strategy_id="s2",
                symbol="AAPL",
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("3"),
                order_type="market",
                time_in_force="day",
                params={"price": Decimal("100")},
            ),
        ]

        results = allocator.allocate(
            decisions,
            account={"equity": "10000", "buying_power": "10000", "cash": "10000"},
            positions=[],
            regime_label="neutral",
        )

        self.assertEqual(len(results), 1)
        self.assertTrue(results[0].approved)
        self.assertTrue(results[0].clipped)
        self.assertIn(ALLOCATOR_CLIP_STRATEGY_BUDGET, results[0].reason_codes)
        self.assertEqual(results[0].decision.qty, Decimal("4"))

    def test_allocator_clips_by_symbol_budget(self) -> None:
        allocator = PortfolioAllocator(
            AllocationConfig(
                enabled=True,
                default_regime="neutral",
                default_budget_multiplier=Decimal("1.0"),
                default_capacity_multiplier=Decimal("1.0"),
                min_multiplier=Decimal("0"),
                max_multiplier=Decimal("2"),
                max_symbol_pct_equity=None,
                max_symbol_notional=None,
                max_gross_exposure=None,
                strategy_notional_caps={},
                symbol_notional_caps={"AAPL": Decimal("500")},
                correlation_group_caps={},
                symbol_correlation_groups={},
                regime_budget_multipliers={},
                regime_capacity_multipliers={},
            )
        )
        decision = StrategyDecision(
            strategy_id="s1",
            symbol="AAPL",
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("7"),
            order_type="market",
            time_in_force="day",
            params={"price": Decimal("100")},
        )
        results = allocator.allocate(
            [decision],
            account={"equity": "10000", "buying_power": "10000", "cash": "10000"},
            positions=[],
            regime_label="neutral",
        )
        self.assertEqual(len(results), 1)
        self.assertTrue(results[0].approved)
        self.assertIn(ALLOCATOR_CLIP_SYMBOL_BUDGET, results[0].reason_codes)
        self.assertEqual(results[0].decision.qty, Decimal("5"))

    def test_allocator_rejects_when_correlation_budget_depleted(self) -> None:
        allocator = PortfolioAllocator(
            AllocationConfig(
                enabled=True,
                default_regime="neutral",
                default_budget_multiplier=Decimal("1.0"),
                default_capacity_multiplier=Decimal("1.0"),
                min_multiplier=Decimal("0"),
                max_multiplier=Decimal("2"),
                max_symbol_pct_equity=None,
                max_symbol_notional=None,
                max_gross_exposure=None,
                strategy_notional_caps={},
                symbol_notional_caps={},
                correlation_group_caps={"tech": Decimal("500")},
                symbol_correlation_groups={"AAPL": "tech"},
                regime_budget_multipliers={},
                regime_capacity_multipliers={},
            )
        )
        decisions = [
            StrategyDecision(
                strategy_id="s1",
                symbol="AAPL",
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("6"),
                order_type="market",
                time_in_force="day",
                params={"price": Decimal("100")},
            ),
            StrategyDecision(
                strategy_id="s2",
                symbol="MSFT",
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("1"),
                order_type="market",
                time_in_force="day",
                params={"price": Decimal("100"), "correlation_group": "tech"},
            ),
        ]

        results = allocator.allocate(
            decisions,
            account={"equity": "10000", "buying_power": "10000", "cash": "10000"},
            positions=[],
            regime_label="neutral",
        )

        self.assertEqual(len(results), 2)
        approved = next(result for result in results if result.decision.symbol == "AAPL")
        rejected = next(result for result in results if result.decision.symbol == "MSFT")
        self.assertTrue(approved.approved)
        self.assertIn(ALLOCATOR_CLIP_CORRELATION_CAPACITY, approved.reason_codes)
        self.assertEqual(approved.decision.qty, Decimal("5"))
        self.assertFalse(rejected.approved)
        self.assertIn(ALLOCATOR_REJECT_CORRELATION_CAPACITY, rejected.reason_codes)
        self.assertEqual(rejected.decision.qty, Decimal("0"))

    def test_disabled_allocator_metadata_does_not_apply_regime_multiplier(self) -> None:
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
                    "enabled": False,
                    "status": "approved",
                    "budget_multiplier": "0.5",
                    "capacity_multiplier": "0.5",
                    "approved_notional": "1000",
                },
            },
        )
        result = sizer.size(decision, account={"equity": "50000"}, positions=[])
        self.assertTrue(result.approved)
        self.assertEqual(result.decision.qty, Decimal("10"))
        self.assertNotIn("allocator_regime_multiplier", result.audit["output"]["methods"])

    def test_allocator_from_settings_consumes_normalized_correlation_maps(self) -> None:
        original_values = {
            "trading_allocator_correlation_group_caps": dict(
                config.settings.trading_allocator_correlation_group_caps
            ),
            "trading_allocator_correlation_group_notional_caps": dict(
                config.settings.trading_allocator_correlation_group_notional_caps
            ),
            "trading_allocator_symbol_correlation_groups": dict(
                config.settings.trading_allocator_symbol_correlation_groups
            ),
            "trading_allocator_correlation_symbol_groups": dict(
                config.settings.trading_allocator_correlation_symbol_groups
            ),
        }
        try:
            config.settings.trading_allocator_correlation_group_caps = {"legacy": 111.0}
            config.settings.trading_allocator_correlation_group_notional_caps = {
                " Tech ": 3000.0
            }
            config.settings.trading_allocator_symbol_correlation_groups = {
                "MSFT": "legacy"
            }
            config.settings.trading_allocator_correlation_symbol_groups = {
                " aapl ": " MegaCap "
            }

            allocator = allocator_from_settings(Decimal("10000"))

            self.assertEqual(
                allocator.config.correlation_group_caps.get("tech"), Decimal("3000.0")
            )
            self.assertEqual(
                allocator.config.symbol_correlation_groups.get("AAPL"), "megacap"
            )
        finally:
            config.settings.trading_allocator_correlation_group_caps = original_values[
                "trading_allocator_correlation_group_caps"
            ]
            config.settings.trading_allocator_correlation_group_notional_caps = (
                original_values["trading_allocator_correlation_group_notional_caps"]
            )
            config.settings.trading_allocator_symbol_correlation_groups = original_values[
                "trading_allocator_symbol_correlation_groups"
            ]
            config.settings.trading_allocator_correlation_symbol_groups = original_values[
                "trading_allocator_correlation_symbol_groups"
            ]

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

            result = sizer.size(decision, account={"equity": "10000"}, positions=positions)

            self.assertTrue(result.approved)
            self.assertEqual(result.decision.qty, Decimal("3"))
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
