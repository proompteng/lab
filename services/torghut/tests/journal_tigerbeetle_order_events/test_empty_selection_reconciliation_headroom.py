from __future__ import annotations

from tests.journal_tigerbeetle_order_events.support import (
    Base,
    FakeJournal,
    Session,
    Settings,
    SimpleNamespace,
    TigerBeetleReconciliationRun,
    _TestJournalTigerBeetleOrderEventsScriptBase,
    cast,
    create_engine,
    datetime,
    io,
    json,
    os,
    patch,
    redirect_stdout,
    script,
    script_cli,
    script_payloads,
    sys,
    tempfile,
    timedelta,
    timezone,
)


class TestEmptySelectionReconciliationHeadroom(
    _TestJournalTigerBeetleOrderEventsScriptBase
):
    def test_reuses_reconciliation_when_freshness_headroom_is_sufficient(
        self,
    ) -> None:
        session = object()
        with patch.object(
            script_payloads,
            "latest_tigerbeetle_reconciliation_payload",
            return_value={
                "ok": True,
                "status": "ok",
                "reconciliation_stale": False,
                "reconciliation_max_age_seconds": 3600,
                "age_seconds": 600,
                "blockers": [],
                "client_lookup_ok": True,
                "checked_transfer_count": 12,
            },
        ):
            result = script._fresh_reconciliation_for_empty_selection(
                session,
                settings_obj=cast(
                    Settings,
                    SimpleNamespace(tigerbeetle_cluster_id=2001),
                ),
                account_label=None,
                freshness_headroom_seconds=1800,
            )

        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result["remaining_freshness_seconds"], 3000)
        self.assertEqual(result["required_freshness_headroom_seconds"], 1800)

    def test_rejects_reconciliation_when_freshness_headroom_is_low(
        self,
    ) -> None:
        session = object()
        with patch.object(
            script_payloads,
            "latest_tigerbeetle_reconciliation_payload",
            return_value={
                "ok": True,
                "status": "ok",
                "reconciliation_stale": False,
                "reconciliation_max_age_seconds": 3600,
                "age_seconds": 3512,
                "blockers": [],
                "client_lookup_ok": True,
            },
        ) as latest:
            result = script._fresh_reconciliation_for_empty_selection(
                session,
                settings_obj=cast(
                    Settings,
                    SimpleNamespace(tigerbeetle_cluster_id=2001),
                ),
                account_label=None,
                freshness_headroom_seconds=1800,
            )

        self.assertIsNone(result)
        latest.assert_called_once_with(session, cluster_id=2001)

    def test_main_refreshes_empty_selection_when_freshness_headroom_is_low(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "torghut.db")
            dsn = f"sqlite+pysqlite:///{db_path}"
            engine = create_engine(dsn, future=True)
            Base.metadata.create_all(engine)
            with Session(engine) as session:
                observed_at = datetime.now(timezone.utc) - timedelta(seconds=3512)
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
                            "reconciliation_max_age_seconds": 3600,
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
                        "--reconcile-empty-selection-freshness-headroom-seconds",
                        "1800",
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
                        "account_label": None,
                    },
                ) as reconcile,
                redirect_stdout(stdout),
            ):
                exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["selected"], 0)
        self.assertEqual(payload["reconciliation"]["status"], "ok")
        reconcile.assert_called_once()
