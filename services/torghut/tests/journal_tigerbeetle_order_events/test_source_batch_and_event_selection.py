from __future__ import annotations

from tests.journal_tigerbeetle_order_events.support import (
    Decimal,
    Execution,
    FakeTigerBeetleClient,
    LEDGER_USD_MICRO,
    Session,
    Settings,
    SimpleNamespace,
    StrategyRuntimeLedgerBucket,
    TRANSFER_CODE_FILL_POST,
    TRANSFER_KIND_EXECUTION_FILL,
    TRANSFER_KIND_FILL_POST,
    TRANSFER_KIND_RUNTIME_NET_PNL,
    TigerBeetleAccountRef,
    TigerBeetleClientTimeoutError,
    TigerBeetleLedgerJournal,
    TigerBeetleTransferRef,
    _TestJournalTigerBeetleOrderEventsScriptBase,
    _add_order_event,
    argparse,
    build_runtime_ledger_bucket_transfer_plan,
    cron_runner,
    datetime,
    io,
    json,
    nullcontext,
    redirect_stderr,
    script,
    select,
    timezone,
)


class TestJournalSourceBatchAndEventSelection(
    _TestJournalTigerBeetleOrderEventsScriptBase
):
    def test_safe_payload_rejects_unsafe_supervised_exit_mismatches(self) -> None:
        safe_payload = {
            "schema_version": "torghut.tigerbeetle-journal-order-events.v1",
            "promotion_authority": False,
            "overrides_runtime_ledger_authority": False,
            "exit_nonzero": False,
            "failed": 0,
            "hard_failure_reasons": [],
            "stop_reasons": [],
        }
        unsafe_cases = [
            ("missing_payload", None),
            ("wrong_schema", {**safe_payload, "schema_version": "unrelated.worker.v1"}),
            ("promotion_authority", {**safe_payload, "promotion_authority": True}),
            (
                "runtime_ledger_authority_override",
                {**safe_payload, "overrides_runtime_ledger_authority": True},
            ),
            ("failed_rows", {**safe_payload, "failed": 2}),
            (
                "hard_failure_reasons",
                {**safe_payload, "hard_failure_reasons": ["journal_batch_failures"]},
            ),
            (
                "scalar_stop_reason",
                {**safe_payload, "stop_reasons": "tigerbeetle_rpc_timeout"},
            ),
        ]

        self.assertTrue(script._safe_payload_allows_success(safe_payload))
        for label, payload in unsafe_cases:
            with self.subTest(label=label):
                self.assertFalse(script._safe_payload_allows_success(payload))

    def test_manual_runner_keeps_live_sources_split_and_honest(self) -> None:
        cases = {
            "live": cron_runner._live_commands(execution_batch_size=10),
            "sim": cron_runner._sim_commands(),
        }
        for preset, commands in cases.items():
            self.assertEqual(
                [command.source for command in commands],
                [
                    script.SOURCE_TYPE_EXECUTION,
                    script.SOURCE_TYPE_EXECUTION_TCA_METRIC,
                    script.SOURCE_TYPE_EXECUTION_ORDER_EVENT,
                    script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                ],
            )
            command_argvs = [
                cron_runner._argv_for_command(
                    command,
                    json_output=True,
                    supervise_timeout_seconds=180.0,
                )
                for command in commands
            ]
            source_args = [argv[argv.index("--sources") + 1] for argv in command_argvs]
            self.assertEqual(source_args, [command.source for command in commands])
            self.assertTrue(all("," not in source for source in source_args))
            if preset == "live":
                order_event_argv = command_argvs[2]
                self.assertEqual(
                    order_event_argv[order_event_argv.index("--batch-size") + 1],
                    str(cron_runner.LIVE_ORDER_EVENT_BATCH_SIZE),
                )
                self.assertEqual(
                    order_event_argv[order_event_argv.index("--max-batches") + 1],
                    "1",
                )
            runtime_argv = command_argvs[-1]
            self.assertEqual(
                runtime_argv[runtime_argv.index("--sources") + 1],
                script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
            )
            if preset == "live":
                self.assertIn("--reconcile-empty-selection", runtime_argv)
                self.assertEqual(
                    runtime_argv[runtime_argv.index("--reconcile-limit") + 1],
                    str(cron_runner.LIVE_RECONCILE_LIMIT),
                )
            else:
                self.assertIn("--reconcile-empty-selection", runtime_argv)
            self.assertIn("--fail-on-degraded", runtime_argv)
            self.assertIn("--allow-data-quality-degraded", runtime_argv)

    def test_process_rows_attaches_runtime_bucket_journal_payload(self) -> None:
        settings_obj = Settings(
            TORGHUT_TIGERBEETLE_ENABLED=True,
            TORGHUT_TIGERBEETLE_JOURNAL_ENABLED=True,
        )
        observed_at = datetime.now(timezone.utc)
        with Session(self.engine) as session:
            bucket = StrategyRuntimeLedgerBucket(
                run_id="runtime-run-journal-attach",
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
                payload_json={
                    "source_refs": ["postgres:execution_order_events:event-1"],
                    "source_row_counts": {"execution_order_events": 1},
                    "source_window_refs": ["kafka:torghut.trade-updates.v1:0:1-2"],
                },
            )
            session.add(bucket)
            session.flush()
            ref = TigerBeetleTransferRef(
                cluster_id=settings_obj.tigerbeetle_cluster_id,
                transfer_id="340282366920938463463374607431768211",
                transfer_kind=TRANSFER_KIND_RUNTIME_NET_PNL,
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_FILL_POST,
                amount=Decimal("2500000"),
                status="created",
                runtime_ledger_bucket_id=bucket.id,
                source_type=script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                source_id=str(bucket.id),
                payload_json={
                    "debit_account_id": "100100100100100100100100100100100101",
                    "credit_account_id": "100100100100100100100100100100100102",
                },
            )
            session.add(ref)
            session.flush()

            batch = script._journal_source_batch(
                session,
                args=argparse.Namespace(dry_run=False),
                source=script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                rows=[bucket],
                journal_one=lambda row: ref,
            )

        self.assertEqual(batch["journaled"], 1)
        self.assertEqual(batch["failed"], 0)
        payload = bucket.payload_json
        self.assertIsInstance(payload, dict)
        self.assertIn("postgres:execution_order_events:event-1", payload["source_refs"])
        self.assertIn(
            f"postgres:strategy_runtime_ledger_buckets:{bucket.id}",
            payload["source_refs"],
        )
        self.assertIn(
            f"postgres:tigerbeetle_transfer_refs:{ref.id}",
            payload["source_refs"],
        )
        self.assertEqual(
            payload["source_row_counts"]["tigerbeetle_transfer_refs"],
            1,
        )
        self.assertEqual(
            payload["tigerbeetle_transfer_ids"],
            ["340282366920938463463374607431768211"],
        )
        self.assertEqual(
            payload["tigerbeetle_journal_parity"]["status"],
            "pass",
        )
        self.assertFalse(
            payload["tigerbeetle_journal_parity"]["promotion_authority"],
        )

    def test_source_batch_uses_batch_refs_for_runtime_attach_and_skips(self) -> None:
        with Session(self.engine) as session:
            bucket, ref = self._add_runtime_bucket_with_ref(
                session,
                run_id="runtime-run-batch-attach",
            )
            skipped = SimpleNamespace(id="skipped-runtime-row")

            batch = script._journal_source_batch(
                session,
                args=argparse.Namespace(dry_run=False, progress_interval=0),
                source=script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                rows=[bucket, skipped],
                journal_one=lambda row: (_ for _ in ()).throw(
                    AssertionError(f"unexpected row fallback: {row!r}")
                ),
                journal_many=lambda rows: [ref, None],
            )

        self.assertEqual(batch["journaled"], 1)
        self.assertEqual(batch["skipped"], 1)
        self.assertEqual(batch["failed"], 0)
        payload = bucket.payload_json
        self.assertIsInstance(payload, dict)
        self.assertIn(
            f"postgres:tigerbeetle_transfer_refs:{ref.id}",
            payload["source_refs"],
        )
        self.assertEqual(
            payload["tigerbeetle_transfer_ids"],
            [ref.transfer_id],
        )

    def test_source_batch_chunks_batch_refs_and_commits_between_chunks(self) -> None:
        rows = [
            SimpleNamespace(id="row-1"),
            SimpleNamespace(id="row-2"),
            SimpleNamespace(id="row-3"),
        ]
        calls: list[list[str]] = []

        class ChunkSession:
            commits = 0

            def begin_nested(self) -> object:
                return nullcontext()

            def commit(self) -> None:
                self.commits += 1

            def expunge_all(self) -> None:
                return None

        session = ChunkSession()

        batch = script._journal_source_batch(
            session,
            args=argparse.Namespace(
                dry_run=False,
                progress_interval=0,
                commit_each_row=True,
                journal_batch_chunk_size=2,
            ),
            source=script.SOURCE_TYPE_EXECUTION_TCA_METRIC,
            rows=rows,
            journal_one=lambda row: (_ for _ in ()).throw(
                AssertionError(f"unexpected row fallback: {row!r}")
            ),
            journal_many=lambda chunk: (
                calls.append([str(getattr(row, "id")) for row in chunk])
                or [object() for _ in chunk]
            ),
        )

        self.assertEqual(calls, [["row-1", "row-2"], ["row-3"]])
        self.assertEqual(session.commits, 2)
        self.assertEqual(batch["journaled"], 3)
        self.assertEqual(batch["failed"], 0)
        self.assertEqual(batch["journal_batch_chunk_size"], 2)
        self.assertEqual(batch["journal_batch_chunks"], 2)

    def test_source_batch_falls_back_from_count_mismatch_and_stops_on_timeout(
        self,
    ) -> None:
        with Session(self.engine) as session:
            bucket, ref = self._add_runtime_bucket_with_ref(
                session,
                run_id="runtime-run-fallback-attach",
            )
            bucket_id = bucket.id
            ref_id = ref.id
            timeout_row = SimpleNamespace(id="timeout-row")
            seen: list[str] = []

            def journal_one(row: object) -> object:
                seen.append(str(getattr(row, "id", "unknown")))
                if row is timeout_row:
                    raise TigerBeetleClientTimeoutError(
                        "tigerbeetle_create_transfers_timeout:10.000s"
                    )
                return ref

            batch = script._journal_source_batch(
                session,
                args=argparse.Namespace(
                    dry_run=False,
                    progress_interval=0,
                    commit_each_row=True,
                ),
                source=script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                rows=[bucket, timeout_row],
                journal_one=journal_one,
                journal_many=lambda rows: [],
            )
            persisted_bucket = session.get(StrategyRuntimeLedgerBucket, bucket_id)
            self.assertIsNotNone(persisted_bucket)
            assert persisted_bucket is not None
            payload = persisted_bucket.payload_json

        self.assertEqual(seen, [str(bucket_id), "timeout-row"])
        self.assertEqual(batch["journaled"], 1)
        self.assertEqual(batch["failed"], 1)
        self.assertTrue(batch["stopped_early"])
        self.assertEqual(batch["stop_reason"], "tigerbeetle_rpc_timeout")
        self.assertEqual(
            batch["error_counts"],
            {
                "TigerBeetleClientTimeoutError:tigerbeetle_create_transfers_timeout:10.000s": 1
            },
        )
        self.assertIsInstance(payload, dict)
        self.assertIn(
            f"postgres:tigerbeetle_transfer_refs:{ref_id}",
            payload["source_refs"],
        )

    def test_runtime_bucket_journal_materializes_signed_ref_and_is_idempotent(
        self,
    ) -> None:
        settings_obj = Settings(
            TORGHUT_TIGERBEETLE_ENABLED=True,
            TORGHUT_TIGERBEETLE_JOURNAL_ENABLED=True,
        )
        client = FakeTigerBeetleClient()
        observed_at = datetime.now(timezone.utc)
        with Session(self.engine) as session:
            bucket = StrategyRuntimeLedgerBucket(
                run_id="runtime-run-signed-ref",
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
                payload_json={
                    "source_refs": ["postgres:execution_order_events:event-1"],
                    "source_row_counts": {"execution_order_events": 1},
                    "source_window_refs": ["kafka:torghut.trade-updates.v1:0:1-2"],
                },
            )
            session.add(bucket)
            session.flush()
            plan = build_runtime_ledger_bucket_transfer_plan(bucket)
            self.assertIsNotNone(plan)
            assert plan is not None

            with TigerBeetleLedgerJournal(
                settings_obj=settings_obj,
                client=client,
            ) as journal:
                ref = journal.journal_runtime_ledger_bucket(session, bucket)
                self.assertIsNotNone(ref)
                assert ref is not None
                script._attach_runtime_bucket_journal_payload(bucket, ref)
                ref_again = journal.journal_runtime_ledger_bucket(session, bucket)

            session.flush()
            payload = ref.payload_json
            self.assertIsInstance(payload, dict)
            transfer = plan.transfer_spec
            self.assertEqual(ref_again, ref)
            self.assertEqual(ref.runtime_ledger_bucket_id, bucket.id)
            self.assertEqual(ref.source_type, script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET)
            self.assertEqual(ref.source_id, str(bucket.id))
            self.assertEqual(ref.transfer_id, str(transfer.transfer_id))
            self.assertEqual(payload["signed_amount_micros"], plan.signed_amount_micros)
            self.assertEqual(payload["pnl_direction"], plan.pnl_direction)
            self.assertEqual(
                payload["debit_account_id"], str(transfer.debit_account_id)
            )
            self.assertEqual(
                payload["credit_account_id"],
                str(transfer.credit_account_id),
            )
            self.assertEqual(len(client.transfers), 1)
            self.assertEqual(len(client.accounts), 4)
            self.assertEqual(
                len(
                    session.execute(
                        select(TigerBeetleTransferRef).where(
                            TigerBeetleTransferRef.source_type
                            == script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                            TigerBeetleTransferRef.source_id == str(bucket.id),
                        )
                    )
                    .scalars()
                    .all()
                ),
                1,
            )
            self.assertEqual(
                len(session.execute(select(TigerBeetleAccountRef)).scalars().all()),
                4,
            )
            self.assertEqual(
                script._select_unlinked_runtime_buckets(
                    session,
                    settings_obj=settings_obj,
                    account_label="paper",
                    limit=10,
                ),
                [],
            )

    def test_source_batch_stops_on_tigerbeetle_timeout(self) -> None:
        rows = [SimpleNamespace(id="first"), SimpleNamespace(id="second")]
        seen: list[str] = []

        def journal_one(row: SimpleNamespace) -> object:
            seen.append(str(row.id))
            raise TigerBeetleClientTimeoutError(
                "tigerbeetle_create_transfers_timeout:10.000s"
            )

        with Session(self.engine) as session:
            batch = script._journal_source_batch(
                session,
                args=argparse.Namespace(dry_run=False, progress_interval=0),
                source=script.SOURCE_TYPE_EXECUTION,
                rows=rows,
                journal_one=journal_one,
            )

        self.assertEqual(seen, ["first"])
        self.assertEqual(batch["failed"], 1)
        self.assertTrue(batch["stopped_early"])
        self.assertEqual(batch["stop_reason"], "tigerbeetle_rpc_timeout")
        self.assertEqual(
            batch["error_counts"],
            {
                "TigerBeetleClientTimeoutError:tigerbeetle_create_transfers_timeout:10.000s": 1
            },
        )

    def test_source_batch_can_commit_successful_rows_individually(self) -> None:
        class FakeNested:
            def __enter__(self) -> None:
                return None

            def __exit__(self, *args: object) -> bool:
                del args
                return False

        class FakeSession:
            commits = 0
            expunges = 0

            def begin_nested(self) -> FakeNested:
                return FakeNested()

            def commit(self) -> None:
                self.commits += 1

            def expunge_all(self) -> None:
                self.expunges += 1

        session = FakeSession()
        rows = [SimpleNamespace(id="first"), SimpleNamespace(id="second")]
        stderr = io.StringIO()

        with redirect_stderr(stderr):
            batch = script._journal_source_batch(
                session,
                args=argparse.Namespace(
                    dry_run=False,
                    progress_interval=1,
                    commit_each_row=True,
                ),
                source=script.SOURCE_TYPE_EXECUTION,
                rows=rows,
                journal_one=lambda row: object(),
            )

        self.assertEqual(batch["journaled"], 2)
        self.assertEqual(batch["failed"], 0)
        self.assertEqual(session.commits, 2)
        self.assertEqual(session.expunges, 2)
        events = [
            json.loads(line) for line in stderr.getvalue().splitlines() if line.strip()
        ]
        row_start_events = [
            event for event in events if event["event"] == "source_row_start"
        ]
        self.assertEqual(
            [event["row_id"] for event in row_start_events],
            ["first", "second"],
        )

    def test_select_unlinked_events_filters_to_journalable_account_rows(self) -> None:
        settings_obj = Settings(TORGHUT_TIGERBEETLE_ENABLED=True)
        with Session(self.engine) as session:
            selected = _add_order_event(
                session,
                fingerprint="selected",
                account_label="paper",
                source_offset=1,
            )
            _add_order_event(
                session,
                fingerprint="accepted-no-amount",
                account_label="paper",
                event_type="accepted",
                status="accepted",
                source_offset=2,
                has_amount=False,
            )
            _add_order_event(
                session,
                fingerprint="wrong-account",
                account_label="live",
                source_offset=3,
            )
            linked = _add_order_event(
                session,
                fingerprint="linked",
                account_label="paper",
                source_offset=4,
            )
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=settings_obj.tigerbeetle_cluster_id,
                    transfer_id="99",
                    transfer_kind=TRANSFER_KIND_FILL_POST,
                    ledger=LEDGER_USD_MICRO,
                    code=TRANSFER_CODE_FILL_POST,
                    amount=Decimal("190250000"),
                    status="created",
                    execution_order_event_id=linked.id,
                    event_fingerprint=linked.event_fingerprint,
                )
            )
            session.flush()

            events = script._select_unlinked_events(
                session,
                settings_obj=settings_obj,
                account_label="paper",
                limit=10,
                event_scan_limit=10,
            )

        self.assertEqual([event.id for event in events.rows], [selected.id])
        self.assertEqual(events.scan_failed, 0)

    def test_select_unlinked_events_rounds_high_precision_amount_rows(self) -> None:
        settings_obj = Settings(TORGHUT_TIGERBEETLE_ENABLED=True)
        with Session(self.engine) as session:
            rounded = _add_order_event(
                session,
                fingerprint="rounded-precision",
                account_label="paper",
                source_offset=1,
            )
            rounded.avg_fill_price = Decimal("190.2500001")
            selected = _add_order_event(
                session,
                fingerprint="selected",
                account_label="paper",
                source_offset=2,
            )
            session.add_all([rounded, selected])
            session.flush()

            events = script._select_unlinked_events(
                session,
                settings_obj=settings_obj,
                account_label="paper",
                limit=10,
                event_scan_limit=10,
            )

        self.assertEqual(
            [event.event_fingerprint for event in events.rows],
            ["rounded-precision", "selected"],
        )
        self.assertEqual(events.scan_failed, 0)

    def test_select_unlinked_events_honors_scan_limit(self) -> None:
        settings_obj = Settings(TORGHUT_TIGERBEETLE_ENABLED=True)
        with Session(self.engine) as session:
            rounded = _add_order_event(
                session,
                fingerprint="rounded-precision",
                account_label="paper",
                source_offset=1,
            )
            rounded.avg_fill_price = Decimal("190.2500001")
            _add_order_event(
                session,
                fingerprint="selected",
                account_label="paper",
                source_offset=2,
            )
            session.add(rounded)
            session.flush()

            events = script._select_unlinked_events(
                session,
                settings_obj=settings_obj,
                account_label="paper",
                limit=1,
                event_scan_limit=1,
            )

        self.assertEqual(
            [event.event_fingerprint for event in events.rows], ["rounded-precision"]
        )
        self.assertEqual(events.scan_failed, 0)

    def test_select_unlinked_events_stops_after_limit(self) -> None:
        settings_obj = Settings(TORGHUT_TIGERBEETLE_ENABLED=True)
        with Session(self.engine) as session:
            first = _add_order_event(
                session,
                fingerprint="selected-1",
                account_label="paper",
                source_offset=1,
            )
            _add_order_event(
                session,
                fingerprint="selected-2",
                account_label="paper",
                source_offset=2,
            )
            session.commit()

            events = script._select_unlinked_events(
                session,
                settings_obj=settings_obj,
                account_label="paper",
                limit=1,
                event_scan_limit=10,
            )

        self.assertEqual([event.id for event in events.rows], [first.id])
        self.assertEqual(events.scan_failed, 0)

    def test_select_unlinked_events_accepts_sub_micro_notional_rows(self) -> None:
        settings_obj = Settings(TORGHUT_TIGERBEETLE_ENABLED=True)
        with Session(self.engine) as session:
            selected = _add_order_event(
                session,
                fingerprint="sub-micro-notional",
                account_label="paper",
                avg_fill_price=Decimal("1.0000005"),
            )

            events = script._select_unlinked_events(
                session,
                settings_obj=settings_obj,
                account_label="paper",
                limit=10,
            )

        self.assertEqual([event.id for event in events.rows], [selected.id])
        self.assertEqual(events.scan_failed, 0)

    def test_select_unlinked_executions_uses_direct_ref_fk(self) -> None:
        settings_obj = Settings(TORGHUT_TIGERBEETLE_ENABLED=True)
        with Session(self.engine) as session:
            linked = Execution(
                alpaca_account_label="paper",
                alpaca_order_id="order-linked",
                client_order_id="client-linked",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.25"),
                status="filled",
                raw_order={"id": "order-linked"},
            )
            selected = Execution(
                alpaca_account_label="paper",
                alpaca_order_id="order-selected",
                client_order_id="client-selected",
                symbol="MSFT",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("410.50"),
                status="filled",
                raw_order={"id": "order-selected"},
            )
            session.add_all([linked, selected])
            session.flush()
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=settings_obj.tigerbeetle_cluster_id,
                    transfer_id="12001",
                    transfer_kind=TRANSFER_KIND_EXECUTION_FILL,
                    ledger=LEDGER_USD_MICRO,
                    code=TRANSFER_CODE_FILL_POST,
                    amount=Decimal("190250000"),
                    status="created",
                    execution_id=linked.id,
                )
            )
            session.flush()

            executions = script._select_unlinked_executions(
                session,
                settings_obj=settings_obj,
                account_label="paper",
                limit=10,
            )

        self.assertEqual([row.id for row in executions], [selected.id])
