from __future__ import annotations

from tests.order_feed.support import (
    ORDER_FEED_SOURCE_REVISION,
    Decimal,
    ExecutionOrderEvent,
    FakeConsumer,
    FakeRecord,
    NormalizedOrderEvent,
    OrderFeedConsumerCursor,
    OrderFeedIngestor,
    OrderFeedSourceWindow,
    OrderFeedTestCase,
    Session,
    SimpleNamespace,
    datetime,
    normalize_order_feed_record,
    order_feed_module,
    patch,
    persist_order_event,
    repair_order_feed_fill_deltas,
    select,
    settings,
    timedelta,
    timezone,
    uuid,
)


class TestOrderFeedCursorAndRetries(OrderFeedTestCase):
    def test_redelivered_failed_apply_duplicate_retries_before_cursor_advance(
        self,
    ) -> None:
        record = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
                b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            offset=21,
        )

        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            first_consumer = FakeConsumer([record])
            first_ingestor = OrderFeedIngestor(consumer_factory=lambda: first_consumer)
            with patch(
                (
                    "app.trading.order_feed.shared_context"
                    ".apply_order_event_to_execution"
                ),
                side_effect=RuntimeError("apply failed"),
            ):
                first_counters = first_ingestor.ingest_once(session)
            failed_source_window = session.execute(
                select(OrderFeedSourceWindow)
            ).scalar_one()
            session.refresh(execution)

            second_consumer = FakeConsumer([record])
            second_ingestor = OrderFeedIngestor(
                consumer_factory=lambda: second_consumer
            )
            second_counters = second_ingestor.ingest_once(session)
            session.refresh(execution)
            cursor = session.execute(select(OrderFeedConsumerCursor)).scalar_one()
            source_windows = (
                session.execute(select(OrderFeedSourceWindow)).scalars().all()
            )
            duplicate_window = session.execute(
                select(OrderFeedSourceWindow).where(
                    OrderFeedSourceWindow.status == "duplicate"
                )
            ).scalar_one()

        self.assertEqual(first_counters["failed_unhandled_total"], 1)
        self.assertEqual(first_counters["cursor_updates_total"], 0)
        self.assertEqual(first_consumer.commit_calls, 0)
        self.assertEqual(failed_source_window.status, "failed_unhandled")
        self.assertEqual(execution.status, "filled")
        self.assertEqual(execution.filled_qty, Decimal("1.00000000"))
        self.assertEqual(execution.avg_fill_price, Decimal("190.20000000"))
        self.assertEqual(second_counters["duplicates_total"], 1)
        self.assertEqual(second_counters["apply_updates_total"], 1)
        self.assertEqual(second_counters["cursor_updates_total"], 1)
        self.assertEqual(second_consumer.commit_calls, 1)
        self.assertEqual(cursor.high_watermark_offset, 21)
        self.assertEqual(
            {window.status for window in source_windows},
            {"failed_unhandled", "duplicate"},
        )
        self.assertEqual(
            duplicate_window.status_reason,
            "duplicate_after_failed_unhandled_reprocessed",
        )
        self.assertEqual(
            duplicate_window.payload_json[
                "reprocessed_failed_unhandled_source_window_id"
            ],
            str(failed_source_window.id),
        )

    def test_failed_duplicate_source_window_helper_handles_unlinked_event(
        self,
    ) -> None:
        event = ExecutionOrderEvent(
            event_fingerprint="no-window",
            source_topic="torghut.trade-updates.v1",
            source_partition=0,
            source_offset=1,
            alpaca_account_label="paper",
            raw_event={},
        )

        with Session(self.engine) as session:
            has_failed_source_window = (
                order_feed_module._order_event_has_failed_unhandled_source_window(
                    session,
                    event,
                )
            )

        self.assertFalse(has_failed_source_window)

    def test_retry_failed_duplicate_requires_execution_link(self) -> None:
        event = ExecutionOrderEvent(
            event_fingerprint="failed-without-execution-link",
            source_topic="torghut.trade-updates.v1",
            source_partition=0,
            source_offset=1,
            alpaca_account_label="paper",
            raw_event={},
        )

        with Session(self.engine) as session:
            with self.assertRaisesRegex(
                RuntimeError,
                "failed_unhandled_order_event_missing_execution_link",
            ):
                order_feed_module._retry_failed_duplicate_order_event_application(
                    session=session,
                    event=event,
                    counters={"out_of_order_total": 0, "apply_updates_total": 0},
                    source_window=None,
                )

    def test_retry_failed_duplicate_requires_existing_execution(self) -> None:
        event = ExecutionOrderEvent(
            event_fingerprint="failed-missing-execution",
            source_topic="torghut.trade-updates.v1",
            source_partition=0,
            source_offset=1,
            alpaca_account_label="paper",
            raw_event={},
            execution_id=uuid.uuid4(),
        )

        with Session(self.engine) as session:
            with self.assertRaisesRegex(
                RuntimeError,
                "failed_unhandled_order_event_execution_not_found",
            ):
                order_feed_module._retry_failed_duplicate_order_event_application(
                    session=session,
                    event=event,
                    counters={"out_of_order_total": 0, "apply_updates_total": 0},
                    source_window=None,
                )

    def test_retry_failed_duplicate_records_out_of_order_retry_lineage(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            execution.order_feed_last_seq = 99
            failed_source_window = OrderFeedSourceWindow(
                consumer_group="torghut-order-feed-v1",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                alpaca_account_label="paper",
                assignment_mode="group",
                source_revision=ORDER_FEED_SOURCE_REVISION,
                window_started_at=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                window_ended_at=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                start_offset=30,
                end_offset=30,
                consumed_count=1,
                status="failed_unhandled",
            )
            retry_source_window = OrderFeedSourceWindow(
                consumer_group="torghut-order-feed-v1",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                alpaca_account_label="paper",
                assignment_mode="group",
                source_revision=ORDER_FEED_SOURCE_REVISION,
                window_started_at=datetime(2026, 2, 1, 10, 1, tzinfo=timezone.utc),
                window_ended_at=datetime(2026, 2, 1, 10, 1, tzinfo=timezone.utc),
                start_offset=30,
                end_offset=30,
                consumed_count=1,
                status="duplicate",
            )
            session.add_all([execution, failed_source_window, retry_source_window])
            session.flush()
            event = ExecutionOrderEvent(
                event_fingerprint="failed-out-of-order-retry",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=30,
                alpaca_account_label="paper",
                feed_seq=10,
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id="order-1",
                client_order_id="client-1",
                event_type="fill",
                status="filled",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.2"),
                raw_event={},
                execution_id=execution.id,
                trade_decision_id=execution.trade_decision_id,
                source_window_id=failed_source_window.id,
            )
            counters = {"out_of_order_total": 0, "apply_updates_total": 0}

            order_feed_module._retry_failed_duplicate_order_event_application(
                session=session,
                event=event,
                counters=counters,
                source_window=retry_source_window,
            )

        self.assertEqual(counters["out_of_order_total"], 1)
        self.assertEqual(counters["apply_updates_total"], 0)
        self.assertEqual(
            retry_source_window.status_reason,
            "duplicate_after_failed_unhandled_reprocessed",
        )
        self.assertEqual(
            retry_source_window.payload_json[
                "reprocessed_failed_unhandled_source_window_id"
            ],
            str(failed_source_window.id),
        )

    def test_unhandled_failure_stops_batch_before_later_offsets(self) -> None:
        failed = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
                b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            offset=22,
        )
        later = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:05Z",'
                b'"order":{"id":"order-2","client_order_id":"client-2","symbol":"MSFT","status":"filled",'
                b'"qty":"1","filled_qty":"1","filled_avg_price":"405.0"}},"seq":11}'
            ),
            offset=23,
        )
        consumer = FakeConsumer([failed, later])
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            with patch(
                ("app.trading.order_feed.shared_context.persist_order_event"),
                side_effect=RuntimeError("store failed"),
            ):
                counters = ingestor.ingest_once(session)
            source_windows = (
                session.execute(
                    select(OrderFeedSourceWindow).order_by(
                        OrderFeedSourceWindow.start_offset
                    )
                )
                .scalars()
                .all()
            )

        self.assertEqual(counters["messages_total"], 1)
        self.assertEqual(counters["failed_unhandled_total"], 1)
        self.assertEqual(consumer.commit_calls, 0)
        self.assertEqual(len(source_windows), 1)
        self.assertEqual(source_windows[0].start_offset, 22)
        self.assertEqual(source_windows[0].status, "failed_unhandled")

    def test_unlinked_event_source_window_records_missing_lineage(self) -> None:
        record = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"unlinked-order","client_order_id":"unlinked-client","symbol":"AAPL","status":"filled",'
                b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            offset=19,
        )
        consumer = FakeConsumer([record])
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            counters = ingestor.ingest_once(session)
            event = session.execute(select(ExecutionOrderEvent)).scalar_one()
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()

        self.assertEqual(counters["events_persisted_total"], 1)
        self.assertEqual(counters["unlinked_execution_total"], 1)
        self.assertEqual(counters["unlinked_decision_total"], 1)
        self.assertEqual(event.source_window_id, source_window.id)
        self.assertEqual(source_window.status, "inserted")
        self.assertEqual(
            source_window.status_reason, "missing_execution_and_decision_links"
        )
        self.assertEqual(source_window.inserted_count, 1)
        self.assertEqual(source_window.unlinked_execution_count, 1)
        self.assertEqual(source_window.unlinked_decision_count, 1)
        self.assertEqual(
            source_window.classification_counts,
            {
                "inserted": 1,
                "unlinked_execution": 1,
                "unlinked_decision": 1,
            },
        )
        self.assertEqual(
            source_window.payload_json["classification_counts"],
            source_window.classification_counts,
        )
        self.assertEqual(
            source_window.payload_json["linked_refs"],
            {
                "execution_order_event_id": str(event.id),
                "execution_id": None,
                "trade_decision_id": None,
            },
        )
        self.assertFalse(source_window.payload_json["source_coverage_complete"])
        self.assertEqual(
            source_window.payload_json["authority_class"],
            "order_feed_lifecycle_unlinked",
        )

    def test_cursor_consumer_group_falls_back_to_client_id(self) -> None:
        settings.trading_order_feed_group_id = " "
        settings.trading_order_feed_client_id = "paper-route-client"
        record = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
                b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            offset=7,
        )
        consumer = FakeConsumer([record])
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            self._seed_execution(session)
            counters = ingestor.ingest_once(session)
            cursor = session.execute(select(OrderFeedConsumerCursor)).scalar_one()

        self.assertEqual(counters["cursor_updates_total"], 1)
        self.assertEqual(cursor.consumer_group, "paper-route-client")

    def test_valid_event_without_source_position_skips_cursor_update(self) -> None:
        record = SimpleNamespace(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
                b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            topic="torghut.trade-updates.v1",
        )
        consumer = FakeConsumer([record])
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            self._seed_execution(session)
            counters = ingestor.ingest_once(session)
            cursor_count = len(session.execute(select(OrderFeedConsumerCursor)).all())

        self.assertEqual(counters["events_persisted_total"], 1)
        self.assertEqual(counters["cursor_updates_total"], 0)
        self.assertEqual(cursor_count, 0)
        self.assertEqual(consumer.commit_calls, 1)

    def test_later_offset_with_gap_advances_cursor_gap_accounting(self) -> None:
        first = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"partial_fill",'
                b'"timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"partially_filled",'
                b'"qty":"2","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            offset=7,
        )
        later = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:05Z",'
                b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
                b'"qty":"2","filled_qty":"2","filled_avg_price":"190.4"}},"seq":11}'
            ),
            offset=10,
        )
        consumer = FakeConsumer([first, later])
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            self._seed_execution(session)
            counters = ingestor.ingest_once(session)
            cursor = session.execute(select(OrderFeedConsumerCursor)).scalar_one()
            events = (
                session.execute(
                    select(ExecutionOrderEvent).order_by(
                        ExecutionOrderEvent.source_offset.asc()
                    )
                )
                .scalars()
                .all()
            )
            source_windows = (
                session.execute(
                    select(OrderFeedSourceWindow).order_by(
                        OrderFeedSourceWindow.start_offset.asc()
                    )
                )
                .scalars()
                .all()
            )

        self.assertEqual(counters["events_persisted_total"], 2)
        self.assertEqual(counters["cursor_updates_total"], 2)
        self.assertEqual(cursor.high_watermark_offset, 10)
        self.assertEqual(cursor.processed_event_count, 2)
        self.assertEqual(cursor.offset_gap_count, 1)
        self.assertEqual(
            cursor.last_event_ts,
            datetime(2026, 2, 1, 10, 0, 5),
        )
        self.assertEqual(
            [event.filled_qty for event in events], [Decimal("1"), Decimal("2")]
        )
        self.assertEqual(
            [event.filled_qty_delta for event in events],
            [Decimal("1"), Decimal("1")],
        )
        self.assertEqual(
            [event.fill_quantity_basis for event in events],
            ["cumulative_to_delta", "cumulative_to_delta"],
        )
        self.assertEqual(
            [event.filled_notional_delta for event in events],
            [Decimal("190.20000000"), Decimal("190.40000000")],
        )
        self.assertEqual([window.start_offset for window in source_windows], [7, 10])
        self.assertEqual(source_windows[1].gap_count, 1)
        self.assertEqual(
            source_windows[1].gap_ranges,
            [{"start_offset": 8, "end_offset": 9}],
        )

    def test_fill_delta_fields_rejects_fill_without_order_identity(self) -> None:
        event = NormalizedOrderEvent(
            event_fingerprint="fill-no-order-id",
            source_topic="torghut.trade-updates.v1",
            source_partition=0,
            source_offset=12,
            alpaca_account_label="paper",
            feed_seq=12,
            event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
            symbol="AAPL",
            alpaca_order_id=None,
            client_order_id=None,
            execution_correlation_id=None,
            event_type="fill",
            status="filled",
            qty=Decimal("1"),
            filled_qty=Decimal("1"),
            filled_qty_delta=None,
            avg_fill_price=Decimal("190.2"),
            filled_notional_delta=None,
            fill_quantity_basis=None,
            raw_event={},
        )

        with Session(self.engine) as session:
            qty_delta, notional_delta, basis = order_feed_module._fill_delta_fields(
                session,
                event,
            )

        self.assertIsNone(qty_delta)
        self.assertIsNone(notional_delta)
        self.assertEqual(basis, "cumulative_non_increasing")

    def test_fill_delta_fields_rejects_non_increasing_cumulative_fill(self) -> None:
        first = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"partial_fill",'
                b'"timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"partially_filled",'
                b'"qty":"2","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            offset=7,
        )
        stale_repeat = NormalizedOrderEvent(
            event_fingerprint="fill-non-increasing",
            source_topic="torghut.trade-updates.v1",
            source_partition=0,
            source_offset=13,
            alpaca_account_label="paper",
            feed_seq=13,
            event_ts=datetime(2026, 2, 1, 10, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            alpaca_order_id="order-1",
            client_order_id="client-1",
            execution_correlation_id=None,
            event_type="fill",
            status="filled",
            qty=Decimal("2"),
            filled_qty=Decimal("1"),
            filled_qty_delta=None,
            avg_fill_price=Decimal("190.3"),
            filled_notional_delta=None,
            fill_quantity_basis=None,
            raw_event={},
        )

        with Session(self.engine) as session:
            self._seed_execution(session)
            normalized = normalize_order_feed_record(
                first,
                default_topic="torghut.trade-updates.v1",
                default_account_label="paper",
            )
            assert normalized.event is not None
            persist_order_event(session, normalized.event)

            qty_delta, notional_delta, basis = order_feed_module._fill_delta_fields(
                session,
                stale_repeat,
            )

        self.assertIsNone(qty_delta)
        self.assertIsNone(notional_delta)
        self.assertEqual(basis, "cumulative_non_increasing")

    def test_repair_order_feed_fill_deltas_converts_legacy_cumulative_fills(
        self,
    ) -> None:
        base_ts = datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc)

        with Session(self.engine) as session:
            self._seed_execution(session)
            session.add_all(
                [
                    ExecutionOrderEvent(
                        event_fingerprint="legacy-fill-1",
                        source_topic="torghut.trade-updates.v1",
                        source_partition=0,
                        source_offset=101,
                        alpaca_account_label="paper",
                        feed_seq=10,
                        event_ts=base_ts,
                        symbol="AAPL",
                        alpaca_order_id="order-1",
                        client_order_id="client-1",
                        event_type="partial_fill",
                        status="partially_filled",
                        qty=Decimal("2"),
                        filled_qty=Decimal("1"),
                        avg_fill_price=Decimal("190.20"),
                        raw_event={},
                    ),
                    ExecutionOrderEvent(
                        event_fingerprint="legacy-fill-2",
                        source_topic="torghut.trade-updates.v1",
                        source_partition=0,
                        source_offset=102,
                        alpaca_account_label="paper",
                        feed_seq=11,
                        event_ts=base_ts + timedelta(seconds=1),
                        symbol="AAPL",
                        alpaca_order_id="order-1",
                        client_order_id="client-1",
                        event_type="fill",
                        status="filled",
                        qty=Decimal("2"),
                        filled_qty=Decimal("2"),
                        avg_fill_price=Decimal("190.40"),
                        raw_event={},
                    ),
                    ExecutionOrderEvent(
                        event_fingerprint="legacy-fill-repeat",
                        source_topic="torghut.trade-updates.v1",
                        source_partition=0,
                        source_offset=103,
                        alpaca_account_label="paper",
                        feed_seq=12,
                        event_ts=base_ts + timedelta(seconds=2),
                        symbol="AAPL",
                        alpaca_order_id="order-1",
                        client_order_id="client-1",
                        event_type="fill",
                        status="filled",
                        qty=Decimal("2"),
                        filled_qty=Decimal("2"),
                        avg_fill_price=Decimal("190.50"),
                        raw_event={},
                    ),
                ]
            )
            session.commit()

            counters = repair_order_feed_fill_deltas(
                session,
                account_label="paper",
                limit=10,
            )
            session.commit()
            events = (
                session.execute(
                    select(ExecutionOrderEvent).order_by(
                        ExecutionOrderEvent.feed_seq.asc()
                    )
                )
                .scalars()
                .all()
            )

        self.assertEqual(counters["selected"], 3)
        self.assertEqual(counters["delta_events_repaired"], 2)
        self.assertEqual(counters["non_increasing_events_marked"], 1)
        self.assertEqual(counters["missing_identity_events_marked"], 0)
        self.assertEqual(
            [event.filled_qty_delta for event in events],
            [Decimal("1.00000000"), Decimal("1.00000000"), None],
        )
        self.assertEqual(
            [event.filled_notional_delta for event in events],
            [Decimal("190.20000000"), Decimal("190.40000000"), None],
        )
        self.assertEqual(
            [event.fill_quantity_basis for event in events],
            [
                "cumulative_to_delta",
                "cumulative_to_delta",
                "cumulative_non_increasing",
            ],
        )

    def test_repair_order_feed_fill_deltas_rejects_missing_order_identity(
        self,
    ) -> None:
        with Session(self.engine) as session:
            session.add(
                ExecutionOrderEvent(
                    event_fingerprint="legacy-fill-no-identity",
                    source_topic="torghut.trade-updates.v1",
                    source_partition=0,
                    source_offset=201,
                    alpaca_account_label="paper",
                    feed_seq=20,
                    event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                    symbol="AAPL",
                    event_type="fill",
                    status="filled",
                    qty=Decimal("1"),
                    filled_qty=Decimal("1"),
                    avg_fill_price=Decimal("190.20"),
                    raw_event={},
                )
            )
            session.commit()

            counters = repair_order_feed_fill_deltas(
                session,
                account_label="paper",
                limit=10,
            )
            session.commit()
            event = session.execute(select(ExecutionOrderEvent)).scalar_one()

        self.assertEqual(counters["selected"], 1)
        self.assertEqual(counters["delta_events_repaired"], 0)
        self.assertEqual(counters["missing_identity_events_marked"], 1)
        self.assertIsNone(event.filled_qty_delta)
        self.assertIsNone(event.filled_notional_delta)
        self.assertEqual(event.fill_quantity_basis, "cumulative_non_increasing")

    def test_repair_order_feed_fill_deltas_orders_by_source_offset_without_event_ts(
        self,
    ) -> None:
        with Session(self.engine) as session:
            session.add_all(
                [
                    ExecutionOrderEvent(
                        event_fingerprint="legacy-fill-offset-1",
                        source_topic="torghut.trade-updates.v1",
                        source_partition=0,
                        source_offset=301,
                        alpaca_account_label="paper",
                        symbol="AAPL",
                        alpaca_order_id="order-offset",
                        event_type="partial_fill",
                        status="partially_filled",
                        qty=Decimal("2"),
                        filled_qty=Decimal("1"),
                        avg_fill_price=Decimal("190"),
                        raw_event={},
                    ),
                    ExecutionOrderEvent(
                        event_fingerprint="legacy-fill-offset-2",
                        source_topic="torghut.trade-updates.v1",
                        source_partition=0,
                        source_offset=302,
                        alpaca_account_label="paper",
                        symbol="AAPL",
                        alpaca_order_id="order-offset",
                        event_type="fill",
                        status="filled",
                        qty=Decimal("2"),
                        filled_qty=Decimal("2"),
                        avg_fill_price=Decimal("191"),
                        raw_event={},
                    ),
                ]
            )
            session.commit()

            counters = repair_order_feed_fill_deltas(
                session,
                account_label="paper",
                limit=10,
            )
            session.commit()
            events = (
                session.execute(
                    select(ExecutionOrderEvent).order_by(
                        ExecutionOrderEvent.source_offset.asc()
                    )
                )
                .scalars()
                .all()
            )

        self.assertEqual(counters["selected"], 2)
        self.assertEqual(counters["delta_events_repaired"], 2)
        self.assertEqual(
            [event.filled_qty_delta for event in events],
            [Decimal("1.00000000"), Decimal("1.00000000")],
        )
        self.assertEqual(
            [event.filled_notional_delta for event in events],
            [Decimal("190.00000000"), Decimal("191.00000000")],
        )
