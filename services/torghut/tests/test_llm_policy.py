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
