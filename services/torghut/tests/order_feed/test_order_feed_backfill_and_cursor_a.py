from __future__ import annotations

from tests.order_feed.support import (
    ORDER_FEED_SOURCE_REVISION,
    Decimal,
    Execution,
    ExecutionOrderEvent,
    FakeConsumer,
    FakeManualConsumer,
    FakeRecord,
    OrderFeedConsumerCursor,
    OrderFeedIngestor,
    OrderFeedSourceWindow,
    OrderFeedTestCase,
    Session,
    SimpleNamespace,
    backfill_order_feed_events_from_executions,
    datetime,
    func,
    order_feed_module,
    patch,
    repair_order_feed_execution_links,
    repair_order_feed_execution_states,
    repair_order_feed_fill_deltas,
    select,
    settings,
    timedelta,
    timezone,
)


class TestOrderFeedBackfillAndCursorA(OrderFeedTestCase):
    def test_order_feed_repair_helpers_filter_to_runtime_window(self) -> None:
        window_start = datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc)
        window_end = datetime(2026, 2, 1, 10, 30, tzinfo=timezone.utc)
        inside_ts = datetime(2026, 2, 1, 10, 5, tzinfo=timezone.utc)
        outside_ts = datetime(2026, 2, 1, 11, 5, tzinfo=timezone.utc)

        with Session(self.engine) as session:
            inside_link_execution = self._seed_execution(
                session,
                account_label="PA3SX7FYNUTF",
                order_id="inside-link-order",
                client_order_id="inside-link-client",
            )
            outside_link_execution = self._seed_execution(
                session,
                account_label="PA3SX7FYNUTF",
                order_id="outside-link-order",
                client_order_id="outside-link-client",
            )
            inside_state_execution = self._seed_execution(
                session,
                account_label="PA3SX7FYNUTF",
                order_id="inside-state-order",
                client_order_id="inside-state-client",
            )
            outside_state_execution = self._seed_execution(
                session,
                account_label="PA3SX7FYNUTF",
                order_id="outside-state-order",
                client_order_id="outside-state-client",
            )
            inside_backfill_execution = self._seed_execution(
                session,
                account_label="PA3SX7FYNUTF",
                order_id="inside-backfill-order",
                client_order_id="inside-backfill-client",
            )
            outside_backfill_execution = self._seed_execution(
                session,
                account_label="PA3SX7FYNUTF",
                order_id="outside-backfill-order",
                client_order_id="outside-backfill-client",
            )
            for execution, ts in (
                (inside_link_execution, inside_ts),
                (inside_state_execution, inside_ts),
                (inside_backfill_execution, inside_ts),
                (outside_link_execution, outside_ts),
                (outside_state_execution, outside_ts),
                (outside_backfill_execution, outside_ts),
            ):
                execution.last_update_at = ts
                execution.status = "filled"
                execution.filled_qty = Decimal("1")
                execution.avg_fill_price = Decimal("191.25")
                execution.raw_order = {
                    "status": "filled",
                    "id": execution.alpaca_order_id,
                }
                session.add(execution)
            session.add_all(
                [
                    ExecutionOrderEvent(
                        event_fingerprint="inside-link-event",
                        source_topic="torghut.trade-updates.v2",
                        source_partition=0,
                        source_offset=201,
                        alpaca_account_label="PA3SX7FYNUTF",
                        event_ts=inside_ts,
                        symbol="AAPL",
                        alpaca_order_id="inside-link-order",
                        client_order_id="inside-link-client",
                        event_type="fill",
                        status="filled",
                        filled_qty=Decimal("1"),
                        avg_fill_price=Decimal("191.25"),
                        raw_event={"event": "fill"},
                    ),
                    ExecutionOrderEvent(
                        event_fingerprint="outside-link-event",
                        source_topic="torghut.trade-updates.v2",
                        source_partition=0,
                        source_offset=202,
                        alpaca_account_label="PA3SX7FYNUTF",
                        event_ts=outside_ts,
                        symbol="AAPL",
                        alpaca_order_id="outside-link-order",
                        client_order_id="outside-link-client",
                        event_type="fill",
                        status="filled",
                        filled_qty=Decimal("1"),
                        avg_fill_price=Decimal("191.25"),
                        raw_event={"event": "fill"},
                    ),
                    ExecutionOrderEvent(
                        event_fingerprint="inside-state-event",
                        source_topic="torghut.trade-updates.v2",
                        source_partition=0,
                        source_offset=203,
                        alpaca_account_label="PA3SX7FYNUTF",
                        event_ts=inside_ts,
                        symbol="AAPL",
                        alpaca_order_id="inside-state-order",
                        client_order_id="inside-state-client",
                        event_type="fill",
                        status="filled",
                        filled_qty=Decimal("1"),
                        avg_fill_price=Decimal("191.25"),
                        raw_event={"event": "fill"},
                        execution_id=inside_state_execution.id,
                        trade_decision_id=inside_state_execution.trade_decision_id,
                    ),
                    ExecutionOrderEvent(
                        event_fingerprint="outside-state-event",
                        source_topic="torghut.trade-updates.v2",
                        source_partition=0,
                        source_offset=204,
                        alpaca_account_label="PA3SX7FYNUTF",
                        event_ts=outside_ts,
                        symbol="AAPL",
                        alpaca_order_id="outside-state-order",
                        client_order_id="outside-state-client",
                        event_type="fill",
                        status="filled",
                        filled_qty=Decimal("1"),
                        avg_fill_price=Decimal("191.25"),
                        raw_event={"event": "fill"},
                        execution_id=outside_state_execution.id,
                        trade_decision_id=outside_state_execution.trade_decision_id,
                    ),
                ]
            )
            session.commit()

            link_result = repair_order_feed_execution_links(
                session,
                account_label="PA3SX7FYNUTF",
                window_start=window_start,
                window_end=window_end,
                limit=10,
            )
            session.commit()
            state_result = repair_order_feed_execution_states(
                session,
                account_label="PA3SX7FYNUTF",
                window_start=window_start,
                window_end=window_end,
                limit=10,
            )
            session.commit()
            delta_result = repair_order_feed_fill_deltas(
                session,
                account_label="PA3SX7FYNUTF",
                window_start=window_start,
                window_end=window_end,
                limit=10,
            )
            session.commit()
            backfill_result = backfill_order_feed_events_from_executions(
                session,
                account_label="PA3SX7FYNUTF",
                window_start=window_start,
                window_end=window_end,
                limit=10,
            )
            session.commit()
            outside_link_event = session.scalar(
                select(ExecutionOrderEvent).where(
                    ExecutionOrderEvent.event_fingerprint == "outside-link-event"
                )
            )
            outside_backfill_event_count = session.scalar(
                select(func.count(ExecutionOrderEvent.id)).where(
                    ExecutionOrderEvent.alpaca_order_id == "outside-backfill-order"
                )
            )

        self.assertEqual(link_result["selected"], 1)
        self.assertEqual(link_result["events_linked"], 1)
        self.assertEqual(state_result["selected"], 2)
        self.assertEqual(delta_result["selected"], 2)
        self.assertEqual(backfill_result["selected"], 1)
        self.assertEqual(backfill_result["events_created"], 1)
        self.assertIsNotNone(outside_link_event)
        assert outside_link_event is not None
        self.assertIsNone(outside_link_event.execution_id)
        self.assertEqual(outside_backfill_event_count, 0)

    def test_execution_event_backfill_filters_existing_order_feed_lifecycle(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(session, account_label="PA3SX7FYNUTF")
            session.add(
                ExecutionOrderEvent(
                    event_fingerprint="existing-live-fill",
                    source_topic="torghut.trade-updates.v2",
                    source_partition=0,
                    source_offset=101,
                    alpaca_account_label="PA3SX7FYNUTF",
                    event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                    symbol="AAPL",
                    alpaca_order_id=execution.alpaca_order_id,
                    client_order_id=execution.client_order_id,
                    event_type="fill",
                    status="filled",
                    raw_event={"event": "fill"},
                    execution_id=execution.id,
                    trade_decision_id=execution.trade_decision_id,
                )
            )
            session.commit()

            result = backfill_order_feed_events_from_executions(
                session,
                account_label="PA3SX7FYNUTF",
                limit=10,
            )
            event_count = session.scalar(select(func.count(ExecutionOrderEvent.id)))

        self.assertEqual(result["selected"], 0)
        self.assertEqual(result["events_created"], 0)
        self.assertEqual(result["skipped_existing_event"], 0)
        self.assertEqual(event_count, 1)

    def test_execution_event_backfill_handles_race_and_offset_collision(
        self,
    ) -> None:
        with Session(self.engine) as session:
            self._seed_execution(
                session,
                account_label="PA3SX7FYNUTF",
                order_id="race-order",
                client_order_id="race-client",
            )
            with patch.object(
                order_feed_module,
                "latest_order_event_for_execution",
                return_value=ExecutionOrderEvent(
                    event_fingerprint="race-existing",
                    source_topic="torghut.trade-updates.v2",
                    alpaca_account_label="PA3SX7FYNUTF",
                    raw_event={"event": "fill"},
                ),
            ):
                race_result = backfill_order_feed_events_from_executions(
                    session,
                    account_label="PA3SX7FYNUTF",
                    limit=10,
                )

            session.add(
                ExecutionOrderEvent(
                    event_fingerprint="offset-collision",
                    source_topic=order_feed_module.EXECUTION_RAW_ORDER_SOURCE_TOPIC,
                    source_partition=order_feed_module.EXECUTION_RAW_ORDER_SOURCE_PARTITION,
                    source_offset=77,
                    alpaca_account_label="PA3SX7FYNUTF",
                    event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                    symbol="MSFT",
                    alpaca_order_id="other-order",
                    client_order_id="other-client",
                    event_type="fill",
                    status="filled",
                    raw_event={"event": "fill"},
                )
            )
            session.commit()
            with patch.object(
                order_feed_module,
                "_stable_execution_source_offset",
                return_value=77,
            ):
                collision_result = backfill_order_feed_events_from_executions(
                    session,
                    account_label="PA3SX7FYNUTF",
                    limit=10,
                )

        self.assertEqual(race_result["selected"], 1)
        self.assertEqual(race_result["events_created"], 0)
        self.assertEqual(race_result["skipped_existing_event"], 1)
        self.assertEqual(collision_result["selected"], 1)
        self.assertEqual(collision_result["events_created"], 0)
        self.assertEqual(collision_result["skipped_source_offset_collision"], 1)

    def test_execution_backfill_helper_edges_are_deterministic(self) -> None:
        partial_execution = Execution(
            trade_decision_id=None,
            alpaca_account_label="PA3SX7FYNUTF",
            alpaca_order_id="partial-order",
            client_order_id=None,
            symbol="AAPL",
            side="buy",
            order_type="limit",
            time_in_force="day",
            submitted_qty=Decimal("1"),
            filled_qty=Decimal("0.5"),
            status="partially_filled",
        )
        unknown_execution = Execution(
            trade_decision_id=None,
            alpaca_account_label="PA3SX7FYNUTF",
            alpaca_order_id="unknown-order",
            client_order_id=None,
            symbol="AAPL",
            side="buy",
            order_type="limit",
            time_in_force="day",
            submitted_qty=Decimal("1"),
            filled_qty=Decimal("0"),
            status="",
        )

        self.assertEqual(
            order_feed_module._execution_backfill_event_type(partial_execution),
            "partial_fill",
        )
        self.assertEqual(
            order_feed_module._execution_backfill_event_type(unknown_execution),
            "execution_snapshot",
        )
        self.assertEqual(
            order_feed_module._ensure_aware_utc(
                datetime(2026, 2, 1, 2, 0, tzinfo=timezone(timedelta(hours=-8)))
            ),
            datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
        )
        self.assertIsNone(order_feed_module._isoformat_datetime(None))
        self.assertEqual(
            order_feed_module._stable_execution_source_offset("not-a-uuid"),
            order_feed_module._stable_execution_source_offset("not-a-uuid"),
        )

    def test_historical_source_window_helpers_handle_missing_and_aware_offsets(
        self,
    ) -> None:
        event = ExecutionOrderEvent(
            event_fingerprint="legacy-fill-missing-offset",
            source_topic="torghut.trade-updates.v1",
            source_partition=None,
            source_offset=None,
            alpaca_account_label="paper",
            event_ts=datetime(
                2026,
                2,
                1,
                2,
                0,
                tzinfo=timezone(timedelta(hours=-8)),
            ),
            symbol="AAPL",
            event_type="fill",
            status="filled",
            raw_event={"event": "fill"},
        )

        with Session(self.engine) as session:
            self.assertIsNone(
                order_feed_module._find_existing_source_window_for_event(
                    session,
                    event,
                )
            )
            with self.assertRaisesRegex(
                ValueError,
                "historical_source_window_requires_source_offset",
            ):
                order_feed_module._create_historical_source_window_for_event(
                    session,
                    event,
                )

        self.assertEqual(
            order_feed_module._event_timestamp_for_source_window(event),
            datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
        )

    def test_ingest_persists_durable_consumer_cursor_for_valid_event(self) -> None:
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

        self.assertEqual(counters["events_persisted_total"], 1)
        self.assertEqual(counters["cursor_updates_total"], 1)
        self.assertEqual(consumer.commit_calls, 1)
        self.assertEqual(cursor.consumer_group, settings.trading_order_feed_group_id)
        self.assertEqual(cursor.source_topic, "torghut.trade-updates.v1")
        self.assertEqual(cursor.source_partition, 0)
        self.assertEqual(cursor.high_watermark_offset, 7)
        self.assertEqual(cursor.processed_event_count, 1)
        self.assertEqual(cursor.duplicate_event_count, 0)

        with Session(self.engine) as session:
            event = session.execute(select(ExecutionOrderEvent)).scalar_one()
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()

        self.assertEqual(event.source_window_id, source_window.id)
        self.assertEqual(source_window.status, "inserted")
        self.assertEqual(source_window.start_offset, 7)
        self.assertEqual(source_window.end_offset, 7)
        self.assertEqual(source_window.consumed_count, 1)
        self.assertEqual(source_window.inserted_count, 1)
        self.assertEqual(source_window.unlinked_execution_count, 0)
        self.assertEqual(source_window.unlinked_decision_count, 0)
        self.assertEqual(source_window.status_reason, "linked_execution_and_decision")
        self.assertEqual(
            source_window.payload_json["source_ref"],
            {
                "topic": "torghut.trade-updates.v1",
                "partition": 0,
                "offset": 7,
            },
        )
        self.assertEqual(
            source_window.payload_json["order_identity"],
            {"alpaca_order_id": "order-1", "client_order_id": "client-1"},
        )
        self.assertEqual(
            source_window.payload_json["execution_order_event_id"], str(event.id)
        )
        self.assertEqual(
            source_window.payload_json["execution_id"], str(event.execution_id)
        )
        self.assertEqual(
            source_window.payload_json["trade_decision_id"],
            str(event.trade_decision_id),
        )
        self.assertEqual(
            source_window.payload_json["lifecycle"],
            {
                "event_type": "fill",
                "status": "filled",
                "event_ts": "2026-02-01T10:00:00+00:00",
                "feed_seq": 10,
            },
        )
        self.assertTrue(source_window.payload_json["source_coverage_complete"])
        self.assertEqual(
            source_window.payload_json["authority_class"],
            "runtime_order_feed_execution_source",
        )

    def test_source_window_records_scope_revision_and_available_high_watermark(
        self,
    ) -> None:
        settings.trading_order_feed_group_id = "torghut-paper-order-feed-v2"
        settings.trading_order_feed_client_id = "paper-collector-7"
        settings.trading_order_feed_assignment_mode = "manual"
        record = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
                b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            offset=31,
            broker_high_watermark=37,
        )
        consumer = FakeManualConsumer(
            [record], partitions={"torghut.trade-updates.v1": {0}}
        )
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            self._seed_execution(session)
            counters = ingestor.ingest_once(session)
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()

        self.assertEqual(counters["events_persisted_total"], 1)
        self.assertEqual(source_window.consumer_group, "torghut-paper-order-feed-v2")
        self.assertEqual(source_window.source_topic, "torghut.trade-updates.v1")
        self.assertEqual(source_window.source_partition, 0)
        self.assertEqual(source_window.alpaca_account_label, "paper")
        self.assertEqual(source_window.assignment_mode, "manual")
        self.assertEqual(source_window.collector_identity, "paper-collector-7")
        self.assertEqual(source_window.source_revision, ORDER_FEED_SOURCE_REVISION)
        self.assertEqual(source_window.start_offset, 31)
        self.assertEqual(source_window.end_offset, 31)
        self.assertEqual(source_window.broker_high_watermark, 37)
        self.assertEqual(source_window.status, "inserted")

    def test_manual_assignment_skips_kafka_commit_after_durable_cursor_update(
        self,
    ) -> None:
        settings.trading_order_feed_assignment_mode = "manual"
        settings.trading_order_feed_auto_offset_reset = "earliest"
        record = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
                b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            offset=32,
        )
        consumer = FakeManualConsumer(
            [record],
            partitions={"torghut.trade-updates.v1": {0}},
        )
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            self._seed_execution(session)
            counters = ingestor.ingest_once(session)
            cursor = session.execute(select(OrderFeedConsumerCursor)).scalar_one()
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()

        self.assertEqual(counters["events_persisted_total"], 1)
        self.assertEqual(counters["cursor_updates_total"], 1)
        self.assertEqual(counters["consumer_commits_total"], 0)
        self.assertEqual(counters["consumer_commit_skipped_total"], 1)
        self.assertEqual(consumer.commit_calls, 0)
        self.assertEqual(cursor.high_watermark_offset, 32)
        self.assertEqual(source_window.assignment_mode, "manual")
        self.assertEqual(source_window.status, "inserted")

    def test_invalid_json_is_durably_classified_before_cursor_advance(self) -> None:
        record = FakeRecord(value=b"{not-json", offset=17)
        consumer = FakeConsumer([record])
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            counters = ingestor.ingest_once(session)
            cursor = session.execute(select(OrderFeedConsumerCursor)).scalar_one()
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()
            event_count = len(session.execute(select(ExecutionOrderEvent)).all())

        self.assertEqual(counters["classified_drops_total"], 1)
        self.assertEqual(counters["malformed_total"], 1)
        self.assertEqual(counters["cursor_updates_total"], 1)
        self.assertEqual(consumer.commit_calls, 1)
        self.assertEqual(event_count, 0)
        self.assertEqual(cursor.high_watermark_offset, 17)
        self.assertEqual(source_window.status, "dropped")
        self.assertEqual(source_window.status_reason, "malformed_json")
        self.assertEqual(source_window.malformed_count, 1)
        self.assertEqual(source_window.dropped_count, 1)
        self.assertEqual(source_window.classification_counts, {"malformed_json": 1})
        self.assertEqual(
            source_window.payload_json["classification_counts"],
            source_window.classification_counts,
        )
        self.assertFalse(source_window.payload_json["source_coverage_complete"])
        self.assertFalse(source_window.payload_json["promotion_authority_eligible"])
        self.assertEqual(
            source_window.payload_json["source_ref"],
            {
                "topic": "torghut.trade-updates.v1",
                "partition": 0,
                "offset": 17,
            },
        )

    def test_missing_trade_update_payload_is_durably_classified(self) -> None:
        record = FakeRecord(
            value=b'{"channel":"orders","payload":{"event":"fill"}}', offset=18
        )
        consumer = FakeConsumer([record])
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            counters = ingestor.ingest_once(session)
            cursor = session.execute(select(OrderFeedConsumerCursor)).scalar_one()
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()
            event_count = len(session.execute(select(ExecutionOrderEvent)).all())

        self.assertEqual(counters["classified_drops_total"], 1)
        self.assertEqual(counters["missing_payload_total"], 1)
        self.assertEqual(counters["cursor_updates_total"], 1)
        self.assertEqual(consumer.commit_calls, 1)
        self.assertEqual(event_count, 0)
        self.assertEqual(cursor.high_watermark_offset, 18)
        self.assertEqual(source_window.status, "dropped")
        self.assertEqual(source_window.status_reason, "missing_trade_update_payload")
        self.assertEqual(source_window.missing_payload_count, 1)
        self.assertEqual(source_window.dropped_count, 1)
        self.assertEqual(
            source_window.classification_counts,
            {"missing_trade_update_payload": 1},
        )
        self.assertEqual(
            source_window.payload_json["classification_counts"],
            source_window.classification_counts,
        )

    def test_out_of_scope_account_is_durably_classified(self) -> None:
        record = FakeRecord(
            value=(
                b'{"channel":"trade_updates","account_label":"paper-b",'
                b'"payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-b","client_order_id":"client-b","symbol":"AAPL",'
                b'"status":"filled","qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            offset=19,
        )
        consumer = FakeConsumer([record])
        ingestor = OrderFeedIngestor(
            consumer_factory=lambda: consumer,
            default_account_label="paper-a",
        )

        with Session(self.engine) as session:
            counters = ingestor.ingest_once(session)
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()
            cursor = session.execute(select(OrderFeedConsumerCursor)).scalar_one()
            event_count = len(session.execute(select(ExecutionOrderEvent)).all())

        self.assertEqual(counters["classified_drops_total"], 1)
        self.assertEqual(counters["out_of_scope_account_total"], 1)
        self.assertEqual(counters["cursor_updates_total"], 1)
        self.assertEqual(consumer.commit_calls, 1)
        self.assertEqual(event_count, 0)
        self.assertEqual(cursor.high_watermark_offset, 19)
        self.assertEqual(source_window.alpaca_account_label, "paper-a")
        self.assertEqual(source_window.status, "dropped")
        self.assertEqual(source_window.status_reason, "out_of_scope_account")
        self.assertEqual(source_window.out_of_scope_account_count, 1)
        self.assertEqual(
            source_window.classification_counts,
            {"out_of_scope_account": 1},
        )
        self.assertEqual(
            source_window.payload_json["classification_counts"],
            source_window.classification_counts,
        )

    def test_out_of_scope_account_without_source_position_is_not_committed(
        self,
    ) -> None:
        record = SimpleNamespace(
            value=(
                b'{"channel":"trade_updates","account_label":"paper-b",'
                b'"payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-b","client_order_id":"client-b","symbol":"AAPL",'
                b'"status":"filled","qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            topic="torghut.trade-updates.v1",
        )
        consumer = FakeConsumer([record])
        ingestor = OrderFeedIngestor(
            consumer_factory=lambda: consumer,
            default_account_label="paper-a",
        )

        with Session(self.engine) as session:
            counters = ingestor.ingest_once(session)
            source_window_count = len(
                session.execute(select(OrderFeedSourceWindow)).all()
            )
            cursor_count = len(session.execute(select(OrderFeedConsumerCursor)).all())

        self.assertEqual(counters["messages_total"], 1)
        self.assertEqual(counters["cursor_updates_total"], 0)
        self.assertEqual(consumer.commit_calls, 0)
        self.assertEqual(source_window_count, 0)
        self.assertEqual(cursor_count, 0)

    def test_missing_order_identity_is_durably_classified(self) -> None:
        record = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"symbol":"AAPL","status":"filled","qty":"1","filled_qty":"1",'
                b'"filled_avg_price":"190.2"}},"seq":10}'
            ),
            offset=18,
        )
        consumer = FakeConsumer([record])
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            counters = ingestor.ingest_once(session)
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()
            cursor = session.execute(select(OrderFeedConsumerCursor)).scalar_one()

        self.assertEqual(counters["classified_drops_total"], 1)
        self.assertEqual(counters["missing_identity_total"], 1)
        self.assertEqual(source_window.status, "dropped")
        self.assertEqual(source_window.status_reason, "missing_order_identity")
        self.assertEqual(source_window.missing_identity_count, 1)
        self.assertEqual(
            source_window.payload_json["order_identity"],
            {"alpaca_order_id": None, "client_order_id": None},
        )
        self.assertEqual(
            source_window.payload_json["lifecycle"],
            {
                "event_type": "fill",
                "status": "filled",
                "event_ts": "2026-02-01T10:00:00+00:00",
                "feed_seq": 10,
            },
        )
        self.assertFalse(source_window.payload_json["source_coverage_complete"])
        self.assertFalse(source_window.payload_json["promotion_authority_eligible"])
        self.assertEqual(
            source_window.payload_json["authority_class"],
            "invalid_order_feed_message",
        )
        self.assertEqual(cursor.high_watermark_offset, 18)

    def test_unhandled_persist_failure_is_classified_without_cursor_or_kafka_commit(
        self,
    ) -> None:
        record = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
                b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            offset=20,
        )
        consumer = FakeConsumer([record])
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            with patch(
                (
                    "app.trading.order_feed_modules.part_01_statements_32"
                    ".persist_order_event"
                ),
                side_effect=RuntimeError("store failed"),
            ):
                counters = ingestor.ingest_once(session)
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()
            cursor_count = len(session.execute(select(OrderFeedConsumerCursor)).all())
            event_count = len(session.execute(select(ExecutionOrderEvent)).all())

        self.assertEqual(counters["messages_total"], 1)
        self.assertEqual(counters["failed_unhandled_total"], 1)
        self.assertEqual(counters["consumer_errors_total"], 1)
        self.assertEqual(counters["cursor_updates_total"], 0)
        self.assertEqual(consumer.commit_calls, 0)
        self.assertEqual(cursor_count, 0)
        self.assertEqual(event_count, 0)
        self.assertEqual(source_window.status, "failed_unhandled")
        self.assertEqual(source_window.failed_unhandled_count, 1)
        self.assertIn("RuntimeError", source_window.status_reason or "")

    def test_unhandled_apply_failure_does_not_advance_source_cursor(self) -> None:
        record = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
                b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            offset=21,
        )
        consumer = FakeConsumer([record])
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            self._seed_execution(session)
            with patch(
                (
                    "app.trading.order_feed_modules.part_01_statements_32"
                    ".apply_order_event_to_execution"
                ),
                side_effect=RuntimeError("apply failed"),
            ):
                counters = ingestor.ingest_once(session)
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()
            cursor_count = len(session.execute(select(OrderFeedConsumerCursor)).all())
            event_count = len(session.execute(select(ExecutionOrderEvent)).all())

        self.assertEqual(counters["messages_total"], 1)
        self.assertEqual(counters["events_persisted_total"], 1)
        self.assertEqual(counters["failed_unhandled_total"], 1)
        self.assertEqual(counters["cursor_updates_total"], 0)
        self.assertEqual(consumer.commit_calls, 0)
        self.assertEqual(cursor_count, 0)
        self.assertEqual(event_count, 1)
        self.assertEqual(source_window.status, "failed_unhandled")
        self.assertEqual(source_window.failed_unhandled_count, 1)
