from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.llm.dspy_programs.runtime import DSPyRuntimeError
from app.trading.llm.review_engine import LLMReviewEngine
from app.trading.llm.schema import (
    LLMReviewResponse,
    MarketContextBundle,
    PortfolioSnapshot,
)
from app.trading.models import StrategyDecision


class FakeDSPyRuntime:
    def __init__(
        self,
        *,
        response_payload: dict[str, object] | None = None,
        error: str | None = None,
    ) -> None:
        self.mode = "active"
        self.program_name = "trade-review-committee-v1"
        self.signature_version = "v1"
        self.artifact_hash = "a" * 64
        self._response_payload = response_payload
        self._error = error

    def review(self, _request):  # noqa: ANN001
        if self._error is not None:
            raise DSPyRuntimeError(self._error)
        assert self._response_payload is not None
        response = LLMReviewResponse.model_validate(self._response_payload)
        metadata = type(
            "_Meta",
            (),
            {
                "program_name": self.program_name,
                "signature_version": self.signature_version,
                "to_payload": lambda self: {  # noqa: ANN001
                    "mode": "active",
                    "program_name": "trade-review-committee-v1",
                    "signature_version": "v1",
                    "artifact_hash": "a" * 64,
                    "artifact_source": "database",
                    "executor": "dspy_live",
                    "latency_ms": 3,
                    "advisory_only": True,
                },
            },
        )()
        return response, metadata


class TestLLMReviewEngine(TestCase):
    def _build_inputs(
        self,
    ) -> tuple[
        StrategyDecision, dict[str, str], list[dict[str, object]], PortfolioSnapshot
    ]:
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
        return decision, account, positions, portfolio

    def test_build_request_sanitizes_inputs(self) -> None:
        engine = LLMReviewEngine(
            dspy_runtime=FakeDSPyRuntime(
                response_payload={
                    "verdict": "approve",
                    "confidence": 0.7,
                    "confidence_band": "medium",
                    "calibrated_probabilities": {
                        "approve": 0.7,
                        "veto": 0.1,
                        "adjust": 0.1,
                        "abstain": 0.05,
                        "escalate": 0.05,
                    },
                    "uncertainty": {"score": 0.3, "band": "medium"},
                    "calibration_metadata": {},
                    "rationale": "ok",
                    "required_checks": ["risk_engine"],
                    "risk_flags": [],
                }
            )
        )

        account = {
            "equity": "10000",
            "cash": "5000",
            "buying_power": "15000",
            "account_id": "secret",
        }
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
                "sizing": {
                    "method": "default_qty",
                    "notional_budget": "100",
                    "extra": "drop",
                },
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

        request = engine.build_request(
            decision,
            account,
            positions,
            portfolio,
            None,
            market_context,
            [],
        )

        self.assertNotIn("account_id", request.account)
        self.assertEqual(
            request.account,
            {"equity": "10000", "cash": "5000", "buying_power": "15000"},
        )
        self.assertEqual([pos["symbol"] for pos in request.positions], ["AAPL", "MSFT"])
        self.assertNotIn("account_id", request.positions[0])
        self.assertNotIn("extra", request.positions[1])
        self.assertNotIn("news", request.decision.params)
        self.assertIn("sizing", request.decision.params)
        self.assertEqual(
            request.decision.params["sizing"],
            {"method": "default_qty", "notional_budget": "100"},
        )
        self.assertIsNotNone(request.market_context)
        self.assertEqual(request.market_context.symbol, "AAPL")

    def test_review_uses_dspy_runtime_response(self) -> None:
        engine = LLMReviewEngine(
            dspy_runtime=FakeDSPyRuntime(
                response_payload={
                    "verdict": "approve",
                    "confidence": 0.88,
                    "confidence_band": "high",
                    "calibrated_probabilities": {
                        "approve": 0.88,
                        "veto": 0.03,
                        "adjust": 0.03,
                        "abstain": 0.03,
                        "escalate": 0.03,
                    },
                    "uncertainty": {"score": 0.12, "band": "low"},
                    "calibration_metadata": {},
                    "rationale": "dspy_approve",
                    "required_checks": ["risk_engine"],
                    "risk_flags": [],
                }
            )
        )
        decision, account, positions, portfolio = self._build_inputs()

        outcome = engine.review(
            decision=decision,
            account=account,
            positions=positions,
            request=engine.build_request(
                decision, account, positions, portfolio, None, None, []
            ),
            portfolio=portfolio,
            market=None,
            recent_decisions=[],
        )

        self.assertEqual(outcome.response.verdict, "approve")
        self.assertTrue(outcome.model.startswith("dspy:"))
        self.assertEqual(outcome.prompt_version, "dspy:v1")
        self.assertIn("dspy", outcome.response_json)
        self.assertEqual(outcome.tokens_prompt, None)
        self.assertEqual(outcome.tokens_completion, None)

    def test_review_uses_deterministic_fallback_when_dspy_fails(self) -> None:
        engine = LLMReviewEngine(
            dspy_runtime=FakeDSPyRuntime(error="dspy_program_failed")
        )
        decision, account, positions, portfolio = self._build_inputs()

        outcome = engine.review(
            decision=decision,
            account=account,
            positions=positions,
            request=engine.build_request(
                decision, account, positions, portfolio, None, None, []
            ),
            portfolio=portfolio,
            market=None,
            recent_decisions=[],
        )

        self.assertEqual(outcome.response.verdict, "veto")
        self.assertEqual(outcome.model, "dspy:trade-review-committee-v1")
        dspy_payload = outcome.response_json.get("dspy")
        self.assertIsInstance(dspy_payload, dict)
        assert isinstance(dspy_payload, dict)
        self.assertTrue(bool(dspy_payload.get("fallback")))
        self.assertEqual(dspy_payload.get("artifact_source"), "runtime_fallback")
        self.assertEqual(outcome.tokens_prompt, None)
        self.assertEqual(outcome.tokens_completion, None)
