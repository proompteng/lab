from __future__ import annotations

from tests.tigerbeetle_journal.support import (
    AccountFailureFakeTigerBeetleClient,
    BatchCountingFakeTigerBeetleClient,
    ClosableFakeTigerBeetleClient,
    Decimal,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    ExistingTransferLookupCountingFakeTigerBeetleClient,
    FakeTigerBeetleClient,
    LEDGER_USD_MICRO,
    Session,
    TIGERBEETLE_AUTHORITY_BLOCKER_ACCOUNTING_ONLY,
    TIGERBEETLE_AUTHORITY_BLOCKER_RUNTIME_LEDGER_SOURCE_REFS_MISSING,
    TIGERBEETLE_AUTHORITY_BLOCKER_RUNTIME_LEDGER_SOURCE_WINDOW_REFS_MISSING,
    TIGERBEETLE_RUNTIME_LEDGER_JOURNAL_STATUS_PASS,
    TRANSFER_KIND_EXECUTION_COST,
    TRANSFER_KIND_EXECUTION_FILL,
    TRANSFER_KIND_FILL_POST,
    TRANSFER_KIND_RUNTIME_NET_PNL,
    TigerBeetleLedgerJournal,
    TigerBeetleTransferRef,
    TigerBeetleTransferSpec,
    _TestTigerBeetleLedgerJournalBase,
    _create_fill_event,
    _runtime_bucket,
    _settings,
    _transfer_ref_mismatches,
    datetime,
    execution_cost_transfer_id,
    execution_economic_event_key,
    execution_tca_metric_economic_event_key,
    execution_tca_metric_source_id,
    execution_transfer_id,
    patch,
    runtime_ledger_transfer_id,
    select,
    submitted_pending_transfer_id,
    tigerbeetle_runtime_ledger_journal_payload,
    timezone,
)


class TestTigerBeetleLedgerJournalPart1(_TestTigerBeetleLedgerJournalBase):
    def test_disabled_journal_is_noop(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session)
            client = FakeTigerBeetleClient()

            ref = TigerBeetleLedgerJournal(
                settings_obj=_settings(enabled=False), client=client
            ).journal_order_event(
                session,
                event,
            )

            self.assertIsNone(ref)
            self.assertEqual(client.transfers, {})

    def test_source_journals_skip_disabled_and_unamounted_rows(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-source-noop")
            execution = event.execution
            self.assertIsNotNone(execution)
            assert execution is not None
            metric = ExecutionTCAMetric(
                execution_id=execution.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                side="buy",
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                shortfall_notional=Decimal("0"),
                computed_at=datetime.now(timezone.utc),
            )
            bucket = _runtime_bucket()
            bucket.net_strategy_pnl_after_costs = Decimal("0")
            bucket.cost_amount = Decimal("0")
            session.add_all([metric, bucket])
            session.flush()
            client = FakeTigerBeetleClient()
            disabled = TigerBeetleLedgerJournal(
                settings_obj=_settings(enabled=False),
                client=client,
            )

            self.assertIsNone(disabled.journal_execution(session, execution))
            self.assertIsNone(disabled.journal_execution_tca_metric(session, metric))
            self.assertIsNone(disabled.journal_runtime_ledger_bucket(session, bucket))
            self.assertEqual(disabled.journal_order_events(session, [event]), [None])
            self.assertEqual(disabled.journal_executions(session, [execution]), [None])
            self.assertEqual(
                disabled.journal_execution_tca_metrics(session, [metric]),
                [None],
            )
            self.assertEqual(
                disabled.journal_runtime_ledger_buckets(session, [bucket]),
                [None],
            )

            enabled = TigerBeetleLedgerJournal(settings_obj=_settings(), client=client)
            event.avg_fill_price = None
            event.filled_qty = None
            execution.avg_fill_price = None
            self.assertEqual(enabled.journal_order_events(session, [event]), [None])
            self.assertEqual(enabled.journal_executions(session, [execution]), [None])
            self.assertEqual(
                enabled.journal_execution_tca_metrics(session, [metric]),
                [None],
            )
            self.assertEqual(
                enabled.journal_runtime_ledger_buckets(session, [bucket]),
                [None],
            )
            self.assertIsNone(enabled.journal_execution(session, execution))
            self.assertIsNone(enabled.journal_execution_tca_metric(session, metric))
            self.assertIsNone(enabled.journal_runtime_ledger_bucket(session, bucket))
            self.assertEqual(client.transfers, {})

    def test_repeated_same_event_creates_one_transfer_ref(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session)
            client = FakeTigerBeetleClient()
            journal = TigerBeetleLedgerJournal(settings_obj=_settings(), client=client)

            first = journal.journal_order_event(session, event)
            second = journal.journal_order_event(session, event)

            self.assertIsNotNone(first)
            self.assertEqual(first, second)
            refs = session.execute(select(TigerBeetleTransferRef)).scalars().all()
            self.assertEqual(len(refs), 1)
            self.assertEqual(refs[0].amount, Decimal("190250000"))
            self.assertEqual(refs[0].ledger, LEDGER_USD_MICRO)
            self.assertEqual(len(client.transfers), 1)

    def test_owned_client_is_reused_and_closed(self) -> None:
        with Session(self.engine) as session:
            first = _create_fill_event(session, fingerprint="client-reuse-1")
            second = _create_fill_event(session, fingerprint="client-reuse-2")
            client = ClosableFakeTigerBeetleClient()

            with patch(
                "app.trading.tigerbeetle_journal_modules.part_04_tigerbeetleledgerjournal.create_tigerbeetle_client",
                return_value=client,
            ) as factory:
                with TigerBeetleLedgerJournal(settings_obj=_settings()) as journal:
                    self.assertIsNotNone(journal.journal_order_event(session, first))
                    self.assertIsNotNone(journal.journal_order_event(session, second))

            self.assertEqual(factory.call_count, 1)
            self.assertEqual(client.close_count, 1)
            self.assertEqual(len(client.transfers), 2)

    def test_reconciliation_client_is_disabled_when_journal_is_disabled(
        self,
    ) -> None:
        client = FakeTigerBeetleClient()

        self.assertIsNone(
            TigerBeetleLedgerJournal(
                settings_obj=_settings(enabled=False),
                client=client,
            ).client_for_reconciliation()
        )
        self.assertIsNone(
            TigerBeetleLedgerJournal(
                settings_obj=_settings(journal_enabled=False),
                client=client,
            ).client_for_reconciliation()
        )

    def test_reconciliation_client_reuses_owned_journal_client(self) -> None:
        client = ClosableFakeTigerBeetleClient()

        with patch(
            "app.trading.tigerbeetle_journal_modules.part_04_tigerbeetleledgerjournal.create_tigerbeetle_client",
            return_value=client,
        ) as factory:
            with TigerBeetleLedgerJournal(settings_obj=_settings()) as journal:
                self.assertIs(journal.client_for_reconciliation(), client)
                self.assertIs(journal.client_for_reconciliation(), client)

        self.assertEqual(factory.call_count, 1)
        self.assertEqual(client.close_count, 1)

    def test_real_fractional_notional_rounds_to_nearest_micro(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fractional-notional")
            event.filled_qty = Decimal("1")
            event.qty = Decimal("1")
            event.avg_fill_price = Decimal("1.0000005")
            client = FakeTigerBeetleClient()

            ref = TigerBeetleLedgerJournal(
                settings_obj=_settings(), client=client
            ).journal_order_event(session, event)

            self.assertIsNotNone(ref)
            assert ref is not None
            self.assertEqual(ref.amount, Decimal("1000001"))
            transfer = client.transfers[int(ref.transfer_id)]
            self.assertEqual(getattr(transfer, "amount"), 1000001)

    def test_fill_without_pending_ref_uses_standalone_transfer(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-standalone")
            client = FakeTigerBeetleClient()

            ref = TigerBeetleLedgerJournal(
                settings_obj=_settings(), client=client
            ).journal_order_event(
                session,
                event,
            )

            self.assertIsNotNone(ref)
            assert ref is not None
            self.assertIsNone(ref.payload_json["pending_id"])
            self.assertEqual(ref.payload_json["pending_mode"], "standalone_fill")
            transfer = client.transfers[int(ref.transfer_id)]
            self.assertEqual(getattr(transfer, "pending_id"), 0)
            self.assertEqual(getattr(transfer, "flags"), 0)

    def test_fill_with_pending_ref_uses_post_pending_transfer(self) -> None:
        with Session(self.engine) as session:
            fill = _create_fill_event(session, fingerprint="fingerprint-post-pending")
            submitted = ExecutionOrderEvent(
                event_fingerprint="fingerprint-post-pending-submitted",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=10,
                alpaca_account_label=fill.alpaca_account_label,
                event_ts=datetime.now(timezone.utc),
                symbol=fill.symbol,
                alpaca_order_id=fill.alpaca_order_id,
                client_order_id=fill.client_order_id,
                event_type="new",
                status="new",
                qty=Decimal("1"),
                avg_fill_price=Decimal("190.25"),
                raw_event={"event": "new", "price": "190.25"},
                execution_id=fill.execution_id,
                trade_decision_id=fill.trade_decision_id,
            )
            session.add(submitted)
            session.flush()
            client = FakeTigerBeetleClient()
            journal = TigerBeetleLedgerJournal(settings_obj=_settings(), client=client)

            pending_ref = journal.journal_order_event(session, submitted)
            fill_ref = journal.journal_order_event(session, fill)

            self.assertIsNotNone(pending_ref)
            self.assertIsNotNone(fill_ref)
            assert fill_ref is not None
            self.assertEqual(
                fill_ref.payload_json["pending_id"],
                str(submitted_pending_transfer_id(fill)),
            )
            self.assertEqual(
                fill_ref.payload_json["pending_mode"], "pending_transfer_ref"
            )

    def test_execution_source_writes_real_execution_ref(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-execution")
            execution = event.execution
            self.assertIsNotNone(execution)
            assert execution is not None
            client = FakeTigerBeetleClient()

            ref = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=client,
            ).journal_execution(session, execution)

            self.assertIsNotNone(ref)
            assert ref is not None
            self.assertEqual(ref.source_type, "execution")
            self.assertEqual(ref.source_id, str(execution.id))
            self.assertEqual(ref.execution_id, execution.id)
            self.assertEqual(ref.transfer_kind, TRANSFER_KIND_EXECUTION_FILL)
            self.assertEqual(ref.transfer_id, str(execution_transfer_id(execution)))
            self.assertEqual(ref.amount, Decimal("190250000"))
            self.assertEqual(ref.payload_json["source_row_id"], str(execution.id))
            self.assertEqual(
                ref.payload_json["economic_event_key"],
                execution_economic_event_key(execution),
            )
            self.assertIn(int(ref.transfer_id), client.transfers)

    def test_cost_source_writes_real_tca_metric_ref(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-cost")
            metric = ExecutionTCAMetric(
                execution_id=event.execution_id,
                trade_decision_id=event.trade_decision_id,
                strategy_id=event.trade_decision.strategy_id
                if event.trade_decision
                else None,
                alpaca_account_label="paper",
                symbol="AAPL",
                side="buy",
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                shortfall_notional=Decimal("0.25"),
                realized_shortfall_bps=Decimal("1.3"),
                computed_at=datetime.now(timezone.utc),
            )
            session.add(metric)
            session.flush()
            client = FakeTigerBeetleClient()

            ref = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=client,
            ).journal_execution_tca_metric(session, metric)

            self.assertIsNotNone(ref)
            assert ref is not None
            self.assertEqual(ref.source_type, "execution_tca_metric")
            self.assertEqual(ref.source_id, execution_tca_metric_source_id(metric))
            self.assertEqual(ref.execution_tca_metric_id, metric.id)
            self.assertEqual(ref.transfer_kind, TRANSFER_KIND_EXECUTION_COST)
            self.assertEqual(ref.transfer_id, str(execution_cost_transfer_id(metric)))
            self.assertEqual(ref.amount, Decimal("250000"))
            self.assertEqual(
                ref.payload_json["source_refs"],
                [
                    f"postgres:execution_tca_metrics:{metric.id}",
                    f"postgres:executions:{metric.execution_id}",
                ],
            )
            self.assertEqual(
                ref.payload_json["economic_event_key"],
                execution_tca_metric_economic_event_key(metric),
            )
            self.assertEqual(ref.payload_json["source_row_id"], str(metric.id))
            self.assertEqual(ref.payload_json["amount_source"], "0.25")
            self.assertEqual(ref.payload_json["ledger"], LEDGER_USD_MICRO)
            self.assertEqual(ref.payload_json["code"], 2011)
            self.assertEqual(ref.payload_json["transfer_id"], ref.transfer_id)

    def test_cost_source_retry_for_same_metric_is_idempotent(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-cost-retry")
            metric = ExecutionTCAMetric(
                execution_id=event.execution_id,
                trade_decision_id=event.trade_decision_id,
                strategy_id=event.trade_decision.strategy_id
                if event.trade_decision
                else None,
                alpaca_account_label="paper",
                symbol="AAPL",
                side="buy",
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                shortfall_notional=Decimal("0.25"),
                realized_shortfall_bps=Decimal("1.3"),
                computed_at=datetime.now(timezone.utc),
            )
            session.add(metric)
            session.flush()
            client = FakeTigerBeetleClient()
            journal = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=client,
            )

            first = journal.journal_execution_tca_metric(session, metric)
            second = journal.journal_execution_tca_metric(session, metric)

            self.assertIsNotNone(first)
            self.assertEqual(first, second)
            refs = session.execute(select(TigerBeetleTransferRef)).scalars().all()
            self.assertEqual(len(refs), 1)
            self.assertEqual(len(client.transfers), 1)

    def test_cost_source_batch_uses_single_native_transfer_request(self) -> None:
        with Session(self.engine) as session:
            metrics: list[ExecutionTCAMetric] = []
            for index in range(3):
                event = _create_fill_event(
                    session,
                    fingerprint=f"fingerprint-cost-batch-{index}",
                )
                metric = ExecutionTCAMetric(
                    execution_id=event.execution_id,
                    trade_decision_id=event.trade_decision_id,
                    strategy_id=event.trade_decision.strategy_id
                    if event.trade_decision
                    else None,
                    alpaca_account_label="paper",
                    symbol="AAPL",
                    side="buy",
                    filled_qty=Decimal("1"),
                    signed_qty=Decimal("1"),
                    shortfall_notional=Decimal("0.25"),
                    realized_shortfall_bps=Decimal("1.3"),
                    computed_at=datetime.now(timezone.utc),
                )
                session.add(metric)
                session.flush()
                metrics.append(metric)
            client = BatchCountingFakeTigerBeetleClient()
            journal = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=client,
            )

            refs = journal.journal_execution_tca_metrics(session, metrics)
            second_refs = journal.journal_execution_tca_metrics(session, metrics)

            self.assertEqual(len([ref for ref in refs if ref is not None]), 3)
            self.assertEqual(len([ref for ref in second_refs if ref is not None]), 3)
            self.assertEqual(client.transfer_call_sizes, [3])
            self.assertEqual(len(client.account_call_sizes), 1)
            self.assertGreater(client.account_call_sizes[0], 0)
            self.assertEqual(len(client.transfers), 3)
            persisted = session.execute(select(TigerBeetleTransferRef)).scalars().all()
            self.assertEqual(len(persisted), 3)

    def test_existing_transfer_batch_uses_single_lookup_request(self) -> None:
        with Session(self.engine) as session:
            metrics: list[ExecutionTCAMetric] = []
            for index in range(3):
                event = _create_fill_event(
                    session,
                    fingerprint=f"fingerprint-existing-cost-batch-{index}",
                )
                metric = ExecutionTCAMetric(
                    execution_id=event.execution_id,
                    trade_decision_id=event.trade_decision_id,
                    strategy_id=event.trade_decision.strategy_id
                    if event.trade_decision
                    else None,
                    alpaca_account_label="paper",
                    symbol="AAPL",
                    side="buy",
                    filled_qty=Decimal("1"),
                    signed_qty=Decimal("1"),
                    shortfall_notional=Decimal("0.25"),
                    realized_shortfall_bps=Decimal("1.3"),
                    computed_at=datetime.now(timezone.utc),
                )
                session.add(metric)
                session.flush()
                metrics.append(metric)
            client = ExistingTransferLookupCountingFakeTigerBeetleClient()
            journal = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=client,
            )

            refs = journal.journal_execution_tca_metrics(session, metrics)

            self.assertEqual(len([ref for ref in refs if ref is not None]), 3)
            self.assertEqual(client.lookup_call_sizes, [3])
            self.assertEqual(
                {ref.status for ref in refs if ref is not None},
                {"exists"},
            )
            persisted = session.execute(select(TigerBeetleTransferRef)).scalars().all()
            self.assertEqual(len(persisted), 3)

    def test_source_batches_cover_order_execution_and_runtime_paths(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-source-batch")
            execution = event.execution
            self.assertIsNotNone(execution)
            assert execution is not None
            bucket = _runtime_bucket()
            session.add(bucket)
            session.flush()
            client = BatchCountingFakeTigerBeetleClient()
            journal = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=client,
            )

            order_refs = journal.journal_order_events(session, [event])
            execution_refs = journal.journal_executions(session, [execution])
            runtime_refs = journal.journal_runtime_ledger_buckets(session, [bucket])

            self.assertEqual(len([ref for ref in order_refs if ref is not None]), 1)
            self.assertEqual(len([ref for ref in execution_refs if ref is not None]), 1)
            self.assertEqual(len([ref for ref in runtime_refs if ref is not None]), 1)
            self.assertEqual(client.transfer_call_sizes, [1, 1, 1])
            runtime_ref = runtime_refs[0]
            self.assertIsNotNone(runtime_ref)
            assert runtime_ref is not None
            self.assertEqual(
                runtime_ref.payload_json["source_refs"],
                [f"postgres:strategy_runtime_ledger_buckets:{bucket.id}"],
            )
            self.assertIn("runtime-run-1", runtime_ref.payload_json["runtime_key"])

    def test_batch_account_failures_are_reported_with_account_id(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-account-fail")
            metric = ExecutionTCAMetric(
                execution_id=event.execution_id,
                trade_decision_id=event.trade_decision_id,
                strategy_id=event.trade_decision.strategy_id
                if event.trade_decision
                else None,
                alpaca_account_label="paper",
                symbol="AAPL",
                side="buy",
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                shortfall_notional=Decimal("0.25"),
                realized_shortfall_bps=Decimal("1.3"),
                computed_at=datetime.now(timezone.utc),
            )
            session.add(metric)
            session.flush()
            journal = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=AccountFailureFakeTigerBeetleClient(),
            )

            with self.assertRaisesRegex(
                RuntimeError,
                "tigerbeetle_create_account_failed:.*:linked_event_failed",
            ):
                journal.journal_execution_tca_metrics(session, [metric])

    def test_cost_source_changed_economics_create_distinct_revision_ref(
        self,
    ) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-cost-revision")
            metric = ExecutionTCAMetric(
                execution_id=event.execution_id,
                trade_decision_id=event.trade_decision_id,
                strategy_id=event.trade_decision.strategy_id
                if event.trade_decision
                else None,
                alpaca_account_label="paper",
                symbol="AAPL",
                side="buy",
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                shortfall_notional=Decimal("0.25"),
                realized_shortfall_bps=Decimal("1.3"),
                computed_at=datetime.now(timezone.utc),
            )
            session.add(metric)
            session.flush()
            client = FakeTigerBeetleClient()
            journal = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=client,
            )

            first = journal.journal_execution_tca_metric(session, metric)
            self.assertIsNotNone(first)
            assert first is not None
            first_transfer_id = first.transfer_id
            first_source_id = first.source_id
            metric.shortfall_notional = Decimal("0.40")
            metric.realized_shortfall_bps = Decimal("2.1")
            session.add(metric)
            session.flush()
            second = journal.journal_execution_tca_metric(session, metric)

            self.assertIsNotNone(second)
            assert second is not None
            self.assertNotEqual(second.transfer_id, first_transfer_id)
            self.assertNotEqual(second.source_id, first_source_id)
            self.assertEqual(second.amount, Decimal("400000"))
            refs = (
                session.execute(
                    select(TigerBeetleTransferRef).where(
                        TigerBeetleTransferRef.source_type == "execution_tca_metric"
                    )
                )
                .scalars()
                .all()
            )
            self.assertEqual(len(refs), 2)
            self.assertEqual(len(client.transfers), 2)

    def test_cost_source_same_ref_different_payload_is_blocked(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(
                session, fingerprint="fingerprint-cost-payload-conflict"
            )
            metric = ExecutionTCAMetric(
                execution_id=event.execution_id,
                trade_decision_id=event.trade_decision_id,
                strategy_id=event.trade_decision.strategy_id
                if event.trade_decision
                else None,
                alpaca_account_label="paper",
                symbol="AAPL",
                side="buy",
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                shortfall_notional=Decimal("0.25"),
                realized_shortfall_bps=Decimal("1.3"),
                computed_at=datetime.now(timezone.utc),
            )
            session.add(metric)
            session.flush()
            expected_transfer_id = str(execution_cost_transfer_id(metric))
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=2001,
                    transfer_id=expected_transfer_id,
                    transfer_kind=TRANSFER_KIND_EXECUTION_COST,
                    ledger=LEDGER_USD_MICRO,
                    code=2011,
                    amount=Decimal("999"),
                    status="created",
                    execution_id=metric.execution_id,
                    execution_tca_metric_id=metric.id,
                    source_type="execution_tca_metric",
                    source_id=str(metric.id),
                    payload_json={
                        "debit_account_id": "1",
                        "credit_account_id": "2",
                    },
                )
            )
            session.flush()

            with self.assertRaisesRegex(
                RuntimeError,
                "tigerbeetle_transfer_ref_conflict:.*amount.*debit_account_id.*credit_account_id",
            ):
                TigerBeetleLedgerJournal(
                    settings_obj=_settings(), client=FakeTigerBeetleClient()
                ).journal_execution_tca_metric(session, metric)

    def test_cost_source_same_ref_different_currency_is_blocked(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(
                session, fingerprint="fingerprint-cost-ledger-conflict"
            )
            metric = ExecutionTCAMetric(
                execution_id=event.execution_id,
                trade_decision_id=event.trade_decision_id,
                strategy_id=event.trade_decision.strategy_id
                if event.trade_decision
                else None,
                alpaca_account_label="paper",
                symbol="AAPL",
                side="buy",
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                shortfall_notional=Decimal("0.25"),
                realized_shortfall_bps=Decimal("1.3"),
                computed_at=datetime.now(timezone.utc),
            )
            session.add(metric)
            session.flush()
            expected_transfer_id = str(execution_cost_transfer_id(metric))
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=2001,
                    transfer_id=expected_transfer_id,
                    transfer_kind=TRANSFER_KIND_EXECUTION_COST,
                    ledger=LEDGER_USD_MICRO + 1,
                    code=2011,
                    amount=Decimal("250000"),
                    status="created",
                    execution_id=metric.execution_id,
                    execution_tca_metric_id=metric.id,
                    source_type="execution_tca_metric",
                    source_id=str(metric.id),
                    payload_json={},
                )
            )
            session.flush()

            with self.assertRaisesRegex(
                RuntimeError,
                "tigerbeetle_transfer_ref_conflict:ledger",
            ):
                TigerBeetleLedgerJournal(
                    settings_obj=_settings(), client=FakeTigerBeetleClient()
                ).journal_execution_tca_metric(session, metric)

    def test_transfer_ref_mismatch_details_cover_identity_kind_code_and_pending(
        self,
    ) -> None:
        expected = TigerBeetleTransferSpec(
            transfer_id=123,
            transfer_kind=TRANSFER_KIND_FILL_POST,
            debit_account_id=11,
            credit_account_id=22,
            amount=1000,
            ledger=LEDGER_USD_MICRO,
            code=2001,
            pending_id=456,
        )
        ref = TigerBeetleTransferRef(
            cluster_id=2001,
            transfer_id="999",
            transfer_kind=TRANSFER_KIND_EXECUTION_COST,
            ledger=LEDGER_USD_MICRO,
            code=2999,
            amount=Decimal("1000"),
            status="created",
            payload_json={"pending_id": "999"},
        )

        self.assertEqual(
            _transfer_ref_mismatches(ref, expected),
            ["transfer_id", "transfer_kind", "code", "pending_id"],
        )

    def test_runtime_bucket_source_writes_real_runtime_ledger_ref(self) -> None:
        with Session(self.engine) as session:
            bucket = _runtime_bucket()
            bucket.payload_json = {
                "source_refs": ["postgres:execution_order_events:event-1"],
                "source_window_refs": ["postgres:source_windows:window-1"],
            }
            session.add(bucket)
            session.flush()
            client = FakeTigerBeetleClient()

            ref = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=client,
            ).journal_runtime_ledger_bucket(session, bucket)

            self.assertIsNotNone(ref)
            assert ref is not None
            self.assertEqual(ref.source_type, "strategy_runtime_ledger_bucket")
            self.assertEqual(ref.source_id, str(bucket.id))
            self.assertEqual(ref.runtime_ledger_bucket_id, bucket.id)
            self.assertEqual(ref.transfer_kind, TRANSFER_KIND_RUNTIME_NET_PNL)
            self.assertEqual(ref.transfer_id, str(runtime_ledger_transfer_id(bucket)))
            self.assertEqual(ref.amount, Decimal("2500000"))
            self.assertEqual(ref.payload_json["pnl_direction"], "profit")
            self.assertEqual(ref.payload_json["signed_amount_micros"], 2500000)
            self.assertEqual(
                ref.payload_json["source_refs"],
                [f"postgres:strategy_runtime_ledger_buckets:{bucket.id}"],
            )
            self.assertEqual(ref.payload_json["source_row_id"], str(bucket.id))
            self.assertEqual(ref.payload_json["transfer_id"], ref.transfer_id)
            self.assertEqual(ref.payload_json["ledger"], ref.ledger)
            self.assertEqual(ref.payload_json["code"], ref.code)
            stable_ref = ref.payload_json["stable_ref"]
            self.assertEqual(
                stable_ref["schema_version"], "torghut.tigerbeetle-stable-ref.v1"
            )
            self.assertEqual(
                stable_ref["stable_ref_id"], ref.payload_json["stable_ref_id"]
            )
            self.assertEqual(stable_ref["transfer_id"], ref.transfer_id)
            self.assertFalse(stable_ref["promotion_authority"])
            self.assertFalse(stable_ref["overrides_runtime_ledger_authority"])
            stable_components = stable_ref["components"]
            self.assertEqual(stable_components["cluster_id"], 2001)
            self.assertEqual(stable_components["account_label"], "paper")
            self.assertEqual(
                stable_components["source_type"],
                "strategy_runtime_ledger_bucket",
            )
            self.assertEqual(stable_components["source_id"], str(bucket.id))
            self.assertEqual(
                stable_components["transfer_kind"], TRANSFER_KIND_RUNTIME_NET_PNL
            )
            self.assertEqual(
                stable_components["source_signature"], ref.payload_json["runtime_key"]
            )
            self.assertFalse(ref.payload_json["promotion_authority"])
            self.assertFalse(ref.payload_json["overrides_runtime_ledger_authority"])
            parity = tigerbeetle_runtime_ledger_journal_payload(
                bucket=bucket,
                ref=ref,
                status=TIGERBEETLE_RUNTIME_LEDGER_JOURNAL_STATUS_PASS,
            )
            self.assertEqual(parity["status"], "pass")
            self.assertEqual(parity["stable_ref_count"], 1)
            self.assertEqual(parity["stable_ref_ids"], [stable_ref["stable_ref_id"]])
            self.assertEqual(
                parity["transfer"]["stable_ref_id"], stable_ref["stable_ref_id"]
            )
            self.assertFalse(parity["promotion_authority"])
            self.assertIn(
                TIGERBEETLE_AUTHORITY_BLOCKER_ACCOUNTING_ONLY,
                parity["authority_blockers"],
            )
            self.assertNotIn(
                TIGERBEETLE_AUTHORITY_BLOCKER_RUNTIME_LEDGER_SOURCE_REFS_MISSING,
                parity["authority_blockers"],
            )
            self.assertNotIn(
                TIGERBEETLE_AUTHORITY_BLOCKER_RUNTIME_LEDGER_SOURCE_WINDOW_REFS_MISSING,
                parity["authority_blockers"],
            )
            transfer = client.transfers[int(ref.transfer_id)]
            self.assertEqual(
                ref.payload_json["debit_account_id"],
                str(getattr(transfer, "debit_account_id")),
            )
            self.assertEqual(
                ref.payload_json["credit_account_id"],
                str(getattr(transfer, "credit_account_id")),
            )
