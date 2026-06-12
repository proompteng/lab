from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.journal_tigerbeetle_order_events.support import *


class TestJournalTigerBeetleOrderEventsScriptPart1(
    _TestJournalTigerBeetleOrderEventsScriptBase
):
    def test_sqlalchemy_dsn_normalizes_postgres_urls(self) -> None:
        self.assertEqual(
            script._sqlalchemy_dsn("postgres://user:pass@host/db"),
            "postgresql+psycopg://user:pass@host/db",
        )
        self.assertEqual(
            script._sqlalchemy_dsn("postgresql://user:pass@host/db"),
            "postgresql+psycopg://user:pass@host/db",
        )
        self.assertEqual(
            script._sqlalchemy_dsn("postgresql+psycopg://user:pass@host/db"),
            "postgresql+psycopg://user:pass@host/db",
        )
        self.assertEqual(
            script._sqlalchemy_dsn("sqlite+pysqlite:///:memory:"),
            "sqlite+pysqlite:///:memory:",
        )

    def test_parse_sources_accepts_aliases_and_deduplicates(self) -> None:
        self.assertEqual(
            script._parse_sources("execution,tca,cost,runtime_ledger"),
            (
                script.SOURCE_TYPE_EXECUTION,
                script.SOURCE_TYPE_EXECUTION_TCA_METRIC,
                script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
            ),
        )
        self.assertEqual(script._parse_sources("all"), script.DEFAULT_SOURCES)
        with self.assertRaises(ValueError):
            script._parse_sources("unknown-source")

    def test_tigerbeetle_status_decoder_uses_operation_specific_enum(self) -> None:
        fake_tigerbeetle = SimpleNamespace(
            CreateAccountStatus=SimpleNamespace(exists=21),
            CreateTransferStatus=SimpleNamespace(debit_account_not_found=21),
        )

        with patch.dict(sys.modules, {"tigerbeetle": fake_tigerbeetle}):
            self.assertEqual(
                journal_model._result_statuses_by_index(
                    [{"index": 0, "status": 21}],
                    count=1,
                    default_status="created",
                    status_type_names=("CreateAccountStatus",),
                ),
                {0: "exists"},
            )
            self.assertEqual(
                journal_model._result_statuses_by_index(
                    [{"index": 0, "status": 21}],
                    count=1,
                    default_status="created",
                    status_type_names=("CreateTransferStatus",),
                ),
                {0: "debit_account_not_found"},
            )

    def test_payload_summarizes_batches(self) -> None:
        args = argparse.Namespace(
            dry_run=True,
            dsn_env="SIM_DB_DSN",
            account_label="paper",
            batch_size=10000,
            max_batches=0,
            event_scan_limit=1000,
            fail_on_degraded=False,
        )

        payload = script._payload(
            args=args,
            started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            batches=[
                {"selected": 2, "journaled": 1, "skipped": 0, "failed": 1},
                {"selected": 1, "journaled": 0, "skipped": 1, "failed": 0},
            ],
            reconciliation={"ok": True},
        )

        self.assertEqual(payload["status"], "degraded")
        self.assertEqual(payload["selected"], 3)
        self.assertEqual(payload["journaled"], 1)
        self.assertEqual(payload["skipped"], 1)
        self.assertEqual(payload["failed"], 1)
        self.assertEqual(payload["batch_size"], 5000)
        self.assertEqual(payload["max_batches"], 1)
        self.assertEqual(payload["event_scan_limit"], 1000)

    def test_payload_degrades_when_reconciliation_fails(self) -> None:
        args = argparse.Namespace(
            dry_run=False,
            dsn_env="SIM_DB_DSN",
            account_label="paper",
            batch_size=500,
            max_batches=1,
            event_scan_limit=None,
            fail_on_degraded=True,
            skip_reconcile=False,
            sources="all",
            supervised_worker=False,
            supervise_timeout_seconds=0.0,
            allow_data_quality_degraded=False,
        )

        payload = script._payload(
            args=args,
            started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            batches=[
                {"selected": 1, "journaled": 1, "skipped": 0, "failed": 0},
            ],
            reconciliation={"ok": False, "blockers": ["tigerbeetle_transfer_missing"]},
        )

        self.assertEqual(payload["status"], "degraded")
        self.assertEqual(payload["failed"], 0)
        self.assertTrue(payload["fail_on_degraded"])
        self.assertTrue(payload["exit_nonzero"])
        self.assertFalse(payload["promotion_authority"])
        self.assertFalse(payload["overrides_runtime_ledger_authority"])

    def test_payload_keeps_data_quality_blockers_visible_without_promotion_authority(
        self,
    ) -> None:
        args = argparse.Namespace(
            dry_run=False,
            dsn_env="SIM_DB_DSN",
            account_label="TORGHUT_SIM",
            batch_size=500,
            max_batches=1,
            event_scan_limit=None,
            fail_on_degraded=True,
            skip_reconcile=False,
            sources="all",
            supervised_worker=False,
            supervise_timeout_seconds=0.0,
            allow_data_quality_degraded=True,
        )

        payload = script._payload(
            args=args,
            started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            batches=[
                {"selected": 0, "journaled": 0, "skipped": 0, "failed": 0},
            ],
            reconciliation={
                "ok": False,
                "blockers": [
                    "tigerbeetle_source_amount_mismatch",
                    "tigerbeetle_unlinked_execution_cost",
                ],
                "promotion_authority": False,
                "overrides_runtime_ledger_authority": False,
            },
        )

        self.assertEqual(payload["status"], "degraded")
        self.assertFalse(payload["ok"])
        self.assertFalse(payload["exit_nonzero"])
        self.assertEqual(payload["exit_policy"], "fail_on_hard_failures_only")
        self.assertEqual(payload["hard_failure_reasons"], [])
        self.assertEqual(
            payload["accounting_blockers"],
            [
                "tigerbeetle_source_amount_mismatch",
                "tigerbeetle_unlinked_execution_cost",
            ],
        )
        self.assertEqual(
            payload["reconciliation_blockers"],
            [
                "tigerbeetle_source_amount_mismatch",
                "tigerbeetle_unlinked_execution_cost",
            ],
        )
        self.assertFalse(payload["promotion_authority"])
        self.assertFalse(payload["overrides_runtime_ledger_authority"])

    def test_supervised_worker_timeout_emits_degraded_payload(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()

        with (
            patch.dict(os.environ, {"DB_DSN": "sqlite+pysqlite:///:memory:"}),
            patch.object(
                sys,
                "argv",
                [
                    "journal_tigerbeetle_order_events.py",
                    "--dsn-env",
                    "DB_DSN",
                    "--sources",
                    "execution",
                    "--batch-size",
                    "50",
                    "--max-batches",
                    "1",
                    "--fail-on-degraded",
                    "--json",
                    "--supervise-timeout-seconds",
                    "0.01",
                ],
            ),
            patch(
                "scripts.journal_tigerbeetle_order_events.subprocess.run",
                side_effect=subprocess.TimeoutExpired(
                    cmd=["python", "journal_tigerbeetle_order_events.py"],
                    timeout=0.01,
                ),
            ) as run_mock,
            redirect_stdout(stdout),
            redirect_stderr(stderr),
        ):
            exit_code = script.main()

        self.assertEqual(exit_code, 1)
        payload = json.loads(stdout.getvalue())
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["status"], "degraded")
        self.assertTrue(payload["stopped_early"])
        self.assertEqual(
            payload["stop_reasons"],
            ["tigerbeetle_journal_worker_timeout"],
        )
        self.assertEqual(payload["failed"], 1)
        self.assertTrue(payload["exit_nonzero"])
        self.assertEqual(
            payload["hard_failure_reasons"],
            ["journal_batch_failures", "tigerbeetle_journal_worker_timeout"],
        )
        self.assertEqual(
            payload["reconciliation"]["reason"],
            "tigerbeetle_journal_worker_timeout",
        )
        self.assertIn("supervised_worker_timeout", stderr.getvalue())
        self.assertIn("--supervised-worker", run_mock.call_args.args[0])
        self.assertEqual(run_mock.call_args.kwargs["timeout"], 0.01)
        self.assertTrue(run_mock.call_args.kwargs["capture_output"])
        self.assertTrue(run_mock.call_args.kwargs["text"])

    def test_progress_events_ignore_invalid_json_and_non_progress_lines(self) -> None:
        progress = json.dumps(
            {
                "schema_version": "torghut.tigerbeetle-journal-progress.v1",
                "event": "source_batch_complete",
                "source": script.SOURCE_TYPE_EXECUTION_ORDER_EVENT,
            },
            separators=(",", ":"),
        )

        events = script._journal_progress_events(
            "\n".join(
                [
                    "plain log line",
                    "{not-json",
                    json.dumps({"schema_version": "other"}),
                    progress,
                ]
            )
        )

        self.assertEqual(events, [json.loads(progress)])
        self.assertEqual(script._progress_int("not-an-int"), 0)

    def test_completed_timeout_progress_rejects_untrusted_progress(self) -> None:
        def worker_args(
            sources: str = script.SOURCE_TYPE_EXECUTION_ORDER_EVENT,
        ) -> argparse.Namespace:
            return argparse.Namespace(
                skip_reconcile=True,
                sources=sources,
                journal_batch_chunk_size=25,
            )

        def complete_event(**overrides: object) -> str:
            payload: dict[str, object] = {
                "schema_version": "torghut.tigerbeetle-journal-progress.v1",
                "event": "source_batch_complete",
                "source": script.SOURCE_TYPE_EXECUTION_ORDER_EVENT,
                "selected": 1,
                "journaled": 1,
                "skipped": 0,
                "failed": 0,
                "stopped_early": False,
                "stop_reason": None,
            }
            payload.update(overrides)
            return json.dumps(payload, separators=(",", ":"))

        self.assertIsNone(
            script._completed_progress_batch_from_timeout(
                complete_event(),
                worker_args=worker_args(
                    f"{script.SOURCE_TYPE_EXECUTION_ORDER_EVENT},{script.SOURCE_TYPE_EXECUTION_TCA_METRIC}"
                ),
            )
        )
        self.assertIsNone(
            script._completed_progress_batch_from_timeout(
                json.dumps(
                    {
                        "schema_version": "torghut.tigerbeetle-journal-progress.v1",
                        "event": "source_batch_chunk_complete",
                        "source": script.SOURCE_TYPE_EXECUTION_ORDER_EVENT,
                    },
                    separators=(",", ":"),
                ),
                worker_args=worker_args(),
            )
        )
        self.assertIsNone(
            script._completed_progress_batch_from_timeout(
                complete_event(failed=1),
                worker_args=worker_args(),
            )
        )
        self.assertIsNone(
            script._completed_progress_batch_from_timeout(
                complete_event(stopped_early=True),
                worker_args=worker_args(),
            )
        )
        self.assertIsNone(
            script._completed_progress_batch_from_timeout(
                complete_event(journaled=0, skipped=0, failed=0, selected=2),
                worker_args=worker_args(),
            )
        )

    def test_supervised_worker_timeout_after_complete_progress_is_success(
        self,
    ) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        progress = "\n".join(
            [
                json.dumps(
                    {
                        "schema_version": "torghut.tigerbeetle-journal-progress.v1",
                        "event": "source_batch_start",
                        "source": script.SOURCE_TYPE_EXECUTION_ORDER_EVENT,
                        "selected": 50,
                    },
                    separators=(",", ":"),
                ),
                json.dumps(
                    {
                        "schema_version": "torghut.tigerbeetle-journal-progress.v1",
                        "event": "source_batch_chunk_complete",
                        "source": script.SOURCE_TYPE_EXECUTION_ORDER_EVENT,
                        "chunk_index": 0,
                        "chunk_size": 25,
                        "selected": 50,
                        "journaled": 25,
                        "skipped": 0,
                        "failed": 0,
                    },
                    separators=(",", ":"),
                ),
                json.dumps(
                    {
                        "schema_version": "torghut.tigerbeetle-journal-progress.v1",
                        "event": "source_batch_chunk_complete",
                        "source": script.SOURCE_TYPE_EXECUTION_ORDER_EVENT,
                        "chunk_index": 1,
                        "chunk_size": 25,
                        "selected": 50,
                        "journaled": 50,
                        "skipped": 0,
                        "failed": 0,
                    },
                    separators=(",", ":"),
                ),
                json.dumps(
                    {
                        "schema_version": "torghut.tigerbeetle-journal-progress.v1",
                        "event": "source_batch_complete",
                        "source": script.SOURCE_TYPE_EXECUTION_ORDER_EVENT,
                        "selected": 50,
                        "journaled": 50,
                        "skipped": 0,
                        "failed": 0,
                        "stopped_early": False,
                        "stop_reason": None,
                    },
                    separators=(",", ":"),
                ),
            ]
        )

        with (
            patch.dict(os.environ, {"DB_DSN": "sqlite+pysqlite:///:memory:"}),
            patch.object(
                sys,
                "argv",
                [
                    "journal_tigerbeetle_order_events.py",
                    "--dsn-env",
                    "DB_DSN",
                    "--sources",
                    script.SOURCE_TYPE_EXECUTION_ORDER_EVENT,
                    "--batch-size",
                    "50",
                    "--max-batches",
                    "1",
                    "--skip-reconcile",
                    "--fail-on-degraded",
                    "--allow-data-quality-degraded",
                    "--commit-each-row",
                    "--json",
                    "--supervise-timeout-seconds",
                    "0.01",
                ],
            ),
            patch(
                "scripts.journal_tigerbeetle_order_events.subprocess.run",
                side_effect=subprocess.TimeoutExpired(
                    cmd=["python", "journal_tigerbeetle_order_events.py"],
                    timeout=0.01,
                    stderr=progress,
                ),
            ),
            redirect_stdout(stdout),
            redirect_stderr(stderr),
        ):
            exit_code = script.main()

        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue().splitlines()[-1])
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["status"], "ok")
        self.assertFalse(payload["promotion_authority"])
        self.assertFalse(payload["overrides_runtime_ledger_authority"])
        self.assertFalse(payload["exit_nonzero"])
        self.assertEqual(payload["selected"], 50)
        self.assertEqual(payload["journaled"], 50)
        self.assertEqual(payload["skipped"], 0)
        self.assertEqual(payload["failed"], 0)
        self.assertEqual(payload["stop_reasons"], [])
        self.assertEqual(payload["hard_failure_reasons"], [])
        self.assertTrue(payload["supervised_worker_timeout_normalized"])
        self.assertEqual(
            payload["supervised_worker_timeout_reason"],
            "worker_completed_batch_before_process_exit_timeout",
        )
        self.assertEqual(payload["batches"][0]["journal_batch_chunks"], 2)
        self.assertTrue(payload["batches"][0]["supervised_worker_timeout_normalized"])
        self.assertIn(
            "supervised_worker_timeout_after_complete_normalized",
            stderr.getvalue(),
        )

    def test_supervised_worker_timeout_after_complete_requires_skip_reconcile(
        self,
    ) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        progress = json.dumps(
            {
                "schema_version": "torghut.tigerbeetle-journal-progress.v1",
                "event": "source_batch_complete",
                "source": script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                "selected": 1,
                "journaled": 1,
                "skipped": 0,
                "failed": 0,
                "stopped_early": False,
                "stop_reason": None,
            },
            separators=(",", ":"),
        )

        with (
            patch.dict(os.environ, {"DB_DSN": "sqlite+pysqlite:///:memory:"}),
            patch.object(
                sys,
                "argv",
                [
                    "journal_tigerbeetle_order_events.py",
                    "--dsn-env",
                    "DB_DSN",
                    "--sources",
                    script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                    "--batch-size",
                    "1",
                    "--max-batches",
                    "1",
                    "--reconcile-empty-selection",
                    "--fail-on-degraded",
                    "--allow-data-quality-degraded",
                    "--json",
                    "--supervise-timeout-seconds",
                    "0.01",
                ],
            ),
            patch(
                "scripts.journal_tigerbeetle_order_events.subprocess.run",
                side_effect=subprocess.TimeoutExpired(
                    cmd=["python", "journal_tigerbeetle_order_events.py"],
                    timeout=0.01,
                    stderr=progress,
                ),
            ),
            redirect_stdout(stdout),
            redirect_stderr(stderr),
        ):
            exit_code = script.main()

        self.assertEqual(exit_code, 1)
        payload = json.loads(stdout.getvalue().splitlines()[-1])
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["failed"], 1)
        self.assertEqual(
            payload["stop_reasons"],
            ["tigerbeetle_journal_worker_timeout"],
        )
        self.assertTrue(payload["exit_nonzero"])
        self.assertIn("supervised_worker_timeout", stderr.getvalue())
        self.assertNotIn(
            "supervised_worker_timeout_after_complete_normalized",
            stderr.getvalue(),
        )

    def test_supervised_worker_splits_multi_source_timeout_budget(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()

        with (
            patch.dict(os.environ, {"DB_DSN": "sqlite+pysqlite:///:memory:"}),
            patch.object(
                sys,
                "argv",
                [
                    "journal_tigerbeetle_order_events.py",
                    "--dsn-env",
                    "DB_DSN",
                    "--sources",
                    "execution,execution_tca_metric",
                    "--batch-size",
                    "50",
                    "--max-batches",
                    "1",
                    "--fail-on-degraded",
                    "--allow-data-quality-degraded",
                    "--json",
                    "--supervise-timeout-seconds",
                    "0.01",
                ],
            ),
            patch(
                "scripts.journal_tigerbeetle_order_events.subprocess.run",
                side_effect=[
                    subprocess.CompletedProcess(
                        args=["python", "journal_tigerbeetle_order_events.py"],
                        returncode=0,
                    ),
                    subprocess.TimeoutExpired(
                        cmd=["python", "journal_tigerbeetle_order_events.py"],
                        timeout=0.01,
                    ),
                ],
            ) as run_mock,
            redirect_stdout(stdout),
            redirect_stderr(stderr),
        ):
            exit_code = script.main()

        self.assertEqual(exit_code, 1)
        self.assertEqual(run_mock.call_count, 2)
        first_argv = run_mock.call_args_list[0].args[0]
        second_argv = run_mock.call_args_list[1].args[0]
        self.assertEqual(
            first_argv[first_argv.index("--sources") + 1],
            script.SOURCE_TYPE_EXECUTION,
        )
        self.assertEqual(
            second_argv[second_argv.index("--sources") + 1],
            script.SOURCE_TYPE_EXECUTION_TCA_METRIC,
        )
        self.assertIn("--supervised-worker", first_argv)
        self.assertIn("--supervised-worker", second_argv)
        self.assertEqual(run_mock.call_args_list[0].kwargs["timeout"], 0.01)
        self.assertEqual(run_mock.call_args_list[1].kwargs["timeout"], 0.01)
        self.assertTrue(run_mock.call_args_list[0].kwargs["capture_output"])
        self.assertTrue(run_mock.call_args_list[1].kwargs["capture_output"])

        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["sources"], [script.SOURCE_TYPE_EXECUTION_TCA_METRIC])
        self.assertFalse(payload["ok"])
        self.assertTrue(payload["exit_nonzero"])
        self.assertEqual(
            payload["hard_failure_reasons"],
            ["journal_batch_failures", "tigerbeetle_journal_worker_timeout"],
        )
        self.assertIn("supervised_worker_timeout", stderr.getvalue())
        self.assertIn(script.SOURCE_TYPE_EXECUTION_TCA_METRIC, stderr.getvalue())
        self.assertNotIn(
            f'"{script.SOURCE_TYPE_EXECUTION}","{script.SOURCE_TYPE_EXECUTION_TCA_METRIC}"',
            stderr.getvalue(),
        )

    def test_supervised_worker_normalizes_safe_payload_exit_mismatch(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        safe_payload = {
            "schema_version": "torghut.tigerbeetle-journal-order-events.v1",
            "ok": False,
            "status": "degraded",
            "authority": "non_authoritative_tigerbeetle_journal_telemetry",
            "promotion_authority": False,
            "overrides_runtime_ledger_authority": False,
            "exit_nonzero": False,
            "failed": 0,
            "hard_failure_reasons": [],
            "stop_reasons": [],
            "accounting_blockers": ["tigerbeetle_unlinked_execution"],
            "reconciliation_blockers": ["tigerbeetle_unlinked_execution"],
            "sources": [script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET],
        }

        with (
            patch.dict(os.environ, {"DB_DSN": "sqlite+pysqlite:///:memory:"}),
            patch.object(
                sys,
                "argv",
                [
                    "journal_tigerbeetle_order_events.py",
                    "--dsn-env",
                    "DB_DSN",
                    "--sources",
                    script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                    "--batch-size",
                    "5",
                    "--max-batches",
                    "1",
                    "--fail-on-degraded",
                    "--allow-data-quality-degraded",
                    "--json",
                    "--supervise-timeout-seconds",
                    "0.01",
                ],
            ),
            patch(
                "scripts.journal_tigerbeetle_order_events.subprocess.run",
                return_value=subprocess.CompletedProcess(
                    args=["python", "journal_tigerbeetle_order_events.py"],
                    returncode=1,
                    stdout=json.dumps(safe_payload, separators=(",", ":")) + "\n",
                    stderr="",
                ),
            ),
            redirect_stdout(stdout),
            redirect_stderr(stderr),
        ):
            exit_code = script.main()

        self.assertEqual(exit_code, 0)
        self.assertEqual(json.loads(stdout.getvalue()), safe_payload)
        progress = json.loads(stderr.getvalue())
        self.assertEqual(
            progress["event"],
            "supervised_worker_exit_mismatch_normalized",
        )
        self.assertEqual(progress["returncode"], 1)
        self.assertEqual(
            progress["sources"],
            [script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET],
        )
        self.assertEqual(
            progress["accounting_blockers"],
            ["tigerbeetle_unlinked_execution"],
        )

    def test_supervised_worker_keeps_unsafe_payload_exit_nonzero(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        unsafe_payload = {
            "schema_version": "torghut.tigerbeetle-journal-order-events.v1",
            "ok": False,
            "status": "degraded",
            "authority": "non_authoritative_tigerbeetle_journal_telemetry",
            "promotion_authority": False,
            "overrides_runtime_ledger_authority": False,
            "exit_nonzero": True,
            "failed": 1,
            "hard_failure_reasons": ["journal_batch_failures"],
            "stop_reasons": [],
            "accounting_blockers": [],
            "reconciliation_blockers": [],
            "sources": [script.SOURCE_TYPE_EXECUTION],
        }

        with (
            patch.dict(os.environ, {"DB_DSN": "sqlite+pysqlite:///:memory:"}),
            patch.object(
                sys,
                "argv",
                [
                    "journal_tigerbeetle_order_events.py",
                    "--dsn-env",
                    "DB_DSN",
                    "--sources",
                    script.SOURCE_TYPE_EXECUTION,
                    "--batch-size",
                    "5",
                    "--max-batches",
                    "1",
                    "--fail-on-degraded",
                    "--json",
                    "--supervise-timeout-seconds",
                    "0.01",
                ],
            ),
            patch(
                "scripts.journal_tigerbeetle_order_events.subprocess.run",
                return_value=subprocess.CompletedProcess(
                    args=["python", "journal_tigerbeetle_order_events.py"],
                    returncode=1,
                    stdout=json.dumps(unsafe_payload, separators=(",", ":")) + "\n",
                    stderr="",
                ),
            ),
            redirect_stdout(stdout),
            redirect_stderr(stderr),
        ):
            exit_code = script.main()

        self.assertEqual(exit_code, 1)
        self.assertEqual(json.loads(stdout.getvalue()), unsafe_payload)
        self.assertEqual(stderr.getvalue(), "")

    def test_last_journal_payload_skips_worker_noise_and_invalid_json(self) -> None:
        first_payload = {
            "schema_version": "torghut.tigerbeetle-journal-order-events.v1",
            "status": "stale",
        }
        final_payload = {
            "schema_version": "torghut.tigerbeetle-journal-order-events.v1",
            "status": "degraded",
            "exit_nonzero": False,
        }

        payload = script._last_journal_payload(
            "\n".join(
                [
                    "worker booted before json output",
                    "{invalid-json",
                    json.dumps({"schema_version": "unrelated.worker.v1"}),
                    json.dumps(first_payload, separators=(",", ":")),
                    "worker flushed trailing progress",
                    json.dumps(final_payload, separators=(",", ":")),
                ]
            )
        )

        self.assertEqual(payload, final_payload)
