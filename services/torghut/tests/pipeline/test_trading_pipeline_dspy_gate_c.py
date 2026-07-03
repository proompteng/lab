from __future__ import annotations

from tests.pipeline.trading_pipeline_base import (
    CountingLLMReviewEngine,
    DSPyReviewRuntime,
    Decimal,
    DecisionEngine,
    Execution,
    FakeAlpacaClient,
    FakeIngestor,
    LLMDecisionReview,
    OrderExecutor,
    OrderFirewall,
    PositionedAlpacaClient,
    Reconciler,
    RiskEngine,
    SignalEnvelope,
    SimulationExecutionAdapter,
    Strategy,
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


class TestTradingPipelineDspyGateC(TradingPipelineTestCaseBase):
    def test_pipeline_llm_dspy_live_runtime_gate_can_pass_through_with_degraded_qty(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_simple_submit_enabled": config.settings.trading_simple_submit_enabled,
            "trading_live_submit_enabled": config.settings.trading_live_submit_enabled,
            "trading_testnet_after_hours_enabled": config.settings.trading_testnet_after_hours_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_fail_mode_enforcement": config.settings.llm_fail_mode_enforcement,
            "llm_fail_open_live_approved": config.settings.llm_fail_open_live_approved,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_model_version_lock": config.settings.llm_model_version_lock,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
            "llm_dspy_runtime_mode": config.settings.llm_dspy_runtime_mode,
            "llm_dspy_artifact_hash": config.settings.llm_dspy_artifact_hash,
            "llm_dspy_program_name": config.settings.llm_dspy_program_name,
            "llm_dspy_signature_version": config.settings.llm_dspy_signature_version,
            "llm_rollout_stage": config.settings.llm_rollout_stage,
            "llm_dspy_live_runtime_block_fail_mode": config.settings.llm_dspy_live_runtime_block_fail_mode,
            "llm_dspy_live_runtime_block_qty_multiplier": config.settings.llm_dspy_live_runtime_block_qty_multiplier,
            "jangar_base_url": config.settings.jangar_base_url,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_mode = "live"
        config.settings.trading_autonomy_allow_live_promotion = True
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_live_submit_enabled = True
        config.settings.trading_testnet_after_hours_enabled = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_fail_mode = "pass_through"
        config.settings.llm_fail_mode_enforcement = "configured"
        config.settings.llm_fail_open_live_approved = True
        config.settings.llm_shadow_mode = False
        config.settings.llm_min_confidence = 0.0
        config.settings.llm_dspy_runtime_mode = "active"
        config.settings.jangar_base_url = "http://jangar.test"
        config.settings.llm_dspy_artifact_hash = (
            DSPyReviewRuntime.bootstrap_artifact_hash()
        )
        config.settings.llm_rollout_stage = "stage3"
        config.settings.llm_dspy_live_runtime_block_fail_mode = (
            "pass_through_reduced_size"
        )
        config.settings.llm_dspy_live_runtime_block_qty_multiplier = 0.5
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

            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="live",
                session_factory=self.session_local,
                llm_review_engine=CountingLLMReviewEngine(),
            )
            pipeline._is_market_session_open = lambda _now=None: False

            eligible_summary = {
                "promotion_eligible_total": 1,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            }
            self._seed_promotion_certificate_evidence()
            with (
                patch(
                    "app.trading.scheduler.pipeline.decision_lifecycle.build_hypothesis_runtime_summary",
                    return_value=eligible_summary,
                ),
                patch(
                    "app.trading.scheduler.pipeline.decision_lifecycle.build_empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
                patch(
                    "app.trading.scheduler.pipeline.decision_lifecycle.load_quant_evidence_status",
                    return_value=self._healthy_live_quant_status(),
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
                self.assertEqual(
                    reviews[0].response_json.get("fallback"), "pass_through"
                )
                self.assertEqual(decisions[0].status, "submitted")
                self.assertEqual(len(executions), 1)
                self.assertLess(executions[0].submitted_qty, Decimal("10"))
                self.assertGreaterEqual(executions[0].submitted_qty, Decimal("1"))
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            config.settings.trading_simple_submit_enabled = original[
                "trading_simple_submit_enabled"
            ]
            config.settings.trading_live_submit_enabled = original[
                "trading_live_submit_enabled"
            ]
            config.settings.trading_testnet_after_hours_enabled = original[
                "trading_testnet_after_hours_enabled"
            ]
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
            config.settings.llm_fail_open_live_approved = original[
                "llm_fail_open_live_approved"
            ]
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
            config.settings.llm_model_version_lock = original["llm_model_version_lock"]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]
            config.settings.llm_dspy_runtime_mode = original["llm_dspy_runtime_mode"]
            config.settings.llm_dspy_artifact_hash = original["llm_dspy_artifact_hash"]
            config.settings.llm_dspy_program_name = original["llm_dspy_program_name"]
            config.settings.llm_dspy_signature_version = original[
                "llm_dspy_signature_version"
            ]
            config.settings.llm_rollout_stage = original["llm_rollout_stage"]
            config.settings.llm_dspy_live_runtime_block_fail_mode = original[
                "llm_dspy_live_runtime_block_fail_mode"
            ]
            config.settings.llm_dspy_live_runtime_block_qty_multiplier = original[
                "llm_dspy_live_runtime_block_qty_multiplier"
            ]
            config.settings.jangar_base_url = original["jangar_base_url"]

    def test_pipeline_llm_shadow_bootstrap_artifact_keeps_live_submission_operational(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_simple_submit_enabled": config.settings.trading_simple_submit_enabled,
            "trading_live_submit_enabled": config.settings.trading_live_submit_enabled,
            "trading_testnet_after_hours_enabled": config.settings.trading_testnet_after_hours_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_fail_mode_enforcement": config.settings.llm_fail_mode_enforcement,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_model_version_lock": config.settings.llm_model_version_lock,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
            "llm_dspy_runtime_mode": config.settings.llm_dspy_runtime_mode,
            "llm_dspy_artifact_hash": config.settings.llm_dspy_artifact_hash,
            "llm_dspy_program_name": config.settings.llm_dspy_program_name,
            "llm_dspy_signature_version": config.settings.llm_dspy_signature_version,
            "llm_rollout_stage": config.settings.llm_rollout_stage,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_mode = "live"
        config.settings.trading_autonomy_allow_live_promotion = True
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_live_submit_enabled = True
        config.settings.trading_testnet_after_hours_enabled = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_fail_mode = "veto"
        config.settings.llm_fail_mode_enforcement = "strict_veto"
        config.settings.llm_shadow_mode = True
        config.settings.llm_min_confidence = 0.0
        config.settings.llm_dspy_runtime_mode = "shadow"
        config.settings.llm_dspy_artifact_hash = (
            DSPyReviewRuntime.bootstrap_artifact_hash()
        )
        config.settings.llm_rollout_stage = "stage3"
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

            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="live",
                session_factory=self.session_local,
            )
            pipeline._is_market_session_open = lambda _now=None: False

            eligible_summary = {
                "promotion_eligible_total": 1,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            }
            self._seed_promotion_certificate_evidence()
            with (
                patch(
                    "app.trading.scheduler.pipeline.decision_lifecycle.build_hypothesis_runtime_summary",
                    return_value=eligible_summary,
                ),
                patch(
                    "app.trading.scheduler.pipeline.decision_lifecycle.build_empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
                patch(
                    "app.trading.scheduler.pipeline.decision_lifecycle.load_quant_evidence_status",
                    return_value=self._healthy_live_quant_status(),
                ),
            ):
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
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_fail_mode = original["llm_fail_mode"]
            config.settings.llm_fail_mode_enforcement = original[
                "llm_fail_mode_enforcement"
            ]
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
            config.settings.llm_model_version_lock = original["llm_model_version_lock"]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]
            config.settings.llm_dspy_runtime_mode = original["llm_dspy_runtime_mode"]
            config.settings.llm_dspy_artifact_hash = original["llm_dspy_artifact_hash"]
            config.settings.llm_dspy_program_name = original["llm_dspy_program_name"]
            config.settings.llm_dspy_signature_version = original[
                "llm_dspy_signature_version"
            ]
            config.settings.llm_rollout_stage = original["llm_rollout_stage"]

    def test_pipeline_llm_dspy_runtime_reduced_sell_uses_seeded_simulation_inventory(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_simulation_enabled": config.settings.trading_simulation_enabled,
            "trading_simple_submit_enabled": config.settings.trading_simple_submit_enabled,
            "trading_live_submit_enabled": config.settings.trading_live_submit_enabled,
            "trading_testnet_after_hours_enabled": config.settings.trading_testnet_after_hours_enabled,
            "trading_allow_shorts": config.settings.trading_allow_shorts,
            "trading_fractional_equities_enabled": config.settings.trading_fractional_equities_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_fail_mode_enforcement": config.settings.llm_fail_mode_enforcement,
            "llm_fail_open_live_approved": config.settings.llm_fail_open_live_approved,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_model_version_lock": config.settings.llm_model_version_lock,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
            "llm_dspy_runtime_mode": config.settings.llm_dspy_runtime_mode,
            "llm_dspy_artifact_hash": config.settings.llm_dspy_artifact_hash,
            "llm_dspy_program_name": config.settings.llm_dspy_program_name,
            "llm_dspy_signature_version": config.settings.llm_dspy_signature_version,
            "llm_rollout_stage": config.settings.llm_rollout_stage,
            "llm_dspy_live_runtime_block_fail_mode": config.settings.llm_dspy_live_runtime_block_fail_mode,
            "llm_dspy_live_runtime_block_qty_multiplier": config.settings.llm_dspy_live_runtime_block_qty_multiplier,
            "jangar_base_url": config.settings.jangar_base_url,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_mode = "live"
        config.settings.trading_autonomy_allow_live_promotion = True
        config.settings.trading_simulation_enabled = True
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_live_submit_enabled = True
        config.settings.trading_testnet_after_hours_enabled = True
        config.settings.trading_allow_shorts = True
        config.settings.trading_fractional_equities_enabled = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_fail_mode = "pass_through"
        config.settings.llm_fail_mode_enforcement = "configured"
        config.settings.llm_fail_open_live_approved = True
        config.settings.llm_shadow_mode = False
        config.settings.llm_min_confidence = 0.0
        config.settings.llm_dspy_runtime_mode = "active"
        config.settings.jangar_base_url = "http://jangar.test"
        config.settings.llm_dspy_artifact_hash = (
            DSPyReviewRuntime.bootstrap_artifact_hash()
        )
        config.settings.llm_rollout_stage = "stage3"
        config.settings.llm_dspy_live_runtime_block_fail_mode = (
            "pass_through_reduced_size"
        )
        config.settings.llm_dspy_live_runtime_block_qty_multiplier = 0.5
        _set_llm_guardrails(config)

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo-sell",
                    description="demo sell",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("100"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 0.1, "signal": 0.4},
                    "rsi14": 75,
                    "price": 100,
                },
                timeframe="1Min",
            )

            alpaca_client = PositionedAlpacaClient(
                [{"symbol": "AAPL", "qty": "2", "side": "long"}]
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
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=execution_adapter,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="live",
                session_factory=self.session_local,
                llm_review_engine=CountingLLMReviewEngine(),
            )
            pipeline._is_market_session_open = lambda _now=None: False

            eligible_summary = {
                "promotion_eligible_total": 1,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            }
            self._seed_promotion_certificate_evidence()
            with (
                patch(
                    "app.trading.scheduler.pipeline.decision_lifecycle.build_hypothesis_runtime_summary",
                    return_value=eligible_summary,
                ),
                patch(
                    "app.trading.scheduler.pipeline.decision_lifecycle.build_empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
                patch(
                    "app.trading.scheduler.pipeline.decision_lifecycle.load_quant_evidence_status",
                    return_value=self._healthy_live_quant_status(),
                ),
                patch(
                    "app.trading.scheduler.pipeline.run_cycle.trading_now",
                    return_value=signal.event_ts,
                ),
                patch(
                    "app.trading.scheduler.pipeline.decision_lifecycle.trading_now",
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
                self.assertEqual(
                    reviews[0].response_json.get("fallback"), "pass_through"
                )
                self.assertEqual(decisions[0].status, "submitted")
                self.assertEqual(len(executions), 1)
                self.assertLess(executions[0].submitted_qty, Decimal("1"))
                remaining_qty = Decimal(
                    str(execution_adapter.list_positions()[0]["qty"])
                )
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
                        }
                    ],
                )
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            config.settings.trading_simulation_enabled = original[
                "trading_simulation_enabled"
            ]
            config.settings.trading_simple_submit_enabled = original[
                "trading_simple_submit_enabled"
            ]
            config.settings.trading_live_submit_enabled = original[
                "trading_live_submit_enabled"
            ]
            config.settings.trading_testnet_after_hours_enabled = original[
                "trading_testnet_after_hours_enabled"
            ]
            config.settings.trading_allow_shorts = original["trading_allow_shorts"]
            config.settings.trading_fractional_equities_enabled = original[
                "trading_fractional_equities_enabled"
            ]
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
            config.settings.llm_fail_open_live_approved = original[
                "llm_fail_open_live_approved"
            ]
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
            config.settings.llm_model_version_lock = original["llm_model_version_lock"]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]
            config.settings.llm_dspy_runtime_mode = original["llm_dspy_runtime_mode"]
            config.settings.llm_dspy_artifact_hash = original["llm_dspy_artifact_hash"]
            config.settings.llm_dspy_program_name = original["llm_dspy_program_name"]
            config.settings.llm_dspy_signature_version = original[
                "llm_dspy_signature_version"
            ]
            config.settings.llm_rollout_stage = original["llm_rollout_stage"]
            config.settings.llm_dspy_live_runtime_block_fail_mode = original[
                "llm_dspy_live_runtime_block_fail_mode"
            ]
            config.settings.llm_dspy_live_runtime_block_qty_multiplier = original[
                "llm_dspy_live_runtime_block_qty_multiplier"
            ]
            config.settings.jangar_base_url = original["jangar_base_url"]

    def test_pipeline_llm_dspy_live_runtime_gate_blocks_without_jangar_base_url(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_fail_mode_enforcement": config.settings.llm_fail_mode_enforcement,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_model_version_lock": config.settings.llm_model_version_lock,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
            "llm_dspy_runtime_mode": config.settings.llm_dspy_runtime_mode,
            "llm_dspy_artifact_hash": config.settings.llm_dspy_artifact_hash,
            "llm_dspy_program_name": config.settings.llm_dspy_program_name,
            "llm_dspy_signature_version": config.settings.llm_dspy_signature_version,
            "llm_rollout_stage": config.settings.llm_rollout_stage,
            "jangar_base_url": config.settings.jangar_base_url,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_mode = "live"
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_fail_mode = "veto"
        config.settings.llm_fail_mode_enforcement = "strict_veto"
        config.settings.llm_shadow_mode = False
        config.settings.llm_min_confidence = 0.0
        config.settings.llm_dspy_runtime_mode = "active"
        config.settings.llm_dspy_artifact_hash = "a" * 64
        config.settings.llm_rollout_stage = "stage3"
        config.settings.jangar_base_url = None
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

            engine = CountingLLMReviewEngine()
            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="live",
                session_factory=self.session_local,
                llm_review_engine=engine,
            )

            pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "error")
                self.assertEqual(
                    reviews[0].rationale, "llm_dspy_live_runtime_gate_blocked"
                )
                self.assertEqual(reviews[0].response_json.get("fallback"), "veto")
                self.assertEqual(len(executions), 0)
                self.assertEqual(engine.review_calls, 0)
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
            config.settings.llm_fail_mode = original["llm_fail_mode"]
            config.settings.llm_fail_mode_enforcement = original[
                "llm_fail_mode_enforcement"
            ]
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
            config.settings.llm_model_version_lock = original["llm_model_version_lock"]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]
            config.settings.llm_dspy_runtime_mode = original["llm_dspy_runtime_mode"]
            config.settings.llm_dspy_artifact_hash = original["llm_dspy_artifact_hash"]
            config.settings.llm_dspy_program_name = original["llm_dspy_program_name"]
            config.settings.llm_dspy_signature_version = original[
                "llm_dspy_signature_version"
            ]
            config.settings.llm_rollout_stage = original["llm_rollout_stage"]
            config.settings.jangar_base_url = original["jangar_base_url"]

    def test_pipeline_llm_disabled_keeps_live_submission_operational(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_simple_submit_enabled": config.settings.trading_simple_submit_enabled,
            "trading_live_submit_enabled": config.settings.trading_live_submit_enabled,
            "trading_testnet_after_hours_enabled": config.settings.trading_testnet_after_hours_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_dspy_runtime_mode": config.settings.llm_dspy_runtime_mode,
            "llm_dspy_artifact_hash": config.settings.llm_dspy_artifact_hash,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_mode = "live"
        config.settings.trading_autonomy_allow_live_promotion = True
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_live_submit_enabled = True
        config.settings.trading_testnet_after_hours_enabled = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = False
        config.settings.llm_shadow_mode = True
        config.settings.llm_dspy_runtime_mode = "disabled"
        config.settings.llm_dspy_artifact_hash = None

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

            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="live",
                session_factory=self.session_local,
            )
            pipeline._is_market_session_open = lambda _now=None: False

            eligible_summary = {
                "promotion_eligible_total": 1,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            }
            self._seed_promotion_certificate_evidence()
            with (
                patch(
                    "app.trading.scheduler.pipeline.decision_lifecycle.build_hypothesis_runtime_summary",
                    return_value=eligible_summary,
                ),
                patch(
                    "app.trading.scheduler.pipeline.decision_lifecycle.build_empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
                patch(
                    "app.trading.scheduler.pipeline.decision_lifecycle.load_quant_evidence_status",
                    return_value=self._healthy_live_quant_status(),
                ),
            ):
                pipeline.run_once()

            with self.session_local() as session:
                llm_reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()

            self.assertEqual(llm_reviews, [])
            self.assertEqual(len(executions), 1)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            config.settings.trading_simple_submit_enabled = original[
                "trading_simple_submit_enabled"
            ]
            config.settings.trading_live_submit_enabled = original[
                "trading_live_submit_enabled"
            ]
            config.settings.trading_testnet_after_hours_enabled = original[
                "trading_testnet_after_hours_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]
            config.settings.llm_dspy_runtime_mode = original["llm_dspy_runtime_mode"]
            config.settings.llm_dspy_artifact_hash = original["llm_dspy_artifact_hash"]
