from __future__ import annotations

from tests.pipeline.trading_pipeline_base import (
    CountingAlpacaClient,
    CursorErrorWarmupIngestor,
    Decimal,
    DecisionEngine,
    FakeAlpacaClient,
    FakeIngestor,
    FetchErrorWarmupIngestor,
    Mock,
    OrderExecutor,
    OrderFirewall,
    PositionSnapshot,
    RaisingObserveDecisionEngine,
    Reconciler,
    RecordingDecisionEngine,
    RiskEngine,
    Session,
    SignalEnvelope,
    SimpleTradingPipeline,
    Strategy,
    TradingPipeline,
    TradingPipelineTestCaseBase,
    TradingState,
    TransactionAwareWarmupIngestor,
    UniverseResolver,
    WarmupIngestor,
    cast,
    date,
    datetime,
    patch,
    select,
    timezone,
)


class TestTradingPipelineWarmupSubmissionA(TradingPipelineTestCaseBase):
    def test_pipeline_empty_signal_batch_commits_cursor(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="empty-signal regression",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            ingestor = FakeIngestor([])
            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=ingestor,
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

            pipeline.run_once()
            self.assertEqual(ingestor.committed_batches, 1)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]

    def test_simple_pipeline_snapshots_account_for_paper_route_window_without_signals(
        self,
    ) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_paper_route_target_plan_url = ""
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "AAPL"

        with self.session_local() as session:
            session.add(
                Strategy(
                    name="paper-route-window-snapshot",
                    description="pre-open account snapshot regression",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
            )
            session.commit()

        alpaca_client = CountingAlpacaClient()
        ingestor = FakeIngestor([])
        pipeline = SimpleTradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=ingestor,
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="TORGHUT_SIM",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: False

        with patch(
            "app.trading.scheduler.pipeline_modules.run_cycle.trading_now",
            return_value=datetime(2026, 3, 26, 13, 20, tzinfo=timezone.utc),
        ):
            pipeline.run_once()
            pipeline.run_once()

        with self.session_local() as session:
            snapshots = session.scalars(select(PositionSnapshot)).all()

        self.assertEqual(len(snapshots), 1)
        self.assertEqual(snapshots[0].alpaca_account_label, "TORGHUT_SIM")
        self.assertEqual(alpaca_client.account_calls, 1)
        self.assertEqual(alpaca_client.position_calls, 1)
        self.assertEqual(ingestor.committed_batches, 2)

    def test_runtime_window_account_snapshot_skips_existing_snapshot(self) -> None:
        from app import config

        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_paper_route_target_plan_url = ""

        alpaca_client = CountingAlpacaClient()
        pipeline = TradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="TORGHUT_SIM",
            session_factory=self.session_local,
        )

        with self.session_local() as session:
            session.add(
                PositionSnapshot(
                    alpaca_account_label="TORGHUT_SIM",
                    as_of=datetime(2026, 3, 26, 13, 20, tzinfo=timezone.utc),
                    equity=Decimal("100000"),
                    cash=Decimal("100000"),
                    buying_power=Decimal("200000"),
                    positions=[],
                )
            )
            session.commit()

            with patch(
                "app.trading.scheduler.pipeline_modules.run_cycle.trading_now",
                return_value=datetime(2026, 3, 26, 13, 20, tzinfo=timezone.utc),
            ):
                pipeline._capture_runtime_window_account_snapshot_if_due(session)

        self.assertEqual(
            pipeline._runtime_window_account_snapshot_day, date(2026, 3, 26)
        )
        self.assertEqual(alpaca_client.account_calls, 0)
        self.assertEqual(alpaca_client.position_calls, 0)

    def test_runtime_window_account_snapshot_rolls_back_capture_failure(self) -> None:
        from app import config

        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_paper_route_target_plan_url = ""

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
            account_label="TORGHUT_SIM",
            session_factory=self.session_local,
        )
        pipeline._get_account_snapshot = Mock(
            side_effect=RuntimeError("broker unavailable")
        )

        with self.session_local() as session:
            with patch(
                "app.trading.scheduler.pipeline_modules.run_cycle.trading_now",
                return_value=datetime(2026, 3, 26, 13, 20, tzinfo=timezone.utc),
            ):
                with self.assertLogs(
                    "app.trading.scheduler.pipeline_modules.run_cycle",
                    level="ERROR",
                ) as logs:
                    pipeline._capture_runtime_window_account_snapshot_if_due(session)

            snapshot_count = session.query(PositionSnapshot).count()

        self.assertEqual(snapshot_count, 0)
        self.assertIsNone(pipeline._runtime_window_account_snapshot_day)
        self.assertTrue(
            any(
                "Failed to capture runtime-window account snapshot" in message
                for message in logs.output
            )
        )

    def test_pipeline_warms_session_context_with_bounded_replay_window(self) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.trading_session_context_warmup_signal_limit = 3

        with self.session_local() as session:
            strategy = Strategy(
                name="warmup-demo",
                description="session warmup regression",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        warmup_signals = [
            SignalEnvelope(
                event_ts=datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
                ingest_ts=datetime(2026, 3, 26, 14, 0, 1, tzinfo=timezone.utc),
                symbol="AAPL",
                timeframe="1Min",
                seq=2,
                payload={"feature_schema_version": "3.0.0", "price": 101},
            ),
            SignalEnvelope(
                event_ts=datetime(2026, 3, 26, 14, 26, tzinfo=timezone.utc),
                ingest_ts=datetime(2026, 3, 26, 14, 26, 1, tzinfo=timezone.utc),
                symbol="AAPL",
                timeframe="1Min",
                seq=3,
                payload={"feature_schema_version": "3.0.0", "price": 102},
            ),
            SignalEnvelope(
                event_ts=datetime(2026, 3, 26, 14, 27, tzinfo=timezone.utc),
                ingest_ts=datetime(2026, 3, 26, 14, 27, 1, tzinfo=timezone.utc),
                symbol="MSFT",
                timeframe="1Min",
                seq=4,
                payload={"feature_schema_version": "3.0.0", "price": 250},
            ),
            SignalEnvelope(
                event_ts=datetime(2026, 3, 26, 14, 28, tzinfo=timezone.utc),
                ingest_ts=datetime(2026, 3, 26, 14, 28, 1, tzinfo=timezone.utc),
                symbol="AAPL",
                timeframe="1Min",
                seq=5,
                payload={"feature_schema_version": "3.0.0", "price": 103},
            ),
        ]
        cursor_at = datetime(2026, 3, 26, 14, 30, tzinfo=timezone.utc)
        ingestor = WarmupIngestor(
            warmup_signals=warmup_signals,
            signals=[],
            cursor_at=cursor_at,
        )
        decision_engine = RecordingDecisionEngine()
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=ingestor,
            decision_engine=decision_engine,
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

        with patch(
            "app.trading.scheduler.pipeline_modules.run_cycle.trading_now",
            return_value=datetime(2026, 3, 26, 15, 0, tzinfo=timezone.utc),
        ):
            pipeline.run_once()
            pipeline.run_once()

        self.assertEqual(
            ingestor.warmup_ranges,
            [
                (
                    datetime(2026, 3, 26, 14, 25, tzinfo=timezone.utc),
                    cursor_at,
                )
            ],
        )
        self.assertEqual(ingestor.warmup_limits, [3])
        self.assertEqual(decision_engine.observed_symbols, ["AAPL", "AAPL"])
        self.assertEqual(ingestor.committed_batches, 2)

    def test_session_context_warmup_closes_transaction_before_replay_fetch(
        self,
    ) -> None:
        warmup_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 45, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 45, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=1,
            payload={"feature_schema_version": "3.0.0", "price": 100},
        )
        with self.session_local() as session:
            session.execute(select(Strategy).limit(1)).all()
            self.assertTrue(session.in_transaction())
            ingestor = TransactionAwareWarmupIngestor(
                warmup_signals=[warmup_signal],
                signals=[],
                cursor_at=datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
                transaction_probe=session.in_transaction,
            )
            pipeline = self._build_warmup_pipeline(ingestor=ingestor)

            with patch(
                "app.trading.scheduler.pipeline_modules.run_cycle.trading_now",
                return_value=datetime(2026, 3, 26, 15, 0, tzinfo=timezone.utc),
            ):
                pipeline._warm_session_context_from_open(session)

        self.assertFalse(ingestor.transaction_active_during_fetch)

    def test_session_context_warmup_rolls_back_when_transaction_close_fails(
        self,
    ) -> None:
        ingestor = WarmupIngestor(
            warmup_signals=[],
            signals=[],
            cursor_at=datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
        )
        pipeline = self._build_warmup_pipeline(ingestor=ingestor)
        session = Mock(spec=Session)
        session.commit.side_effect = RuntimeError("commit failed")

        with patch(
            "app.trading.scheduler.pipeline_modules.run_cycle.trading_now",
            return_value=datetime(2026, 3, 26, 15, 0, tzinfo=timezone.utc),
        ):
            pipeline._warm_session_context_from_open(cast(Session, session))

        session.rollback.assert_called_once()
        self.assertEqual(ingestor.warmup_ranges, [])
        self.assertIsNone(pipeline._session_context_warmup_day)

    def test_session_context_warmup_ignores_preopen_and_empty_cursor_windows(
        self,
    ) -> None:
        ingestor = WarmupIngestor(
            warmup_signals=[],
            signals=[],
            cursor_at=datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
        )
        pipeline = self._build_warmup_pipeline(ingestor=ingestor)

        with self.session_local() as session:
            with patch(
                "app.trading.scheduler.pipeline_modules.run_cycle.trading_now",
                return_value=datetime(2026, 3, 26, 12, 0, tzinfo=timezone.utc),
            ):
                pipeline._warm_session_context_from_open(session)

            ingestor.cursor_at = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)
            with patch(
                "app.trading.scheduler.pipeline_modules.run_cycle.trading_now",
                return_value=datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
            ):
                pipeline._warm_session_context_from_open(session)

        self.assertEqual(ingestor.warmup_ranges, [])

    def test_session_context_warmup_handles_cursor_and_fetch_errors(self) -> None:
        for ingestor in (
            CursorErrorWarmupIngestor(
                warmup_signals=[],
                signals=[],
                cursor_at=datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
            ),
            FetchErrorWarmupIngestor(
                warmup_signals=[],
                signals=[],
                cursor_at=datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
            ),
        ):
            pipeline = self._build_warmup_pipeline(ingestor=ingestor)
            with self.session_local() as session:
                with patch(
                    "app.trading.scheduler.pipeline_modules.run_cycle.trading_now",
                    return_value=datetime(2026, 3, 26, 15, 0, tzinfo=timezone.utc),
                ):
                    pipeline._warm_session_context_from_open(session)

            self.assertIsNone(pipeline._session_context_warmup_day)

    def test_session_context_warmup_normalizes_naive_cursor_and_skips_bad_signals(
        self,
    ) -> None:
        warmup_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 45, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 45, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=1,
            payload={"feature_schema_version": "3.0.0", "price": 100},
        )
        ingestor = WarmupIngestor(
            warmup_signals=[warmup_signal],
            signals=[],
            cursor_at=datetime(2026, 3, 26, 14, 0),
        )
        pipeline = self._build_warmup_pipeline(
            ingestor=ingestor,
            decision_engine=RaisingObserveDecisionEngine(),
        )

        with self.session_local() as session:
            with patch(
                "app.trading.scheduler.pipeline_modules.run_cycle.trading_now",
                return_value=datetime(2026, 3, 26, 15, 0, tzinfo=timezone.utc),
            ):
                pipeline._warm_session_context_from_open(session)

        self.assertEqual(
            ingestor.warmup_ranges,
            [
                (
                    datetime(2026, 3, 26, 13, 55, tzinfo=timezone.utc),
                    datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
                )
            ],
        )
        self.assertEqual(
            pipeline._session_context_warmup_day,
            datetime(2026, 3, 26, tzinfo=timezone.utc).date(),
        )
