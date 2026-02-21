from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

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

    def test_adaptive_policy_tightens_participation_and_prefers_limit(self) -> None:
        policy = ExecutionPolicy(
            config=_config(
                prefer_limit=False,
                max_participation_rate=Decimal("0.2"),
            )
        )
        adaptive = AdaptiveExecutionPolicyDecision(
            key="AAPL:trend",
            symbol="AAPL",
            regime_label="trend",
            sample_size=8,
            adaptive_samples=4,
            baseline_slippage_bps=Decimal("10"),
            recent_slippage_bps=Decimal("22"),
            baseline_shortfall_notional=Decimal("2"),
            recent_shortfall_notional=Decimal("8"),
            effect_size_bps=Decimal("-12"),
            degradation_bps=Decimal("12"),
            fallback_active=False,
            fallback_reason=None,
            prefer_limit=True,
            participation_rate_scale=Decimal("0.5"),
            execution_seconds_scale=Decimal("1.4"),
            aggressiveness="defensive",
            generated_at=datetime(2026, 1, 2, tzinfo=timezone.utc),
        )
        decision = _decision(order_type="market")
        decision = decision.model_copy(
            update={"params": {"price": Decimal("100"), "adv": Decimal("1000")}}
        )
        outcome = policy.evaluate(
            decision,
            strategy=None,
            positions=[],
            market_snapshot=None,
            adaptive_policy=adaptive,
        )
        self.assertEqual(outcome.decision.order_type, "limit")
        self.assertEqual(outcome.adaptive is not None, True)
        assert outcome.adaptive is not None
        self.assertTrue(outcome.adaptive.applied)
        self.assertLessEqual(
            Decimal(outcome.impact_assumptions["model"]["max_participation_rate"]),
            Decimal("0.2"),
        )

    def test_adaptive_policy_fallback_disables_override(self) -> None:
        policy = ExecutionPolicy(config=_config(prefer_limit=False))
        adaptive = AdaptiveExecutionPolicyDecision(
            key="AAPL:all",
            symbol="AAPL",
            regime_label="all",
            sample_size=12,
            adaptive_samples=8,
            baseline_slippage_bps=Decimal("8"),
            recent_slippage_bps=Decimal("16"),
            baseline_shortfall_notional=Decimal("1"),
            recent_shortfall_notional=Decimal("4"),
            effect_size_bps=Decimal("-8"),
            degradation_bps=Decimal("8"),
            fallback_active=True,
            fallback_reason="adaptive_policy_degraded",
            prefer_limit=True,
            participation_rate_scale=Decimal("0.75"),
            execution_seconds_scale=Decimal("1.2"),
            aggressiveness="defensive",
            generated_at=datetime(2026, 1, 2, tzinfo=timezone.utc),
        )
        outcome = policy.evaluate(
            _decision(order_type="market"),
            strategy=None,
            positions=[],
            market_snapshot=None,
            adaptive_policy=adaptive,
        )
        self.assertEqual(outcome.decision.order_type, "market")
        assert outcome.adaptive is not None
        self.assertFalse(outcome.adaptive.applied)
        self.assertEqual(outcome.adaptive.reason, "adaptive_policy_degraded")
