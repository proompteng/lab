from __future__ import annotations

from tests.signal_ingest.support import (
    Base,
    CapturingIngestor,
    ClickHouseSignalIngestor,
    SchemaDiscoveringIngestor,
    SimulationWindowIngestor,
    SimulationWindowNoLatestIngestor,
    TradeCursor,
    _TestSignalIngestBase,
    assess_signal_quote_quality,
    create_engine,
    datetime,
    json,
    patch,
    sessionmaker,
    settings,
    timezone,
)


class TestParseEnvelopeRow(_TestSignalIngestBase):
    def test_parse_envelope_row(self) -> None:
        ingestor = ClickHouseSignalIngestor(
            schema="envelope", fast_forward_stale_cursor=False
        )
        row = {
            "event_ts": datetime(2026, 1, 1, tzinfo=timezone.utc),
            "ingest_ts": datetime(2026, 1, 1, tzinfo=timezone.utc),
            "symbol": "AAPL",
            "payload": {"macd": {"macd": 0.5, "signal": 0.2}, "rsi14": 22},
            "window": {"size": "PT1M"},
            "seq": 10,
            "source": "ta",
        }
        signal = ingestor.parse_row(row)
        self.assertIsNotNone(signal)
        assert signal is not None
        self.assertEqual(signal.symbol, "AAPL")
        self.assertEqual(signal.payload.get("rsi14"), 22)
        self.assertEqual(signal.timeframe, "1Min")

    def test_parse_envelope_row_backfills_flat_executable_quote_fields(self) -> None:
        ingestor = ClickHouseSignalIngestor(
            schema="envelope", fast_forward_stale_cursor=False
        )
        row = {
            "event_ts": datetime(2026, 1, 1, tzinfo=timezone.utc),
            "ingest_ts": datetime(2026, 1, 1, tzinfo=timezone.utc),
            "symbol": "NVDA",
            "payload": {
                "macd": {"macd": 0.5, "signal": 0.2},
                "price": None,
                "imbalance": {"bid_px": None, "ask_px": None, "spread": None},
            },
            "window": {"size": "PT1M"},
            "seq": 10,
            "source": "ta",
            "imbalance_bid_px": 125.70,
            "imbalance_ask_px": 125.80,
            "imbalance_spread": 0.10,
        }
        signal = ingestor.parse_row(row)
        self.assertIsNotNone(signal)
        assert signal is not None
        self.assertEqual(signal.payload.get("price"), 125.75)
        self.assertEqual(signal.payload.get("imbalance_bid_px"), 125.70)
        self.assertEqual(signal.payload.get("imbalance_ask_px"), 125.80)
        self.assertEqual(signal.payload.get("imbalance", {}).get("bid_px"), 125.70)
        self.assertEqual(signal.payload.get("imbalance", {}).get("ask_px"), 125.80)
        self.assertEqual(signal.payload.get("imbalance", {}).get("spread"), 0.10)

        quote_status = assess_signal_quote_quality(
            signal=signal,
            previous_price=None,
        )
        self.assertTrue(quote_status.valid, quote_status.reason)

    def test_parse_flat_row(self) -> None:
        ingestor = ClickHouseSignalIngestor(
            schema="flat", fast_forward_stale_cursor=False
        )
        row = {
            "ts": "2026-01-01T00:00:01Z",
            "symbol": "MSFT",
            "macd": 0.8,
            "signal": 0.4,
            "rsi": 55.0,
            "ema12": 351.2,
            "ema26": 349.9,
            "vol_realized_w60s": 0.009,
            "microbar_volume": 18200,
            "signal_json": '{"vwap": 350.1}',
        }
        signal = ingestor.parse_row(row)
        self.assertIsNotNone(signal)
        assert signal is not None
        self.assertEqual(signal.symbol, "MSFT")
        self.assertIn("macd", signal.payload)
        self.assertEqual(signal.payload.get("rsi"), 55.0)
        self.assertEqual(signal.payload.get("vwap"), 350.1)
        self.assertEqual(signal.payload.get("ema12"), 351.2)
        self.assertEqual(signal.payload.get("ema26"), 349.9)
        self.assertEqual(signal.payload.get("vol_realized_w60s"), 0.009)
        self.assertEqual(signal.payload.get("microbar_volume"), 18200)

    def test_parse_flat_row_merges_deeplob_microstructure_signal_v1(self) -> None:
        ingestor = ClickHouseSignalIngestor(
            schema="flat", fast_forward_stale_cursor=False
        )
        row = {
            "ts": "2026-01-01T00:00:03Z",
            "symbol": "MSFT",
            "microstructure_signal_v1": json.dumps(
                {
                    "schema_version": "microstructure_signal_v1",
                    "symbol": "msft",
                    "horizon": "PT1S",
                    "direction_probabilities": {
                        "up": 0.7,
                        "flat": 0.1,
                        "down": 0.2,
                    },
                    "uncertainty_band": "high",
                    "expected_spread_impact_bps": 14.0,
                    "expected_slippage_bps": 9.2,
                    "feature_quality_status": "pass",
                    "artifact": {
                        "model_id": "deeplob-bdlob-v1",
                        "feature_schema_version": "microstructure_signal_v1",
                        "training_run_id": "run-abc-123",
                    },
                }
            ),
        }
        signal = ingestor.parse_row(row)
        self.assertIsNotNone(signal)
        assert signal is not None
        self.assertIn("microstructure_signal", signal.payload)
        microstructure = signal.payload.get("microstructure_signal")
        self.assertIsInstance(microstructure, dict)
        assert isinstance(microstructure, dict)
        self.assertEqual(
            microstructure.get("schema_version"), "microstructure_signal_v1"
        )
        self.assertEqual(
            microstructure.get("artifact", {}).get("model_id"),
            "deeplob-bdlob-v1",
        )

    def test_parse_flat_row_prefers_midpoint_price_when_available(self) -> None:
        ingestor = ClickHouseSignalIngestor(
            schema="flat", fast_forward_stale_cursor=False
        )
        row = {
            "ts": "2026-01-01T00:00:02Z",
            "symbol": "NVDA",
            "macd": 0.4,
            "signal": 0.2,
            "rsi14": 44,
            "vwap_session": 125.50,
            "spread": 0.08,
            "imbalance_bid_px": 125.70,
            "imbalance_ask_px": 125.80,
            "imbalance_spread": 0.08,
        }
        signal = ingestor.parse_row(row)
        self.assertIsNotNone(signal)
        assert signal is not None
        self.assertEqual(signal.payload.get("price"), 125.75)
        self.assertEqual(signal.payload.get("imbalance", {}).get("bid_px"), 125.70)
        self.assertEqual(signal.payload.get("imbalance", {}).get("ask_px"), 125.80)
        self.assertEqual(signal.payload.get("imbalance", {}).get("spread"), 0.08)

    def test_parse_flat_row_preserves_bid_ask_when_only_imbalance_spread_exists(
        self,
    ) -> None:
        ingestor = ClickHouseSignalIngestor(
            schema="flat", fast_forward_stale_cursor=False
        )
        row = {
            "ts": "2026-01-01T00:00:02Z",
            "symbol": "NVDA",
            "macd": 0.4,
            "signal": 0.2,
            "rsi14": 44,
            "vwap_session": 125.50,
            "imbalance_bid_px": 125.70,
            "imbalance_ask_px": 125.80,
            "imbalance_spread": 0.10,
        }
        signal = ingestor.parse_row(row)
        self.assertIsNotNone(signal)
        assert signal is not None
        self.assertEqual(signal.payload.get("price"), 125.75)
        self.assertEqual(signal.payload.get("imbalance", {}).get("bid_px"), 125.70)
        self.assertEqual(signal.payload.get("imbalance", {}).get("ask_px"), 125.80)
        self.assertEqual(signal.payload.get("imbalance", {}).get("spread"), 0.10)

    def test_parse_flat_row_uses_vwap_as_price_fallback_without_midpoint(self) -> None:
        ingestor = ClickHouseSignalIngestor(
            schema="flat", fast_forward_stale_cursor=False
        )
        row = {
            "ts": "2026-01-01T00:00:02Z",
            "symbol": "NVDA",
            "macd": 0.4,
            "signal": 0.2,
            "rsi14": 44,
            "vwap_session": 125.75,
        }
        signal = ingestor.parse_row(row)
        self.assertIsNotNone(signal)
        assert signal is not None
        self.assertEqual(signal.payload.get("price"), 125.75)

    def test_parse_row_attaches_simulation_context_from_row_fields(self) -> None:
        ingestor = ClickHouseSignalIngestor(
            schema="envelope", fast_forward_stale_cursor=False
        )
        row = {
            "event_ts": datetime(2026, 1, 1, tzinfo=timezone.utc),
            "symbol": "AAPL",
            "seq": 55,
            "payload": {
                "macd": {"macd": 0.5, "signal": 0.2},
                "rsi14": 30,
            },
            "dataset_event_id": "evt-55",
            "source_topic": "torghut.trades.v1",
            "source_partition": 2,
            "source_offset": 900,
            "replay_topic": "torghut.sim.trades.v1",
        }
        original_enabled = settings.trading_simulation_enabled
        original_run_id = settings.trading_simulation_run_id
        original_dataset_id = settings.trading_simulation_dataset_id
        try:
            settings.trading_simulation_enabled = True
            settings.trading_simulation_run_id = "sim-2026-02-27-01"
            settings.trading_simulation_dataset_id = "dataset-a"
            signal = ingestor.parse_row(row)
        finally:
            settings.trading_simulation_enabled = original_enabled
            settings.trading_simulation_run_id = original_run_id
            settings.trading_simulation_dataset_id = original_dataset_id

        self.assertIsNotNone(signal)
        assert signal is not None
        context = signal.payload.get("simulation_context")
        self.assertIsInstance(context, dict)
        assert isinstance(context, dict)
        self.assertEqual(context.get("simulation_run_id"), "sim-2026-02-27-01")
        self.assertEqual(context.get("dataset_id"), "dataset-a")
        self.assertEqual(context.get("dataset_event_id"), "evt-55")
        self.assertEqual(context.get("source_topic"), "torghut.trades.v1")
        self.assertEqual(context.get("signal_seq"), 55)

    def test_simulation_mode_disables_cursor_fast_forward_and_empty_batch_advance(
        self,
    ) -> None:
        original_enabled = settings.trading_simulation_enabled
        original_empty_batch_advance = (
            settings.trading_signal_empty_batch_advance_seconds
        )
        try:
            settings.trading_simulation_enabled = True
            settings.trading_signal_empty_batch_advance_seconds = 60
            ingestor = ClickHouseSignalIngestor(schema="envelope", url="http://example")
        finally:
            settings.trading_simulation_enabled = original_enabled
            settings.trading_signal_empty_batch_advance_seconds = (
                original_empty_batch_advance
            )

        self.assertFalse(ingestor.fast_forward_stale_cursor)
        self.assertEqual(ingestor.empty_batch_advance_seconds, 0)

    def test_simulation_mode_initial_cursor_uses_simulated_window_start(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        original_enabled = settings.trading_simulation_enabled
        try:
            settings.trading_simulation_enabled = True
            ingestor = ClickHouseSignalIngestor(schema="envelope", url="http://example")
            with (
                session_local() as session,
                patch(
                    "app.trading.ingest.clickhouse_signal_ingestor_persistence_methods.trading_now",
                    return_value=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                ) as mocked_trading_now,
            ):
                cursor_at, cursor_seq, cursor_symbol = ingestor._get_cursor(session)
        finally:
            settings.trading_simulation_enabled = original_enabled

        mocked_trading_now.assert_called_once_with(account_label=ingestor.account_label)
        self.assertEqual(cursor_at, datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc))
        self.assertIsNone(cursor_seq)
        self.assertIsNone(cursor_symbol)

    def test_simulation_mode_baseline_cursor_reuses_simulated_window_start(
        self,
    ) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        original_enabled = settings.trading_simulation_enabled
        try:
            settings.trading_simulation_enabled = True
            ingestor = ClickHouseSignalIngestor(schema="envelope", url="http://example")
            with (
                session_local() as session,
                patch(
                    "app.trading.ingest.clickhouse_signal_ingestor_persistence_methods.trading_now",
                    return_value=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                ) as mocked_trading_now,
            ):
                session.add(
                    TradeCursor(
                        source="clickhouse",
                        cursor_at=datetime(1970, 1, 1, tzinfo=timezone.utc),
                        cursor_seq=None,
                    )
                )
                session.commit()
                cursor_at, cursor_seq, cursor_symbol = ingestor._get_cursor(session)
        finally:
            settings.trading_simulation_enabled = original_enabled

        mocked_trading_now.assert_called_once_with(account_label=ingestor.account_label)
        self.assertEqual(cursor_at, datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc))
        self.assertIsNone(cursor_seq)
        self.assertIsNone(cursor_symbol)

    def test_simulation_mode_cursor_outside_window_resets_to_window_start(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        snapshot = {
            "enabled": settings.trading_simulation_enabled,
            "window_start": settings.trading_simulation_window_start,
            "window_end": settings.trading_simulation_window_end,
        }
        try:
            settings.trading_simulation_enabled = True
            settings.trading_simulation_window_start = "2026-03-06T14:30:00Z"
            settings.trading_simulation_window_end = "2026-03-06T14:45:00Z"
            ingestor = ClickHouseSignalIngestor(schema="envelope", url="http://example")
            with session_local() as session:
                session.add(
                    TradeCursor(
                        source="clickhouse",
                        account_label=ingestor.account_label,
                        cursor_at=datetime(2026, 3, 6, 20, 22, tzinfo=timezone.utc),
                        cursor_seq=11,
                        cursor_symbol="NVDA",
                    )
                )
                session.commit()
                cursor_at, cursor_seq, cursor_symbol = ingestor._get_cursor(session)
        finally:
            settings.trading_simulation_enabled = snapshot["enabled"]
            settings.trading_simulation_window_start = snapshot["window_start"]
            settings.trading_simulation_window_end = snapshot["window_end"]

        self.assertEqual(cursor_at, datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc))
        self.assertIsNone(cursor_seq)
        self.assertIsNone(cursor_symbol)

    def test_simulation_mode_fetch_uses_simulated_now_for_cursor_tail_lag(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        latest_signal = datetime(2026, 3, 6, 15, 30, 0, tzinfo=timezone.utc)

        class CursorIngestor(ClickHouseSignalIngestor):
            def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
                if "latest_signal_ts" in query:
                    return [{"latest_signal_ts": latest_signal.isoformat()}]
                return []

        original_enabled = settings.trading_simulation_enabled
        try:
            settings.trading_simulation_enabled = True
            ingestor = CursorIngestor(
                schema="envelope", url="http://example", fast_forward_stale_cursor=False
            )
            with (
                session_local() as session,
                patch(
                    "app.trading.ingest.clickhouse_signal_ingestor_core_methods.trading_now",
                    return_value=latest_signal,
                ) as mocked_trading_now,
                patch(
                    "app.trading.ingest.clickhouse_signal_ingestor_persistence_methods.trading_now",
                    return_value=latest_signal,
                ),
            ):
                session.add(
                    TradeCursor(
                        source="clickhouse", cursor_at=latest_signal, cursor_seq=None
                    )
                )
                session.commit()

                batch = ingestor.fetch_signals(session)
        finally:
            settings.trading_simulation_enabled = original_enabled

        mocked_trading_now.assert_called_once_with(account_label=ingestor.account_label)
        self.assertEqual(batch.signals, [])
        self.assertEqual(batch.no_signal_reason, "cursor_tail_stable")
        self.assertEqual(batch.cursor_at, latest_signal)
        self.assertEqual(batch.query_end, latest_signal)
        self.assertEqual(batch.signal_lag_seconds, 0.0)

    def test_simulation_mode_fetch_uses_bounded_cursor_ordered_query(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        latest_signal = datetime(2026, 3, 6, 15, 30, 0, tzinfo=timezone.utc)

        original_enabled = settings.trading_simulation_enabled
        try:
            settings.trading_simulation_enabled = True
            ingestor = SimulationWindowIngestor(
                schema="envelope",
                url="http://example",
                latest_signal_ts=latest_signal,
                fast_forward_stale_cursor=False,
            )
            with (
                session_local() as session,
                patch(
                    "app.trading.ingest.clickhouse_signal_ingestor_core_methods.trading_now",
                    return_value=datetime(2026, 3, 6, 14, 30, 0, tzinfo=timezone.utc),
                ),
                patch(
                    "app.trading.ingest.clickhouse_signal_ingestor_persistence_methods.trading_now",
                    return_value=datetime(2026, 3, 6, 14, 30, 0, tzinfo=timezone.utc),
                ),
            ):
                batch = ingestor.fetch_signals(session)
        finally:
            settings.trading_simulation_enabled = original_enabled

        self.assertEqual(batch.signals, [])
        self.assertEqual(batch.no_signal_reason, "empty_batch_advanced")
        self.assertEqual(
            batch.cursor_at, datetime(2026, 3, 6, 14, 30, 10, tzinfo=timezone.utc)
        )
        self.assertGreaterEqual(len(ingestor.queries), 2)
        replay_query = ingestor.queries[-1]
        self.assertIn("WHERE event_ts >= toDateTime64", replay_query)
        self.assertIn("AND event_ts <= toDateTime64", replay_query)
        self.assertIn("ORDER BY event_ts ASC, symbol ASC, seq ASC", replay_query)
        self.assertIn("LIMIT 500", replay_query)

    def test_simulation_mode_fetch_filters_cursor_boundary_rows_before_advancing(
        self,
    ) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        latest_signal = datetime(2026, 3, 6, 15, 30, 0, tzinfo=timezone.utc)
        row = {
            "event_ts": "2026-03-06T14:30:00Z",
            "ingest_ts": "2026-03-06T14:30:01Z",
            "symbol": "AAPL",
            "payload": {
                "price": 100,
                "macd": {"macd": 1.0, "signal": 0.5},
                "rsi14": 30,
            },
            "window_size": "PT1S",
            "window_step": "PT1S",
            "seq": 7,
            "source": "ta",
        }

        original_enabled = settings.trading_simulation_enabled
        try:
            settings.trading_simulation_enabled = True
            ingestor = SimulationWindowIngestor(
                schema="envelope",
                url="http://example",
                latest_signal_ts=latest_signal,
                rows=[row],
                fast_forward_stale_cursor=False,
            )
            with (
                session_local() as session,
                patch(
                    "app.trading.ingest.clickhouse_signal_ingestor_core_methods.trading_now",
                    return_value=latest_signal,
                ),
                patch(
                    "app.trading.ingest.clickhouse_signal_ingestor_persistence_methods.trading_now",
                    return_value=latest_signal,
                ),
            ):
                session.add(
                    TradeCursor(
                        source="clickhouse",
                        account_label=ingestor.account_label,
                        cursor_at=datetime(2026, 3, 6, 14, 30, 0, tzinfo=timezone.utc),
                        cursor_seq=7,
                        cursor_symbol="AAPL",
                    )
                )
                session.commit()
                batch = ingestor.fetch_signals(session)
        finally:
            settings.trading_simulation_enabled = original_enabled

        self.assertEqual(batch.signals, [])
        self.assertEqual(batch.no_signal_reason, "empty_batch_advanced")
        self.assertEqual(
            batch.cursor_at, datetime(2026, 3, 6, 14, 30, 10, tzinfo=timezone.utc)
        )

    def test_simulation_mode_fetch_queries_bounded_window_when_latest_probe_fails(
        self,
    ) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        row = {
            "event_ts": "2026-03-06T14:30:01Z",
            "ingest_ts": "2026-03-06T14:30:02Z",
            "symbol": "AAPL",
            "payload": {
                "price": 100,
                "macd": {"macd": 1.0, "signal": 0.5},
                "rsi14": 30,
            },
            "window_size": "PT1S",
            "window_step": "PT1S",
            "seq": 8,
            "source": "ta",
        }

        original_enabled = settings.trading_simulation_enabled
        try:
            settings.trading_simulation_enabled = True
            ingestor = SimulationWindowNoLatestIngestor(
                schema="envelope",
                url="http://example",
                rows=[row],
                fast_forward_stale_cursor=False,
            )
            with (
                session_local() as session,
                patch(
                    "app.trading.ingest.clickhouse_signal_ingestor_core_methods.trading_now",
                    return_value=datetime(2026, 3, 6, 14, 30, 0, tzinfo=timezone.utc),
                ),
                patch(
                    "app.trading.ingest.clickhouse_signal_ingestor_persistence_methods.trading_now",
                    return_value=datetime(2026, 3, 6, 14, 30, 0, tzinfo=timezone.utc),
                ),
            ):
                batch = ingestor.fetch_signals(session)
        finally:
            settings.trading_simulation_enabled = original_enabled

        self.assertEqual(batch.no_signal_reason, None)
        self.assertEqual(len(batch.signals), 1)
        self.assertEqual(
            batch.query_start, datetime(2026, 3, 6, 14, 30, 0, tzinfo=timezone.utc)
        )
        self.assertEqual(
            batch.query_end, datetime(2026, 3, 6, 14, 30, 10, tzinfo=timezone.utc)
        )
        replay_query = ingestor.queries[-1]
        self.assertIn("WHERE event_ts >=", replay_query)
        self.assertIn("AND event_ts <=", replay_query)

    def test_simulation_mode_empty_poll_without_in_window_signals_holds_cursor(
        self,
    ) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        snapshot = {
            "enabled": settings.trading_simulation_enabled,
            "window_start": settings.trading_simulation_window_start,
            "window_end": settings.trading_simulation_window_end,
        }
        try:
            settings.trading_simulation_enabled = True
            settings.trading_simulation_window_start = "2026-03-06T14:30:00Z"
            settings.trading_simulation_window_end = "2026-03-06T14:45:00Z"
            ingestor = SimulationWindowNoLatestIngestor(
                schema="envelope",
                url="http://example",
                rows=[],
                fast_forward_stale_cursor=False,
            )
            with (
                session_local() as session,
                patch(
                    "app.trading.ingest.clickhouse_signal_ingestor_core_methods.trading_now",
                    return_value=datetime(2026, 3, 6, 14, 30, 0, tzinfo=timezone.utc),
                ),
                patch(
                    "app.trading.ingest.clickhouse_signal_ingestor_persistence_methods.trading_now",
                    return_value=datetime(2026, 3, 6, 14, 30, 0, tzinfo=timezone.utc),
                ),
            ):
                batch = ingestor.fetch_signals(session)
        finally:
            settings.trading_simulation_enabled = snapshot["enabled"]
            settings.trading_simulation_window_start = snapshot["window_start"]
            settings.trading_simulation_window_end = snapshot["window_end"]

        self.assertEqual(batch.signals, [])
        self.assertEqual(batch.no_signal_reason, "no_signals_in_window")
        self.assertEqual(
            batch.cursor_at, datetime(2026, 3, 6, 14, 30, 0, tzinfo=timezone.utc)
        )
        self.assertEqual(
            batch.query_end, datetime(2026, 3, 6, 14, 30, 10, tzinfo=timezone.utc)
        )
        latest_query = next(
            query for query in ingestor.queries if "latest_signal_ts" in query
        )
        self.assertIn("WHERE event_ts >=", latest_query)
        self.assertIn("AND event_ts <=", latest_query)

    def test_build_query_flat_schema(self) -> None:
        ingestor = ClickHouseSignalIngestor(
            schema="flat", table="torghut.ta_signals", fast_forward_stale_cursor=False
        )
        query = ingestor._build_query(
            datetime(2026, 1, 1, tzinfo=timezone.utc), None, None
        )
        self.assertIn(
            "SELECT event_ts, ts, symbol, macd, macd_signal, macd_hist, signal, rsi, rsi14, ema, ema12, ema26",
            query,
        )
        self.assertIn("signal_json, timeframe, price, close, spread", query)
        self.assertIn("ema12, ema26", query)
        self.assertIn("vol_realized_w60s", query)
        self.assertIn("microstructure_signal_v1", query)
        self.assertIn("FROM torghut.ta_signals", query)
        self.assertIn("WHERE event_ts > toDateTime64", query)
        self.assertNotIn("payload", query)
        self.assertIn("ORDER BY event_ts ASC", query)

    def test_build_query_envelope_schema(self) -> None:
        ingestor = ClickHouseSignalIngestor(
            schema="envelope",
            table="torghut.ta_signals",
            fast_forward_stale_cursor=False,
        )
        query = ingestor._build_query(
            datetime(2026, 1, 1, tzinfo=timezone.utc), None, None
        )
        self.assertIn(
            "SELECT event_ts, ingest_ts, symbol, payload, window_size, window_step, seq, source",
            query,
        )
        self.assertIn("FROM torghut.ta_signals", query)
        self.assertIn("WHERE event_ts > toDateTime64", query)
        self.assertIn("ORDER BY event_ts ASC, symbol ASC, seq ASC", query)
        self.assertNotIn("signal_json", query)

    def test_build_query_joins_microbar_volume_from_price_table(self) -> None:
        with (
            patch.object(settings, "trading_price_table", "torghut.ta_microbars"),
            patch.object(settings, "trading_signal_allowed_sources_raw", "ta"),
        ):
            ingestor = SchemaDiscoveringIngestor(
                schema="envelope",
                table="torghut.ta_signals",
                url="http://example",
                fast_forward_stale_cursor=False,
                columns={
                    "event_ts",
                    "symbol",
                    "window_size",
                    "seq",
                    "source",
                    "payload",
                },
            )
            query = ingestor._build_query(
                datetime(2026, 1, 1, tzinfo=timezone.utc), None, None
            )

        self.assertIn("ANY LEFT JOIN torghut.ta_microbars AS m", query)
        self.assertIn("if(m.symbol = '', NULL, m.v) AS microbar_volume", query)
        self.assertIn("s.source = m.source", query)
        self.assertIn("s.window_size = m.window_size", query)
        self.assertIn("lower(source) IN ('ta')", query)

    def test_build_replay_query_filters_allowed_sources(self) -> None:
        with (
            patch.object(settings, "trading_price_table", ""),
            patch.object(settings, "trading_signal_allowed_sources_raw", "ta"),
        ):
            ingestor = ClickHouseSignalIngestor(
                schema="envelope",
                table="torghut.ta_signals",
                fast_forward_stale_cursor=False,
            )
            query = ingestor._build_replay_query(
                start=datetime(2026, 1, 1, tzinfo=timezone.utc),
                end=datetime(2026, 1, 1, 0, 1, tzinfo=timezone.utc),
                normalized_symbol=None,
                limit=None,
                time_column="event_ts",
            )

        self.assertIn("lower(source) IN ('ta')", query)

    def test_build_simulation_query_filters_allowed_sources(self) -> None:
        with (
            patch.object(settings, "trading_price_table", ""),
            patch.object(settings, "trading_signal_allowed_sources_raw", "ta"),
        ):
            ingestor = ClickHouseSignalIngestor(
                schema="envelope",
                table="torghut.ta_signals",
                fast_forward_stale_cursor=False,
            )
            query = ingestor._build_simulation_query(
                start=datetime(2026, 1, 1, tzinfo=timezone.utc),
                end=datetime(2026, 1, 1, 0, 1, tzinfo=timezone.utc),
                cursor_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                cursor_seq=None,
                cursor_symbol=None,
                time_column="event_ts",
            )

        self.assertIn("lower(source) IN ('ta')", query)

    def test_latest_signal_timestamp_query_filters_allowed_sources(self) -> None:
        with patch.object(settings, "trading_signal_allowed_sources_raw", "ta"):
            ingestor = ClickHouseSignalIngestor(
                schema="envelope",
                table="torghut.ta_signals",
                fast_forward_stale_cursor=False,
            )
            queries = ingestor._latest_signal_timestamp_queries("event_ts")

        self.assertTrue(any("lower(source) IN ('ta')" in query for query in queries))

    def test_source_filter_skips_when_source_column_missing(self) -> None:
        with patch.object(settings, "trading_signal_allowed_sources_raw", "ta"):
            ingestor = SchemaDiscoveringIngestor(
                schema="auto",
                table="torghut.ta_signals",
                url="http://example",
                fast_forward_stale_cursor=False,
                columns={"event_ts", "symbol", "payload"},
            )
            clause = ingestor._source_where_clause()

        self.assertIsNone(clause)

    def test_microbar_join_skips_invalid_price_table(self) -> None:
        with patch.object(settings, "trading_price_table", "torghut..ta_microbars"):
            ingestor = ClickHouseSignalIngestor(
                schema="envelope",
                table="torghut.ta_signals",
                fast_forward_stale_cursor=False,
            )
            with self.assertLogs("app.trading.ingest", level="WARNING") as logs:
                should_join = ingestor._should_join_microbar_volume(
                    ["event_ts", "symbol", "payload"]
                )

        self.assertFalse(should_join)
        self.assertTrue(
            any("Invalid ClickHouse price table" in item for item in logs.output)
        )

    def test_build_query_envelope_schema_with_cursor_seq(self) -> None:
        ingestor = ClickHouseSignalIngestor(
            schema="envelope",
            table="torghut.ta_signals",
            fast_forward_stale_cursor=False,
        )
        query = ingestor._build_query(
            datetime(2026, 1, 1, tzinfo=timezone.utc), 42, None
        )
        self.assertIn("event_ts = toDateTime64", query)
        self.assertIn("seq > 42", query)
        self.assertIn("ORDER BY event_ts ASC, symbol ASC, seq ASC", query)

    def test_build_query_flat_schema_overlaps_window(self) -> None:
        ingestor = ClickHouseSignalIngestor(
            schema="flat", table="torghut.ta_signals", fast_forward_stale_cursor=False
        )
        query = ingestor._build_query(
            datetime(2026, 1, 1, 0, 0, 5, tzinfo=timezone.utc), None, None
        )
        self.assertIn("WHERE event_ts > toDateTime64", query)
        self.assertIn("2026-01-01 00:00:05.000", query)

    def test_resolve_flat_time_column_prefers_event_ts(self) -> None:
        ingestor = SchemaDiscoveringIngestor(
            schema="flat",
            table="torghut.ta_signals",
            url="http://example",
            fast_forward_stale_cursor=False,
            columns={"ts", "event_ts", "symbol"},
        )
        query = ingestor._build_query(
            datetime(2026, 1, 1, tzinfo=timezone.utc), None, None
        )
        self.assertIn("WHERE event_ts > toDateTime64", query)
        self.assertIn("ORDER BY event_ts ASC", query)
        self.assertNotIn("WHERE ts >= toDateTime64", query)

    def test_resolve_flat_time_column_falls_back_to_ts(self) -> None:
        ingestor = SchemaDiscoveringIngestor(
            schema="flat",
            table="torghut.ta_signals",
            url="http://example",
            fast_forward_stale_cursor=False,
            columns={"ts", "symbol"},
        )
        query = ingestor._build_query(
            datetime(2026, 1, 1, tzinfo=timezone.utc), None, None
        )
        self.assertIn("WHERE ts >= toDateTime64", query)
        self.assertIn("ORDER BY ts ASC, symbol ASC", query)
        self.assertNotIn("WHERE event_ts >", query)

    def test_fetch_signals_between_respects_schema(self) -> None:
        ingestor = CapturingIngestor(
            schema="flat", table="torghut.ta_signals", url="http://example"
        )
        ingestor.fetch_signals_between(
            start=datetime(2026, 1, 1, tzinfo=timezone.utc),
            end=datetime(2026, 1, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL",
        )
        assert ingestor.last_query is not None
        self.assertIn(
            "SELECT event_ts, ts, symbol, macd, macd_signal, macd_hist, signal, rsi, rsi14, ema, ema12, ema26",
            ingestor.last_query,
        )
        self.assertIn(
            "signal_json, timeframe, price, close, spread", ingestor.last_query
        )
        self.assertIn("ema12, ema26", ingestor.last_query)
        self.assertIn("vol_realized_w60s", ingestor.last_query)
        self.assertIn("microstructure_signal_v1", ingestor.last_query)
        self.assertIn("WHERE event_ts >= toDateTime64", ingestor.last_query)
        self.assertIn("AND event_ts <= toDateTime64", ingestor.last_query)

        envelope_ingestor = CapturingIngestor(
            schema="envelope", table="torghut.ta_signals", url="http://example"
        )
        envelope_ingestor.fetch_signals_between(
            start=datetime(2026, 1, 1, tzinfo=timezone.utc),
            end=datetime(2026, 1, 1, 1, tzinfo=timezone.utc),
            symbol="AAPL",
        )
        assert envelope_ingestor.last_query is not None
        self.assertIn(
            "SELECT event_ts, ingest_ts, symbol, payload, window_size, window_step, seq, source",
            envelope_ingestor.last_query,
        )
        self.assertIn("WHERE event_ts >= toDateTime64", envelope_ingestor.last_query)
        self.assertIn("AND event_ts <= toDateTime64", envelope_ingestor.last_query)
        self.assertIn("ORDER BY event_ts ASC, seq ASC", envelope_ingestor.last_query)
