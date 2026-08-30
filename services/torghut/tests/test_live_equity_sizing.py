from __future__ import annotations

from decimal import Decimal
from unittest import TestCase
from unittest.mock import patch

from app.config import settings
from app.models import Strategy
from app.trading.decisions.positions_for_strategy_action import (
    resolve_aggregated_notional_budget,
)
from app.trading.decisions.single_strategy_qty import single_strategy_budget


def _strategy(name: str, *, max_notional: str, max_position_pct: str) -> Strategy:
    return Strategy(
        name=name,
        enabled=True,
        base_timeframe="1Sec",
        universe_type="static",
        universe_symbols=["NVDA"],
        max_notional_per_trade=Decimal(max_notional),
        max_position_pct_equity=Decimal(max_position_pct),
    )


class TestLiveEquitySizing(TestCase):
    def test_live_single_strategy_ignores_fixed_notional(self) -> None:
        strategy = _strategy(
            "live-equity-sized",
            max_notional="100",
            max_position_pct="2",
        )

        with (
            patch.object(settings, "trading_mode", "live"),
            patch.object(settings, "trading_simple_max_symbol_pct_equity", 0.5),
        ):
            budget = single_strategy_budget(
                strategy=strategy,
                equity=Decimal("10000"),
            )

        self.assertEqual(budget.notional_budget, Decimal("5000.0"))
        self.assertEqual(budget.method, "live_equity_pct")

    def test_live_aggregated_sizing_ignores_collection_targets(self) -> None:
        strategies = [
            _strategy("first", max_notional="10", max_position_pct="2"),
            _strategy("second", max_notional="20", max_position_pct="3"),
        ]

        with (
            patch.object(settings, "trading_mode", "live"),
            patch.object(settings, "trading_simple_max_symbol_pct_equity", 0.5),
        ):
            budget = resolve_aggregated_notional_budget(
                strategies,
                equity=Decimal("10000"),
            )

        self.assertEqual(budget, Decimal("5000.0"))

    def test_paper_replay_retains_fixed_notional_contract(self) -> None:
        strategy = _strategy(
            "paper-replay",
            max_notional="100",
            max_position_pct="2",
        )

        with patch.object(settings, "trading_mode", "paper"):
            budget = single_strategy_budget(
                strategy=strategy,
                equity=Decimal("10000"),
            )

        self.assertEqual(budget.notional_budget, Decimal("100"))
        self.assertEqual(budget.method, "min(max_notional,pct_equity)")
