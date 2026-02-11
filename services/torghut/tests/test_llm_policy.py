from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from app import config
from app.trading.llm.policy import apply_policy
from app.trading.llm.schema import LLMReviewResponse
from app.trading.models import StrategyDecision


class TestLLMPolicy(TestCase):
    def test_adjust_to_limit_requires_limit_price(self) -> None:
        original = {
            "llm_adjustment_allowed": config.settings.llm_adjustment_allowed,
            "llm_min_confidence": config.settings.llm_min_confidence,
        }
        config.settings.llm_adjustment_allowed = True
        config.settings.llm_min_confidence = 0.0

        try:
            decision = StrategyDecision(
                strategy_id="strategy",
                symbol="AAPL",
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("1"),
                order_type="market",
                time_in_force="day",
            )
            review = LLMReviewResponse(
                verdict="adjust",
                confidence=1.0,
                adjusted_qty=Decimal("1.1"),
                adjusted_order_type="limit",
                rationale="limit_requested",
                risk_flags=[],
            )
            outcome = apply_policy(decision, review)
            self.assertEqual(outcome.verdict, "veto")
            self.assertEqual(outcome.reason, "llm_adjustment_missing_limit_price")
        finally:
            config.settings.llm_adjustment_allowed = original["llm_adjustment_allowed"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]

    def test_adjustment_clamped_to_bounds(self) -> None:
        original = {
            "llm_adjustment_allowed": config.settings.llm_adjustment_allowed,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_min_qty_multiplier": config.settings.llm_min_qty_multiplier,
            "llm_max_qty_multiplier": config.settings.llm_max_qty_multiplier,
        }
        config.settings.llm_adjustment_allowed = True
        config.settings.llm_min_confidence = 0.0
        config.settings.llm_min_qty_multiplier = 0.5
        config.settings.llm_max_qty_multiplier = 1.25

        try:
            decision = StrategyDecision(
                strategy_id="strategy",
                symbol="AAPL",
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("10"),
                order_type="market",
                time_in_force="day",
            )
            review = LLMReviewResponse(
                verdict="adjust",
                confidence=1.0,
                adjusted_qty=Decimal("25"),
                adjusted_order_type="market",
                rationale="clamp_requested",
                risk_flags=[],
            )
            outcome = apply_policy(decision, review)
            self.assertEqual(outcome.verdict, "adjust")
            self.assertEqual(outcome.decision.qty, Decimal("12.5"))
            self.assertEqual(outcome.reason, "llm_adjustment_clamped_max")
        finally:
            config.settings.llm_adjustment_allowed = original["llm_adjustment_allowed"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]
            config.settings.llm_min_qty_multiplier = original["llm_min_qty_multiplier"]
            config.settings.llm_max_qty_multiplier = original["llm_max_qty_multiplier"]
