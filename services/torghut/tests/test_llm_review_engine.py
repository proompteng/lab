from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.llm.client import LLMClientResponse
from app.trading.llm.review_engine import LLMReviewEngine
from app.trading.llm.schema import MarketContextBundle, PortfolioSnapshot
from app.trading.models import StrategyDecision


class FakeLLMClient:
    def __init__(self, content: str | list[str]) -> None:
        self.contents = [content] if isinstance(content, str) else list(content)
        self._idx = 0

    def request_review(self, messages, temperature, max_tokens):  # noqa: ANN001
        if self._idx >= len(self.contents):
            payload = self.contents[-1]
        else:
            payload = self.contents[self._idx]
        self._idx += 1
        return LLMClientResponse(content=payload, usage=None)


class TestLLMReviewEngine(TestCase):
    def setUp(self) -> None:
        from app import config

        self._orig_committee = config.settings.llm_committee_enabled

    def tearDown(self) -> None:
        from app import config

        config.settings.llm_committee_enabled = self._orig_committee

    def test_review_normalizes_common_keys(self) -> None:
        from app import config

        config.settings.llm_committee_enabled = False
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
        self.assertEqual(outcome.response.confidence_band, "medium")
        self.assertEqual(outcome.response.risk_flags, [])
        self.assertAlmostEqual(
            sum(outcome.response.calibrated_probabilities.model_dump(mode="python").values()),
            1.0,
            places=6,
        )
        self.assertEqual(outcome.response.uncertainty.band, "medium")

    def test_committee_mandatory_veto_wins(self) -> None:
        from app import config

        config.settings.llm_committee_enabled = True
        responses = [
            '{"verdict":"approve","confidence":0.8,"uncertainty":"low","rationale_short":"edge","required_checks":["risk_engine"]}',
            '{"verdict":"veto","confidence":0.9,"uncertainty":"low","rationale_short":"risk","required_checks":["risk_engine"]}',
            '{"verdict":"approve","confidence":0.7,"uncertainty":"medium","rationale_short":"exec","required_checks":["execution_policy"]}',
            '{"verdict":"approve","confidence":0.9,"uncertainty":"low","rationale_short":"policy","required_checks":["order_firewall"]}',
        ]
        engine = LLMReviewEngine(client=FakeLLMClient(responses))

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

        self.assertEqual(outcome.response.verdict, "veto")
        self.assertIsNotNone(outcome.response.committee)
        assert outcome.response.committee is not None
        self.assertIn("risk_critic", outcome.response.committee.roles)
        self.assertTrue(bool(outcome.request_hash))
        self.assertTrue(bool(outcome.response_hash))

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

    def test_review_normalizes_escalate_alias(self) -> None:
        from app import config

        config.settings.llm_committee_enabled = False
        engine = LLMReviewEngine(
            client=FakeLLMClient(
                '{"decision":"escalate_to_human","confidence":0.2,"confidence_band":"LOW",'
                '"escalation_reason":"need manual review","rationale":"need manual review"}'
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
        outcome = engine.review(
            decision=decision,
            account=account,
            positions=positions,
            request=engine.build_request(decision, account, positions, portfolio, None, None, []),
            portfolio=portfolio,
            market=None,
            recent_decisions=[],
        )
        self.assertEqual(outcome.response.verdict, "escalate")
        self.assertEqual(outcome.response.confidence_band, "low")
        self.assertEqual(outcome.response.escalate_reason, "need manual review")
        self.assertEqual(outcome.response.uncertainty.band, "high")

    def test_review_normalizes_confidence_band_alias(self) -> None:
        from app import config

        config.settings.llm_committee_enabled = False
        engine = LLMReviewEngine(
            client=FakeLLMClient(
                '{"verdict":"approve","confidence":0.6,"confidence_band":"Moderate","rationale":"ok"}'
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
        outcome = engine.review(
            decision=decision,
            account=account,
            positions=positions,
            request=engine.build_request(decision, account, positions, portfolio, None, None, []),
            portfolio=portfolio,
            market=None,
            recent_decisions=[],
        )
        self.assertEqual(outcome.response.confidence_band, "medium")
        self.assertEqual(outcome.response.uncertainty.band, "medium")
