from __future__ import annotations

from tests.tigerbeetle_journal.support import (
    Decimal,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    FakeTigerBeetleClient,
    LEDGER_USD_MICRO,
    NumericExistsFakeTigerBeetleClient,
    RuntimeLedgerJournalPayloadInput,
    Session,
    SimpleNamespace,
    TIGERBEETLE_AUTHORITY_BLOCKER_RUNTIME_LEDGER_SOURCE_REFS_MISSING,
    TIGERBEETLE_AUTHORITY_BLOCKER_RUNTIME_LEDGER_SOURCE_WINDOW_REFS_MISSING,
    TIGERBEETLE_RUNTIME_LEDGER_JOURNAL_STATUS_PASS,
    TRANSFER_KIND_CANCEL_VOID,
    TRANSFER_KIND_FILL_POST,
    TRANSFER_KIND_RUNTIME_NET_PNL,
    TRANSFER_KIND_SUBMITTED_PENDING,
    TigerBeetleAccountRef,
    TigerBeetleAccountSpec,
    TigerBeetleLedgerJournal,
    TigerBeetleTransferRef,
    TigerBeetleTransferSpec,
    _TestTigerBeetleLedgerJournalBase,
    _create_fill_event,
    _runtime_bucket,
    _settings,
    build_order_event_transfer_plan,
    datetime,
    decimal_usd_to_micros,
    dedupe_account_specs,
    event_amount_usd,
    event_transfer_id,
    lookup_payload_decimal,
    order_event_account_specs,
    order_event_precedes,
    order_event_transfer_spec,
    patch,
    positive_payload_count,
    result_index,
    result_status,
    result_statuses_by_index,
    runtime_ledger_transfer_id,
    select,
    submitted_pending_transfer_id,
    sys,
    tigerbeetle_runtime_ledger_journal_payload,
    timezone,
    transfer_attr,
    transfer_flag,
)


class TestTigerBeetleLedgerJournalTransferRefs(_TestTigerBeetleLedgerJournalBase):
    @staticmethod
    def _add_stable_ref_account_refs(session: Session) -> None:
        session.add_all(
            [
                TigerBeetleAccountRef(
                    cluster_id=2001,
                    account_id="100100100100100100100100100100100101",
                    account_key="cash:paper:usd",
                    ledger=LEDGER_USD_MICRO,
                    code=1001,
                    account_label="paper",
                ),
                TigerBeetleAccountRef(
                    cluster_id=2001,
                    account_id="100100100100100100100100100100100102",
                    account_key="runtime_ledger:paper:hypothesis-1",
                    ledger=LEDGER_USD_MICRO,
                    code=1503,
                    account_label="paper",
                ),
            ]
        )

    def test_stable_ref_backfill_selects_missing_ref_before_newer_complete_ref(
        self,
    ) -> None:
        with Session(self.engine) as session:
            self._add_stable_ref_account_refs(session)
            missing = TigerBeetleTransferRef(
                cluster_id=2001,
                transfer_id="100100100100100100100100100100100201",
                transfer_kind=TRANSFER_KIND_RUNTIME_NET_PNL,
                ledger=LEDGER_USD_MICRO,
                code=2012,
                amount=Decimal("2500000"),
                status="created",
                source_type="strategy_runtime_ledger_bucket",
                source_id="00000000-0000-4000-8000-000000000001",
                payload_json={
                    "debit_account_id": "100100100100100100100100100100100101",
                    "credit_account_id": "100100100100100100100100100100100102",
                    "runtime_key": "hypothesis-1:runtime-run-1:source-window",
                },
                created_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
            )
            complete = TigerBeetleTransferRef(
                cluster_id=2001,
                transfer_id="100100100100100100100100100100100202",
                transfer_kind=TRANSFER_KIND_RUNTIME_NET_PNL,
                ledger=LEDGER_USD_MICRO,
                code=2012,
                amount=Decimal("2500000"),
                status="created",
                source_type="strategy_runtime_ledger_bucket",
                source_id="00000000-0000-4000-8000-000000000002",
                payload_json={"stable_ref": {"schema_version": "already-present"}},
                created_at=datetime(2026, 6, 2, tzinfo=timezone.utc),
            )
            session.add_all([missing, complete])
            session.flush()
            journal = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=FakeTigerBeetleClient(),
            )

            result = journal.backfill_stable_ref_payloads(session, limit=1)

            self.assertEqual(result, {"selected": 1, "updated": 1, "skipped": 0})
            self.assertIn("stable_ref", missing.payload_json)
            self.assertEqual(
                complete.payload_json,
                {"stable_ref": {"schema_version": "already-present"}},
            )

    def test_stable_ref_payload_backfill_is_idempotent_without_tigerbeetle_write(
        self,
    ) -> None:
        with Session(self.engine) as session:
            self._add_stable_ref_account_refs(session)
            bucket = _runtime_bucket()
            session.add(bucket)
            session.flush()
            ref = TigerBeetleTransferRef(
                cluster_id=2001,
                transfer_id=str(runtime_ledger_transfer_id(bucket)),
                transfer_kind=TRANSFER_KIND_RUNTIME_NET_PNL,
                ledger=LEDGER_USD_MICRO,
                code=2012,
                amount=Decimal("2500000"),
                status="created",
                runtime_ledger_bucket_id=bucket.id,
                source_type="strategy_runtime_ledger_bucket",
                source_id=str(bucket.id),
                payload_json={
                    "debit_account_id": "100100100100100100100100100100100101",
                    "credit_account_id": "100100100100100100100100100100100102",
                    "runtime_key": "hypothesis-1:runtime-run-1:source-window",
                },
            )
            session.add(ref)
            session.flush()
            client = FakeTigerBeetleClient()
            journal = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=client,
            )

            first = journal.backfill_stable_ref_payloads(session)
            first_payload = dict(ref.payload_json)
            second = journal.backfill_stable_ref_payloads(session)

            self.assertEqual(first, {"selected": 1, "updated": 1, "skipped": 0})
            self.assertEqual(second, {"selected": 0, "updated": 0, "skipped": 0})
            self.assertEqual(client.transfers, {})
            self.assertEqual(ref.payload_json, first_payload)
            self.assertIn("stable_ref", ref.payload_json)
            stable_ref = ref.payload_json["stable_ref"]
            self.assertEqual(
                stable_ref["components"]["account_label"],
                "paper",
            )
            self.assertEqual(
                stable_ref["account_keys"],
                ["cash:paper:usd", "runtime_ledger:paper:hypothesis-1"],
            )

    def test_runtime_bucket_journal_payload_marks_aggregate_only_non_authority(
        self,
    ) -> None:
        with Session(self.engine) as session:
            bucket = _runtime_bucket()
            bucket.payload_json = {"source": "aggregate-only-fixture"}
            session.add(bucket)
            session.flush()
            client = FakeTigerBeetleClient()

            ref = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=client,
            ).journal_runtime_ledger_bucket(session, bucket)

        self.assertIsNotNone(ref)
        assert ref is not None
        parity = tigerbeetle_runtime_ledger_journal_payload(
            RuntimeLedgerJournalPayloadInput(
                bucket=bucket,
                ref=ref,
                status=TIGERBEETLE_RUNTIME_LEDGER_JOURNAL_STATUS_PASS,
            )
        )
        self.assertFalse(parity["promotion_authority"])
        self.assertFalse(parity["overrides_runtime_ledger_authority"])
        self.assertIn(
            TIGERBEETLE_AUTHORITY_BLOCKER_RUNTIME_LEDGER_SOURCE_REFS_MISSING,
            parity["authority_blockers"],
        )
        self.assertIn(
            TIGERBEETLE_AUTHORITY_BLOCKER_RUNTIME_LEDGER_SOURCE_WINDOW_REFS_MISSING,
            parity["authority_blockers"],
        )

    def test_source_authority_count_parser_rejects_invalid_values(self) -> None:
        self.assertFalse(positive_payload_count("not-a-number"))

    def test_runtime_bucket_journal_payload_merges_transfer_account_refs(
        self,
    ) -> None:
        with Session(self.engine) as session:
            bucket = _runtime_bucket()
            session.add(bucket)
            session.flush()
            ref = TigerBeetleTransferRef(
                cluster_id=2001,
                transfer_id="340282366920938463463374607431768210",
                transfer_kind=TRANSFER_KIND_RUNTIME_NET_PNL,
                ledger=LEDGER_USD_MICRO,
                code=2001,
                amount=Decimal("2500000"),
                status="created",
                runtime_ledger_bucket_id=bucket.id,
                payload_json={
                    "debit_account_id": "100100100100100100100100100100100101",
                    "credit_account_id": "100100100100100100100100100100100102",
                },
            )
            duplicate_cash_ref = TigerBeetleAccountRef(
                cluster_id=2001,
                account_id="100100100100100100100100100100100101",
                account_key="TORGHUT_SIM:cash",
                ledger=840001,
                code=1001,
                account_label="paper",
            )
            missing_fee_ref = TigerBeetleAccountRef(
                cluster_id=2002,
                account_id="100100100100100100100100100100100103",
                account_key="TORGHUT_SIM:fees",
                ledger=840001,
                code=1003,
                account_label="paper",
            )
            session.add_all([ref, duplicate_cash_ref, missing_fee_ref])
            session.flush()

            parity = tigerbeetle_runtime_ledger_journal_payload(
                RuntimeLedgerJournalPayloadInput(
                    bucket=bucket,
                    ref=ref,
                    status=TIGERBEETLE_RUNTIME_LEDGER_JOURNAL_STATUS_PASS,
                    account_refs=[duplicate_cash_ref, missing_fee_ref],
                )
            )

        self.assertEqual(parity["cluster_ids"], [2001, 2002])
        self.assertEqual(
            parity["account_ids"],
            [
                "100100100100100100100100100100100101",
                "100100100100100100100100100100100102",
                "100100100100100100100100100100100103",
            ],
        )
        self.assertEqual(
            parity["account_keys"],
            ["TORGHUT_SIM:cash", "TORGHUT_SIM:fees"],
        )

    def test_negative_runtime_bucket_reverses_transfer_direction(self) -> None:
        with Session(self.engine) as session:
            winning_bucket = _runtime_bucket()
            losing_bucket = _runtime_bucket()
            losing_bucket.run_id = "runtime-run-loss"
            losing_bucket.gross_strategy_pnl = Decimal("-3.00")
            losing_bucket.cost_amount = Decimal("0.50")
            losing_bucket.net_strategy_pnl_after_costs = Decimal("-3.50")
            session.add_all([winning_bucket, losing_bucket])
            session.flush()
            client = FakeTigerBeetleClient()
            journal = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=client,
            )

            winning_ref = journal.journal_runtime_ledger_bucket(session, winning_bucket)
            losing_ref = journal.journal_runtime_ledger_bucket(session, losing_bucket)

            self.assertIsNotNone(winning_ref)
            self.assertIsNotNone(losing_ref)
            assert winning_ref is not None
            assert losing_ref is not None
            self.assertEqual(winning_ref.payload_json["pnl_direction"], "profit")
            self.assertEqual(losing_ref.payload_json["pnl_direction"], "loss")
            self.assertEqual(losing_ref.payload_json["signed_amount_micros"], -3500000)
            winning_transfer = client.transfers[int(winning_ref.transfer_id)]
            losing_transfer = client.transfers[int(losing_ref.transfer_id)]
            self.assertEqual(
                getattr(winning_transfer, "debit_account_id"),
                getattr(losing_transfer, "credit_account_id"),
            )
            self.assertNotEqual(
                getattr(losing_transfer, "debit_account_id"),
                getattr(losing_transfer, "credit_account_id"),
            )
            self.assertNotEqual(
                getattr(winning_transfer, "debit_account_id"),
                getattr(losing_transfer, "debit_account_id"),
            )

    def test_source_journals_noop_when_disabled_or_amount_missing(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-noop-sources")
            execution = event.execution
            self.assertIsNotNone(execution)
            assert execution is not None
            metric = ExecutionTCAMetric(
                execution_id=execution.id,
                trade_decision_id=event.trade_decision_id,
                strategy_id=event.trade_decision.strategy_id
                if event.trade_decision
                else None,
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

            disabled = TigerBeetleLedgerJournal(
                settings_obj=_settings(enabled=False),
                client=FakeTigerBeetleClient(),
            )
            self.assertIsNone(disabled.journal_execution(session, execution))
            self.assertIsNone(disabled.journal_execution_tca_metric(session, metric))
            self.assertIsNone(disabled.journal_runtime_ledger_bucket(session, bucket))

            execution.avg_fill_price = None
            enabled = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=FakeTigerBeetleClient(),
            )
            self.assertIsNone(enabled.journal_execution(session, execution))
            self.assertIsNone(enabled.journal_execution_tca_metric(session, metric))
            self.assertIsNone(enabled.journal_runtime_ledger_bucket(session, bucket))

    def test_existing_transfer_ref_backfills_source_metadata(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-backfill-ref")
            amount = decimal_usd_to_micros(
                event_amount_usd(event, TRANSFER_KIND_FILL_POST) or Decimal("0")
            )
            accounts = {
                spec.account_key: spec for spec in order_event_account_specs(event)
            }
            expected = order_event_transfer_spec(
                event,
                transfer_kind=TRANSFER_KIND_FILL_POST,
                amount=amount,
                accounts=accounts,
                use_pending_transfer=False,
            )
            existing = TigerBeetleTransferRef(
                cluster_id=2001,
                transfer_id=str(expected.transfer_id),
                transfer_kind=expected.transfer_kind,
                ledger=expected.ledger,
                code=expected.code,
                amount=Decimal(expected.amount),
                status="created",
                payload_json={"legacy": "ref"},
            )
            session.add(existing)
            session.flush()

            ref = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=FakeTigerBeetleClient(),
            ).journal_order_event(session, event)

            self.assertIsNotNone(ref)
            assert ref is not None
            self.assertEqual(ref.id, existing.id)
            self.assertEqual(ref.trade_decision_id, event.trade_decision_id)
            self.assertEqual(ref.execution_id, event.execution_id)
            self.assertEqual(ref.execution_order_event_id, event.id)
            self.assertEqual(ref.source_type, "execution_order_event")
            self.assertEqual(ref.source_id, str(event.id))
            self.assertEqual(ref.event_fingerprint, event.event_fingerprint)
            self.assertEqual(ref.payload_json["legacy"], "ref")
            self.assertEqual(ref.payload_json["source"], "execution_order_event")

    def test_duplicate_transfer_exists_is_verified_before_ref_persist(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-exists")
            client = FakeTigerBeetleClient()
            amount = decimal_usd_to_micros(
                event_amount_usd(event, TRANSFER_KIND_FILL_POST) or Decimal("0")
            )
            accounts = {
                spec.account_key: spec for spec in order_event_account_specs(event)
            }
            expected = order_event_transfer_spec(
                event,
                transfer_kind=TRANSFER_KIND_FILL_POST,
                amount=amount,
                accounts=accounts,
                use_pending_transfer=False,
            )
            client.transfers[expected.transfer_id] = expected

            ref = TigerBeetleLedgerJournal(
                settings_obj=_settings(), client=client
            ).journal_order_event(
                session,
                event,
            )

            self.assertIsNotNone(ref)
            self.assertEqual(ref.status, "exists")
            self.assertEqual(ref.transfer_id, str(expected.transfer_id))

    def test_numeric_duplicate_transfer_exists_is_verified_before_ref_persist(
        self,
    ) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(
                session,
                fingerprint="fingerprint-numeric-exists",
            )
            client = NumericExistsFakeTigerBeetleClient()
            amount = decimal_usd_to_micros(
                event_amount_usd(event, TRANSFER_KIND_FILL_POST) or Decimal("0")
            )
            accounts = {
                spec.account_key: spec for spec in order_event_account_specs(event)
            }
            expected = order_event_transfer_spec(
                event,
                transfer_kind=TRANSFER_KIND_FILL_POST,
                amount=amount,
                accounts=accounts,
                use_pending_transfer=False,
            )
            client.transfers[expected.transfer_id] = expected

            ref = TigerBeetleLedgerJournal(
                settings_obj=_settings(), client=client
            ).journal_order_event(
                session,
                event,
            )

            self.assertIsNotNone(ref)
            assert ref is not None
            self.assertEqual(ref.status, "exists")
            self.assertEqual(ref.transfer_id, str(expected.transfer_id))

    def test_duplicate_transfer_conflict_fails_hard(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-conflict")
            client = FakeTigerBeetleClient()
            transfer_id = event_transfer_id(event, TRANSFER_KIND_FILL_POST)
            client.transfers[transfer_id] = TigerBeetleTransferSpec(
                transfer_id=transfer_id,
                transfer_kind=TRANSFER_KIND_FILL_POST,
                debit_account_id=1,
                credit_account_id=2,
                amount=99,
                ledger=LEDGER_USD_MICRO,
                code=2001,
            )

            with self.assertRaisesRegex(
                RuntimeError, "tigerbeetle_duplicate_transfer_conflict"
            ):
                TigerBeetleLedgerJournal(
                    settings_obj=_settings(), client=client
                ).journal_order_event(
                    session,
                    event,
                )

    def test_helper_edge_paths_are_deterministic(self) -> None:
        self.assertEqual(
            result_status(
                SimpleNamespace(status="Result.CREATED"),
                status_type_names=("CreateTransferStatus",),
            ),
            "created",
        )
        self.assertEqual(
            result_status(
                SimpleNamespace(status=46),
                status_type_names=("CreateTransferStatus",),
            ),
            "exists",
        )
        self.assertEqual(
            result_status(
                SimpleNamespace(status=4294967295),
                status_type_names=("CreateTransferStatus",),
            ),
            "created",
        )
        with patch.dict(sys.modules, {"tigerbeetle": None}):
            self.assertEqual(
                result_status(
                    SimpleNamespace(status=46),
                    status_type_names=("CreateTransferStatus",),
                ),
                "exists",
            )
        with patch.dict(sys.modules, {"tigerbeetle": SimpleNamespace()}):
            self.assertEqual(
                result_status(
                    SimpleNamespace(status=1234),
                    status_type_names=("CreateTransferStatus",),
                ),
                "1234",
            )

        class FakeTransferStatuses:
            _IGNORED = 1
            EXISTS = 46

        with patch.dict(
            sys.modules,
            {
                "tigerbeetle": SimpleNamespace(
                    CreateTransferStatus=FakeTransferStatuses,
                    CreateAccountStatus=None,
                )
            },
        ):
            self.assertEqual(
                result_status(
                    SimpleNamespace(status=46),
                    status_type_names=("CreateTransferStatus",),
                ),
                "exists",
            )
            self.assertEqual(
                result_status(
                    SimpleNamespace(status=1),
                    status_type_names=("CreateTransferStatus",),
                ),
                "1",
            )
        self.assertEqual(result_index({"index": "2"}, 0), 2)
        self.assertEqual(
            result_statuses_by_index(
                [{"index": "1", "status": "exists"}],
                count=3,
                default_status="created",
                status_type_names=("CreateTransferStatus",),
            ),
            {0: "created", 1: "exists", 2: "created"},
        )
        with self.assertRaisesRegex(
            RuntimeError,
            "tigerbeetle_result_index_invalid:not-int",
        ):
            result_index({"index": "not-int"}, 0)
        with self.assertRaisesRegex(
            RuntimeError,
            "tigerbeetle_result_index_out_of_range:3",
        ):
            result_statuses_by_index(
                [{"index": 3, "status": "exists"}],
                count=1,
                default_status="created",
                status_type_names=("CreateTransferStatus",),
            )
        self.assertEqual(transfer_attr({"transfer_id": 123}, "id"), 123)
        self.assertEqual(transfer_attr(SimpleNamespace(transfer_id=456), "id"), 456)
        with self.assertRaises(AttributeError):
            transfer_attr(object(), "id")
        self.assertIsNone(lookup_payload_decimal({"amount": "bad"}, ("amount",)))
        base_account = TigerBeetleAccountSpec(
            account_id=101,
            account_key="paper:AAPL:cash",
            ledger=LEDGER_USD_MICRO,
            code=1001,
        )
        duplicate_account = TigerBeetleAccountSpec(
            account_id=101,
            account_key="paper:AAPL:cash",
            ledger=LEDGER_USD_MICRO,
            code=1001,
        )
        self.assertEqual(
            dedupe_account_specs([base_account, duplicate_account]),
            [base_account],
        )
        conflicting_account = TigerBeetleAccountSpec(
            account_id=101,
            account_key="paper:AAPL:cash",
            ledger=LEDGER_USD_MICRO,
            code=1002,
        )
        with self.assertRaisesRegex(
            RuntimeError,
            "tigerbeetle_account_spec_conflict",
        ):
            dedupe_account_specs([base_account, conflicting_account])

    def test_event_amount_uses_notional_and_payload_fallbacks(self) -> None:
        notional_event = ExecutionOrderEvent(
            event_fingerprint="amount-notional",
            source_topic="torghut.trade-updates.v1",
            source_partition=0,
            source_offset=1,
            alpaca_account_label="paper",
            event_ts=datetime.now(timezone.utc),
            symbol="AAPL",
            event_type="fill",
            status="filled",
            raw_event={"notional": "-12.34"},
        )
        self.assertEqual(
            event_amount_usd(notional_event, TRANSFER_KIND_FILL_POST),
            Decimal("12.34"),
        )

        raw_payload_event = ExecutionOrderEvent(
            event_fingerprint="amount-raw",
            source_topic="torghut.trade-updates.v1",
            source_partition=0,
            source_offset=1,
            alpaca_account_label="paper",
            event_ts=datetime.now(timezone.utc),
            symbol="AAPL",
            event_type="fill",
            status="filled",
            raw_event={"notional": "bad", "qty": "2", "price": "10"},
        )
        self.assertEqual(
            event_amount_usd(raw_payload_event, TRANSFER_KIND_FILL_POST),
            Decimal("20"),
        )

        explicit_delta_event = ExecutionOrderEvent(
            event_fingerprint="amount-explicit-delta",
            source_topic="torghut.trade-updates.v1",
            source_partition=0,
            source_offset=1,
            alpaca_account_label="paper",
            event_ts=datetime.now(timezone.utc),
            symbol="AAPL",
            event_type="fill",
            status="filled",
            raw_event={"fill_notional": "7.25", "notional": "100"},
        )
        self.assertEqual(
            event_amount_usd(explicit_delta_event, TRANSFER_KIND_FILL_POST),
            Decimal("7.25"),
        )

        nested_payload_event = ExecutionOrderEvent(
            event_fingerprint="amount-nested",
            source_topic="torghut.trade-updates.v1",
            source_partition=0,
            source_offset=1,
            alpaca_account_label="paper",
            event_ts=datetime.now(timezone.utc),
            symbol="AAPL",
            event_type="submitted",
            status="submitted",
            qty=Decimal("3"),
            raw_event={"order": {"price": "11"}},
        )
        self.assertEqual(
            event_amount_usd(nested_payload_event, TRANSFER_KIND_SUBMITTED_PENDING),
            Decimal("33"),
        )

        missing_payload_event = ExecutionOrderEvent(
            event_fingerprint="amount-missing",
            source_topic="torghut.trade-updates.v1",
            source_partition=0,
            source_offset=1,
            alpaca_account_label="paper",
            event_ts=datetime.now(timezone.utc),
            symbol="AAPL",
            event_type="fill",
            status="filled",
            raw_event={"event": "fill"},
        )
        self.assertIsNone(
            event_amount_usd(missing_payload_event, TRANSFER_KIND_FILL_POST)
        )

    def test_fill_event_amount_uses_incremental_notional_delta(self) -> None:
        with Session(self.engine) as session:
            first = _create_fill_event(session, fingerprint="partial-fill-delta-1")
            first.alpaca_order_id = "shared-order"
            first.client_order_id = "shared-client"
            first.event_type = "partial_fill"
            first.status = "partially_filled"
            first.qty = Decimal("2")
            first.filled_qty = Decimal("1")
            first.avg_fill_price = Decimal("190.20")
            first.source_offset = 10

            second = _create_fill_event(session, fingerprint="partial-fill-delta-2")
            second.alpaca_order_id = "shared-order"
            second.client_order_id = "shared-client"
            second.event_type = "fill"
            second.status = "filled"
            second.qty = Decimal("2")
            second.filled_qty = Decimal("2")
            second.avg_fill_price = Decimal("190.40")
            second.source_offset = 11
            duplicate_cumulative = _create_fill_event(
                session, fingerprint="partial-fill-delta-3"
            )
            duplicate_cumulative.alpaca_order_id = "shared-order"
            duplicate_cumulative.client_order_id = "shared-client"
            duplicate_cumulative.event_type = "fill"
            duplicate_cumulative.status = "filled"
            duplicate_cumulative.qty = Decimal("2")
            duplicate_cumulative.filled_qty = Decimal("2")
            duplicate_cumulative.avg_fill_price = Decimal("190.40")
            duplicate_cumulative.source_offset = 12
            session.add_all([first, second])
            session.flush()

            first_plan = build_order_event_transfer_plan(
                session,
                first,
                settings_obj=_settings(),
            )
            second_plan = build_order_event_transfer_plan(
                session,
                second,
                settings_obj=_settings(),
            )
            duplicate_cumulative_plan = build_order_event_transfer_plan(
                session,
                duplicate_cumulative,
                settings_obj=_settings(),
            )

        self.assertIsNotNone(first_plan)
        self.assertIsNotNone(second_plan)
        assert first_plan is not None
        assert second_plan is not None
        self.assertEqual(first_plan.transfer_spec.amount, 190200000)
        self.assertEqual(second_plan.transfer_spec.amount, 190600000)
        self.assertIsNone(duplicate_cumulative_plan)

    def test_fill_event_amount_prefers_raw_execution_delta_over_cumulative_average(
        self,
    ) -> None:
        event = ExecutionOrderEvent(
            event_fingerprint="crypto-partial-fill-raw-execution",
            source_topic="torghut.trade-updates.v2",
            source_partition=0,
            source_offset=66074,
            alpaca_account_label="PA3SX7FYNUTF",
            event_ts=datetime.now(timezone.utc),
            symbol="BTC/USD",
            alpaca_order_id="crypto-order",
            client_order_id="crypto-client",
            event_type="fill",
            status="filled",
            qty=Decimal("0.000449274"),
            filled_qty=Decimal("0.000449274"),
            filled_qty_delta=Decimal("0.000229274"),
            avg_fill_price=Decimal("64747.862313288"),
            filled_notional_delta=Decimal("14.84500138"),
            fill_quantity_basis="cumulative_to_delta",
            raw_event={
                "channel": "trade_updates",
                "payload": {
                    "event": "fill",
                    "qty": "0.000229274",
                    "price": "64729.4",
                    "order": {
                        "filled_qty": "0.000449274",
                        "filled_avg_price": "64747.862313288",
                    },
                },
            },
        )

        with Session(self.engine) as session:
            session.add(event)
            session.flush()
            plan = build_order_event_transfer_plan(
                session,
                event,
                settings_obj=_settings(),
            )

        self.assertIsNotNone(plan)
        assert plan is not None
        self.assertEqual(plan.transfer_spec.amount, 14840768)

    def test_order_event_precedence_falls_back_deterministically(self) -> None:
        older = ExecutionOrderEvent(
            event_fingerprint="older",
            source_topic="torghut.trade-updates.v1",
            source_partition=0,
            source_offset=None,
            alpaca_account_label="paper",
            symbol="AAPL",
            event_type="fill",
            status="filled",
            feed_seq=10,
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            created_at=datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc),
        )
        newer = ExecutionOrderEvent(
            event_fingerprint="newer",
            source_topic="torghut.trade-updates.v1",
            source_partition=0,
            source_offset=None,
            alpaca_account_label="paper",
            symbol="AAPL",
            event_type="fill",
            status="filled",
            feed_seq=11,
            event_ts=datetime(2026, 1, 1, 0, 1, tzinfo=timezone.utc),
            created_at=datetime(2026, 1, 1, 0, 1, tzinfo=timezone.utc),
        )

        self.assertTrue(order_event_precedes(older, newer))

        older.feed_seq = None
        newer.feed_seq = None
        self.assertTrue(order_event_precedes(older, newer))

        older.event_ts = None
        newer.event_ts = None
        self.assertTrue(order_event_precedes(older, newer))

    def test_transfer_specs_cover_pending_and_void_paths(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-submitted")
            accounts = {
                spec.account_key: spec for spec in order_event_account_specs(event)
            }

            submitted = order_event_transfer_spec(
                event,
                transfer_kind=TRANSFER_KIND_SUBMITTED_PENDING,
                amount=100,
                accounts=accounts,
            )
            canceled = order_event_transfer_spec(
                event,
                transfer_kind=TRANSFER_KIND_CANCEL_VOID,
                amount=100,
                accounts=accounts,
            )

        self.assertEqual(submitted.transfer_kind, TRANSFER_KIND_SUBMITTED_PENDING)
        self.assertEqual(canceled.transfer_kind, TRANSFER_KIND_CANCEL_VOID)
        self.assertNotEqual(canceled.pending_id, 0)

    def test_void_transfer_requires_pending_mode(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-void-required")
            accounts = {
                spec.account_key: spec for spec in order_event_account_specs(event)
            }

            with self.assertRaisesRegex(
                ValueError,
                "tigerbeetle_pending_transfer_required_for_void",
            ):
                order_event_transfer_spec(
                    event,
                    transfer_kind=TRANSFER_KIND_CANCEL_VOID,
                    amount=100,
                    accounts=accounts,
                    use_pending_transfer=False,
                )

    def test_transfer_plan_derives_void_amount_from_pending_ref(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-void-amount")
            event.event_type = "canceled"
            event.status = "canceled"
            event.qty = None
            event.filled_qty = None
            event.avg_fill_price = None
            event.raw_event = {"event": "canceled"}
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=_settings().tigerbeetle_cluster_id,
                    transfer_id=str(submitted_pending_transfer_id(event)),
                    transfer_kind=TRANSFER_KIND_SUBMITTED_PENDING,
                    ledger=LEDGER_USD_MICRO,
                    code=2000,
                    amount=Decimal("123000000"),
                    status="created",
                    event_fingerprint="fingerprint-void-amount-submitted",
                )
            )
            session.flush()

            plan = build_order_event_transfer_plan(
                session,
                event,
                settings_obj=_settings(),
            )

            self.assertIsNotNone(plan)
            assert plan is not None
            self.assertEqual(plan.transfer_spec.amount, 123000000)

    def test_transfer_plan_skips_void_without_pending_ref(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-void-skip")
            event.event_type = "canceled"
            event.status = "canceled"

            self.assertIsNone(
                build_order_event_transfer_plan(
                    session,
                    event,
                    settings_obj=_settings(),
                )
            )

    def test_transfer_flag_handles_missing_module_and_missing_flags(self) -> None:
        with patch.dict(sys.modules, {"tigerbeetle": None}):
            self.assertEqual(transfer_flag("PENDING"), 0)
        with patch.dict(sys.modules, {"tigerbeetle": SimpleNamespace()}):
            self.assertEqual(transfer_flag("PENDING"), 0)
        self.assertEqual(transfer_flag("DOES_NOT_EXIST"), 0)

    def test_journal_reuses_existing_account_refs_for_distinct_events(self) -> None:
        with Session(self.engine) as session:
            first = _create_fill_event(session, fingerprint="fingerprint-ref-1")
            second = _create_fill_event(session, fingerprint="fingerprint-ref-2")
            client = FakeTigerBeetleClient()
            journal = TigerBeetleLedgerJournal(settings_obj=_settings(), client=client)

            journal.journal_order_event(session, first)
            journal.journal_order_event(session, second)

            cash_refs = [
                ref
                for ref in client.accounts.values()
                if getattr(ref, "account_key", "") == "cash:paper:usd"
            ]
            self.assertEqual(len(cash_refs), 1)
            account_refs = (
                session.execute(select(TigerBeetleAccountRef)).scalars().all()
            )
            self.assertGreaterEqual(len(account_refs), 5)
