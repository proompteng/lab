from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.models import StrategyDecision
from app.trading.simple_risk import prepare_simple_decision


class TestSimpleRisk(TestCase):
    def _decision(
        self,
        *,
        action: str = "buy",
        qty: str = "1",
        price: str = "100",
    ) -> StrategyDecision:
        return StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            timeframe="1Min",
            action=action,  # type: ignore[arg-type]
            qty=Decimal(qty),
            rationale="simple-risk-test",
            params={"price": price},
        )

    def test_quantizes_and_clamps_order_notional(self) -> None:
        result = prepare_simple_decision(
            decision=self._decision(qty="3.75"),
            account={"buying_power": "10000", "equity": "10000", "cash": "10000"},
            positions=[],
            fractional_equities_enabled=True,
            allow_shorts=True,
            max_notional_per_order=Decimal("250"),
            max_notional_per_symbol=None,
        )

        self.assertTrue(result.approved)
        self.assertEqual(result.decision.qty, Decimal("2.5000"))
        self.assertEqual(result.notional, Decimal("250.0000"))

    def test_rejects_when_symbol_exposure_cap_leaves_less_than_min_qty(self) -> None:
        result = prepare_simple_decision(
            decision=self._decision(qty="1"),
            account={"buying_power": "10000", "equity": "10000", "cash": "10000"},
            positions=[{"symbol": "AAPL", "qty": "9", "market_value": "950", "side": "long"}],
            fractional_equities_enabled=False,
            allow_shorts=True,
            max_notional_per_order=None,
            max_notional_per_symbol=Decimal("1000"),
        )

        self.assertFalse(result.approved)
        self.assertEqual(result.reject_reason, "max_symbol_exposure_exceeded")

    def test_rejects_when_buying_power_is_insufficient(self) -> None:
        result = prepare_simple_decision(
            decision=self._decision(qty="5"),
            account={"buying_power": "200", "equity": "10000", "cash": "200"},
            positions=[],
            fractional_equities_enabled=False,
            allow_shorts=True,
            max_notional_per_order=None,
            max_notional_per_symbol=None,
        )

        self.assertFalse(result.approved)
        self.assertEqual(result.reject_reason, "insufficient_buying_power")

    def test_rejects_sub_min_qty_after_quantization(self) -> None:
        result = prepare_simple_decision(
            decision=self._decision(qty="0.2"),
            account={"buying_power": "10000", "equity": "10000", "cash": "10000"},
            positions=[],
            fractional_equities_enabled=False,
            allow_shorts=True,
            max_notional_per_order=None,
            max_notional_per_symbol=None,
        )

        self.assertFalse(result.approved)
        self.assertEqual(result.reject_reason, "qty_below_min_after_clamp")
