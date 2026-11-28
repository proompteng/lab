from __future__ import annotations

import tempfile
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from sqlalchemy import select

from app.models import Execution, LLMDecisionReview, TradeDecision
from app.trading.firewall import OrderFirewall
from app.trading.llm.schema import MarketContextBundle
from app.trading.scheduler.pipeline.llm_review import TradingPipelineReviewMixin
from app.trading.scheduler.state import TradingState
from tests.pipeline.trading_pipeline_base import TradingPipelineTestCaseBase
from tests.pipeline.trading_pipeline_support import (
    FakeAlpacaClient,
    FakeIngestor,
    FakeLLMReviewEngine,
)
from tests.trading_fixtures import macd_buy_signal, make_signal, make_strategy


class TestTradingPipelineStageLlm(TradingPipelineTestCaseBase):
    def test_execution_client_name_uses_declared_adapter(self) -> None:
        mixin = object.__new__(TradingPipelineReviewMixin)
        client = type("DeclaredAdapter", (), {"name": "simulation"})()

        self.assertEqual(mixin._execution_client_name(client), "simulation")

    def test_pipeline_stage1_live_uses_mode_consistent_fail_mode(self) -> None:
        self.configure_settings(
            trading_enabled=True,
        )
        self.configure_settings(
            trading_mode="live",
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
            llm_enabled=True,
            llm_rollout_stage="stage1_shadow_pilot",
            llm_shadow_mode=False,
            llm_fail_mode="pass_through",
            llm_fail_mode_enforcement="configured",
        )
        self.configure_llm_guardrails()

        self.seed_demo_strategy()

        signal = macd_buy_signal()

        alpaca_client = FakeAlpacaClient()
        pipeline = self.make_pipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([signal]),
            execution_adapter=alpaca_client,
            llm_review_engine=FakeLLMReviewEngine(circuit_open=True),
        )

        pipeline.run_once()

        with self.session_local() as session:
            decisions = session.execute(select(TradeDecision)).scalars().all()
            executions = session.execute(select(Execution)).scalars().all()
            self.assertEqual(decisions[0].status, "blocked")
            self.assertEqual(
                decisions[0].decision_json.get("submission_block_reason"),
                "capital_stage_shadow",
            )
            self.assertEqual(len(executions), 0)
            self.assertEqual(pipeline.state.metrics.llm_fail_mode_override_total, 0)
            self.assertEqual(pipeline.state.metrics.llm_fail_mode_exception_total, 0)
            self.assertEqual(
                pipeline.state.metrics.llm_policy_resolution_total.get("compliant"),
                1,
            )
            self.assertEqual(pipeline.state.metrics.llm_stage_policy_violation_total, 1)

    def test_pipeline_stage1_market_context_failure_keeps_shadow_mode(self) -> None:
        self.configure_settings(
            trading_enabled=True,
        )
        self.configure_settings(
            trading_mode="live",
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
            trading_market_context_fail_mode="fail_closed",
            llm_enabled=True,
            llm_rollout_stage="stage1_shadow_pilot",
            llm_shadow_mode=False,
            llm_fail_mode="pass_through",
            llm_fail_mode_enforcement="configured",
        )
        self.configure_llm_guardrails()

        self.seed_demo_strategy()

        signal = macd_buy_signal()

        class _FailingMarketContextClient:
            @staticmethod
            def fetch(symbol: str) -> MarketContextBundle | None:
                raise RuntimeError(f"market-context unavailable for {symbol}")

        alpaca_client = FakeAlpacaClient()
        pipeline = self.make_pipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([signal]),
            execution_adapter=alpaca_client,
            llm_review_engine=FakeLLMReviewEngine(),
        )
        pipeline.market_context_client = _FailingMarketContextClient()

        pipeline.run_once()

        with self.session_local() as session:
            reviews = session.execute(select(LLMDecisionReview)).scalars().all()
            decisions = session.execute(select(TradeDecision)).scalars().all()
            executions = session.execute(select(Execution)).scalars().all()
            self.assertEqual(len(reviews), 1)
            self.assertEqual(reviews[0].verdict, "error")
            self.assertEqual(
                reviews[0].response_json.get("error"),
                "market_context_fetch_error",
            )
            self.assertEqual(
                decisions[0].decision_json.get("market_context", {}).get("reason"),
                "market_context_fetch_error",
            )
            policy_resolution = reviews[0].response_json.get("policy_resolution")
            self.assertIsInstance(policy_resolution, dict)
            # Stage1 rollout must stay shadow-only even when fail mode is configured as fail_closed.
            self.assertEqual(decisions[0].status, "blocked")
            self.assertEqual(
                decisions[0].decision_json.get("submission_block_reason"),
                "capital_stage_shadow",
            )
            self.assertEqual(len(executions), 0)
            self.assertEqual(pipeline.state.metrics.llm_market_context_block_total, 1)
            self.assertEqual(pipeline.state.metrics.llm_guardrail_shadow_total, 1)

    def test_pipeline_stage2_fail_mode_forces_pass_through(self) -> None:
        self.configure_settings(
            trading_enabled=True,
            trading_mode="paper",
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
            llm_enabled=True,
            llm_rollout_stage="stage2",
            llm_shadow_mode=False,
            llm_fail_mode="veto",
            llm_fail_mode_enforcement="configured",
        )
        self.configure_llm_guardrails()

        with self.session_local() as session:
            strategy = make_strategy(
                name="demo",
                description="demo",
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.flush()
            self._activate_test_capital_authority(session, strategy=strategy)
            session.commit()

        signal = macd_buy_signal()

        alpaca_client = FakeAlpacaClient()
        pipeline = self.make_pipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([signal]),
            execution_adapter=alpaca_client,
            llm_review_engine=FakeLLMReviewEngine(circuit_open=True),
        )
        self._prime_test_capital_state(pipeline.state)

        pipeline.run_once()

        with self.session_local() as session:
            reviews = session.execute(select(LLMDecisionReview)).scalars().all()
            decisions = session.execute(select(TradeDecision)).scalars().all()
            executions = session.execute(select(Execution)).scalars().all()
            self.assertEqual(len(reviews), 1)
            self.assertEqual(reviews[0].verdict, "error")
            self.assertEqual(reviews[0].response_json.get("fallback"), "pass_through")
            policy_resolution = reviews[0].response_json.get("policy_resolution")
            self.assertIsInstance(policy_resolution, dict)
            assert isinstance(policy_resolution, dict)
            self.assertEqual(policy_resolution.get("rollout_stage"), "stage2")
            self.assertEqual(
                pipeline.state.metrics.llm_policy_resolution_total.get("violation"),
                1,
            )
            self.assertEqual(decisions[0].status, "submitted")
            self.assertEqual(len(executions), 1)

    def test_pipeline_llm_min_confidence(self) -> None:
        self.configure_settings(
            trading_enabled=True,
        )
        self.configure_settings(
            trading_mode="paper",
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
            llm_enabled=True,
            llm_min_confidence=0.9,
        )
        self.configure_llm_guardrails()

        self.seed_demo_strategy()

        signal = macd_buy_signal()

        alpaca_client = FakeAlpacaClient()
        pipeline = self.make_pipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([signal]),
            execution_adapter=alpaca_client,
            llm_review_engine=FakeLLMReviewEngine(verdict="approve", confidence=0.1),
        )

        pipeline.run_once()

        with self.session_local() as session:
            reviews = session.execute(select(LLMDecisionReview)).scalars().all()
            decisions = session.execute(select(TradeDecision)).scalars().all()
            executions = session.execute(select(Execution)).scalars().all()
            self.assertEqual(len(reviews), 1)
            self.assertEqual(reviews[0].verdict, "veto")
            self.assertEqual(decisions[0].status, "rejected")
            self.assertEqual(len(executions), 0)

    def test_pipeline_llm_adjust_out_of_bounds(self) -> None:
        self.configure_settings(
            trading_enabled=True,
        )
        self.configure_settings(
            trading_mode="paper",
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
            llm_enabled=True,
            llm_adjustment_allowed=True,
            llm_min_confidence=0.0,
        )
        self.configure_llm_guardrails(adjustment_approved=True)

        self.seed_demo_strategy()

        with tempfile.TemporaryDirectory() as tmpdir:
            gate_path = Path(tmpdir) / "gate-report.json"
            gate_path.write_text('{"uncertainty_gate_action":"pass"}', encoding="utf-8")
            signal = make_signal(
                datetime.now(timezone.utc),
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                    "schema_version": "hmm_regime_context_v1",
                    "regime_id": "R1",
                    "posterior": {"R1": 1.0},
                    "entropy": "0.12",
                    "entropy_band": "low",
                    "predicted_next": "R1",
                    "transition_shock": False,
                    "duration_ms": 0,
                    "artifact": {
                        "model_id": "hmm-regime-v1.0",
                        "feature_schema": "hmm-v1",
                        "training_run_id": "run-2026",
                    },
                    "guardrail": {
                        "stale": False,
                        "fallback_to_defensive": False,
                    },
                },
            )

            alpaca_client = FakeAlpacaClient()
            pipeline = self.make_pipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                execution_adapter=alpaca_client,
                state=TradingState(last_autonomy_gates=str(gate_path)),
                llm_review_engine=FakeLLMReviewEngine(
                    verdict="adjust",
                    adjusted_qty=Decimal("50"),
                    adjusted_order_type="market",
                ),
            )

            pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                decisions = session.execute(select(TradeDecision)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "adjust")
                self.assertEqual(reviews[0].adjusted_qty, Decimal("12.5"))
                self.assertEqual(decisions[0].status, "rejected")
                self.assertEqual(len(executions), 0)
