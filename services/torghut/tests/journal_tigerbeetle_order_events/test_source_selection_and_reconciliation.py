from __future__ import annotations

from tests.journal_tigerbeetle_order_events.support import (
    Base,
    Decimal,
    Execution,
    ExecutionTCAMetric,
    FakeJournal,
    LEDGER_USD_MICRO,
    Session,
    Settings,
    StrategyRuntimeLedgerBucket,
    TRANSFER_CODE_FILL_POST,
    TRANSFER_KIND_EXECUTION_COST,
    TigerBeetleReconciliationRun,
    TigerBeetleTransferRef,
    _TestJournalTigerBeetleOrderEventsScriptBase,
    _add_order_event,
    _add_real_source_rows,
    build_runtime_ledger_bucket_transfer_plan,
    create_engine,
    datetime,
    io,
    json,
    os,
    patch,
    redirect_stdout,
    script,
    script_cli,
    sys,
    tempfile,
    timedelta,
    timezone,
)


class TestJournalSourceSelectionAndReconciliation(
    _TestJournalTigerBeetleOrderEventsScriptBase
):
    def test_select_unlinked_executions_prioritizes_reconciliation_window(
        self,
    ) -> None:
        settings_obj = Settings(TORGHUT_TIGERBEETLE_ENABLED=True)
        observed_at = datetime.now(timezone.utc)
        with Session(self.engine) as session:
            older = Execution(
                alpaca_account_label="paper",
                alpaca_order_id="order-older-window",
                client_order_id="client-older-window",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.25"),
                status="filled",
                raw_order={"id": "order-older-window"},
                created_at=observed_at - timedelta(minutes=5),
                updated_at=observed_at - timedelta(minutes=5),
            )
            newer = Execution(
                alpaca_account_label="paper",
                alpaca_order_id="order-newer-window",
                client_order_id="client-newer-window",
                symbol="MSFT",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("410.50"),
                status="filled",
                raw_order={"id": "order-newer-window"},
                created_at=observed_at,
                updated_at=observed_at,
            )
            session.add_all([older, newer])
            session.flush()

            executions = script._select_unlinked_executions(
                session,
                settings_obj=settings_obj,
                account_label="paper",
                limit=1,
            )

        self.assertEqual([row.id for row in executions], [newer.id])

    def test_select_unlinked_tca_metrics_uses_direct_ref_fk(self) -> None:
        settings_obj = Settings(TORGHUT_TIGERBEETLE_ENABLED=True)
        with Session(self.engine) as session:
            linked_execution = Execution(
                alpaca_account_label="paper",
                alpaca_order_id="order-tca-linked",
                client_order_id="client-tca-linked",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.25"),
                status="filled",
                raw_order={"id": "order-tca-linked"},
            )
            selected_execution = Execution(
                alpaca_account_label="paper",
                alpaca_order_id="order-tca-selected",
                client_order_id="client-tca-selected",
                symbol="MSFT",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("410.50"),
                status="filled",
                raw_order={"id": "order-tca-selected"},
            )
            session.add_all([linked_execution, selected_execution])
            session.flush()
            linked = ExecutionTCAMetric(
                execution_id=linked_execution.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                side="buy",
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                shortfall_notional=Decimal("0.25"),
                computed_at=datetime.now(timezone.utc),
            )
            selected = ExecutionTCAMetric(
                execution_id=selected_execution.id,
                alpaca_account_label="paper",
                symbol="MSFT",
                side="buy",
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                shortfall_notional=Decimal("0.35"),
                computed_at=datetime.now(timezone.utc),
            )
            session.add_all([linked, selected])
            session.flush()
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=settings_obj.tigerbeetle_cluster_id,
                    transfer_id="12002",
                    transfer_kind=TRANSFER_KIND_EXECUTION_COST,
                    ledger=LEDGER_USD_MICRO,
                    code=TRANSFER_CODE_FILL_POST,
                    amount=Decimal("250000"),
                    status="created",
                    execution_id=linked_execution.id,
                    execution_tca_metric_id=linked.id,
                )
            )
            session.flush()

            metrics = script._select_unlinked_tca_metrics(
                session,
                settings_obj=settings_obj,
                account_label="paper",
                limit=10,
            )

        self.assertEqual([row.id for row in metrics], [selected.id])

    def test_select_unlinked_tca_metrics_prioritizes_reconciliation_window(
        self,
    ) -> None:
        settings_obj = Settings(TORGHUT_TIGERBEETLE_ENABLED=True)
        observed_at = datetime.now(timezone.utc)
        with Session(self.engine) as session:
            older_execution = Execution(
                alpaca_account_label="paper",
                alpaca_order_id="order-older-tca-window",
                client_order_id="client-older-tca-window",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.25"),
                status="filled",
                raw_order={"id": "order-older-tca-window"},
            )
            newer_execution = Execution(
                alpaca_account_label="paper",
                alpaca_order_id="order-newer-tca-window",
                client_order_id="client-newer-tca-window",
                symbol="MSFT",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("410.50"),
                status="filled",
                raw_order={"id": "order-newer-tca-window"},
            )
            session.add_all([older_execution, newer_execution])
            session.flush()
            older = ExecutionTCAMetric(
                execution_id=older_execution.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                side="buy",
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                shortfall_notional=Decimal("0.25"),
                computed_at=observed_at - timedelta(minutes=5),
                created_at=observed_at - timedelta(minutes=5),
                updated_at=observed_at - timedelta(minutes=5),
            )
            newer = ExecutionTCAMetric(
                execution_id=newer_execution.id,
                alpaca_account_label="paper",
                symbol="MSFT",
                side="buy",
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                shortfall_notional=Decimal("0.35"),
                computed_at=observed_at,
                created_at=observed_at,
                updated_at=observed_at,
            )
            session.add_all([older, newer])
            session.flush()

            metrics = script._select_unlinked_tca_metrics(
                session,
                settings_obj=settings_obj,
                account_label="paper",
                limit=1,
            )

        self.assertEqual([row.id for row in metrics], [newer.id])

    def test_select_runtime_buckets_repairs_unsigned_legacy_ref_materialization(
        self,
    ) -> None:
        settings_obj = Settings(TORGHUT_TIGERBEETLE_ENABLED=True)
        observed_at = datetime.now(timezone.utc)
        with Session(self.engine) as session:
            bucket = StrategyRuntimeLedgerBucket(
                run_id="runtime-run-legacy-ref",
                candidate_id="candidate",
                hypothesis_id="hypothesis",
                observed_stage="paper",
                bucket_started_at=observed_at,
                bucket_ended_at=observed_at,
                account_label="paper",
                runtime_strategy_name="demo-runtime",
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
                payload_json={"source": "test"},
            )
            session.add(bucket)
            session.flush()
            plan = build_runtime_ledger_bucket_transfer_plan(bucket)
            self.assertIsNotNone(plan)
            assert plan is not None
            transfer = plan.transfer_spec
            legacy_ref = TigerBeetleTransferRef(
                cluster_id=settings_obj.tigerbeetle_cluster_id,
                transfer_id=str(transfer.transfer_id),
                transfer_kind=transfer.transfer_kind,
                ledger=transfer.ledger,
                code=transfer.code,
                amount=Decimal(transfer.amount),
                status="created",
                source_type=script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                source_id=str(bucket.id),
                payload_json={
                    "source": script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                    "account_ids": [
                        str(transfer.debit_account_id),
                        str(transfer.credit_account_id),
                    ],
                },
            )
            session.add(legacy_ref)
            session.flush()

            selected = script._select_unlinked_runtime_buckets(
                session,
                settings_obj=settings_obj,
                account_label="paper",
                limit=1,
            )

            self.assertEqual([row.id for row in selected], [bucket.id])
            self.assertEqual(
                script._payload_mapping(legacy_ref), legacy_ref.payload_json
            )
            self.assertFalse(
                script._payload_int_matches(
                    {"signed_amount_micros": "not-an-int"},
                    "signed_amount_micros",
                    plan.signed_amount_micros,
                )
            )

            legacy_ref.runtime_ledger_bucket_id = bucket.id
            session.add(legacy_ref)
            session.flush()
            selected_after_fk_repair = script._select_unlinked_runtime_buckets(
                session,
                settings_obj=settings_obj,
                account_label="paper",
                limit=1,
            )

            legacy_ref.payload_json = {
                **legacy_ref.payload_json,
                "signed_amount_micros": plan.signed_amount_micros,
                "pnl_direction": plan.pnl_direction,
                "debit_account_id": str(transfer.debit_account_id),
                "credit_account_id": str(transfer.credit_account_id),
            }
            session.add(legacy_ref)
            session.flush()
            selected_after_signed_materialization = (
                script._select_unlinked_runtime_buckets(
                    session,
                    settings_obj=settings_obj,
                    account_label="paper",
                    limit=10,
                )
            )
            legacy_ref.payload_json = None
            bucket.net_strategy_pnl_after_costs = Decimal("0")
            bucket.cost_amount = Decimal("0")
            self.assertEqual(script._payload_mapping(legacy_ref), {})
            self.assertFalse(
                script._runtime_ref_matches_signed_bucket(legacy_ref, bucket)
            )

        self.assertEqual([row.id for row in selected_after_fk_repair], [bucket.id])
        self.assertEqual(selected_after_signed_materialization, [])

    def test_runtime_signed_ref_helpers_fail_closed_on_unusable_payloads(
        self,
    ) -> None:
        observed_at = datetime.now(timezone.utc)
        bucket = StrategyRuntimeLedgerBucket(
            run_id="runtime-run-unjournalable",
            candidate_id="candidate",
            hypothesis_id="hypothesis",
            observed_stage="paper",
            bucket_started_at=observed_at,
            bucket_ended_at=observed_at,
            account_label="paper",
            runtime_strategy_name="demo-runtime",
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
            cost_amount=Decimal("0"),
            net_strategy_pnl_after_costs=Decimal("0"),
            post_cost_expectancy_bps=Decimal("0"),
            ledger_schema_version="torghut.runtime-ledger.v1",
            pnl_basis="post_cost",
            payload_json={"source": "test"},
        )
        ref = TigerBeetleTransferRef(
            transfer_id="0",
            transfer_kind=script.TRANSFER_KIND_RUNTIME_NET_PNL,
            amount=Decimal("0"),
            payload_json="not-a-mapping",
        )

        self.assertEqual(script._payload_mapping(ref), {})
        self.assertFalse(script._payload_int_matches({"value": object()}, "value", 1))
        self.assertFalse(script._runtime_ref_matches_signed_bucket(ref, bucket))

    def test_select_runtime_buckets_stops_at_limit(
        self,
    ) -> None:
        settings_obj = Settings(TORGHUT_TIGERBEETLE_ENABLED=True)
        observed_at = datetime.now(timezone.utc)
        with Session(self.engine) as session:
            bucket = StrategyRuntimeLedgerBucket(
                run_id="runtime-run-limit",
                candidate_id="candidate",
                hypothesis_id="hypothesis",
                observed_stage="paper",
                bucket_started_at=observed_at,
                bucket_ended_at=observed_at,
                account_label="paper",
                runtime_strategy_name="demo-runtime",
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
                payload_json={"source": "test"},
            )
            session.add(bucket)
            session.flush()

            selected = script._select_unlinked_runtime_buckets(
                session,
                settings_obj=settings_obj,
                account_label="paper",
                limit=1,
            )

        self.assertEqual([row.id for row in selected], [bucket.id])

    def test_main_journals_selected_events_and_reconciles(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "torghut.db")
            dsn = f"sqlite+pysqlite:///{db_path}"
            engine = create_engine(dsn, future=True)
            Base.metadata.create_all(engine)
            with Session(engine) as session:
                _add_order_event(session, fingerprint="selected", source_offset=1)
                _add_real_source_rows(session)
                session.commit()

            stdout = io.StringIO()
            with (
                patch.dict(os.environ, {"TEST_DB_DSN": dsn}),
                patch.object(
                    sys,
                    "argv",
                    [
                        "journal_tigerbeetle_order_events.py",
                        "--dsn-env",
                        "TEST_DB_DSN",
                        "--batch-size",
                        "10",
                        "--max-batches",
                        "2",
                        "--reconcile-limit",
                        "12",
                        "--json",
                    ],
                ),
                patch.object(script_cli, "TigerBeetleLedgerJournal", FakeJournal),
                patch.object(
                    script_cli,
                    "reconcile_tigerbeetle_transfers",
                    return_value={"ok": True},
                ) as reconcile,
                redirect_stdout(stdout),
            ):
                exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(
            payload["schema_version"],
            "torghut.tigerbeetle-journal-order-events.v1",
        )
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["journaled"], 4)
        self.assertEqual(payload["failed"], 0)
        self.assertEqual(FakeJournal.instances[0].events, ["selected"])
        self.assertEqual(FakeJournal.instances[0].executions, ["order-source"])
        self.assertEqual(FakeJournal.instances[0].tca_metrics, ["AAPL"])
        self.assertEqual(
            FakeJournal.instances[0].runtime_buckets,
            ["runtime-run-source"],
        )
        reconcile.assert_called_once()
        self.assertIs(
            reconcile.call_args.kwargs["client"],
            FakeJournal.instances[0].reconciliation_client,
        )

    def test_main_can_target_tca_metrics_without_reconcile(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "torghut.db")
            dsn = f"sqlite+pysqlite:///{db_path}"
            engine = create_engine(dsn, future=True)
            Base.metadata.create_all(engine)
            with Session(engine) as session:
                _add_order_event(session, fingerprint="selected", source_offset=1)
                _add_real_source_rows(session)
                session.commit()

            stdout = io.StringIO()
            with (
                patch.dict(os.environ, {"TEST_DB_DSN": dsn}),
                patch.object(
                    sys,
                    "argv",
                    [
                        "journal_tigerbeetle_order_events.py",
                        "--dsn-env",
                        "TEST_DB_DSN",
                        "--sources",
                        "execution_tca_metric",
                        "--batch-size",
                        "10",
                        "--max-batches",
                        "2",
                        "--skip-reconcile",
                        "--json",
                    ],
                ),
                patch.object(script_cli, "TigerBeetleLedgerJournal", FakeJournal),
                patch.object(
                    script_cli, "reconcile_tigerbeetle_transfers"
                ) as reconcile,
                redirect_stdout(stdout),
            ):
                exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["sources"], [script.SOURCE_TYPE_EXECUTION_TCA_METRIC])
        self.assertTrue(payload["skip_reconcile"])
        self.assertEqual(payload["journaled"], 1)
        self.assertEqual(FakeJournal.instances[0].events, [])
        self.assertEqual(FakeJournal.instances[0].executions, [])
        self.assertEqual(FakeJournal.instances[0].tca_metrics, ["AAPL"])
        self.assertEqual(FakeJournal.instances[0].runtime_buckets, [])
        reconcile.assert_not_called()

    def test_main_skips_backfill_and_reconcile_when_source_selects_no_rows(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "torghut.db")
            dsn = f"sqlite+pysqlite:///{db_path}"
            engine = create_engine(dsn, future=True)
            Base.metadata.create_all(engine)

            stdout = io.StringIO()
            with (
                patch.dict(os.environ, {"TEST_DB_DSN": dsn}),
                patch.object(
                    sys,
                    "argv",
                    [
                        "journal_tigerbeetle_order_events.py",
                        "--dsn-env",
                        "TEST_DB_DSN",
                        "--sources",
                        "strategy_runtime_ledger_bucket",
                        "--batch-size",
                        "5",
                        "--fail-on-degraded",
                        "--allow-data-quality-degraded",
                        "--json",
                    ],
                ),
                patch.object(script_cli, "TigerBeetleLedgerJournal", FakeJournal),
                patch.object(
                    script_cli, "reconcile_tigerbeetle_transfers"
                ) as reconcile,
                redirect_stdout(stdout),
            ):
                exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["selected"], 0)
        self.assertEqual(payload["journaled"], 0)
        self.assertEqual(payload["failed"], 0)
        self.assertEqual(payload["reconciliation"]["status"], "skipped")
        self.assertEqual(payload["reconciliation"]["reason"], "no_source_rows_selected")
        self.assertFalse(payload["reconcile_empty_selection"])
        self.assertEqual(FakeJournal.instances[0].runtime_buckets, [])
        self.assertEqual(FakeJournal.instances[0].stable_ref_backfills, 0)
        reconcile.assert_not_called()

    def test_main_can_reconcile_when_source_selects_no_rows(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "torghut.db")
            dsn = f"sqlite+pysqlite:///{db_path}"
            engine = create_engine(dsn, future=True)
            Base.metadata.create_all(engine)

            stdout = io.StringIO()
            with (
                patch.dict(os.environ, {"TEST_DB_DSN": dsn}),
                patch.object(
                    sys,
                    "argv",
                    [
                        "journal_tigerbeetle_order_events.py",
                        "--dsn-env",
                        "TEST_DB_DSN",
                        "--sources",
                        "strategy_runtime_ledger_bucket",
                        "--batch-size",
                        "5",
                        "--reconcile-limit",
                        "12",
                        "--reconcile-empty-selection",
                        "--fail-on-degraded",
                        "--allow-data-quality-degraded",
                        "--json",
                    ],
                ),
                patch.object(script_cli, "TigerBeetleLedgerJournal", FakeJournal),
                patch.object(
                    script_cli,
                    "reconcile_tigerbeetle_transfers",
                    return_value={"ok": True, "status": "ok"},
                ) as reconcile,
                redirect_stdout(stdout),
            ):
                exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["selected"], 0)
        self.assertTrue(payload["reconcile_empty_selection"])
        self.assertEqual(payload["reconciliation"]["status"], "ok")
        self.assertEqual(FakeJournal.instances[0].stable_ref_backfills, 0)
        reconcile.assert_called_once()
        self.assertEqual(reconcile.call_args.kwargs["limit"], 12)
        self.assertIs(
            reconcile.call_args.kwargs["client"],
            FakeJournal.instances[0].reconciliation_client,
        )
        self.assertIsNone(reconcile.call_args.kwargs["account_label"])

    def test_main_passes_account_label_to_empty_selection_reconciliation(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "torghut.db")
            dsn = f"sqlite+pysqlite:///{db_path}"
            engine = create_engine(dsn, future=True)
            Base.metadata.create_all(engine)

            stdout = io.StringIO()
            with (
                patch.dict(os.environ, {"TEST_DB_DSN": dsn}),
                patch.object(
                    sys,
                    "argv",
                    [
                        "journal_tigerbeetle_order_events.py",
                        "--dsn-env",
                        "TEST_DB_DSN",
                        "--sources",
                        "strategy_runtime_ledger_bucket",
                        "--account-label",
                        "TORGHUT_SIM",
                        "--batch-size",
                        "5",
                        "--reconcile-limit",
                        "12",
                        "--reconcile-empty-selection",
                        "--fail-on-degraded",
                        "--allow-data-quality-degraded",
                        "--json",
                    ],
                ),
                patch.object(script_cli, "TigerBeetleLedgerJournal", FakeJournal),
                patch.object(
                    script_cli,
                    "reconcile_tigerbeetle_transfers",
                    return_value={
                        "ok": True,
                        "status": "ok",
                        "account_label": "TORGHUT_SIM",
                    },
                ) as reconcile,
                redirect_stdout(stdout),
            ):
                exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["selected"], 0)
        self.assertEqual(payload["reconciliation"]["account_label"], "TORGHUT_SIM")
        reconcile.assert_called_once()
        self.assertEqual(reconcile.call_args.kwargs["account_label"], "TORGHUT_SIM")

    def test_main_reuses_fresh_reconciliation_when_empty_source_selects_no_rows(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "torghut.db")
            dsn = f"sqlite+pysqlite:///{db_path}"
            engine = create_engine(dsn, future=True)
            Base.metadata.create_all(engine)
            with Session(engine) as session:
                observed_at = datetime.now(timezone.utc)
                session.add(
                    TigerBeetleReconciliationRun(
                        cluster_id=2001,
                        started_at=observed_at,
                        finished_at=observed_at,
                        status="ok",
                        checked_transfer_count=26,
                        missing_transfer_count=0,
                        mismatched_transfer_count=0,
                        source_missing_count=0,
                        payload_json={
                            "ok": True,
                            "status": "ok",
                            "blockers": [],
                            "reconciliation_max_age_seconds": 300,
                            "runtime_ledger_checked_transfer_count": 26,
                            "runtime_ledger_signed_transfer_count": 26,
                            "runtime_ledger_missing_signed_ref_count": 0,
                        },
                    )
                )
                session.commit()

            stdout = io.StringIO()
            with (
                patch.dict(os.environ, {"TEST_DB_DSN": dsn}),
                patch.object(
                    sys,
                    "argv",
                    [
                        "journal_tigerbeetle_order_events.py",
                        "--dsn-env",
                        "TEST_DB_DSN",
                        "--sources",
                        "strategy_runtime_ledger_bucket",
                        "--batch-size",
                        "5",
                        "--reconcile-limit",
                        "12",
                        "--reconcile-empty-selection",
                        "--fail-on-degraded",
                        "--allow-data-quality-degraded",
                        "--json",
                    ],
                ),
                patch.object(script_cli, "TigerBeetleLedgerJournal", FakeJournal),
                patch.object(
                    script_cli, "reconcile_tigerbeetle_transfers"
                ) as reconcile,
                redirect_stdout(stdout),
            ):
                exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["selected"], 0)
        self.assertEqual(payload["journaled"], 0)
        self.assertEqual(payload["failed"], 0)
        self.assertEqual(payload["reconciliation"]["status"], "skipped")
        self.assertEqual(
            payload["reconciliation"]["reason"],
            "fresh_reconciliation_available",
        )
        self.assertEqual(
            payload["reconciliation"]["latest_status"],
            "ok",
        )
        self.assertFalse(payload["reconciliation"]["reconciliation_stale"])
        self.assertEqual(FakeJournal.instances[0].runtime_buckets, [])
        self.assertEqual(FakeJournal.instances[0].stable_ref_backfills, 0)
        reconcile.assert_not_called()
