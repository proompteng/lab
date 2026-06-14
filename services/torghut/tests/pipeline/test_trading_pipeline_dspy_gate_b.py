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
    Reconciler,
    RiskEngine,
    SignalEnvelope,
    Strategy,
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


class TestTradingPipelineDspyGateB(TradingPipelineTestCaseBase):
    def test_classify_dspy_live_runtime_block_distinguishes_artifact_and_runtime_causes(
        self,
    ) -> None:
        artifact = TradingPipeline._classify_dspy_live_runtime_block(
            ("dspy_bootstrap_artifact_forbidden",)
        )
        runtime = TradingPipeline._classify_dspy_live_runtime_block(
            ("dspy_live_readiness_error:TimeoutError",)
        )

        self.assertEqual(
            artifact, ("llm_runtime_fallback_artifact_invalid", "artifact_invalid")
        )
        self.assertEqual(
            runtime, ("llm_runtime_fallback_runtime_not_ready", "runtime_not_ready")
        )

    def test_pipeline_llm_dspy_live_runtime_gate_blocks_malformed_artifact_hash(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
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
        config.settings.trading_live_enabled = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_fail_mode = "veto"
        config.settings.llm_fail_mode_enforcement = "strict_veto"
        config.settings.llm_shadow_mode = False
        config.settings.llm_min_confidence = 0.0
        config.settings.llm_dspy_runtime_mode = "active"
        config.settings.llm_dspy_artifact_hash = "not-a-valid-hex-hash"
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

            with patch(
                "app.trading.scheduler.pipeline_modules.llm_review.DSPyReviewRuntime.from_settings"
            ) as from_settings:
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
                pipeline.run_once()
                from_settings.assert_not_called()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "error")
                self.assertEqual(
                    reviews[0].rationale, "llm_dspy_live_runtime_gate_blocked"
                )
                self.assertEqual(len(executions), 0)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
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

    def test_pipeline_llm_dspy_live_runtime_gate_blocks_before_readiness_probe(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
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
        config.settings.trading_live_enabled = True
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
        _set_llm_guardrails(config)
        config.settings.llm_model_version_lock = "mismatch-model:v2"

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
            with patch(
                "app.trading.scheduler.pipeline_modules.llm_review.DSPyReviewRuntime.from_settings"
            ) as from_settings:
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
                from_settings.assert_not_called()

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
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
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

    def test_pipeline_llm_dspy_live_runtime_gate_blocks_bootstrap_artifact_hash(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
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
        config.settings.trading_live_enabled = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_fail_mode = "veto"
        config.settings.llm_fail_mode_enforcement = "strict_veto"
        config.settings.llm_shadow_mode = False
        config.settings.llm_min_confidence = 0.0
        config.settings.llm_dspy_runtime_mode = "active"
        config.settings.jangar_base_url = "http://jangar.test"
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
            config.settings.trading_live_enabled = original["trading_live_enabled"]
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
