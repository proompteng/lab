from __future__ import annotations

from tests.order_feed.support import (
    Decimal,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    ORDER_FEED_SOURCE_REVISION,
    OrderFeedSourceWindow,
    OrderFeedTestCase,
    Session,
    datetime,
    order_feed_module,
    order_feed_repair_module,
    patch,
    repair_order_feed_execution_links,
    repair_order_feed_execution_states,
    select,
    timezone,
)


class TestOrderFeedRepairLinksA(OrderFeedTestCase):
    def test_repair_order_feed_execution_links_links_matching_lifecycle_rows(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            execution_id = execution.id
            trade_decision_id = execution.trade_decision_id
            linkable_event = ExecutionOrderEvent(
                event_fingerprint="repair-linkable-fill",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=288,
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
            unmatched_event = ExecutionOrderEvent(
                event_fingerprint="repair-unmatched-fill",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=289,
                alpaca_account_label="paper",
                event_ts=datetime(2026, 2, 1, 10, 1, tzinfo=timezone.utc),
                symbol="MSFT",
                alpaca_order_id="missing-order",
                client_order_id="missing-client",
                event_type="fill",
                status="filled",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("320.00"),
                raw_event={"event": "fill"},
            )
            session.add_all([linkable_event, unmatched_event])
            session.commit()

            result = repair_order_feed_execution_links(
                session,
                account_label="paper",
                limit=10,
            )
            session.commit()
            session.refresh(linkable_event)
            session.refresh(unmatched_event)
            session.refresh(execution)
            source_windows = (
                session.execute(select(OrderFeedSourceWindow)).scalars().all()
            )
            source_window = session.get(
                OrderFeedSourceWindow, linkable_event.source_window_id
            )
            unmatched_source_window = session.get(
                OrderFeedSourceWindow,
                unmatched_event.source_window_id,
            )
            tca_metric = session.execute(select(ExecutionTCAMetric)).scalar_one()

        self.assertEqual(len(source_windows), 2)
        self.assertIsNotNone(source_window)
        self.assertIsNotNone(unmatched_source_window)
        self.assertEqual(
            result,
            {
                "selected": 2,
                "executions_matched": 1,
                "executions_linked": 1,
                "decisions_matched": 0,
                "events_linked": 1,
                "decision_events_linked": 0,
                "events_without_execution": 1,
                "events_without_decision": 1,
                "account_alias_events_linked": 0,
            },
        )
        self.assertEqual(linkable_event.execution_id, execution_id)
        self.assertEqual(linkable_event.trade_decision_id, trade_decision_id)
        self.assertEqual(linkable_event.source_window_id, source_window.id)
        self.assertEqual(unmatched_event.source_window_id, unmatched_source_window.id)
        self.assertIsNone(unmatched_event.execution_id)
        self.assertIsNone(unmatched_event.trade_decision_id)
        self.assertEqual(execution.status, "filled")
        self.assertEqual(execution.filled_qty, Decimal("1.00000000"))
        self.assertEqual(tca_metric.execution_id, execution_id)
        self.assertEqual(source_window.unlinked_execution_count, 0)
        self.assertEqual(source_window.unlinked_decision_count, 0)
        self.assertTrue(source_window.payload_json["source_coverage_complete"])
        self.assertEqual(
            source_window.payload_json["linked_refs"],
            {
                "execution_order_event_id": str(linkable_event.id),
                "execution_id": str(execution_id),
                "trade_decision_id": str(trade_decision_id),
            },
        )
        self.assertEqual(
            source_window.payload_json["authority_class"],
            "runtime_order_feed_execution_source",
        )
        self.assertEqual(unmatched_source_window.unlinked_execution_count, 1)
        self.assertEqual(unmatched_source_window.unlinked_decision_count, 1)
        self.assertEqual(
            unmatched_source_window.status_reason,
            "historical_execution_order_event_backfill",
        )
        self.assertEqual(
            unmatched_source_window.payload_json["linkage_blockers"],
            ["missing_execution_link", "missing_trade_decision_link"],
        )

    def test_repair_order_feed_execution_states_reapplies_latest_stream_sequence(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(session, account_label="TORGHUT_SIM")
            execution_id = execution.id
            trade_decision_id = execution.trade_decision_id
            partial_event_ts = datetime(
                2026, 2, 1, 10, 0, 0, 360000, tzinfo=timezone.utc
            )
            execution.status = "partially_filled"
            execution.filled_qty = Decimal("0.16140000")
            execution.avg_fill_price = Decimal("311.01")
            execution.order_feed_last_seq = 183689
            execution.order_feed_last_event_ts = partial_event_ts
            session.add(execution)
            partial_event = ExecutionOrderEvent(
                event_fingerprint="repair-state-partial-later-event-ts",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=66072,
                feed_seq=183689,
                alpaca_account_label="PA3SX7FYNUTF",
                event_ts=partial_event_ts,
                symbol="AAPL",
                alpaca_order_id=execution.alpaca_order_id,
                client_order_id=execution.client_order_id,
                execution_id=execution_id,
                trade_decision_id=trade_decision_id,
                event_type="partial_fill",
                status="partially_filled",
                filled_qty=Decimal("0.1614"),
                avg_fill_price=Decimal("311.01"),
                raw_event={"event": "partial_fill"},
            )
            fill_event = ExecutionOrderEvent(
                event_fingerprint="repair-state-fill-higher-feed-seq",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=66073,
                feed_seq=183690,
                alpaca_account_label="PA3SX7FYNUTF",
                event_ts=datetime(2026, 2, 1, 10, 0, 0, 358000, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id=execution.alpaca_order_id,
                client_order_id=execution.client_order_id,
                execution_id=execution_id,
                trade_decision_id=trade_decision_id,
                event_type="fill",
                status="filled",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("311.01"),
                raw_event={"event": "fill"},
            )
            session.add_all([partial_event, fill_event])
            session.commit()

            result = repair_order_feed_execution_states(
                session,
                account_label="TORGHUT_SIM",
                limit=10,
            )
            session.commit()
            session.refresh(execution)

        self.assertEqual(
            result,
            {
                "selected": 1,
                "latest_event_found": 1,
                "executions_updated": 1,
                "out_of_order_events_skipped": 0,
            },
        )
        self.assertEqual(execution.status, "filled")
        self.assertEqual(execution.filled_qty, Decimal("1.00000000"))
        self.assertEqual(execution.order_feed_last_seq, 183690)

    def test_repair_order_feed_execution_states_counts_non_updating_outcomes(
        self,
    ) -> None:
        with Session(self.engine) as session:
            executions = [
                self._seed_execution(
                    session,
                    account_label="TORGHUT_SIM",
                    order_id=f"state-branch-order-{index}",
                    client_order_id=f"state-branch-client-{index}",
                )
                for index in range(3)
            ]
            linked_events = []
            for index, execution in enumerate(executions):
                event = ExecutionOrderEvent(
                    event_fingerprint=f"repair-state-branch-event-{index}",
                    source_topic="torghut.trade-updates.v1",
                    source_partition=0,
                    source_offset=67000 + index,
                    feed_seq=184000 + index,
                    alpaca_account_label="TORGHUT_SIM",
                    event_ts=datetime(2026, 2, 1, 10, index, tzinfo=timezone.utc),
                    symbol="AAPL",
                    alpaca_order_id=execution.alpaca_order_id,
                    client_order_id=execution.client_order_id,
                    execution_id=execution.id,
                    trade_decision_id=execution.trade_decision_id,
                    event_type="fill",
                    status="filled",
                    filled_qty=Decimal("1"),
                    avg_fill_price=Decimal("311.01"),
                    raw_event={"event": "fill"},
                )
                linked_events.append(event)
            session.add_all(linked_events)
            session.commit()

            with (
                patch.object(
                    order_feed_repair_module,
                    "latest_order_event_for_execution",
                    side_effect=[None, linked_events[1], linked_events[2]],
                ) as latest_event,
                patch.object(
                    order_feed_repair_module,
                    "apply_order_event_to_execution",
                    side_effect=[(False, True), (False, False)],
                ) as apply_event,
            ):
                result = repair_order_feed_execution_states(
                    session,
                    account_label="TORGHUT_SIM",
                    limit=10,
                )

        self.assertEqual(
            result,
            {
                "selected": 3,
                "latest_event_found": 2,
                "executions_updated": 0,
                "out_of_order_events_skipped": 1,
            },
        )
        self.assertEqual(latest_event.call_count, 3)
        self.assertEqual(apply_event.call_count, 2)

    def test_repair_order_feed_execution_links_links_by_alpaca_order_id_only(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            execution_id = execution.id
            trade_decision_id = execution.trade_decision_id
            event = ExecutionOrderEvent(
                event_fingerprint="repair-link-by-alpaca-order-id",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=328,
                alpaca_account_label="paper",
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id=execution.alpaca_order_id,
                client_order_id=None,
                event_type="fill",
                status="filled",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("191.25"),
                raw_event={"event": "fill"},
            )
            session.add(event)
            session.commit()

            result = repair_order_feed_execution_links(
                session,
                account_label="paper",
                limit=10,
            )
            session.commit()
            session.refresh(event)
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()

        self.assertEqual(result["events_linked"], 1)
        self.assertEqual(event.execution_id, execution_id)
        self.assertEqual(event.trade_decision_id, trade_decision_id)
        self.assertEqual(event.source_window_id, source_window.id)
        self.assertEqual(source_window.unlinked_execution_count, 0)
        self.assertEqual(source_window.unlinked_decision_count, 0)
        self.assertEqual(
            source_window.status_reason, "historical_execution_order_event_backfill"
        )

    def test_repair_order_feed_execution_links_links_by_execution_idempotency_key(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(
                session,
                order_id="broker-order-idempotency",
                client_order_id="decision-client-id",
                execution_idempotency_key="lean-idempotency-key-1",
            )
            execution_id = execution.id
            trade_decision_id = execution.trade_decision_id
            event = ExecutionOrderEvent(
                event_fingerprint="repair-link-by-idempotency-key",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=329,
                alpaca_account_label="paper",
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id=None,
                client_order_id="lean-idempotency-key-1",
                event_type="fill",
                status="filled",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("191.25"),
                raw_event={"event": "fill"},
            )
            session.add(event)
            session.commit()

            result = repair_order_feed_execution_links(
                session,
                account_label="paper",
                limit=10,
            )
            session.commit()
            session.refresh(event)
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()

        self.assertEqual(result["events_linked"], 1)
        self.assertEqual(event.execution_id, execution_id)
        self.assertEqual(event.trade_decision_id, trade_decision_id)
        self.assertEqual(event.source_window_id, source_window.id)
        self.assertEqual(source_window.unlinked_execution_count, 0)
        self.assertEqual(source_window.unlinked_decision_count, 0)
        self.assertEqual(source_window.payload_json["source_coverage_complete"], True)
        self.assertFalse(source_window.payload_json["promotion_authority_eligible"])

    def test_repair_order_feed_execution_links_resolves_configured_account_alias(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(
                session,
                account_label="TORGHUT_SIM",
                order_id="sim-alias-order-1",
                client_order_id="sim-alias-client-1",
            )
            execution_id = execution.id
            trade_decision_id = execution.trade_decision_id
            source_window = OrderFeedSourceWindow(
                consumer_group="torghut-order-feed-v1",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                alpaca_account_label="PA3SX7FYNUTF",
                assignment_mode="group",
                source_revision=ORDER_FEED_SOURCE_REVISION,
                window_started_at=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                window_ended_at=datetime(2026, 2, 1, 10, 1, tzinfo=timezone.utc),
                start_offset=330,
                end_offset=330,
                consumed_count=1,
                inserted_count=1,
                unlinked_execution_count=1,
                unlinked_decision_count=1,
                status="inserted",
                status_reason="missing_execution_and_decision_links",
            )
            session.add(source_window)
            session.flush()
            event = ExecutionOrderEvent(
                event_fingerprint="repair-configured-account-alias",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=330,
                alpaca_account_label="PA3SX7FYNUTF",
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id="sim-alias-order-1",
                client_order_id="sim-alias-client-1",
                event_type="fill",
                status="filled",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("191.25"),
                raw_event={"event": "fill"},
                source_window_id=source_window.id,
            )
            session.add(event)
            session.commit()

            result = repair_order_feed_execution_links(
                session,
                account_label="PA3SX7FYNUTF",
                canonical_account_label="TORGHUT_SIM",
                limit=10,
            )
            session.commit()
            session.refresh(event)
            session.refresh(source_window)

        self.assertEqual(result["events_linked"], 1)
        self.assertEqual(result["account_alias_events_linked"], 1)
        self.assertEqual(event.alpaca_account_label, "PA3SX7FYNUTF")
        self.assertEqual(event.execution_id, execution_id)
        self.assertEqual(event.trade_decision_id, trade_decision_id)
        self.assertEqual(
            event.raw_event["_torghut_account_label_alias"],
            {
                "source_account_label": "PA3SX7FYNUTF",
                "canonical_account_label": "TORGHUT_SIM",
                "basis": "matched_order_identity",
            },
        )
        self.assertEqual(source_window.unlinked_execution_count, 0)
        self.assertEqual(source_window.unlinked_decision_count, 0)
        self.assertEqual(
            source_window.payload_json["account_label_alias"],
            {
                "source_account_label": "PA3SX7FYNUTF",
                "canonical_account_label": "TORGHUT_SIM",
                "basis": "matched_order_identity",
            },
        )
        self.assertTrue(source_window.payload_json["source_coverage_complete"])
        self.assertFalse(source_window.payload_json["promotion_authority_eligible"])

    def test_repair_order_feed_execution_links_prioritizes_recent_account_alias_event(
        self,
    ) -> None:
        with Session(self.engine) as session:
            old_unmatchable_event = ExecutionOrderEvent(
                event_fingerprint="repair-old-broker-account-unmatchable-fill",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=331,
                alpaca_account_label="PA3SX7FYNUTF",
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id="old-broker-missing-order",
                client_order_id="old-broker-missing-client",
                event_type="fill",
                status="filled",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("191.25"),
                raw_event={"event": "fill"},
            )
            execution = self._seed_execution(
                session,
                account_label="TORGHUT_SIM",
                order_id="new-sim-alias-order",
                client_order_id="new-sim-alias-client",
            )
            execution_id = execution.id
            trade_decision_id = execution.trade_decision_id
            linkable_event = ExecutionOrderEvent(
                event_fingerprint="repair-new-broker-account-linkable-fill",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=332,
                alpaca_account_label="PA3SX7FYNUTF",
                event_ts=datetime(2026, 2, 1, 10, 1, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id="new-sim-alias-order",
                client_order_id="new-sim-alias-client",
                event_type="fill",
                status="filled",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("191.25"),
                raw_event={"event": "fill"},
            )
            session.add_all([old_unmatchable_event, linkable_event])
            session.commit()

            result = repair_order_feed_execution_links(
                session,
                account_label="PA3SX7FYNUTF",
                canonical_account_label="TORGHUT_SIM",
                limit=1,
            )
            session.commit()
            session.refresh(old_unmatchable_event)
            session.refresh(linkable_event)

        self.assertEqual(result["selected"], 1)
        self.assertEqual(result["events_linked"], 1)
        self.assertEqual(result["account_alias_events_linked"], 1)
        self.assertIsNone(old_unmatchable_event.execution_id)
        self.assertIsNone(old_unmatchable_event.trade_decision_id)
        self.assertEqual(
            order_feed_module._order_event_linkage_blockers(old_unmatchable_event),
            [],
        )
        self.assertEqual(linkable_event.alpaca_account_label, "PA3SX7FYNUTF")
        self.assertEqual(linkable_event.execution_id, execution_id)
        self.assertEqual(linkable_event.trade_decision_id, trade_decision_id)
        self.assertEqual(
            linkable_event.raw_event["_torghut_account_label_alias"],
            {
                "source_account_label": "PA3SX7FYNUTF",
                "canonical_account_label": "TORGHUT_SIM",
                "basis": "matched_order_identity",
            },
        )

    def test_linkage_helpers_preserve_actionable_blocker_classifications(
        self,
    ) -> None:
        non_mapping = order_feed_module._raw_event_with_linkage_blockers(
            "raw-event",
            ["missing_execution", "", "missing_execution"],
        )
        self.assertEqual(
            non_mapping,
            {
                "payload": "raw-event",
                "_torghut_linkage": {
                    "blockers": ["missing_execution"],
                    "classification": "missing_execution",
                },
            },
        )
        event = ExecutionOrderEvent(
            event_fingerprint="account-alias-helper-edge",
            source_topic="torghut.trade-updates.v1",
            source_partition=0,
            source_offset=399,
            alpaca_account_label="paper",
            event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
            symbol="AAPL",
            raw_event="raw-event",
        )
        self.assertIsNone(order_feed_module._order_event_account_label_alias(event))

        event.raw_event = {
            "_torghut_account_label_alias": {"source_account_label": "PA3SX7FYNUTF"}
        }
        self.assertIsNone(order_feed_module._order_event_account_label_alias(event))

        order_feed_module._mark_order_event_account_alias(
            event,
            source_account_label="PA3SX7FYNUTF",
            canonical_account_label="TORGHUT_SIM",
            basis="matched_order_identity",
        )
        self.assertEqual(
            event.raw_event,
            {
                "_torghut_account_label_alias": {
                    "source_account_label": "PA3SX7FYNUTF",
                    "canonical_account_label": "TORGHUT_SIM",
                    "basis": "matched_order_identity",
                }
            },
        )

        event.raw_event = "raw-event"
        order_feed_module._mark_order_event_account_alias(
            event,
            source_account_label="PA3SX7FYNUTF",
            canonical_account_label="TORGHUT_SIM",
            basis="matched_order_identity",
        )
        self.assertEqual(event.raw_event["payload"], "raw-event")
        self.assertEqual(
            event.raw_event["_torghut_account_label_alias"],
            {
                "source_account_label": "PA3SX7FYNUTF",
                "canonical_account_label": "TORGHUT_SIM",
                "basis": "matched_order_identity",
            },
        )

        existing = order_feed_module._raw_event_with_linkage_blockers(
            {"event": "fill", "_torghut_linkage": {"source": "previous"}},
            ["ambiguous_execution_identity"],
        )
        self.assertEqual(existing["event"], "fill")
        self.assertEqual(existing["_torghut_linkage"]["source"], "previous")
        self.assertEqual(
            existing["_torghut_linkage"]["blockers"],
            ["ambiguous_execution_identity"],
        )
        self.assertEqual(
            order_feed_module._order_event_linkage_blockers(
                ExecutionOrderEvent(raw_event="raw-event")
            ),
            [],
        )
        self.assertEqual(
            order_feed_module._order_event_linkage_blockers(
                ExecutionOrderEvent(
                    raw_event={"_torghut_linkage": {"blockers": "single_blocker"}}
                )
            ),
            ["single_blocker"],
        )
        self.assertEqual(
            order_feed_module._order_event_linkage_blockers(
                ExecutionOrderEvent(raw_event={"_torghut_linkage": {"blockers": 0}})
            ),
            [],
        )
        self.assertIsNone(
            order_feed_module._order_event_client_identity(
                ExecutionOrderEvent(raw_event="raw-event")
            )
        )
        self.assertEqual(
            order_feed_module._order_event_client_identity(
                ExecutionOrderEvent(
                    raw_event={
                        "order": {
                            "executionIdempotencyKey": "execution-idempotency-key-1"
                        }
                    }
                )
            ),
            "execution-idempotency-key-1",
        )

    def test_repair_order_feed_execution_links_blocks_account_mismatch(
        self,
    ) -> None:
        with Session(self.engine) as session:
            self._seed_execution(session, account_label="paper")
            source_window = OrderFeedSourceWindow(
                consumer_group="torghut-order-feed-v1",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                alpaca_account_label="PA3SX7FYNUTF",
                assignment_mode="group",
                source_revision=ORDER_FEED_SOURCE_REVISION,
                window_started_at=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                window_ended_at=datetime(2026, 2, 1, 10, 1, tzinfo=timezone.utc),
                start_offset=330,
                end_offset=330,
                consumed_count=1,
                inserted_count=1,
                unlinked_execution_count=1,
                unlinked_decision_count=1,
                status="inserted",
                status_reason="missing_execution_and_decision_links",
            )
            session.add(source_window)
            session.flush()
            event = ExecutionOrderEvent(
                event_fingerprint="repair-account-mismatch",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=330,
                alpaca_account_label="PA3SX7FYNUTF",
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id="order-1",
                client_order_id="client-1",
                event_type="fill",
                status="filled",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("191.25"),
                raw_event={"event": "fill"},
                source_window_id=source_window.id,
            )
            session.add(event)
            session.commit()

            result = repair_order_feed_execution_links(
                session,
                account_label="PA3SX7FYNUTF",
                limit=10,
            )
            session.commit()
            session.refresh(event)
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()

        self.assertEqual(result["events_linked"], 0)
        self.assertIsNone(event.execution_id)
        self.assertIsNone(event.trade_decision_id)
        self.assertEqual(source_window.unlinked_execution_count, 1)
        self.assertEqual(source_window.unlinked_decision_count, 1)
        self.assertEqual(
            source_window.status_reason,
            "account_mismatch_execution_identity",
        )
        self.assertEqual(
            source_window.payload_json["linkage_blockers"],
            ["account_mismatch_execution_identity"],
        )
        self.assertFalse(source_window.payload_json["promotion_authority_eligible"])

    def test_repair_order_feed_execution_links_blocks_ambiguous_identity(
        self,
    ) -> None:
        with Session(self.engine) as session:
            first = self._seed_execution(
                session,
                order_id="ambiguous-alpaca-order",
                client_order_id="first-client",
            )
            second = self._seed_execution(
                session,
                order_id="second-alpaca-order",
                client_order_id="ambiguous-client",
            )
            source_window = OrderFeedSourceWindow(
                consumer_group="torghut-order-feed-v1",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                alpaca_account_label="paper",
                assignment_mode="group",
                source_revision=ORDER_FEED_SOURCE_REVISION,
                window_started_at=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                window_ended_at=datetime(2026, 2, 1, 10, 1, tzinfo=timezone.utc),
                start_offset=331,
                end_offset=331,
                consumed_count=1,
                inserted_count=1,
                unlinked_execution_count=1,
                unlinked_decision_count=1,
                status="inserted",
                status_reason="missing_execution_and_decision_links",
            )
            session.add(source_window)
            session.flush()
            event = ExecutionOrderEvent(
                event_fingerprint="repair-ambiguous-identity",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=331,
                alpaca_account_label="paper",
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id=first.alpaca_order_id,
                client_order_id=second.client_order_id,
                event_type="fill",
                status="filled",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("191.25"),
                raw_event={"event": "fill"},
                source_window_id=source_window.id,
            )
            session.add(event)
            session.commit()

            result = repair_order_feed_execution_links(
                session,
                account_label="paper",
                limit=10,
            )
            session.commit()
            session.refresh(event)
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()

        self.assertEqual(result["events_linked"], 0)
        self.assertIsNone(event.execution_id)
        self.assertIsNone(event.trade_decision_id)
        self.assertEqual(source_window.unlinked_execution_count, 1)
        self.assertEqual(source_window.unlinked_decision_count, 1)
        self.assertEqual(source_window.status_reason, "ambiguous_execution_identity")
        self.assertEqual(
            source_window.payload_json["linkage_blockers"],
            ["ambiguous_execution_identity"],
        )
        self.assertFalse(source_window.payload_json["source_coverage_complete"])
