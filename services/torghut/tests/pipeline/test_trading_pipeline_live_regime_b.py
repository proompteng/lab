from __future__ import annotations

from tests.pipeline.trading_pipeline_base import (
    Decimal,
    DecisionEngine,
    Execution,
    FakeAlpacaClient,
    FakeIngestor,
    FakePriceFetcher,
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
    patch,
    select,
    tempfile,
    timezone,
)


class TestTradingPipelineLiveRegimeB(TradingPipelineTestCaseBase):
    def test_run_once_blocks_live_submission_when_quant_latest_store_is_empty(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_autonomy_enabled": config.settings.trading_autonomy_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_live_enabled = True
        config.settings.trading_autonomy_enabled = False
        config.settings.trading_autonomy_allow_live_promotion = True
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            allowed_summary = {
                "promotion_eligible_total": 1,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            }
            with self.session_local() as session:
                strategy = Strategy(
                    name="live-canary-empty-quant",
                    description="autonomy evidence with empty quant latest store",
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
            state = TradingState(
                last_autonomy_promotion_eligible=True,
                last_autonomy_promotion_action="promote",
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

            with (
                patch(
                    "app.trading.scheduler.pipeline.decision_lifecycle.build_hypothesis_runtime_summary",
                    return_value=allowed_summary,
                ),
                patch(
                    "app.trading.scheduler.pipeline.decision_lifecycle.build_empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
                patch(
                    "app.trading.scheduler.pipeline.decision_lifecycle.load_quant_evidence_status",
                    return_value={
                        "required": True,
                        "ok": False,
                        "status": "degraded",
                        "reason": "quant_latest_metrics_empty",
                        "blocking_reasons": [
                            "quant_latest_metrics_empty",
                            "quant_latest_store_alarm",
                        ],
                        "account": "paper",
                        "window": "15m",
                        "source_url": "http://jangar.test/api/torghut/trading/control-plane/quant/health?account=paper&window=15m",
                        "latest_metrics_count": 0,
                        "latest_metrics_updated_at": None,
                        "empty_latest_store_alarm": True,
                        "missing_update_alarm": False,
                        "metrics_pipeline_lag_seconds": None,
                        "stage_count": 0,
                        "max_stage_lag_seconds": 0,
                        "stages": [],
                    },
                ),
            ):
                pipeline.run_once()

            with self.session_local() as session:
                decision_rows = session.execute(select(TradeDecision)).scalars().all()
                self.assertEqual(len(decision_rows), 1)
                self.assertEqual(decision_rows[0].status, "blocked")
                decision_json = decision_rows[0].decision_json
                assert isinstance(decision_json, dict)
                control_plane_snapshot = decision_json.get("control_plane_snapshot")
                assert isinstance(control_plane_snapshot, dict)
                live_submission_gate = control_plane_snapshot.get(
                    "live_submission_gate"
                )
                assert isinstance(live_submission_gate, dict)
                self.assertEqual(live_submission_gate.get("allowed"), False)
                self.assertEqual(
                    live_submission_gate.get("reason"),
                    "quant_latest_metrics_empty",
                )
                self.assertEqual(live_submission_gate.get("capital_state"), "observe")
                self.assertIn(
                    "quant_latest_store_alarm",
                    live_submission_gate.get("blocked_reasons", []),
                )

            self.assertEqual(alpaca_client.submitted, [])
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_autonomy_enabled = original[
                "trading_autonomy_enabled"
            ]
            config.settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]

    def test_decision_engine_macd_rsi(self) -> None:
        engine = DecisionEngine()
        strategy = Strategy(
            name="demo",
            description="demo",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
        )
        signal = SignalEnvelope(
            event_ts=datetime.now(timezone.utc),
            symbol="AAPL",
            payload={"macd": {"macd": 1.2, "signal": 0.5}, "rsi14": 25, "price": 100},
            timeframe="1Min",
        )
        decisions = engine.evaluate(signal, [strategy])
        self.assertTrue(decisions)
        self.assertEqual(decisions[0].action, "buy")

    def test_decision_engine_attaches_price(self) -> None:
        engine = DecisionEngine(price_fetcher=FakePriceFetcher(Decimal("101.5")))
        strategy = Strategy(
            name="demo",
            description="demo",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
        )
        signal = SignalEnvelope(
            event_ts=datetime.now(timezone.utc),
            symbol="AAPL",
            payload={"macd": {"macd": 1.2, "signal": 0.5}, "rsi14": 25},
            timeframe="1Min",
        )
        decisions = engine.evaluate(signal, [strategy])
        self.assertTrue(decisions)
        self.assertEqual(decisions[0].params.get("price"), Decimal("101.5"))

    def test_risk_engine_ignores_deprecated_live_enabled_flag(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_live_enabled = False

        try:
            strategy = Strategy(
                name="demo",
                description="demo",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
            )
            decision = StrategyDecision(
                strategy_id="strategy",
                symbol="AAPL",
                event_ts=datetime.now(timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("1"),
                params={"price": Decimal("100")},
            )

            with self.session_local() as session:
                engine = RiskEngine()
                verdict = engine.evaluate(
                    session,
                    decision,
                    strategy,
                    account={"equity": "10000", "buying_power": "10000"},
                    positions=[],
                    allowed_symbols={"AAPL"},
                )
            self.assertTrue(verdict.approved)
            self.assertNotIn("live_trading_disabled", verdict.reasons)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]

    def test_pipeline_idempotent_execution(self) -> None:
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
            pipeline.run_once()

            with self.session_local() as session:
                decisions = session.execute(select(TradeDecision)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(decisions), 1)
                self.assertEqual(len(executions), 1)
                self.assertIsNotNone(decisions[0].decision_hash)
                self.assertEqual(len(alpaca_client.submitted), 1)
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

    def test_pipeline_runtime_uncertainty_fail_blocks_new_entries(self) -> None:
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
                        description="runtime-gate-fail",
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
                    '{"uncertainty_gate_action":"fail","coverage_error":"0.11","shift_score":"0.96"}',
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

                with self.session_local() as session:
                    decisions = session.execute(select(TradeDecision)).scalars().all()
                    self.assertEqual(len(decisions), 1)
                    self.assertEqual(decisions[0].status, "rejected")
                    decision_json = decisions[0].decision_json
                    assert isinstance(decision_json, dict)
                    self.assertIn(
                        "runtime_uncertainty_gate_fail_block_new_entries",
                        decision_json.get("risk_reasons", []),
                    )
                    params = decision_json.get("params")
                    assert isinstance(params, dict)
                    gate_payload = params.get("runtime_uncertainty_gate")
                    assert isinstance(gate_payload, dict)
                    self.assertEqual(gate_payload.get("action"), "fail")
                    self.assertTrue(gate_payload.get("entry_blocked"))

                self.assertEqual(alpaca_client.submitted, [])
                self.assertEqual(
                    state.metrics.runtime_uncertainty_gate_action_total.get("fail"), 1
                )
                self.assertEqual(
                    state.metrics.runtime_uncertainty_gate_blocked_total.get("fail"),
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
