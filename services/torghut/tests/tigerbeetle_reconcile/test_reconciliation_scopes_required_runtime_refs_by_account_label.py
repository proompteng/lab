from __future__ import annotations

from tests.tigerbeetle_reconcile.support import (
    BLOCKER_CODE_MISMATCH,
    BLOCKER_CREDIT_ACCOUNT_MISMATCH,
    BLOCKER_DEBIT_ACCOUNT_MISMATCH,
    BLOCKER_LEDGER_MISMATCH,
    BLOCKER_POSTGRES_REF_MISMATCH,
    BLOCKER_RUNTIME_LEDGER_ACCOUNT_REFS_MISSING,
    BLOCKER_RUNTIME_LEDGER_DIRECTION_MISMATCH,
    BLOCKER_RUNTIME_LEDGER_METADATA_MISMATCH,
    BLOCKER_RUNTIME_LEDGER_SIGNED_REFS_MISSING,
    BLOCKER_SOURCE_ROW_MISSING,
    BLOCKER_STABLE_REF_PAYLOAD_MISMATCH,
    BLOCKER_UNLINKED_EVENT,
    BLOCKER_UNLINKED_EXECUTION,
    Decimal,
    Execution,
    ExecutionOrderEvent,
    FakeTigerBeetleClient,
    LEDGER_USD_MICRO,
    SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
    StableRefPayloadInput,
    Session,
    TRANSFER_CODE_FILL_POST,
    TRANSFER_CODE_RUNTIME_NET_PNL,
    TRANSFER_KIND_RUNTIME_NET_PNL,
    TigerBeetleTransferRef,
    TigerBeetleTransferSpec,
    _TestTigerBeetleReconcileBase,
    _add_account_refs_for_plan,
    _add_ref,
    _runtime_bucket,
    _settings,
    _stable_ref_matches,
    _transfer,
    build_runtime_ledger_bucket_transfer_plan,
    datetime,
    reconcile_tigerbeetle_transfers,
    tigerbeetle_ref_counts,
    tigerbeetle_stable_ref_payload,
    timezone,
)


class TestReconciliationScopesRequiredRuntimeRefsByAccountLabel(
    _TestTigerBeetleReconcileBase
):
    def test_reconciliation_scopes_required_runtime_refs_by_account_label(
        self,
    ) -> None:
        with Session(self.engine) as session:
            sim_bucket = _runtime_bucket(
                net_pnl=Decimal("2.50"),
                account_label="TORGHUT_SIM",
            )
            replay_bucket = _runtime_bucket(
                net_pnl=Decimal("7.50"),
                account_label="TORGHUT_REPLAY",
            )
            session.add_all([sim_bucket, replay_bucket])
            session.flush()
            sim_plan = build_runtime_ledger_bucket_transfer_plan(sim_bucket)
            self.assertIsNotNone(sim_plan)
            assert sim_plan is not None
            _add_account_refs_for_plan(session, sim_plan)
            sim_transfer = sim_plan.transfer_spec
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=2001,
                    transfer_id=str(sim_transfer.transfer_id),
                    transfer_kind=sim_transfer.transfer_kind,
                    ledger=sim_transfer.ledger,
                    code=sim_transfer.code,
                    amount=Decimal(sim_transfer.amount),
                    status="created",
                    runtime_ledger_bucket_id=sim_bucket.id,
                    source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                    source_id=str(sim_bucket.id),
                    payload_json={
                        "source": SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                        "run_id": sim_bucket.run_id,
                        "candidate_id": sim_bucket.candidate_id,
                        "hypothesis_id": sim_bucket.hypothesis_id,
                        "observed_stage": sim_bucket.observed_stage,
                        "pnl_basis": sim_bucket.pnl_basis,
                        "ledger_schema_version": sim_bucket.ledger_schema_version,
                        "amount_source": str(sim_plan.amount_source),
                        "signed_amount_micros": sim_plan.signed_amount_micros,
                        "pnl_direction": sim_plan.pnl_direction,
                        "runtime_key": sim_plan.runtime_key,
                        "debit_account_id": str(sim_transfer.debit_account_id),
                        "credit_account_id": str(sim_transfer.credit_account_id),
                    },
                )
            )
            client = FakeTigerBeetleClient()
            client.transfers[sim_transfer.transfer_id] = sim_transfer
            session.flush()

            unscoped = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
                account_label=None,
            )
            scoped = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
                account_label="TORGHUT_SIM",
            )

            self.assertFalse(unscoped["ok"], unscoped)
            self.assertEqual(unscoped["runtime_ledger_missing_signed_ref_count"], 1)
            self.assertEqual(scoped["account_label"], "TORGHUT_SIM")
            self.assertTrue(scoped["ok"], scoped)
            self.assertEqual(scoped["runtime_ledger_ref_count"], 1)
            self.assertEqual(scoped["runtime_ledger_signed_ref_count"], 1)
            self.assertEqual(scoped["runtime_ledger_missing_signed_ref_count"], 0)
            ref_counts = scoped["ref_counts"]
            assert isinstance(ref_counts, dict)
            self.assertEqual(ref_counts["account_label"], "TORGHUT_SIM")
            source_materialization = ref_counts["source_materialization"]
            assert isinstance(source_materialization, dict)
            self.assertEqual(
                source_materialization["runtime_ledger_account_label_scope"],
                "TORGHUT_SIM",
            )

    def test_reconciliation_reports_archived_runtime_ref_without_blocking_current_ref(
        self,
    ) -> None:
        with Session(self.engine) as session:
            bucket = _runtime_bucket(net_pnl=Decimal("2.50"))
            session.add(bucket)
            session.flush()
            client = FakeTigerBeetleClient()
            plan = build_runtime_ledger_bucket_transfer_plan(bucket)
            self.assertIsNotNone(plan)
            assert plan is not None
            _add_account_refs_for_plan(session, plan)
            current_transfer = plan.transfer_spec
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=2001,
                    transfer_id=str(current_transfer.transfer_id),
                    transfer_kind=current_transfer.transfer_kind,
                    ledger=current_transfer.ledger,
                    code=current_transfer.code,
                    amount=Decimal(current_transfer.amount),
                    status="created",
                    runtime_ledger_bucket_id=bucket.id,
                    source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                    source_id=str(bucket.id),
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
                        "debit_account_id": str(current_transfer.debit_account_id),
                        "credit_account_id": str(current_transfer.credit_account_id),
                    },
                )
            )
            archived_transfer = TigerBeetleTransferSpec(
                transfer_id=7001,
                transfer_kind=TRANSFER_KIND_RUNTIME_NET_PNL,
                debit_account_id=11,
                credit_account_id=12,
                amount=2500000,
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_RUNTIME_NET_PNL,
            )
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=2001,
                    transfer_id=str(archived_transfer.transfer_id),
                    transfer_kind=archived_transfer.transfer_kind,
                    ledger=archived_transfer.ledger,
                    code=archived_transfer.code,
                    amount=Decimal(archived_transfer.amount),
                    status="exists",
                    source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                    source_id="6f767a53-6b44-428a-bd85-2f662642f637",
                    payload_json={
                        "source": SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                        "run_id": "archived-runtime-run",
                        "candidate_id": "candidate",
                        "hypothesis_id": "hypothesis",
                        "amount_source": "2.50",
                        "net_strategy_pnl_after_costs": "2.50",
                        "debit_account_id": str(archived_transfer.debit_account_id),
                        "credit_account_id": str(archived_transfer.credit_account_id),
                    },
                )
            )
            session.flush()
            client.transfers[current_transfer.transfer_id] = current_transfer
            client.transfers[archived_transfer.transfer_id] = archived_transfer

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
            )

            self.assertTrue(payload["ok"], payload)
            self.assertEqual(payload["runtime_ledger_checked_transfer_count"], 2)
            self.assertEqual(payload["runtime_ledger_signed_transfer_count"], 1)
            self.assertEqual(
                payload["archived_runtime_ledger_source_missing_count"],
                1,
            )
            self.assertEqual(payload["source_row_missing_count"], 0)
            self.assertEqual(payload["source_missing_count"], 0)
            self.assertNotIn(BLOCKER_SOURCE_ROW_MISSING, payload["blockers"])

    def test_reconciliation_blocks_runtime_ledger_signed_ref_coverage_gap(
        self,
    ) -> None:
        with Session(self.engine) as session:
            bucket = _runtime_bucket(net_pnl=Decimal("2.50"))
            session.add(bucket)
            session.flush()
            plan = build_runtime_ledger_bucket_transfer_plan(bucket)
            self.assertIsNotNone(plan)
            assert plan is not None
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
                    source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                    source_id=str(bucket.id),
                    payload_json={
                        "source": SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                        "debit_account_id": str(transfer.debit_account_id),
                        "credit_account_id": str(transfer.credit_account_id),
                    },
                )
            )
            session.flush()
            client = FakeTigerBeetleClient()
            client.transfers[transfer.transfer_id] = transfer

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
            )

            self.assertFalse(payload["ok"], payload)
            self.assertIn(
                BLOCKER_RUNTIME_LEDGER_SIGNED_REFS_MISSING,
                payload["blockers"],
            )
            self.assertIn(
                BLOCKER_RUNTIME_LEDGER_ACCOUNT_REFS_MISSING,
                payload["blockers"],
            )
            self.assertEqual(payload["runtime_ledger_missing_signed_ref_count"], 1)
            self.assertEqual(payload["runtime_ledger_missing_account_ref_count"], 2)

    def test_reconciliation_keeps_unsigned_runtime_placeholder_blocked_with_accounts(
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
                    source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                    source_id=str(bucket.id),
                    payload_json={
                        "source": SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                        "account_ids": [
                            str(transfer.debit_account_id),
                            str(transfer.credit_account_id),
                        ],
                    },
                )
            )
            session.flush()
            client = FakeTigerBeetleClient()
            client.transfers[transfer.transfer_id] = transfer

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
            )

            self.assertFalse(payload["ok"], payload)
            self.assertIn(
                BLOCKER_RUNTIME_LEDGER_SIGNED_REFS_MISSING,
                payload["blockers"],
            )
            self.assertNotIn(
                BLOCKER_RUNTIME_LEDGER_ACCOUNT_REFS_MISSING,
                payload["blockers"],
            )
            self.assertEqual(payload["runtime_ledger_signed_ref_count"], 0)
            self.assertEqual(payload["runtime_ledger_missing_signed_ref_count"], 1)
            self.assertEqual(payload["runtime_ledger_missing_account_ref_count"], 0)

    def test_reconciliation_blocks_stable_ref_payload_mismatch(self) -> None:
        with Session(self.engine) as session:
            bucket = _runtime_bucket(net_pnl=Decimal("2.50"))
            session.add(bucket)
            session.flush()
            plan = build_runtime_ledger_bucket_transfer_plan(bucket)
            self.assertIsNotNone(plan)
            assert plan is not None
            _add_account_refs_for_plan(session, plan)
            transfer = plan.transfer_spec
            stable_payload = tigerbeetle_stable_ref_payload(
                StableRefPayloadInput(
                    cluster_id=2001,
                    account_specs=plan.account_specs,
                    transfer_spec=transfer,
                    source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                    source_id=str(bucket.id),
                    payload_json={
                        "runtime_key": plan.runtime_key,
                        "debit_account_id": str(transfer.debit_account_id),
                        "credit_account_id": str(transfer.credit_account_id),
                    },
                )
            )
            stable_ref = stable_payload["stable_ref"]
            assert isinstance(stable_ref, dict)
            components = stable_ref["components"]
            assert isinstance(components, dict)
            components["source_id"] = "different-runtime-bucket"
            payload_json = {
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
                "debit_account_id": str(transfer.debit_account_id),
                "credit_account_id": str(transfer.credit_account_id),
                **stable_payload,
            }
            ref = TigerBeetleTransferRef(
                cluster_id=2001,
                transfer_id=str(transfer.transfer_id),
                transfer_kind=transfer.transfer_kind,
                ledger=transfer.ledger,
                code=transfer.code,
                amount=Decimal(transfer.amount),
                status="created",
                runtime_ledger_bucket_id=bucket.id,
                source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                source_id=str(bucket.id),
                payload_json=payload_json,
            )
            session.add(ref)
            session.flush()
            client = FakeTigerBeetleClient()
            client.transfers[transfer.transfer_id] = transfer

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
            )

        self.assertFalse(_stable_ref_matches(ref))
        self.assertFalse(payload["ok"], payload)
        self.assertIn(BLOCKER_STABLE_REF_PAYLOAD_MISMATCH, payload["blockers"])
        self.assertEqual(payload["stable_ref_count"], 1)
        self.assertEqual(payload["stable_ref_mismatch_count"], 1)

    def test_ref_counts_expose_source_materialization_identifiers(self) -> None:
        with Session(self.engine) as session:
            bucket = _runtime_bucket(net_pnl=Decimal("2.50"))
            session.add(bucket)
            session.flush()
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
                    source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                    source_id=str(bucket.id),
                    payload_json={
                        "source": SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                        "signed_amount_micros": plan.signed_amount_micros,
                        "pnl_direction": plan.pnl_direction,
                        "debit_account_id": str(transfer.debit_account_id),
                        "credit_account_id": str(transfer.credit_account_id),
                    },
                )
            )
            session.flush()

            payload = tigerbeetle_ref_counts(session, cluster_id=2001)

        self.assertEqual(payload["account_ref_count"], 4)
        self.assertEqual(payload["runtime_ledger_ref_count"], 1)
        self.assertEqual(payload["runtime_ledger_signed_ref_count"], 1)
        self.assertEqual(payload["runtime_ledger_missing_signed_ref_count"], 0)
        self.assertEqual(payload["runtime_ledger_missing_account_ref_count"], 0)
        self.assertEqual(payload["runtime_ledger_source_ids"], [str(bucket.id)])
        self.assertEqual(
            payload["runtime_ledger_transfer_ids"],
            [str(transfer.transfer_id)],
        )
        source_materialization = payload["source_materialization"]
        assert isinstance(source_materialization, dict)
        self.assertEqual(
            source_materialization["runtime_ledger_source_table"],
            "strategy_runtime_ledger_buckets",
        )

    def test_bounded_ref_counts_preserve_signed_runtime_refs_when_sample_exact(
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
                    source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                    source_id=str(bucket.id),
                    payload_json={
                        "source": SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                        "signed_amount_micros": plan.signed_amount_micros,
                        "pnl_direction": plan.pnl_direction,
                        "debit_account_id": str(transfer.debit_account_id),
                        "credit_account_id": str(transfer.credit_account_id),
                    },
                )
            )
            session.flush()

            payload = tigerbeetle_ref_counts(
                session,
                cluster_id=2001,
                full_ref_scan=False,
            )

        self.assertEqual(payload["runtime_ledger_ref_count"], 1)
        self.assertEqual(payload["runtime_ledger_signed_ref_count"], 1)
        self.assertEqual(payload["runtime_ledger_missing_signed_ref_count"], 0)
        self.assertEqual(payload["runtime_ledger_missing_account_ref_count"], 0)
        self.assertEqual(payload["runtime_ledger_signed_bucket_ids"], [str(bucket.id)])
        self.assertFalse(payload["runtime_ledger_ref_coverage_bounded"])

    def test_reconciliation_blocks_runtime_ledger_signed_direction_mismatch(
        self,
    ) -> None:
        with Session(self.engine) as session:
            bucket = _runtime_bucket(net_pnl=Decimal("-3.50"))
            session.add(bucket)
            session.flush()
            plan = build_runtime_ledger_bucket_transfer_plan(bucket)
            self.assertIsNotNone(plan)
            assert plan is not None
            _add_account_refs_for_plan(session, plan)
            expected = plan.transfer_spec
            wrong_transfer = TigerBeetleTransferSpec(
                transfer_id=expected.transfer_id,
                transfer_kind=expected.transfer_kind,
                debit_account_id=expected.credit_account_id,
                credit_account_id=expected.debit_account_id,
                amount=expected.amount,
                ledger=expected.ledger,
                code=expected.code,
            )
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=2001,
                    transfer_id=str(expected.transfer_id),
                    transfer_kind=expected.transfer_kind,
                    ledger=expected.ledger,
                    code=expected.code,
                    amount=Decimal(expected.amount),
                    status="created",
                    runtime_ledger_bucket_id=bucket.id,
                    source_type="strategy_runtime_ledger_bucket",
                    source_id=str(bucket.id),
                    payload_json={
                        "source": "strategy_runtime_ledger_bucket",
                        "run_id": bucket.run_id,
                        "candidate_id": "wrong-candidate",
                        "hypothesis_id": bucket.hypothesis_id,
                        "observed_stage": bucket.observed_stage,
                        "pnl_basis": bucket.pnl_basis,
                        "ledger_schema_version": bucket.ledger_schema_version,
                        "amount_source": str(plan.amount_source),
                        "signed_amount_micros": abs(plan.signed_amount_micros),
                        "pnl_direction": "profit",
                        "runtime_key": plan.runtime_key,
                        "debit_account_id": str(wrong_transfer.debit_account_id),
                        "credit_account_id": str(wrong_transfer.credit_account_id),
                    },
                )
            )
            session.flush()
            client = FakeTigerBeetleClient()
            client.transfers[expected.transfer_id] = wrong_transfer

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
            )

            self.assertFalse(payload["ok"])
            self.assertIn(
                BLOCKER_RUNTIME_LEDGER_DIRECTION_MISMATCH, payload["blockers"]
            )
            self.assertIn(BLOCKER_RUNTIME_LEDGER_METADATA_MISMATCH, payload["blockers"])
            self.assertEqual(payload["runtime_ledger_signed_transfer_count"], 0)
            self.assertEqual(payload["runtime_ledger_direction_mismatch_count"], 1)
            self.assertEqual(payload["runtime_ledger_metadata_mismatch_count"], 1)

    def test_reconciliation_blocks_code_and_ledger_mismatch(self) -> None:
        with Session(self.engine) as session:
            _add_ref(session)
            client = FakeTigerBeetleClient()
            client.transfers[1001] = TigerBeetleTransferSpec(
                transfer_id=1001,
                transfer_kind="fill_post",
                debit_account_id=11,
                credit_account_id=12,
                amount=190250000,
                ledger=999,
                code=999,
            )

            payload = reconcile_tigerbeetle_transfers(
                session, settings_obj=_settings(), client=client
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_CODE_MISMATCH, payload["blockers"])
            self.assertIn(BLOCKER_LEDGER_MISMATCH, payload["blockers"])

    def test_reconciliation_blocks_account_mismatch(self) -> None:
        with Session(self.engine) as session:
            _add_ref(
                session,
                payload_json={"debit_account_id": "11", "credit_account_id": "12"},
            )
            client = FakeTigerBeetleClient()
            client.transfers[1001] = TigerBeetleTransferSpec(
                transfer_id=1001,
                transfer_kind="fill_post",
                debit_account_id=99,
                credit_account_id=98,
                amount=190250000,
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_FILL_POST,
            )

            payload = reconcile_tigerbeetle_transfers(
                session, settings_obj=_settings(), client=client
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_DEBIT_ACCOUNT_MISMATCH, payload["blockers"])
            self.assertIn(BLOCKER_CREDIT_ACCOUNT_MISMATCH, payload["blockers"])

    def test_reconciliation_blocks_postgres_ref_that_no_longer_matches_event(
        self,
    ) -> None:
        with Session(self.engine) as session:
            event = ExecutionOrderEvent(
                event_fingerprint="linked-unjournalable-event",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=1,
                alpaca_account_label="paper",
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                event_type="accepted",
                status="accepted",
                raw_event={"event": "accepted"},
            )
            session.add(event)
            session.flush()
            mismatched_ref = TigerBeetleTransferRef(
                cluster_id=2001,
                transfer_id="1001",
                transfer_kind="fill_post",
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_FILL_POST,
                amount=Decimal("190250000"),
                status="created",
                event_fingerprint=event.event_fingerprint,
                execution_order_event_id=event.id,
                payload_json={
                    "debit_account_id": "11",
                    "credit_account_id": "12",
                },
            )
            session.add(mismatched_ref)
            session.flush()
            client = FakeTigerBeetleClient()
            client.transfers[1001] = _transfer()

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_POSTGRES_REF_MISMATCH, payload["blockers"])
            mismatched_refs = payload["mismatched_refs"]
            assert isinstance(mismatched_refs, list)
            self.assertEqual(mismatched_refs[0]["row_id"], str(mismatched_ref.id))
            self.assertEqual(
                mismatched_refs[0]["blocker"],
                BLOCKER_POSTGRES_REF_MISMATCH,
            )

    def test_reconciliation_blocks_unlinked_order_event(self) -> None:
        with Session(self.engine) as session:
            session.add(
                ExecutionOrderEvent(
                    event_fingerprint="unlinked-fill",
                    source_topic="torghut.trade-updates.v1",
                    source_partition=0,
                    source_offset=1,
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
            )
            session.flush()

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=FakeTigerBeetleClient(),
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_UNLINKED_EVENT, payload["blockers"])
            self.assertEqual(payload["source_missing_count"], 1)

    def test_reconciliation_treats_source_id_order_event_ref_as_linked(self) -> None:
        with Session(self.engine) as session:
            event = ExecutionOrderEvent(
                event_fingerprint="source-id-linked-fill",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=1,
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
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=2001,
                    transfer_id="1001",
                    transfer_kind="fill_post",
                    ledger=LEDGER_USD_MICRO,
                    code=TRANSFER_CODE_FILL_POST,
                    amount=Decimal("190250000"),
                    status="created",
                    source_type="execution_order_event",
                    source_id=str(event.id),
                    event_fingerprint=event.event_fingerprint,
                )
            )
            session.flush()
            client = FakeTigerBeetleClient()
            client.transfers[1001] = _transfer()

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
            )

            self.assertTrue(payload["ok"])
            self.assertEqual(payload["unlinked_event_count"], 0)
            self.assertNotIn(BLOCKER_UNLINKED_EVENT, payload["blockers"])

    def test_reconciliation_blocks_unlinked_execution_ref(self) -> None:
        with Session(self.engine) as session:
            session.add(
                Execution(
                    alpaca_account_label="paper",
                    alpaca_order_id="order-unlinked-execution",
                    client_order_id="client-unlinked-execution",
                    symbol="AAPL",
                    side="buy",
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=Decimal("1"),
                    filled_qty=Decimal("1"),
                    avg_fill_price=Decimal("190.25"),
                    status="filled",
                    raw_order={"id": "order-unlinked-execution"},
                )
            )
            session.flush()

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=FakeTigerBeetleClient(),
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_UNLINKED_EXECUTION, payload["blockers"])
            self.assertEqual(payload["unlinked_execution_count"], 1)
