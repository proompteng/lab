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

    def test_build_request_sanitizes_inputs(self) -> None:
        engine = LLMReviewEngine(client=FakeLLMClient('{"verdict":"approve","confidence":1,"rationale":"ok","risk_flags":[]}'))

        account = {"equity": "10000", "cash": "5000", "buying_power": "15000", "account_id": "secret"}
        positions = [
            {
                "symbol": "AAPL",
                "qty": "10",
                "market_value": "1000",
                "avg_entry_price": "95",
                "account_id": "nope",
            },
            {"symbol": "MSFT", "qty": "5", "extra": "nope"},
            {"qty": "1"},
        ]
        portfolio = PortfolioSnapshot(
            equity=Decimal("10000"),
            cash=Decimal("5000"),
            buying_power=Decimal("15000"),
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
            params={
                "macd": Decimal("1.0"),
                "rsi": Decimal("30"),
                "price": Decimal("100"),
                "news": "should_drop",
                "sizing": {"method": "default_qty", "notional_budget": "100", "extra": "drop"},
            },
        )

        request = engine.build_request(decision, account, positions, portfolio, None, [])

        self.assertNotIn("account_id", request.account)
        self.assertEqual(request.account, {"equity": "10000", "cash": "5000", "buying_power": "15000"})
        self.assertEqual([pos["symbol"] for pos in request.positions], ["AAPL", "MSFT"])
        self.assertNotIn("account_id", request.positions[0])
        self.assertNotIn("extra", request.positions[1])
        self.assertNotIn("news", request.decision.params)
        self.assertIn("sizing", request.decision.params)
        self.assertEqual(request.decision.params["sizing"], {"method": "default_qty", "notional_budget": "100"})
