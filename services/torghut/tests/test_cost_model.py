from __future__ import annotations

from decimal import Decimal
from unittest import TestCase

from app.trading.backtest import BacktestTrade, evaluate_trades
from app.trading.costs import CostModelConfig, CostModelInputs, OrderIntent, TransactionCostModel


class TestTransactionCostModel(TestCase):
    def test_cost_components_sum(self) -> None:
        model = TransactionCostModel(
            CostModelConfig(
                commission_bps=Decimal("2"),
                commission_per_share=Decimal("0"),
                min_commission=Decimal("0"),
                max_participation_rate=Decimal("0.5"),
                impact_bps_at_full_participation=Decimal("20"),
            )
        )
        order = OrderIntent(
            symbol="AAPL",
            side="buy",
            qty=Decimal("10"),
            price=Decimal("100"),
            order_type="market",
        )
        market = CostModelInputs(
            price=Decimal("100"),
            spread=Decimal("0.20"),
            volatility=Decimal("0.001"),
            adv=Decimal("100000"),
            execution_seconds=60,
        )
        estimate = model.estimate_costs(order, market)

        self.assertGreater(estimate.spread_cost_bps, Decimal("0"))
        self.assertGreater(estimate.volatility_cost_bps, Decimal("0"))
        self.assertGreater(estimate.impact_cost_bps, Decimal("0"))
        self.assertEqual(
            estimate.total_cost_bps,
            estimate.spread_cost_bps
            + estimate.volatility_cost_bps
            + estimate.impact_cost_bps
            + estimate.commission_cost_bps,
        )
        self.assertEqual(estimate.total_cost, (estimate.notional * estimate.total_cost_bps) / Decimal("10000"))

    def test_capacity_warning_on_high_participation(self) -> None:
        model = TransactionCostModel(CostModelConfig(max_participation_rate=Decimal("0.05")))
        order = OrderIntent(
            symbol="AAPL",
            side="buy",
            qty=Decimal("1000"),
            price=Decimal("10"),
            order_type="market",
        )
        market = CostModelInputs(price=Decimal("10"), adv=Decimal("100000"))
        estimate = model.estimate_costs(order, market)

        self.assertFalse(estimate.capacity_ok)
        self.assertIn("participation_exceeds_max", estimate.warnings)


class TestBacktestEvaluation(TestCase):
    def test_backtest_outputs_include_gross_and_net_pnl(self) -> None:
        model = TransactionCostModel(CostModelConfig(commission_bps=Decimal("0")))
        trade = BacktestTrade(
            symbol="AAPL",
            side="long",
            qty=Decimal("1"),
            entry=CostModelInputs(price=Decimal("100"), spread=Decimal("0")),
            exit=CostModelInputs(price=Decimal("110"), spread=Decimal("0")),
        )

        result = evaluate_trades([trade], model)

        self.assertEqual(result.gross_pnl, Decimal("10"))
        self.assertEqual(result.net_pnl, Decimal("10"))
        self.assertEqual(result.trade_count, 1)
