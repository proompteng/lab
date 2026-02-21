from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.llm.client import LLMClientResponse
from app.trading.llm.review_engine import LLMReviewEngine
from app.trading.llm.schema import MarketContextBundle, PortfolioSnapshot
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
            request=engine.build_request(decision, account, positions, portfolio, None, None, []),
            portfolio=portfolio,
            market=None,
            recent_decisions=[],
        )

        self.assertEqual(outcome.response.verdict, "approve")
        self.assertEqual(outcome.response.confidence, 0.5)
        self.assertEqual(outcome.response.risk_flags, [])
        total_probability = (
            outcome.response.calibrated_probabilities.approve
            + outcome.response.calibrated_probabilities.veto
            + outcome.response.calibrated_probabilities.adjust
            + outcome.response.calibrated_probabilities.abstain
            + outcome.response.calibrated_probabilities.escalate
        )
        self.assertAlmostEqual(total_probability, 1.0, places=6)

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

        market_context = MarketContextBundle.model_validate(
            {
                "contextVersion": "torghut.market-context.v1",
                "symbol": "AAPL",
                "asOfUtc": "2026-02-19T12:00:00Z",
                "freshnessSeconds": 20,
                "qualityScore": 0.8,
                "sourceCount": 1,
                "riskFlags": [],
                "domains": {
                    "technicals": {
                        "domain": "technicals",
                        "state": "ok",
                        "asOf": "2026-02-19T12:00:00Z",
                        "freshnessSeconds": 20,
                        "maxFreshnessSeconds": 60,
                        "sourceCount": 1,
                        "qualityScore": 1,
                        "payload": {"price": 100},
                        "citations": [],
                        "riskFlags": [],
                    },
                    "fundamentals": {
                        "domain": "fundamentals",
                        "state": "missing",
                        "asOf": None,
                        "freshnessSeconds": None,
                        "maxFreshnessSeconds": 86400,
                        "sourceCount": 0,
                        "qualityScore": 0,
                        "payload": {},
                        "citations": [],
                        "riskFlags": ["fundamentals_missing"],
                    },
                    "news": {
                        "domain": "news",
                        "state": "missing",
                        "asOf": None,
                        "freshnessSeconds": None,
                        "maxFreshnessSeconds": 300,
                        "sourceCount": 0,
                        "qualityScore": 0,
                        "payload": {},
                        "citations": [],
                        "riskFlags": ["news_missing"],
                    },
                    "regime": {
                        "domain": "regime",
                        "state": "ok",
                        "asOf": "2026-02-19T12:00:00Z",
                        "freshnessSeconds": 20,
                        "maxFreshnessSeconds": 120,
                        "sourceCount": 1,
                        "qualityScore": 1,
                        "payload": {},
                        "citations": [],
                        "riskFlags": [],
                    },
                },
            }
        )

        request = engine.build_request(decision, account, positions, portfolio, None, market_context, [])

        self.assertNotIn("account_id", request.account)
        self.assertEqual(request.account, {"equity": "10000", "cash": "5000", "buying_power": "15000"})
        self.assertEqual([pos["symbol"] for pos in request.positions], ["AAPL", "MSFT"])
        self.assertNotIn("account_id", request.positions[0])
        self.assertNotIn("extra", request.positions[1])
        self.assertNotIn("news", request.decision.params)
        self.assertIn("sizing", request.decision.params)
        self.assertEqual(request.decision.params["sizing"], {"method": "default_qty", "notional_budget": "100"})
        self.assertIsNotNone(request.market_context)
        self.assertEqual(request.market_context.symbol, "AAPL")

    def test_review_rejects_invalid_probability_mass(self) -> None:
        engine = LLMReviewEngine(
            client=FakeLLMClient(
                '{"verdict":"approve","confidence":0.8,"uncertainty":0.1,'
                '"confidence_band":"high","uncertainty_band":"low",'
                '"calibrated_probabilities":{"approve":0.9,"veto":0.1,"adjust":0.1,"abstain":0.1,"escalate":0.1},'
                '"rationale":"bad_probs","risk_flags":[]}'
            )
        )
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
        with self.assertRaises(ValueError):
            engine.review(
                decision=decision,
                account=account,
                positions=positions,
                request=engine.build_request(decision, account, positions, portfolio, None, None, []),
                portfolio=portfolio,
                market=None,
                recent_decisions=[],
            )
