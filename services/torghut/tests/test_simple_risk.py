from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.models import StrategyDecision
from app.trading.simple_risk import (
    _buying_power_required_notional,
    prepare_simple_decision,
)


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

    def test_price_snapshot_drives_notional_when_signal_price_is_stale(self) -> None:
        decision = self._decision(
            action="sell", qty="2.4232", price="412.6704331378219"
        )
        decision = decision.model_copy(
            update={
                "params": {
                    "price": "412.6704331378219",
                    "price_snapshot": {
                        "price": "316.93",
                        "source": "ta_microbars",
                        "as_of": "2026-03-31T13:38:20+00:00",
                    },
                }
            }
        )

        result = prepare_simple_decision(
            decision=decision,
            account={"buying_power": "10000", "equity": "10000", "cash": "10000"},
            positions=[{"symbol": "AAPL", "qty": "3.1488", "side": "long"}],
            fractional_equities_enabled=True,
            allow_shorts=True,
            max_notional_per_order=None,
            max_notional_per_symbol=None,
        )

        self.assertTrue(result.approved)
        self.assertEqual(result.notional, Decimal("767.984776"))
        self.assertEqual(result.diagnostics["price"], "316.93")
        self.assertEqual(result.decision.params["simple_lane"]["price"], "316.93")

    def test_rejects_when_symbol_exposure_cap_leaves_less_than_min_qty(self) -> None:
        result = prepare_simple_decision(
            decision=self._decision(qty="1"),
            account={"buying_power": "10000", "equity": "10000", "cash": "10000"},
            positions=[
                {"symbol": "AAPL", "qty": "9", "market_value": "950", "side": "long"}
            ],
            fractional_equities_enabled=False,
            allow_shorts=True,
            max_notional_per_order=None,
            max_notional_per_symbol=Decimal("1000"),
        )

        self.assertFalse(result.approved)
        self.assertEqual(result.reject_reason, "max_symbol_exposure_exceeded")

    def test_caps_to_buying_power_when_order_can_be_reduced(self) -> None:
        result = prepare_simple_decision(
            decision=self._decision(qty="5"),
            account={"buying_power": "200", "equity": "10000", "cash": "200"},
            positions=[],
            fractional_equities_enabled=False,
            allow_shorts=True,
            max_notional_per_order=None,
            max_notional_per_symbol=None,
        )

        self.assertTrue(result.approved)
        self.assertEqual(result.decision.qty, Decimal("2"))
        self.assertEqual(result.notional, Decimal("200"))
        self.assertEqual(result.diagnostics["buying_power_cap_qty"], "2")
        self.assertEqual(result.diagnostics["final_qty"], "2")
        self.assertTrue(result.decision.params["simple_lane"]["capped_by_buying_power"])

    def test_buying_power_reserve_keeps_capped_order_below_available_cash(self) -> None:
        result = prepare_simple_decision(
            decision=self._decision(qty="120.7481", price="414.085"),
            account={"buying_power": "373.80", "equity": "10000", "cash": "373.80"},
            positions=[],
            fractional_equities_enabled=True,
            allow_shorts=True,
            max_notional_per_order=None,
            max_notional_per_symbol=None,
            buying_power_reserve_bps=Decimal("25"),
        )

        self.assertTrue(result.approved)
        self.assertTrue(result.decision.params["simple_lane"]["capped_by_buying_power"])
        self.assertLess(result.decision.qty, Decimal("0.9027"))
        self.assertEqual(result.diagnostics["buying_power_reserve_bps"], "25")
        self.assertEqual(result.diagnostics["buying_power_after_reserve"], "372.865500")
        self.assertLessEqual(
            Decimal(result.diagnostics["buying_power_required_notional"]),
            Decimal(result.diagnostics["buying_power_after_reserve"]),
        )

    def test_rejects_when_buying_power_cap_leaves_less_than_min_qty(self) -> None:
        result = prepare_simple_decision(
            decision=self._decision(qty="5"),
            account={"buying_power": "50", "equity": "10000", "cash": "50"},
            positions=[],
            fractional_equities_enabled=False,
            allow_shorts=True,
            max_notional_per_order=None,
            max_notional_per_symbol=None,
        )

        self.assertFalse(result.approved)
        self.assertEqual(result.reject_reason, "insufficient_buying_power")

    def test_rejects_when_buying_power_is_zero(self) -> None:
        result = prepare_simple_decision(
            decision=self._decision(qty="5"),
            account={"buying_power": "0", "equity": "10000", "cash": "0"},
            positions=[],
            fractional_equities_enabled=False,
            allow_shorts=True,
            max_notional_per_order=None,
            max_notional_per_symbol=None,
        )

        self.assertFalse(result.approved)
        self.assertEqual(result.reject_reason, "insufficient_buying_power")
        self.assertEqual(result.diagnostics["buying_power_cap_qty"], "0")

    def test_short_increase_buying_power_cap_counts_only_excess_qty(self) -> None:
        result = prepare_simple_decision(
            decision=self._decision(action="sell", qty="5", price="100"),
            account={"buying_power": "200", "equity": "10000", "cash": "200"},
            positions=[{"symbol": "AAPL", "qty": "2", "side": "long"}],
            fractional_equities_enabled=False,
            allow_shorts=True,
            max_notional_per_order=None,
            max_notional_per_symbol=None,
        )

        self.assertTrue(result.approved)
        self.assertEqual(result.decision.qty, Decimal("4"))
        self.assertEqual(result.notional, Decimal("400"))
        self.assertEqual(result.diagnostics["buying_power_cap_qty"], "4")
        self.assertEqual(result.diagnostics["buying_power_required_notional"], "200")
        self.assertTrue(result.decision.params["simple_lane"]["capped_by_buying_power"])

    def test_rejects_short_increase_when_shorts_are_disabled(self) -> None:
        result = prepare_simple_decision(
            decision=self._decision(action="sell", qty="2", price="100"),
            account={"buying_power": "10000", "equity": "10000", "cash": "10000"},
            positions=[{"symbol": "AAPL", "qty": "1", "side": "long"}],
            fractional_equities_enabled=False,
            allow_shorts=False,
            max_notional_per_order=None,
            max_notional_per_symbol=None,
        )

        self.assertFalse(result.approved)
        self.assertEqual(result.reject_reason, "shorting_not_allowed_for_asset")

    def test_buying_power_required_notional_ignores_non_increasing_exposure(
        self,
    ) -> None:
        zero_qty_sell = self._decision(action="sell", qty="0", price="100")
        reducing_sell = self._decision(action="sell", qty="1", price="100")

        self.assertEqual(
            _buying_power_required_notional(
                decision=zero_qty_sell,
                qty=Decimal("0"),
                price=Decimal("100"),
                current_qty=Decimal("0"),
            ),
            Decimal("0"),
        )
        self.assertEqual(
            _buying_power_required_notional(
                decision=reducing_sell,
                qty=Decimal("1"),
                price=Decimal("100"),
                current_qty=Decimal("2"),
            ),
            Decimal("0"),
        )

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

    def test_target_sizing_rejects_missing_expectancy_before_order_clamp(self) -> None:
        decision = self._decision(qty="1")
        decision = decision.model_copy(
            update={
                "params": {
                    "price": "100",
                    "target_sizing": {
                        "capacity_daily_notional": "1000000",
                        "drawdown_budget": "1000",
                    },
                }
            }
        )

        result = prepare_simple_decision(
            decision=decision,
            account={"buying_power": "10000", "equity": "10000", "cash": "10000"},
            positions=[],
            fractional_equities_enabled=False,
            allow_shorts=True,
            max_notional_per_order=None,
            max_notional_per_symbol=None,
        )

        self.assertFalse(result.approved)
        self.assertEqual(result.reject_reason, "target_sizing_blocked")
        self.assertIn(
            "observed_post_cost_expectancy_bps_missing",
            result.diagnostics["target_sizing"]["blocking_reasons"],
        )
