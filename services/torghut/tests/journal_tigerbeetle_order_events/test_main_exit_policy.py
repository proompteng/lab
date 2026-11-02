from __future__ import annotations

from tests.journal_tigerbeetle_order_events.support import (
    Base,
    Decimal,
    ExecutionOrderEvent,
    FakeJournal,
    Session,
    Settings,
    SimpleNamespace,
    _TestJournalTigerBeetleOrderEventsScriptBase,
    _add_order_event,
    _add_real_source_rows,
    cast,
    create_engine,
    io,
    json,
    os,
    patch,
    redirect_stdout,
    script,
    script_cli,
    script_core,
    script_payloads,
    sys,
    tempfile,
)


class TestJournalMainExitPolicy(_TestJournalTigerBeetleOrderEventsScriptBase):
    def test_fresh_empty_selection_reconciliation_requires_clean_latest_payload(
        self,
    ) -> None:
        base_payload: dict[str, object] = {
            "ok": True,
            "status": "ok",
            "reconciliation_stale": False,
            "reconciliation_max_age_seconds": 300,
            "blockers": [],
            "client_lookup_ok": True,
        }
        rejection_cases = [
            {"ok": False},
            {"status": "degraded"},
            {"reconciliation_stale": True},
            {"reconciliation_max_age_seconds": 0},
            {"blockers": ["runtime_ledger_missing"]},
            {"blockers": True},
            {"client_lookup_ok": False},
        ]

        for override in rejection_cases:
            with self.subTest(override=override):
                payload = {**base_payload, **override}
                session = object()
                with patch.object(
                    script_payloads,
                    "latest_tigerbeetle_reconciliation_payload",
                    return_value=payload,
                ) as latest:
                    result = script._fresh_reconciliation_for_empty_selection(
                        session,
                        settings_obj=cast(
                            Settings,
                            SimpleNamespace(tigerbeetle_cluster_id=2001),
                        ),
                        account_label=None,
                    )

                self.assertIsNone(result)
                latest.assert_called_once_with(session, cluster_id=2001)

    def test_main_dry_run_rolls_back_without_reconcile(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "torghut.db")
            dsn = f"sqlite+pysqlite:///{db_path}"
            engine = create_engine(dsn, future=True)
            Base.metadata.create_all(engine)
            with Session(engine) as session:
                _add_order_event(session, fingerprint="selected", source_offset=1)
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
                        "--dry-run",
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
        self.assertTrue(payload["dry_run"])
        self.assertEqual(payload["journaled"], 1)
        reconcile.assert_not_called()

    def test_main_reports_scan_failed_rows_as_degraded_event_failures(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "torghut.db")
            dsn = f"sqlite+pysqlite:///{db_path}"
            engine = create_engine(dsn, future=True)
            Base.metadata.create_all(engine)
            with Session(engine) as session:
                bad = _add_order_event(session, fingerprint="bad", source_offset=1)
                bad.avg_fill_price = Decimal("190.2500001")
                _add_order_event(session, fingerprint="selected", source_offset=2)
                session.commit()

            real_build_plan = script.build_order_event_transfer_plan

            def build_plan_with_failure(
                session: Session,
                event: ExecutionOrderEvent,
                *,
                settings_obj: Settings,
            ) -> object:
                if event.event_fingerprint == "bad":
                    raise RuntimeError("scan failed")
                return real_build_plan(session, event, settings_obj=settings_obj)

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
                        "--json",
                    ],
                ),
                patch.object(script_cli, "TigerBeetleLedgerJournal", FakeJournal),
                patch.object(
                    script_cli,
                    "reconcile_tigerbeetle_transfers",
                    return_value={"ok": True},
                ),
                patch.object(
                    script_core,
                    "build_order_event_transfer_plan",
                    side_effect=build_plan_with_failure,
                ),
                redirect_stdout(stdout),
            ):
                exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["status"], "degraded")
        self.assertEqual(payload["journaled"], 1)
        self.assertEqual(payload["failed"], 1)
        self.assertEqual(payload["batches"][0]["scan_failed"], 1)

    def test_main_reports_degraded_for_failed_batch(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "torghut.db")
            dsn = f"sqlite+pysqlite:///{db_path}"
            engine = create_engine(dsn, future=True)
            Base.metadata.create_all(engine)
            with Session(engine) as session:
                _add_order_event(session, fingerprint="skip", source_offset=1)
                _add_order_event(session, fingerprint="fail", source_offset=2)
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
                        "--json",
                    ],
                ),
                patch.object(script_cli, "TigerBeetleLedgerJournal", FakeJournal),
                patch.object(
                    script_cli,
                    "reconcile_tigerbeetle_transfers",
                    return_value={"ok": False},
                ),
                redirect_stdout(stdout),
            ):
                exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["status"], "degraded")
        self.assertEqual(payload["skipped"], 1)
        self.assertEqual(payload["failed"], 1)
        self.assertEqual(
            payload["batches"][0]["error_counts"],
            {"RuntimeError:journal failed": 1},
        )
        sample_errors = payload["batches"][0]["sample_errors"]
        self.assertEqual(len(sample_errors), 1)
        self.assertTrue(sample_errors[0]["row_id"])
        self.assertEqual(sample_errors[0]["error_type"], "RuntimeError")
        self.assertEqual(sample_errors[0]["error"], "journal failed")

    def test_main_stops_journaling_after_tigerbeetle_timeout(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "torghut.db")
            dsn = f"sqlite+pysqlite:///{db_path}"
            engine = create_engine(dsn, future=True)
            Base.metadata.create_all(engine)
            with Session(engine) as session:
                _add_order_event(session, fingerprint="timeout", source_offset=1)
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
                        "--fail-on-degraded",
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
        self.assertEqual(exit_code, 1)
        self.assertEqual(payload["status"], "degraded")
        self.assertTrue(payload["stopped_early"])
        self.assertEqual(payload["stop_reasons"], ["tigerbeetle_rpc_timeout"])
        self.assertEqual(payload["failed"], 1)
        self.assertEqual(payload["reconciliation"]["status"], "skipped")
        reconcile.assert_not_called()
        fake_journal = FakeJournal.instances[-1]
        self.assertEqual(fake_journal.events, ["timeout"])
        self.assertEqual(fake_journal.executions, [])
        self.assertEqual(fake_journal.tca_metrics, [])

    def test_main_can_fail_closed_for_degraded_batch(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "torghut.db")
            dsn = f"sqlite+pysqlite:///{db_path}"
            engine = create_engine(dsn, future=True)
            Base.metadata.create_all(engine)
            with Session(engine) as session:
                _add_order_event(session, fingerprint="fail", source_offset=1)
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
                        "--fail-on-degraded",
                        "--json",
                    ],
                ),
                patch.object(script_cli, "TigerBeetleLedgerJournal", FakeJournal),
                patch.object(
                    script_cli,
                    "reconcile_tigerbeetle_transfers",
                    return_value={"ok": False},
                ),
                redirect_stdout(stdout),
            ):
                exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 1)
        self.assertTrue(payload["fail_on_degraded"])

    def test_main_can_fail_closed_for_degraded_reconciliation(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "torghut.db")
            dsn = f"sqlite+pysqlite:///{db_path}"
            engine = create_engine(dsn, future=True)
            Base.metadata.create_all(engine)
            with Session(engine) as session:
                _add_order_event(session, fingerprint="selected", source_offset=1)
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
                        "--fail-on-degraded",
                        "--json",
                    ],
                ),
                patch.object(script_cli, "TigerBeetleLedgerJournal", FakeJournal),
                patch.object(
                    script_cli,
                    "reconcile_tigerbeetle_transfers",
                    return_value={"ok": False, "blockers": ["missing"]},
                ),
                redirect_stdout(stdout),
            ):
                exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 1)
        self.assertEqual(payload["status"], "degraded")
        self.assertEqual(payload["failed"], 0)
        self.assertEqual(payload["journaled"], 1)

    def test_main_scheduled_non_authority_allows_data_quality_degraded_exit_zero(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "torghut.db")
            dsn = f"sqlite+pysqlite:///{db_path}"
            engine = create_engine(dsn, future=True)
            Base.metadata.create_all(engine)
            with Session(engine) as session:
                _add_order_event(session, fingerprint="selected", source_offset=1)
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
                        "ok": False,
                        "blockers": [
                            "tigerbeetle_source_amount_mismatch",
                            "tigerbeetle_unlinked_execution_cost",
                        ],
                        "promotion_authority": False,
                        "overrides_runtime_ledger_authority": False,
                    },
                ),
                redirect_stdout(stdout),
            ):
                exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["status"], "degraded")
        self.assertFalse(payload["ok"])
        self.assertFalse(payload["exit_nonzero"])
        self.assertFalse(payload["promotion_authority"])
        self.assertFalse(payload["overrides_runtime_ledger_authority"])
        self.assertEqual(payload["hard_failure_reasons"], [])
        self.assertEqual(
            payload["accounting_blockers"],
            [
                "tigerbeetle_source_amount_mismatch",
                "tigerbeetle_unlinked_execution_cost",
            ],
        )

    def test_main_scheduled_non_authority_fails_closed_for_batch_errors(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "torghut.db")
            dsn = f"sqlite+pysqlite:///{db_path}"
            engine = create_engine(dsn, future=True)
            Base.metadata.create_all(engine)
            with Session(engine) as session:
                _add_order_event(session, fingerprint="fail", source_offset=1)
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
                        "--fail-on-degraded",
                        "--allow-data-quality-degraded",
                        "--json",
                    ],
                ),
                patch.object(script_cli, "TigerBeetleLedgerJournal", FakeJournal),
                patch.object(
                    script_cli,
                    "reconcile_tigerbeetle_transfers",
                    return_value={"ok": True, "blockers": []},
                ),
                redirect_stdout(stdout),
            ):
                exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 1)
        self.assertEqual(payload["status"], "degraded")
        self.assertTrue(payload["exit_nonzero"])
        self.assertEqual(payload["hard_failure_reasons"], ["journal_batch_failures"])

    def test_main_scheduled_non_authority_fails_closed_for_tigerbeetle_infra_blocker(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "torghut.db")
            dsn = f"sqlite+pysqlite:///{db_path}"
            engine = create_engine(dsn, future=True)
            Base.metadata.create_all(engine)
            with Session(engine) as session:
                _add_order_event(session, fingerprint="selected", source_offset=1)
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
                        "ok": False,
                        "blockers": ["tigerbeetle_client_unavailable"],
                    },
                ),
                redirect_stdout(stdout),
            ):
                exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 1)
        self.assertEqual(payload["status"], "degraded")
        self.assertTrue(payload["exit_nonzero"])
        self.assertEqual(
            payload["hard_failure_reasons"],
            ["tigerbeetle_client_unavailable"],
        )

    def test_main_requires_dsn_env_var(self) -> None:
        with (
            patch.dict(os.environ, {}, clear=True),
            patch.object(
                sys,
                "argv",
                ["journal_tigerbeetle_order_events.py", "--dsn-env", "MISSING_DSN"],
            ),
            self.assertRaisesRegex(SystemExit, "missing DSN env var: MISSING_DSN"),
        ):
            script.main()
