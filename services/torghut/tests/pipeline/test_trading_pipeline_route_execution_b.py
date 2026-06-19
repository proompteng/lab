from __future__ import annotations

from tests.pipeline.trading_pipeline_base import (
    CursorAdvancingFakeIngestor,
    Decimal,
    DecisionEngine,
    FakeAlpacaClient,
    FakeIngestor,
    OrderExecutor,
    OrderFirewall,
    Reconciler,
    RecordingDecisionEngine,
    RiskEngine,
    SignalBatch,
    SignalEnvelope,
    Strategy,
    TradingPipeline,
    TradingPipelineTestCaseBase,
    TradingState,
    UniverseResolver,
    WarmupIngestor,
    _with_default_executable_quote,
    datetime,
    patch,
    timedelta,
    timezone,
)


class TestTradingPipelineRouteExecutionB(TradingPipelineTestCaseBase):
    def test_pipeline_skips_stale_feature_batch_and_commits_cursor(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "trading_feature_quality_enabled": config.settings.trading_feature_quality_enabled,
            "trading_feature_max_staleness_ms": config.settings.trading_feature_max_staleness_ms,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_mode = "paper"
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.trading_feature_quality_enabled = True
        config.settings.trading_feature_max_staleness_ms = 1_000

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="quality-gate regression",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            stale_signal = SignalEnvelope(
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                ingest_ts=datetime(2026, 1, 1, 0, 0, 5, tzinfo=timezone.utc),
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

            execution_adapter = FakeAlpacaClient()
            ingestor = CursorAdvancingFakeIngestor(
                [stale_signal],
                cursor_at=stale_signal.event_ts,
                cursor_seq=stale_signal.seq,
                cursor_symbol=stale_signal.symbol,
            )
            state = TradingState()
            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
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
            pipeline.run_once()

            self.assertEqual(ingestor.committed_batches, 2)
            self.assertEqual(state.metrics.feature_quality_rejections_total, 1)
            self.assertEqual(
                state.metrics.feature_quality_reject_reason_total.get(
                    "feature_staleness_exceeds_budget"
                ),
                1,
            )
            self.assertIsNone(
                state.metrics.feature_quality_cursor_commit_blocked_total.get(
                    "feature_staleness_exceeds_budget"
                )
            )
            self.assertGreater(state.metrics.feature_staleness_ms_p95, 1_000)
            self.assertEqual(execution_adapter.submitted, [])
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
            config.settings.trading_feature_quality_enabled = original[
                "trading_feature_quality_enabled"
            ]
            config.settings.trading_feature_max_staleness_ms = original[
                "trading_feature_max_staleness_ms"
            ]

    def test_signal_batch_preserves_lag_metric_for_alpha_readiness(self) -> None:
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
        batch = SignalBatch(
            signals=[_with_default_executable_quote(signal)],
            cursor_at=signal.event_ts,
            cursor_seq=signal.seq,
            cursor_symbol=signal.symbol,
            query_start=signal.event_ts - timedelta(seconds=10),
            query_end=signal.event_ts,
            signal_lag_seconds=4.9,
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
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: True

        with self.session_local() as session:
            prepared = pipeline._prepare_batch_for_decisions(
                session,
                batch,
                quality_signals=batch.signals,
            )

        self.assertTrue(prepared)
        self.assertEqual(pipeline.state.metrics.signal_lag_seconds, 4)
        self.assertEqual(pipeline.state.last_signal_continuity_state, "signals_present")
        self.assertFalse(bool(pipeline.state.last_signal_continuity_actionable))

    def test_signal_batch_counts_feature_rows_when_quality_enforcement_disabled(
        self,
    ) -> None:
        from app import config

        original = config.settings.trading_feature_quality_enabled
        config.settings.trading_feature_quality_enabled = False
        try:
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
            batch = SignalBatch(
                signals=[_with_default_executable_quote(signal)],
                cursor_at=signal.event_ts,
                cursor_seq=signal.seq,
                cursor_symbol=signal.symbol,
                query_start=signal.event_ts - timedelta(seconds=10),
                query_end=signal.event_ts,
                signal_lag_seconds=4.9,
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
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
            )
            pipeline._is_market_session_open = lambda _now=None: True

            with self.session_local() as session:
                prepared = pipeline._prepare_batch_for_decisions(
                    session,
                    batch,
                    quality_signals=batch.signals,
                )

            self.assertTrue(prepared)
            self.assertEqual(pipeline.state.metrics.feature_batch_rows_total, 1)
        finally:
            config.settings.trading_feature_quality_enabled = original

    def test_pipeline_blocks_cursor_on_non_staleness_feature_quality_failure(
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
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_mode = "paper"
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.trading_feature_quality_enabled = True
        config.settings.trading_feature_max_staleness_ms = 1_000

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="schema quality-gate regression",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            malformed_schema_signal = SignalEnvelope(
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                ingest_ts=datetime(2026, 1, 1, 0, 0, 0, 500000, tzinfo=timezone.utc),
                symbol="AAPL",
                timeframe="1Min",
                seq=1,
                payload={
                    "feature_schema_version": "2.0.0",
                    "macd": {"macd": 1.2, "signal": 0.5},
                    "rsi14": 25,
                    "price": 100,
                },
            )

            execution_adapter = FakeAlpacaClient()
            ingestor = FakeIngestor(
                [malformed_schema_signal],
                cursor_at=malformed_schema_signal.event_ts,
                cursor_seq=malformed_schema_signal.seq,
                cursor_symbol=malformed_schema_signal.symbol,
            )
            state = TradingState()
            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
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

            self.assertEqual(ingestor.committed_batches, 0)
            self.assertEqual(state.metrics.feature_quality_rejections_total, 1)
            self.assertEqual(
                state.metrics.feature_quality_reject_reason_total.get(
                    "schema_mismatch"
                ),
                1,
            )
            self.assertEqual(
                state.metrics.feature_quality_cursor_commit_blocked_total.get(
                    "schema_mismatch"
                ),
                1,
            )
            self.assertEqual(execution_adapter.submitted, [])
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
            config.settings.trading_feature_quality_enabled = original[
                "trading_feature_quality_enabled"
            ]
            config.settings.trading_feature_max_staleness_ms = original[
                "trading_feature_max_staleness_ms"
            ]

    def test_pipeline_accepts_replayed_batch_in_simulation_mode(self) -> None:
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
        config.settings.trading_mode = "paper"
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.trading_feature_quality_enabled = True
        config.settings.trading_feature_max_staleness_ms = 1_000
        config.settings.trading_kill_switch_enabled = False

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="simulation replay staleness regression",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            replayed_signal = SignalEnvelope(
                event_ts=datetime(2026, 3, 13, 13, 30, tzinfo=timezone.utc),
                ingest_ts=datetime(2026, 3, 15, 4, 2, 24, 236000, tzinfo=timezone.utc),
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
            execution_adapter = FakeAlpacaClient()
            ingestor = FakeIngestor([replayed_signal])
            state = TradingState()
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
            pipeline._is_market_session_open = lambda _now=None: True

            with patch(
                "app.trading.features.simulation_context_enabled",
                return_value=True,
            ):
                pipeline.run_once()

            self.assertEqual(ingestor.committed_batches, 1)
            self.assertEqual(state.metrics.feature_quality_rejections_total, 0)
            self.assertEqual(state.metrics.feature_staleness_ms_p95, 0)
            self.assertEqual(len(alpaca_client.submitted), 1)
            self.assertEqual(alpaca_client.submitted[0]["symbol"], "AAPL")
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
            config.settings.trading_feature_quality_enabled = original[
                "trading_feature_quality_enabled"
            ]
            config.settings.trading_feature_max_staleness_ms = original[
                "trading_feature_max_staleness_ms"
            ]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]

    def test_pipeline_suppresses_no_signal_alert_during_bootstrap_grace(self) -> None:
        from app import config

        original = {
            "trading_signal_no_signal_streak_alert_threshold": config.settings.trading_signal_no_signal_streak_alert_threshold,
            "trading_signal_bootstrap_grace_seconds": config.settings.trading_signal_bootstrap_grace_seconds,
        }
        config.settings.trading_signal_no_signal_streak_alert_threshold = 1
        config.settings.trading_signal_bootstrap_grace_seconds = 180

        try:
            state = TradingState()
            state.signal_bootstrap_started_at = datetime.now(timezone.utc)
            state.signal_bootstrap_completed_at = None
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
                state=state,
                account_label="paper",
                session_factory=self.session_local,
            )
            pipeline._is_market_session_open = lambda _now=None: True

            with patch(
                "app.trading.scheduler.pipeline.decision_lifecycle.signal_bootstrap_grace_active",
                return_value=True,
            ):
                pipeline.record_no_signal_batch(
                    SignalBatch(
                        signals=[],
                        cursor_at=datetime(2026, 3, 13, 13, 30, tzinfo=timezone.utc),
                        cursor_seq=1,
                        cursor_symbol="AAPL",
                        no_signal_reason="no_signals_in_window",
                    )
                )

            self.assertFalse(state.last_signal_continuity_actionable)
            self.assertFalse(state.signal_continuity_alert_active)
            self.assertEqual(state.metrics.signal_continuity_actionable, 0)
            self.assertEqual(
                state.metrics.signal_expected_staleness_total.get(
                    "no_signals_in_window"
                ),
                1,
            )
        finally:
            config.settings.trading_signal_no_signal_streak_alert_threshold = original[
                "trading_signal_no_signal_streak_alert_threshold"
            ]
            config.settings.trading_signal_bootstrap_grace_seconds = original[
                "trading_signal_bootstrap_grace_seconds"
            ]

    def test_pipeline_treats_fresh_tail_state_as_expected_staleness(self) -> None:
        from app import config

        original = {
            "trading_signal_no_signal_streak_alert_threshold": config.settings.trading_signal_no_signal_streak_alert_threshold,
            "trading_signal_stale_lag_alert_seconds": config.settings.trading_signal_stale_lag_alert_seconds,
            "trading_signal_bootstrap_grace_seconds": config.settings.trading_signal_bootstrap_grace_seconds,
        }
        config.settings.trading_signal_no_signal_streak_alert_threshold = 1
        config.settings.trading_signal_stale_lag_alert_seconds = 300
        config.settings.trading_signal_bootstrap_grace_seconds = 0

        try:
            state = TradingState()
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
                state=state,
                account_label="paper",
                session_factory=self.session_local,
            )
            pipeline._is_market_session_open = lambda _now=None: True

            pipeline.record_no_signal_batch(
                SignalBatch(
                    signals=[],
                    cursor_at=datetime(2026, 5, 5, 18, 3, tzinfo=timezone.utc),
                    cursor_seq=10,
                    cursor_symbol="NVDA",
                    no_signal_reason="cursor_tail_stable",
                    signal_lag_seconds=68,
                )
            )

            self.assertFalse(state.last_signal_continuity_actionable)
            self.assertFalse(state.signal_continuity_alert_active)
            self.assertEqual(state.metrics.signal_continuity_actionable, 0)
            self.assertEqual(state.metrics.signal_lag_seconds, 68)
            self.assertEqual(
                state.metrics.signal_expected_staleness_total.get("cursor_tail_stable"),
                1,
            )
            self.assertNotIn(
                "cursor_tail_stable",
                state.metrics.signal_staleness_alert_total,
            )
        finally:
            config.settings.trading_signal_no_signal_streak_alert_threshold = original[
                "trading_signal_no_signal_streak_alert_threshold"
            ]
            config.settings.trading_signal_stale_lag_alert_seconds = original[
                "trading_signal_stale_lag_alert_seconds"
            ]
            config.settings.trading_signal_bootstrap_grace_seconds = original[
                "trading_signal_bootstrap_grace_seconds"
            ]

    def test_pipeline_alerts_when_tail_lag_is_stale(self) -> None:
        from app import config

        original = {
            "trading_signal_no_signal_streak_alert_threshold": config.settings.trading_signal_no_signal_streak_alert_threshold,
            "trading_signal_stale_lag_alert_seconds": config.settings.trading_signal_stale_lag_alert_seconds,
            "trading_signal_bootstrap_grace_seconds": config.settings.trading_signal_bootstrap_grace_seconds,
        }
        config.settings.trading_signal_no_signal_streak_alert_threshold = 1
        config.settings.trading_signal_stale_lag_alert_seconds = 300
        config.settings.trading_signal_bootstrap_grace_seconds = 0

        try:
            state = TradingState()
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
                state=state,
                account_label="paper",
                session_factory=self.session_local,
            )
            pipeline._is_market_session_open = lambda _now=None: True

            pipeline.record_no_signal_batch(
                SignalBatch(
                    signals=[],
                    cursor_at=datetime(2026, 5, 5, 18, 10, tzinfo=timezone.utc),
                    cursor_seq=11,
                    cursor_symbol="NVDA",
                    no_signal_reason="cursor_tail_stable",
                    signal_lag_seconds=301,
                )
            )

            self.assertTrue(state.last_signal_continuity_actionable)
            self.assertTrue(state.signal_continuity_alert_active)
            self.assertEqual(state.signal_continuity_alert_reason, "cursor_tail_stable")
            self.assertEqual(state.metrics.signal_continuity_actionable, 1)
            self.assertEqual(state.metrics.signal_lag_seconds, 301)
            self.assertEqual(
                state.metrics.signal_actionable_staleness_total.get(
                    "cursor_tail_stable"
                ),
                1,
            )
            self.assertEqual(
                state.metrics.signal_staleness_alert_total.get("cursor_tail_stable"),
                1,
            )
        finally:
            config.settings.trading_signal_no_signal_streak_alert_threshold = original[
                "trading_signal_no_signal_streak_alert_threshold"
            ]
            config.settings.trading_signal_stale_lag_alert_seconds = original[
                "trading_signal_stale_lag_alert_seconds"
            ]
            config.settings.trading_signal_bootstrap_grace_seconds = original[
                "trading_signal_bootstrap_grace_seconds"
            ]

    def test_pipeline_quality_gate_uses_allowed_symbol_subset(self) -> None:
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
        config.settings.trading_mode = "paper"
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.trading_feature_quality_enabled = True
        config.settings.trading_feature_max_staleness_ms = 1_000
        config.settings.trading_kill_switch_enabled = False

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="quality-gate subset regression",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            fresh_allowed_signal = SignalEnvelope(
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
            stale_out_of_universe_signal = SignalEnvelope(
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                ingest_ts=datetime(2026, 1, 1, 0, 0, 5, tzinfo=timezone.utc),
                symbol="MSFT",
                timeframe="1Min",
                seq=2,
                payload={
                    "feature_schema_version": "3.0.0",
                    "macd": {"macd": 1.2, "signal": 0.5},
                    "rsi14": 25,
                    "price": 100,
                    "spread": 1,
                },
            )

            alpaca_client = FakeAlpacaClient()
            execution_adapter = FakeAlpacaClient()
            decision_engine = RecordingDecisionEngine()
            ingestor = FakeIngestor(
                [fresh_allowed_signal, stale_out_of_universe_signal]
            )
            state = TradingState()
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=ingestor,
                decision_engine=decision_engine,
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
            self.assertEqual(state.metrics.feature_quality_rejections_total, 0)
            self.assertEqual(state.metrics.feature_batch_rows_total, 1)
            self.assertLessEqual(state.metrics.feature_staleness_ms_p95, 1_000)
            self.assertEqual(len(alpaca_client.submitted), 1)
            self.assertEqual(alpaca_client.submitted[0]["symbol"], "AAPL")
            self.assertNotIn("MSFT", decision_engine.observed_symbols)
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
            config.settings.trading_feature_quality_enabled = original[
                "trading_feature_quality_enabled"
            ]
            config.settings.trading_feature_max_staleness_ms = original[
                "trading_feature_max_staleness_ms"
            ]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]

    def test_relevant_signal_symbols_ignore_disabled_strategies(self) -> None:
        enabled_strategy = Strategy(
            name="enabled-filter-source",
            description="enabled source",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
        )
        disabled_strategy = Strategy(
            name="disabled-filter-source",
            description="disabled source",
            enabled=False,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["MSFT"],
        )

        pipeline = self._build_warmup_pipeline(
            ingestor=WarmupIngestor(
                warmup_signals=[],
                signals=[],
                cursor_at=datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
            )
        )

        relevant_symbols = pipeline._relevant_signal_symbols(
            strategies=[enabled_strategy, disabled_strategy],
            allowed_symbols={"AAPL", "MSFT"},
        )

        self.assertEqual(relevant_symbols, {"AAPL"})
