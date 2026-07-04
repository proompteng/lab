from __future__ import annotations

from tests.pipeline.trading_pipeline_base import (
    Any,
    Decimal,
    DecisionEngine,
    Execution,
    FakeAlpacaClient,
    FakeIngestor,
    MarketContextBundle,
    OrderExecutor,
    OrderFirewall,
    Reconciler,
    RiskEngine,
    Session,
    SignalEnvelope,
    SimpleNamespace,
    SimpleTradingPipeline,
    Strategy,
    TradeDecision,
    TradingPipeline,
    TradingPipelineTestCaseBase,
    TradingState,
    UniverseResolver,
    _market_context_bundle,
    cast,
    datetime,
    patch,
    select,
    timedelta,
    timezone,
)


class TestTradingPipelineWarmupSubmissionB(TradingPipelineTestCaseBase):
    def test_simple_pipeline_submits_live_order_when_shared_gate_allows_and_persists_lane_metadata(
        self,
    ) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_mode = "live"
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_autonomy_allow_live_promotion = False
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "AAPL"

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-live",
                description="simple live lane",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 30, 5, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=1,
            payload={
                "feature_schema_version": "3.0.0",
                "macd": {"macd": 1.2, "signal": 0.5},
                "rsi14": 25,
                "price": 100,
            },
        )

        alpaca_client = FakeAlpacaClient()
        pipeline = SimpleTradingPipeline(
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
        pipeline._is_market_session_open = lambda _now=None: True

        with (
            patch.object(
                SimpleTradingPipeline,
                "_live_submission_gate",
                return_value={
                    "allowed": True,
                    "reason": "promotion_certificate_valid",
                    "blocked_reasons": [],
                    "capital_stage": "live",
                    "capital_state": "live",
                    "profit_window_contract": {
                        "summary": {"windows_total": 1},
                    },
                },
            ),
            patch.object(
                SimpleTradingPipeline,
                "_profitability_proof_floor",
                return_value={
                    "route_state": "paper_ready",
                    "capital_state": "paper",
                    "max_notional": "1000",
                    "blocking_reasons": [],
                },
            ),
        ):
            pipeline.run_once()

        self.assertEqual(len(alpaca_client.submitted), 1)
        self.assertEqual(alpaca_client.submitted[0]["type"], "limit")
        self.assertEqual(pipeline.state.metrics.feature_batch_rows_total, 1)
        self.assertEqual(pipeline.state.metrics.feature_quality_rejections_total, 0)
        self.assertEqual(pipeline.state.metrics.drift_detection_checks_total, 1)
        self.assertIsNotNone(pipeline.state.drift_last_detection_at)
        self.assertTrue(pipeline.state.drift_live_promotion_eligible)
        self.assertEqual(pipeline.state.drift_status, "stable")
        with self.session_local() as session:
            decision = session.execute(select(TradeDecision)).scalar_one()
            execution = session.execute(select(Execution)).scalar_one()
            decision_json = cast(dict[str, Any], decision.decision_json)
            params = cast(dict[str, Any], decision_json.get("params"))
            control_plane = cast(
                dict[str, Any], decision_json.get("control_plane_snapshot")
            )
            execution_audit = cast(dict[str, Any], execution.execution_audit_json)
            self.assertEqual(decision.status, "submitted")
            self.assertEqual(execution.order_type, "limit")
            self.assertEqual(params.get("execution_lane"), "simple")
            self.assertEqual(params.get("submit_path"), "direct_alpaca")
            execution_policy = cast(dict[str, Any], params.get("execution_policy"))
            self.assertEqual(execution_policy.get("selected_order_type"), "limit")
            self.assertEqual(control_plane.get("execution_lane"), "simple")
            self.assertEqual(control_plane.get("pipeline_mode"), "simple")
            self.assertEqual(execution_audit.get("execution_lane"), "simple")
            self.assertEqual(execution_audit.get("submit_path"), "direct_alpaca")

    def test_simple_pipeline_paper_order_updates_proof_counters_without_live_promotion(
        self,
    ) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_mode = "paper"
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_drift_governance_enabled = True
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "AAPL"

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-paper-proof-counters",
                description="simple paper lane proof counter regression",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 30, 5, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=1,
            payload={
                "feature_schema_version": "3.0.0",
                "macd": {"macd": 1.2, "signal": 0.5},
                "rsi14": 25,
                "price": 100,
            },
        )

        alpaca_client = FakeAlpacaClient()
        pipeline = SimpleTradingPipeline(
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
        pipeline._is_market_session_open = lambda _now=None: True

        with patch.object(
            SimpleTradingPipeline,
            "_profitability_proof_floor",
            return_value={
                "route_state": "paper_ready",
                "capital_state": "paper",
                "max_notional": "1000",
                "blocking_reasons": [],
            },
        ):
            pipeline.run_once()

        self.assertEqual(len(alpaca_client.submitted), 1)
        self.assertEqual(alpaca_client.submitted[0]["type"], "limit")
        self.assertEqual(pipeline.state.metrics.feature_batch_rows_total, 1)
        self.assertEqual(pipeline.state.metrics.feature_quality_rejections_total, 0)
        self.assertEqual(pipeline.state.metrics.drift_detection_checks_total, 1)
        self.assertIsNotNone(pipeline.state.drift_last_detection_at)
        self.assertTrue(pipeline.state.drift_live_promotion_eligible)
        self.assertEqual(pipeline.state.drift_status, "stable")
        with self.session_local() as session:
            decision = session.execute(select(TradeDecision)).scalar_one()
            execution = session.execute(select(Execution)).scalar_one()
            decision_json = cast(dict[str, Any], decision.decision_json)
            params = cast(dict[str, Any], decision_json.get("params"))
            control_plane = cast(
                dict[str, Any], decision_json.get("control_plane_snapshot")
            )
            self.assertEqual(decision.status, "submitted")
            self.assertEqual(execution.order_type, "limit")
            self.assertEqual(params.get("execution_lane"), "simple")
            self.assertEqual(params.get("submit_path"), "direct_alpaca")
            execution_policy = cast(dict[str, Any], params.get("execution_policy"))
            self.assertEqual(execution_policy.get("selected_order_type"), "limit")
            self.assertEqual(
                control_plane.get("live_submission_gate", {}).get("reason"),
                "non_live_mode",
            )

    def test_simple_pipeline_refreshes_market_context_before_profitability_floor(
        self,
    ) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_mode = "paper"
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_order_feed_telemetry_enabled = True
        config.settings.trading_order_feed_enabled = True
        config.settings.trading_order_feed_bootstrap_servers = "kafka:9092"
        config.settings.trading_order_feed_topic = "torghut.trade-updates.v1"
        config.settings.trading_order_feed_topic_v2 = None
        config.settings.trading_order_feed_assignment_mode = "manual"
        config.settings.trading_order_feed_auto_offset_reset = "latest"
        config.settings.trading_market_context_url = "http://market-context.test/api"
        config.settings.trading_market_context_timeout_seconds = 1
        config.settings.trading_market_context_max_staleness_seconds = 300
        config.settings.trading_market_context_min_quality = 0.4
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        class _MarketContextClient:
            def __init__(self) -> None:
                self.calls: list[str] = []

            def fetch(
                self, symbol: str, *, as_of: datetime | None = None
            ) -> MarketContextBundle:
                del as_of
                self.calls.append(symbol)
                return _market_context_bundle(symbol=symbol)

        class _UniverseResolver:
            @staticmethod
            def get_resolution() -> SimpleNamespace:
                return SimpleNamespace(symbols={"AAPL"})

        captured_market_context: dict[str, object] = {}
        fake_market_context = _MarketContextClient()
        pipeline = SimpleTradingPipeline(
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
        pipeline.market_context_client = cast(Any, fake_market_context)
        pipeline.universe_resolver = cast(Any, _UniverseResolver())
        pipeline.state.market_session_open = True
        now = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)

        def _healthy_hypotheses(
            session: Session,
            *,
            state: object,
            market_context_status: dict[str, object],
        ) -> dict[str, object]:
            del session, state
            captured_market_context.update(market_context_status)
            return {
                "summary": {
                    "promotion_eligible_total": 1,
                    "rollback_required_total": 0,
                    "state_totals": {"canary_live": 1},
                },
                "items": [
                    {
                        "hypothesis_id": "H-CONT-01",
                        "promotion_contract": {
                            "max_avg_abs_slippage_bps": "12",
                            "observed_post_cost_expectancy_bps": "8",
                            "capacity_daily_notional": "1000000",
                            "drawdown_budget": "500",
                            "allocated_sleeve_equity": "100000",
                        },
                    }
                ],
            }

        with (
            self.session_local() as session,
            patch(
                "app.trading.scheduler.simple_pipeline.build_hypothesis_runtime_summary",
                side_effect=_healthy_hypotheses,
            ),
            patch(
                "app.trading.scheduler.pipeline.decision_lifecycle.build_empirical_jobs_status",
                return_value={"ready": True, "status": "healthy"},
            ),
            patch(
                "app.trading.scheduler.simple_pipeline.load_quant_evidence_status",
                return_value=self._healthy_quant_status(account_label="paper"),
            ),
            patch.object(
                SimpleTradingPipeline,
                "_live_submission_gate",
                return_value={
                    "allowed": True,
                    "reason": "non_live_mode",
                    "blocked_reasons": [],
                    "capital_stage": "paper",
                },
            ),
            patch(
                "app.trading.scheduler.simple_pipeline.build_tca_gate_inputs",
                return_value={
                    "order_count": 40,
                    "filled_execution_count": 40,
                    "unsettled_execution_count": 0,
                    "latest_execution_created_at": now.isoformat(),
                    "last_computed_at": now.isoformat(),
                    "avg_abs_slippage_bps": "5.0",
                    "scope_symbols": ["AAPL"],
                    "scope_symbol_count": 1,
                    "symbol_breakdown": [
                        {
                            "symbol": "AAPL",
                            "order_count": 40,
                            "avg_abs_slippage_bps": "5.0",
                            "max_abs_slippage_bps": "7.0",
                            "last_computed_at": now.isoformat(),
                        }
                    ],
                },
            ),
        ):
            receipt = pipeline._profitability_proof_floor(session=session)

        self.assertEqual(fake_market_context.calls, ["AAPL"])
        self.assertEqual(pipeline.state.last_market_context_symbol, "AAPL")
        self.assertEqual(captured_market_context["last_freshness_seconds"], 20)
        last_domain_states = cast(
            dict[str, str], captured_market_context["last_domain_states"]
        )
        self.assertEqual(last_domain_states, {"technicals": "ok", "regime": "ok"})
        self.assertEqual(receipt["floor_state"], "paper_ready")
        proof_dimensions = cast(list[dict[str, object]], receipt["proof_dimensions"])
        dimensions = {cast(str, item["dimension"]): item for item in proof_dimensions}
        self.assertEqual(dimensions["market_context"]["state"], "pass")
        self.assertEqual(dimensions["target_notional_sizing"]["state"], "pass")

    def test_simple_pipeline_refreshes_market_context_during_prepare_run_once(
        self,
    ) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_market_context_url = "http://market-context.test/api"
        config.settings.trading_market_context_timeout_seconds = 1
        config.settings.trading_market_context_max_staleness_seconds = 300
        config.settings.trading_market_context_min_quality = 0.4
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        class _MarketContextClient:
            def __init__(self) -> None:
                self.calls: list[str] = []

            def fetch(
                self, symbol: str, *, as_of: datetime | None = None
            ) -> MarketContextBundle:
                del as_of
                self.calls.append(symbol)
                return _market_context_bundle(symbol=symbol)

        class _UniverseResolver:
            @staticmethod
            def get_resolution() -> SimpleNamespace:
                return SimpleNamespace(symbols={"AAPL"})

        fake_market_context = _MarketContextClient()
        pipeline = SimpleTradingPipeline(
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
        pipeline.market_context_client = cast(Any, fake_market_context)
        pipeline.universe_resolver = cast(Any, _UniverseResolver())

        with self.session_local() as session:
            strategies = pipeline._prepare_run_once(session)

        self.assertEqual(strategies, [])
        self.assertEqual(fake_market_context.calls, ["AAPL"])
        self.assertEqual(pipeline.state.last_market_context_symbol, "AAPL")
        self.assertIsNotNone(pipeline.state.last_market_context_checked_at)
        self.assertEqual(pipeline.state.last_market_context_freshness_seconds, 20)

    def test_simple_pipeline_market_context_refresh_skips_recent_or_fresh_state(
        self,
    ) -> None:
        from app import config

        config.settings.trading_market_context_url = "http://market-context.test/api"
        config.settings.trading_market_context_max_staleness_seconds = 300
        pipeline = SimpleTradingPipeline(
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

        fetch_calls: list[str] = []

        def _fetch(symbol: str) -> tuple[MarketContextBundle | None, str | None]:
            fetch_calls.append(symbol)
            return _market_context_bundle(symbol=symbol), None

        pipeline._fetch_market_context = _fetch
        now = datetime.now(timezone.utc)
        pipeline.state.last_market_context_checked_at = now - timedelta(seconds=15)

        self.assertTrue(pipeline._market_context_refresh_recent(now))
        pipeline._refresh_market_context_for_proof_floor()
        self.assertEqual(fetch_calls, [])

        now = datetime.now(timezone.utc)
        pipeline.state.last_market_context_checked_at = now - timedelta(seconds=60)
        pipeline.state.last_market_context_as_of = now - timedelta(seconds=30)
        pipeline.state.last_market_context_freshness_seconds = 30
        pipeline.state.market_context_alert_active = False
        pipeline._refresh_market_context_for_proof_floor()

        self.assertEqual(fetch_calls, [])
        self.assertGreaterEqual(
            cast(int, pipeline.state.last_market_context_freshness_seconds),
            0,
        )

    def test_simple_pipeline_market_context_probe_symbol_fallbacks(self) -> None:
        class _EmptyUniverseResolver:
            @staticmethod
            def get_resolution() -> SimpleNamespace:
                return SimpleNamespace(symbols={"", "   "})

        class _FailingUniverseResolver:
            @staticmethod
            def get_resolution() -> SimpleNamespace:
                raise RuntimeError("universe unavailable")

        pipeline = SimpleTradingPipeline(
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

        pipeline.state.last_market_context_symbol = " nvda "
        self.assertEqual(pipeline._market_context_probe_symbol(), "NVDA")

        pipeline.state.last_market_context_symbol = None
        pipeline.universe_resolver = cast(Any, _EmptyUniverseResolver())
        self.assertIsNone(pipeline._market_context_probe_symbol())

        pipeline.universe_resolver = cast(Any, _FailingUniverseResolver())
        self.assertIsNone(pipeline._market_context_probe_symbol())

    def test_simple_pipeline_market_context_refresh_handles_empty_probe_symbol(
        self,
    ) -> None:
        from app import config

        class _EmptyUniverseResolver:
            @staticmethod
            def get_resolution() -> SimpleNamespace:
                return SimpleNamespace(symbols=set())

        config.settings.trading_market_context_url = "http://market-context.test/api"
        pipeline = SimpleTradingPipeline(
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
        pipeline.universe_resolver = cast(Any, _EmptyUniverseResolver())
        pipeline._refresh_market_context_for_proof_floor()

        self.assertIsNone(pipeline.state.last_market_context_symbol)

    def test_simple_pipeline_drift_check_skip_does_not_mutate_promotion_state(
        self,
    ) -> None:
        from app import config

        original_enabled = config.settings.trading_drift_governance_enabled
        config.settings.trading_drift_governance_enabled = False
        pipeline = SimpleTradingPipeline(
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
        pipeline.state.drift_live_promotion_eligible = True
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 30, 5, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=1,
            payload={
                "feature_schema_version": "3.0.0",
                "macd": {"macd": 1.2, "signal": 0.5},
                "rsi14": 25,
                "price": 100,
            },
        )

        try:
            pipeline._run_simple_drift_check([signal])
        finally:
            config.settings.trading_drift_governance_enabled = original_enabled

        self.assertEqual(pipeline.state.metrics.drift_detection_checks_total, 0)
        self.assertIsNone(pipeline.state.drift_last_detection_at)
        self.assertTrue(pipeline.state.drift_live_promotion_eligible)

    def test_simple_pipeline_detected_drift_blocks_promotion_state(self) -> None:
        from app import config

        config.settings.trading_drift_governance_enabled = True
        pipeline = SimpleTradingPipeline(
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
        pipeline.state.drift_live_promotion_eligible = True
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 30, 5, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=1,
            payload={
                "feature_schema_version": "3.0.0",
                "price": 100,
            },
        )

        pipeline._run_simple_drift_check([signal])

        self.assertEqual(pipeline.state.metrics.drift_detection_checks_total, 1)
        self.assertEqual(pipeline.state.metrics.drift_incidents_total, 1)
        self.assertIsNotNone(pipeline.state.drift_active_incident_id)
        self.assertIn(
            "data_required_null_rate_exceeded",
            pipeline.state.drift_active_reason_codes,
        )
        self.assertEqual(pipeline.state.drift_status, "drift_detected")
        self.assertFalse(pipeline.state.drift_live_promotion_eligible)
        self.assertIn(
            "data_required_null_rate_exceeded",
            pipeline.state.drift_live_promotion_reasons,
        )
        self.assertEqual(
            pipeline.state.metrics.drift_incident_reason_total[
                "data_required_null_rate_exceeded"
            ],
            1,
        )

    def test_simple_pipeline_blocks_live_order_when_shared_gate_blocks(
        self,
    ) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_mode = "live"
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "NVDA"

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-live-blocked",
                description="simple live lane blocked by shared gate",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 30, 5, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=1,
            payload={
                "feature_schema_version": "3.0.0",
                "macd": {"macd": 1.2, "signal": 0.5},
                "rsi14": 25,
                "price": 100,
            },
        )

        alpaca_client = FakeAlpacaClient()
        pipeline = SimpleTradingPipeline(
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
        pipeline._is_market_session_open = lambda _now=None: True

        with patch.object(
            SimpleTradingPipeline,
            "_live_submission_gate",
            return_value={
                "allowed": False,
                "reason": "profit_window_underfunded",
                "blocked_reasons": ["profit_window_underfunded"],
                "capital_stage": "shadow",
                "capital_state": "observe",
                "profit_window_contract": {
                    "summary": {"windows_total": 1},
                },
            },
        ):
            pipeline.run_once()

        self.assertEqual(len(alpaca_client.submitted), 0)
        with self.session_local() as session:
            decision = session.execute(select(TradeDecision)).scalar_one()
            decision_json = cast(dict[str, Any], decision.decision_json)
            control_plane = cast(
                dict[str, Any], decision_json.get("control_plane_snapshot")
            )
            gate = cast(dict[str, Any], control_plane.get("live_submission_gate"))
            self.assertEqual(decision.status, "blocked")
            self.assertEqual(
                decision_json.get("submission_block_reason"),
                "profit_window_underfunded",
            )
            self.assertEqual(gate.get("reason"), "profit_window_underfunded")

    def test_simple_pipeline_blocks_live_order_when_submit_disabled_with_operational_gate_metadata(
        self,
    ) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_mode = "live"
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = False
        config.settings.trading_live_submit_enabled = True
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "NVDA"

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-live-submit-disabled",
                description="simple live lane keeps shared gate metadata",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 30, 5, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=1,
            payload={
                "feature_schema_version": "3.0.0",
                "macd": {"macd": 1.2, "signal": 0.5},
                "rsi14": 25,
                "price": 100,
            },
        )

        alpaca_client = FakeAlpacaClient()
        pipeline = SimpleTradingPipeline(
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
        pipeline._is_market_session_open = lambda _now=None: True

        with patch.object(
            TradingPipeline,
            "_live_submission_gate",
            return_value={
                "allowed": True,
                "reason": "promotion_certificate_valid",
                "blocked_reasons": [],
                "capital_stage": "live",
                "capital_state": "live",
                "profit_window_contract": {
                    "summary": {"windows_total": 1},
                },
            },
        ):
            pipeline.run_once()

        self.assertEqual(len(alpaca_client.submitted), 0)
        with self.session_local() as session:
            decision = session.execute(select(TradeDecision)).scalar_one()
            decision_json = cast(dict[str, Any], decision.decision_json)
            control_plane = cast(
                dict[str, Any], decision_json.get("control_plane_snapshot")
            )
            gate = cast(dict[str, Any], control_plane.get("live_submission_gate"))
            self.assertEqual(decision.status, "blocked")
            self.assertEqual(
                decision_json.get("submission_block_reason"),
                "submit_disabled",
            )
            self.assertEqual(gate.get("reason"), "submit_disabled")
            self.assertEqual(
                gate.get("profit_window_contract", {}).get("summary"),
                {"windows_total": 1},
            )
            self.assertNotIn("simple_lane", gate)

    def test_simple_pipeline_blocks_paper_order_when_profitability_floor_zero_notional(
        self,
    ) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_mode = "paper"
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "AAPL"

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-paper-proof-floor-blocked",
                description="simple paper lane blocked by proof floor",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["NVDA"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 30, 5, tzinfo=timezone.utc),
            symbol="NVDA",
            timeframe="1Min",
            seq=1,
            payload={
                "feature_schema_version": "3.0.0",
                "macd": {"macd": 1.2, "signal": 0.5},
                "rsi14": 25,
                "price": 100,
            },
        )

        alpaca_client = FakeAlpacaClient()
        pipeline = SimpleTradingPipeline(
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
        pipeline._is_market_session_open = lambda _now=None: True

        with patch.object(
            SimpleTradingPipeline,
            "_profitability_proof_floor",
            return_value={
                "route_state": "repair_only",
                "capital_state": "zero_notional",
                "max_notional": "0",
                "blocking_reasons": ["hypothesis_not_promotion_eligible"],
            },
        ):
            pipeline.run_once()

        self.assertEqual(len(alpaca_client.submitted), 0)
        with self.session_local() as session:
            decision = session.execute(select(TradeDecision)).scalar_one()
            decision_json = cast(dict[str, Any], decision.decision_json)
            control_plane = cast(
                dict[str, Any], decision_json.get("control_plane_snapshot")
            )
            proof_floor = cast(
                dict[str, Any], decision_json.get("profitability_proof_floor")
            )
            self.assertEqual(decision.status, "blocked")
            self.assertEqual(
                decision_json.get("submission_stage"),
                "blocked_profitability_proof_floor",
            )
            self.assertEqual(
                decision_json.get("submission_block_reason"),
                "hypothesis_not_promotion_eligible",
            )
            self.assertEqual(proof_floor.get("capital_state"), "zero_notional")
            self.assertEqual(control_plane.get("execution_lane"), "simple")
