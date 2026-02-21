from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from app import config
from app.trading.execution_policy import ExecutionPolicy, ExecutionPolicyConfig
from app.trading.models import StrategyDecision
from app.trading.tca import AdaptiveExecutionPolicyDecision


def _config(**overrides: object) -> ExecutionPolicyConfig:
    base = ExecutionPolicyConfig(
        min_notional=None,
        max_notional=None,
        max_participation_rate=Decimal("0.1"),
        allow_shorts=False,
        kill_switch_enabled=False,
        prefer_limit=False,
        max_retries=0,
        backoff_base_seconds=0.1,
        backoff_multiplier=2.0,
        backoff_max_seconds=1.0,
    )
    return ExecutionPolicyConfig(**{**base.__dict__, **overrides})


def _decision(
    *,
    action: str = "buy",
    qty: Decimal = Decimal("10"),
    price: Decimal | None = Decimal("100"),
    order_type: str = "market",
) -> StrategyDecision:
    return StrategyDecision(
        strategy_id="strategy-1",
        symbol="AAPL",
        event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
        timeframe="1Min",
        action=action,
        qty=qty,
        order_type=order_type,
        time_in_force="day",
        params={"price": price} if price is not None else {},
    )


class TestExecutionPolicy(TestCase):
    def setUp(self) -> None:
        self._advisor_enabled = config.settings.trading_execution_advisor_enabled
        self._advisor_staleness = (
            config.settings.trading_execution_advisor_max_staleness_seconds
        )
        self._advisor_timeout_ms = config.settings.trading_execution_advisor_timeout_ms
        config.settings.trading_execution_advisor_enabled = False
        config.settings.trading_execution_advisor_max_staleness_seconds = 15
        config.settings.trading_execution_advisor_timeout_ms = 250

    def tearDown(self) -> None:
        config.settings.trading_execution_advisor_enabled = self._advisor_enabled
        config.settings.trading_execution_advisor_max_staleness_seconds = (
            self._advisor_staleness
        )
        config.settings.trading_execution_advisor_timeout_ms = self._advisor_timeout_ms

    def test_kill_switch_blocks(self) -> None:
        policy = ExecutionPolicy(config=_config(kill_switch_enabled=True))
        outcome = policy.evaluate(
            _decision(), strategy=None, positions=[], market_snapshot=None
        )
        self.assertFalse(outcome.approved)
        self.assertIn("kill_switch_enabled", outcome.reasons)

    def test_kill_switch_blocks_even_with_allocator_approved_metadata(self) -> None:
        policy = ExecutionPolicy(config=_config(kill_switch_enabled=True))
        decision = _decision()
        decision = decision.model_copy(
            update={
                "params": {
                    "price": Decimal("100"),
                    "allocator": {"status": "approved", "reason_codes": []},
                }
            }
        )
        outcome = policy.evaluate(
            decision, strategy=None, positions=[], market_snapshot=None
        )
        self.assertFalse(outcome.approved)
        self.assertIn("kill_switch_enabled", outcome.reasons)

    def test_shorts_blocked_when_disabled(self) -> None:
        policy = ExecutionPolicy(config=_config(allow_shorts=False))
        outcome = policy.evaluate(
            _decision(action="sell", qty=Decimal("5")),
            strategy=None,
            positions=[],
            market_snapshot=None,
        )
        self.assertFalse(outcome.approved)
        self.assertIn("shorts_not_allowed", outcome.reasons)

    def test_max_notional_enforced(self) -> None:
        policy = ExecutionPolicy(config=_config(max_notional=Decimal("100")))
        outcome = policy.evaluate(
            _decision(qty=Decimal("2"), price=Decimal("75")),
            strategy=None,
            positions=[],
            market_snapshot=None,
        )
        self.assertFalse(outcome.approved)
        self.assertIn("max_notional_exceeded", outcome.reasons)

    def test_min_notional_enforced(self) -> None:
        policy = ExecutionPolicy(config=_config(min_notional=Decimal("250")))
        outcome = policy.evaluate(
            _decision(qty=Decimal("2"), price=Decimal("100")),
            strategy=None,
            positions=[],
            market_snapshot=None,
        )
        self.assertFalse(outcome.approved)
        self.assertIn("min_notional_not_met", outcome.reasons)

    def test_approved_orders_stay_within_caps(self) -> None:
        policy = ExecutionPolicy(
            config=_config(
                max_notional=Decimal("300"),
                max_participation_rate=Decimal("0.25"),
            )
        )
        decision = _decision(qty=Decimal("2"), price=Decimal("100"))
        decision = decision.model_copy(
            update={"params": {"price": Decimal("100"), "adv": Decimal("2000")}}
        )
        outcome = policy.evaluate(
            decision, strategy=None, positions=[], market_snapshot=None
        )
        self.assertTrue(outcome.approved)
        self.assertIsNotNone(outcome.notional)
        self.assertIsNotNone(outcome.participation_rate)
        self.assertLessEqual(outcome.notional or Decimal("0"), Decimal("300"))
        self.assertLessEqual(
            outcome.participation_rate or Decimal("0"), Decimal("0.25")
        )

    def test_participation_cap_enforced(self) -> None:
        policy = ExecutionPolicy(config=_config(max_participation_rate=Decimal("0.1")))
        decision = _decision(qty=Decimal("200"), price=Decimal("10"))
        decision = decision.model_copy(
            update={"params": {"price": Decimal("10"), "adv": Decimal("1000")}}
        )
        outcome = policy.evaluate(
            decision, strategy=None, positions=[], market_snapshot=None
        )
        self.assertFalse(outcome.approved)
        self.assertIn("participation_exceeds_max", outcome.reasons)

    def test_allocator_participation_override_only_tightens(self) -> None:
        policy = ExecutionPolicy(config=_config(max_participation_rate=Decimal("0.5")))
        decision = _decision(qty=Decimal("200"), price=Decimal("10"))
        decision = decision.model_copy(
            update={
                "params": {
                    "price": Decimal("10"),
                    "adv": Decimal("1000"),
                    "allocator": {"max_participation_rate_override": "0.1"},
                }
            }
        )
        outcome = policy.evaluate(
            decision, strategy=None, positions=[], market_snapshot=None
        )
        self.assertFalse(outcome.approved)
        self.assertIn("participation_exceeds_max", outcome.reasons)

    def test_sell_to_reduce_long_position_allowed_with_no_shorts(self) -> None:
        policy = ExecutionPolicy(config=_config(allow_shorts=False))
        outcome = policy.evaluate(
            _decision(action="sell", qty=Decimal("2")),
            strategy=None,
            positions=[{"symbol": "AAPL", "qty": "5", "side": "long"}],
            market_snapshot=None,
        )
        self.assertTrue(outcome.approved)
        self.assertNotIn("shorts_not_allowed", outcome.reasons)

    def test_shorts_allowed_when_enabled(self) -> None:
        policy = ExecutionPolicy(config=_config(allow_shorts=True))
        outcome = policy.evaluate(
            _decision(action="sell", qty=Decimal("2")),
            strategy=None,
            positions=[],
            market_snapshot=None,
        )
        self.assertTrue(outcome.approved)
        self.assertNotIn("shorts_not_allowed", outcome.reasons)

    def test_retry_backoff_schedule_sanitized_and_capped(self) -> None:
        policy = ExecutionPolicy(
            config=_config(
                max_retries=4,
                backoff_base_seconds=-1.0,
                backoff_multiplier=0.5,
                backoff_max_seconds=0.25,
            )
        )
        outcome = policy.evaluate(
            _decision(), strategy=None, positions=[], market_snapshot=None
        )
        self.assertEqual(outcome.retry_delays, [0.1, 0.1, 0.1, 0.1])

    def test_impact_assumptions_recorded(self) -> None:
        policy = ExecutionPolicy(config=_config(prefer_limit=True))
        outcome = policy.evaluate(
            _decision(qty=Decimal("1"), price=Decimal("25")),
            strategy=None,
            positions=[],
            market_snapshot=None,
        )
        assumptions = outcome.impact_assumptions
        self.assertIn("model", assumptions)
        self.assertIn("inputs", assumptions)
        self.assertIn("estimate", assumptions)
        self.assertEqual(outcome.decision.order_type, "limit")

    def test_near_touch_prices_are_quantized_to_tick_size(self) -> None:
        policy = ExecutionPolicy(config=_config(prefer_limit=True))
        decision = _decision(
            action="buy",
            qty=Decimal("1"),
            price=Decimal("635.815"),
            order_type="market",
        )
        outcome = policy.evaluate(
            decision,
            strategy=None,
            positions=[],
            market_snapshot=None,
        )
        self.assertEqual(outcome.decision.order_type, "limit")
        self.assertEqual(outcome.decision.limit_price, Decimal("635.82"))

    def test_limit_and_stop_prices_are_quantized(self) -> None:
        decision = _decision(
            action="sell",
            qty=Decimal("10"),
            order_type="limit",
            price=Decimal("120.1234"),
        )
        decision = decision.model_copy(
            update={
                "params": {
                    "price": Decimal("120.1234"),
                    "limit_price": Decimal("120.1234"),
                    "spread": Decimal("0.020"),
                }
            }
        )
        policy = ExecutionPolicy(config=_config(prefer_limit=False))
        outcome = policy.evaluate(
            decision,
            strategy=None,
            positions=[],
            market_snapshot=None,
        )
        self.assertEqual(outcome.decision.order_type, "limit")
        self.assertEqual(outcome.decision.limit_price, Decimal("120.12"))

    def test_advisor_tightens_participation_and_order_type_only(self) -> None:
        config.settings.trading_execution_advisor_enabled = True
        policy = ExecutionPolicy(config=_config(max_participation_rate=Decimal("0.25")))
        decision = _decision(
            qty=Decimal("10"), price=Decimal("100"), order_type="market"
        )
        decision = decision.model_copy(
            update={
                "params": {
                    "price": Decimal("100"),
                    "adv": Decimal("100000"),
                    "microstructure_state": {
                        "schema_version": "microstructure_state_v1",
                        "symbol": "AAPL",
                        "event_ts": "2026-01-01T00:00:00Z",
                        "spread_bps": "3.2",
                        "depth_top5_usd": "1500000",
                        "order_flow_imbalance": "0.10",
                        "latency_ms_estimate": 20,
                        "fill_hazard": "0.8",
                        "liquidity_regime": "normal",
                    },
                    "execution_advice": {
                        "urgency_tier": "normal",
                        "max_participation_rate": "0.05",
                        "preferred_order_type": "limit",
                        "adverse_selection_risk": "0.20",
                    },
                }
            }
        )
        outcome = policy.evaluate(
            decision, strategy=None, positions=[], market_snapshot=None
        )
        self.assertTrue(outcome.approved)
        self.assertEqual(outcome.decision.order_type, "limit")
        self.assertEqual(outcome.advisor_metadata["applied"], True)
        self.assertEqual(outcome.advisor_metadata["max_participation_rate"], "0.05")

    def test_advisor_timeout_falls_back_to_baseline(self) -> None:
        config.settings.trading_execution_advisor_enabled = True
        config.settings.trading_execution_advisor_timeout_ms = 10
        policy = ExecutionPolicy(config=_config(max_participation_rate=Decimal("0.25")))
        decision = _decision(
            qty=Decimal("10"), price=Decimal("100"), order_type="market"
        )
        decision = decision.model_copy(
            update={
                "params": {
                    "price": Decimal("100"),
                    "microstructure_state": {
                        "schema_version": "microstructure_state_v1",
                        "symbol": "AAPL",
                        "event_ts": "2026-01-01T00:00:00Z",
                        "spread_bps": "3.2",
                        "depth_top5_usd": "1500000",
                        "order_flow_imbalance": "0.10",
                        "latency_ms_estimate": 20,
                        "fill_hazard": "0.8",
                        "liquidity_regime": "normal",
                    },
                    "execution_advice": {
                        "urgency_tier": "normal",
                        "latency_ms": 50,
                        "max_participation_rate": "0.01",
                        "preferred_order_type": "limit",
                    },
                }
            }
        )
        outcome = policy.evaluate(
            decision, strategy=None, positions=[], market_snapshot=None
        )
        self.assertEqual(outcome.advisor_metadata["applied"], False)
        self.assertEqual(outcome.advisor_metadata["fallback_reason"], "advisor_timeout")
