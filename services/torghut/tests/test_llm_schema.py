from __future__ import annotations

from decimal import Decimal
from unittest import TestCase

from pydantic import ValidationError

from app.trading.llm.schema import (
    LLMDecisionContext,
    LLMRegimeHMMContext,
    LLMReviewResponse,
)


class TestLlmSchema(TestCase):
    def test_decision_context_accepts_compact_regime_hmm_context(self) -> None:
        context = LLMDecisionContext.model_validate(
            {
                "strategy_id": "demo",
                "symbol": "AAPL",
                "action": "buy",
                "qty": "1",
                "order_type": "market",
                "time_in_force": "day",
                "event_ts": "2026-02-28T14:00:00Z",
                "timeframe": "1Min",
                "regime_hmm": {
                    "regime_id": "R2",
                    "entropy_band": "medium",
                    "predicted_next": "R3",
                    "artifact_version": "hmm-regime-v1.2.0",
                    "guardrail_reason": "stable",
                },
                "params": {
                    "price": "100",
                },
            }
        )
        self.assertEqual(context.regime_hmm.regime_id, "R2")

    def test_llm_regime_hmm_context_rejects_unknown_fields(self) -> None:
        with self.assertRaises(ValidationError):
            LLMDecisionContext.model_validate(
                {
                    "strategy_id": "demo",
                    "symbol": "AAPL",
                    "action": "buy",
                    "qty": "1",
                    "order_type": "market",
                    "time_in_force": "day",
                    "event_ts": "2026-02-28T14:00:00Z",
                    "timeframe": "1Min",
                    "regime_hmm": {
                        "regime_id": "R2",
                        "entropy_band": "medium",
                        "predicted_next": "R3",
                        "artifact_version": "hmm-regime-v1.2.0",
                        "unknown": "field",
                    },
                    "params": {},
                }
            )

    def test_llm_regime_hmm_context_schema(self) -> None:
        context = LLMRegimeHMMContext.model_validate(
            {
                "regime_id": "R2",
                "entropy_band": "medium",
                "predicted_next": "R3",
                "artifact_version": "hmm-regime-v1.2.0",
                "guardrail_reason": "stable",
            }
        )
        self.assertEqual(context.regime_id, "R2")

    def test_calibrated_probabilities_must_sum_to_one(self) -> None:
        with self.assertRaises(ValidationError):
            LLMReviewResponse(
                verdict="approve",
                confidence=0.8,
                confidence_band="high",
                calibrated_probabilities={
                    "approve": 0.8,
                    "veto": 0.1,
                    "adjust": 0.1,
                    "abstain": 0.1,
                    "escalate": 0.1,
                },
                uncertainty={"score": 0.2, "band": "low"},
                calibration_metadata={},
                rationale="invalid probability mass",
                risk_flags=[],
            )

    def test_adjust_verdict_requires_adjusted_qty(self) -> None:
        with self.assertRaises(ValidationError):
            LLMReviewResponse(
                verdict="adjust",
                confidence=0.9,
                confidence_band="high",
                calibrated_probabilities={
                    "approve": 0.05,
                    "veto": 0.05,
                    "adjust": 0.8,
                    "abstain": 0.05,
                    "escalate": 0.05,
                },
                uncertainty={"score": 0.1, "band": "low"},
                calibration_metadata={},
                adjusted_order_type="market",
                rationale="missing adjusted quantity",
                risk_flags=[],
            )

    def test_limit_order_requires_limit_price(self) -> None:
        with self.assertRaises(ValidationError):
            LLMReviewResponse(
                verdict="adjust",
                confidence=0.9,
                confidence_band="high",
                calibrated_probabilities={
                    "approve": 0.05,
                    "veto": 0.05,
                    "adjust": 0.8,
                    "abstain": 0.05,
                    "escalate": 0.05,
                },
                uncertainty={"score": 0.1, "band": "low"},
                calibration_metadata={},
                adjusted_qty=Decimal("2"),
                adjusted_order_type="limit",
                rationale="missing limit price",
                risk_flags=[],
            )

    def test_escalate_verdict_requires_escalate_reason(self) -> None:
        with self.assertRaises(ValidationError):
            LLMReviewResponse(
                verdict="escalate",
                confidence=0.2,
                confidence_band="low",
                calibrated_probabilities={
                    "approve": 0.1,
                    "veto": 0.1,
                    "adjust": 0.1,
                    "abstain": 0.1,
                    "escalate": 0.6,
                },
                uncertainty={"score": 0.8, "band": "high"},
                calibration_metadata={},
                rationale="requires operator review",
                risk_flags=[],
            )
