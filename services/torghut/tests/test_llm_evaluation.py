from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase
from uuid import uuid4

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models import Base, LLMDecisionReview, Strategy, TradeDecision
from app.trading.llm.evaluation import build_llm_evaluation_metrics


class TestLlmEvaluation(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine)
        self.session_local = sessionmaker(bind=self.engine, autoflush=False, autocommit=False, expire_on_commit=False)

    def tearDown(self) -> None:
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def test_build_metrics_includes_calibration_and_decision_contribution(self) -> None:
        now = datetime(2026, 2, 20, 15, 0, tzinfo=timezone.utc)
        with self.session_local() as session:
            strategy = Strategy(
                id=uuid4(),
                name="demo",
                description="demo",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_position_pct_equity=None,
                max_notional_per_trade=None,
            )
            session.add(strategy)
            session.flush()

            decision_one = TradeDecision(
                id=uuid4(),
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={"qty": "1"},
                rationale="d1",
                decision_hash=None,
                status="planned",
                created_at=now,
            )
            decision_two = TradeDecision(
                id=uuid4(),
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={"qty": "1"},
                rationale="d2",
                decision_hash=None,
                status="planned",
                created_at=now,
            )
            session.add_all([decision_one, decision_two])
            session.flush()

            review_one = LLMDecisionReview(
                trade_decision_id=decision_one.id,
                model="m",
                prompt_version="v1",
                input_json={},
                response_json={
                    "verdict": "adjust",
                    "uncertainty": 0.2,
                    "calibrated_probabilities": {
                        "approve": 0.1,
                        "veto": 0.1,
                        "adjust": 0.7,
                        "abstain": 0.05,
                        "escalate": 0.05,
                    },
                },
                verdict="adjust",
                confidence=Decimal("0.8"),
                adjusted_qty=Decimal("2"),
                adjusted_order_type="market",
                rationale="ok",
                risk_flags=["spread_wide"],
                tokens_prompt=20,
                tokens_completion=10,
            )
            review_two = LLMDecisionReview(
                trade_decision_id=decision_two.id,
                model="m",
                prompt_version="v1",
                input_json={},
                response_json={
                    "verdict": "abstain",
                    "policy_override": "llm_abstain_pass_through",
                    "uncertainty": 0.7,
                    "calibrated_probabilities": {
                        "approve": 0.2,
                        "veto": 0.1,
                        "adjust": 0.1,
                        "abstain": 0.5,
                        "escalate": 0.1,
                    },
                },
                verdict="approve",
                confidence=Decimal("0.6"),
                adjusted_qty=None,
                adjusted_order_type=None,
                rationale="fallback",
                risk_flags=[],
                tokens_prompt=12,
                tokens_completion=8,
            )
            session.add_all([review_one, review_two])
            session.commit()

            payload = build_llm_evaluation_metrics(session=session, now=now)

        metrics = payload["metrics"]
        assert isinstance(metrics, dict)
        self.assertEqual(metrics["total_reviews"], 2)
        self.assertEqual(metrics["verdict_counts"]["adjust"], 1)
        self.assertEqual(metrics["verdict_counts"]["approve"], 1)
        self.assertEqual(metrics["tokens"]["total"], 50)

        calibration_quality = metrics["calibration_quality"]
        assert isinstance(calibration_quality, dict)
        self.assertEqual(calibration_quality["count"], 2)
        self.assertGreater(float(calibration_quality["avg_top_probability"]), 0.5)
        self.assertGreater(float(calibration_quality["avg_probability_margin"]), 0.0)

        decision_contribution = metrics["decision_contribution"]
        assert isinstance(decision_contribution, dict)
        self.assertEqual(decision_contribution["policy_override_total"], 1)
        self.assertEqual(decision_contribution["llm_influence_total"], 1)
        self.assertEqual(decision_contribution["model_verdict_counts"]["abstain"], 1)
