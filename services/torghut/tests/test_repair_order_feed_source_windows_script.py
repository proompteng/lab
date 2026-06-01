from __future__ import annotations

import io
import json
import os
import sys
from unittest import TestCase
from unittest.mock import patch

from scripts import repair_order_feed_source_windows as script


class _FakeSession:
    def __init__(self) -> None:
        self.commits = 0
        self.rollbacks = 0

    def __enter__(self) -> _FakeSession:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        self.rollbacks += 1


class _FakeSessionFactory:
    def __init__(self, session: _FakeSession) -> None:
        self.session = session

    def __call__(self) -> _FakeSession:
        return self.session


class TestRepairOrderFeedSourceWindowsScript(TestCase):
    def test_main_defaults_to_dry_run_and_rolls_back(self) -> None:
        fake_session = _FakeSession()
        stdout = io.StringIO()

        with (
            patch.dict(os.environ, {"TEST_DSN": "postgresql://example/test"}),
            patch.object(
                sys,
                "argv",
                [
                    "repair_order_feed_source_windows.py",
                    "--dsn-env",
                    "TEST_DSN",
                    "--json",
                    "--batch-size",
                    "6000",
                    "--max-batches",
                    "3",
                ],
            ),
            patch.object(
                script, "create_engine", return_value=object()
            ) as create_engine,
            patch.object(
                script,
                "sessionmaker",
                return_value=_FakeSessionFactory(fake_session),
            ),
            patch.object(
                script,
                "backfill_order_feed_source_windows",
                return_value={
                    "selected": 5,
                    "source_windows_created": 3,
                    "source_windows_reused": 2,
                    "events_linked": 5,
                },
            ) as backfill,
            patch.object(
                script,
                "repair_order_feed_execution_links",
                return_value={
                    "selected": 4,
                    "executions_matched": 3,
                    "executions_linked": 2,
                    "events_linked": 3,
                    "events_without_execution": 1,
                },
            ) as repair_links,
            patch.object(
                script,
                "backfill_order_feed_events_from_executions",
            ) as backfill_execution_events,
            patch("sys.stdout", stdout),
        ):
            exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["apply"], False)
        self.assertEqual(payload["backfill_execution_events"], False)
        self.assertEqual(payload["dsn_env"], "TEST_DSN")
        self.assertEqual(payload["batch_size"], 5000)
        self.assertEqual(payload["max_batches"], 3)
        self.assertEqual(payload["selected"], 5)
        self.assertEqual(payload["source_windows_created"], 3)
        self.assertEqual(payload["source_windows_reused"], 2)
        self.assertEqual(payload["events_linked"], 5)
        self.assertEqual(payload["execution_link_candidates"], 4)
        self.assertEqual(payload["execution_link_executions_matched"], 3)
        self.assertEqual(payload["execution_link_executions_linked"], 2)
        self.assertEqual(payload["execution_link_events_linked"], 3)
        self.assertEqual(payload["execution_link_events_without_execution"], 1)
        self.assertEqual(payload["execution_event_backfill_candidates"], 0)
        self.assertEqual(payload["execution_event_backfill_events_created"], 0)
        self.assertEqual(payload["execution_event_backfill_source_windows_created"], 0)
        self.assertEqual(fake_session.commits, 0)
        self.assertEqual(fake_session.rollbacks, 1)
        create_engine.assert_called_once_with(
            "postgresql+psycopg://example/test",
            pool_pre_ping=True,
            future=True,
        )
        backfill.assert_called_once_with(
            fake_session,
            account_label=None,
            limit=5000,
        )
        repair_links.assert_called_once_with(
            fake_session,
            account_label=None,
            limit=5000,
        )
        backfill_execution_events.assert_not_called()

    def test_main_applies_until_selection_drops_below_batch_size(self) -> None:
        fake_session = _FakeSession()
        stdout = io.StringIO()

        with (
            patch.dict(os.environ, {"SIM_DSN": "postgresql://example/sim"}),
            patch.object(
                sys,
                "argv",
                [
                    "repair_order_feed_source_windows.py",
                    "--dsn-env",
                    "SIM_DSN",
                    "--account-label",
                    "TORGHUT_SIM",
                    "--batch-size",
                    "2",
                    "--max-batches",
                    "3",
                    "--apply",
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
                side_effect=[
                    {
                        "selected": 2,
                        "source_windows_created": 2,
                        "source_windows_reused": 0,
                        "events_linked": 2,
                    },
                    {
                        "selected": 1,
                        "source_windows_created": 0,
                        "source_windows_reused": 1,
                        "events_linked": 1,
                    },
                ],
            ) as backfill,
            patch.object(
                script,
                "repair_order_feed_execution_links",
                side_effect=[
                    {
                        "selected": 2,
                        "executions_matched": 2,
                        "executions_linked": 1,
                        "events_linked": 2,
                        "events_without_execution": 0,
                    },
                    {
                        "selected": 0,
                        "executions_matched": 0,
                        "executions_linked": 0,
                        "events_linked": 0,
                        "events_without_execution": 0,
                    },
                ],
            ) as repair_links,
            patch.object(
                script,
                "backfill_order_feed_events_from_executions",
            ) as backfill_execution_events,
            patch("sys.stdout", stdout),
        ):
            exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["apply"], True)
        self.assertEqual(payload["account_label"], "TORGHUT_SIM")
        self.assertEqual(payload["backfill_execution_events"], False)
        self.assertEqual(payload["selected"], 3)
        self.assertEqual(payload["source_windows_created"], 2)
        self.assertEqual(payload["source_windows_reused"], 1)
        self.assertEqual(payload["events_linked"], 3)
        self.assertEqual(payload["execution_link_candidates"], 2)
        self.assertEqual(payload["execution_link_executions_matched"], 2)
        self.assertEqual(payload["execution_link_executions_linked"], 1)
        self.assertEqual(payload["execution_link_events_linked"], 2)
        self.assertEqual(payload["execution_link_events_without_execution"], 0)
        self.assertEqual(fake_session.commits, 2)
        self.assertEqual(fake_session.rollbacks, 0)
        self.assertEqual(backfill.call_count, 2)
        self.assertEqual(backfill.call_args.kwargs["account_label"], "TORGHUT_SIM")
        self.assertEqual(backfill.call_args.kwargs["limit"], 2)
        self.assertEqual(repair_links.call_count, 2)
        self.assertEqual(repair_links.call_args.kwargs["account_label"], "TORGHUT_SIM")
        self.assertEqual(repair_links.call_args.kwargs["limit"], 2)
        backfill_execution_events.assert_not_called()

    def test_main_backfills_execution_events_when_enabled(self) -> None:
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
                    "selected": 0,
                    "executions_matched": 0,
                    "executions_linked": 0,
                    "events_linked": 0,
                    "events_without_execution": 0,
                },
            ),
            patch.object(
                script,
                "backfill_order_feed_events_from_executions",
                return_value={
                    "selected": 7,
                    "events_created": 6,
                    "source_windows_created": 6,
                    "skipped_existing_event": 1,
                    "skipped_missing_trade_decision": 0,
                    "skipped_missing_order_identity": 0,
                    "skipped_source_offset_collision": 0,
                },
            ) as backfill_execution_events,
            patch("sys.stdout", stdout),
        ):
            exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["apply"], True)
        self.assertEqual(payload["backfill_execution_events"], True)
        self.assertEqual(payload["account_label"], "PA3SX7FYNUTF")
        self.assertEqual(payload["execution_event_backfill_candidates"], 7)
        self.assertEqual(payload["execution_event_backfill_events_created"], 6)
        self.assertEqual(payload["execution_event_backfill_source_windows_created"], 6)
        self.assertEqual(payload["execution_event_backfill_skipped_existing_event"], 1)
        self.assertEqual(fake_session.commits, 1)
        backfill_execution_events.assert_called_once_with(
            fake_session,
            account_label="PA3SX7FYNUTF",
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
