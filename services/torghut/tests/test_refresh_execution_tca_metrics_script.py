from __future__ import annotations

import io
import json
import os
import sys
from unittest import TestCase
from unittest.mock import Mock, patch

from scripts import refresh_execution_tca_metrics as script


class _FakeEngine:
    def __init__(self) -> None:
        self.dispose_calls = 0

    def dispose(self) -> None:
        self.dispose_calls += 1


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
    def test_sqlalchemy_dsn_normalizes_postgres_url_variants(self) -> None:
        self.assertEqual(
            script._sqlalchemy_dsn("postgresql+psycopg://user:pass@db/torghut"),
            "postgresql+psycopg://user:pass@db/torghut",
        )
        self.assertEqual(
            script._sqlalchemy_dsn("postgresql://user:pass@db/torghut"),
            "postgresql+psycopg://user:pass@db/torghut",
        )
        self.assertEqual(
            script._sqlalchemy_dsn("sqlite:///tmp/torghut.db"),
            "sqlite:///tmp/torghut.db",
        )

    def test_env_int_or_none_uses_blank_as_unset(self) -> None:
        with patch.dict(
            os.environ,
            {"TORGHUT_EXECUTION_TCA_ACTIVITY_LOOKBACK_SECONDS": " "},
        ):
            self.assertIsNone(
                script._env_int_or_none(
                    "TORGHUT_EXECUTION_TCA_ACTIVITY_LOOKBACK_SECONDS"
                )
            )

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
            patch.dict(
                os.environ,
                {"TORGHUT_EXECUTION_TCA_ACTIVITY_LOOKBACK_SECONDS": "86400"},
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
        self.assertEqual(payload["execution_activity_lookback_seconds"], 86400)
        self.assertEqual(payload["selected"], 3)
        self.assertEqual(payload["refreshed"], 3)
        self.assertEqual(fake_session.commits, 2)
        self.assertEqual(fake_session.rollbacks, 0)
        self.assertEqual(refresh.call_count, 2)
        self.assertEqual(refresh.call_args.kwargs["account_label"], "paper")
        self.assertEqual(refresh.call_args.kwargs["limit"], 2)
        self.assertEqual(refresh.call_args.kwargs["dry_run"], False)
        self.assertIsNotNone(refresh.call_args.kwargs["execution_activity_after"])

    def test_main_can_refresh_non_default_dsn_env(self) -> None:
        fake_engine = _FakeEngine()
        fake_session = _FakeSession()
        stdout = io.StringIO()
        session_factory = Mock(return_value=fake_session)

        with (
            patch.object(
                sys,
                "argv",
                [
                    "refresh_execution_tca_metrics.py",
                    "--dsn-env",
                    "SIM_DB_DSN",
                    "--account-label",
                    "TORGHUT_SIM",
                    "--json",
                ],
            ),
            patch.dict(
                os.environ,
                {"SIM_DB_DSN": "postgres://user:pass@db:5432/torghut_sim_default"},
            ),
            patch.object(script, "create_engine", return_value=fake_engine) as create,
            patch.object(script, "sessionmaker", return_value=session_factory) as make,
            patch.object(
                script,
                "refresh_execution_tca_metrics",
                return_value={
                    "selected": 3,
                    "refreshed": 0,
                    "dry_run": True,
                    "limit": 1000,
                    "account_label": "TORGHUT_SIM",
                    "stale_before": "2026-06-05T00:00:00+00:00",
                },
            ) as refresh,
            patch("sys.stdout", stdout),
        ):
            exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["dsn_env"], "SIM_DB_DSN")
        self.assertEqual(payload["account_label"], "TORGHUT_SIM")
        create.assert_called_once_with(
            "postgresql+psycopg://user:pass@db:5432/torghut_sim_default",
            pool_pre_ping=True,
            future=True,
        )
        make.assert_called_once_with(
            bind=fake_engine,
            autoflush=False,
            autocommit=False,
            expire_on_commit=False,
            future=True,
        )
        session_factory.assert_called_once_with()
        self.assertEqual(fake_engine.dispose_calls, 1)
        refresh.assert_called_once()
        self.assertEqual(refresh.call_args.kwargs["account_label"], "TORGHUT_SIM")

    def test_main_rejects_missing_non_default_dsn_env(self) -> None:
        with (
            patch.object(
                sys,
                "argv",
                [
                    "refresh_execution_tca_metrics.py",
                    "--dsn-env",
                    "SIM_DB_DSN",
                    "--json",
                ],
            ),
            patch.dict(os.environ, {}, clear=True),
        ):
            with self.assertRaisesRegex(SystemExit, "missing DSN env var: SIM_DB_DSN"):
                script.main()
