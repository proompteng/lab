from __future__ import annotations

from tests.order_feed.support import (
    Decimal,
    Execution,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    FakeConsumer,
    FakeRecord,
    FakeTigerBeetleClient,
    NormalizedOrderEvent,
    OrderFeedIngestor,
    OrderFeedSourceWindow,
    OrderFeedTestCase,
    RejectedSignalOutcomeEvent,
    SOURCE_TYPE_EXECUTION,
    SOURCE_TYPE_EXECUTION_ORDER_EVENT,
    Session,
    Strategy,
    TRANSFER_KIND_EXECUTION_FILL,
    TRANSFER_KIND_FILL_POST,
    TigerBeetleReconciliationRun,
    TigerBeetleTransferRef,
    TradeDecision,
    apply_order_event_to_execution,
    datetime,
    latest_order_event_for_execution,
    logger,
    merge_execution_raw_order_update,
    normalize_order_feed_record,
    order_identity_matches_account_scope,
    patch,
    persist_order_event,
    select,
    settings,
    timedelta,
    timezone,
)


class TestOrderFeedCore(OrderFeedTestCase):
    def test_runtime_symbol_columns_allow_occ_option_contracts(self) -> None:
        for model in (
            TradeDecision,
            Execution,
            ExecutionOrderEvent,
            RejectedSignalOutcomeEvent,
            ExecutionTCAMetric,
        ):
            symbol_column = model.__table__.c.symbol
            self.assertEqual(
                symbol_column.type.length,
                64,
                f"{model.__tablename__}.symbol must support OCC option symbols",
            )

    def test_option_order_feed_symbol_persists_full_occ_symbol(self) -> None:
        option_symbol = "AMZN260529P00270000"
        self.assertGreater(len(option_symbol), 16)
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"option-order-1","client_order_id":"option-client-1",'
            b'"symbol":"AMZN260529P00270000","status":"filled","qty":"1","filled_qty":"1",'
            b'"filled_avg_price":"2.15"}},"seq":10}'
        )
        record = FakeRecord(value=payload, offset=55)

        with Session(self.engine) as session:
            normalized = normalize_order_feed_record(
                record,
                default_topic="torghut.trade-updates.v1",
                default_account_label="paper",
            )
            assert normalized.event is not None
            self.assertEqual(normalized.event.symbol, option_symbol)

            persisted, is_duplicate = persist_order_event(session, normalized.event)
            session.commit()

            self.assertFalse(is_duplicate)
            self.assertEqual(persisted.symbol, option_symbol)

    def test_fill_persists_broker_position_quantity(self) -> None:
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"partial_fill",'
            b'"position_qty":"0.00003","timestamp":"2026-07-15T12:00:00Z",'
            b'"order":{"id":"crypto-order-1","client_order_id":"crypto-client-1",'
            b'"symbol":"BTC/USD","status":"partially_filled","qty":"0.00004",'
            b'"filled_qty":"0.00003","filled_avg_price":"97000"}},"seq":11}'
        )

        with Session(self.engine) as session:
            normalized = normalize_order_feed_record(
                FakeRecord(value=payload, offset=56),
                default_topic="torghut.trade-updates.v1",
                default_account_label="paper",
            )
            assert normalized.event is not None
            self.assertEqual(normalized.event.position_qty, Decimal("0.00003"))
            replay_without_position = normalize_order_feed_record(
                FakeRecord(
                    value=payload.replace(b'"position_qty":"0.00003",', b""),
                    offset=56,
                ),
                default_topic="torghut.trade-updates.v1",
                default_account_label="paper",
            )
            assert replay_without_position.event is not None
            self.assertIsNone(replay_without_position.event.position_qty)
            self.assertEqual(
                normalized.event.event_fingerprint,
                replay_without_position.event.event_fingerprint,
            )

            persisted, is_duplicate = persist_order_event(session, normalized.event)
            session.commit()

            self.assertFalse(is_duplicate)
            self.assertEqual(persisted.position_qty, Decimal("0.00003000"))

    def test_cross_account_order_feed_normalization_defaults_do_not_crosstalk(
        self,
    ) -> None:
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"order-shared","client_order_id":"client-shared","symbol":"AAPL","status":"filled",'
            b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
        )
        record = FakeRecord(value=payload, offset=22)

        with Session(self.engine) as session:
            paper_a = self._seed_execution(
                session,
                account_label="paper-a",
                order_id="order-shared",
                client_order_id="client-shared",
            )
            paper_b = self._seed_execution(
                session,
                account_label="paper-b",
                order_id="order-2",
                client_order_id="client-b",
            )

            normalized = normalize_order_feed_record(
                record,
                default_topic="torghut.trade-updates.v1",
                default_account_label="paper-b",
            )
            assert normalized.event is not None

            persisted, is_duplicate = persist_order_event(session, normalized.event)
            session.commit()

            self.assertFalse(is_duplicate)
            self.assertEqual(persisted.alpaca_account_label, "paper-b")
            self.assertIsNone(persisted.execution_id)
            self.assertEqual(paper_a.status, "new")
            self.assertEqual(paper_b.status, "new")

    def test_unrelated_account_order_feed_event_stays_unlinked_from_hpairs_decision(
        self,
    ) -> None:
        payload = (
            b'{"channel":"trade_updates","account_label":"UNRELATED_ACCOUNT",'
            b'"payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"hpairs-order-1","client_order_id":"hpairs-client-1",'
            b'"symbol":"AAPL","status":"filled","qty":"1","filled_qty":"1",'
            b'"filled_avg_price":"190.2","alpaca_account_label":"UNRELATED_ACCOUNT"}},'
            b'"seq":11}'
        )
        record = FakeRecord(value=payload, offset=23)

        with Session(self.engine) as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                description="H-PAIRS paper collection",
                enabled=True,
                base_timeframe="1Min",
                universe_type="symbols_list",
                universe_symbols=["AAPL", "AMZN"],
            )
            session.add(strategy)
            session.flush()
            session.add(
                TradeDecision(
                    strategy_id=strategy.id,
                    alpaca_account_label="TORGHUT_SIM",
                    symbol="AAPL",
                    timeframe="1Min",
                    decision_json={
                        "params": {
                            "hypothesis_id": "H-PAIRS-01",
                            "source_decision_mode": "route_acquisition",
                        }
                    },
                    decision_hash="hpairs-client-1",
                    status="submitted",
                )
            )
            session.commit()

            normalized = normalize_order_feed_record(
                record,
                default_topic="torghut.trade-updates.v1",
                default_account_label="TORGHUT_SIM",
            )
            assert normalized.event is not None
            persisted, is_duplicate = persist_order_event(session, normalized.event)
            session.commit()
            persisted_account_label = persisted.alpaca_account_label
            persisted_execution_id = persisted.execution_id
            persisted_trade_decision_id = persisted.trade_decision_id

        self.assertFalse(is_duplicate)
        self.assertEqual(persisted_account_label, "UNRELATED_ACCOUNT")
        self.assertIsNone(persisted_execution_id)
        self.assertIsNone(persisted_trade_decision_id)

    def test_cross_account_ingest_default_account_does_not_update_wrong_execution(
        self,
    ) -> None:
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"order-shared","client_order_id":"client-shared","symbol":"AAPL","status":"filled",'
            b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
        )
        fake_payload_record = FakeRecord(value=payload, offset=22)

        with Session(self.engine) as session:
            self._seed_execution(
                session,
                account_label="paper-a",
                order_id="order-shared",
                client_order_id="client-shared",
            )
            self._seed_execution(
                session,
                account_label="paper-b",
                order_id="order-shared-b",
                client_order_id="client-shared-b",
            )

            ingestor = OrderFeedIngestor(
                consumer_factory=lambda: FakeConsumer([fake_payload_record]),
                default_account_label="paper-b",
            )
            counters = ingestor.ingest_once(session)
            self.assertEqual(counters["messages_total"], 1)
            self.assertEqual(counters["events_persisted_total"], 1)
            self.assertEqual(counters["apply_updates_total"], 0)
            self.assertEqual(counters["duplicates_total"], 0)

            paper_a = session.execute(
                select(Execution).where(
                    Execution.alpaca_account_label == "paper-a",
                    Execution.alpaca_order_id == "order-shared",
                )
            ).scalar_one()
            paper_b = session.execute(
                select(Execution).where(
                    Execution.alpaca_account_label == "paper-b",
                    Execution.alpaca_order_id == "order-shared-b",
                )
            ).scalar_one()
            self.assertEqual(paper_a.status, "new")
            self.assertEqual(paper_b.status, "new")

            events = session.execute(select(ExecutionOrderEvent)).scalars().all()
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0].alpaca_account_label, "paper-b")

    def test_persist_order_event_journals_tigerbeetle_ref_when_enabled(self) -> None:
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
            b'"qty":"1","filled_qty":"1","filled_avg_price":"190.25"}},"seq":10}'
        )
        record = FakeRecord(value=payload, offset=22)
        client = FakeTigerBeetleClient()
        settings.tigerbeetle_enabled = True
        settings.tigerbeetle_journal_enabled = True

        with Session(self.engine) as session:
            self._seed_execution(session)
            normalized = normalize_order_feed_record(
                record,
                default_topic="torghut.trade-updates.v1",
                default_account_label="paper",
            )
            assert normalized.event is not None

            with patch(
                "app.trading.tigerbeetle_journal.ledger_journal.create_tigerbeetle_client",
                return_value=client,
            ):
                persisted, is_duplicate = persist_order_event(
                    session,
                    normalized.event,
                )
                duplicate_row, duplicate = persist_order_event(
                    session,
                    normalized.event,
                )
            session.commit()

            self.assertFalse(is_duplicate)
            self.assertTrue(duplicate)
            self.assertEqual(duplicate_row.id, persisted.id)
            refs = session.execute(select(TigerBeetleTransferRef)).scalars().all()
            self.assertEqual(len(refs), 1)
            self.assertEqual(refs[0].execution_order_event_id, persisted.id)
            self.assertEqual(refs[0].amount, Decimal("190250000"))

    def test_order_feed_ingest_persists_tigerbeetle_reconciliation(self) -> None:
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
            b'"qty":"1","filled_qty":"1","filled_avg_price":"190.25"}},"seq":10}'
        )
        record = FakeRecord(value=payload, offset=22)
        client = FakeTigerBeetleClient()
        settings.tigerbeetle_enabled = True
        settings.tigerbeetle_journal_enabled = True

        with Session(self.engine) as session:
            self._seed_execution(session)
            ingestor = OrderFeedIngestor(
                consumer_factory=lambda: FakeConsumer([record]),
                default_account_label="paper",
            )

            with (
                patch(
                    "app.trading.tigerbeetle_journal.ledger_journal.create_tigerbeetle_client",
                    return_value=client,
                ),
                patch(
                    "app.trading.tigerbeetle_reconcile.latest_tigerbeetle_reconciliation_status_p.create_tigerbeetle_client",
                    return_value=client,
                ),
            ):
                counters = ingestor.ingest_once(session)

            self.assertEqual(counters["events_persisted_total"], 1)
            refs = session.execute(select(TigerBeetleTransferRef)).scalars().all()
            self.assertEqual(len(refs), 2)
            event = session.execute(select(ExecutionOrderEvent)).scalar_one()
            refs_by_kind = {ref.transfer_kind: ref for ref in refs}
            self.assertEqual(
                set(refs_by_kind),
                {TRANSFER_KIND_FILL_POST, TRANSFER_KIND_EXECUTION_FILL},
            )
            order_ref = refs_by_kind[TRANSFER_KIND_FILL_POST]
            self.assertEqual(order_ref.execution_order_event_id, event.id)
            self.assertEqual(order_ref.source_type, SOURCE_TYPE_EXECUTION_ORDER_EVENT)
            self.assertEqual(order_ref.source_id, str(event.id))
            execution_ref = refs_by_kind[TRANSFER_KIND_EXECUTION_FILL]
            self.assertEqual(execution_ref.execution_id, event.execution_id)
            self.assertEqual(execution_ref.source_type, SOURCE_TYPE_EXECUTION)
            self.assertEqual(execution_ref.source_id, str(event.execution_id))
            runs = session.execute(select(TigerBeetleReconciliationRun)).scalars().all()
            self.assertEqual(len(runs), 1)
            self.assertEqual(runs[0].status, "ok")

    def test_order_feed_event_survives_optional_reconciliation_rollback(self) -> None:
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
            b'"qty":"1","filled_qty":"1","filled_avg_price":"190.25"}},"seq":10}'
        )
        record = FakeRecord(value=payload, offset=22)
        client = FakeTigerBeetleClient()
        settings.tigerbeetle_enabled = True
        settings.tigerbeetle_journal_enabled = True

        with Session(self.engine) as session:
            self._seed_execution(session)
            ingestor = OrderFeedIngestor(
                consumer_factory=lambda: FakeConsumer([record]),
                default_account_label="paper",
            )

            def fail_reconciliation(reconciliation_session: Session) -> None:
                # Model a failed PostgreSQL transaction from the optional audit.
                # The already-committed broker event must not be rolled back with it.
                reconciliation_session.rollback()
                raise RuntimeError("reconcile failed")

            with (
                patch(
                    "app.trading.tigerbeetle_journal.ledger_journal.create_tigerbeetle_client",
                    return_value=client,
                ),
                patch(
                    "app.trading.order_feed.shared_context.reconcile_tigerbeetle_transfers",
                    side_effect=fail_reconciliation,
                ),
                self.assertLogs(logger, level="WARNING"),
            ):
                counters = ingestor.ingest_once(session)

            self.assertEqual(counters["events_persisted_total"], 1)
            event = session.execute(select(ExecutionOrderEvent)).scalar_one()
            self.assertEqual(event.alpaca_order_id, "order-1")
            self.assertTrue(session.is_active)

    def test_order_feed_reconciliation_failure_respects_required_flag(self) -> None:
        settings.tigerbeetle_enabled = True
        settings.tigerbeetle_journal_enabled = True

        with Session(self.engine) as session:
            ingestor = OrderFeedIngestor(
                consumer_factory=lambda: FakeConsumer([]),
                default_account_label="paper",
            )
            with (
                patch(
                    (
                        "app.trading.order_feed.shared_context"
                        ".reconcile_tigerbeetle_transfers"
                    ),
                    side_effect=RuntimeError("reconcile failed"),
                ),
                patch.object(session, "rollback", wraps=session.rollback) as rollback,
            ):
                with self.assertLogs(logger, level="WARNING"):
                    ingestor._reconcile_tigerbeetle_if_enabled(session)
                self.assertEqual(rollback.call_count, 1)

                settings.tigerbeetle_reconcile_required = True
                with self.assertRaisesRegex(RuntimeError, "reconcile failed"):
                    ingestor._reconcile_tigerbeetle_if_enabled(session)
                self.assertEqual(rollback.call_count, 2)

    def test_order_feed_runs_reconciliation_while_feed_is_idle(self) -> None:
        settings.tigerbeetle_enabled = True
        settings.tigerbeetle_journal_enabled = True

        with Session(self.engine) as session:
            ingestor = OrderFeedIngestor(
                consumer_factory=lambda: FakeConsumer([]),
                default_account_label="paper",
            )
            with patch(
                (
                    "app.trading.order_feed.shared_context"
                    ".reconcile_tigerbeetle_transfers"
                ),
                return_value={"ok": True},
            ) as reconcile:
                ingestor.ingest_once(session)
                ingestor.ingest_once(session)

        self.assertEqual(reconcile.call_count, 1)

    def test_optional_tigerbeetle_journal_failure_does_not_drop_order_event(
        self,
    ) -> None:
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
            b'"qty":"1","filled_qty":"1","filled_avg_price":"190.25"}},"seq":10}'
        )
        record = FakeRecord(value=payload, offset=22)
        settings.tigerbeetle_enabled = True
        settings.tigerbeetle_journal_enabled = True
        settings.tigerbeetle_required = False

        with Session(self.engine) as session:
            self._seed_execution(session)
            normalized = normalize_order_feed_record(
                record,
                default_topic="torghut.trade-updates.v1",
                default_account_label="paper",
            )
            assert normalized.event is not None

            with patch(
                "app.trading.tigerbeetle_journal.ledger_journal.create_tigerbeetle_client",
                side_effect=RuntimeError("tb unavailable"),
            ):
                persisted, is_duplicate = persist_order_event(
                    session,
                    normalized.event,
                )
            session.commit()

            self.assertFalse(is_duplicate)
            self.assertIsNotNone(persisted.id)
            refs = session.execute(select(TigerBeetleTransferRef)).scalars().all()
            self.assertEqual(refs, [])

    def test_required_tigerbeetle_journal_failure_blocks_order_event(self) -> None:
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
            b'"qty":"1","filled_qty":"1","filled_avg_price":"190.25"}},"seq":10}'
        )
        record = FakeRecord(value=payload, offset=22)
        settings.tigerbeetle_enabled = True
        settings.tigerbeetle_journal_enabled = True
        settings.tigerbeetle_required = True

        with Session(self.engine) as session:
            self._seed_execution(session)
            normalized = normalize_order_feed_record(
                record,
                default_topic="torghut.trade-updates.v1",
                default_account_label="paper",
            )
            assert normalized.event is not None

            with patch(
                "app.trading.tigerbeetle_journal.ledger_journal.create_tigerbeetle_client",
                side_effect=RuntimeError("tb unavailable"),
            ):
                with self.assertRaisesRegex(RuntimeError, "tb unavailable"):
                    persist_order_event(session, normalized.event)
            session.rollback()
            self.assertEqual(
                session.execute(select(ExecutionOrderEvent)).scalars().all(),
                [],
            )
            self.assertEqual(
                session.execute(select(TigerBeetleTransferRef)).scalars().all(),
                [],
            )

    def test_duplicate_event_is_idempotent(self) -> None:
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
            b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
        )
        record = FakeRecord(value=payload, offset=12)

        with Session(self.engine) as session:
            self._seed_execution(session)
            normalized = normalize_order_feed_record(
                record,
                default_topic="torghut.trade-updates.v1",
                default_account_label="paper",
            )
            assert normalized.event is not None
            self.assertEqual(normalized.event.alpaca_account_label, "paper")

            first, first_dup = persist_order_event(session, normalized.event)
            second, second_dup = persist_order_event(session, normalized.event)
            session.commit()

            self.assertFalse(first_dup)
            self.assertTrue(second_dup)
            self.assertEqual(first.id, second.id)
            rows = session.execute(select(ExecutionOrderEvent)).scalars().all()
            self.assertEqual(len(rows), 1)

    def test_ingestor_counts_duplicate_events(self) -> None:
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
            b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
        )
        record = FakeRecord(value=payload, offset=12)
        consumer = FakeConsumer([record, record])
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            self._seed_execution(session)
            counters = ingestor.ingest_once(session)
            rows = session.execute(select(ExecutionOrderEvent)).scalars().all()

        self.assertEqual(counters["messages_total"], 2)
        self.assertEqual(counters["events_persisted_total"], 1)
        self.assertEqual(counters["duplicates_total"], 1)
        self.assertEqual(len(rows), 1)

    def test_latest_order_event_for_execution_ignores_unrelated_same_account_event(
        self,
    ) -> None:
        own_payload = (
            b'{"channel":"trade_updates","payload":{"event":"accepted","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"accepted",'
            b'"qty":"1","filled_qty":"0"}},"seq":10}'
        )
        unrelated_payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:05:00Z",'
            b'"order":{"id":"order-2","client_order_id":"client-2","symbol":"MSFT","status":"filled",'
            b'"qty":"1","filled_qty":"1","filled_avg_price":"405.0"}},"seq":11}'
        )

        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            for payload, offset in ((own_payload, 1), (unrelated_payload, 2)):
                normalized = normalize_order_feed_record(
                    FakeRecord(value=payload, offset=offset),
                    default_topic="torghut.trade-updates.v1",
                    default_account_label="paper",
                )
                assert normalized.event is not None
                persist_order_event(session, normalized.event)
            session.commit()

            latest = latest_order_event_for_execution(session, execution)

        self.assertIsNotNone(latest)
        assert latest is not None
        self.assertEqual(latest.alpaca_order_id, "order-1")
        self.assertEqual(latest.client_order_id, "client-1")

    def test_out_of_order_event_does_not_regress_execution(self) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            execution.order_feed_last_seq = 30
            execution.order_feed_last_event_ts = datetime.now(timezone.utc)
            execution.status = "filled"
            execution.filled_qty = Decimal("1")
            session.add(execution)
            session.commit()

            stale = ExecutionOrderEvent(
                event_fingerprint="stale-event",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=99,
                alpaca_account_label="paper",
                feed_seq=12,
                event_ts=execution.order_feed_last_event_ts - timedelta(seconds=10),
                symbol="AAPL",
                alpaca_order_id="order-1",
                client_order_id="client-1",
                event_type="partial_fill",
                status="partially_filled",
                qty=Decimal("1"),
                filled_qty=Decimal("0.5"),
                avg_fill_price=Decimal("190.0"),
                raw_event={"event": "partial_fill"},
                execution_id=execution.id,
            )
            session.add(stale)
            session.flush()

            updated, out_of_order = apply_order_event_to_execution(execution, stale)
            self.assertFalse(updated)
            self.assertTrue(out_of_order)
            self.assertEqual(execution.status, "filled")
            self.assertEqual(execution.filled_qty, Decimal("1"))

    def test_order_feed_update_preserves_submit_audit_and_cost_metadata(self) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            execution.raw_order = {
                "id": "order-1",
                "status": "accepted",
                "_execution_audit": {
                    "execution_policy_hash": "policy-sha",
                    "lineage_hash": "lineage-sha",
                },
                "runtime_ledger_cost": {
                    "cost_amount": "0.20",
                    "cost_basis": "modeled_paper_cost_budget",
                },
                "cost_amount": "0.20",
                "cost_basis": "modeled_paper_cost_budget",
                "execution_policy": {"max_order_notional": "1000"},
            }
            event = ExecutionOrderEvent(
                event_fingerprint="fill-event",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=101,
                alpaca_account_label="paper",
                feed_seq=31,
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id="order-1",
                client_order_id="client-1",
                event_type="fill",
                status="filled",
                qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.2"),
                raw_event={
                    "event": "fill",
                    "order": {
                        "id": "order-1",
                        "status": "filled",
                        "filled_qty": "1",
                        "filled_avg_price": "190.2",
                    },
                },
                execution_id=execution.id,
            )
            session.add(event)
            session.flush()

            updated, out_of_order = apply_order_event_to_execution(execution, event)

            self.assertTrue(updated)
            self.assertFalse(out_of_order)
            assert isinstance(execution.raw_order, dict)
            self.assertEqual(
                execution.raw_order["_execution_audit"]["execution_policy_hash"],
                "policy-sha",
            )
            self.assertEqual(
                execution.raw_order["runtime_ledger_cost"]["cost_basis"],
                "modeled_paper_cost_budget",
            )
            self.assertEqual(execution.raw_order["cost_amount"], "0.20")
            self.assertEqual(execution.raw_order["status"], "accepted")
            self.assertEqual(
                execution.raw_order["_order_feed_last_event"]["order"]["status"],
                "filled",
            )

    def test_merge_execution_raw_order_update_preserves_existing_keys(self) -> None:
        merged = merge_execution_raw_order_update(
            {
                "id": "order-1",
                "status": "accepted",
                "cost_amount": "0.20",
            },
            {"status": "filled", "filled_qty": "1"},
            update_key="_broker_reconcile_last_order",
        )

        self.assertIsInstance(merged, dict)
        assert isinstance(merged, dict)
        self.assertEqual(merged["status"], "accepted")
        self.assertEqual(merged["cost_amount"], "0.20")
        self.assertEqual(merged["filled_qty"], "1")
        self.assertEqual(merged["_broker_reconcile_last_order"]["status"], "filled")

    def test_ingestor_refreshes_tca_after_order_feed_fill_update(self) -> None:
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
            b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":31}'
        )
        consumer = FakeConsumer([FakeRecord(value=payload, offset=101)])
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            execution = self._seed_execution(session)

            with patch(
                ("app.trading.order_feed.shared_context.upsert_execution_tca_metric")
            ) as upsert:
                counters = ingestor.ingest_once(session)
                session.refresh(execution)

            self.assertEqual(counters["events_persisted_total"], 1)
            self.assertEqual(counters["apply_updates_total"], 1)
            self.assertEqual(execution.status, "filled")
            upsert.assert_called_once()

    def test_ingestor_counts_out_of_order_updates(self) -> None:
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"partial_fill","timestamp":"2026-02-01T09:59:00Z",'
            b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"partially_filled",'
            b'"qty":"1","filled_qty":"0.5","filled_avg_price":"190.0"}},"seq":12}'
        )
        consumer = FakeConsumer([FakeRecord(value=payload, offset=99)])
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            execution.order_feed_last_seq = 30
            execution.order_feed_last_event_ts = datetime(
                2026, 2, 1, 10, 0, tzinfo=timezone.utc
            )
            execution.status = "filled"
            execution.filled_qty = Decimal("1")
            session.add(execution)
            session.commit()

            counters = ingestor.ingest_once(session)
            session.refresh(execution)

        self.assertEqual(counters["events_persisted_total"], 1)
        self.assertEqual(counters["out_of_order_total"], 1)
        self.assertEqual(counters["apply_updates_total"], 0)
        self.assertEqual(execution.status, "filled")
        self.assertEqual(execution.filled_qty, Decimal("1"))

    def test_missing_identity_fields_are_dropped(self) -> None:
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"symbol":"AAPL","status":"filled"}},"seq":11}'
        )
        record = FakeRecord(value=payload, offset=44)

        normalized = normalize_order_feed_record(
            record,
            default_topic="torghut.trade-updates.v1",
            default_account_label="paper",
        )
        self.assertIsNone(normalized.event)
        self.assertEqual(normalized.drop_reason, "missing_order_identity")

    def test_v2_payload_uses_account_label_from_envelope(self) -> None:
        payload = (
            b'{"channel":"trade_updates","accountLabel":"paper-b","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"account_label":"paper-b","order":{"id":"order-9","client_order_id":"client-9","symbol":"AAPL","status":"filled",'
            b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10,"version":2}'
        )
        record = FakeRecord(value=payload, topic="torghut.trade-updates.v2", offset=12)

        normalized = normalize_order_feed_record(
            record,
            default_topic="torghut.trade-updates.v1",
            default_account_label="paper-a",
        )
        assert normalized.event is not None
        self.assertEqual(normalized.event.alpaca_account_label, "paper-b")

    def test_payload_uses_order_level_alpaca_account_label(self) -> None:
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"order-7","client_order_id":"client-7","symbol":"AAPL","status":"filled",'
            b'"alpaca_account_label":"paper-c","qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
        )
        record = FakeRecord(value=payload, topic="torghut.trade-updates.v1", offset=12)

        normalized = normalize_order_feed_record(
            record,
            default_topic="torghut.trade-updates.v1",
            default_account_label="paper-a",
        )
        assert normalized.event is not None
        self.assertEqual(normalized.event.alpaca_account_label, "paper-c")

    def test_sim_broker_account_label_alias_links_to_torghut_sim_scope(
        self,
    ) -> None:
        record = FakeRecord(
            value=(
                b'{"channel":"trade_updates","account_label":"PA3SX7FYNUTF",'
                b'"payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"account_label":"PA3SX7FYNUTF",'
                b'"order":{"id":"sim-order-1","client_order_id":"sim-client-1",'
                b'"symbol":"AAPL","status":"filled","qty":"1","filled_qty":"1",'
                b'"filled_avg_price":"190.2","alpaca_account_label":"PA3SX7FYNUTF"}},'
                b'"seq":10}'
            ),
            offset=26,
        )
        consumer = FakeConsumer([record])
        ingestor = OrderFeedIngestor(
            consumer_factory=lambda: consumer,
            default_account_label="TORGHUT_SIM",
        )

        with Session(self.engine) as session:
            execution = self._seed_execution(
                session,
                account_label="TORGHUT_SIM",
                order_id="sim-order-1",
                client_order_id="sim-client-1",
            )
            execution_id = execution.id
            trade_decision_id = execution.trade_decision_id

            counters = ingestor.ingest_once(session)
            event = session.execute(select(ExecutionOrderEvent)).scalar_one()
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()

        self.assertEqual(counters["events_persisted_total"], 1)
        self.assertEqual(counters["out_of_scope_account_total"], 0)
        self.assertEqual(counters["apply_updates_total"], 1)
        self.assertEqual(event.alpaca_account_label, "TORGHUT_SIM")
        self.assertEqual(event.execution_id, execution_id)
        self.assertEqual(event.trade_decision_id, trade_decision_id)
        self.assertEqual(
            event.raw_event["_torghut_account_label_alias"]["source_account_label"],
            "PA3SX7FYNUTF",
        )
        self.assertEqual(source_window.alpaca_account_label, "TORGHUT_SIM")
        self.assertEqual(source_window.status, "inserted")
        self.assertEqual(
            source_window.payload_json["account_label_alias"],
            {
                "source_account_label": "PA3SX7FYNUTF",
                "canonical_account_label": "TORGHUT_SIM",
                "basis": "matched_order_identity",
            },
        )
        self.assertFalse(source_window.payload_json["promotion_authority_eligible"])

    def test_order_feed_event_links_by_execution_correlation_id_only(self) -> None:
        record = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill",'
                b'"timestamp":"2026-02-01T10:00:00Z",'
                b'"_execution_correlation_id":"corr-order-feed-1",'
                b'"order":{"symbol":"AAPL","status":"filled","qty":"1",'
                b'"filled_qty":"1","filled_avg_price":"190.2"}},'
                b'"seq":12}'
            ),
            offset=27,
        )
        consumer = FakeConsumer([record])
        ingestor = OrderFeedIngestor(
            consumer_factory=lambda: consumer,
            default_account_label="paper",
        )

        with Session(self.engine) as session:
            execution = self._seed_execution(
                session,
                order_id="corr-broker-order-1",
                client_order_id="corr-client-1",
                execution_correlation_id="corr-order-feed-1",
            )
            execution_id = execution.id
            trade_decision_id = execution.trade_decision_id

            counters = ingestor.ingest_once(session)
            event = session.execute(select(ExecutionOrderEvent)).scalar_one()
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()

        self.assertEqual(counters["events_persisted_total"], 1)
        self.assertEqual(counters["unlinked_execution_total"], 0)
        self.assertEqual(counters["unlinked_decision_total"], 0)
        self.assertIsNone(event.alpaca_order_id)
        self.assertIsNone(event.client_order_id)
        self.assertEqual(event.execution_id, execution_id)
        self.assertEqual(event.trade_decision_id, trade_decision_id)
        self.assertEqual(
            source_window.payload_json["execution_correlation_id"],
            "corr-order-feed-1",
        )
        self.assertTrue(source_window.payload_json["source_coverage_complete"])
        self.assertFalse(source_window.payload_json["promotion_authority_eligible"])

    def test_order_identity_account_scope_matches_execution_correlation_id(
        self,
    ) -> None:
        with Session(self.engine) as session:
            self._seed_execution(
                session,
                order_id="corr-scope-order",
                client_order_id="corr-scope-client",
                execution_correlation_id="corr-scope-1",
            )
            event = NormalizedOrderEvent(
                event_fingerprint="corr-scope-fingerprint",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=40,
                alpaca_account_label="paper",
                feed_seq=12,
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id=None,
                client_order_id=None,
                execution_correlation_id="corr-scope-1",
                event_type="fill",
                status="filled",
                qty=Decimal("1"),
                filled_qty=Decimal("1"),
                position_qty=None,
                filled_qty_delta=Decimal("1"),
                avg_fill_price=Decimal("190.2"),
                filled_notional_delta=Decimal("190.2"),
                fill_quantity_basis="filled_qty",
                raw_event={"event": "fill"},
            )

            in_scope = order_identity_matches_account_scope(
                session,
                event,
                account_label="paper",
            )

        self.assertTrue(in_scope)
