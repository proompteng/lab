from __future__ import annotations

from tests.pipeline.trading_pipeline_base import (
    Decimal,
    DecisionEngine,
    FakeAlpacaClient,
    FakeIngestor,
    OrderExecutor,
    OrderFirewall,
    Reconciler,
    RiskEngine,
    Session,
    SignalBatch,
    SignalEnvelope,
    SimpleTradingPipeline,
    Strategy,
    TradingPipeline,
    TradingPipelineTestCaseBase,
    TradingState,
    UniverseResolver,
    datetime,
    patch,
    timezone,
)


class SessionRecordingIngestor(FakeIngestor):
    def __init__(self, signals: list[SignalEnvelope]) -> None:
        super().__init__(signals)
        self.fetch_session_id: int | None = None
        self.commit_session_ids: list[int] = []

    def fetch_signals(
        self,
        session: Session,
        *,
        symbols: set[str] | None = None,
        timeframes: set[str] | None = None,
    ) -> SignalBatch:
        self.fetch_session_id = id(session)
        return super().fetch_signals(
            session,
            symbols=symbols,
            timeframes=timeframes,
        )

    def commit_cursor(self, session: Session, batch: SignalBatch) -> None:
        self.commit_session_ids.append(id(session))
        super().commit_cursor(session, batch)


class TestTradingPipelineCursorCommit(TradingPipelineTestCaseBase):
    def test_simple_pipeline_commits_cursor_with_fresh_session(self) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 6, 18, 15, 0, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 6, 18, 15, 0, 1, tzinfo=timezone.utc),
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
        ingestor = SessionRecordingIngestor([signal])
        pipeline = SimpleTradingPipeline(
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
        strategy = Strategy(
            name="demo",
            description="cursor commit session isolation",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )

        with (
            patch.object(pipeline, "_label_mature_rejected_signal_outcome_events"),
            patch.object(pipeline, "_prepare_run_once", return_value=[strategy]),
            patch.object(pipeline, "_capture_runtime_window_account_snapshot_if_due"),
            patch.object(pipeline, "_warm_session_context_from_open"),
            patch.object(
                pipeline, "_bounded_paper_route_signal_scope", return_value=None
            ),
            patch.object(pipeline, "_build_run_context", return_value=None),
        ):
            pipeline.run_once()

        self.assertIsNotNone(ingestor.fetch_session_id)
        self.assertEqual(ingestor.committed_batches, 1)
        self.assertEqual(len(ingestor.commit_session_ids), 1)
        self.assertNotEqual(ingestor.fetch_session_id, ingestor.commit_session_ids[0])

    def test_full_pipeline_commits_cursor_with_fresh_session_when_context_missing(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 6, 18, 15, 1, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 6, 18, 15, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=2,
            payload={
                "feature_schema_version": "3.0.0",
                "macd": {"macd": 1.2, "signal": 0.5},
                "rsi14": 25,
                "price": 100,
            },
        )
        ingestor = SessionRecordingIngestor([signal])
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
        strategy = Strategy(
            name="demo",
            description="cursor commit session isolation",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )

        with (
            patch.object(pipeline, "_label_mature_rejected_signal_outcome_events"),
            patch.object(pipeline, "_prepare_run_once", return_value=[strategy]),
            patch.object(pipeline, "_capture_runtime_window_account_snapshot_if_due"),
            patch.object(pipeline, "_warm_session_context_from_open"),
            patch.object(pipeline, "_build_run_context", return_value=None),
        ):
            pipeline.run_once()

        self.assertIsNotNone(ingestor.fetch_session_id)
        self.assertEqual(ingestor.committed_batches, 1)
        self.assertEqual(len(ingestor.commit_session_ids), 1)
        self.assertNotEqual(ingestor.fetch_session_id, ingestor.commit_session_ids[0])
