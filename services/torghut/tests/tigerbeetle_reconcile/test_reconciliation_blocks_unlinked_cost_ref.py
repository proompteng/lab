from __future__ import annotations

from tests.tigerbeetle_reconcile.support import (
    BLOCKER_CLIENT_UNAVAILABLE,
    BLOCKER_CODE_MISMATCH,
    BLOCKER_TRANSFER_MISSING,
    BLOCKER_UNLINKED_COST,
    BLOCKER_UNLINKED_RUNTIME_LEDGER,
    Decimal,
    Execution,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    FailingLookupClient,
    FakeTigerBeetleClient,
    LEDGER_USD_MICRO,
    SOURCE_TYPE_EXECUTION,
    SOURCE_TYPE_EXECUTION_TCA_METRIC,
    SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
    Session,
    StrategyRuntimeLedgerBucket,
    TRANSFER_CODE_EXECUTION_FILL,
    TRANSFER_CODE_RUNTIME_NET_PNL,
    TRANSFER_KIND_EXECUTION_COST,
    TRANSFER_KIND_EXECUTION_FILL,
    TRANSFER_KIND_RUNTIME_NET_PNL,
    TigerBeetleReconciliationRun,
    TigerBeetleTransferRef,
    TigerBeetleTransferSpec,
    _TestTigerBeetleReconcileBase,
    _add_ref,
    archived_runtime_ledger_amount_micros,
    attr,
    cost_amount_micros,
    execution_amount_micros,
    expected_source_amount_micros,
    payload_int,
    runtime_ledger_amount_micros,
    _settings,
    usd_to_micros,
    uuid_or_none,
    datetime,
    latest_tigerbeetle_reconciliation_payload,
    reconcile_tigerbeetle_transfers,
    timezone,
)


class TestReconciliationBlocksUnlinkedCostRef(_TestTigerBeetleReconcileBase):
    def test_reconciliation_blocks_unlinked_cost_ref(self) -> None:
        with Session(self.engine) as session:
            execution = Execution(
                alpaca_account_label="paper",
                alpaca_order_id="order-unlinked-cost",
                client_order_id="client-unlinked-cost",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.25"),
                status="filled",
                raw_order={"id": "order-unlinked-cost"},
            )
            session.add(execution)
            session.flush()
            session.add(
                ExecutionTCAMetric(
                    execution_id=execution.id,
                    alpaca_account_label="paper",
                    symbol="AAPL",
                    side="buy",
                    filled_qty=Decimal("1"),
                    signed_qty=Decimal("1"),
                    shortfall_notional=Decimal("0.25"),
                    computed_at=datetime.now(timezone.utc),
                )
            )
            session.flush()

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=FakeTigerBeetleClient(),
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_UNLINKED_COST, payload["blockers"])
            self.assertEqual(payload["unlinked_cost_count"], 1)

    def test_reconciliation_treats_fk_linked_cost_ref_as_linked(self) -> None:
        with Session(self.engine) as session:
            execution = Execution(
                alpaca_account_label="paper",
                alpaca_order_id="order-linked-cost",
                client_order_id="client-linked-cost",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.25"),
                status="filled",
                raw_order={"id": "order-linked-cost"},
            )
            session.add(execution)
            session.flush()
            metric = ExecutionTCAMetric(
                execution_id=execution.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                side="buy",
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                shortfall_notional=Decimal("0.25"),
                computed_at=datetime.now(timezone.utc),
            )
            session.add(metric)
            session.flush()
            session.add_all(
                [
                    TigerBeetleTransferRef(
                        cluster_id=2001,
                        transfer_id="1005",
                        transfer_kind=TRANSFER_KIND_EXECUTION_FILL,
                        ledger=LEDGER_USD_MICRO,
                        code=TRANSFER_CODE_EXECUTION_FILL,
                        amount=Decimal("190250000"),
                        status="created",
                        execution_id=execution.id,
                        source_type=SOURCE_TYPE_EXECUTION,
                        source_id=str(execution.id),
                        payload_json={"amount_source": "190.25"},
                    ),
                    TigerBeetleTransferRef(
                        cluster_id=2001,
                        transfer_id="1006",
                        transfer_kind=TRANSFER_KIND_EXECUTION_COST,
                        ledger=LEDGER_USD_MICRO,
                        code=TRANSFER_CODE_EXECUTION_FILL,
                        amount=Decimal("250000"),
                        status="created",
                        execution_id=execution.id,
                        execution_tca_metric_id=metric.id,
                        source_type=SOURCE_TYPE_EXECUTION_TCA_METRIC,
                        source_id=str(metric.id),
                    ),
                ]
            )
            session.flush()
            client = FakeTigerBeetleClient()
            client.transfers[1005] = TigerBeetleTransferSpec(
                transfer_id=1005,
                transfer_kind=TRANSFER_KIND_EXECUTION_FILL,
                debit_account_id=11,
                credit_account_id=12,
                amount=190250000,
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_EXECUTION_FILL,
            )
            client.transfers[1006] = TigerBeetleTransferSpec(
                transfer_id=1006,
                transfer_kind=TRANSFER_KIND_EXECUTION_COST,
                debit_account_id=11,
                credit_account_id=13,
                amount=250000,
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_EXECUTION_FILL,
            )

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
            )

            self.assertTrue(payload["ok"])
            self.assertEqual(payload["unlinked_cost_count"], 0)
            self.assertNotIn(BLOCKER_UNLINKED_COST, payload["blockers"])

    def test_reconciliation_blocks_unlinked_runtime_ledger_ref(self) -> None:
        with Session(self.engine) as session:
            observed_at = datetime.now(timezone.utc)
            session.add(
                StrategyRuntimeLedgerBucket(
                    run_id="runtime-run-unlinked",
                    candidate_id="candidate",
                    hypothesis_id="hypothesis",
                    observed_stage="paper",
                    bucket_started_at=observed_at,
                    bucket_ended_at=observed_at,
                    account_label="paper",
                    runtime_strategy_name="demo",
                    strategy_family="demo",
                    fill_count=1,
                    decision_count=1,
                    submitted_order_count=1,
                    cancelled_order_count=0,
                    rejected_order_count=0,
                    unfilled_order_count=0,
                    closed_trade_count=1,
                    open_position_count=0,
                    filled_notional=Decimal("190.25"),
                    gross_strategy_pnl=Decimal("3.00"),
                    cost_amount=Decimal("0.50"),
                    net_strategy_pnl_after_costs=Decimal("2.50"),
                    post_cost_expectancy_bps=Decimal("12.50"),
                    ledger_schema_version="torghut.runtime-ledger.v1",
                    pnl_basis="post_cost",
                    payload_json={"source": "representative-runtime-ledger"},
                )
            )
            session.flush()

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=FakeTigerBeetleClient(),
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_UNLINKED_RUNTIME_LEDGER, payload["blockers"])
            self.assertEqual(payload["unlinked_runtime_ledger_count"], 1)

    def test_reconciliation_ignores_unjournalable_lifecycle_event(self) -> None:
        with Session(self.engine) as session:
            session.add(
                ExecutionOrderEvent(
                    event_fingerprint="accepted-without-price",
                    source_topic="torghut.trade-updates.v1",
                    source_partition=0,
                    source_offset=1,
                    alpaca_account_label="paper",
                    event_ts=datetime.now(timezone.utc),
                    symbol="AAPL",
                    event_type="accepted",
                    status="accepted",
                    qty=Decimal("1"),
                    raw_event={"event": "accepted"},
                )
            )
            session.flush()

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=FakeTigerBeetleClient(),
            )

            self.assertTrue(payload["ok"])
            self.assertEqual(payload["unlinked_event_count"], 0)

    def test_reconciliation_blocks_client_unavailable(self) -> None:
        with Session(self.engine) as session:
            _add_ref(session)

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=FailingLookupClient(),
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_CLIENT_UNAVAILABLE, payload["blockers"])
            self.assertNotIn(BLOCKER_TRANSFER_MISSING, payload["blockers"])
            self.assertFalse(payload["client_lookup_ok"])
            self.assertIn("RuntimeError: lookup failed", str(payload["client_error"]))
            self.assertEqual(payload["missing_transfer_count"], 0)
            self.assertEqual(payload["missing_transfer_refs"], [])

    def test_latest_reconciliation_payload_normalizes_blockers(self) -> None:
        with Session(self.engine) as session:
            session.add(
                TigerBeetleReconciliationRun(
                    cluster_id=2001,
                    started_at=datetime.now(timezone.utc),
                    finished_at=datetime.now(timezone.utc),
                    status="degraded",
                    checked_transfer_count=2,
                    missing_transfer_count=0,
                    mismatched_transfer_count=1,
                    source_missing_count=0,
                    payload_json={
                        "blockers": [BLOCKER_CODE_MISMATCH, 7],
                        "client_lookup_ok": False,
                        "client_error": "RuntimeError: lookup failed",
                        "mismatched_ref_count": 1,
                        "missing_source_row_count": 3,
                        "unlinked_order_event_ref_count": 4,
                        "mismatched_refs": [
                            {
                                "blocker": BLOCKER_CODE_MISMATCH,
                                "row_id": "ref-1",
                            }
                        ],
                        "blocker_details": {
                            "mismatched_refs": [
                                {
                                    "blocker": BLOCKER_CODE_MISMATCH,
                                    "row_id": "ref-1",
                                }
                            ]
                        },
                        "ref_counts": {
                            "account_ref_count": 1,
                            "transfer_ref_count": 2,
                            "runtime_ledger_ref_count": 5,
                            "runtime_ledger_signed_ref_count": 4,
                        },
                    },
                )
            )
            session.flush()

            payload = latest_tigerbeetle_reconciliation_payload(
                session,
                cluster_id=2001,
            )

        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["blockers"], [BLOCKER_CODE_MISMATCH, "7"])
        self.assertEqual(payload["account_ref_count"], 1)
        self.assertEqual(payload["transfer_ref_count"], 2)
        self.assertEqual(payload["runtime_ledger_ref_count"], 5)
        self.assertEqual(payload["runtime_ledger_signed_ref_count"], 4)
        self.assertFalse(payload["promotion_authority"])
        self.assertFalse(payload["overrides_runtime_ledger_authority"])
        self.assertFalse(payload["client_lookup_ok"])
        self.assertEqual(payload["client_error"], "RuntimeError: lookup failed")
        self.assertIn("reconciliation_freshness", payload)
        self.assertEqual(payload["mismatched_ref_count"], 1)
        self.assertEqual(payload["missing_source_row_count"], 3)
        self.assertEqual(payload["unlinked_order_event_ref_count"], 4)
        self.assertEqual(
            payload["mismatched_refs"],
            [{"blocker": BLOCKER_CODE_MISMATCH, "row_id": "ref-1"}],
        )
        self.assertEqual(
            payload["ref_counts"],
            {
                "account_ref_count": 1,
                "transfer_ref_count": 2,
                "runtime_ledger_ref_count": 5,
                "runtime_ledger_signed_ref_count": 4,
            },
        )

    def testattr_helper_supports_mapping_and_transfer_id_fallbacks(self) -> None:
        self.assertEqual(attr({"transfer_id": 44}, "id"), 44)
        self.assertEqual(attr(type("TransferId", (), {"transfer_id": 45})(), "id"), 45)
        with self.assertRaises(AttributeError):
            attr(object(), "id")

    def test_source_amount_helpers_handle_invalid_and_zero_values(self) -> None:
        self.assertEqual(payload_int({"value": "42"}, "value"), 42)
        self.assertEqual(payload_int({"value": object()}, "value"), 0)
        self.assertEqual(payload_int({}, "value"), 0)
        self.assertIsNone(uuid_or_none(None))
        self.assertIsNone(uuid_or_none("not-a-uuid"))
        self.assertEqual(
            str(uuid_or_none("6f767a53-6b44-428a-bd85-2f662642f637:revision")),
            "6f767a53-6b44-428a-bd85-2f662642f637",
        )
        self.assertIsNone(usd_to_micros(None))
        self.assertIsNone(usd_to_micros(Decimal("0")))
        self.assertIsNone(usd_to_micros(Decimal("0.0000001")))
        self.assertEqual(usd_to_micros(Decimal("-1.25")), Decimal("1250000"))
        self.assertIsNone(execution_amount_micros(None))
        self.assertIsNone(cost_amount_micros(None))
        self.assertIsNone(runtime_ledger_amount_micros(None))
        archived_ref = TigerBeetleTransferRef(
            cluster_id=2001,
            transfer_id="9001",
            transfer_kind=TRANSFER_KIND_RUNTIME_NET_PNL,
            ledger=LEDGER_USD_MICRO,
            code=TRANSFER_CODE_RUNTIME_NET_PNL,
            amount=Decimal("1250000"),
            status="exists",
            source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
            source_id="6f767a53-6b44-428a-bd85-2f662642f637",
            payload_json={},
        )
        self.assertIsNone(archived_runtime_ledger_amount_micros(archived_ref))
        archived_ref.payload_json = {"amount_source": object()}
        self.assertIsNone(archived_runtime_ledger_amount_micros(archived_ref))
        archived_ref.payload_json = {"amount_source": "-1.25"}
        self.assertEqual(
            archived_runtime_ledger_amount_micros(archived_ref),
            Decimal("1250000"),
        )

    def test_expected_source_amount_supports_cost_and_runtime_refs(self) -> None:
        with Session(self.engine) as session:
            execution = Execution(
                alpaca_account_label="paper",
                alpaca_order_id="order-source-helper",
                client_order_id="client-source-helper",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.25"),
                status="filled",
                raw_order={"id": "order-source-helper"},
            )
            session.add(execution)
            session.flush()
            metric = ExecutionTCAMetric(
                execution_id=execution.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                side="buy",
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                shortfall_notional=Decimal("-0.25"),
                computed_at=datetime.now(timezone.utc),
            )
            observed_at = datetime.now(timezone.utc)
            bucket = StrategyRuntimeLedgerBucket(
                run_id="runtime-run-helper",
                candidate_id="candidate",
                hypothesis_id="hypothesis",
                observed_stage="paper",
                bucket_started_at=observed_at,
                bucket_ended_at=observed_at,
                account_label="paper",
                runtime_strategy_name="demo",
                strategy_family="demo",
                fill_count=1,
                decision_count=1,
                submitted_order_count=1,
                cancelled_order_count=0,
                rejected_order_count=0,
                unfilled_order_count=0,
                closed_trade_count=1,
                open_position_count=0,
                filled_notional=Decimal("190.25"),
                gross_strategy_pnl=Decimal("0"),
                cost_amount=Decimal("-0.50"),
                net_strategy_pnl_after_costs=Decimal("0"),
                post_cost_expectancy_bps=Decimal("12.50"),
                ledger_schema_version="torghut.runtime-ledger.v1",
                pnl_basis="post_cost",
                payload_json={"source": "helper"},
            )
            session.add_all([metric, bucket])
            session.flush()

            cost_ref = TigerBeetleTransferRef(
                cluster_id=2001,
                transfer_id="2001",
                transfer_kind="execution_cost",
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_EXECUTION_FILL,
                amount=Decimal("250000"),
                status="created",
                source_type="execution_tca_metric",
                source_id=f"{metric.id}:revision",
            )
            archived_cost_ref = TigerBeetleTransferRef(
                cluster_id=2001,
                transfer_id="2005",
                transfer_kind="execution_cost",
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_EXECUTION_FILL,
                amount=Decimal("250000"),
                status="created",
                source_type="execution_tca_metric",
                source_id=f"{metric.id}:archived",
                payload_json={"amount_source": "0.25"},
            )
            metric.shortfall_notional = Decimal("0.75")
            runtime_ref = TigerBeetleTransferRef(
                cluster_id=2001,
                transfer_id="2002",
                transfer_kind="runtime_net_pnl",
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_EXECUTION_FILL,
                amount=Decimal("500000"),
                status="created",
                source_type="strategy_runtime_ledger_bucket",
                source_id=str(bucket.id),
            )
            unknown_ref = TigerBeetleTransferRef(
                cluster_id=2001,
                transfer_id="2003",
                transfer_kind="runtime_net_pnl",
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_EXECUTION_FILL,
                amount=Decimal("500000"),
                status="created",
                source_type="untracked",
                source_id=str(bucket.id),
            )
            invalid_ref = TigerBeetleTransferRef(
                cluster_id=2001,
                transfer_id="2004",
                transfer_kind="runtime_net_pnl",
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_EXECUTION_FILL,
                amount=Decimal("500000"),
                status="created",
                source_type="strategy_runtime_ledger_bucket",
                source_id="not-a-uuid",
            )

            self.assertEqual(
                expected_source_amount_micros(session, cost_ref), Decimal("750000")
            )
            self.assertEqual(
                expected_source_amount_micros(session, archived_cost_ref),
                Decimal("250000"),
            )
            self.assertEqual(
                expected_source_amount_micros(session, runtime_ref), Decimal("500000")
            )
            self.assertIsNone(expected_source_amount_micros(session, unknown_ref))
            self.assertIsNone(expected_source_amount_micros(session, invalid_ref))
