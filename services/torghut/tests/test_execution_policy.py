from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.execution_policy import ExecutionPolicy, ExecutionPolicyConfig
from app.trading.models import StrategyDecision


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
    def test_kill_switch_blocks(self) -> None:
        policy = ExecutionPolicy(config=_config(kill_switch_enabled=True))
        outcome = policy.evaluate(_decision(), strategy=None, positions=[], market_snapshot=None)
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

    def test_approved_orders_stay_within_caps(self) -> None:
        policy = ExecutionPolicy(
            config=_config(
                max_notional=Decimal("300"),
                max_participation_rate=Decimal("0.25"),
            )
        )
        decision = _decision(qty=Decimal("2"), price=Decimal("100"))
        decision = decision.model_copy(update={"params": {"price": Decimal("100"), "adv": Decimal("2000")}})
        outcome = policy.evaluate(decision, strategy=None, positions=[], market_snapshot=None)
        self.assertTrue(outcome.approved)
        self.assertIsNotNone(outcome.notional)
        self.assertIsNotNone(outcome.participation_rate)
        self.assertLessEqual(outcome.notional or Decimal("0"), Decimal("300"))
        self.assertLessEqual(outcome.participation_rate or Decimal("0"), Decimal("0.25"))

    def test_participation_cap_enforced(self) -> None:
        policy = ExecutionPolicy(config=_config(max_participation_rate=Decimal("0.1")))
        decision = _decision(qty=Decimal("200"), price=Decimal("10"))
        decision = decision.model_copy(update={"params": {"price": Decimal("10"), "adv": Decimal("1000")}})
        outcome = policy.evaluate(decision, strategy=None, positions=[], market_snapshot=None)
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

    def test_retry_backoff_schedule_sanitized_and_capped(self) -> None:
        policy = ExecutionPolicy(
            config=_config(
                max_retries=4,
                backoff_base_seconds=-1.0,
                backoff_multiplier=0.5,
                backoff_max_seconds=0.25,
            )
        )
        outcome = policy.evaluate(_decision(), strategy=None, positions=[], market_snapshot=None)
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
