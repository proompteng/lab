from __future__ import annotations

from tests.pipeline.trading_pipeline_base import (
    Decimal,
    DecisionEngine,
    Execution,
    FakeAlpacaClient,
    FakeIngestor,
    FakeLLMReviewEngine,
    LLMDecisionReview,
    OrderExecutor,
    OrderFirewall,
    Path,
    Reconciler,
    RiskEngine,
    SignalEnvelope,
    Strategy,
    TradeDecision,
    TradingPipeline,
    TradingPipelineTestCaseBase,
    TradingState,
    UniverseResolver,
    _build_dspy_lineage,
    _committee_trace_has_veto,
    _set_llm_guardrails,
    datetime,
    patch,
    select,
    tempfile,
    timezone,
)


class TestTradingPipelineExecutionLlmB(TradingPipelineTestCaseBase):
    def test_pipeline_llm_adjust(self) -> None:
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
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_adjustment_allowed": config.settings.llm_adjustment_allowed,
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
        config.settings.llm_adjustment_allowed = True
        _set_llm_guardrails(config, adjustment_approved=True)

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

            with tempfile.TemporaryDirectory() as tmpdir:
                gate_path = Path(tmpdir) / "gate-report.json"
                gate_path.write_text(
                    '{"uncertainty_gate_action":"pass"}', encoding="utf-8"
                )
                signal = SignalEnvelope(
                    event_ts=datetime.now(timezone.utc),
                    symbol="AAPL",
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
                    state=TradingState(last_autonomy_gates=str(gate_path)),
                    account_label="paper",
                    session_factory=self.session_local,
                    llm_review_engine=FakeLLMReviewEngine(
                        verdict="adjust",
                        adjusted_qty=Decimal("8"),
                        adjusted_order_type="limit",
                        limit_price=Decimal("101.5"),
                    ),
                )

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
            config.settings.llm_adjustment_allowed = original["llm_adjustment_allowed"]
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

    def test_pipeline_llm_failure_fallbacks(self) -> None:
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
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_live_submit_enabled = True
        config.settings.trading_testnet_after_hours_enabled = True
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
            config.settings.trading_mode = "paper"
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
                llm_review_engine=FakeLLMReviewEngine(error=RuntimeError("boom")),
            )
            pipeline.run_once()

            with self.session_local() as session:
                executions = session.execute(select(Execution)).scalars().all()
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                self.assertEqual(len(executions), 1)
                self.assertEqual(reviews[0].verdict, "error")
                self.assertEqual(
                    reviews[0].response_json.get("fallback"), "pass_through"
                )
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
                self.assertFalse(
                    committee_veto_alignment.get("deterministic_veto", True)
                )

            config.settings.trading_mode = "live"
            config.settings.trading_mode = "live"
            config.settings.trading_autonomy_allow_live_promotion = True
            live_signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.2, "signal": 0.3},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )
            live_alpaca = FakeAlpacaClient()
            pipeline_live = TradingPipeline(
                alpaca_client=live_alpaca,
                order_firewall=OrderFirewall(live_alpaca),
                ingestor=FakeIngestor([live_signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=live_alpaca,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="live",
                session_factory=self.session_local,
                llm_review_engine=FakeLLMReviewEngine(error=RuntimeError("boom")),
            )
            pipeline_live._is_market_session_open = lambda _now=None: False
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
                pipeline_live.run_once()

            with self.session_local() as session:
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(executions), 2)
                decisions = session.execute(select(TradeDecision)).scalars().all()
                self.assertEqual(decisions[-1].status, "submitted")
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
