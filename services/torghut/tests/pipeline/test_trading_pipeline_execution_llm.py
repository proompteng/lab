from __future__ import annotations

import tempfile
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from sqlalchemy import select

from app.models import (
    BrokerMutationReceipt,
    BrokerMutationReceiptEvent,
    Execution,
    LLMDecisionReview,
    Strategy,
    TradeDecision,
    TradeDecisionSubmissionClaim,
)
from app.trading.execution import OrderExecutor
from app.trading.firewall import OrderFirewall
from app.trading.models import StrategyDecision
from app.trading.scheduler.pipeline.contexts import OrderSubmissionRequest
from app.trading.scheduler.pipeline_helpers import (
    _build_dspy_lineage,
    _committee_trace_has_veto,
)
from app.trading.scheduler.state import TradingState
from app.trading.tca import AdaptiveExecutionPolicyDecision
from tests.pipeline.trading_pipeline_base import TradingPipelineTestCaseBase
from tests.pipeline.trading_pipeline_support import (
    CountingAlpacaClient,
    FakeAlpacaClient,
    FakeIngestor,
    FakeLLMReviewEngine,
    FakePriceFetcher,
    RejectingAlpacaClient,
    SellInventoryConflictAlpacaClient,
)
from tests.trading_fixtures import macd_buy_signal, make_signal, make_strategy


class TestTradingPipelineExecutionLLM(TradingPipelineTestCaseBase):
    def test_pipeline_persists_adaptive_policy_and_records_fallback_metric(
        self,
    ) -> None:
        self.configure_settings(
            trading_enabled=True,
        )
        self.configure_settings(
            trading_mode="paper",
            trading_kill_switch_enabled=False,
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
        )

        with self.session_local() as session:
            strategy = make_strategy(
                name="demo",
                description="adaptive-metrics",
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        signal = make_signal(
            datetime.now(timezone.utc),
            payload={
                "macd": {"macd": 1.1, "signal": 0.4},
                "rsi14": 25,
                "price": 100,
                "regime_label": "trend",
            },
        )

        fallback_policy = AdaptiveExecutionPolicyDecision(
            key="AAPL:trend",
            symbol="AAPL",
            regime_label="trend",
            sample_size=12,
            adaptive_samples=8,
            baseline_slippage_bps=Decimal("8"),
            recent_slippage_bps=Decimal("16"),
            baseline_shortfall_notional=Decimal("1"),
            recent_shortfall_notional=Decimal("4"),
            effect_size_bps=Decimal("-8"),
            degradation_bps=Decimal("8"),
            expected_shortfall_coverage=Decimal("1"),
            expected_shortfall_sample_count=12,
            fallback_active=True,
            fallback_reason="adaptive_policy_degraded",
            prefer_limit=True,
            participation_rate_scale=Decimal("0.8"),
            execution_seconds_scale=Decimal("1.2"),
            aggressiveness="defensive",
            generated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )

        state = TradingState()
        alpaca_client = FakeAlpacaClient()
        pipeline = self.make_pipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([signal]),
            execution_adapter=alpaca_client,
            state=state,
        )

        with patch(
            "app.trading.scheduler.pipeline.submission_policy.derive_adaptive_execution_policy",
            return_value=fallback_policy,
        ):
            pipeline.run_once()

        with self.session_local() as session:
            decision_row = session.execute(select(TradeDecision)).scalar_one()
            decision_json = decision_row.decision_json
            assert isinstance(decision_json, dict)
            params = decision_json.get("params")
            assert isinstance(params, dict)
            execution_policy = params.get("execution_policy")
            assert isinstance(execution_policy, dict)
            adaptive = execution_policy.get("adaptive")
            assert isinstance(adaptive, dict)
            self.assertFalse(adaptive.get("applied"))
            self.assertEqual(adaptive.get("reason"), "adaptive_policy_degraded")

        self.assertEqual(state.metrics.adaptive_policy_decisions_total, 1)
        self.assertEqual(state.metrics.adaptive_policy_fallback_total, 1)
        self.assertEqual(state.metrics.adaptive_policy_applied_total, 0)

    def test_pipeline_kill_switch_cancels_and_blocks_submissions(self) -> None:
        self.configure_settings(
            trading_enabled=True,
        )
        self.configure_settings(
            trading_mode="paper",
            trading_kill_switch_enabled=True,
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
        )

        self.seed_demo_strategy()

        signal = macd_buy_signal()

        alpaca_client = FakeAlpacaClient()
        pipeline = self.make_pipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([signal]),
            execution_adapter=alpaca_client,
        )

        pipeline.run_once()

        self.assertEqual(alpaca_client.cancel_all_calls, 1)
        self.assertEqual(len(alpaca_client.submitted), 0)
        self.assertEqual(pipeline.state.metrics.orders_rejected_total, 1)

    def test_pipeline_reuses_account_snapshot_within_reconcile_interval(self) -> None:
        self.configure_settings(
            trading_enabled=False,
        )
        self.configure_settings(
            trading_mode="paper",
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
            trading_reconcile_ms=60000,
        )

        self.seed_demo_strategy()

        signal = macd_buy_signal()

        alpaca_client = CountingAlpacaClient()
        pipeline = self.make_pipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([signal]),
            execution_adapter=alpaca_client,
        )

        pipeline.run_once()
        pipeline.run_once()

        self.assertEqual(alpaca_client.account_calls, 1)
        self.assertEqual(alpaca_client.position_calls, 1)

    def test_pipeline_persists_price_snapshot(self) -> None:
        self.configure_settings(
            trading_enabled=True,
        )
        self.configure_settings(
            trading_mode="paper",
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
        )

        self.seed_demo_strategy()

        signal = make_signal(
            datetime.now(timezone.utc),
            payload={
                "macd": {"macd": 1.1, "signal": 0.4},
                "rsi14": 25,
                "price": Decimal("101.5"),
                "spread": Decimal("0.02"),
                "imbalance_bid_px": Decimal("101.49"),
                "imbalance_ask_px": Decimal("101.51"),
            },
        )

        alpaca_client = FakeAlpacaClient()
        pipeline = self.make_pipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([signal]),
            execution_adapter=alpaca_client,
            price_fetcher=FakePriceFetcher(Decimal("101.5"), spread=Decimal("0.02")),
        )

        pipeline.run_once()

        with self.session_local() as session:
            decisions = session.execute(select(TradeDecision)).scalars().all()
            self.assertEqual(len(decisions), 1)
            decision_json = decisions[0].decision_json
            params = decision_json.get("params", {})
            self.assertEqual(params.get("price"), "101.5")
            snapshot = params.get("price_snapshot", {})
            self.assertEqual(snapshot.get("price"), "101.5")
            self.assertEqual(snapshot.get("source"), "price_fetcher")

    def test_pipeline_llm_approve(self) -> None:
        self.configure_settings(
            trading_enabled=True,
            trading_mode="paper",
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
            llm_enabled=True,
            llm_fail_mode="veto",
            llm_fail_mode_enforcement="strict_veto",
            llm_abstain_fail_mode="veto",
            llm_escalate_fail_mode="veto",
            llm_quality_fail_mode="veto",
            llm_shadow_mode=False,
            llm_min_confidence=0.0,
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
            llm_review_engine=FakeLLMReviewEngine(verdict="approve"),
        )
        self._prime_test_capital_state(pipeline.state)

        pipeline.run_once()

        with self.session_local() as session:
            reviews = session.execute(select(LLMDecisionReview)).scalars().all()
            executions = session.execute(select(Execution)).scalars().all()
            self.assertEqual(len(reviews), 1)
            self.assertEqual(reviews[0].verdict, "approve")
            self.assertEqual(len(executions), 1)
            claim = session.execute(select(TradeDecisionSubmissionClaim)).scalar_one()
            receipt = session.execute(select(BrokerMutationReceipt)).scalar_one()
            terminal_event = session.execute(
                select(BrokerMutationReceiptEvent)
                .where(BrokerMutationReceiptEvent.receipt_id == receipt.id)
                .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
                .limit(1)
            ).scalar_one()
            self.assertEqual(claim.state, "submitted")
            self.assertEqual(claim.execution_id, executions[0].id)
            self.assertEqual(terminal_event.state, "settled")
            self.assertEqual(terminal_event.execution_id, executions[0].id)

    def test_pipeline_order_submit_rejection_does_not_crash_or_retry(self) -> None:
        self.configure_settings(
            trading_enabled=True,
            trading_mode="paper",
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
            llm_enabled=False,
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

        alpaca = RejectingAlpacaClient()
        pipeline = self.make_pipeline(
            alpaca_client=alpaca,
            order_firewall=OrderFirewall(alpaca),
            ingestor=FakeIngestor([signal]),
            execution_adapter=alpaca,
        )
        self._prime_test_capital_state(pipeline.state)

        pipeline.run_once()
        pipeline.run_once()

        self.assertEqual(alpaca.submit_calls, 1)
        self.assertEqual(alpaca.cancel_calls, [])

        with self.session_local() as session:
            decisions = session.execute(select(TradeDecision)).scalars().all()
            executions = session.execute(select(Execution)).scalars().all()
            self.assertEqual(len(decisions), 1)
            self.assertNotEqual(decisions[0].status, "rejected")
            self.assertEqual(
                decisions[0].decision_json.get("submission_stage"),
                "broker_io_unresolved",
            )
            self.assertEqual(len(executions), 0)
            claim = session.execute(select(TradeDecisionSubmissionClaim)).scalar_one()
            receipt = session.execute(select(BrokerMutationReceipt)).scalar_one()
            latest_event = session.execute(
                select(BrokerMutationReceiptEvent)
                .where(BrokerMutationReceiptEvent.receipt_id == receipt.id)
                .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
                .limit(1)
            ).scalar_one()
            self.assertEqual(claim.state, "broker_io")
            self.assertEqual(latest_event.state, "broker_io")
            self.assertIsNone(latest_event.settled_at)

    def test_sell_inventory_conflict_does_not_cancel_existing_sell_order(self) -> None:
        with self.session_local() as session:
            strategy = make_strategy(
                name="demo",
                description="demo",
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime.now(timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("1"),
                params={"price": Decimal("100")},
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session, decision, strategy, "paper"
            )

            alpaca = SellInventoryConflictAlpacaClient()
            pipeline = self.make_pipeline(
                alpaca_client=alpaca,
                order_firewall=OrderFirewall(alpaca),
                executor=executor,
                execution_adapter=alpaca,
            )

            execution, rejected = pipeline._submit_order_with_handling(
                OrderSubmissionRequest(
                    session=session,
                    execution_client=alpaca,
                    decision=decision,
                    decision_row=decision_row,
                    selected_adapter_name="alpaca",
                )
            )

            self.assertIsNone(execution)
            self.assertTrue(rejected)
            self.assertEqual(alpaca.cancel_calls, [])

            session.refresh(decision_row)
            self.assertEqual(decision_row.status, "rejected")
            self.assertEqual(
                decision_row.decision_json.get("reject_reason_atomic"),
                ["sell_inventory_unavailable"],
            )
            self.assertEqual(
                decision_row.decision_json.get("broker_precheck", {}).get("code"),
                "precheck_sell_qty_exceeds_available",
            )
            self.assertNotIn("broker_precheck_recovery", decision_row.decision_json)

    def test_recovered_broker_rejection_is_not_reported_as_submitted(self) -> None:
        with self.session_local() as session:
            strategy = make_strategy(
                name="recovered-rejection",
                description="recovered broker rejection",
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime.now(timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("1"),
                params={"price": Decimal("100")},
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session,
                decision,
                strategy,
                "paper",
            )
            alpaca = FakeAlpacaClient()
            state = TradingState()
            pipeline = self.make_pipeline(
                alpaca_client=alpaca,
                order_firewall=OrderFirewall(alpaca),
                executor=executor,
                execution_adapter=alpaca,
                state=state,
            )

            def recover_rejected_order(*_args: object, **_kwargs: object) -> None:
                decision_json = dict(decision_row.decision_json)
                decision_json["submission_stage"] = "rejected"
                decision_row.status = "rejected"
                decision_row.decision_json = decision_json
                session.add(decision_row)
                session.commit()
                return None

            with patch.object(
                executor,
                "submit_order",
                side_effect=recover_rejected_order,
            ):
                execution, rejected = pipeline._submit_order_with_handling(
                    OrderSubmissionRequest(
                        session=session,
                        execution_client=alpaca,
                        decision=decision,
                        decision_row=decision_row,
                        selected_adapter_name="alpaca",
                    )
                )

            self.assertIsNone(execution)
            self.assertTrue(rejected)
            self.assertEqual(decision_row.status, "rejected")
            self.assertEqual(
                decision_row.decision_json.get("submission_stage"),
                "rejected",
            )
            self.assertEqual(state.metrics.orders_submitted_total, 0)
            self.assertEqual(state.metrics.orders_rejected_total, 1)
            self.assertEqual(
                state.metrics.decision_reject_reason_total.get("broker_rejected"),
                1,
            )

    def test_recovered_terminal_order_is_not_reported_as_submitted(self) -> None:
        with self.session_local() as session:
            strategy = make_strategy(
                name="recovered-terminal",
                description="recovered terminal broker order",
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime.now(timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("1"),
                params={"price": Decimal("100")},
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session,
                decision,
                strategy,
                "paper",
            )
            alpaca = FakeAlpacaClient()
            state = TradingState()
            pipeline = self.make_pipeline(
                alpaca_client=alpaca,
                order_firewall=OrderFirewall(alpaca),
                executor=executor,
                execution_adapter=alpaca,
                state=state,
            )
            terminal_execution = SimpleNamespace(
                id="recovered-terminal-execution",
                status="canceled",
                filled_qty=Decimal("0"),
                raw_order={},
                execution_audit_json={},
                execution_correlation_id=None,
                execution_idempotency_key=None,
                execution_fallback_reason=None,
            )

            with patch.object(
                executor,
                "submit_order",
                return_value=terminal_execution,
            ):
                execution, rejected = pipeline._submit_order_with_handling(
                    OrderSubmissionRequest(
                        session=session,
                        execution_client=alpaca,
                        decision=decision,
                        decision_row=decision_row,
                        selected_adapter_name="alpaca",
                    )
                )

            self.assertIs(execution, terminal_execution)
            self.assertTrue(rejected)
            self.assertEqual(state.metrics.orders_submitted_total, 0)
            self.assertEqual(state.metrics.orders_rejected_total, 1)
            self.assertEqual(
                state.metrics.decision_reject_reason_total.get(
                    "order_terminal_unfilled_canceled"
                ),
                1,
            )
            session.refresh(decision_row)
            self.assertEqual(decision_row.status, "rejected")
            self.assertEqual(
                decision_row.decision_json.get("submission_stage"),
                "rejected_unfilled",
            )

    def test_pipeline_llm_veto(self) -> None:
        self.configure_settings(
            trading_enabled=True,
        )
        self.configure_settings(
            trading_mode="paper",
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
            llm_enabled=True,
            llm_min_confidence=0.0,
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
            llm_review_engine=FakeLLMReviewEngine(verdict="veto"),
        )

        pipeline.run_once()

        with self.session_local() as session:
            decisions = session.execute(select(TradeDecision)).scalars().all()
            reviews = session.execute(select(LLMDecisionReview)).scalars().all()
            executions = session.execute(select(Execution)).scalars().all()
            self.assertEqual(len(reviews), 1)
            self.assertEqual(reviews[0].verdict, "veto")
            self.assertEqual(decisions[0].status, "rejected")
            self.assertEqual(len(executions), 0)

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

    def test_pipeline_llm_adjust(self) -> None:
        self.configure_settings(
            trading_enabled=True,
            trading_mode="paper",
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
            llm_enabled=True,
            llm_min_confidence=0.0,
            llm_adjustment_allowed=True,
        )
        self.configure_llm_guardrails(adjustment_approved=True)

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
                    adjusted_qty=Decimal("8"),
                    adjusted_order_type="limit",
                    limit_price=Decimal("101.5"),
                ),
            )
            self._prime_test_capital_state(pipeline.state)

            pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                decisions = session.execute(select(TradeDecision)).scalars().all()
                self.assertEqual(reviews[0].verdict, "adjust")
                self.assertEqual(reviews[0].adjusted_qty, Decimal("8"))
                self.assertEqual(len(executions), 1)
                self.assertEqual(executions[0].submitted_qty, Decimal("8"))
                decision_json = decisions[0].decision_json
                self.assertIn("llm_adjusted_decision", decision_json)
                self.assertEqual(decision_json["llm_adjusted_decision"]["qty"], "8")

    def test_pipeline_llm_failure_fallbacks(self) -> None:
        from app import config

        self.configure_settings(
            trading_enabled=True,
            trading_simple_submit_enabled=True,
            trading_live_submit_enabled=True,
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
            llm_enabled=True,
            llm_fail_mode="pass_through",
            llm_fail_mode_enforcement="configured",
            llm_shadow_mode=False,
            llm_min_confidence=0.0,
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

        self.configure_settings(
            trading_mode="paper",
        )
        alpaca_client = FakeAlpacaClient()
        pipeline = self.make_pipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([signal]),
            execution_adapter=alpaca_client,
            llm_review_engine=FakeLLMReviewEngine(error=RuntimeError("boom")),
        )
        self._prime_test_capital_state(pipeline.state)
        pipeline.run_once()

        with self.session_local() as session:
            executions = session.execute(select(Execution)).scalars().all()
            reviews = session.execute(select(LLMDecisionReview)).scalars().all()
            self.assertEqual(len(executions), 1)
            self.assertEqual(reviews[0].verdict, "error")
            self.assertEqual(reviews[0].response_json.get("fallback"), "pass_through")
            self.assertEqual(
                reviews[0].response_json.get("effective_verdict"), "approve"
            )
            policy_resolution = reviews[0].response_json.get("policy_resolution")
            self.assertIsInstance(policy_resolution, dict)
            assert isinstance(policy_resolution, dict)
            self.assertIn("effective_fail_mode", policy_resolution)
            self.assertIn("reasoning", policy_resolution)
            lineage = reviews[0].response_json.get("dspy_lineage")
            self.assertIsInstance(lineage, dict)
            assert isinstance(lineage, dict)
            self.assertEqual(
                lineage.get("program_name"),
                config.settings.llm_dspy_program_name,
            )
            self.assertEqual(
                lineage.get("signature_version"),
                config.settings.llm_dspy_signature_version,
            )
            configured_artifact_hash = config.settings.llm_dspy_artifact_hash
            if isinstance(configured_artifact_hash, str):
                expected_artifact_hash = configured_artifact_hash.strip() or None
            else:
                expected_artifact_hash = None
            self.assertEqual(lineage.get("artifact_hash"), expected_artifact_hash)
            committee_veto_alignment = reviews[0].response_json.get(
                "committee_veto_alignment"
            )
            self.assertIsInstance(committee_veto_alignment, dict)
            assert isinstance(committee_veto_alignment, dict)
            self.assertFalse(committee_veto_alignment.get("committee_veto", True))
            self.assertFalse(committee_veto_alignment.get("deterministic_veto", True))

        self.configure_settings(
            trading_mode="live",
            trading_autonomy_allow_live_promotion=True,
        )
        with self.session_local() as session:
            strategy = session.execute(
                select(Strategy).where(Strategy.name == "demo")
            ).scalar_one()
            self._activate_test_capital_authority(
                session,
                strategy=strategy,
                account_mode="live",
                account_label="live",
            )
            session.commit()
        live_signal = make_signal(
            datetime.now(timezone.utc),
            payload={
                "macd": {"macd": 1.2, "signal": 0.3},
                "rsi14": 25,
                "price": 100,
            },
        )
        live_alpaca = FakeAlpacaClient()
        pipeline_live = self.make_pipeline(
            alpaca_client=live_alpaca,
            order_firewall=OrderFirewall(live_alpaca, account_label="live"),
            ingestor=FakeIngestor([live_signal]),
            execution_adapter=live_alpaca,
            account_label="live",
            llm_review_engine=FakeLLMReviewEngine(error=RuntimeError("boom")),
        )
        self._prime_test_capital_state(pipeline_live.state)
        pipeline_live._is_market_session_open = lambda _now=None: True
        self._seed_promotion_certificate_evidence()
        pipeline_live.run_once()

        with self.session_local() as session:
            executions = session.execute(select(Execution)).scalars().all()
            self.assertEqual(len(executions), 2)
            decisions = session.execute(select(TradeDecision)).scalars().all()
            self.assertEqual(decisions[-1].status, "submitted")

    def test_committee_veto_detection_helper(self) -> None:
        with_veto = {
            "committee": {
                "roles": {
                    "risk_critic": {"verdict": "veto"},
                    "execution_critic": {"verdict": "approve"},
                }
            }
        }
        without_veto = {
            "committee": {
                "roles": {
                    "risk_critic": {"verdict": "approve"},
                    "execution_critic": {"verdict": "adjust"},
                }
            }
        }

        self.assertTrue(_committee_trace_has_veto(with_veto))
        self.assertFalse(_committee_trace_has_veto(without_veto))
        self.assertFalse(_committee_trace_has_veto({}))

    def test_dspy_lineage_helper_uses_response_payload(self) -> None:
        response_json = {
            "dspy": {
                "mode": "active",
                "program_name": "trade-review-committee-v9",
                "signature_version": "2026-03-03.v9",
                "artifact_hash": "f" * 64,
                "artifact_source": "runtime_fallback",
            }
        }

        lineage = _build_dspy_lineage(response_json)

        self.assertEqual(lineage["mode"], "active")
        self.assertEqual(lineage["program_name"], "trade-review-committee-v9")
        self.assertEqual(lineage["signature_version"], "2026-03-03.v9")
        self.assertEqual(lineage["artifact_hash"], "f" * 64)
        self.assertEqual(lineage["artifact_source"], "runtime_fallback")
