from __future__ import annotations

from tests.pipeline.trading_pipeline_base import (
    Any,
    Decimal,
    DecisionEngine,
    FakeAlpacaClient,
    FakeIngestor,
    OrderExecutor,
    OrderFirewall,
    Path,
    PositionedAlpacaClient,
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


class TestTradingPipelineRuntimeUncertaintyB(TradingPipelineTestCaseBase):
    def test_pipeline_runtime_regime_gate_invalid_posterior_blocks_risk_increasing_entry_and_preserves_artifact_lineage(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                with self.session_local() as session:
                    strategy = Strategy(
                        name="demo-invalid-posterior",
                        description="runtime-regime-gate-invalid-posterior",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols=["AAPL"],
                        max_notional_per_trade=Decimal("1000"),
                    )
                    session.add(strategy)
                    session.commit()

                gate_path = Path(tmpdir) / "gate-report.json"
                gate_path.write_text(
                    '{"uncertainty_gate_action":"pass"}',
                    encoding="utf-8",
                )
                signal = SignalEnvelope(
                    event_ts=datetime.now(timezone.utc),
                    symbol="AAPL",
                    payload={
                        "macd": {"macd": 1.2, "signal": 0.5},
                        "rsi14": 25,
                        "price": 100,
                        "schema_version": "hmm_regime_context_v1",
                        "regime_id": "R2",
                        "posterior": {"R2": "bad-posterior"},
                        "entropy": "1.2",
                        "entropy_band": "medium",
                        "predicted_next": "R3",
                        "transition_shock": False,
                        "duration_ms": 123,
                        "artifact": {
                            "model_id": "hmm-regime-v1.2.0",
                            "feature_schema": "hmm-v1",
                            "training_run_id": "run-2026-03-02",
                        },
                        "guardrail": {
                            "stale": False,
                            "fallback_to_defensive": False,
                        },
                    },
                    timeframe="1Min",
                )
                state = TradingState(last_autonomy_gates=str(gate_path))
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
                    self.assertEqual(decisions[0].status, "rejected")
                    decision_json = decisions[0].decision_json
                    assert isinstance(decision_json, dict)
                    self.assertIn(
                        "runtime_uncertainty_gate_abstain_block_risk_increasing_entries",
                        decision_json.get("risk_reasons", []),
                    )
                    params = decision_json.get("params")
                    assert isinstance(params, dict)

                    gate_payload = params.get("runtime_uncertainty_gate")
                    assert isinstance(gate_payload, dict)
                    self.assertEqual(
                        gate_payload.get("source"), "regime_hmm_non_authoritative"
                    )
                    regime_gate = gate_payload.get("regime_gate")
                    assert isinstance(regime_gate, dict)
                    self.assertEqual(regime_gate.get("action"), "abstain")
                    self.assertEqual(regime_gate.get("reason"), "hmm_invalid_posterior")

                    regime_payload = params.get("regime_hmm")
                    self.assertIsInstance(regime_payload, dict)
                    self.assertEqual(
                        regime_payload.get("schema_version"),
                        "hmm_regime_context_v1",
                    )
                    regime_artifact = regime_payload.get("artifact")
                    self.assertIsInstance(regime_artifact, dict)
                    self.assertEqual(
                        regime_artifact.get("model_id"),
                        "hmm-regime-v1.2.0",
                    )
                    self.assertEqual(
                        regime_artifact.get("feature_schema"),
                        "hmm-v1",
                    )
                    self.assertEqual(
                        regime_artifact.get("training_run_id"),
                        "run-2026-03-02",
                    )
                    self.assertEqual(regime_payload.get("hmm_entropy"), "1.2")
                    self.assertEqual(regime_payload.get("hmm_state_posterior"), {})
                    self.assertEqual(regime_payload.get("hmm_entropy_band"), "medium")
                    self.assertEqual(regime_payload.get("hmm_transition_shock"), False)

                self.assertEqual(len(alpaca_client.submitted), 0)
                self.assertEqual(
                    state.metrics.runtime_regime_gate_action_total.get("abstain"), 1
                )
                self.assertEqual(
                    state.metrics.runtime_regime_gate_blocked_total.get("abstain"), 1
                )
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]

    def test_pipeline_runtime_regime_gate_unparseable_payload_fails_closed(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        class DeterministicDecisionEngine(DecisionEngine):
            def evaluate(
                self,
                _signal,
                _strategies,
                *,
                equity: Any | None = None,
            ) -> list[StrategyDecision]:
                _ = equity
                return [forced_decision]

        strategy_id: str
        with self.session_local() as session:
            strategy = Strategy(
                name="demo",
                description="runtime-regime-gate-unparseable",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()
            strategy_id = str(strategy.id)

        forced_decision = StrategyDecision(
            strategy_id=strategy_id,
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            params={
                "regime_hmm": "bad-regime-payload",
            },
        )

        try:
            state = TradingState()
            alpaca_client = FakeAlpacaClient()
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor(
                    [
                        SignalEnvelope(
                            event_ts=datetime.now(timezone.utc),
                            symbol="AAPL",
                            payload={
                                "macd": {"macd": 1.2, "signal": 0.5},
                                "rsi14": 25,
                                "price": 100,
                            },
                            timeframe="1Min",
                        )
                    ]
                ),
                decision_engine=DeterministicDecisionEngine(),
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
                self.assertEqual(decisions[0].status, "rejected")
                decision_json = decisions[0].decision_json
                assert isinstance(decision_json, dict)
                self.assertIn(
                    "runtime_uncertainty_gate_abstain_block_risk_increasing_entries",
                    decision_json.get("risk_reasons", []),
                )
                params = decision_json.get("params")
                assert isinstance(params, dict)
                gate_payload = params.get("runtime_uncertainty_gate")
                assert isinstance(gate_payload, dict)
                self.assertEqual(gate_payload.get("action"), "abstain")
                self.assertEqual(gate_payload.get("source"), "regime_hmm_unparseable")
                regime_gate = gate_payload.get("regime_gate")
                assert isinstance(regime_gate, dict)
                self.assertEqual(regime_gate.get("action"), "abstain")
                self.assertEqual(
                    regime_gate.get("reason"), "regime_hmm_unparseable_payload"
                )

            self.assertEqual(len(alpaca_client.submitted), 0)
            self.assertEqual(
                state.metrics.runtime_regime_gate_action_total.get("abstain"), 1
            )
            self.assertEqual(
                state.metrics.runtime_regime_gate_blocked_total.get("abstain"), 1
            )
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]

    def test_pipeline_runtime_uncertainty_abstain_allows_risk_reducing_exit(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                with self.session_local() as session:
                    strategy = Strategy(
                        name="demo",
                        description="runtime-gate-abstain",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols=["AAPL"],
                        max_notional_per_trade=Decimal("1000"),
                    )
                    session.add(strategy)
                    session.commit()

                gate_path = Path(tmpdir) / "gate-report.json"
                gate_path.write_text(
                    '{"uncertainty_gate_action":"abstain"}',
                    encoding="utf-8",
                )
                signal = SignalEnvelope(
                    event_ts=datetime.now(timezone.utc),
                    symbol="AAPL",
                    payload={
                        "macd": {"macd": 0.4, "signal": 1.0},
                        "rsi14": 75,
                        "price": 100,
                    },
                    timeframe="1Min",
                )
                state = TradingState(last_autonomy_gates=str(gate_path))
                alpaca_client = PositionedAlpacaClient(
                    positions=[
                        {
                            "symbol": "AAPL",
                            "qty": "5",
                            "side": "long",
                            "market_value": "500",
                        }
                    ]
                )
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
                    self.assertEqual(decisions[0].status, "submitted")
                    decision_json = decisions[0].decision_json
                    assert isinstance(decision_json, dict)
                    params = decision_json.get("params")
                    assert isinstance(params, dict)
                    gate_payload = params.get("runtime_uncertainty_gate")
                    assert isinstance(gate_payload, dict)
                    self.assertEqual(gate_payload.get("action"), "abstain")
                    self.assertFalse(gate_payload.get("entry_blocked"))
                    self.assertFalse(gate_payload.get("risk_increasing_entry"))

                self.assertEqual(len(alpaca_client.submitted), 1)
                self.assertEqual(
                    state.metrics.runtime_uncertainty_gate_action_total.get("abstain"),
                    1,
                )
                self.assertIsNone(
                    state.metrics.runtime_uncertainty_gate_blocked_total.get("abstain")
                )
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]

    def test_pipeline_runtime_uncertainty_degrade_tightens_sizing_and_participation(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                with self.session_local() as session:
                    strategy = Strategy(
                        name="demo",
                        description="runtime-gate-degrade",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols=["AAPL"],
                        max_notional_per_trade=Decimal("1000"),
                    )
                    session.add(strategy)
                    session.commit()

                gate_path = Path(tmpdir) / "gate-report.json"
                gate_path.write_text(
                    '{"uncertainty_gate_action":"degrade"}',
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

                self.assertEqual(len(alpaca_client.submitted), 1)
                self.assertEqual(alpaca_client.submitted[0]["qty"], "5.0")
                with self.session_local() as session:
                    decisions = session.execute(select(TradeDecision)).scalars().all()
                    self.assertEqual(len(decisions), 1)
                    self.assertEqual(decisions[0].status, "submitted")
                    decision_json = decisions[0].decision_json
                    assert isinstance(decision_json, dict)
                    params = decision_json.get("params")
                    assert isinstance(params, dict)
                    gate_payload = params.get("runtime_uncertainty_gate")
                    assert isinstance(gate_payload, dict)
                    self.assertEqual(gate_payload.get("action"), "degrade")
                    self.assertEqual(gate_payload.get("degrade_qty_multiplier"), "0.50")
                    allocator = params.get("allocator")
                    assert isinstance(allocator, dict)
                    self.assertEqual(
                        allocator.get("max_participation_rate_override"), "0.05"
                    )
                    self.assertEqual(params.get("execution_seconds"), 120)

                self.assertEqual(
                    state.metrics.runtime_uncertainty_gate_action_total.get("degrade"),
                    1,
                )
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]

    def test_runtime_uncertainty_gate_degrade_uses_regime_profile(self) -> None:
        from app import config

        original = {
            "qty_multipliers": config.settings.trading_runtime_uncertainty_degrade_qty_multipliers_by_regime,
            "max_participation_rates": config.settings.trading_runtime_uncertainty_degrade_max_participation_rate_by_regime,
            "min_execution_seconds": config.settings.trading_runtime_uncertainty_degrade_min_execution_seconds_by_regime,
        }

        config.settings.trading_runtime_uncertainty_degrade_qty_multipliers_by_regime = {
            "riskoff": 0.25,
        }
        config.settings.trading_runtime_uncertainty_degrade_max_participation_rate_by_regime = {
            "riskoff": 0.03,
        }
        config.settings.trading_runtime_uncertainty_degrade_min_execution_seconds_by_regime = {
            "riskoff": 180,
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
                qty=Decimal("20"),
                params={
                    "regime_gate": {
                        "action": "pass",
                        "regime_label": "riskoff",
                    },
                },
            )

            updated_decision, payload, reason = (
                pipeline._apply_runtime_uncertainty_gate(
                    decision,
                    positions=[],
                )
            )

            self.assertIsNone(reason)
            self.assertEqual(payload.get("degrade_qty_multiplier"), "0.25")
            self.assertEqual(payload.get("max_participation_rate_override"), "0.03")
            self.assertEqual(payload.get("min_execution_seconds"), 180)
            self.assertEqual(
                str(
                    updated_decision.params["allocator"][
                        "max_participation_rate_override"
                    ]
                ),
                "0.03",
            )
            self.assertEqual(updated_decision.params.get("execution_seconds"), 180)
            self.assertEqual(Decimal(str(payload.get("adjusted_qty"))), Decimal("5"))
        finally:
            config.settings.trading_runtime_uncertainty_degrade_qty_multipliers_by_regime = original[
                "qty_multipliers"
            ]
            config.settings.trading_runtime_uncertainty_degrade_max_participation_rate_by_regime = original[
                "max_participation_rates"
            ]
            config.settings.trading_runtime_uncertainty_degrade_min_execution_seconds_by_regime = original[
                "min_execution_seconds"
            ]

    def test_runtime_uncertainty_gate_degrade_does_not_increase_fractional_qty(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_fractional_equities_enabled": config.settings.trading_fractional_equities_enabled,
            "qty_multipliers": config.settings.trading_runtime_uncertainty_degrade_qty_multipliers_by_regime,
        }
        config.settings.trading_fractional_equities_enabled = True
        config.settings.trading_runtime_uncertainty_degrade_qty_multipliers_by_regime = {
            "trend": 0.5,
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
                qty=Decimal("0.2766"),
                params={
                    "regime_gate": {
                        "action": "pass",
                        "regime_label": "trend",
                    },
                    "runtime_uncertainty_gate": {
                        "action": "degrade",
                    },
                },
            )

            updated_decision, payload, reason = (
                pipeline._apply_runtime_uncertainty_gate(
                    decision,
                    positions=[],
                )
            )

            self.assertIsNone(reason)
            self.assertEqual(payload.get("adjusted_qty"), "0.1383")
            self.assertEqual(updated_decision.qty, Decimal("0.1383"))
        finally:
            config.settings.trading_fractional_equities_enabled = original[
                "trading_fractional_equities_enabled"
            ]
            config.settings.trading_runtime_uncertainty_degrade_qty_multipliers_by_regime = original[
                "qty_multipliers"
            ]

    def test_runtime_uncertainty_gate_softens_saturated_autonomy_fail_sentinel(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            gate_path = Path(tmpdir) / "gate-report.json"
            gate_path.write_text(
                json.dumps(
                    {
                        "uncertainty_gate_action": "fail",
                        "coverage_error": "1",
                        "shift_score": "1",
                        "conformal_interval_width": "0",
                    }
                ),
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
                qty=Decimal("5"),
                params={},
            )

            gate = pipeline._resolve_runtime_uncertainty_gate_from_inputs(decision)

            self.assertEqual(gate.action, "degrade")
            self.assertEqual(
                gate.source, "autonomy_gate_report_saturated_fail_sentinel"
            )
            self.assertEqual(
                gate.reason, "autonomy_gate_report_saturated_fail_sentinel"
            )

    def test_pipeline_runtime_uncertainty_uses_projected_positions_within_run(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                with self.session_local() as session:
                    strategy = Strategy(
                        name="demo",
                        description="runtime-gate-projected-positions",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols=["AAPL"],
                        max_notional_per_trade=Decimal("500"),
                    )
                    session.add(strategy)
                    session.commit()

                gate_path = Path(tmpdir) / "gate-report.json"
                gate_path.write_text(
                    '{"uncertainty_gate_action":"abstain"}',
                    encoding="utf-8",
                )
                event_ts = datetime.now(timezone.utc)
                signals = [
                    SignalEnvelope(
                        event_ts=event_ts,
                        symbol="AAPL",
                        payload={
                            "macd": {"macd": 1.2, "signal": 0.5},
                            "rsi14": 25,
                            "price": 100,
                        },
                        timeframe="1Min",
                    ),
                    SignalEnvelope(
                        event_ts=event_ts + timedelta(seconds=1),
                        symbol="AAPL",
                        payload={
                            "macd": {"macd": 1.2, "signal": 0.5},
                            "rsi14": 25,
                            "price": 100,
                        },
                        timeframe="1Min",
                    ),
                ]
                state = TradingState(last_autonomy_gates=str(gate_path))
                alpaca_client = PositionedAlpacaClient(
                    positions=[
                        {
                            "symbol": "AAPL",
                            "qty": "5",
                            "side": "short",
                            "market_value": "-500",
                        }
                    ]
                )
                pipeline = TradingPipeline(
                    alpaca_client=alpaca_client,
                    order_firewall=OrderFirewall(alpaca_client),
                    ingestor=FakeIngestor(signals),
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
                    self.assertEqual(len(decisions), 2)
                    status_counts = {
                        status: sum(1 for item in decisions if item.status == status)
                        for status in {"submitted", "rejected"}
                    }
                    self.assertEqual(status_counts.get("submitted"), 1)
                    self.assertEqual(status_counts.get("rejected"), 1)
                    rejected = next(
                        item for item in decisions if item.status == "rejected"
                    )
                    decision_json = rejected.decision_json
                    assert isinstance(decision_json, dict)
                    self.assertIn(
                        "runtime_uncertainty_gate_abstain_block_risk_increasing_entries",
                        decision_json.get("risk_reasons", []),
                    )

                self.assertEqual(len(alpaca_client.submitted), 1)
                self.assertEqual(
                    state.metrics.runtime_uncertainty_gate_blocked_total.get("abstain"),
                    1,
                )
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
