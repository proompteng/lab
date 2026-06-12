from __future__ import annotations

import io
import json
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import (
    Base,
    Execution,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    OrderFeedSourceWindow,
    Strategy,
    TradeDecision,
)
from scripts import reconcile_cross_dsn_order_feed_links as cross_dsn_script
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
    def test_parse_optional_dt_handles_empty_and_naive_values(self) -> None:
        self.assertIsNone(script._parse_optional_dt(" "))
        parsed = script._parse_optional_dt("2026-05-13T17:00:00")
        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual(parsed.tzinfo, timezone.utc)
        self.assertEqual(parsed.isoformat(), "2026-05-13T17:00:00+00:00")

    def test_main_rejects_invalid_bounded_window(self) -> None:
        with (
            patch.dict(os.environ, {"SIM_DSN": "postgresql://example/sim"}),
            patch.object(
                sys,
                "argv",
                [
                    "repair_order_feed_source_windows.py",
                    "--dsn-env",
                    "SIM_DSN",
                    "--window-start",
                    "2026-05-13T17:30:00Z",
                    "--window-end",
                    "2026-05-13T17:00:00Z",
                    "--json",
                ],
            ),
            patch.object(script, "create_engine", return_value=object()),
            patch.object(script, "sessionmaker") as sessionmaker_mock,
        ):
            with self.assertRaises(SystemExit) as raised:
                script.main()

        self.assertEqual(str(raised.exception), "window_end_must_be_after_window_start")
        sessionmaker_mock.assert_called_once()

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
                    "decisions_matched": 1,
                    "events_linked": 3,
                    "decision_events_linked": 1,
                    "events_without_execution": 1,
                    "events_without_decision": 0,
                },
            ) as repair_links,
            patch.object(
                script,
                "backfill_order_feed_events_from_executions",
            ) as backfill_execution_events,
            patch.object(
                script,
                "repair_order_feed_execution_states",
                return_value={
                    "selected": 7,
                    "latest_event_found": 6,
                    "executions_updated": 5,
                    "out_of_order_events_skipped": 1,
                },
            ) as repair_states,
            patch.object(
                script,
                "repair_order_feed_fill_deltas",
                return_value={
                    "selected": 6,
                    "delta_events_repaired": 5,
                    "non_increasing_events_marked": 1,
                    "missing_identity_events_marked": 0,
                },
            ) as repair_deltas,
            patch("sys.stdout", stdout),
        ):
            exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["apply"], False)
        self.assertEqual(payload["backfill_execution_events"], False)
        self.assertEqual(payload["source_window_only"], False)
        self.assertEqual(payload["execution_event_backfill_enabled"], False)
        self.assertIsNone(payload["execution_event_backfill_skip_reason"])
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
        self.assertEqual(payload["execution_link_decisions_matched"], 1)
        self.assertEqual(payload["execution_link_events_linked"], 3)
        self.assertEqual(payload["execution_link_decision_events_linked"], 1)
        self.assertEqual(payload["execution_link_events_without_execution"], 1)
        self.assertEqual(payload["execution_link_events_without_decision"], 0)
        self.assertEqual(payload["execution_state_candidates"], 7)
        self.assertEqual(payload["execution_state_latest_event_found"], 6)
        self.assertEqual(payload["execution_state_executions_updated"], 5)
        self.assertEqual(payload["execution_state_out_of_order_events_skipped"], 1)
        self.assertEqual(payload["execution_event_backfill_candidates"], 0)
        self.assertEqual(payload["execution_event_backfill_events_created"], 0)
        self.assertEqual(payload["execution_event_backfill_source_windows_created"], 0)
        self.assertEqual(payload["fill_delta_candidates"], 6)
        self.assertEqual(payload["fill_delta_events_repaired"], 5)
        self.assertEqual(payload["fill_delta_non_increasing_events_marked"], 1)
        self.assertEqual(payload["fill_delta_missing_identity_events_marked"], 0)
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
            window_start=None,
            window_end=None,
            limit=5000,
        )
        repair_links.assert_called_once_with(
            fake_session,
            account_label=None,
            canonical_account_label=None,
            window_start=None,
            window_end=None,
            limit=5000,
        )
        backfill_execution_events.assert_not_called()
        repair_states.assert_called_once_with(
            fake_session,
            account_label=None,
            window_start=None,
            window_end=None,
            limit=5000,
        )
        repair_deltas.assert_called_once_with(
            fake_session,
            account_label=None,
            window_start=None,
            window_end=None,
            limit=5000,
        )

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
                        "decisions_matched": 0,
                        "events_linked": 2,
                        "decision_events_linked": 0,
                        "events_without_execution": 0,
                        "events_without_decision": 0,
                    },
                    {
                        "selected": 0,
                        "executions_matched": 0,
                        "executions_linked": 0,
                        "decisions_matched": 0,
                        "events_linked": 0,
                        "decision_events_linked": 0,
                        "events_without_execution": 0,
                        "events_without_decision": 0,
                    },
                ],
            ),
            patch.object(
                script,
                "backfill_order_feed_events_from_executions",
            ),
            patch.object(
                script,
                "repair_order_feed_execution_states",
                side_effect=[
                    {
                        "selected": 2,
                        "latest_event_found": 2,
                        "executions_updated": 2,
                        "out_of_order_events_skipped": 0,
                    },
                    {
                        "selected": 1,
                        "latest_event_found": 1,
                        "executions_updated": 0,
                        "out_of_order_events_skipped": 1,
                    },
                ],
            ),
            patch.object(
                script,
                "repair_order_feed_fill_deltas",
                side_effect=[
                    {
                        "selected": 2,
                        "delta_events_repaired": 2,
                        "non_increasing_events_marked": 0,
                        "missing_identity_events_marked": 0,
                    },
                    {
                        "selected": 1,
                        "delta_events_repaired": 0,
                        "non_increasing_events_marked": 1,
                        "missing_identity_events_marked": 0,
                    },
                ],
            ),
            patch("sys.stdout", stdout),
        ):
            exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["apply"], True)
        self.assertEqual(payload["account_label"], "TORGHUT_SIM")
        self.assertEqual(payload["backfill_execution_events"], False)
        self.assertEqual(payload["execution_event_backfill_enabled"], False)
        self.assertIsNone(payload["execution_event_backfill_skip_reason"])
        self.assertEqual(payload["selected"], 3)
        self.assertEqual(payload["source_windows_created"], 2)
        self.assertEqual(payload["source_windows_reused"], 1)
        self.assertEqual(payload["events_linked"], 3)
        self.assertEqual(payload["execution_link_candidates"], 2)
        self.assertEqual(payload["execution_link_executions_matched"], 2)
        self.assertEqual(payload["execution_link_executions_linked"], 1)
        self.assertEqual(payload["execution_link_decisions_matched"], 0)
        self.assertEqual(payload["execution_link_events_linked"], 2)
        self.assertEqual(payload["execution_link_decision_events_linked"], 0)
        self.assertEqual(payload["execution_link_events_without_execution"], 0)
        self.assertEqual(payload["execution_link_events_without_decision"], 0)
        self.assertEqual(payload["execution_state_candidates"], 3)
        self.assertEqual(payload["execution_state_latest_event_found"], 3)
        self.assertEqual(payload["execution_state_executions_updated"], 2)
        self.assertEqual(payload["execution_state_out_of_order_events_skipped"], 1)
        self.assertEqual(payload["fill_delta_candidates"], 3)
        self.assertEqual(payload["fill_delta_events_repaired"], 2)
        self.assertEqual(payload["fill_delta_non_increasing_events_marked"], 1)
        self.assertEqual(payload["fill_delta_missing_identity_events_marked"], 0)
        self.assertEqual(fake_session.commits, 2)
        self.assertEqual(fake_session.rollbacks, 0)
        self.assertEqual(backfill.call_count, 2)
        self.assertEqual(backfill.call_args.kwargs["account_label"], "TORGHUT_SIM")
        self.assertIsNone(backfill.call_args.kwargs["window_start"])
        self.assertIsNone(backfill.call_args.kwargs["window_end"])
        self.assertEqual(backfill.call_args.kwargs["limit"], 2)

    def test_main_passes_bounded_window_to_source_window_backfill(self) -> None:
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
                    "--window-start",
                    "2026-05-13T17:00:00Z",
                    "--window-end",
                    "2026-05-13T17:30:00Z",
                    "--json",
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
                return_value={
                    "selected": 2,
                    "source_windows_created": 1,
                    "source_windows_reused": 1,
                    "events_linked": 2,
                },
            ) as backfill,
            patch.object(
                script,
                "repair_order_feed_execution_links",
                return_value={
                    "selected": 0,
                    "executions_matched": 0,
                    "executions_linked": 0,
                    "decisions_matched": 0,
                    "events_linked": 0,
                    "decision_events_linked": 0,
                    "events_without_execution": 0,
                    "events_without_decision": 0,
                    "account_alias_events_linked": 0,
                },
            ) as repair_links,
            patch.object(
                script,
                "repair_order_feed_execution_states",
                return_value={
                    "selected": 0,
                    "latest_event_found": 0,
                    "executions_updated": 0,
                    "out_of_order_events_skipped": 0,
                },
            ) as repair_states,
            patch.object(
                script,
                "backfill_order_feed_events_from_executions",
            ) as backfill_execution_events,
            patch.object(
                script,
                "repair_order_feed_fill_deltas",
                return_value={
                    "selected": 0,
                    "delta_events_repaired": 0,
                    "non_increasing_events_marked": 0,
                    "missing_identity_events_marked": 0,
                },
            ) as repair_deltas,
            patch("sys.stdout", stdout),
        ):
            exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["window_start"], "2026-05-13T17:00:00+00:00")
        self.assertEqual(payload["window_end"], "2026-05-13T17:30:00+00:00")
        self.assertEqual(fake_session.commits, 1)
        self.assertEqual(fake_session.rollbacks, 0)
        backfill.assert_called_once()
        self.assertEqual(backfill.call_args.kwargs["account_label"], "TORGHUT_SIM")
        self.assertEqual(
            backfill.call_args.kwargs["window_start"].isoformat(),
            "2026-05-13T17:00:00+00:00",
        )
        self.assertEqual(
            backfill.call_args.kwargs["window_end"].isoformat(),
            "2026-05-13T17:30:00+00:00",
        )
        backfill_execution_events.assert_not_called()
        self.assertEqual(repair_links.call_count, 1)
        self.assertEqual(repair_links.call_args.kwargs["account_label"], "TORGHUT_SIM")
        self.assertIsNone(repair_links.call_args.kwargs["canonical_account_label"])
        self.assertEqual(
            repair_links.call_args.kwargs["window_start"].isoformat(),
            "2026-05-13T17:00:00+00:00",
        )
        self.assertEqual(
            repair_links.call_args.kwargs["window_end"].isoformat(),
            "2026-05-13T17:30:00+00:00",
        )
        self.assertEqual(repair_links.call_args.kwargs["limit"], 1000)
        self.assertEqual(repair_states.call_count, 1)
        self.assertEqual(repair_states.call_args.kwargs["account_label"], "TORGHUT_SIM")
        self.assertEqual(
            repair_states.call_args.kwargs["window_start"].isoformat(),
            "2026-05-13T17:00:00+00:00",
        )
        self.assertEqual(
            repair_states.call_args.kwargs["window_end"].isoformat(),
            "2026-05-13T17:30:00+00:00",
        )
        self.assertEqual(repair_states.call_args.kwargs["limit"], 1000)
        self.assertEqual(repair_deltas.call_count, 1)
        self.assertEqual(repair_deltas.call_args.kwargs["account_label"], "TORGHUT_SIM")
        self.assertEqual(
            repair_deltas.call_args.kwargs["window_start"].isoformat(),
            "2026-05-13T17:00:00+00:00",
        )
        self.assertEqual(
            repair_deltas.call_args.kwargs["window_end"].isoformat(),
            "2026-05-13T17:30:00+00:00",
        )
        self.assertEqual(repair_deltas.call_args.kwargs["limit"], 1000)

    def test_main_source_window_only_skips_broader_repairs(self) -> None:
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
                    "--source-window-only",
                    "--backfill-execution-events",
                    "--json",
                    "--apply",
                    "--batch-size",
                    "2",
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
                    "selected": 2,
                    "source_windows_created": 1,
                    "source_windows_reused": 1,
                    "events_linked": 2,
                },
            ) as backfill,
            patch.object(script, "repair_order_feed_execution_links") as repair_links,
            patch.object(script, "repair_order_feed_execution_states") as repair_states,
            patch.object(
                script,
                "backfill_order_feed_events_from_executions",
            ) as backfill_execution_events,
            patch.object(script, "repair_order_feed_fill_deltas") as repair_deltas,
            patch("sys.stdout", stdout),
        ):
            exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertTrue(payload["source_window_only"])
        self.assertFalse(payload["execution_event_backfill_enabled"])
        self.assertEqual(
            payload["execution_event_backfill_skip_reason"], "source_window_only"
        )
        self.assertEqual(payload["selected"], 2)
        self.assertEqual(payload["events_linked"], 2)
        self.assertEqual(payload["execution_link_candidates"], 0)
        self.assertEqual(payload["execution_state_candidates"], 0)
        self.assertEqual(payload["execution_event_backfill_candidates"], 0)
        self.assertEqual(payload["fill_delta_candidates"], 0)
        self.assertEqual(fake_session.commits, 1)
        self.assertEqual(fake_session.rollbacks, 0)
        backfill.assert_called_once_with(
            fake_session,
            account_label="TORGHUT_SIM",
            window_start=None,
            window_end=None,
            limit=2,
        )
        repair_links.assert_not_called()
        repair_states.assert_not_called()
        backfill_execution_events.assert_not_called()
        repair_deltas.assert_not_called()

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
                    "--window-start",
                    "2026-05-13T17:00:00Z",
                    "--window-end",
                    "2026-05-13T17:30:00Z",
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
            patch.object(
                script,
                "repair_order_feed_execution_states",
                return_value={
                    "selected": 0,
                    "latest_event_found": 0,
                    "executions_updated": 0,
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
            ) as repair_deltas,
            patch("sys.stdout", stdout),
        ):
            exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["apply"], True)
        self.assertEqual(payload["backfill_execution_events"], True)
        self.assertEqual(payload["execution_event_backfill_enabled"], True)
        self.assertIsNone(payload["execution_event_backfill_skip_reason"])
        self.assertEqual(payload["account_label"], "PA3SX7FYNUTF")
        self.assertEqual(payload["window_start"], "2026-05-13T17:00:00+00:00")
        self.assertEqual(payload["window_end"], "2026-05-13T17:30:00+00:00")
        self.assertEqual(payload["execution_state_candidates"], 0)
        self.assertEqual(payload["execution_state_executions_updated"], 0)
        self.assertEqual(payload["execution_event_backfill_candidates"], 7)
        self.assertEqual(payload["execution_event_backfill_events_created"], 6)
        self.assertEqual(payload["execution_event_backfill_source_windows_created"], 6)
        self.assertEqual(payload["execution_event_backfill_skipped_existing_event"], 1)
        self.assertEqual(payload["fill_delta_candidates"], 0)
        self.assertEqual(payload["fill_delta_events_repaired"], 0)
        self.assertEqual(fake_session.commits, 1)
        backfill_execution_events.assert_called_once_with(
            fake_session,
            account_label="PA3SX7FYNUTF",
            window_start=script._parse_optional_dt("2026-05-13T17:00:00Z"),
            window_end=script._parse_optional_dt("2026-05-13T17:30:00Z"),
            limit=100,
        )
        repair_states.assert_called_once_with(
            fake_session,
            account_label="PA3SX7FYNUTF",
            window_start=script._parse_optional_dt("2026-05-13T17:00:00Z"),
            window_end=script._parse_optional_dt("2026-05-13T17:30:00Z"),
            limit=100,
        )
        repair_deltas.assert_called_once_with(
            fake_session,
            account_label="PA3SX7FYNUTF",
            window_start=script._parse_optional_dt("2026-05-13T17:00:00Z"),
            window_end=script._parse_optional_dt("2026-05-13T17:30:00Z"),
            limit=100,
        )

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


def _sqlite_model_engine() -> object:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return engine


def _seed_canonical_execution(
    session: Session,
    *,
    order_id: str,
    client_order_id: str,
    execution_idempotency_key: str | None = None,
    account_label: str = "TORGHUT_SIM",
) -> tuple[TradeDecision, Execution, ExecutionTCAMetric]:
    strategy = Strategy(
        name=f"strategy-{client_order_id}",
        description="canonical sim strategy",
        enabled=True,
        base_timeframe="1Min",
        universe_type="symbols_list",
        universe_symbols=["AMZN"],
    )
    session.add(strategy)
    session.flush()
    decision = TradeDecision(
        strategy_id=strategy.id,
        alpaca_account_label=account_label,
        symbol="AMZN",
        timeframe="1Min",
        decision_json={"side": "buy", "qty": "1"},
        rationale="test",
        decision_hash=client_order_id,
        status="executed",
        executed_at=datetime(2026, 6, 11, 14, 30, tzinfo=timezone.utc),
    )
    session.add(decision)
    session.flush()
    execution = Execution(
        trade_decision_id=decision.id,
        alpaca_account_label=account_label,
        alpaca_order_id=order_id,
        client_order_id=client_order_id,
        symbol="AMZN",
        side="buy",
        order_type="market",
        time_in_force="day",
        submitted_qty=Decimal("1"),
        filled_qty=Decimal("1"),
        avg_fill_price=Decimal("100"),
        status="filled",
        execution_idempotency_key=execution_idempotency_key,
        raw_order={"id": order_id, "client_order_id": client_order_id},
        last_update_at=datetime(2026, 6, 11, 14, 30, tzinfo=timezone.utc),
    )
    session.add(execution)
    session.flush()
    metric = ExecutionTCAMetric(
        execution_id=execution.id,
        trade_decision_id=decision.id,
        strategy_id=strategy.id,
        alpaca_account_label=account_label,
        symbol="AMZN",
        side="buy",
        avg_fill_price=Decimal("100"),
        filled_qty=Decimal("1"),
        signed_qty=Decimal("1"),
        computed_at=datetime(2026, 6, 11, 14, 31, tzinfo=timezone.utc),
    )
    session.add(metric)
    session.flush()
    return decision, execution, metric


def _seed_live_source_window(
    session: Session, *, event_count: int
) -> OrderFeedSourceWindow:
    source_window = OrderFeedSourceWindow(
        consumer_group="torghut-order-feed-v1",
        source_topic="torghut.trade-updates.v1",
        source_partition=0,
        alpaca_account_label="PA3SX7FYNUTF",
        assignment_mode="group",
        source_revision="alpaca-trade-updates-v1",
        window_started_at=datetime(2026, 6, 11, 13, 30, tzinfo=timezone.utc),
        window_ended_at=datetime(2026, 6, 11, 20, 10, tzinfo=timezone.utc),
        start_offset=10_000,
        end_offset=10_000 + event_count - 1,
        consumed_count=event_count,
        inserted_count=event_count,
        unlinked_execution_count=event_count,
        unlinked_decision_count=event_count,
        status="inserted",
        status_reason="missing_execution_and_decision_links",
        classification_counts={
            "inserted": event_count,
            "unlinked_execution": event_count,
            "unlinked_decision": event_count,
        },
        payload_json={
            "classification_counts": {
                "inserted": event_count,
                "unlinked_execution": event_count,
                "unlinked_decision": event_count,
            }
        },
    )
    session.add(source_window)
    session.flush()
    return source_window


class TestCrossDsnOrderFeedReconciliationScript(TestCase):
    def test_cross_dsn_parse_datetime_dsn_and_helper_edges(self) -> None:
        with patch.object(
            sys,
            "argv",
            [
                "reconcile_cross_dsn_order_feed_links.py",
                "--source-account-label",
                "PA3SX7FYNUTF",
                "--canonical-account-label",
                "TORGHUT_SIM",
                "--window-start",
                "2026-06-11T13:30:00Z",
                "--window-end",
                "2026-06-11T20:10:00Z",
            ],
        ):
            args = cross_dsn_script._parse_args()

        self.assertEqual(args.event_dsn_env, "DB_DSN")
        self.assertEqual(args.canonical_dsn_env, "SIM_DB_DSN")
        self.assertEqual(args.limit, 5000)
        with self.assertRaisesRegex(SystemExit, "empty_datetime"):
            cross_dsn_script._parse_dt(" ")
        self.assertEqual(
            cross_dsn_script._parse_dt("2026-06-11T13:30:00").isoformat(),
            "2026-06-11T13:30:00+00:00",
        )
        self.assertEqual(
            cross_dsn_script._sqlalchemy_dsn("postgres://example/live"),
            "postgresql+psycopg://example/live",
        )
        self.assertEqual(
            cross_dsn_script._sqlalchemy_dsn("postgresql://example/sim"),
            "postgresql+psycopg://example/sim",
        )
        self.assertEqual(
            cross_dsn_script._sqlalchemy_dsn("sqlite+pysqlite:///:memory:"),
            "sqlite+pysqlite:///:memory:",
        )

        engine = _sqlite_model_engine()
        with Session(engine) as session:
            _, execution, _ = _seed_canonical_execution(
                session,
                order_id="duplicate-order",
                client_order_id="duplicate-client",
            )
            session.commit()
            self.assertEqual(
                cross_dsn_script._unique_executions([execution, execution]),
                [execution],
            )
            event_without_identity = ExecutionOrderEvent(
                event_fingerprint="no-order-identity",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=1,
                alpaca_account_label="PA3SX7FYNUTF",
                symbol="AMZN",
                raw_event={"event": "fill"},
            )
            self.assertEqual(
                cross_dsn_script._canonical_execution_matches(
                    session,
                    event_without_identity,
                    canonical_account_label="TORGHUT_SIM",
                ),
                [],
            )
            self.assertEqual(
                cross_dsn_script._event_raw_payload(
                    ExecutionOrderEvent(
                        event_fingerprint="raw-list-event",
                        source_topic="torghut.trade-updates.v1",
                        source_partition=0,
                        source_offset=2,
                        alpaca_account_label="PA3SX7FYNUTF",
                        symbol="AMZN",
                        raw_event=["raw-list"],
                    )
                ),
                {"raw_event": ["raw-list"]},
            )

    def test_cross_dsn_decision_fallback_handles_missing_no_match_and_single(
        self,
    ) -> None:
        engine = _sqlite_model_engine()
        with Session(engine) as session:
            strategy = Strategy(
                name="decision-fallback",
                description="decision fallback",
                enabled=True,
                base_timeframe="1Min",
                universe_type="symbols_list",
                universe_symbols=["AMZN"],
            )
            session.add(strategy)
            session.flush()
            decisions = [
                TradeDecision(
                    strategy_id=strategy.id,
                    alpaca_account_label="TORGHUT_SIM",
                    symbol="AMZN",
                    timeframe="1Min",
                    decision_json={"side": "buy"},
                    decision_hash="single-client",
                    status="submitted",
                ),
            ]
            session.add_all(decisions)
            session.flush()
            execution = Execution(
                trade_decision_id=None,
                alpaca_account_label="TORGHUT_SIM",
                alpaca_order_id="fallback-order",
                client_order_id="fallback-client",
                symbol="AMZN",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("0"),
                status="new",
                raw_order={"id": "fallback-order"},
                last_update_at=datetime(2026, 6, 11, 14, 30, tzinfo=timezone.utc),
            )
            session.add(execution)
            session.flush()
            event_without_client = ExecutionOrderEvent(
                event_fingerprint="fallback-no-client",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=1,
                alpaca_account_label="PA3SX7FYNUTF",
                symbol="AMZN",
                raw_event={"event": "fill"},
            )
            event_with_missing_client = ExecutionOrderEvent(
                event_fingerprint="fallback-missing-client",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=2,
                alpaca_account_label="PA3SX7FYNUTF",
                client_order_id="missing-client",
                symbol="AMZN",
                raw_event={"event": "fill"},
            )
            event_with_single_client = ExecutionOrderEvent(
                event_fingerprint="fallback-single-client",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=3,
                alpaca_account_label="PA3SX7FYNUTF",
                client_order_id="single-client",
                symbol="AMZN",
                raw_event={"event": "fill"},
            )

            self.assertIsNone(
                cross_dsn_script._canonical_decision_id(
                    session,
                    event_without_client,
                    execution,
                    canonical_account_label="TORGHUT_SIM",
                )
            )
            self.assertIsNone(
                cross_dsn_script._canonical_decision_id(
                    session,
                    event_with_missing_client,
                    execution,
                    canonical_account_label="TORGHUT_SIM",
                )
            )
            self.assertEqual(
                cross_dsn_script._canonical_decision_id(
                    session,
                    event_with_single_client,
                    execution,
                    canonical_account_label="TORGHUT_SIM",
                ),
                decisions[-1].id,
            )

    def test_cross_dsn_source_window_marking_handles_missing_and_empty_counts(
        self,
    ) -> None:
        event_engine = _sqlite_model_engine()
        linked_at = datetime(2026, 6, 11, 21, 0, tzinfo=timezone.utc)

        with Session(event_engine) as event_session:
            source_window = _seed_live_source_window(event_session, event_count=1)
            source_window.payload_json = ["not-a-mapping"]
            source_window.classification_counts = {
                "cross_dsn_execution_ref_count": 7,
            }
            event_session.commit()
            source_window_id = source_window.id

        with Session(event_engine) as event_session:
            marked = cross_dsn_script._mark_source_windows(
                event_session,
                source_window_ids={uuid.uuid4(), source_window_id},
                event_dsn_env="DB_DSN",
                canonical_dsn_env="SIM_DB_DSN",
                source_account_label="PA3SX7FYNUTF",
                canonical_account_label="TORGHUT_SIM",
                canonical_execution_ids=set(),
                canonical_trade_decision_ids=set(),
                canonical_tca_ids=set(),
                linked_at=linked_at,
            )
            event_session.commit()
            source_window = event_session.get(OrderFeedSourceWindow, source_window_id)

        self.assertEqual(marked, 1)
        assert source_window is not None
        self.assertEqual(
            source_window.payload_json["cross_dsn_execution_ref_count"],
            0,
        )
        self.assertNotIn(
            "cross_dsn_execution_ref_count",
            source_window.classification_counts,
        )
        self.assertEqual(
            source_window.payload_json["_torghut_cross_dsn_linkage"][
                "canonical_execution_ids"
            ],
            [],
        )

    def test_dry_run_and_apply_cross_dsn_refs_without_live_fks(self) -> None:
        event_engine = _sqlite_model_engine()
        canonical_engine = _sqlite_model_engine()
        window_start = datetime(2026, 6, 11, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 11, 20, 10, tzinfo=timezone.utc)
        linked_at = datetime(2026, 6, 11, 21, 0, tzinfo=timezone.utc)

        with Session(canonical_engine) as canonical_session:
            for index in range(4):
                _seed_canonical_execution(
                    canonical_session,
                    order_id=f"sim-order-{index}",
                    client_order_id=f"sim-client-{index}",
                )
            canonical_session.commit()

        with Session(event_engine) as event_session:
            source_window = _seed_live_source_window(event_session, event_count=16)
            for order_index in range(4):
                for event_index in range(4):
                    offset = 10_000 + (order_index * 4) + event_index
                    event_session.add(
                        ExecutionOrderEvent(
                            event_fingerprint=f"live-event-{order_index}-{event_index}",
                            source_topic="torghut.trade-updates.v1",
                            source_partition=0,
                            source_offset=offset,
                            alpaca_account_label="PA3SX7FYNUTF",
                            event_ts=window_start
                            + timedelta(minutes=order_index, seconds=event_index),
                            symbol="AMZN",
                            alpaca_order_id=f"sim-order-{order_index}",
                            client_order_id=f"sim-client-{order_index}",
                            event_type="fill",
                            status="filled",
                            qty=Decimal("1"),
                            filled_qty=Decimal("1"),
                            avg_fill_price=Decimal("100"),
                            raw_event={"event": "fill", "source_offset": offset},
                            source_window_id=source_window.id,
                        )
                    )
            event_session.commit()

        with (
            Session(event_engine) as event_session,
            Session(canonical_engine) as canonical_session,
        ):
            dry_run = cross_dsn_script.reconcile_cross_dsn_order_feed_links(
                event_session,
                canonical_session,
                event_dsn_env="DB_DSN",
                canonical_dsn_env="SIM_DB_DSN",
                source_account_label="PA3SX7FYNUTF",
                canonical_account_label="TORGHUT_SIM",
                window_start=window_start,
                window_end=window_end,
                apply=False,
                now=linked_at,
            )
            first_event = event_session.scalars(
                select(ExecutionOrderEvent).order_by(ExecutionOrderEvent.source_offset)
            ).first()

        self.assertEqual(dry_run["selected"], 16)
        self.assertEqual(dry_run["events_matched"], 16)
        self.assertEqual(dry_run["canonical_executions_matched"], 4)
        self.assertEqual(dry_run["canonical_trade_decisions_matched"], 4)
        self.assertEqual(dry_run["canonical_tca_matched"], 4)
        self.assertEqual(dry_run["events_ambiguous"], 0)
        self.assertEqual(dry_run["events_marked"], 0)
        assert first_event is not None
        self.assertNotIn("_torghut_cross_dsn_linkage", first_event.raw_event)

        with (
            Session(event_engine) as event_session,
            Session(canonical_engine) as canonical_session,
        ):
            applied = cross_dsn_script.reconcile_cross_dsn_order_feed_links(
                event_session,
                canonical_session,
                event_dsn_env="DB_DSN",
                canonical_dsn_env="SIM_DB_DSN",
                source_account_label="PA3SX7FYNUTF",
                canonical_account_label="TORGHUT_SIM",
                window_start=window_start,
                window_end=window_end,
                apply=True,
                now=linked_at,
            )
            event_session.commit()

        self.assertEqual(applied["selected"], 16)
        self.assertEqual(applied["events_matched"], 16)
        self.assertEqual(applied["events_marked"], 16)
        self.assertEqual(applied["source_windows_marked"], 1)
        self.assertEqual(applied["canonical_executions_matched"], 4)
        self.assertEqual(applied["canonical_trade_decisions_matched"], 4)
        self.assertEqual(applied["canonical_tca_matched"], 4)

        with Session(event_engine) as event_session:
            events = list(
                event_session.scalars(
                    select(ExecutionOrderEvent).order_by(
                        ExecutionOrderEvent.source_offset
                    )
                )
            )
            source_window = event_session.scalar(select(OrderFeedSourceWindow))

        self.assertEqual(len(events), 16)
        for event in events:
            self.assertIsNone(event.execution_id)
            self.assertIsNone(event.trade_decision_id)
            linkage = event.raw_event["_torghut_cross_dsn_linkage"]
            self.assertEqual(linkage["source_dsn_env"], "DB_DSN")
            self.assertEqual(linkage["canonical_dsn_env"], "SIM_DB_DSN")
            self.assertEqual(linkage["canonical_account_label"], "TORGHUT_SIM")
            self.assertFalse(linkage["promotion_authority_eligible"])
            self.assertTrue(linkage["canonical_execution_id"])
            self.assertTrue(linkage["canonical_trade_decision_id"])
            self.assertTrue(linkage["canonical_execution_tca_metric_id"])
        assert source_window is not None
        self.assertEqual(source_window.unlinked_execution_count, 16)
        self.assertEqual(source_window.unlinked_decision_count, 16)
        self.assertEqual(
            source_window.payload_json["cross_dsn_execution_ref_count"], 16
        )
        self.assertEqual(
            source_window.payload_json["cross_dsn_trade_decision_ref_count"],
            16,
        )
        self.assertEqual(source_window.payload_json["cross_dsn_tca_ref_count"], 16)
        self.assertEqual(
            source_window.classification_counts["cross_dsn_execution_ref_count"],
            16,
        )
        self.assertEqual(
            len(
                source_window.payload_json["_torghut_cross_dsn_linkage"][
                    "canonical_execution_ids"
                ]
            ),
            4,
        )

    def test_ambiguous_order_identity_fails_closed(self) -> None:
        event_engine = _sqlite_model_engine()
        canonical_engine = _sqlite_model_engine()
        window_start = datetime(2026, 6, 11, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 11, 20, 10, tzinfo=timezone.utc)

        with Session(canonical_engine) as canonical_session:
            _seed_canonical_execution(
                canonical_session,
                order_id="ambiguous-order",
                client_order_id="first-client",
            )
            _seed_canonical_execution(
                canonical_session,
                order_id="second-order",
                client_order_id="second-client",
                execution_idempotency_key="ambiguous-client",
            )
            canonical_session.commit()

        with Session(event_engine) as event_session:
            source_window = _seed_live_source_window(event_session, event_count=1)
            event_session.add(
                ExecutionOrderEvent(
                    event_fingerprint="live-ambiguous-event",
                    source_topic="torghut.trade-updates.v1",
                    source_partition=0,
                    source_offset=10_000,
                    alpaca_account_label="PA3SX7FYNUTF",
                    event_ts=window_start + timedelta(minutes=1),
                    symbol="AMZN",
                    alpaca_order_id="ambiguous-order",
                    client_order_id="ambiguous-client",
                    event_type="fill",
                    status="filled",
                    qty=Decimal("1"),
                    filled_qty=Decimal("1"),
                    avg_fill_price=Decimal("100"),
                    raw_event={"event": "fill"},
                    source_window_id=source_window.id,
                )
            )
            event_session.commit()

        with (
            Session(event_engine) as event_session,
            Session(canonical_engine) as canonical_session,
        ):
            result = cross_dsn_script.reconcile_cross_dsn_order_feed_links(
                event_session,
                canonical_session,
                event_dsn_env="DB_DSN",
                canonical_dsn_env="SIM_DB_DSN",
                source_account_label="PA3SX7FYNUTF",
                canonical_account_label="TORGHUT_SIM",
                window_start=window_start,
                window_end=window_end,
                apply=True,
                now=window_end,
            )
            event_session.commit()

        self.assertEqual(result["selected"], 1)
        self.assertEqual(result["events_matched"], 0)
        self.assertEqual(result["events_ambiguous"], 1)
        self.assertEqual(result["events_marked"], 0)
        self.assertEqual(result["source_windows_marked"], 0)
        self.assertFalse(result["promotion_authority_eligible"])

        with Session(event_engine) as event_session:
            event = event_session.scalar(select(ExecutionOrderEvent))
            source_window = event_session.scalar(select(OrderFeedSourceWindow))

        assert event is not None
        self.assertIsNone(event.execution_id)
        self.assertIsNone(event.trade_decision_id)
        self.assertNotIn("_torghut_cross_dsn_linkage", event.raw_event)
        assert source_window is not None
        self.assertNotIn("_torghut_cross_dsn_linkage", source_window.payload_json)

    def test_unmatched_and_missing_tca_are_reported_without_live_fks(self) -> None:
        event_engine = _sqlite_model_engine()
        canonical_engine = _sqlite_model_engine()
        window_start = datetime(2026, 6, 11, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 11, 20, 10, tzinfo=timezone.utc)

        with Session(canonical_engine) as canonical_session:
            _, _, metric = _seed_canonical_execution(
                canonical_session,
                order_id="matched-without-tca",
                client_order_id="matched-client",
            )
            canonical_session.delete(metric)
            canonical_session.commit()

        with Session(event_engine) as event_session:
            source_window = _seed_live_source_window(event_session, event_count=2)
            for offset, order_id, client_order_id in (
                (10_000, "matched-without-tca", "matched-client"),
                (10_001, "missing-canonical-order", "missing-client"),
            ):
                event_session.add(
                    ExecutionOrderEvent(
                        event_fingerprint=f"live-{order_id}",
                        source_topic="torghut.trade-updates.v1",
                        source_partition=0,
                        source_offset=offset,
                        alpaca_account_label="PA3SX7FYNUTF",
                        event_ts=window_start + timedelta(minutes=1),
                        symbol="AMZN",
                        alpaca_order_id=order_id,
                        client_order_id=client_order_id,
                        event_type="fill",
                        status="filled",
                        qty=Decimal("1"),
                        filled_qty=Decimal("1"),
                        avg_fill_price=Decimal("100"),
                        raw_event={"event": "fill"},
                        source_window_id=source_window.id,
                    )
                )
            event_session.commit()

        with (
            Session(event_engine) as event_session,
            Session(canonical_engine) as canonical_session,
        ):
            result = cross_dsn_script.reconcile_cross_dsn_order_feed_links(
                event_session,
                canonical_session,
                event_dsn_env="DB_DSN",
                canonical_dsn_env="SIM_DB_DSN",
                source_account_label="PA3SX7FYNUTF",
                canonical_account_label="TORGHUT_SIM",
                window_start=window_start,
                window_end=window_end,
                apply=True,
                now=window_end,
            )
            event_session.commit()

        self.assertEqual(result["selected"], 2)
        self.assertEqual(result["events_matched"], 1)
        self.assertEqual(result["events_unmatched"], 1)
        self.assertEqual(result["canonical_tca_matched"], 0)
        self.assertEqual(result["canonical_tca_missing"], 1)
        self.assertEqual(
            result["unmatched_order_identities"][0]["alpaca_order_id"],
            "missing-canonical-order",
        )

    def test_cross_dsn_main_rejects_missing_envs_and_invalid_window(self) -> None:
        base_argv = [
            "reconcile_cross_dsn_order_feed_links.py",
            "--event-dsn-env",
            "EVENT_DSN",
            "--canonical-dsn-env",
            "CANONICAL_DSN",
            "--source-account-label",
            "PA3SX7FYNUTF",
            "--canonical-account-label",
            "TORGHUT_SIM",
            "--window-start",
            "2026-06-11T20:10:00Z",
            "--window-end",
            "2026-06-11T13:30:00Z",
        ]
        with (
            patch.dict(os.environ, {}, clear=True),
            patch.object(sys, "argv", base_argv),
        ):
            with self.assertRaisesRegex(SystemExit, "missing DSN env var: EVENT_DSN"):
                cross_dsn_script.main()
        with (
            patch.dict(
                os.environ, {"EVENT_DSN": "postgres://example/live"}, clear=True
            ),
            patch.object(sys, "argv", base_argv),
        ):
            with self.assertRaisesRegex(
                SystemExit,
                "missing DSN env var: CANONICAL_DSN",
            ):
                cross_dsn_script.main()
        with (
            patch.dict(
                os.environ,
                {
                    "EVENT_DSN": "postgres://example/live",
                    "CANONICAL_DSN": "postgresql://example/sim",
                },
                clear=True,
            ),
            patch.object(sys, "argv", base_argv),
            patch.object(cross_dsn_script, "create_engine") as create_engine,
        ):
            with self.assertRaisesRegex(
                SystemExit,
                "window_end_must_be_after_window_start",
            ):
                cross_dsn_script.main()

        create_engine.assert_not_called()

    def test_cross_dsn_main_transaction_and_output_modes(self) -> None:
        def run_main(
            *,
            argv: list[str],
            event_session: _FakeSession,
            canonical_session: _FakeSession,
            reconcile_payload: dict[str, object],
        ) -> tuple[int, str]:
            stdout = io.StringIO()
            with (
                patch.dict(
                    os.environ,
                    {
                        "EVENT_DSN": "postgres://example/live",
                        "CANONICAL_DSN": "postgresql://example/sim",
                    },
                    clear=True,
                ),
                patch.object(sys, "argv", argv),
                patch.object(
                    cross_dsn_script,
                    "create_engine",
                    return_value=object(),
                ),
                patch.object(
                    cross_dsn_script,
                    "sessionmaker",
                    side_effect=[
                        _FakeSessionFactory(event_session),
                        _FakeSessionFactory(canonical_session),
                    ],
                ),
                patch.object(
                    cross_dsn_script,
                    "reconcile_cross_dsn_order_feed_links",
                    return_value=reconcile_payload,
                ),
                patch("sys.stdout", stdout),
            ):
                exit_code = cross_dsn_script.main()
            return exit_code, stdout.getvalue()

        base_argv = [
            "reconcile_cross_dsn_order_feed_links.py",
            "--event-dsn-env",
            "EVENT_DSN",
            "--canonical-dsn-env",
            "CANONICAL_DSN",
            "--source-account-label",
            "PA3SX7FYNUTF",
            "--canonical-account-label",
            "TORGHUT_SIM",
            "--window-start",
            "2026-06-11T13:30:00Z",
            "--window-end",
            "2026-06-11T20:10:00Z",
            "--limit",
            "6000",
        ]
        dry_event_session = _FakeSession()
        dry_canonical_session = _FakeSession()
        dry_code, dry_output = run_main(
            argv=base_argv,
            event_session=dry_event_session,
            canonical_session=dry_canonical_session,
            reconcile_payload={"status": "ok", "apply": False},
        )

        self.assertEqual(dry_code, 0)
        self.assertEqual(json.loads(dry_output)["apply"], False)
        self.assertIn("\n  ", dry_output)
        self.assertEqual(dry_event_session.commits, 0)
        self.assertEqual(dry_event_session.rollbacks, 1)
        self.assertEqual(dry_canonical_session.rollbacks, 1)

        apply_event_session = _FakeSession()
        apply_canonical_session = _FakeSession()
        apply_code, apply_output = run_main(
            argv=[*base_argv, "--apply", "--json"],
            event_session=apply_event_session,
            canonical_session=apply_canonical_session,
            reconcile_payload={"status": "ok", "apply": True},
        )

        self.assertEqual(apply_code, 0)
        self.assertEqual(json.loads(apply_output)["apply"], True)
        self.assertNotIn("\n  ", apply_output)
        self.assertEqual(apply_event_session.commits, 1)
        self.assertEqual(apply_event_session.rollbacks, 0)
        self.assertEqual(apply_canonical_session.rollbacks, 1)
