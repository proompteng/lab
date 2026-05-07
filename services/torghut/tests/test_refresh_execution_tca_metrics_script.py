from __future__ import annotations

import io
import json
import sys
from unittest import TestCase
from unittest.mock import patch

from scripts import refresh_execution_tca_metrics as script


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


class TestRefreshExecutionTcaMetricsScript(TestCase):
    def test_main_defaults_to_dry_run_and_rolls_back(self) -> None:
        fake_session = _FakeSession()
        stdout = io.StringIO()

        with (
            patch.object(sys, "argv", ["refresh_execution_tca_metrics.py", "--json"]),
            patch.object(script, "SessionLocal", return_value=fake_session),
            patch.object(
                script,
                "refresh_execution_tca_metrics",
                return_value={
                    "selected": 4,
                    "refreshed": 0,
                    "dry_run": True,
                    "limit": 1000,
                    "account_label": None,
                    "stale_before": "2026-05-07T00:00:00+00:00",
                },
            ) as refresh,
            patch("sys.stdout", stdout),
        ):
            exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["apply"], False)
        self.assertEqual(payload["selected"], 4)
        self.assertEqual(payload["refreshed"], 0)
        self.assertEqual(fake_session.commits, 0)
        self.assertEqual(fake_session.rollbacks, 1)
        refresh.assert_called_once()
        self.assertEqual(refresh.call_args.kwargs["dry_run"], True)

    def test_main_applies_batches_until_selection_drops_below_batch_size(self) -> None:
        fake_session = _FakeSession()
        stdout = io.StringIO()

        with (
            patch.object(
                sys,
                "argv",
                [
                    "refresh_execution_tca_metrics.py",
                    "--apply",
                    "--json",
                    "--account-label",
                    "paper",
                    "--older-than-seconds",
                    "0",
                    "--batch-size",
                    "2",
                    "--max-batches",
                    "3",
                ],
            ),
            patch.object(script, "SessionLocal", return_value=fake_session),
            patch.object(
                script,
                "refresh_execution_tca_metrics",
                side_effect=[
                    {
                        "selected": 2,
                        "refreshed": 2,
                        "dry_run": False,
                        "limit": 2,
                        "account_label": "paper",
                        "stale_before": "2026-05-07T00:00:00+00:00",
                    },
                    {
                        "selected": 1,
                        "refreshed": 1,
                        "dry_run": False,
                        "limit": 2,
                        "account_label": "paper",
                        "stale_before": "2026-05-07T00:00:00+00:00",
                    },
                ],
            ) as refresh,
            patch("sys.stdout", stdout),
        ):
            exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["apply"], True)
        self.assertEqual(payload["account_label"], "paper")
        self.assertEqual(payload["older_than_seconds"], 0)
        self.assertEqual(payload["selected"], 3)
        self.assertEqual(payload["refreshed"], 3)
        self.assertEqual(fake_session.commits, 2)
        self.assertEqual(fake_session.rollbacks, 0)
        self.assertEqual(refresh.call_count, 2)
        self.assertEqual(refresh.call_args.kwargs["account_label"], "paper")
        self.assertEqual(refresh.call_args.kwargs["limit"], 2)
        self.assertEqual(refresh.call_args.kwargs["dry_run"], False)
