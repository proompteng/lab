from __future__ import annotations

from tests.tigerbeetle_reconcile.support import (
    BLOCKER_AMOUNT_MISMATCH,
    BLOCKER_POSTGRES_REF_MISMATCH,
    BLOCKER_SOURCE_AMOUNT_MISMATCH,
    BLOCKER_SOURCE_ROW_MISSING,
    BLOCKER_TRANSFER_MISSING,
    CloseTrackingClient,
    Decimal,
    Execution,
    ExecutionOrderEvent,
    FakeTigerBeetleClient,
    LEDGER_USD_MICRO,
    SOURCE_TYPE_EXECUTION,
    SOURCE_TYPE_EXECUTION_ORDER_EVENT,
    SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
    StableRefPayloadInput,
    Session,
    TRANSFER_CODE_EXECUTION_FILL,
    TRANSFER_CODE_FILL_POST,
    TRANSFER_CODE_RUNTIME_NET_PNL,
    TRANSFER_CODE_SUBMITTED_PENDING,
    TRANSFER_KIND_EXECUTION_FILL,
    TRANSFER_KIND_RUNTIME_NET_PNL,
    TRANSFER_KIND_SUBMITTED_PENDING,
    TigerBeetleReconciliationRun,
    TigerBeetleTransferRef,
    TigerBeetleTransferSpec,
    _TestTigerBeetleReconcileBase,
    _add_account_refs_for_plan,
    _add_ref,
    _payload_string_list,
    _runtime_bucket,
    _runtime_ledger_payload_account_ids,
    _settings,
    _stable_ref_archives_event_transfer,
    _transfer,
    _usd_to_micros,
    build_order_event_transfer_plan,
    build_runtime_ledger_bucket_transfer_plan,
    datetime,
    latest_tigerbeetle_reconciliation_status_payload,
    patch,
    reconcile_tigerbeetle_transfers,
    select,
    submitted_pending_transfer_id,
    tigerbeetle_stable_ref_payload,
    timezone,
    uuid4,
)


class TestReconciliationPassesWhenPostgresRefsMatchTigerbeetle(
    _TestTigerBeetleReconcileBase
):
    def test_reconciliation_passes_when_postgres_refs_match_tigerbeetle(self) -> None:
        with Session(self.engine) as session:
            _add_ref(session)
            client = FakeTigerBeetleClient()
            client.transfers[1001] = _transfer()

            payload = reconcile_tigerbeetle_transfers(
                session, settings_obj=_settings(), client=client
            )

            self.assertTrue(payload["ok"])
            self.assertEqual(payload["blockers"], [])
            self.assertEqual(payload["checked_transfer_count"], 1)
            run = session.execute(select(TigerBeetleReconciliationRun)).scalar_one()
            self.assertEqual(run.blockers_json, [])
            self.assertEqual(run.transfer_ref_count, 1)
            self.assertIsInstance(run.ref_counts_json, dict)
            compact_payload = latest_tigerbeetle_reconciliation_status_payload(
                session,
                cluster_id=2001,
            )
            self.assertIsNotNone(compact_payload)
            assert compact_payload is not None
            self.assertTrue(compact_payload["compact_status"])
            self.assertEqual(compact_payload["transfer_ref_count"], 1)

    def test_reconciliation_closes_owned_tigerbeetle_client(self) -> None:
        with Session(self.engine) as session:
            _add_ref(session)
            client = CloseTrackingClient()
            client.transfers[1001] = _transfer()

            with patch(
                "app.trading.tigerbeetle_reconcile.latest_tigerbeetle_reconciliation_status_p.create_tigerbeetle_client",
                return_value=client,
            ):
                payload = reconcile_tigerbeetle_transfers(
                    session,
                    settings_obj=_settings(),
                )

            self.assertTrue(payload["ok"])
            self.assertTrue(client.closed)

    def test_reconciliation_does_not_close_injected_tigerbeetle_client(self) -> None:
        with Session(self.engine) as session:
            _add_ref(session)
            client = CloseTrackingClient()
            client.transfers[1001] = _transfer()

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
            )

            self.assertTrue(payload["ok"])
            self.assertFalse(client.closed)

    def test_reconciliation_blocks_missing_tigerbeetle_transfer(self) -> None:
        with Session(self.engine) as session:
            _add_ref(session)

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=FakeTigerBeetleClient(),
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_TRANSFER_MISSING, payload["blockers"])

    def test_reconciliation_blocks_amount_mismatch(self) -> None:
        with Session(self.engine) as session:
            _add_ref(session)
            client = FakeTigerBeetleClient()
            client.transfers[1001] = _transfer(amount=1)

            payload = reconcile_tigerbeetle_transfers(
                session, settings_obj=_settings(), client=client
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_AMOUNT_MISMATCH, payload["blockers"])

    def test_source_amount_micros_rounds_real_broker_notional(self) -> None:
        self.assertEqual(_usd_to_micros(Decimal("1.0000004")), Decimal("1000000"))
        self.assertEqual(_usd_to_micros(Decimal("1.0000005")), Decimal("1000001"))

    def test_reconciliation_blocks_source_amount_mismatch(self) -> None:
        with Session(self.engine) as session:
            execution = Execution(
                alpaca_account_label="paper",
                alpaca_order_id="order-source-mismatch",
                client_order_id="client-source-mismatch",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.25"),
                status="filled",
                raw_order={"id": "order-source-mismatch"},
            )
            session.add(execution)
            session.flush()
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=2001,
                    transfer_id="1002",
                    transfer_kind="execution_fill",
                    ledger=LEDGER_USD_MICRO,
                    code=TRANSFER_CODE_EXECUTION_FILL,
                    amount=Decimal("1"),
                    status="created",
                    execution_id=execution.id,
                    source_type="execution",
                    source_id=f"{execution.id}:current",
                )
            )
            session.flush()
            client = FakeTigerBeetleClient()
            client.transfers[1002] = TigerBeetleTransferSpec(
                transfer_id=1002,
                transfer_kind="execution_fill",
                debit_account_id=11,
                credit_account_id=12,
                amount=1,
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_EXECUTION_FILL,
            )

            payload = reconcile_tigerbeetle_transfers(
                session, settings_obj=_settings(), client=client
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_SOURCE_AMOUNT_MISMATCH, payload["blockers"])
            self.assertEqual(payload["source_amount_mismatch_count"], 1)

    def test_reconciliation_reports_legacy_unversioned_source_amount_without_blocking(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = Execution(
                alpaca_account_label="paper",
                alpaca_order_id="order-legacy-source",
                client_order_id="client-legacy-source",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.25"),
                status="filled",
                raw_order={"id": "order-legacy-source"},
            )
            session.add(execution)
            session.flush()
            ref = TigerBeetleTransferRef(
                cluster_id=2001,
                transfer_id="1004",
                transfer_kind=TRANSFER_KIND_EXECUTION_FILL,
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_EXECUTION_FILL,
                amount=Decimal("1"),
                status="created",
                execution_id=execution.id,
                source_type=SOURCE_TYPE_EXECUTION,
                source_id=str(execution.id),
            )
            session.add(ref)
            session.flush()
            client = FakeTigerBeetleClient()
            client.transfers[1004] = TigerBeetleTransferSpec(
                transfer_id=1004,
                transfer_kind=TRANSFER_KIND_EXECUTION_FILL,
                debit_account_id=11,
                credit_account_id=12,
                amount=1,
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_EXECUTION_FILL,
            )

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
            )

            self.assertTrue(payload["ok"])
            self.assertNotIn(BLOCKER_SOURCE_AMOUNT_MISMATCH, payload["blockers"])
            self.assertEqual(payload["source_amount_mismatch_count"], 0)
            self.assertEqual(payload["legacy_source_amount_unverifiable_count"], 1)
            legacy_refs = payload["legacy_source_amount_unverifiable_refs"]
            assert isinstance(legacy_refs, list)
            self.assertEqual(legacy_refs[0]["row_id"], str(ref.id))

    def test_reconciliation_blocks_source_row_missing(self) -> None:
        with Session(self.engine) as session:
            missing_id = "6f767a53-6b44-428a-bd85-2f662642f637"
            missing_ref = TigerBeetleTransferRef(
                cluster_id=2001,
                transfer_id="1003",
                transfer_kind="execution_fill",
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_EXECUTION_FILL,
                amount=Decimal("190250000"),
                status="created",
                source_type="execution",
                source_id=missing_id,
            )
            session.add(missing_ref)
            session.flush()
            client = FakeTigerBeetleClient()
            client.transfers[1003] = TigerBeetleTransferSpec(
                transfer_id=1003,
                transfer_kind="execution_fill",
                debit_account_id=11,
                credit_account_id=12,
                amount=190250000,
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_EXECUTION_FILL,
            )

            payload = reconcile_tigerbeetle_transfers(
                session, settings_obj=_settings(), client=client
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_SOURCE_ROW_MISSING, payload["blockers"])
            self.assertEqual(payload["source_row_missing_count"], 1)
            self.assertEqual(payload["missing_source_row_count"], 1)
            self.assertEqual(payload["source_missing_count"], 1)
            missing_source_rows = payload["missing_source_rows"]
            assert isinstance(missing_source_rows, list)
            self.assertEqual(missing_source_rows[0]["row_id"], str(missing_ref.id))
            self.assertEqual(missing_source_rows[0]["source_id"], missing_id)

    def test_reconciliation_accepts_historical_standalone_fill_when_pending_ref_arrives_later(
        self,
    ) -> None:
        with Session(self.engine) as session:
            event = ExecutionOrderEvent(
                event_fingerprint="standalone-fill-before-pending",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=2,
                alpaca_account_label="paper",
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                event_type="fill",
                status="filled",
                qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.25"),
                raw_event={"event": "fill"},
            )
            session.add(event)
            session.flush()
            plan = build_order_event_transfer_plan(
                session, event, settings_obj=_settings()
            )
            self.assertIsNotNone(plan)
            assert plan is not None
            transfer = plan.transfer_spec
            pending_transfer_id = submitted_pending_transfer_id(event)
            session.add_all(
                [
                    TigerBeetleTransferRef(
                        cluster_id=2001,
                        transfer_id=str(transfer.transfer_id),
                        transfer_kind=transfer.transfer_kind,
                        ledger=transfer.ledger,
                        code=transfer.code,
                        amount=Decimal(transfer.amount),
                        status="created",
                        execution_order_event_id=event.id,
                        source_type=SOURCE_TYPE_EXECUTION_ORDER_EVENT,
                        source_id=str(event.id),
                        event_fingerprint=event.event_fingerprint,
                        payload_json={
                            "debit_account_id": f"{transfer.debit_account_id}.0",
                            "credit_account_id": str(transfer.credit_account_id),
                            "pending_mode": "standalone_fill",
                            "source": SOURCE_TYPE_EXECUTION_ORDER_EVENT,
                        },
                    ),
                    TigerBeetleTransferRef(
                        cluster_id=2001,
                        transfer_id=str(pending_transfer_id),
                        transfer_kind=TRANSFER_KIND_SUBMITTED_PENDING,
                        ledger=LEDGER_USD_MICRO,
                        code=TRANSFER_CODE_SUBMITTED_PENDING,
                        amount=Decimal(transfer.amount),
                        status="created",
                    ),
                ]
            )
            session.flush()
            client = FakeTigerBeetleClient()
            client.transfers[transfer.transfer_id] = {
                "transfer_id": Decimal(transfer.transfer_id),
                "amount": str(transfer.amount),
                "ledger": str(transfer.ledger),
                "code": str(transfer.code),
                "debit_account_id": Decimal(transfer.debit_account_id),
                "credit_account_id": str(transfer.credit_account_id),
            }
            client.transfers[pending_transfer_id] = TigerBeetleTransferSpec(
                transfer_id=pending_transfer_id,
                transfer_kind=TRANSFER_KIND_SUBMITTED_PENDING,
                debit_account_id=11,
                credit_account_id=12,
                amount=transfer.amount,
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_SUBMITTED_PENDING,
            )

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
            )

        self.assertTrue(payload["ok"], payload)
        self.assertNotIn(BLOCKER_POSTGRES_REF_MISMATCH, payload["blockers"])
        self.assertEqual(payload["mismatched_ref_count"], 0)

    def test_reconciliation_accepts_stable_order_event_ref_after_decision_backfill(
        self,
    ) -> None:
        with Session(self.engine) as session:
            event = ExecutionOrderEvent(
                event_fingerprint="standalone-fill-before-decision-linkage",
                source_topic="torghut.trade-updates.v2",
                source_partition=0,
                source_offset=66072,
                alpaca_account_label="PA3SX7FYNUTF",
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                client_order_id="tgpf-20260604200525-aapl-1eb44d6252",
                event_type="partial_fill",
                status="partially_filled",
                qty=Decimal("120.1614"),
                filled_qty=Decimal("0.1614"),
                filled_qty_delta=Decimal("0.1614"),
                avg_fill_price=Decimal("311.01"),
                filled_notional_delta=Decimal("50.197014"),
                fill_quantity_basis="cumulative_to_delta",
                raw_event={
                    "event": "partial_fill",
                    "_torghut_linkage": {
                        "blockers": ["account_mismatch_execution_identity"],
                    },
                },
            )
            session.add(event)
            session.flush()
            plan = build_order_event_transfer_plan(
                session, event, settings_obj=_settings()
            )
            self.assertIsNotNone(plan)
            assert plan is not None
            transfer = plan.transfer_spec
            payload_json = {
                "debit_account_id": str(transfer.debit_account_id),
                "credit_account_id": str(transfer.credit_account_id),
                "pending_mode": plan.pending_mode,
                "source": SOURCE_TYPE_EXECUTION_ORDER_EVENT,
            }
            stable_payload = tigerbeetle_stable_ref_payload(
                StableRefPayloadInput(
                    cluster_id=2001,
                    account_specs=plan.account_specs,
                    transfer_spec=transfer,
                    source_type=SOURCE_TYPE_EXECUTION_ORDER_EVENT,
                    source_id=str(event.id),
                    payload_json=payload_json,
                    event_fingerprint=event.event_fingerprint,
                )
            )
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=2001,
                    transfer_id=str(transfer.transfer_id),
                    transfer_kind=transfer.transfer_kind,
                    ledger=transfer.ledger,
                    code=transfer.code,
                    amount=Decimal(transfer.amount),
                    status="created",
                    execution_order_event_id=event.id,
                    source_type=SOURCE_TYPE_EXECUTION_ORDER_EVENT,
                    source_id=str(event.id),
                    event_fingerprint=event.event_fingerprint,
                    payload_json={**payload_json, **stable_payload},
                )
            )
            event.trade_decision_id = uuid4()
            session.flush()
            current_plan = build_order_event_transfer_plan(
                session, event, settings_obj=_settings()
            )
            self.assertIsNotNone(current_plan)
            assert current_plan is not None
            self.assertNotEqual(
                transfer.credit_account_id,
                current_plan.transfer_spec.credit_account_id,
            )

            client = FakeTigerBeetleClient()
            client.transfers[transfer.transfer_id] = transfer

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
            )

        self.assertTrue(payload["ok"], payload)
        self.assertNotIn(BLOCKER_POSTGRES_REF_MISMATCH, payload["blockers"])
        self.assertEqual(payload["mismatched_transfer_count"], 0)

    def test_stable_order_event_archive_requires_stable_payload(self) -> None:
        with Session(self.engine) as session:
            event = ExecutionOrderEvent(
                event_fingerprint="missing-stable-ref-payload",
                source_topic="torghut.trade-updates.v2",
                source_partition=0,
                source_offset=66073,
                alpaca_account_label="paper",
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                event_type="fill",
                status="filled",
                qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.25"),
                raw_event={"event": "fill"},
            )
            session.add(event)
            session.flush()
            ref = TigerBeetleTransferRef(
                cluster_id=2001,
                transfer_id="1001",
                transfer_kind="fill_post",
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_FILL_POST,
                amount=Decimal("190250000"),
                status="created",
                execution_order_event_id=event.id,
                source_type=SOURCE_TYPE_EXECUTION_ORDER_EVENT,
                source_id=str(event.id),
                event_fingerprint=event.event_fingerprint,
                payload_json={"source": SOURCE_TYPE_EXECUTION_ORDER_EVENT},
            )

            self.assertFalse(_stable_ref_archives_event_transfer(ref, event))

    def test_stable_order_event_archive_rejects_malformed_stable_payload(self) -> None:
        with Session(self.engine) as session:
            event = ExecutionOrderEvent(
                event_fingerprint="malformed-stable-ref-payload",
                source_topic="torghut.trade-updates.v2",
                source_partition=0,
                source_offset=66074,
                alpaca_account_label="paper",
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                event_type="fill",
                status="filled",
                qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.25"),
                raw_event={"event": "fill"},
            )
            session.add(event)
            session.flush()
            plan = build_order_event_transfer_plan(
                session, event, settings_obj=_settings()
            )
            self.assertIsNotNone(plan)
            assert plan is not None
            transfer = plan.transfer_spec
            payload_json = {
                "debit_account_id": str(transfer.debit_account_id),
                "credit_account_id": str(transfer.credit_account_id),
                "pending_mode": plan.pending_mode,
                "source": SOURCE_TYPE_EXECUTION_ORDER_EVENT,
            }
            stable_payload = tigerbeetle_stable_ref_payload(
                StableRefPayloadInput(
                    cluster_id=2001,
                    account_specs=plan.account_specs,
                    transfer_spec=transfer,
                    source_type=SOURCE_TYPE_EXECUTION_ORDER_EVENT,
                    source_id=str(event.id),
                    payload_json=payload_json,
                    event_fingerprint=event.event_fingerprint,
                )
            )
            stable_ref = stable_payload["stable_ref"]
            assert isinstance(stable_ref, dict)
            stable_ref["stable_ref_id"] = "bad-stable-ref-id"
            ref = TigerBeetleTransferRef(
                cluster_id=2001,
                transfer_id=str(transfer.transfer_id),
                transfer_kind=transfer.transfer_kind,
                ledger=transfer.ledger,
                code=transfer.code,
                amount=Decimal(transfer.amount),
                status="created",
                execution_order_event_id=event.id,
                source_type=SOURCE_TYPE_EXECUTION_ORDER_EVENT,
                source_id=str(event.id),
                event_fingerprint=event.event_fingerprint,
                payload_json={**payload_json, **stable_payload},
            )

            self.assertFalse(_stable_ref_archives_event_transfer(ref, event))

    def test_reconciliation_blocks_order_event_ref_when_core_transfer_changes(
        self,
    ) -> None:
        with Session(self.engine) as session:
            event = ExecutionOrderEvent(
                event_fingerprint="core-transfer-amount-drift",
                source_topic="torghut.trade-updates.v2",
                source_partition=0,
                source_offset=66075,
                alpaca_account_label="paper",
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                event_type="fill",
                status="filled",
                qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.25"),
                raw_event={"event": "fill"},
            )
            session.add(event)
            session.flush()
            plan = build_order_event_transfer_plan(
                session, event, settings_obj=_settings()
            )
            self.assertIsNotNone(plan)
            assert plan is not None
            transfer = plan.transfer_spec
            drifted_amount = transfer.amount + 1
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=2001,
                    transfer_id=str(transfer.transfer_id),
                    transfer_kind=transfer.transfer_kind,
                    ledger=transfer.ledger,
                    code=transfer.code,
                    amount=Decimal(drifted_amount),
                    status="created",
                    execution_order_event_id=event.id,
                    source_type=SOURCE_TYPE_EXECUTION_ORDER_EVENT,
                    source_id=str(event.id),
                    event_fingerprint=event.event_fingerprint,
                    payload_json={
                        "debit_account_id": str(transfer.debit_account_id),
                        "credit_account_id": str(transfer.credit_account_id),
                        "pending_mode": plan.pending_mode,
                        "source": SOURCE_TYPE_EXECUTION_ORDER_EVENT,
                    },
                )
            )
            session.flush()
            client = FakeTigerBeetleClient()
            client.transfers[transfer.transfer_id] = TigerBeetleTransferSpec(
                transfer_id=transfer.transfer_id,
                transfer_kind=transfer.transfer_kind,
                debit_account_id=transfer.debit_account_id,
                credit_account_id=transfer.credit_account_id,
                amount=drifted_amount,
                ledger=transfer.ledger,
                code=transfer.code,
            )

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
            )

        self.assertFalse(payload["ok"], payload)
        self.assertIn(BLOCKER_POSTGRES_REF_MISMATCH, payload["blockers"])
        self.assertEqual(payload["mismatched_transfer_count"], 1)

    def test_runtime_payload_account_ids_normalize_sequence_scalar_and_missing_values(
        self,
    ) -> None:
        self.assertEqual(
            _payload_string_list({"account_ids": ["11", None, 12]}, "account_ids"),
            ["11", "12"],
        )
        self.assertEqual(
            _payload_string_list({"account_ids": "11"}, "account_ids"), ["11"]
        )

        ref = TigerBeetleTransferRef(
            cluster_id=2001,
            transfer_id="runtime-account-ref",
            transfer_kind=TRANSFER_KIND_RUNTIME_NET_PNL,
            ledger=LEDGER_USD_MICRO,
            code=TRANSFER_CODE_RUNTIME_NET_PNL,
            amount=Decimal("2500000"),
            status="created",
            source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
            source_id="runtime-source",
            payload_json={
                "account_ids": ["11"],
                "debit_account_id": None,
                "credit_account_id": "12",
            },
        )

        self.assertEqual(_runtime_ledger_payload_account_ids(ref), ["11", "12"])

    def test_reconciliation_accepts_signed_runtime_ledger_profit_and_loss_refs(
        self,
    ) -> None:
        with Session(self.engine) as session:
            profit_bucket = _runtime_bucket(net_pnl=Decimal("2.50"))
            loss_bucket = _runtime_bucket(net_pnl=Decimal("-3.50"))
            session.add_all([profit_bucket, loss_bucket])
            session.flush()
            client = FakeTigerBeetleClient()
            for bucket in (profit_bucket, loss_bucket):
                plan = build_runtime_ledger_bucket_transfer_plan(bucket)
                self.assertIsNotNone(plan)
                assert plan is not None
                _add_account_refs_for_plan(session, plan)
                transfer = plan.transfer_spec
                session.add(
                    TigerBeetleTransferRef(
                        cluster_id=2001,
                        transfer_id=str(transfer.transfer_id),
                        transfer_kind=transfer.transfer_kind,
                        ledger=transfer.ledger,
                        code=transfer.code,
                        amount=Decimal(transfer.amount),
                        status="created",
                        runtime_ledger_bucket_id=bucket.id,
                        source_type="strategy_runtime_ledger_bucket",
                        source_id=str(bucket.id),
                        payload_json={
                            "source": "strategy_runtime_ledger_bucket",
                            "run_id": bucket.run_id,
                            "candidate_id": bucket.candidate_id,
                            "hypothesis_id": bucket.hypothesis_id,
                            "observed_stage": bucket.observed_stage,
                            "pnl_basis": bucket.pnl_basis,
                            "ledger_schema_version": bucket.ledger_schema_version,
                            "amount_source": str(plan.amount_source),
                            "signed_amount_micros": plan.signed_amount_micros,
                            "pnl_direction": plan.pnl_direction,
                            "runtime_key": plan.runtime_key,
                            "debit_account_id": str(transfer.debit_account_id),
                            "credit_account_id": str(transfer.credit_account_id),
                        },
                    )
                )
                client.transfers[transfer.transfer_id] = transfer
            session.flush()

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
            )

            self.assertTrue(payload["ok"], payload)
            self.assertEqual(payload["runtime_ledger_checked_transfer_count"], 2)
            self.assertEqual(payload["runtime_ledger_signed_transfer_count"], 2)
            self.assertEqual(payload["runtime_ledger_missing_signed_ref_count"], 0)
            self.assertEqual(payload["runtime_ledger_missing_account_ref_count"], 0)
            self.assertFalse(payload["promotion_authority"])
            self.assertFalse(payload["overrides_runtime_ledger_authority"])
            self.assertFalse(payload["reconciliation_stale"])
            freshness = payload["reconciliation_freshness"]
            assert isinstance(freshness, dict)
            self.assertEqual(freshness["age_seconds"], 0)
            self.assertFalse(freshness["stale"])
            ref_counts = payload["ref_counts"]
            assert isinstance(ref_counts, dict)
            self.assertEqual(ref_counts["runtime_ledger_signed_ref_count"], 2)
            self.assertEqual(ref_counts["runtime_ledger_missing_signed_ref_count"], 0)
            self.assertEqual(ref_counts["runtime_ledger_missing_account_ref_count"], 0)
            source_materialization = ref_counts["source_materialization"]
            assert isinstance(source_materialization, dict)
            self.assertEqual(
                source_materialization["runtime_ledger_source_type"],
                SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
            )

    def test_reconciliation_checks_runtime_ledger_refs_outside_recent_sample(
        self,
    ) -> None:
        with Session(self.engine) as session:
            bucket = _runtime_bucket(net_pnl=Decimal("2.50"))
            session.add(bucket)
            session.flush()
            plan = build_runtime_ledger_bucket_transfer_plan(bucket)
            self.assertIsNotNone(plan)
            assert plan is not None
            _add_account_refs_for_plan(session, plan)
            runtime_transfer = plan.transfer_spec
            old_created_at = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=2001,
                    transfer_id=str(runtime_transfer.transfer_id),
                    transfer_kind=runtime_transfer.transfer_kind,
                    ledger=runtime_transfer.ledger,
                    code=runtime_transfer.code,
                    amount=Decimal(runtime_transfer.amount),
                    status="created",
                    runtime_ledger_bucket_id=bucket.id,
                    source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                    source_id=str(bucket.id),
                    created_at=old_created_at,
                    updated_at=old_created_at,
                    payload_json={
                        "source": SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                        "run_id": bucket.run_id,
                        "candidate_id": bucket.candidate_id,
                        "hypothesis_id": bucket.hypothesis_id,
                        "observed_stage": bucket.observed_stage,
                        "pnl_basis": bucket.pnl_basis,
                        "ledger_schema_version": bucket.ledger_schema_version,
                        "amount_source": str(plan.amount_source),
                        "signed_amount_micros": plan.signed_amount_micros,
                        "pnl_direction": plan.pnl_direction,
                        "runtime_key": plan.runtime_key,
                        "debit_account_id": str(runtime_transfer.debit_account_id),
                        "credit_account_id": str(runtime_transfer.credit_account_id),
                    },
                )
            )
            client = FakeTigerBeetleClient()
            client.transfers[runtime_transfer.transfer_id] = runtime_transfer
            for offset, transfer_id in enumerate((1001, 1002, 1003), start=1):
                created_at = datetime(2026, 6, 2, 12, offset, tzinfo=timezone.utc)
                _add_ref(
                    session,
                    transfer_id=str(transfer_id),
                    payload_json={"created_for": "recent_sample"},
                )
                recent_ref = session.execute(
                    select(TigerBeetleTransferRef).where(
                        TigerBeetleTransferRef.transfer_id == str(transfer_id)
                    )
                ).scalar_one()
                recent_ref.created_at = created_at
                recent_ref.updated_at = created_at
                client.transfers[transfer_id] = _transfer(transfer_id=transfer_id)
            session.flush()

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
                limit=2,
            )

            self.assertTrue(payload["ok"], payload)
            self.assertEqual(payload["checked_transfer_count"], 3)
            self.assertEqual(payload["runtime_ledger_checked_transfer_count"], 1)
            self.assertEqual(payload["runtime_ledger_signed_transfer_count"], 1)
            self.assertEqual(payload["runtime_ledger_missing_signed_ref_count"], 0)
