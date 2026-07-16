from __future__ import annotations

from app.models import BrokerAccountActivity

from tests.order_feed.support import (
    Decimal,
    Execution,
    ExecutionOrderEvent,
    FakeConsumer,
    FakeManualConsumer,
    FakeManualConsumerWithoutEndSeek,
    FakeRecord,
    ORDER_FEED_SOURCE_REVISION,
    OrderFeedConsumerCursor,
    OrderFeedIngestor,
    OrderFeedSourceWindow,
    OrderFeedTestCase,
    Session,
    TopicPartition,
    cross_dsn_linkage_counts_for_source_window,
    datetime,
    normalize_order_feed_record,
    persist_order_event,
    refresh_source_window_linkage_counts,
    select,
    settings,
    timezone,
)


class TestOrderFeedFillDeltaAndIngest(OrderFeedTestCase):
    def test_ingest_appends_one_immutable_broker_source_fact_across_replay(
        self,
    ) -> None:
        payload = (
            b'{"channel":"trade_updates","ingestTs":"2026-07-16T01:00:01Z",'
            b'"payload":{"event":"fill","price":"190.20","qty":"1",'
            b'"timestamp":"2026-07-16T01:00:00Z","order":{"id":"order-1",'
            b'"client_order_id":"client-1","symbol":"AAPL","side":"buy",'
            b'"status":"filled","qty":"1","filled_qty":"1"}},"seq":10}'
        )
        consumer = FakeConsumer(
            [
                FakeRecord(value=payload, offset=10),
                FakeRecord(value=payload, offset=11),
            ]
        )
        ingestor = OrderFeedIngestor(
            consumer_factory=lambda: consumer,
            default_account_label="paper",
            broker_environment="paper",
            broker_endpoint_fingerprint="a" * 64,
        )

        with Session(self.engine) as session:
            self._seed_execution(session)
            counters = ingestor.ingest_once(session)

        self.assertEqual(counters["immutable_source_events_total"], 1)
        self.assertEqual(counters["immutable_source_duplicates_total"], 1)
        with Session(self.engine) as session:
            rows = session.scalars(select(BrokerAccountActivity)).all()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].source, "trade_updates_ws")
        self.assertEqual(rows[0].source_offset, 10)
        self.assertNotIn("ingestTs", rows[0].raw_payload)

    def test_duplicate_event_source_window_attach_refreshes_linkage_counts(
        self,
    ) -> None:
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
            b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
        )
        record = FakeRecord(value=payload, offset=11)

        with Session(self.engine) as session:
            self._seed_execution(session)
            normalized = normalize_order_feed_record(
                record,
                default_topic="torghut.trade-updates.v1",
                default_account_label="paper",
            )
            assert normalized.event is not None
            persisted, duplicate = persist_order_event(session, normalized.event)
            self.assertFalse(duplicate)
            persisted_id = persisted.id
            source_window = OrderFeedSourceWindow(
                consumer_group="torghut-order-feed-v1",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                alpaca_account_label="paper",
                assignment_mode="manual",
                source_revision=ORDER_FEED_SOURCE_REVISION,
                window_started_at=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                window_ended_at=datetime(2026, 2, 1, 10, 1, tzinfo=timezone.utc),
                start_offset=11,
                end_offset=11,
                consumed_count=1,
                inserted_count=1,
                unlinked_execution_count=1,
                unlinked_decision_count=1,
                status="inserted",
            )
            session.add(source_window)
            session.flush()
            persisted.source_window_id = None
            session.flush()

            persisted_again, duplicate_again = persist_order_event(
                session,
                normalized.event,
                source_window_id=source_window.id,
            )
            persisted_again_id = persisted_again.id
            session.commit()
            session.refresh(source_window)

        self.assertTrue(duplicate_again)
        self.assertEqual(persisted_again_id, persisted_id)
        self.assertEqual(source_window.unlinked_execution_count, 0)
        self.assertEqual(source_window.unlinked_decision_count, 0)

    def test_source_window_refresh_counts_cross_dsn_refs_separately(
        self,
    ) -> None:
        with Session(self.engine) as session:
            source_window = OrderFeedSourceWindow(
                consumer_group="torghut-order-feed-v1",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                alpaca_account_label="PA3SX7FYNUTF",
                assignment_mode="manual",
                source_revision=ORDER_FEED_SOURCE_REVISION,
                window_started_at=datetime(2026, 6, 11, 13, 30, tzinfo=timezone.utc),
                window_ended_at=datetime(2026, 6, 11, 20, 10, tzinfo=timezone.utc),
                start_offset=1,
                end_offset=4,
                consumed_count=4,
                inserted_count=4,
                unlinked_execution_count=4,
                unlinked_decision_count=4,
                status="inserted",
                classification_counts={
                    "cross_dsn_execution_ref_count": 99,
                },
                payload_json={
                    "classification_counts": {
                        "cross_dsn_execution_ref_count": 99,
                    }
                },
            )
            session.add(source_window)
            session.flush()
            events = [
                ExecutionOrderEvent(
                    event_fingerprint="cross-dsn-raw-list",
                    source_topic="torghut.trade-updates.v1",
                    source_partition=0,
                    source_offset=1,
                    alpaca_account_label="PA3SX7FYNUTF",
                    event_ts=datetime(2026, 6, 11, 14, 0, tzinfo=timezone.utc),
                    symbol="AMZN",
                    raw_event=["not-a-mapping"],
                    source_window_id=source_window.id,
                ),
                ExecutionOrderEvent(
                    event_fingerprint="cross-dsn-no-linkage",
                    source_topic="torghut.trade-updates.v1",
                    source_partition=0,
                    source_offset=2,
                    alpaca_account_label="PA3SX7FYNUTF",
                    event_ts=datetime(2026, 6, 11, 14, 1, tzinfo=timezone.utc),
                    symbol="AMZN",
                    raw_event={"event": "fill"},
                    source_window_id=source_window.id,
                ),
                ExecutionOrderEvent(
                    event_fingerprint="cross-dsn-bad-linkage",
                    source_topic="torghut.trade-updates.v1",
                    source_partition=0,
                    source_offset=3,
                    alpaca_account_label="PA3SX7FYNUTF",
                    event_ts=datetime(2026, 6, 11, 14, 2, tzinfo=timezone.utc),
                    symbol="AMZN",
                    raw_event={"_torghut_cross_dsn_linkage": "bad"},
                    source_window_id=source_window.id,
                ),
                ExecutionOrderEvent(
                    event_fingerprint="cross-dsn-linked",
                    source_topic="torghut.trade-updates.v1",
                    source_partition=0,
                    source_offset=4,
                    alpaca_account_label="PA3SX7FYNUTF",
                    event_ts=datetime(2026, 6, 11, 14, 3, tzinfo=timezone.utc),
                    symbol="AMZN",
                    raw_event={
                        "_torghut_cross_dsn_linkage": {
                            "canonical_execution_id": "execution-1",
                            "canonical_trade_decision_id": "decision-1",
                            "canonical_execution_tca_metric_id": "tca-1",
                        }
                    },
                    source_window_id=source_window.id,
                ),
            ]
            session.add_all(events)
            session.flush()

            counts = cross_dsn_linkage_counts_for_source_window(
                session,
                source_window.id,
            )
            refresh_source_window_linkage_counts(
                session,
                events[-1],
            )
            session.commit()
            session.refresh(source_window)

        self.assertEqual(
            counts,
            {
                "cross_dsn_execution_ref_count": 1,
                "cross_dsn_trade_decision_ref_count": 1,
                "cross_dsn_tca_ref_count": 1,
            },
        )
        self.assertEqual(source_window.payload_json["cross_dsn_execution_ref_count"], 1)
        self.assertEqual(
            source_window.classification_counts["cross_dsn_trade_decision_ref_count"],
            1,
        )
        self.assertEqual(source_window.unlinked_execution_count, 4)
        self.assertEqual(source_window.unlinked_decision_count, 4)

    def test_duplicate_event_advances_cursor_accounting_and_commits(self) -> None:
        record = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
                b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            offset=11,
        )

        with Session(self.engine) as session:
            self._seed_execution(session)
            first_consumer = FakeConsumer([record])
            first_ingestor = OrderFeedIngestor(consumer_factory=lambda: first_consumer)
            first_ingestor.ingest_once(session)

            duplicate_consumer = FakeConsumer([record])
            duplicate_ingestor = OrderFeedIngestor(
                consumer_factory=lambda: duplicate_consumer
            )
            counters = duplicate_ingestor.ingest_once(session)
            cursor = session.execute(select(OrderFeedConsumerCursor)).scalar_one()
            duplicate_source_window = session.execute(
                select(OrderFeedSourceWindow).where(
                    OrderFeedSourceWindow.status == "duplicate"
                )
            ).scalar_one()

        self.assertEqual(counters["duplicates_total"], 1)
        self.assertEqual(counters["cursor_updates_total"], 1)
        self.assertEqual(duplicate_consumer.commit_calls, 1)
        self.assertEqual(cursor.high_watermark_offset, 11)
        self.assertEqual(cursor.processed_event_count, 2)
        self.assertEqual(cursor.duplicate_event_count, 1)
        self.assertEqual(duplicate_source_window.duplicate_count, 1)
        self.assertEqual(duplicate_source_window.consumed_count, 1)
        self.assertEqual(
            duplicate_source_window.payload_json["classification_counts"],
            {"duplicate": 1},
        )
        self.assertEqual(
            duplicate_source_window.payload_json["order_identity"],
            {"alpaca_order_id": "order-1", "client_order_id": "client-1"},
        )
        self.assertEqual(
            duplicate_source_window.payload_json["lifecycle"]["status"], "filled"
        )
        self.assertFalse(
            duplicate_source_window.payload_json["source_coverage_complete"]
        )
        self.assertEqual(
            duplicate_source_window.payload_json["authority_class"],
            "duplicate_order_feed_message",
        )

    def test_manual_assignment_skips_missing_topic_metadata_then_fails_closed(
        self,
    ) -> None:
        settings.trading_order_feed_assignment_mode = "manual"
        consumer = FakeManualConsumer([], partitions={})
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            counters = ingestor.ingest_once(session)

        self.assertEqual(counters["consumer_errors_total"], 1)
        self.assertEqual(consumer.assigned, [])

    def test_manual_assignment_latest_requires_seek_to_end_support(self) -> None:
        settings.trading_order_feed_assignment_mode = "manual"
        settings.trading_order_feed_auto_offset_reset = "latest"
        consumer = FakeManualConsumerWithoutEndSeek(
            [],
            partitions={"torghut.trade-updates.v1": {0}},
        )
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            counters = ingestor.ingest_once(session)

        self.assertEqual(counters["consumer_errors_total"], 1)
        self.assertEqual(
            consumer.assigned, [TopicPartition("torghut.trade-updates.v1", 0)]
        )

    def test_manual_assignment_latest_seeks_unpositioned_to_end(self) -> None:
        settings.trading_order_feed_assignment_mode = "manual"
        settings.trading_order_feed_auto_offset_reset = "latest"
        consumer = FakeManualConsumer(
            [],
            partitions={"torghut.trade-updates.v1": {0}},
        )
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            counters = ingestor.ingest_once(session)

        self.assertEqual(counters["messages_total"], 0)
        self.assertEqual(consumer.seek_to_beginning_calls, [])
        self.assertEqual(
            consumer.seek_to_end_calls,
            [(TopicPartition("torghut.trade-updates.v1", 0),)],
        )

    def test_stream_and_root_order_payloads_are_normalized(self) -> None:
        stream_record = FakeRecord(
            value=(
                b'{"stream":"trade_updates","data":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-stream","client_order_id":"client-stream","symbol":"AAPL","status":"filled"}}}'
            )
        )
        root_record = FakeRecord(
            value=(
                b'{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-root","client_order_id":"client-root","symbol":"AAPL","status":"filled"}}'
            )
        )

        stream = normalize_order_feed_record(
            stream_record,
            default_topic="torghut.trade-updates.v1",
            default_account_label="paper",
        )
        root = normalize_order_feed_record(
            root_record,
            default_topic="torghut.trade-updates.v1",
            default_account_label="paper",
        )

        assert stream.event is not None
        assert root.event is not None
        self.assertEqual(stream.event.alpaca_order_id, "order-stream")
        self.assertEqual(root.event.alpaca_order_id, "order-root")

    def test_ingestor_applies_valid_events_and_tracks_missing_fields(self) -> None:
        good = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
                b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            offset=1,
        )
        bad = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:01:00Z",'
                b'"order":{"symbol":"AAPL"}},"seq":11}'
            ),
            offset=2,
        )
        consumer = FakeConsumer([good, bad])
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            self._seed_execution(session)
            counters = ingestor.ingest_once(session)
            execution = session.execute(
                select(Execution).where(Execution.alpaca_order_id == "order-1")
            ).scalar_one()
            rows = session.execute(select(ExecutionOrderEvent)).scalars().all()

        self.assertEqual(counters["messages_total"], 2)
        self.assertEqual(counters["events_persisted_total"], 1)
        self.assertEqual(counters["missing_fields_total"], 1)
        self.assertEqual(counters["apply_updates_total"], 1)
        self.assertEqual(consumer.commit_calls, 1)
        self.assertEqual(len(rows), 1)
        self.assertEqual(execution.status, "filled")
        self.assertEqual(execution.filled_qty, Decimal("1"))
