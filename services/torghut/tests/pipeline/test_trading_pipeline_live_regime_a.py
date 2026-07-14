from __future__ import annotations

from app.trading.scheduler.pipeline.submission_policy import (
    _decision_execution_notional,
)

from tests.pipeline.trading_pipeline_base import (
    Decimal,
    DecisionEngine,
    FakeAlpacaClient,
    FakeIngestor,
    OrderExecutor,
    OrderFirewall,
    Reconciler,
    RiskEngine,
    SignalEnvelope,
    Strategy,
    StrategyDecision,
    StrategyHypothesis,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    TradeDecision,
    TradingPipeline,
    TradingPipelineTestCaseBase,
    TradingState,
    UniverseResolver,
    VNextDatasetSnapshot,
    datetime,
    patch,
    select,
    timedelta,
    timezone,
)


class TestTradingPipelineLiveRegimeA(TradingPipelineTestCaseBase):
    def test_authority_notional_uses_final_executable_quantity_and_price(self) -> None:
        decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("8"),
            order_type="limit",
            limit_price=Decimal("101.5"),
            params={
                "price": "100",
                "portfolio_sizing": {"output": {"final_notional": "1000"}},
            },
        )

        self.assertEqual(_decision_execution_notional(decision), Decimal("812.0"))

    def test_pipeline_continues_when_feature_quality_has_warning_only_null_rate(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "trading_feature_quality_enabled": config.settings.trading_feature_quality_enabled,
            "trading_feature_max_staleness_ms": config.settings.trading_feature_max_staleness_ms,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL,MSFT"
        config.settings.trading_feature_quality_enabled = True
        config.settings.trading_feature_max_staleness_ms = 1_000
        config.settings.trading_kill_switch_enabled = False

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="quality-gate warning-only regression",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL", "MSFT"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.flush()
                self._activate_test_capital_authority(session, strategy=strategy)
                session.commit()

            valid_signal = SignalEnvelope(
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                ingest_ts=datetime(2026, 1, 1, 0, 0, 0, 500000, tzinfo=timezone.utc),
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
            incomplete_signal = SignalEnvelope(
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                ingest_ts=datetime(2026, 1, 1, 0, 0, 0, 500000, tzinfo=timezone.utc),
                symbol="MSFT",
                timeframe="1Min",
                seq=2,
                payload={
                    "feature_schema_version": "3.0.0",
                    "macd": {"macd": None, "signal": None},
                    "rsi14": None,
                    "price": 100,
                },
            )

            alpaca_client = FakeAlpacaClient()
            execution_adapter = FakeAlpacaClient()
            ingestor = FakeIngestor([valid_signal, incomplete_signal])
            state = TradingState()
            self._prime_test_capital_state(state)
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=ingestor,
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=execution_adapter,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=state,
                account_label="paper",
                session_factory=self.session_local,
            )

            pipeline.run_once()

            self.assertEqual(ingestor.committed_batches, 1)
            self.assertEqual(state.metrics.feature_quality_rejections_total, 1)
            self.assertEqual(
                state.metrics.feature_quality_reject_reason_total.get(
                    "required_feature_null_rate_exceeds_threshold"
                ),
                1,
            )
            self.assertIsNone(
                state.metrics.feature_quality_cursor_commit_blocked_total.get(
                    "required_feature_null_rate_exceeds_threshold"
                )
            )
            self.assertEqual(len(alpaca_client.submitted), 1)
            self.assertEqual(alpaca_client.submitted[0]["symbol"], "AAPL")
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
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
            config.settings.trading_feature_quality_enabled = original[
                "trading_feature_quality_enabled"
            ]
            config.settings.trading_feature_max_staleness_ms = original[
                "trading_feature_max_staleness_ms"
            ]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]

    def test_stale_planned_decision_is_force_blocked(self) -> None:
        from app import config

        original_timeout = config.settings.trading_planned_decision_timeout_seconds
        config.settings.trading_planned_decision_timeout_seconds = 60
        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="stale-planned",
                    description="stale planned decision rejection",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                )
                session.add(strategy)
                session.commit()
                session.refresh(strategy)

                decision = StrategyDecision(
                    strategy_id=str(strategy.id),
                    symbol="AAPL",
                    event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
                    timeframe="1Min",
                    action="buy",
                    qty=Decimal("1"),
                    params={"price": Decimal("100")},
                )
                executor = OrderExecutor()
                decision_row = executor.ensure_decision(
                    session, decision, strategy, "paper"
                )
                decision_row.created_at = datetime.now(timezone.utc) - timedelta(
                    seconds=300
                )
                session.add(decision_row)
                session.commit()

                pipeline = TradingPipeline(
                    alpaca_client=FakeAlpacaClient(),
                    order_firewall=OrderFirewall(FakeAlpacaClient()),
                    ingestor=FakeIngestor([]),
                    decision_engine=DecisionEngine(),
                    risk_engine=RiskEngine(),
                    executor=executor,
                    execution_adapter=FakeAlpacaClient(),
                    reconciler=Reconciler(),
                    universe_resolver=UniverseResolver(),
                    state=TradingState(),
                    account_label="paper",
                    session_factory=self.session_local,
                )

                pending = pipeline._ensure_pending_decision_row(
                    session=session,
                    decision=decision,
                    strategy=strategy,
                )

                self.assertIsNone(pending)
                refreshed = session.get(TradeDecision, decision_row.id)
                assert refreshed is not None
                self.assertEqual(refreshed.status, "blocked")
                decision_json = refreshed.decision_json
                assert isinstance(decision_json, dict)
                self.assertEqual(
                    decision_json.get("submission_block_reason"),
                    "stale_planned_cleanup",
                )
                submission_block_atomic = decision_json.get("submission_block_atomic")
                assert isinstance(submission_block_atomic, list)
                self.assertIn("stale_planned_cleanup", submission_block_atomic)
                self.assertEqual(
                    decision_json.get("submission_stage"),
                    "blocked_stale_planned_cleanup",
                )
                self.assertEqual(
                    pipeline.state.metrics.submission_block_total.get(
                        "stale_planned_cleanup"
                    ),
                    1,
                )
                self.assertEqual(
                    pipeline.state.metrics.planned_decisions_stale_total, 1
                )
        finally:
            config.settings.trading_planned_decision_timeout_seconds = original_timeout

    def test_simulation_clock_does_not_reject_fresh_planned_decision(self) -> None:
        from app import config
        from app.trading import time_source as time_source_module

        original = {
            "trading_planned_decision_timeout_seconds": config.settings.trading_planned_decision_timeout_seconds,
            "trading_simulation_enabled": config.settings.trading_simulation_enabled,
            "trading_simulation_clock_mode": config.settings.trading_simulation_clock_mode,
            "trading_simulation_window_start": config.settings.trading_simulation_window_start,
            "trading_account_label": config.settings.trading_account_label,
        }
        original_load_cursor = (
            time_source_module.TradingTimeSource._load_clickhouse_cursor
        )
        config.settings.trading_planned_decision_timeout_seconds = 60
        config.settings.trading_simulation_enabled = True
        config.settings.trading_simulation_clock_mode = "cursor"
        config.settings.trading_simulation_window_start = "2026-02-10T15:00:00+00:00"
        config.settings.trading_account_label = "paper"
        time_source_module.TradingTimeSource._load_clickhouse_cursor = staticmethod(
            lambda **_: None
        )
        time_source_module._TIME_SOURCE._cache_by_account.clear()
        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="simulation-fresh-planned",
                    description="simulation planned decision freshness",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                )
                session.add(strategy)
                session.commit()
                session.refresh(strategy)

                decision = StrategyDecision(
                    strategy_id=str(strategy.id),
                    symbol="AAPL",
                    event_ts=datetime(2026, 2, 10, 15, 0, tzinfo=timezone.utc),
                    timeframe="1Min",
                    action="buy",
                    qty=Decimal("1"),
                    params={"price": Decimal("100")},
                )
                executor = OrderExecutor()
                decision_row = executor.ensure_decision(
                    session, decision, strategy, "paper"
                )
                decision_row.created_at = datetime(
                    2026, 2, 10, 15, 0, 30, tzinfo=timezone.utc
                )
                session.add(decision_row)
                session.commit()

                pipeline = TradingPipeline(
                    alpaca_client=FakeAlpacaClient(),
                    order_firewall=OrderFirewall(FakeAlpacaClient()),
                    ingestor=FakeIngestor([]),
                    decision_engine=DecisionEngine(),
                    risk_engine=RiskEngine(),
                    executor=executor,
                    execution_adapter=FakeAlpacaClient(),
                    reconciler=Reconciler(),
                    universe_resolver=UniverseResolver(),
                    state=TradingState(),
                    account_label="paper",
                    session_factory=self.session_local,
                )

                pending = pipeline._ensure_pending_decision_row(
                    session=session,
                    decision=decision,
                    strategy=strategy,
                )

                self.assertIsNotNone(pending)
                refreshed = session.get(TradeDecision, decision_row.id)
                assert refreshed is not None
                self.assertEqual(refreshed.status, "planned")
                self.assertEqual(
                    pipeline.state.metrics.planned_decisions_timeout_rejected_total, 0
                )
                self.assertEqual(
                    pipeline.state.metrics.planned_decisions_stale_total, 0
                )
        finally:
            config.settings.trading_planned_decision_timeout_seconds = original[
                "trading_planned_decision_timeout_seconds"
            ]
            config.settings.trading_simulation_enabled = original[
                "trading_simulation_enabled"
            ]
            config.settings.trading_simulation_clock_mode = original[
                "trading_simulation_clock_mode"
            ]
            config.settings.trading_simulation_window_start = original[
                "trading_simulation_window_start"
            ]
            config.settings.trading_account_label = original["trading_account_label"]
            time_source_module.TradingTimeSource._load_clickhouse_cursor = (
                original_load_cursor
            )
            time_source_module._TIME_SOURCE._cache_by_account.clear()

    def test_global_live_gate_cannot_bypass_missing_strategy_authority(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_autonomy_enabled": config.settings.trading_autonomy_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_simple_submit_enabled": config.settings.trading_simple_submit_enabled,
            "trading_live_submit_enabled": config.settings.trading_live_submit_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_autonomy_enabled = False
        config.settings.trading_autonomy_allow_live_promotion = False
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_live_submit_enabled = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="shadow-stage",
                    description="shadow stage block",
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
                timeframe="1Min",
                payload={
                    "macd": {"macd": 1.2, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
            )
            alpaca_client = FakeAlpacaClient()
            state = TradingState()
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
            pipeline._is_market_session_open = lambda _now=None: True

            with (
                patch(
                    "app.trading.submission_council._alpaca_broker_available",
                    return_value=True,
                ),
            ):
                pipeline.run_once()

            with self.session_local() as session:
                decision_rows = session.execute(select(TradeDecision)).scalars().all()
                self.assertEqual(len(decision_rows), 1)
                decision_row = decision_rows[0]
                self.assertEqual(decision_row.status, "blocked")
                decision_json = decision_row.decision_json
                assert isinstance(decision_json, dict)
                self.assertEqual(
                    decision_json.get("submission_stage"),
                    "blocked_strategy_capital_authority",
                )
                control_plane_snapshot = decision_json.get("control_plane_snapshot")
                assert isinstance(control_plane_snapshot, dict)
                self.assertEqual(
                    control_plane_snapshot.get("capital_stage"), "quarantined"
                )
                self.assertEqual(
                    control_plane_snapshot.get("trading_autonomy_allow_live_promotion"),
                    False,
                )
                live_submission_gate = control_plane_snapshot.get(
                    "live_submission_gate"
                )
                assert isinstance(live_submission_gate, dict)
                self.assertEqual(live_submission_gate.get("allowed"), True)
                self.assertEqual(
                    live_submission_gate.get("reason"),
                    "operational_submission_ready",
                )
                strategy_authority = decision_json.get("strategy_capital_authority")
                assert isinstance(strategy_authority, dict)
                self.assertEqual(
                    strategy_authority.get("reason_codes"), ["authority_missing"]
                )
                self.assertFalse(decision_row.strategy_capital_authority_allowed)
                self.assertIsNone(decision_row.strategy_capital_authority_id)
                self.assertIsNone(decision_row.strategy_capital_authority_digest)
                self.assertIsNotNone(
                    decision_row.strategy_capital_authority_evaluated_at
                )

            self.assertEqual(alpaca_client.submitted, [])
            self.assertEqual(
                state.metrics.submission_block_total.get("authority_missing"), 1
            )
            self.assertEqual(state.metrics.decision_state_total.get("blocked"), 1)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_autonomy_enabled = original[
                "trading_autonomy_enabled"
            ]
            config.settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_simple_submit_enabled = original[
                "trading_simple_submit_enabled"
            ]
            config.settings.trading_live_submit_enabled = original[
                "trading_live_submit_enabled"
            ]

    def test_matching_bounded_strategy_authority_allows_live_submission(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_autonomy_enabled": config.settings.trading_autonomy_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_simple_submit_enabled": config.settings.trading_simple_submit_enabled,
            "trading_live_submit_enabled": config.settings.trading_live_submit_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_autonomy_enabled = False
        config.settings.trading_autonomy_allow_live_promotion = False
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_live_submit_enabled = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="bounded-live",
                    description="exact strategy authority",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.flush()
                authority = self._activate_test_capital_authority(
                    session,
                    strategy=strategy,
                    account_mode="live",
                    account_label="live",
                )
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                timeframe="1Min",
                payload={
                    "macd": {"macd": 1.2, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
            )
            alpaca_client = FakeAlpacaClient()
            state = TradingState()
            self._prime_test_capital_state(state)
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
                account_label="live",
                session_factory=self.session_local,
            )
            pipeline._is_market_session_open = lambda _now=None: True

            with patch(
                "app.trading.submission_council._alpaca_broker_available",
                return_value=True,
            ):
                pipeline.run_once()

            with self.session_local() as session:
                decision_row = session.execute(select(TradeDecision)).scalar_one()
                self.assertEqual(decision_row.status, "submitted")
                authority_payload = decision_row.decision_json.get("params", {}).get(
                    "strategy_capital_authority"
                )
                assert isinstance(authority_payload, dict)
                self.assertTrue(authority_payload["allowed"])
                self.assertEqual(
                    authority_payload["authority_id"], authority.authority_id
                )
                self.assertEqual(
                    authority_payload["authority_digest"], authority.digest
                )
                self.assertTrue(decision_row.strategy_capital_authority_allowed)
                self.assertEqual(
                    decision_row.strategy_capital_authority_id,
                    authority.authority_id,
                )
                self.assertEqual(
                    decision_row.strategy_capital_authority_digest,
                    authority.digest,
                )
                self.assertIsNotNone(
                    decision_row.strategy_capital_authority_evaluated_at
                )
            self.assertEqual(len(alpaca_client.submitted), 1)
        finally:
            for name, value in original.items():
                setattr(config.settings, name, value)

    def test_live_submission_allows_autonomy_eligible_canary_without_static_flag(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_autonomy_enabled": config.settings.trading_autonomy_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_simple_submit_enabled": config.settings.trading_simple_submit_enabled,
            "trading_live_submit_enabled": config.settings.trading_live_submit_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_autonomy_enabled = False
        config.settings.trading_autonomy_allow_live_promotion = False
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_live_submit_enabled = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with self.session_local() as session:
                evidence_at = datetime.now(timezone.utc)
                strategy = Strategy(
                    name="live-canary-eligible",
                    description="promotion-eligible live canary",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.flush()
                self._activate_test_capital_authority(
                    session,
                    strategy=strategy,
                    account_mode="live",
                    account_label="live",
                )
                session.add(
                    StrategyHypothesisMetricWindow(
                        run_id="run-1",
                        candidate_id="cand-1",
                        hypothesis_id="H-CONT-01",
                        observed_stage="live",
                        window_started_at=evidence_at - timedelta(minutes=15),
                        window_ended_at=evidence_at,
                        market_session_count=1,
                        decision_count=1,
                        trade_count=1,
                        order_count=1,
                        continuity_ok=True,
                        drift_ok=True,
                        dependency_quorum_decision="allow",
                        post_cost_expectancy_bps="2.5",
                        avg_abs_slippage_bps="1.0",
                        slippage_budget_bps="5.0",
                        capital_stage="0.10x canary",
                        payload_json=self._runtime_ledger_weighted_window_payload(),
                    )
                )
                session.add(
                    StrategyPromotionDecision(
                        run_id="run-1",
                        candidate_id="cand-1",
                        hypothesis_id="H-CONT-01",
                        promotion_target="live",
                        state="0.10x canary",
                        allowed=True,
                        reason_summary="ready",
                    )
                )
                session.add(
                    self._runtime_ledger_bucket(
                        run_id="run-1",
                        candidate_id="cand-1",
                        hypothesis_id="H-CONT-01",
                        strategy_family="live-canary-eligible",
                        post_cost_expectancy_bps=Decimal("2.5"),
                        bucket_at=evidence_at,
                    )
                )
                session.add(
                    StrategyHypothesis(
                        hypothesis_id="H-CONT-01",
                        lane_id="lane-cand-1",
                        strategy_family="live-canary-eligible",
                        active=True,
                    )
                )
                session.add(
                    VNextDatasetSnapshot(
                        run_id="run-1",
                        candidate_id="cand-1",
                        dataset_id="dataset-cand-1",
                        source="historical_market_replay",
                        dataset_version="run-1",
                        artifact_ref="s3://torghut/empirical/cand-1",
                    )
                )
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
            self._prime_test_capital_state(state)
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
                account_label="live",
                session_factory=self.session_local,
            )
            pipeline._is_market_session_open = lambda _now=None: True

            with (
                patch(
                    "app.trading.submission_council._alpaca_broker_available",
                    return_value=True,
                ),
            ):
                pipeline.run_once()

            with self.session_local() as session:
                decision_rows = session.execute(select(TradeDecision)).scalars().all()
                self.assertEqual(len(decision_rows), 1)
                self.assertNotEqual(decision_rows[0].status, "blocked")
                decision_json = decision_rows[0].decision_json
                assert isinstance(decision_json, dict)
                control_plane_snapshot = decision_json.get("control_plane_snapshot")
                assert isinstance(control_plane_snapshot, dict)
                live_submission_gate = control_plane_snapshot.get(
                    "live_submission_gate"
                )
                assert isinstance(live_submission_gate, dict)
                self.assertEqual(live_submission_gate.get("allowed"), True)
                self.assertEqual(
                    live_submission_gate.get("reason"),
                    "operational_submission_ready",
                )
                self.assertIsNone(
                    live_submission_gate.get("evidence_tuple", {}).get("hypothesis_id")
                )

            self.assertEqual(len(alpaca_client.submitted), 1)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_autonomy_enabled = original[
                "trading_autonomy_enabled"
            ]
            config.settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_simple_submit_enabled = original[
                "trading_simple_submit_enabled"
            ]
            config.settings.trading_live_submit_enabled = original[
                "trading_live_submit_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]

    def test_live_submission_ignores_autonomy_promotion_evidence_for_operational_submit(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_autonomy_enabled": config.settings.trading_autonomy_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_simple_submit_enabled": config.settings.trading_simple_submit_enabled,
            "trading_live_submit_enabled": config.settings.trading_live_submit_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_autonomy_enabled = False
        config.settings.trading_autonomy_allow_live_promotion = False
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_live_submit_enabled = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="live-canary-missing-proof",
                    description="autonomy evidence without promotion proof",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.flush()
                self._activate_test_capital_authority(
                    session,
                    strategy=strategy,
                    account_mode="live",
                    account_label="live",
                )
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
            self._prime_test_capital_state(state)
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
                account_label="live",
                session_factory=self.session_local,
            )
            pipeline._is_market_session_open = lambda _now=None: True

            with (
                patch(
                    "app.trading.submission_council._alpaca_broker_available",
                    return_value=True,
                ),
            ):
                pipeline.run_once()

            with self.session_local() as session:
                decision_rows = session.execute(select(TradeDecision)).scalars().all()
                self.assertEqual(len(decision_rows), 1)
                self.assertNotEqual(decision_rows[0].status, "blocked")
                decision_json = decision_rows[0].decision_json
                assert isinstance(decision_json, dict)
                control_plane_snapshot = decision_json.get("control_plane_snapshot")
                assert isinstance(control_plane_snapshot, dict)
                live_submission_gate = control_plane_snapshot.get(
                    "live_submission_gate"
                )
                assert isinstance(live_submission_gate, dict)
                self.assertEqual(live_submission_gate.get("allowed"), True)
                self.assertEqual(
                    live_submission_gate.get("reason"),
                    "operational_submission_ready",
                )
                self.assertNotIn(
                    "hypothesis_not_promotion_eligible",
                    live_submission_gate.get("blocked_reasons", []),
                )

            self.assertNotEqual(alpaca_client.submitted, [])
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_autonomy_enabled = original[
                "trading_autonomy_enabled"
            ]
            config.settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_simple_submit_enabled = original[
                "trading_simple_submit_enabled"
            ]
            config.settings.trading_live_submit_enabled = original[
                "trading_live_submit_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
