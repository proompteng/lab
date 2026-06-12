from __future__ import annotations

# ruff: noqa: F403,F405
from tests.pipeline.trading_pipeline_base import *


class TestTradingPipelineDspyGateA(TradingPipelineTestCaseBase):
    def test_pipeline_llm_unsupported_runtime_state_vetoes_decision(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
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
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_fail_mode = "pass_through"
        config.settings.llm_fail_mode_enforcement = "configured"
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

            config.settings.trading_mode = "paper"
            config.settings.trading_live_enabled = False
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
                account_label="paper",
                session_factory=self.session_local,
                llm_review_engine=FakeLLMReviewEngine(
                    error=DSPyRuntimeUnsupportedStateError("dspy_runtime_disabled")
                ),
            )

            pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "error")
                self.assertEqual(reviews[0].response_json.get("fallback"), "veto")
                self.assertEqual(
                    reviews[0].response_json.get("effective_verdict"), "veto"
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
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]

    def test_pipeline_llm_unsupported_runtime_state_vetoes_decision_in_shadow_mode(
        self,
    ) -> None:
        from app import config

        class _UnavailableLiveRuntime:
            def evaluate_live_readiness(self) -> tuple[bool, tuple[str, ...]]:
                return False, ("dspy_runtime_disabled",)

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
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
            "jangar_base_url": config.settings.jangar_base_url,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_live_enabled = True
        config.settings.trading_autonomy_allow_live_promotion = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_fail_mode = "veto"
        config.settings.llm_fail_mode_enforcement = "strict_veto"
        config.settings.llm_shadow_mode = True
        config.settings.llm_min_confidence = 0.0
        config.settings.llm_dspy_runtime_mode = "active"
        config.settings.jangar_base_url = "http://jangar.test"
        config.settings.llm_dspy_artifact_hash = "a" * 64
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

            engine = CountingLLMReviewEngine(
                error=DSPyRuntimeUnsupportedStateError("dspy_runtime_disabled")
            )
            with patch(
                "app.trading.scheduler.pipeline.DSPyReviewRuntime.from_settings",
                return_value=_UnavailableLiveRuntime(),
            ):
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
                        "app.trading.scheduler.pipeline.build_hypothesis_runtime_summary",
                        return_value=eligible_summary,
                    ),
                    patch(
                        "app.trading.scheduler.pipeline.build_empirical_jobs_status",
                        return_value={"ready": True, "status": "healthy"},
                    ),
                    patch(
                        "app.trading.scheduler.pipeline.load_quant_evidence_status",
                        return_value=self._healthy_live_quant_status(),
                    ),
                ):
                    pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "error")
                self.assertEqual(reviews[0].response_json.get("fallback"), "veto")
                self.assertEqual(
                    reviews[0].response_json.get("effective_verdict"), "veto"
                )
                self.assertEqual(len(executions), 0)
                self.assertEqual(
                    reviews[0].rationale, "llm_dspy_live_runtime_gate_blocked"
                )
                self.assertEqual(engine.review_calls, 0)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
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
            config.settings.jangar_base_url = original["jangar_base_url"]

    def test_pipeline_llm_dspy_live_runtime_gate_allows_live_path(self) -> None:
        from app import config

        class _AvailableLiveRuntime:
            def evaluate_live_readiness(self) -> tuple[bool, tuple[str, ...]]:
                return True, ()

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
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
        config.settings.trading_autonomy_allow_live_promotion = True
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
        config.settings.llm_dspy_runtime_mode = "active"
        config.settings.jangar_base_url = "http://jangar.test"
        config.settings.llm_dspy_artifact_hash = "a" * 64
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
            with patch(
                "app.trading.scheduler.pipeline.DSPyReviewRuntime.from_settings",
                return_value=_AvailableLiveRuntime(),
            ):
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
                    "app.trading.scheduler.pipeline.build_hypothesis_runtime_summary",
                    return_value=eligible_summary,
                ),
                patch(
                    "app.trading.scheduler.pipeline.build_empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
                patch(
                    "app.trading.scheduler.pipeline.load_quant_evidence_status",
                    return_value=self._healthy_live_quant_status(),
                ),
            ):
                pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "error")
                self.assertEqual(
                    reviews[0].rationale, "llm_dspy_live_runtime_gate_blocked"
                )
                self.assertEqual(len(executions), 0)
                self.assertEqual(engine.review_calls, 0)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
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

    def test_pipeline_llm_dspy_live_runtime_readiness_blocked_without_dspy_live_artifact(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
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
        config.settings.trading_autonomy_allow_live_promotion = True
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

        class _UnavailableLiveRuntime:
            def evaluate_live_readiness(self) -> tuple[bool, tuple[str, ...]]:
                return False, ("dspy_active_mode_requires_dspy_live_executor",)

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
                "app.trading.scheduler.pipeline.DSPyReviewRuntime.from_settings",
                return_value=_UnavailableLiveRuntime(),
            ):
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
                self.assertEqual(len(executions), 0)
                self.assertEqual(engine.review_calls, 0)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
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
            config.settings.jangar_base_url = original["jangar_base_url"]

    def test_pipeline_llm_dspy_live_runtime_gate_blocks_when_stage_not_stage3(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
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
        config.settings.trading_autonomy_allow_live_promotion = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_fail_mode = "veto"
        config.settings.llm_fail_mode_enforcement = "strict_veto"
        config.settings.llm_shadow_mode = False
        config.settings.llm_min_confidence = 0.0
        config.settings.llm_dspy_runtime_mode = "active"
        config.settings.jangar_base_url = "http://jangar.test"
        config.settings.llm_dspy_artifact_hash = "a" * 64
        config.settings.llm_rollout_stage = "stage2"
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
                decisions = session.execute(select(TradeDecision)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(len(decisions), 1)
                self.assertEqual(reviews[0].verdict, "error")
                self.assertEqual(reviews[0].response_json.get("fallback"), "veto")
                self.assertEqual(
                    reviews[0].rationale, "llm_dspy_live_runtime_gate_blocked"
                )
                self.assertEqual(
                    reviews[0].response_json.get("llm_runtime", {}).get("subtype"),
                    "policy_blocked",
                )
                self.assertEqual(
                    decisions[0].decision_json.get("llm_runtime", {}).get("subtype"),
                    "policy_blocked",
                )
                self.assertEqual(len(executions), 0)
                self.assertEqual(engine.review_calls, 0)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
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
            config.settings.jangar_base_url = original["jangar_base_url"]

    def test_pipeline_llm_dspy_live_runtime_gate_blocked_in_live(self) -> None:
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
                self.assertEqual(reviews[0].response_json.get("fallback"), "veto")
                self.assertEqual(
                    reviews[0].rationale, "llm_dspy_live_runtime_gate_blocked"
                )
                llm_runtime = reviews[0].response_json.get("llm_runtime", {})
                self.assertEqual(
                    llm_runtime.get("reject_reason"),
                    "llm_runtime_fallback_policy_blocked",
                )
                self.assertEqual(llm_runtime.get("subtype"), "policy_blocked")
                self.assertIsInstance(llm_runtime.get("primary_reason"), str)
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
