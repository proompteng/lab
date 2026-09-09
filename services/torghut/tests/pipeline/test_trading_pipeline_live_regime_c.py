from __future__ import annotations

from tests.pipeline.trading_pipeline_base import (
    Decimal,
    DecisionEngine,
    FakeAlpacaClient,
    FakeIngestor,
    OrderExecutor,
    OrderFirewall,
    Path,
    Reconciler,
    RiskEngine,
    SignalEnvelope,
    Strategy,
    StrategyDecision,
    TradeDecision,
    TradingPipeline,
    TradingPipelineTestCaseBase,
    TradingState,
    UniverseResolver,
    datetime,
    json,
    select,
    tempfile,
    timedelta,
    timezone,
)


class TestTradingPipelineLiveRegimeC(TradingPipelineTestCaseBase):
    def test_pipeline_runtime_uncertainty_saturated_fail_sentinel_degrades(
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
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                with self.session_local() as session:
                    strategy = Strategy(
                        name="demo",
                        description="runtime-gate-sentinel",
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

                gate_path = Path(tmpdir) / "gate-report.json"
                gate_path.write_text(
                    json.dumps(
                        {
                            "generated_at": datetime.now(timezone.utc).isoformat(),
                            "uncertainty_gate_action": "fail",
                            "coverage_error": "1",
                            "shift_score": "1",
                            "conformal_interval_width": "0",
                        }
                    ),
                    encoding="utf-8",
                )
                signal = SignalEnvelope(
                    event_ts=datetime.now(timezone.utc),
                    symbol="AAPL",
                    payload={
                        "macd": {"macd": 1.2, "signal": 0.5},
                        "rsi14": 25,
                        "price": 100,
                    },
                    timeframe="1Min",
                )
                state = TradingState(last_autonomy_gates=str(gate_path))
                self._prime_test_capital_state(state)
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

                pipeline.run_once()

                with self.session_local() as session:
                    decisions = session.execute(select(TradeDecision)).scalars().all()
                    self.assertEqual(len(decisions), 1)
                    self.assertNotEqual(decisions[0].status, "rejected")
                    decision_json = decisions[0].decision_json
                    assert isinstance(decision_json, dict)
                    self.assertNotIn(
                        "runtime_uncertainty_gate_fail_block_new_entries",
                        decision_json.get("risk_reasons", []),
                    )
                    params = decision_json.get("params")
                    assert isinstance(params, dict)
                    gate_payload = params.get("runtime_uncertainty_gate")
                    assert isinstance(gate_payload, dict)
                    self.assertEqual(gate_payload.get("action"), "degrade")
                    self.assertEqual(
                        gate_payload.get("source"),
                        "autonomy_gate_report_saturated_fail_sentinel",
                    )

                self.assertEqual(len(alpaca_client.submitted), 1)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
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

    def test_runtime_uncertainty_gate_resolves_strictest_action_across_sources(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            gate_path = Path(tmpdir) / "gate-report.json"
            gate_path.write_text(
                '{"uncertainty_gate_action":"fail","coverage_error":"0.11","shift_score":"0.96"}',
                encoding="utf-8",
            )
            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(last_autonomy_gates=str(gate_path)),
                account_label="paper",
                session_factory=self.session_local,
            )
            decision = StrategyDecision(
                strategy_id="strategy",
                symbol="AAPL",
                event_ts=datetime.now(timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("1"),
                params={
                    "uncertainty_gate_action": "pass",
                    "runtime_uncertainty_gate": {"action": "degrade"},
                    "forecast_audit": {"uncertainty_gate_action": "abstain"},
                },
            )

            gate = pipeline._resolve_runtime_uncertainty_gate(decision)

            self.assertEqual(gate.action, "fail")
            self.assertEqual(gate.source, "autonomy_gate_report")

    def test_pipeline_runtime_uncertainty_gate_defaults_degrade_when_inputs_missing(
        self,
    ) -> None:
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={},
        )

        gate, _runtime_payload = (
            pipeline._resolve_runtime_uncertainty_gate_from_inputs(decision),
            pipeline._resolve_runtime_uncertainty_gate(decision),
        )
        self.assertEqual(gate.action, "degrade")
        self.assertEqual(gate.source, "uncertainty_input_missing")
        self.assertEqual(_runtime_payload.action, "degrade")
        self.assertEqual(_runtime_payload.source, "uncertainty_input_missing")

    def test_pipeline_runtime_uncertainty_gate_stale_decision_payload_abstains(
        self,
    ) -> None:
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        stale = datetime.now(timezone.utc) - timedelta(minutes=45)
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={
                "runtime_uncertainty_gate": {
                    "action": "pass",
                    "generated_at": stale.isoformat().replace("+00:00", "Z"),
                    "coverage_error": "0.01",
                }
            },
        )

        gate = pipeline._resolve_runtime_uncertainty_gate_from_inputs(decision)
        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "decision_runtime_payload_stale")
        self.assertEqual(gate.reason, "decision_runtime_payload_generated_at_stale")

    def test_pipeline_runtime_regime_gate_defaults_degrade_when_inputs_missing(
        self,
    ) -> None:
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={},
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)
        self.assertEqual(gate.action, "degrade")
        self.assertEqual(gate.source, "missing")
        self.assertEqual(gate.reason, "missing")

    def test_pipeline_runtime_regime_gate_degrades_for_uncertain_regime_posterior(
        self,
    ) -> None:
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={
                "regime_hmm": {
                    "schema_version": "hmm_regime_context_v1",
                    "regime_id": "R2",
                    "posterior": {"R2": "0.68", "R3": "0.32"},
                    "entropy": "0.95",
                    "entropy_band": "medium",
                    "predicted_next": "R3",
                    "artifact": {"model_id": "hmm-regime-v1.2.0"},
                    "guardrail": {"reason": "stable"},
                },
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)
        self.assertEqual(gate.action, "degrade")
        self.assertEqual(gate.source, "regime_hmm_confidence")
        self.assertEqual(gate.reason, "regime_hmm_confidence_is_uncertain")

    def test_pipeline_runtime_regime_gate_abstains_for_high_entropy_low_confidence(
        self,
    ) -> None:
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={
                "regime_hmm": {
                    "schema_version": "hmm_regime_context_v1",
                    "regime_id": "R2",
                    "posterior": {"R2": "0.60", "R3": "0.40"},
                    "entropy": "2.2",
                    "entropy_band": "high",
                    "predicted_next": "R3",
                    "artifact": {"model_id": "hmm-regime-v1.2.0"},
                    "guardrail": {"reason": "stable"},
                },
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)
        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "regime_hmm_confidence")
        self.assertEqual(gate.reason, "regime_hmm_confidence_too_low")

    def test_pipeline_runtime_regime_gate_respects_configured_entropy_band_thresholds(
        self,
    ) -> None:
        from app import config

        original_thresholds = dict(
            config.settings.trading_runtime_regime_confidence_thresholds_by_entropy_band
        )
        config.settings.trading_runtime_regime_confidence_thresholds_by_entropy_band = {
            **original_thresholds,
            "high": (0.55, 0.45),
        }
        try:
            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
            )
            decision = StrategyDecision(
                strategy_id="strategy",
                symbol="AAPL",
                event_ts=datetime.now(timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("10"),
                params={
                    "regime_hmm": {
                        "schema_version": "hmm_regime_context_v1",
                        "regime_id": "R2",
                        "posterior": {"R2": "0.60", "R3": "0.40"},
                        "entropy": "2.2",
                        "entropy_band": "high",
                        "predicted_next": "R3",
                        "artifact": {"model_id": "hmm-regime-v1.2.0"},
                        "guardrail": {"reason": "stable"},
                    },
                },
            )

            gate = pipeline._resolve_runtime_regime_gate(decision)
            self.assertEqual(gate.action, "pass")
            self.assertEqual(gate.source, "regime_hmm")
        finally:
            config.settings.trading_runtime_regime_confidence_thresholds_by_entropy_band = original_thresholds

    def test_pipeline_runtime_regime_gate_invalid_regime_gate_action_fails_closed(
        self,
    ) -> None:
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={
                "regime_gate": {"action": "invalid"},
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)
        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "decision_regime_gate_invalid_action")
        self.assertEqual(gate.reason, "decision_regime_gate_invalid_action")

    def test_pipeline_runtime_regime_gate_unknown_regime_without_label_fails_closed(
        self,
    ) -> None:
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={
                "regime_hmm": {
                    "schema_version": "hmm_regime_context_v1",
                    "regime_id": "unknown",
                    "posterior": {"R2": "0.75"},
                    "entropy": "1.23",
                    "entropy_band": "medium",
                    "predicted_next": "R3",
                    "artifact": {"model_id": "hmm-regime-v1.2.0"},
                    "guardrail": {"reason": "stable"},
                },
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)

        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "regime_hmm_unknown_regime")
        self.assertEqual(gate.reason, "hmm_unknown")

    def test_pipeline_runtime_regime_gate_invalid_regime_id_without_label_fails_closed(
        self,
    ) -> None:
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={
                "regime_hmm": {
                    "schema_version": "hmm_regime_context_v1",
                    "regime_id": "R2-ish",
                    "posterior": {"R2": "0.75"},
                    "entropy": "1.23",
                    "entropy_band": "medium",
                    "predicted_next": "R3",
                    "artifact": {"model_id": "hmm-regime-v1.2.0"},
                    "guardrail": {"reason": "legacy_bridge"},
                },
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)

        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "regime_hmm_unknown_regime")
        self.assertEqual(gate.reason, "hmm_unknown")

    def test_pipeline_runtime_regime_gate_invalid_schema_version_fails_closed(
        self,
    ) -> None:
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={
                "regime_hmm": {
                    "schema_version": "hmm_regime_context_v0",
                    "regime_id": "R2",
                    "artifact": {"model_id": "hmm-regime-v1.2.0"},
                    "guardrail": {"reason": "stable"},
                },
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)

        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "regime_hmm_unknown_regime")
        self.assertEqual(gate.reason, "hmm_schema_version_invalid")
