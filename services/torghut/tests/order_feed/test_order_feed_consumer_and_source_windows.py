from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.order_feed.support import (
    Decimal,
    ExecutionOrderEvent,
    FakeConsumer,
    FakeManualConsumer,
    HISTORICAL_ORDER_EVENT_SOURCE_WINDOW_REVISION,
    ORDER_FEED_SOURCE_REVISION,
    OrderFeedConsumerCursor,
    OrderFeedIngestor,
    OrderFeedSourceWindow,
    OrderFeedTestCase,
    Session,
    SimpleNamespace,
    TopicPartition,
    backfill_order_feed_source_windows,
    datetime,
    link_order_events_to_execution,
    patch,
    select,
    settings,
    timezone,
)


class TestOrderFeedConsumerAndSourceWindows(OrderFeedTestCase):
    def test_build_consumer_applies_kafka_security_kwargs(self) -> None:
        captured_kwargs: dict[str, object] = {}
        original_security_protocol = settings.trading_order_feed_security_protocol
        original_sasl_mechanism = settings.trading_order_feed_sasl_mechanism
        original_sasl_username = settings.trading_order_feed_sasl_username
        original_sasl_password = settings.trading_order_feed_sasl_password
        try:
            settings.trading_order_feed_security_protocol = "SASL_PLAINTEXT"
            settings.trading_order_feed_sasl_mechanism = "SCRAM-SHA-512"
            settings.trading_order_feed_sasl_username = "user"
            settings.trading_order_feed_sasl_password = "secret"

            class _FakeKafkaConsumer:
                def __init__(self, *topics: str, **kwargs: object) -> None:
                    captured_kwargs["topics"] = list(topics)
                    captured_kwargs.update(kwargs)

            with patch.dict(
                "sys.modules",
                {"kafka": SimpleNamespace(KafkaConsumer=_FakeKafkaConsumer)},
            ):
                OrderFeedIngestor._build_consumer()
        finally:
            settings.trading_order_feed_security_protocol = original_security_protocol
            settings.trading_order_feed_sasl_mechanism = original_sasl_mechanism
            settings.trading_order_feed_sasl_username = original_sasl_username
            settings.trading_order_feed_sasl_password = original_sasl_password

        self.assertEqual(captured_kwargs.get("security_protocol"), "SASL_PLAINTEXT")
        self.assertEqual(captured_kwargs.get("sasl_mechanism"), "SCRAM-SHA-512")
        self.assertEqual(captured_kwargs.get("sasl_plain_username"), "user")
        self.assertEqual(captured_kwargs.get("sasl_plain_password"), "secret")

    def test_build_consumer_group_mode_falls_back_to_client_id_group(self) -> None:
        captured_kwargs: dict[str, object] = {}
        original_group_id = settings.trading_order_feed_group_id
        original_client_id = settings.trading_order_feed_client_id
        original_assignment_mode = settings.trading_order_feed_assignment_mode
        try:
            settings.trading_order_feed_assignment_mode = "group"
            settings.trading_order_feed_group_id = " "
            settings.trading_order_feed_client_id = "paper-route-client"

            class _FakeKafkaConsumer:
                def __init__(self, *topics: str, **kwargs: object) -> None:
                    captured_kwargs["topics"] = list(topics)
                    captured_kwargs.update(kwargs)

            with patch.dict(
                "sys.modules",
                {"kafka": SimpleNamespace(KafkaConsumer=_FakeKafkaConsumer)},
            ):
                OrderFeedIngestor._build_consumer()
        finally:
            settings.trading_order_feed_group_id = original_group_id
            settings.trading_order_feed_client_id = original_client_id
            settings.trading_order_feed_assignment_mode = original_assignment_mode

        self.assertEqual(captured_kwargs.get("topics"), ["torghut.trade-updates.v1"])
        self.assertEqual(captured_kwargs.get("group_id"), "paper-route-client")

    def test_build_consumer_disables_group_subscription_for_manual_assignment(
        self,
    ) -> None:
        captured_kwargs: dict[str, object] = {}
        original_assignment_mode = settings.trading_order_feed_assignment_mode
        original_group_id = settings.trading_order_feed_group_id
        try:
            settings.trading_order_feed_assignment_mode = "manual"
            settings.trading_order_feed_group_id = "torghut-order-feed-sim-default"

            class _FakeKafkaConsumer:
                def __init__(self, *topics: str, **kwargs: object) -> None:
                    captured_kwargs["topics"] = list(topics)
                    captured_kwargs.update(kwargs)

            with patch.dict(
                "sys.modules",
                {"kafka": SimpleNamespace(KafkaConsumer=_FakeKafkaConsumer)},
            ):
                OrderFeedIngestor._build_consumer()
        finally:
            settings.trading_order_feed_assignment_mode = original_assignment_mode
            settings.trading_order_feed_group_id = original_group_id

        self.assertEqual(captured_kwargs.get("topics"), [])
        self.assertIsNone(captured_kwargs.get("group_id"))

    def test_ingest_counts_consumer_factory_failure(self) -> None:
        def fail_consumer() -> FakeConsumer:
            raise RuntimeError("boom")

        ingestor = OrderFeedIngestor(consumer_factory=fail_consumer)
        with Session(self.engine) as session:
            counters = ingestor.ingest_once(session)

        self.assertEqual(counters["consumer_errors_total"], 1)

    def test_ingest_skips_when_bootstrap_servers_missing(self) -> None:
        settings.trading_order_feed_bootstrap_servers = ""
        ingestor = OrderFeedIngestor(consumer_factory=lambda: FakeConsumer([]))

        with Session(self.engine) as session:
            counters = ingestor.ingest_once(session)

        self.assertEqual(counters["messages_total"], 0)
        self.assertEqual(counters["consumer_errors_total"], 0)

    def test_close_resets_cached_manual_consumer(self) -> None:
        consumer = FakeManualConsumer(
            [],
            partitions={"torghut.trade-updates.v1": {0}},
        )
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)
        ingestor._consumer = consumer
        ingestor._manual_assignment_ready = True

        ingestor.close()

        self.assertIsNone(ingestor._consumer)
        self.assertFalse(ingestor._manual_assignment_ready)

    def test_existing_manual_consumer_gets_assigned_before_poll(self) -> None:
        settings.trading_order_feed_assignment_mode = "manual"
        settings.trading_order_feed_auto_offset_reset = "earliest"
        consumer = FakeManualConsumer(
            [],
            partitions={"torghut.trade-updates.v1": {0}},
        )
        ingestor = OrderFeedIngestor(consumer_factory=lambda: FakeConsumer([]))
        ingestor._consumer = consumer
        ingestor._manual_assignment_ready = False

        with Session(self.engine) as session:
            counters = ingestor.ingest_once(session)

        self.assertEqual(counters["messages_total"], 0)
        self.assertEqual(
            consumer.assigned, [TopicPartition("torghut.trade-updates.v1", 0)]
        )
        self.assertTrue(ingestor._manual_assignment_ready)

    def test_manual_assignment_resumes_after_persisted_offsets(self) -> None:
        settings.trading_order_feed_assignment_mode = "manual"
        settings.trading_order_feed_auto_offset_reset = "earliest"
        consumer = FakeManualConsumer(
            [],
            partitions={"torghut.trade-updates.v1": {0, 1}},
        )

        with Session(self.engine) as session:
            existing = OrderFeedSourceWindow(
                consumer_group=settings.trading_order_feed_group_id,
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                alpaca_account_label="paper",
                assignment_mode="manual",
                source_revision=ORDER_FEED_SOURCE_REVISION,
                window_started_at=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                window_ended_at=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                start_offset=41,
                end_offset=41,
                consumed_count=1,
                status="inserted",
            )
            session.add(existing)
            session.commit()

            ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)
            counters = ingestor.ingest_once(session)

        self.assertEqual(counters["messages_total"], 0)
        self.assertEqual(
            consumer.assigned,
            [
                TopicPartition("torghut.trade-updates.v1", 0),
                TopicPartition("torghut.trade-updates.v1", 1),
            ],
        )
        self.assertEqual(
            consumer.seek_calls,
            [(TopicPartition("torghut.trade-updates.v1", 0), 42)],
        )
        self.assertEqual(
            consumer.seek_to_beginning_calls,
            [(TopicPartition("torghut.trade-updates.v1", 1),)],
        )
        self.assertEqual(consumer.seek_to_end_calls, [])

    def test_manual_assignment_prefers_consumer_cursor_over_event_rows(self) -> None:
        settings.trading_order_feed_assignment_mode = "manual"
        settings.trading_order_feed_auto_offset_reset = "earliest"
        settings.trading_order_feed_group_id = "torghut-order-feed-v1"
        consumer = FakeManualConsumer(
            [],
            partitions={"torghut.trade-updates.v1": {0}},
        )

        with Session(self.engine) as session:
            session.add(
                ExecutionOrderEvent(
                    event_fingerprint="legacy-event",
                    source_topic="torghut.trade-updates.v1",
                    source_partition=0,
                    source_offset=41,
                    alpaca_account_label="paper",
                    symbol="AAPL",
                    raw_event={"event": "fill"},
                )
            )
            session.add(
                OrderFeedSourceWindow(
                    consumer_group="torghut-order-feed-v1",
                    source_topic="torghut.trade-updates.v1",
                    source_partition=0,
                    alpaca_account_label="paper",
                    assignment_mode="manual",
                    source_revision=ORDER_FEED_SOURCE_REVISION,
                    window_started_at=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                    window_ended_at=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                    start_offset=49,
                    end_offset=49,
                    consumed_count=1,
                    status="inserted",
                )
            )
            session.add(
                OrderFeedConsumerCursor(
                    consumer_group="torghut-order-feed-v1",
                    source_topic="torghut.trade-updates.v1",
                    source_partition=0,
                    high_watermark_offset=57,
                    processed_event_count=9,
                )
            )
            session.commit()

            ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)
            counters = ingestor.ingest_once(session)

        self.assertEqual(counters["messages_total"], 0)
        self.assertEqual(
            consumer.seek_calls,
            [(TopicPartition("torghut.trade-updates.v1", 0), 58)],
        )
        self.assertEqual(consumer.seek_to_beginning_calls, [])

    def test_backfill_source_windows_links_legacy_events_without_cursor_authority(
        self,
    ) -> None:
        settings.trading_order_feed_assignment_mode = "manual"
        settings.trading_order_feed_auto_offset_reset = "earliest"
        settings.trading_order_feed_group_id = "torghut-order-feed-v1"
        consumer = FakeManualConsumer(
            [],
            partitions={"torghut.trade-updates.v1": {0}},
        )

        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            event = ExecutionOrderEvent(
                event_fingerprint="legacy-fill-with-source-offset",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=88,
                alpaca_account_label="paper",
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id=execution.alpaca_order_id,
                client_order_id=execution.client_order_id,
                event_type="fill",
                status="filled",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("191.25"),
                raw_event={"event": "fill"},
                execution_id=execution.id,
                trade_decision_id=execution.trade_decision_id,
            )
            session.add(event)
            session.commit()

            result = backfill_order_feed_source_windows(
                session,
                account_label="paper",
                limit=10,
            )
            session.commit()
            session.refresh(event)
            source_window = session.get(OrderFeedSourceWindow, event.source_window_id)
            self.assertIsNotNone(source_window)
            assert source_window is not None
            ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)
            counters = ingestor.ingest_once(session)

        self.assertEqual(
            result,
            {
                "selected": 1,
                "source_windows_created": 1,
                "source_windows_reused": 0,
                "events_linked": 1,
            },
        )
        self.assertEqual(
            source_window.source_revision,
            HISTORICAL_ORDER_EVENT_SOURCE_WINDOW_REVISION,
        )
        self.assertEqual(source_window.status, "inserted")
        self.assertGreater(
            source_window.window_ended_at,
            source_window.window_started_at,
        )
        self.assertEqual(
            source_window.status_reason, "historical_execution_order_event_backfill"
        )
        self.assertEqual(source_window.inserted_count, 1)
        self.assertEqual(source_window.unlinked_execution_count, 0)
        self.assertEqual(source_window.unlinked_decision_count, 0)
        self.assertTrue(source_window.payload_json["source_coverage_complete"])
        self.assertEqual(
            source_window.payload_json["authority_class"],
            "runtime_order_feed_execution_source",
        )
        self.assertEqual(source_window.payload_json["cursor_authority"], False)
        self.assertEqual(counters["messages_total"], 0)
        self.assertEqual(consumer.seek_calls, [])
        self.assertEqual(
            consumer.seek_to_beginning_calls,
            [(TopicPartition("torghut.trade-updates.v1", 0),)],
        )

    def test_backfill_source_windows_reuses_existing_source_window(self) -> None:
        settings.trading_order_feed_assignment_mode = "manual"
        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            source_window = OrderFeedSourceWindow(
                consumer_group="torghut-order-feed-v1",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                alpaca_account_label="paper",
                assignment_mode="manual",
                source_revision=HISTORICAL_ORDER_EVENT_SOURCE_WINDOW_REVISION,
                window_started_at=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                window_ended_at=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                start_offset=88,
                end_offset=90,
                consumed_count=3,
                inserted_count=3,
                status="inserted",
            )
            session.add(source_window)
            session.flush()
            source_window_id = source_window.id
            event = ExecutionOrderEvent(
                event_fingerprint="legacy-fill-existing-source-window",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=89,
                alpaca_account_label="paper",
                event_ts=datetime(2026, 2, 1, 10, 1, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id=execution.alpaca_order_id,
                client_order_id=execution.client_order_id,
                event_type="fill",
                status="filled",
                raw_event={"event": "fill"},
                execution_id=execution.id,
                trade_decision_id=execution.trade_decision_id,
            )
            session.add(event)
            session.commit()

            result = backfill_order_feed_source_windows(
                session,
                account_label="paper",
                limit=10,
            )
            session.commit()
            session.refresh(event)

        self.assertEqual(
            result,
            {
                "selected": 1,
                "source_windows_created": 0,
                "source_windows_reused": 1,
                "events_linked": 1,
            },
        )
        self.assertEqual(event.source_window_id, source_window_id)

    def test_backfill_source_windows_filters_by_event_window(self) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            before_event = ExecutionOrderEvent(
                event_fingerprint="legacy-fill-before-window",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=111,
                alpaca_account_label="paper",
                event_ts=datetime(2026, 2, 1, 9, 59, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id=execution.alpaca_order_id,
                client_order_id=execution.client_order_id,
                event_type="fill",
                status="filled",
                raw_event={"event": "fill"},
                execution_id=execution.id,
                trade_decision_id=execution.trade_decision_id,
            )
            in_window_event = ExecutionOrderEvent(
                event_fingerprint="legacy-fill-inside-window",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=112,
                alpaca_account_label="paper",
                event_ts=datetime(2026, 2, 1, 10, 5, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id=execution.alpaca_order_id,
                client_order_id=execution.client_order_id,
                event_type="fill",
                status="filled",
                raw_event={"event": "fill"},
                execution_id=execution.id,
                trade_decision_id=execution.trade_decision_id,
            )
            after_event = ExecutionOrderEvent(
                event_fingerprint="legacy-fill-after-window",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=113,
                alpaca_account_label="paper",
                event_ts=datetime(2026, 2, 1, 10, 30, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id=execution.alpaca_order_id,
                client_order_id=execution.client_order_id,
                event_type="fill",
                status="filled",
                raw_event={"event": "fill"},
                execution_id=execution.id,
                trade_decision_id=execution.trade_decision_id,
            )
            session.add_all([before_event, in_window_event, after_event])
            session.commit()

            result = backfill_order_feed_source_windows(
                session,
                account_label="paper",
                window_start=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                window_end=datetime(2026, 2, 1, 10, 30, tzinfo=timezone.utc),
                limit=10,
            )
            session.commit()
            session.refresh(before_event)
            session.refresh(in_window_event)
            session.refresh(after_event)

        self.assertEqual(
            result,
            {
                "selected": 1,
                "source_windows_created": 1,
                "source_windows_reused": 0,
                "events_linked": 1,
            },
        )
        self.assertIsNone(before_event.source_window_id)
        self.assertIsNotNone(in_window_event.source_window_id)
        self.assertIsNone(after_event.source_window_id)

    def test_linking_one_event_keeps_source_window_unlinked_counts_aggregate(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            execution_id = execution.id
            trade_decision_id = execution.trade_decision_id
            source_window = OrderFeedSourceWindow(
                consumer_group="torghut-order-feed-v1",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                alpaca_account_label="paper",
                assignment_mode="manual",
                source_revision=ORDER_FEED_SOURCE_REVISION,
                window_started_at=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                window_ended_at=datetime(2026, 2, 1, 10, 1, tzinfo=timezone.utc),
                start_offset=88,
                end_offset=89,
                consumed_count=2,
                inserted_count=2,
                unlinked_execution_count=2,
                unlinked_decision_count=2,
                status="inserted",
            )
            session.add(source_window)
            session.flush()

            linkable_event = ExecutionOrderEvent(
                event_fingerprint="legacy-fill-linkable-source-window",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=88,
                alpaca_account_label="paper",
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id=execution.alpaca_order_id,
                client_order_id=execution.client_order_id,
                event_type="fill",
                status="filled",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("191.25"),
                raw_event={"event": "fill"},
                source_window_id=source_window.id,
            )
            still_unlinked_event = ExecutionOrderEvent(
                event_fingerprint="legacy-fill-still-unlinked-source-window",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=89,
                alpaca_account_label="paper",
                event_ts=datetime(2026, 2, 1, 10, 1, tzinfo=timezone.utc),
                symbol="MSFT",
                alpaca_order_id="other-order",
                client_order_id="other-client",
                event_type="fill",
                status="filled",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("320.00"),
                raw_event={"event": "fill"},
                source_window_id=source_window.id,
            )
            session.add_all([linkable_event, still_unlinked_event])
            session.commit()

            linked = link_order_events_to_execution(session, execution)
            session.commit()
            session.refresh(source_window)
            session.refresh(linkable_event)
            session.refresh(still_unlinked_event)

        self.assertEqual(linked, 1)
        self.assertEqual(linkable_event.execution_id, execution_id)
        self.assertEqual(linkable_event.trade_decision_id, trade_decision_id)
        self.assertIsNone(still_unlinked_event.execution_id)
        self.assertIsNone(still_unlinked_event.trade_decision_id)
        self.assertEqual(source_window.inserted_count, 2)
        self.assertEqual(source_window.unlinked_execution_count, 1)
        self.assertEqual(source_window.unlinked_decision_count, 1)

    def test_linking_legacy_offset_event_creates_source_window_lineage(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            execution_id = execution.id
            trade_decision_id = execution.trade_decision_id
            linkable_event = ExecutionOrderEvent(
                event_fingerprint="legacy-fill-linkable-missing-source-window",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=188,
                alpaca_account_label="paper",
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id=execution.alpaca_order_id,
                client_order_id=execution.client_order_id,
                event_type="fill",
                status="filled",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("191.25"),
                raw_event={"event": "fill"},
            )
            session.add(linkable_event)
            session.commit()

            linked = link_order_events_to_execution(session, execution)
            session.commit()
            session.refresh(linkable_event)
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()

        self.assertEqual(linked, 1)
        self.assertEqual(linkable_event.execution_id, execution_id)
        self.assertEqual(linkable_event.trade_decision_id, trade_decision_id)
        self.assertEqual(linkable_event.source_window_id, source_window.id)
        self.assertEqual(
            source_window.source_revision,
            HISTORICAL_ORDER_EVENT_SOURCE_WINDOW_REVISION,
        )
        self.assertEqual(source_window.status, "inserted")
        self.assertEqual(source_window.start_offset, 188)
        self.assertEqual(source_window.end_offset, 188)
        self.assertGreater(
            source_window.window_ended_at,
            source_window.window_started_at,
        )
        self.assertEqual(source_window.inserted_count, 1)
        self.assertEqual(source_window.unlinked_execution_count, 0)
        self.assertEqual(source_window.unlinked_decision_count, 0)
        self.assertEqual(
            source_window.status_reason, "historical_execution_order_event_backfill"
        )
        self.assertEqual(
            source_window.payload_json["source_ref"],
            {
                "topic": "torghut.trade-updates.v1",
                "partition": 0,
                "offset": 188,
            },
        )
        self.assertEqual(
            source_window.payload_json["order_identity"],
            {"alpaca_order_id": "order-1", "client_order_id": "client-1"},
        )
        self.assertEqual(
            source_window.payload_json["execution_order_event_id"],
            str(linkable_event.id),
        )
        self.assertEqual(
            source_window.payload_json["execution_id"], str(linkable_event.execution_id)
        )
        self.assertEqual(
            source_window.payload_json["trade_decision_id"],
            str(linkable_event.trade_decision_id),
        )
        self.assertEqual(
            source_window.payload_json["lifecycle"],
            {
                "event_type": "fill",
                "status": "filled",
                "event_ts": "2026-02-01T10:00:00+00:00",
                "feed_seq": None,
            },
        )
        self.assertTrue(source_window.payload_json["source_coverage_complete"])
        self.assertEqual(
            source_window.payload_json["authority_class"],
            "runtime_order_feed_execution_source",
        )

    def test_linking_event_uses_client_order_decision_when_execution_is_unlinked(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            execution_id = execution.id
            decision_id = execution.trade_decision_id
            execution.trade_decision_id = None
            session.add(execution)
            session.flush()
            event = ExecutionOrderEvent(
                event_fingerprint="legacy-fill-execution-missing-decision",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=238,
                alpaca_account_label="paper",
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id=execution.alpaca_order_id,
                client_order_id=execution.client_order_id,
                event_type="fill",
                status="filled",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("191.25"),
                raw_event={"event": "fill"},
            )
            session.add(event)
            session.commit()

            linked = link_order_events_to_execution(session, execution)
            session.commit()
            session.refresh(event)

        self.assertEqual(linked, 1)
        self.assertEqual(event.execution_id, execution_id)
        self.assertEqual(event.trade_decision_id, decision_id)

    def test_linking_events_applies_latest_stream_sequence_not_event_timestamp(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            execution_id = execution.id
            partial_event = ExecutionOrderEvent(
                event_fingerprint="legacy-partial-fill-later-event-ts",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=66072,
                feed_seq=183689,
                alpaca_account_label="paper",
                event_ts=datetime(2026, 2, 1, 10, 0, 0, 360000, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id=execution.alpaca_order_id,
                client_order_id=execution.client_order_id,
                event_type="partial_fill",
                status="partially_filled",
                filled_qty=Decimal("0.1614"),
                avg_fill_price=Decimal("311.01"),
                raw_event={"event": "partial_fill"},
            )
            fill_event = ExecutionOrderEvent(
                event_fingerprint="legacy-fill-earlier-event-ts-higher-feed-seq",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=66073,
                feed_seq=183690,
                alpaca_account_label="paper",
                event_ts=datetime(2026, 2, 1, 10, 0, 0, 358000, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id=execution.alpaca_order_id,
                client_order_id=execution.client_order_id,
                event_type="fill",
                status="filled",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("311.01"),
                raw_event={"event": "fill"},
            )
            session.add_all([partial_event, fill_event])
            session.commit()

            linked = link_order_events_to_execution(session, execution)
            session.commit()
            session.refresh(execution)
            session.refresh(partial_event)
            session.refresh(fill_event)

        self.assertEqual(linked, 2)
        self.assertEqual(partial_event.execution_id, execution_id)
        self.assertEqual(fill_event.execution_id, execution_id)
        self.assertEqual(execution.status, "filled")
        self.assertEqual(execution.filled_qty, Decimal("1.00000000"))
