from __future__ import annotations

from tests.repair_order_feed_source_windows_script.support import (
    _FakeSession,
    _FakeSessionFactory,
    _TestRepairOrderFeedSourceWindowsScriptBase,
    io,
    json,
    os,
    patch,
    script,
    sys,
)


class TestMainSkipsExecutionEventBackfillForAccountAliasRepair(
    _TestRepairOrderFeedSourceWindowsScriptBase
):
    def test_main_skips_execution_event_backfill_for_account_alias_repair(self) -> None:
        fake_session = _FakeSession()
        stdout = io.StringIO()

        with (
            patch.dict(os.environ, {"LIVE_DSN": "postgresql://example/live"}),
            patch.object(
                sys,
                "argv",
                [
                    "repair_order_feed_source_windows.py",
                    "--dsn-env",
                    "LIVE_DSN",
                    "--account-label",
                    "PA3SX7FYNUTF",
                    "--canonical-account-label",
                    "TORGHUT_SIM",
                    "--batch-size",
                    "100",
                    "--max-batches",
                    "1",
                    "--backfill-execution-events",
                    "--apply",
                    "--json",
                ],
            ),
            patch.object(script, "create_engine", return_value=object()),
            patch.object(
                script,
                "sessionmaker",
                return_value=_FakeSessionFactory(fake_session),
            ),
            patch.object(
                script,
                "backfill_order_feed_source_windows",
                return_value={
                    "selected": 0,
                    "source_windows_created": 0,
                    "source_windows_reused": 0,
                    "events_linked": 0,
                },
            ),
            patch.object(
                script,
                "repair_order_feed_execution_links",
                return_value={
                    "selected": 1,
                    "executions_matched": 1,
                    "executions_linked": 1,
                    "decisions_matched": 1,
                    "events_linked": 1,
                    "decision_events_linked": 0,
                    "events_without_execution": 0,
                    "events_without_decision": 0,
                    "account_alias_events_linked": 1,
                },
            ),
            patch.object(
                script,
                "backfill_order_feed_events_from_executions",
            ) as backfill_execution_events,
            patch.object(
                script,
                "repair_order_feed_execution_states",
                return_value={
                    "selected": 1,
                    "latest_event_found": 1,
                    "executions_updated": 1,
                    "out_of_order_events_skipped": 0,
                },
            ) as repair_states,
            patch.object(
                script,
                "repair_order_feed_fill_deltas",
                return_value={
                    "selected": 0,
                    "delta_events_repaired": 0,
                    "non_increasing_events_marked": 0,
                    "missing_identity_events_marked": 0,
                },
            ),
            patch("sys.stdout", stdout),
        ):
            exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["apply"], True)
        self.assertEqual(payload["backfill_execution_events"], True)
        self.assertEqual(payload["execution_event_backfill_enabled"], False)
        self.assertEqual(
            payload["execution_event_backfill_skip_reason"],
            "account_alias_repair",
        )
        self.assertEqual(payload["execution_event_backfill_candidates"], 0)
        self.assertEqual(payload["execution_event_backfill_events_created"], 0)
        self.assertEqual(payload["execution_link_account_alias_events_linked"], 1)
        self.assertEqual(payload["execution_state_candidates"], 1)
        self.assertEqual(payload["execution_state_executions_updated"], 1)
        backfill_execution_events.assert_not_called()
        repair_states.assert_called_once_with(
            fake_session,
            account_label="TORGHUT_SIM",
            window_start=None,
            window_end=None,
            limit=100,
        )

    def test_main_requires_configured_dsn_env(self) -> None:
        with (
            patch.dict(os.environ, {}, clear=True),
            patch.object(
                sys,
                "argv",
                [
                    "repair_order_feed_source_windows.py",
                    "--dsn-env",
                    "MISSING_DSN",
                ],
            ),
        ):
            with self.assertRaisesRegex(SystemExit, "missing DSN env var: MISSING_DSN"):
                script.main()

    def test_sqlalchemy_dsn_uses_installed_psycopg_driver(self) -> None:
        self.assertEqual(
            script._sqlalchemy_dsn("postgresql://user:pass@postgres/torghut"),
            "postgresql+psycopg://user:pass@postgres/torghut",
        )
        self.assertEqual(
            script._sqlalchemy_dsn("postgres://user:pass@postgres/torghut"),
            "postgresql+psycopg://user:pass@postgres/torghut",
        )
        self.assertEqual(
            script._sqlalchemy_dsn("postgresql+psycopg://user:pass@postgres/torghut"),
            "postgresql+psycopg://user:pass@postgres/torghut",
        )
