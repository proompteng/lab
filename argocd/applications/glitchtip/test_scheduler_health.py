"""Regression checks for the GlitchTip scheduler-aware liveness contract."""

import contextlib
import importlib.util
import io
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import MagicMock, patch


spec = importlib.util.spec_from_file_location(
    "scheduler_health", Path(__file__).with_name("scheduler-health.py")
)
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)


class SchedulerHealthTests(unittest.TestCase):
    def setUp(self):
        self.driver = types.SimpleNamespace(connect=MagicMock())
        self.database = self.driver.connect.return_value.__enter__.return_value
        self.database.execute.return_value.fetchone.return_value = (True,)
        self.http = MagicMock()
        self.http.return_value.__enter__.return_value.status = 200
        self.context = contextlib.ExitStack()
        self.context.enter_context(patch.dict(sys.modules, {"psycopg": self.driver}))
        self.context.enter_context(patch.dict("os.environ", {"DATABASE_URL": "redacted"}))
        self.context.enter_context(patch.object(health.urllib.request, "urlopen", self.http))
        self.context.enter_context(patch.object(health.signal, "alarm"))
        self.addCleanup(self.context.close)

    def test_http_and_live_scheduler_are_required(self):
        self.assertEqual(health.main(), 0)
        options = self.driver.connect.call_args.kwargs["options"]
        self.assertIn("default_transaction_read_only=on", options)
        self.assertIn("statement_timeout=2000", options)
        self.assertEqual(self.driver.connect.call_args.kwargs["connect_timeout"], 2)

    def test_stale_or_missing_scheduler_fails_despite_healthy_http(self):
        self.database.execute.return_value.fetchone.return_value = (False,)
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            self.assertEqual(health.main(), 1)
        self.assertIn("scheduler heartbeat is stale or missing", output.getvalue())

    def test_failed_http_does_not_issue_database_work(self):
        self.http.side_effect = TimeoutError("sensitive HTTP diagnostic")
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            self.assertEqual(health.main(), 1)
        self.driver.connect.assert_not_called()
        self.assertNotIn("sensitive", output.getvalue())

    def test_database_errors_fail_without_printing_credentials(self):
        self.driver.connect.side_effect = ConnectionError("postgres://secret@host")
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            self.assertEqual(health.main(), 1)
        self.assertIn("ConnectionError", output.getvalue())
        self.assertNotIn("postgres", output.getvalue())
        self.assertNotIn("secret", output.getvalue())


if __name__ == "__main__":
    unittest.main()
