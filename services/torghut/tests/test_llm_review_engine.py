from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.llm.client import LLMClientResponse
from app.trading.llm.review_engine import LLMReviewEngine
from app.trading.llm.schema import PortfolioSnapshot
from app.trading.models import StrategyDecision


class FakeLLMClient:
    def __init__(self, content: str) -> None:
        self.content = content

    def request_review(self, messages, temperature, max_tokens):  # noqa: ANN001
        return LLMClientResponse(content=self.content, usage=None)


class TestLLMReviewEngine(TestCase):
    def test_review_normalizes_common_keys(self) -> None:
        engine = LLMReviewEngine(client=FakeLLMClient('{"decision":"approve","rationale":"ok"}'))

        account = {"equity": "10000", "cash": "10000", "buying_power": "10000"}
        positions: list[dict[str, object]] = []
        portfolio = PortfolioSnapshot(
            equity=Decimal("10000"),
            cash=Decimal("10000"),
            buying_power=Decimal("10000"),
            total_exposure=Decimal("0"),
            exposure_by_symbol={},
            positions=positions,
        )
        decision = StrategyDecision(
            strategy_id="demo",
            symbol="AAPL",
            action="buy",
            qty=Decimal("1"),
            order_type="market",
            time_in_force="day",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            rationale="demo",
            params={},
        )

        outcome = engine.review(
            decision=decision,
            account=account,
            positions=positions,
            request=engine.build_request(decision, account, positions, portfolio, None, []),
            portfolio=portfolio,
            market=None,
            recent_decisions=[],
        )

        self.assertEqual(outcome.response.verdict, "approve")
        self.assertEqual(outcome.response.confidence, 0.5)
        self.assertEqual(outcome.response.risk_flags, [])

