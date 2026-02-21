from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from pydantic import ValidationError

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
            with self.assertRaises(ValidationError):
                LLMReviewResponse(
                    verdict="adjust",
                    confidence=1.0,
                    confidence_band="high",
                    calibrated_probabilities={
                        "approve": 0.0,
                        "veto": 0.0,
                        "adjust": 1.0,
                        "abstain": 0.0,
                        "escalate": 0.0,
                    },
                    uncertainty={"score": 0.0, "band": "low"},
                    calibration_metadata={},
                    adjusted_qty=Decimal("1.1"),
                    adjusted_order_type="limit",
                    rationale="limit_requested",
                    risk_flags=[],
                )
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
                confidence_band="high",
                calibrated_probabilities={
                    "approve": 0.0,
                    "veto": 0.0,
                    "adjust": 1.0,
                    "abstain": 0.0,
                    "escalate": 0.0,
                },
                uncertainty={"score": 0.0, "band": "low"},
                calibration_metadata={},
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

    def test_abstain_uses_explicit_pass_through_fallback(self) -> None:
        original = {
            "llm_abstain_fail_mode": config.settings.llm_abstain_fail_mode,
            "llm_max_uncertainty_score": config.settings.llm_max_uncertainty_score,
            "llm_max_uncertainty_band": config.settings.llm_max_uncertainty_band,
            "llm_min_calibrated_probability": config.settings.llm_min_calibrated_probability,
        }
        config.settings.llm_abstain_fail_mode = "pass_through"
        config.settings.llm_max_uncertainty_score = 1.0
        config.settings.llm_max_uncertainty_band = "high"
        config.settings.llm_min_calibrated_probability = 0.0

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
                verdict="abstain",
                confidence=0.4,
                confidence_band="low",
                calibrated_probabilities={
                    "approve": 0.2,
                    "veto": 0.2,
                    "adjust": 0.1,
                    "abstain": 0.4,
                    "escalate": 0.1,
                },
                uncertainty={"score": 0.6, "band": "medium"},
                calibration_metadata={},
                rationale="insufficient evidence",
                risk_flags=["low_signal_quality"],
            )
            outcome = apply_policy(decision, review)
            self.assertEqual(outcome.verdict, "approve")
            self.assertEqual(outcome.reason, "llm_abstain_fallback_pass_through")
        finally:
            config.settings.llm_abstain_fail_mode = original["llm_abstain_fail_mode"]
            config.settings.llm_max_uncertainty_score = original[
                "llm_max_uncertainty_score"
            ]
            config.settings.llm_max_uncertainty_band = original[
                "llm_max_uncertainty_band"
            ]
            config.settings.llm_min_calibrated_probability = original[
                "llm_min_calibrated_probability"
            ]

    def test_uncertainty_guardrails_force_configured_fallback(self) -> None:
        original = {
            "llm_uncertainty_fail_mode": config.settings.llm_uncertainty_fail_mode,
            "llm_max_uncertainty_score": config.settings.llm_max_uncertainty_score,
            "llm_max_uncertainty_band": config.settings.llm_max_uncertainty_band,
            "llm_min_calibrated_probability": config.settings.llm_min_calibrated_probability,
            "llm_min_confidence": config.settings.llm_min_confidence,
        }
        config.settings.llm_uncertainty_fail_mode = "veto"
        config.settings.llm_max_uncertainty_score = 0.2
        config.settings.llm_max_uncertainty_band = "low"
        config.settings.llm_min_calibrated_probability = 0.6
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
                verdict="approve",
                confidence=0.8,
                confidence_band="high",
                calibrated_probabilities={
                    "approve": 0.3,
                    "veto": 0.2,
                    "adjust": 0.2,
                    "abstain": 0.2,
                    "escalate": 0.1,
                },
                uncertainty={"score": 0.7, "band": "high"},
                calibration_metadata={"quality_score": 0.3},
                rationale="model is not calibrated enough",
                risk_flags=[],
            )
            outcome = apply_policy(decision, review)
            self.assertEqual(outcome.verdict, "veto")
            self.assertEqual(outcome.reason, "llm_uncertainty_guardrail_fallback_veto")
            self.assertIn("llm_uncertainty_score_above_max", outcome.guardrail_reasons or [])
            self.assertIn("llm_uncertainty_band_above_max", outcome.guardrail_reasons or [])
            self.assertIn(
                "llm_calibrated_probability_below_min",
                outcome.guardrail_reasons or [],
            )
            self.assertIn(
                "llm_calibration_quality_below_min", outcome.guardrail_reasons or []
            )
        finally:
            config.settings.llm_uncertainty_fail_mode = original[
                "llm_uncertainty_fail_mode"
            ]
            config.settings.llm_max_uncertainty_score = original[
                "llm_max_uncertainty_score"
            ]
            config.settings.llm_max_uncertainty_band = original[
                "llm_max_uncertainty_band"
            ]
            config.settings.llm_min_calibrated_probability = original[
                "llm_min_calibrated_probability"
            ]
            config.settings.llm_min_confidence = original["llm_min_confidence"]
