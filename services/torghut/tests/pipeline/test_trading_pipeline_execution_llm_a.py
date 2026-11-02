from __future__ import annotations

from types import SimpleNamespace

from app.models import (
    BrokerMutationReceipt,
    BrokerMutationReceiptEvent,
    TradeDecisionSubmissionClaim,
)
from app.trading.scheduler.pipeline.contexts import OrderSubmissionRequest
from tests.pipeline.trading_pipeline_base import (
    AdaptiveExecutionPolicyDecision,
    CountingAlpacaClient,
    Decimal,
    DecisionEngine,
    Execution,
    FakeAlpacaClient,
    FakeIngestor,
    FakeLLMReviewEngine,
    FakePriceFetcher,
    LLMDecisionReview,
    OrderExecutor,
    OrderFirewall,
    Reconciler,
    RejectingAlpacaClient,
    RiskEngine,
    SellInventoryConflictAlpacaClient,
    SignalEnvelope,
    Strategy,
    StrategyDecision,
    TradeDecision,
    TradingPipeline,
    TradingPipelineTestCaseBase,
    TradingState,
    UniverseResolver,
    _set_llm_guardrails,
    datetime,
    patch,
    select,
    timezone,
)


class TestTradingPipelineExecutionLlmA(TradingPipelineTestCaseBase):
    def test_pipeline_persists_adaptive_policy_and_records_fallback_metric(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_mode = "paper"
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="adaptive-metrics",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                    "regime_label": "trend",
                },
                timeframe="1Min",
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
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=alpaca_client,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=state,
                account_label="paper",
                session_factory=self.session_local,
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
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]

    def test_pipeline_kill_switch_cancels_and_blocks_submissions(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_mode = "paper"
        config.settings.trading_kill_switch_enabled = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            alpaca_client = FakeAlpacaClient()
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=alpaca_client,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
            )

            pipeline.run_once()

            self.assertEqual(alpaca_client.cancel_all_calls, 1)
            self.assertEqual(len(alpaca_client.submitted), 0)
            self.assertEqual(pipeline.state.metrics.orders_rejected_total, 1)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]

    def test_pipeline_reuses_account_snapshot_within_reconcile_interval(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "trading_reconcile_ms": config.settings.trading_reconcile_ms,
        }
        config.settings.trading_enabled = False
        config.settings.trading_mode = "paper"
        config.settings.trading_mode = "paper"
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.trading_reconcile_ms = 60000

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            alpaca_client = CountingAlpacaClient()
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=alpaca_client,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
            )

            pipeline.run_once()
            pipeline.run_once()

            self.assertEqual(alpaca_client.account_calls, 1)
            self.assertEqual(alpaca_client.position_calls, 1)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.trading_reconcile_ms = original["trading_reconcile_ms"]

    def test_pipeline_persists_price_snapshot(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_mode = "paper"
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": Decimal("101.5"),
                    "spread": Decimal("0.02"),
                    "imbalance_bid_px": Decimal("101.49"),
                    "imbalance_ask_px": Decimal("101.51"),
                },
                timeframe="1Min",
            )

            alpaca_client = FakeAlpacaClient()
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=alpaca_client,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
                price_fetcher=FakePriceFetcher(
                    Decimal("101.5"), spread=Decimal("0.02")
                ),
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
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]

    def test_pipeline_llm_approve(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_fail_mode_enforcement": config.settings.llm_fail_mode_enforcement,
            "llm_abstain_fail_mode": config.settings.llm_abstain_fail_mode,
            "llm_escalate_fail_mode": config.settings.llm_escalate_fail_mode,
            "llm_quality_fail_mode": config.settings.llm_quality_fail_mode,
            "llm_fail_open_live_approved": config.settings.llm_fail_open_live_approved,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_fail_mode = "veto"
        config.settings.llm_fail_mode_enforcement = "strict_veto"
        config.settings.llm_abstain_fail_mode = "veto"
        config.settings.llm_escalate_fail_mode = "veto"
        config.settings.llm_quality_fail_mode = "veto"
        config.settings.llm_shadow_mode = False
        config.settings.llm_min_confidence = 0.0
        _set_llm_guardrails(config)

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.flush()
                self._activate_test_capital_authority(session, strategy=strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            alpaca_client = FakeAlpacaClient()
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=alpaca_client,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
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
                claim = session.execute(
                    select(TradeDecisionSubmissionClaim)
                ).scalar_one()
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
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_fail_mode = original["llm_fail_mode"]
            config.settings.llm_fail_mode_enforcement = original[
                "llm_fail_mode_enforcement"
            ]
            config.settings.llm_abstain_fail_mode = original["llm_abstain_fail_mode"]
            config.settings.llm_escalate_fail_mode = original["llm_escalate_fail_mode"]
            config.settings.llm_quality_fail_mode = original["llm_quality_fail_mode"]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]

    def test_pipeline_order_submit_rejection_does_not_crash_or_retry(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = False

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.flush()
                self._activate_test_capital_authority(session, strategy=strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            alpaca = RejectingAlpacaClient()
            pipeline = TradingPipeline(
                alpaca_client=alpaca,
                order_firewall=OrderFirewall(alpaca),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=alpaca,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
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
                claim = session.execute(
                    select(TradeDecisionSubmissionClaim)
                ).scalar_one()
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
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]

    def test_sell_inventory_conflict_does_not_cancel_existing_sell_order(self) -> None:
        with self.session_local() as session:
            strategy = Strategy(
                name="demo",
                description="demo",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
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
            pipeline = TradingPipeline(
                alpaca_client=alpaca,
                order_firewall=OrderFirewall(alpaca),
                ingestor=FakeIngestor([]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=executor,
                execution_adapter=alpaca,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
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
            strategy = Strategy(
                name="recovered-rejection",
                description="recovered broker rejection",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
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
            pipeline = TradingPipeline(
                alpaca_client=alpaca,
                order_firewall=OrderFirewall(alpaca),
                ingestor=FakeIngestor([]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=executor,
                execution_adapter=alpaca,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=state,
                account_label="paper",
                session_factory=self.session_local,
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
            strategy = Strategy(
                name="recovered-terminal",
                description="recovered terminal broker order",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
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
            pipeline = TradingPipeline(
                alpaca_client=alpaca,
                order_firewall=OrderFirewall(alpaca),
                ingestor=FakeIngestor([]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=executor,
                execution_adapter=alpaca,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=state,
                account_label="paper",
                session_factory=self.session_local,
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
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_mode = "paper"
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_min_confidence = 0.0
        _set_llm_guardrails(config)

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            alpaca_client = FakeAlpacaClient()
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=alpaca_client,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
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
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]
