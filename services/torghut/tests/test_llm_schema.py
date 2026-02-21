from __future__ import annotations

from decimal import Decimal
from unittest import TestCase

from pydantic import ValidationError

from app.trading.llm.schema import LLMReviewResponse


class TestLlmSchema(TestCase):
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
