from __future__ import annotations

from tests.order_feed.support import (
    Decimal,
    EXECUTION_RAW_ORDER_SOURCE_WINDOW_REVISION,
    ExecutionLinkageResolution,
    ExecutionOrderEvent,
    NormalizedOrderEvent,
    ORDER_FEED_SOURCE_REVISION,
    OrderFeedSourceWindow,
    OrderFeedTestCase,
    Session,
    Strategy,
    TradeDecision,
    backfill_order_feed_events_from_executions,
    datetime,
    dedupe,
    func,
    latest_order_event_for_execution,
    link_order_events_to_execution,
    order_event_client_identity,
    order_event_linkage_blockers,
    patch,
    persist_order_event,
    raw_event_with_linkage_blockers,
    repair_order_feed_execution_links,
    resolve_execution_linkage_for_identity,
    resolve_trade_decision_linkage_for_identity,
    select,
    timezone,
)


class TestOrderFeedRepairLinksB(OrderFeedTestCase):
    def test_repair_order_feed_execution_links_links_matching_decision_without_execution(
        self,
    ) -> None:
        with Session(self.engine) as session:
            strategy = Strategy(
                name="decision-only-demo",
                description="decision-only-demo",
                enabled=True,
                base_timeframe="1Min",
                universe_type="symbols_list",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.flush()
            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="TORGHUT_SIM",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={"side": "buy"},
                decision_hash="decision-only-client-1",
                status="submitted",
            )
            session.add(decision)
            session.flush()
            decision_id = decision.id
            event = ExecutionOrderEvent(
                event_fingerprint="repair-decision-only-fill",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=388,
                alpaca_account_label="TORGHUT_SIM",
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id="missing-execution-order",
                client_order_id="decision-only-client-1",
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
                account_label="TORGHUT_SIM",
                limit=10,
            )
            session.commit()
            session.refresh(event)
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()

        self.assertEqual(
            result,
            {
                "selected": 1,
                "executions_matched": 0,
                "executions_linked": 0,
                "decisions_matched": 1,
                "events_linked": 0,
                "decision_events_linked": 1,
                "events_without_execution": 1,
                "events_without_decision": 0,
                "account_alias_events_linked": 0,
            },
        )
        self.assertIsNone(event.execution_id)
        self.assertEqual(event.trade_decision_id, decision_id)
        self.assertEqual(event.source_window_id, source_window.id)
        self.assertEqual(source_window.unlinked_execution_count, 1)
        self.assertEqual(source_window.unlinked_decision_count, 0)
        self.assertFalse(source_window.payload_json["source_coverage_complete"])
        self.assertEqual(
            source_window.payload_json["linked_refs"],
            {
                "execution_order_event_id": str(event.id),
                "execution_id": None,
                "trade_decision_id": str(decision_id),
            },
        )
        self.assertEqual(
            source_window.payload_json["authority_class"],
            "order_feed_lifecycle_unlinked",
        )

    def test_repair_order_feed_execution_links_resolves_decision_account_alias_without_execution(
        self,
    ) -> None:
        with Session(self.engine) as session:
            strategy = Strategy(
                name="decision-alias-demo",
                description="decision-alias-demo",
                enabled=True,
                base_timeframe="1Min",
                universe_type="symbols_list",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.flush()
            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="TORGHUT_SIM",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={"side": "buy"},
                decision_hash="decision-alias-client-1",
                status="submitted",
            )
            session.add(decision)
            session.flush()
            decision_id = decision.id
            source_window = OrderFeedSourceWindow(
                consumer_group="torghut-order-feed-v1",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                alpaca_account_label="PA3SX7FYNUTF",
                assignment_mode="group",
                source_revision=ORDER_FEED_SOURCE_REVISION,
                window_started_at=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                window_ended_at=datetime(2026, 2, 1, 10, 1, tzinfo=timezone.utc),
                start_offset=389,
                end_offset=389,
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
                event_fingerprint="repair-decision-alias-only-fill",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=389,
                alpaca_account_label="PA3SX7FYNUTF",
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id="missing-execution-order",
                client_order_id="decision-alias-client-1",
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

        self.assertEqual(
            result,
            {
                "selected": 1,
                "executions_matched": 0,
                "executions_linked": 0,
                "decisions_matched": 1,
                "events_linked": 0,
                "decision_events_linked": 1,
                "events_without_execution": 1,
                "events_without_decision": 0,
                "account_alias_events_linked": 1,
            },
        )
        self.assertIsNone(event.execution_id)
        self.assertEqual(event.trade_decision_id, decision_id)
        self.assertEqual(
            event.raw_event["_torghut_account_label_alias"],
            {
                "source_account_label": "PA3SX7FYNUTF",
                "canonical_account_label": "TORGHUT_SIM",
                "basis": "matched_order_identity",
            },
        )
        self.assertEqual(source_window.unlinked_execution_count, 1)
        self.assertEqual(source_window.unlinked_decision_count, 0)
        self.assertEqual(
            source_window.payload_json["account_label_alias"],
            {
                "source_account_label": "PA3SX7FYNUTF",
                "canonical_account_label": "TORGHUT_SIM",
                "basis": "matched_order_identity",
            },
        )
        self.assertFalse(source_window.payload_json["source_coverage_complete"])

    def test_repair_order_feed_execution_links_counts_missing_decision_identity(
        self,
    ) -> None:
        with Session(self.engine) as session:
            event = ExecutionOrderEvent(
                event_fingerprint="repair-missing-decision-identity",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=389,
                alpaca_account_label="TORGHUT_SIM",
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id="missing-execution-order-no-client",
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
                account_label="TORGHUT_SIM",
                limit=10,
            )

        self.assertEqual(result["selected"], 1)
        self.assertEqual(result["decision_events_linked"], 0)
        self.assertEqual(result["events_without_execution"], 1)
        self.assertEqual(result["events_without_decision"], 1)

    def test_repair_order_feed_execution_links_marks_existing_decision_missing_execution(
        self,
    ) -> None:
        with Session(self.engine) as session:
            strategy = Strategy(
                name="existing-decision-missing-execution",
                description="existing-decision-missing-execution",
                enabled=True,
                base_timeframe="1Min",
                universe_type="symbols_list",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.flush()
            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="TORGHUT_SIM",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={"side": "buy"},
                decision_hash="existing-decision-client",
                status="submitted",
            )
            session.add(decision)
            session.flush()
            decision_id = decision.id
            event = ExecutionOrderEvent(
                event_fingerprint="repair-existing-decision-missing-execution",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=390,
                alpaca_account_label="TORGHUT_SIM",
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id="missing-execution-existing-decision-order",
                client_order_id="existing-decision-client",
                event_type="fill",
                status="filled",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("191.25"),
                raw_event={"event": "fill"},
                trade_decision_id=decision_id,
            )
            session.add(event)
            session.commit()

            result = repair_order_feed_execution_links(
                session,
                account_label="TORGHUT_SIM",
                limit=10,
            )
            session.commit()
            session.refresh(event)
            source_window = session.get(OrderFeedSourceWindow, event.source_window_id)

        self.assertEqual(
            result,
            {
                "selected": 1,
                "executions_matched": 0,
                "executions_linked": 0,
                "decisions_matched": 0,
                "events_linked": 0,
                "decision_events_linked": 0,
                "events_without_execution": 1,
                "events_without_decision": 0,
                "account_alias_events_linked": 0,
            },
        )
        self.assertIsNone(event.execution_id)
        self.assertEqual(event.trade_decision_id, decision_id)
        self.assertEqual(
            order_event_linkage_blockers(event),
            ["missing_execution_link"],
        )
        assert source_window is not None
        self.assertEqual(source_window.unlinked_execution_count, 1)
        self.assertEqual(source_window.unlinked_decision_count, 0)
        self.assertFalse(source_window.payload_json["source_coverage_complete"])

    def test_repair_order_feed_execution_links_marks_missing_links_to_advance_scan(
        self,
    ) -> None:
        with Session(self.engine) as session:
            old_unmatchable_event = ExecutionOrderEvent(
                event_fingerprint="repair-old-unmatchable-fill",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=390,
                alpaca_account_label="TORGHUT_SIM",
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id="old-missing-order",
                client_order_id="old-missing-client",
                event_type="fill",
                status="filled",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("191.25"),
                raw_event={"event": "fill"},
            )
            execution = self._seed_execution(
                session,
                account_label="TORGHUT_SIM",
                order_id="new-linkable-order",
                client_order_id="new-linkable-client",
            )
            execution_id = execution.id
            trade_decision_id = execution.trade_decision_id
            linkable_event = ExecutionOrderEvent(
                event_fingerprint="repair-new-linkable-fill",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=391,
                alpaca_account_label="TORGHUT_SIM",
                event_ts=datetime(2026, 2, 1, 10, 1, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id="new-linkable-order",
                client_order_id="new-linkable-client",
                event_type="fill",
                status="filled",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("191.25"),
                raw_event={"event": "fill"},
            )
            session.add_all([old_unmatchable_event, linkable_event])
            session.commit()

            first_result = repair_order_feed_execution_links(
                session,
                account_label="TORGHUT_SIM",
                limit=1,
            )
            second_result = repair_order_feed_execution_links(
                session,
                account_label="TORGHUT_SIM",
                limit=1,
            )
            session.commit()
            session.refresh(old_unmatchable_event)
            session.refresh(linkable_event)

        self.assertEqual(first_result["events_without_execution"], 1)
        self.assertEqual(second_result["events_linked"], 1)
        self.assertIsNone(old_unmatchable_event.execution_id)
        self.assertIsNone(old_unmatchable_event.trade_decision_id)
        self.assertEqual(
            order_event_linkage_blockers(old_unmatchable_event),
            ["missing_execution_link", "missing_trade_decision_link"],
        )
        self.assertEqual(linkable_event.execution_id, execution_id)
        self.assertEqual(linkable_event.trade_decision_id, trade_decision_id)

    def test_linkage_payload_helpers_cover_fallback_shapes(self) -> None:
        wrapped = raw_event_with_linkage_blockers(
            ["raw-list"],
            ["missing_execution_link", "missing_execution_link", " "],
        )
        self.assertEqual(wrapped["payload"], ["raw-list"])
        self.assertEqual(
            wrapped["_torghut_linkage"]["blockers"], ["missing_execution_link"]
        )

        merged = raw_event_with_linkage_blockers(
            {"_torghut_linkage": {"existing": "kept"}},
            ["missing_trade_decision_link"],
        )
        self.assertEqual(merged["_torghut_linkage"]["existing"], "kept")
        self.assertEqual(
            merged["_torghut_linkage"]["classification"],
            "missing_trade_decision_link",
        )

        cleared = raw_event_with_linkage_blockers(
            {"_torghut_linkage": {"blockers": ["old"]}},
            [],
        )
        self.assertNotIn("_torghut_linkage", cleared)

        self.assertEqual(
            order_event_linkage_blockers(
                ExecutionOrderEvent(raw_event=["not-a-mapping"])
            ),
            [],
        )
        self.assertEqual(
            order_event_linkage_blockers(
                ExecutionOrderEvent(
                    raw_event={"_torghut_linkage": {"blockers": "single-blocker"}}
                )
            ),
            ["single-blocker"],
        )
        self.assertEqual(
            order_event_linkage_blockers(
                ExecutionOrderEvent(raw_event={"_torghut_linkage": {"blockers": 7}})
            ),
            [],
        )
        self.assertIsNone(
            order_event_client_identity(
                ExecutionOrderEvent(raw_event=["not-a-mapping"])
            )
        )
        self.assertEqual(
            order_event_client_identity(
                ExecutionOrderEvent(
                    raw_event={"order": {"idempotencyKey": "idem-client"}}
                )
            ),
            "idem-client",
        )
        self.assertEqual(
            dedupe(["a", "", "a", " b ", "b"]),
            ["a", "b"],
        )

    def test_persist_order_event_links_trade_decision_without_execution(self) -> None:
        with Session(self.engine) as session:
            strategy = Strategy(
                name="decision-only-persist",
                description="decision-only-persist",
                enabled=True,
                base_timeframe="1Min",
                universe_type="symbols_list",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.flush()
            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={"side": "buy"},
                decision_hash="decision-only-persist-client",
                status="submitted",
            )
            session.add(decision)
            session.flush()
            decision_id = decision.id

            persisted, duplicate = persist_order_event(
                session,
                NormalizedOrderEvent(
                    event_fingerprint="decision-only-persist-event",
                    source_topic="torghut.trade-updates.v1",
                    source_partition=0,
                    source_offset=410,
                    alpaca_account_label="paper",
                    feed_seq=410,
                    event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                    symbol="AAPL",
                    alpaca_order_id="missing-execution-order",
                    client_order_id="decision-only-persist-client",
                    execution_correlation_id=None,
                    event_type="fill",
                    status="filled",
                    qty=Decimal("1"),
                    filled_qty=Decimal("1"),
                    filled_qty_delta=None,
                    avg_fill_price=Decimal("190"),
                    filled_notional_delta=None,
                    fill_quantity_basis=None,
                    raw_event={"event": "fill"},
                ),
            )

        self.assertFalse(duplicate)
        self.assertIsNone(persisted.execution_id)
        self.assertEqual(persisted.trade_decision_id, decision_id)

    def test_latest_order_event_for_execution_uses_idempotency_key_identity(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(
                session,
                execution_idempotency_key="exec-idem-1",
            )
            event = ExecutionOrderEvent(
                event_fingerprint="latest-idempotency-event",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=411,
                alpaca_account_label="paper",
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id="different-order",
                client_order_id="exec-idem-1",
                event_type="fill",
                status="filled",
                raw_event={"event": "fill"},
            )
            session.add(event)
            session.commit()

            latest = latest_order_event_for_execution(session, execution)

        self.assertIsNotNone(latest)
        assert latest is not None
        self.assertEqual(latest.event_fingerprint, "latest-idempotency-event")

    def test_link_order_events_to_execution_records_blockers_and_skips_mismatches(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(
                session,
                order_id="link-target-order",
                client_order_id="link-target-client",
            )
            other_execution = self._seed_execution(
                session,
                order_id="link-other-order",
                client_order_id="link-other-client",
            )
            ambiguous_event = ExecutionOrderEvent(
                event_fingerprint="link-ambiguous-event",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=412,
                alpaca_account_label="paper",
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id=execution.alpaca_order_id,
                client_order_id=other_execution.client_order_id,
                event_type="fill",
                status="filled",
                raw_event={"event": "fill"},
            )
            skip_event = ExecutionOrderEvent(
                event_fingerprint="link-skip-event",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=413,
                alpaca_account_label="paper",
                event_ts=datetime(2026, 2, 1, 10, 1, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id=execution.alpaca_order_id,
                client_order_id=execution.client_order_id,
                event_type="fill",
                status="filled",
                raw_event={"event": "fill"},
            )
            session.add_all([ambiguous_event, skip_event])
            session.commit()

            ambiguous_count = link_order_events_to_execution(
                session, execution, limit=1
            )
            session.commit()
            session.refresh(ambiguous_event)
            with patch(
                "app.trading.order_feed.normalize_order_feed_record._resolve_execution_linkage_for_identity",
                return_value=ExecutionLinkageResolution(
                    execution=other_execution,
                ),
            ):
                skipped_count = link_order_events_to_execution(
                    session, execution, limit=1
                )

        self.assertEqual(ambiguous_count, 0)
        self.assertEqual(skipped_count, 0)
        self.assertEqual(
            order_event_linkage_blockers(ambiguous_event),
            ["ambiguous_execution_identity"],
        )

    def test_link_order_events_to_execution_records_missing_decision_blockers(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(
                session,
                order_id="missing-decision-order",
                client_order_id="missing-decision-client",
            )
            execution.trade_decision_id = None
            event = ExecutionOrderEvent(
                event_fingerprint="missing-decision-link-event",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=414,
                alpaca_account_label="paper",
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id=execution.alpaca_order_id,
                client_order_id=None,
                event_type="fill",
                status="filled",
                raw_event={"event": "fill"},
            )
            session.add(event)
            session.commit()

            linked_count = link_order_events_to_execution(session, execution)
            session.commit()
            session.refresh(event)

        self.assertEqual(linked_count, 1)
        self.assertEqual(
            order_event_linkage_blockers(event),
            ["order_feed_trade_decision_identity_missing"],
        )

    def test_identity_resolution_reports_missing_and_account_mismatch_refs(
        self,
    ) -> None:
        with Session(self.engine) as session:
            missing_execution = resolve_execution_linkage_for_identity(
                session,
                account_label="paper",
                alpaca_order_id=None,
                client_order_id=None,
            )

            strategy = Strategy(
                name="ambiguous-decision",
                description="ambiguous-decision",
                enabled=True,
                base_timeframe="1Min",
                universe_type="symbols_list",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.flush()
            session.add_all(
                [
                    TradeDecision(
                        strategy_id=strategy.id,
                        alpaca_account_label="other-paper",
                        symbol="AAPL",
                        timeframe="1Min",
                        decision_json={"side": "buy"},
                        decision_hash="account-mismatch-decision-client",
                        status="submitted",
                    ),
                ]
            )
            session.commit()

            account_mismatch_decision = resolve_trade_decision_linkage_for_identity(
                session,
                account_label="paper",
                client_order_id="account-mismatch-decision-client",
            )

        self.assertEqual(
            missing_execution.blockers,
            ("order_feed_execution_identity_missing",),
        )
        self.assertEqual(
            account_mismatch_decision.blockers,
            ("account_mismatch_trade_decision_identity",),
        )

    def test_repair_order_feed_execution_links_limits_matching_execution_fanout(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            events = [
                ExecutionOrderEvent(
                    event_fingerprint=f"repair-fanout-fill-{index}",
                    source_topic="torghut.trade-updates.v1",
                    source_partition=0,
                    source_offset=400 + index,
                    alpaca_account_label="paper",
                    event_ts=datetime(2026, 2, 1, 10, index, tzinfo=timezone.utc),
                    symbol="AAPL",
                    alpaca_order_id=execution.alpaca_order_id,
                    client_order_id=execution.client_order_id,
                    event_type="fill",
                    status="filled",
                    filled_qty=Decimal("1"),
                    avg_fill_price=Decimal("191.25"),
                    raw_event={"event": "fill"},
                )
                for index in range(5)
            ]
            session.add_all(events)
            session.commit()

            first_result = repair_order_feed_execution_links(
                session,
                account_label="paper",
                limit=2,
            )
            session.commit()
            second_result = repair_order_feed_execution_links(
                session,
                account_label="paper",
                limit=2,
            )
            session.commit()
            linked_count = session.scalar(
                select(func.count(ExecutionOrderEvent.id)).where(
                    ExecutionOrderEvent.execution_id == execution.id
                )
            )

        self.assertEqual(first_result["events_linked"], 2)
        self.assertEqual(second_result["events_linked"], 2)
        self.assertEqual(linked_count, 4)

    def test_backfill_order_feed_events_from_executions_links_live_account_source(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(
                session,
                account_label="PA3SX7FYNUTF",
                order_id="live-order-1",
                client_order_id="live-client-1",
            )
            execution.status = "filled"
            execution.filled_qty = Decimal("1")
            execution.avg_fill_price = Decimal("191.25")
            execution.raw_order = {
                "id": "live-order-1",
                "client_order_id": "live-client-1",
                "status": "filled",
            }
            execution_id = execution.id
            trade_decision_id = execution.trade_decision_id
            session.add(execution)
            session.commit()

            result = backfill_order_feed_events_from_executions(
                session,
                account_label="PA3SX7FYNUTF",
                limit=10,
            )
            session.commit()
            event = session.execute(select(ExecutionOrderEvent)).scalar_one()
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()

        self.assertEqual(
            result,
            {
                "selected": 1,
                "events_created": 1,
                "source_windows_created": 1,
                "skipped_existing_event": 0,
                "skipped_missing_trade_decision": 0,
                "skipped_missing_order_identity": 0,
                "skipped_source_offset_collision": 0,
            },
        )
        self.assertEqual(event.execution_id, execution_id)
        self.assertEqual(event.trade_decision_id, trade_decision_id)
        self.assertEqual(event.source_window_id, source_window.id)
        self.assertEqual(event.alpaca_account_label, "PA3SX7FYNUTF")
        self.assertEqual(event.event_type, "fill")
        self.assertEqual(event.status, "filled")
        self.assertEqual(event.filled_qty, Decimal("1.00000000"))
        self.assertEqual(event.avg_fill_price, Decimal("191.25000000"))
        self.assertIsNotNone(event.source_offset)
        self.assertEqual(
            source_window.source_revision,
            EXECUTION_RAW_ORDER_SOURCE_WINDOW_REVISION,
        )
        self.assertEqual(source_window.status, "inserted")
        self.assertEqual(source_window.payload_json["cursor_authority"], False)
        self.assertEqual(source_window.payload_json["execution_id"], str(execution_id))
        self.assertEqual(source_window.unlinked_execution_count, 0)
        self.assertEqual(source_window.unlinked_decision_count, 0)
