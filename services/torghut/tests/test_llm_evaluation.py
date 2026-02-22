from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import cast
from unittest import TestCase

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.models import Base, LLMDecisionReview, Strategy, TradeDecision
from app.trading.llm.evaluation import build_llm_evaluation_metrics


class TestLlmEvaluation(TestCase):
    def setUp(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        self.session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

    def test_evaluation_includes_calibration_quality_and_decision_contribution(self) -> None:
        with self.session_local() as session:
            strategy = Strategy(
                name="llm-eval",
                description="llm metrics",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={"symbol": "AAPL", "action": "buy", "qty": "1"},
                status="planned",
                created_at=datetime(2026, 2, 21, 12, 0, tzinfo=timezone.utc),
            )
            session.add(decision)
            session.commit()

            session.add_all(
                [
                    LLMDecisionReview(
                        trade_decision_id=decision.id,
                        model="test-model",
                        prompt_version="v1",
                        input_json={"decision": "1"},
                        response_json={
                            "policy_override": "llm_uncertainty_guardrail_fallback_veto",
                            "calibrated_probabilities": {
                                "approve": 0.55,
                                "veto": 0.2,
                                "adjust": 0.1,
                                "abstain": 0.1,
                                "escalate": 0.05,
                            },
                            "uncertainty": {"score": 0.42, "band": "high"},
                            "calibration_metadata": {"quality_score": 0.61},
                            "deterministic_guardrails": [
                                "llm_uncertainty_score_above_max"
                            ],
                        },
                        verdict="veto",
                        confidence=Decimal("0.6"),
                        rationale="guardrail",
                        risk_flags=["llm_uncertainty_score_above_max"],
                        tokens_prompt=10,
                        tokens_completion=5,
                    ),
                    LLMDecisionReview(
                        trade_decision_id=decision.id,
                        model="test-model",
                        prompt_version="v1",
                        input_json={"decision": "2"},
                        response_json={
                            "calibrated_probabilities": {
                                "approve": 0.2,
                                "veto": 0.2,
                                "adjust": 0.4,
                                "abstain": 0.1,
                                "escalate": 0.1,
                            },
                            "uncertainty": {"score": 0.3, "band": "medium"},
                            "calibration_metadata": {"quality_score": 0.9},
                        },
                        verdict="adjust",
                        confidence=Decimal("0.5"),
                        rationale="adjust",
                        risk_flags=[],
                        tokens_prompt=8,
                        tokens_completion=4,
                    ),
                ]
            )
            session.commit()

            metrics_payload = build_llm_evaluation_metrics(
                cast(Session, session),
                now=datetime(2026, 2, 21, 12, 0, tzinfo=timezone.utc),
            )

        metrics = metrics_payload["metrics"]
        assert isinstance(metrics, dict)
        calibration_quality = metrics.get("calibration_quality")
        decision_contribution = metrics.get("decision_contribution")
        self.assertIsInstance(calibration_quality, dict)
        self.assertIsInstance(decision_contribution, dict)
        if isinstance(calibration_quality, dict):
            self.assertEqual(calibration_quality.get("samples"), 2)
            self.assertGreater(float(calibration_quality.get("mean_confidence_gap") or 0), 0)
            self.assertGreater(float(calibration_quality.get("high_uncertainty_rate") or 0), 0)
        if isinstance(decision_contribution, dict):
            self.assertEqual(decision_contribution.get("contribution_events"), 2)
            self.assertEqual(decision_contribution.get("fallback_total"), 1)
            self.assertEqual(decision_contribution.get("deterministic_guardrail_total"), 1)
