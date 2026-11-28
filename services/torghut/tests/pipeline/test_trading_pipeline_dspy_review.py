from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import patch

from sqlalchemy import select

from app.models import Execution, LLMDecisionReview, TradeDecision
from app.trading.execution_adapters import SimulationExecutionAdapter
from app.trading.firewall import OrderFirewall
from app.trading.llm.dspy_programs.runtime import (
    DSPyReviewRuntime,
    DSPyRuntimeUnsupportedStateError,
)
from tests.pipeline.trading_pipeline_base import TradingPipelineTestCaseBase
from tests.pipeline.trading_pipeline_support import (
    CountingLLMReviewEngine,
    FakeAlpacaClient,
    FakeIngestor,
    FakeLLMReviewEngine,
    PositionedAlpacaClient,
)
from tests.trading_fixtures import macd_buy_signal, make_signal, make_strategy


class TestTradingPipelineDspyReview(TradingPipelineTestCaseBase):
    def setUp(self) -> None:
        super().setUp()
        self._broker_available_patcher = patch(
            "app.trading.submission_council._alpaca_broker_available",
            return_value=True,
        )
        self._broker_available_patcher.start()

    def tearDown(self) -> None:
        self._broker_available_patcher.stop()
        super().tearDown()

    def test_pipeline_llm_dspy_live_runtime_gate_can_pass_through_with_degraded_qty(
        self,
    ) -> None:
        self.configure_settings(
            trading_enabled=True,
            trading_mode="live",
            trading_autonomy_allow_live_promotion=True,
            trading_simple_submit_enabled=True,
            trading_live_submit_enabled=True,
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
            llm_enabled=True,
            llm_fail_mode="pass_through",
            llm_fail_mode_enforcement="configured",
            llm_fail_open_live_approved=True,
            llm_shadow_mode=False,
            llm_min_confidence=0.0,
            llm_dspy_runtime_mode="active",
            jangar_base_url="http://jangar.test",
            llm_dspy_artifact_hash=DSPyReviewRuntime.bootstrap_artifact_hash(),
            llm_rollout_stage="stage3",
            llm_dspy_live_runtime_block_fail_mode="pass_through_reduced_size",
            llm_dspy_live_runtime_block_qty_multiplier=0.5,
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
            self._activate_test_capital_authority(
                session,
                strategy=strategy,
                account_mode="live",
                account_label="live",
            )
            session.commit()

        signal = macd_buy_signal()

        pipeline = self.make_pipeline(
            order_firewall=OrderFirewall(FakeAlpacaClient(), account_label="live"),
            ingestor=FakeIngestor([signal]),
            account_label="live",
            llm_review_engine=CountingLLMReviewEngine(),
        )
        self._prime_test_capital_state(pipeline.state)
        pipeline._is_market_session_open = lambda _now=None: True

        self._seed_promotion_certificate_evidence()
        pipeline.run_once()

        with self.session_local() as session:
            reviews = session.execute(select(LLMDecisionReview)).scalars().all()
            decisions = session.execute(select(TradeDecision)).scalars().all()
            executions = session.execute(select(Execution)).scalars().all()

            self.assertEqual(len(reviews), 1)
            self.assertEqual(reviews[0].verdict, "error")
            self.assertEqual(
                reviews[0].rationale,
                "llm_dspy_live_runtime_gate_blocked",
            )
            self.assertEqual(reviews[0].response_json.get("fallback"), "pass_through")
            self.assertEqual(decisions[0].status, "submitted")
            self.assertEqual(len(executions), 1)
            self.assertLess(executions[0].submitted_qty, Decimal("10"))
            self.assertGreaterEqual(executions[0].submitted_qty, Decimal("1"))
            decision_payload = decisions[0].decision_json
            assert isinstance(decision_payload, dict)
            params = decision_payload.get("params")
            assert isinstance(params, dict)
            degrade = params.get("llm_runtime_block_degrade")
            assert isinstance(degrade, dict)
            self.assertEqual(
                Decimal(str(decision_payload.get("qty"))),
                executions[0].submitted_qty,
            )
            self.assertEqual(
                Decimal(str(degrade.get("degraded_qty"))),
                executions[0].submitted_qty,
            )
            self.assertGreater(
                Decimal(str(degrade.get("original_qty"))),
                executions[0].submitted_qty,
            )
            self.assertEqual(degrade.get("qty_multiplier"), "0.5")

    def test_pipeline_llm_shadow_bootstrap_artifact_keeps_live_submission_operational(
        self,
    ) -> None:
        self.configure_settings(
            trading_enabled=True,
            trading_mode="live",
            trading_autonomy_allow_live_promotion=True,
            trading_simple_submit_enabled=True,
            trading_live_submit_enabled=True,
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
            llm_enabled=True,
            llm_fail_mode="veto",
            llm_fail_mode_enforcement="strict_veto",
            llm_shadow_mode=True,
            llm_min_confidence=0.0,
            llm_dspy_runtime_mode="shadow",
            llm_dspy_artifact_hash=DSPyReviewRuntime.bootstrap_artifact_hash(),
            llm_rollout_stage="stage3",
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
            self._activate_test_capital_authority(
                session,
                strategy=strategy,
                account_mode="live",
                account_label="live",
            )
            session.commit()

        signal = macd_buy_signal()

        pipeline = self.make_pipeline(
            order_firewall=OrderFirewall(FakeAlpacaClient(), account_label="live"),
            ingestor=FakeIngestor([signal]),
            account_label="live",
        )
        self._prime_test_capital_state(pipeline.state)
        pipeline._is_market_session_open = lambda _now=None: True

        self._seed_promotion_certificate_evidence()
        pipeline.run_once()

        with self.session_local() as session:
            reviews = session.execute(select(LLMDecisionReview)).scalars().all()
            decisions = session.execute(select(TradeDecision)).scalars().all()
            executions = session.execute(select(Execution)).scalars().all()

            self.assertEqual(len(reviews), 1)
            self.assertNotEqual(reviews[0].verdict, "error")
            self.assertNotEqual(
                reviews[0].rationale,
                "llm_dspy_live_runtime_gate_blocked",
            )
            dspy_payload = reviews[0].response_json.get("dspy")
            self.assertIsInstance(dspy_payload, dict)
            assert isinstance(dspy_payload, dict)
            self.assertEqual(dspy_payload.get("artifact_source"), "bootstrap")
            self.assertEqual(decisions[0].status, "submitted")
            self.assertEqual(len(executions), 1)

    def test_pipeline_llm_dspy_runtime_reduced_sell_uses_seeded_simulation_inventory(
        self,
    ) -> None:
        self.configure_settings(
            trading_enabled=True,
        )
        self.configure_settings(
            trading_mode="live",
            trading_autonomy_allow_live_promotion=True,
            trading_simulation_enabled=True,
            trading_simple_submit_enabled=True,
            trading_live_submit_enabled=True,
            trading_allow_shorts=True,
            trading_fractional_equities_enabled=True,
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
            llm_enabled=True,
            llm_fail_mode="pass_through",
            llm_fail_mode_enforcement="configured",
            llm_fail_open_live_approved=True,
            llm_shadow_mode=False,
            llm_min_confidence=0.0,
            llm_dspy_runtime_mode="active",
            jangar_base_url="http://jangar.test",
            llm_dspy_artifact_hash=DSPyReviewRuntime.bootstrap_artifact_hash(),
            llm_rollout_stage="stage3",
            llm_dspy_live_runtime_block_fail_mode="pass_through_reduced_size",
            llm_dspy_live_runtime_block_qty_multiplier=0.5,
        )
        self.configure_llm_guardrails()

        with self.session_local() as session:
            strategy = make_strategy(
                name="demo-sell",
                description="demo sell",
                max_notional_per_trade=Decimal("100"),
            )
            session.add(strategy)
            session.commit()

        signal = make_signal(
            datetime.now(timezone.utc),
            payload={
                "macd": {"macd": 0.1, "signal": 0.4},
                "rsi14": 75,
                "price": 100,
            },
        )

        alpaca_client = PositionedAlpacaClient(
            [
                {
                    "symbol": "AAPL",
                    "qty": "2",
                    "side": "long",
                    "market_value": "200",
                }
            ]
        )
        execution_adapter = SimulationExecutionAdapter(
            bootstrap_servers=None,
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
            topic="torghut.sim.trade-updates.v1",
            account_label="live",
            simulation_run_id="sim-test",
            dataset_id="dataset-a",
        )
        pipeline = self.make_pipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([signal]),
            execution_adapter=execution_adapter,
            account_label="live",
            llm_review_engine=CountingLLMReviewEngine(),
        )
        pipeline._is_market_session_open = lambda _now=None: True

        self._seed_promotion_certificate_evidence()
        with (
            patch(
                "app.trading.scheduler.pipeline.run_cycle.trading_now",
                return_value=signal.event_ts,
            ),
            patch(
                "app.trading.scheduler.pipeline.decision_lifecycle.trading_now",
                return_value=signal.event_ts,
            ),
            patch(
                "app.trading.scheduler.capital_controls.trading_now",
                return_value=signal.event_ts,
            ),
            patch(
                "app.trading.execution_adapters.adapter_types.active_simulation_runtime_context",
                return_value={"run_id": "sim-test", "dataset_id": "dataset-a"},
            ),
        ):
            pipeline.run_once()

        with self.session_local() as session:
            reviews = session.execute(select(LLMDecisionReview)).scalars().all()
            decisions = session.execute(select(TradeDecision)).scalars().all()
            executions = session.execute(select(Execution)).scalars().all()

            self.assertEqual(len(reviews), 1)
            self.assertEqual(reviews[0].verdict, "error")
            self.assertEqual(
                reviews[0].rationale,
                "llm_dspy_live_runtime_gate_blocked",
            )
            self.assertEqual(reviews[0].response_json.get("fallback"), "pass_through")
            self.assertEqual(decisions[0].status, "submitted")
            self.assertEqual(len(executions), 1)
            self.assertLess(executions[0].submitted_qty, Decimal("1"))
            decision_payload = decisions[0].decision_json
            assert isinstance(decision_payload, dict)
            params = decision_payload.get("params")
            assert isinstance(params, dict)
            degrade = params.get("llm_runtime_block_degrade")
            assert isinstance(degrade, dict)
            self.assertEqual(
                Decimal(str(decision_payload.get("qty"))),
                executions[0].submitted_qty,
            )
            self.assertEqual(
                Decimal(str(degrade.get("degraded_qty"))),
                executions[0].submitted_qty,
            )
            self.assertGreater(
                Decimal(str(degrade.get("original_qty"))),
                executions[0].submitted_qty,
            )
            self.assertEqual(degrade.get("qty_multiplier"), "0.5")
            remaining_qty = Decimal(str(execution_adapter.list_positions()[0]["qty"]))
            self.assertEqual(
                remaining_qty,
                Decimal("2") - executions[0].submitted_qty,
            )
            self.assertEqual(
                execution_adapter.list_positions(),
                [
                    {
                        "symbol": "AAPL",
                        "qty": str(remaining_qty.normalize()),
                        "side": "long",
                        "alpaca_account_label": "live",
                        "market_value": str(
                            (remaining_qty * Decimal("100")).normalize()
                        ),
                    }
                ],
            )

    def test_pipeline_llm_dspy_live_runtime_gate_blocks_without_jangar_base_url(
        self,
    ) -> None:
        self.configure_settings(
            trading_enabled=True,
        )
        self.configure_settings(
            trading_mode="live",
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
            llm_enabled=True,
            llm_fail_mode="veto",
            llm_fail_mode_enforcement="strict_veto",
            llm_shadow_mode=False,
            llm_min_confidence=0.0,
            llm_dspy_runtime_mode="active",
            llm_dspy_artifact_hash="a" * 64,
            llm_rollout_stage="stage3",
            jangar_base_url=None,
        )
        self.configure_llm_guardrails()

        self.seed_demo_strategy()

        signal = macd_buy_signal()

        engine = CountingLLMReviewEngine()
        pipeline = self.make_pipeline(
            order_firewall=OrderFirewall(FakeAlpacaClient(), account_label="live"),
            ingestor=FakeIngestor([signal]),
            account_label="live",
            llm_review_engine=engine,
        )

        pipeline.run_once()

        with self.session_local() as session:
            reviews = session.execute(select(LLMDecisionReview)).scalars().all()
            executions = session.execute(select(Execution)).scalars().all()
            self.assertEqual(len(reviews), 1)
            self.assertEqual(reviews[0].verdict, "error")
            self.assertEqual(reviews[0].rationale, "llm_dspy_live_runtime_gate_blocked")
            self.assertEqual(reviews[0].response_json.get("fallback"), "veto")
            self.assertEqual(len(executions), 0)
            self.assertEqual(engine.review_calls, 0)

    def test_pipeline_llm_disabled_keeps_live_submission_operational(self) -> None:
        self.configure_settings(
            trading_enabled=True,
            trading_mode="live",
            trading_autonomy_allow_live_promotion=True,
            trading_simple_submit_enabled=True,
            trading_live_submit_enabled=True,
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
            llm_enabled=False,
            llm_shadow_mode=True,
            llm_dspy_runtime_mode="disabled",
            llm_dspy_artifact_hash=None,
        )

        with self.session_local() as session:
            strategy = make_strategy(
                name="demo",
                description="demo",
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.flush()
            self._activate_test_capital_authority(
                session,
                strategy=strategy,
                account_mode="live",
                account_label="live",
            )
            session.commit()

        signal = macd_buy_signal()

        pipeline = self.make_pipeline(
            order_firewall=OrderFirewall(FakeAlpacaClient(), account_label="live"),
            ingestor=FakeIngestor([signal]),
            account_label="live",
        )
        self._prime_test_capital_state(pipeline.state)
        pipeline._is_market_session_open = lambda _now=None: True

        self._seed_promotion_certificate_evidence()
        pipeline.run_once()

        with self.session_local() as session:
            llm_reviews = session.execute(select(LLMDecisionReview)).scalars().all()
            executions = session.execute(select(Execution)).scalars().all()

        self.assertEqual(llm_reviews, [])
        self.assertEqual(len(executions), 1)

    def test_pipeline_llm_dspy_unsupported_runtime_state_vetoes_in_live(self) -> None:
        class _UnavailableLiveRuntime:
            def evaluate_live_readiness(self) -> tuple[bool, tuple[str, ...]]:
                return False, ("dspy_runtime_disabled",)

        self.configure_settings(
            trading_enabled=True,
        )
        self.configure_settings(
            trading_mode="live",
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
            llm_enabled=True,
            llm_fail_mode="pass_through",
            llm_fail_mode_enforcement="configured",
            llm_fail_open_live_approved=True,
            llm_shadow_mode=False,
            llm_min_confidence=0.0,
            llm_dspy_runtime_mode="active",
            jangar_base_url="http://jangar.test",
            llm_dspy_artifact_hash="a" * 64,
            llm_rollout_stage="stage3",
        )
        self.configure_llm_guardrails()

        self.seed_demo_strategy()

        signal = macd_buy_signal()

        engine = CountingLLMReviewEngine(
            error=DSPyRuntimeUnsupportedStateError("dspy_runtime_disabled")
        )
        with patch(
            "app.trading.scheduler.pipeline.llm_review.DSPyReviewRuntime.from_settings",
            return_value=_UnavailableLiveRuntime(),
        ):
            pipeline = self.make_pipeline(
                ingestor=FakeIngestor([signal]),
                account_label="live",
                llm_review_engine=engine,
            )
            pipeline.run_once()

        with self.session_local() as session:
            reviews = session.execute(select(LLMDecisionReview)).scalars().all()
            executions = session.execute(select(Execution)).scalars().all()
            self.assertEqual(len(reviews), 1)
            self.assertEqual(reviews[0].verdict, "error")
            self.assertEqual(
                reviews[0].rationale,
                "llm_dspy_live_runtime_gate_blocked",
            )
            self.assertEqual(len(executions), 0)
            self.assertEqual(engine.review_calls, 0)

    def test_pipeline_llm_guardrails_force_shadow(self) -> None:
        self.configure_settings(
            trading_enabled=True,
            trading_mode="paper",
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
            llm_enabled=True,
            llm_shadow_mode=False,
            llm_min_confidence=0.0,
            llm_allowed_models_raw=None,
            llm_evaluation_report=None,
            llm_effective_challenge_id=None,
            llm_shadow_completed_at=None,
            llm_adjustment_approved=False,
        )

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
            llm_review_engine=FakeLLMReviewEngine(verdict="veto"),
        )
        self._prime_test_capital_state(pipeline.state)

        pipeline.run_once()

        with self.session_local() as session:
            reviews = session.execute(select(LLMDecisionReview)).scalars().all()
            decisions = session.execute(select(TradeDecision)).scalars().all()
            executions = session.execute(select(Execution)).scalars().all()
            self.assertEqual(len(reviews), 1)
            self.assertEqual(reviews[0].verdict, "veto")
            self.assertEqual(decisions[0].status, "submitted")
            self.assertEqual(len(executions), 1)
            self.assertEqual(pipeline.state.metrics.llm_guardrail_shadow_total, 1)

    def test_pipeline_llm_circuit_open(self) -> None:
        self.configure_settings(
            trading_enabled=True,
            trading_mode="paper",
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
            llm_enabled=True,
            llm_fail_mode="pass_through",
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
            executions = session.execute(select(Execution)).scalars().all()
            self.assertEqual(len(reviews), 1)
            self.assertEqual(reviews[0].verdict, "error")
            self.assertEqual(len(executions), 1)
            self.assertEqual(pipeline.state.metrics.llm_circuit_open_total, 1)
