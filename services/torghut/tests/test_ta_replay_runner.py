import argparse
import io
import json
import os
import sys
from contextlib import redirect_stdout
from unittest import TestCase
from unittest.mock import patch
from urllib.error import URLError

from scripts import ta_replay_runner as runner


_TABLE_COVERAGE_TSV = """table_name\tdays\tfirst_day\tlast_day\trows
ta_microbars\t19\t2026-04-27\t2026-05-22\t1281193
ta_signals\t9\t2026-05-12\t2026-05-22\t632380
"""

_DAY_GAP_TSV = """trading_day\tsignal_rows\tmicrobar_rows
2026-05-22\t58446\t58446
2026-05-08\t0\t68396
2026-05-07\t0\t66008
"""


class TestTaReplayRunnerCoveragePreflight(TestCase):
    def _args(self, **overrides: object) -> argparse.Namespace:
        values = {
            "namespace": "torghut",
            "verify": False,
            "json": True,
            "check_clickhouse_coverage": True,
            "clickhouse_http_url": "http://clickhouse.test:8123",
            "clickhouse_username": "torghut",
            "clickhouse_password": "secret",
            "clickhouse_password_env": "TA_CLICKHOUSE_PASSWORD",
            "clickhouse_timeout_seconds": 5,
            "coverage_day_limit": 40,
            "required_trading_days": 25,
        }
        values.update(overrides)
        return argparse.Namespace(**values)

    def _state(self) -> runner.ReplayState:
        return runner.ReplayState(
            namespace="torghut",
            ta_group_id="torghut-ta-2025-12-23",
            ta_auto_offset_reset="latest",
            flink_job_state="running",
            flink_restart_nonce=7,
            flink_status_state="RUNNING",
        )

    def _plan(self) -> dict[str, str]:
        return {
            "replay_group_id": "torghut-ta-replay-profit-proof",
            "ta_auto_offset_reset": "earliest",
        }

    def _coverage(self) -> dict[str, object]:
        return argparse.Namespace(
            status="insufficient_ta_signal_days",
            summary={
                "required_trading_days": 25,
                "ta_signals_days": 9,
                "ta_microbars_days": 19,
                "missing_signal_days_vs_required": 16,
                "microbar_only_day_count": 2,
            },
        ).__dict__

    def test_load_clickhouse_coverage_flags_signal_shortfall_and_microbar_only_days(
        self,
    ) -> None:
        with patch.object(
            runner,
            "_clickhouse_query",
            side_effect=[_TABLE_COVERAGE_TSV, _DAY_GAP_TSV],
        ):
            coverage = runner._load_clickhouse_coverage(self._args())

        assert coverage is not None
        self.assertEqual(coverage["status"], "insufficient_ta_signal_days")
        self.assertIn("insufficient_ta_signal_days:9<25", coverage["blockers"])
        self.assertIn("microbar_only_days:2", coverage["blockers"])
        self.assertEqual(coverage["summary"]["ta_signals_days"], 9)
        self.assertEqual(coverage["summary"]["ta_microbars_days"], 19)
        self.assertEqual(coverage["summary"]["missing_signal_days_vs_required"], 16)
        self.assertEqual(
            coverage["summary"]["microbar_only_days"],
            ["2026-05-08", "2026-05-07"],
        )

    def test_plan_json_embeds_coverage_preflight(self) -> None:
        output = io.StringIO()
        with patch.object(
            runner,
            "_clickhouse_query",
            side_effect=[_TABLE_COVERAGE_TSV, _DAY_GAP_TSV],
        ):
            with redirect_stdout(output):
                exit_code = runner._handle_plan_mode(
                    args=self._args(),
                    state=self._state(),
                    plan=self._plan(),
                    warnings=[],
                )

        self.assertEqual(exit_code, 0)
        payload = json.loads(output.getvalue())
        self.assertEqual(
            payload["coverage"]["schema_version"],
            "torghut.ta-replay-coverage-preflight.v1",
        )
        self.assertEqual(
            payload["coverage"]["summary"]["missing_signal_days_vs_required"], 16
        )

    def test_text_plan_renders_coverage_preflight_summary(self) -> None:
        output = io.StringIO()
        with redirect_stdout(output):
            runner._print_plan_text(
                self._state(),
                self._plan(),
                "torghut",
                dry_run=True,
                warnings=["TA_AUTO_OFFSET_RESET already matches the replay target"],
                coverage=self._coverage(),
            )

        text = output.getvalue()
        self.assertIn("Coverage preflight:", text)
        self.assertIn("missing-signal-days-vs-required: 16", text)
        self.assertIn("Use --mode=apply --confirm REPLAY_TA_CANARY", text)

    def test_verify_text_mode_renders_coverage_and_failed_checks(self) -> None:
        state = runner.ReplayState(
            namespace="torghut",
            ta_group_id="wrong-group",
            ta_auto_offset_reset="latest",
            flink_job_state="suspended",
            flink_restart_nonce=7,
            flink_status_state="FAILED",
        )
        output = io.StringIO()
        with patch.object(
            runner,
            "_clickhouse_query",
            side_effect=[_TABLE_COVERAGE_TSV, _DAY_GAP_TSV],
        ):
            with redirect_stdout(output):
                exit_code = runner._handle_verify_mode(
                    args=self._args(json=False),
                    state=state,
                    plan=self._plan(),
                    warnings=[],
                )

        self.assertEqual(exit_code, 1)
        text = output.getvalue()
        self.assertIn("Verify results:", text)
        self.assertIn("ta_group_id_applied: fail", text)
        self.assertIn("job_state_not_failed: fail", text)

    def test_apply_text_mode_patches_and_renders_verification(self) -> None:
        applied_state = runner.ReplayState(
            namespace="torghut",
            ta_group_id="torghut-ta-replay-profit-proof",
            ta_auto_offset_reset="earliest",
            flink_job_state="running",
            flink_restart_nonce=8,
            flink_status_state="RUNNING",
        )
        output = io.StringIO()
        patches: list[tuple[str, str, dict[str, object]]] = []

        def capture_patch(kind: str, name: str, patch: dict[str, object]) -> None:
            patches.append((kind, name, patch))

        with patch.object(runner, "_kubectl_merge_patch", side_effect=capture_patch):
            with patch.object(runner, "_load_state", return_value=applied_state):
                with patch.object(
                    runner,
                    "_clickhouse_query",
                    side_effect=[_TABLE_COVERAGE_TSV, _DAY_GAP_TSV],
                ):
                    with redirect_stdout(output):
                        exit_code = runner._handle_apply_mode(
                            args=self._args(json=False, verify=True),
                            state=self._state(),
                            plan=self._plan(),
                            warnings=["planned warning"],
                        )

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            [patch[0] for patch in patches],
            ["configmap", "flinkdeployment", "flinkdeployment"],
        )
        self.assertIn("Patch complete.", output.getvalue())
        self.assertIn("restart_nonce_advanced: ok", output.getvalue())

    def test_clickhouse_query_builds_request_and_wraps_url_errors(self) -> None:
        class FakeResponse:
            def __enter__(self) -> "FakeResponse":
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def read(self) -> bytes:
                return b"ok"

        with patch.object(runner, "urlopen", return_value=FakeResponse()) as urlopen:
            result = runner._clickhouse_query(
                http_url="http://clickhouse.test:8123",
                username="torghut",
                password="secret",
                query="SELECT 1",
                timeout_seconds=0,
            )

        self.assertEqual(result, "ok")
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "http://clickhouse.test:8123")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(
            request.headers["Authorization"],
            runner._clickhouse_basic_auth("torghut", "secret"),
        )
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 1)

        with patch.object(runner, "urlopen", side_effect=URLError("refused")):
            with self.assertRaisesRegex(
                RuntimeError, "clickhouse_coverage_query_failed"
            ):
                runner._clickhouse_query(
                    http_url="http://clickhouse.test:8123",
                    username="torghut",
                    password="secret",
                    query="SELECT 1",
                    timeout_seconds=5,
                )

    def test_coverage_loader_disabled_password_and_env_branches(self) -> None:
        self.assertIsNone(
            runner._load_clickhouse_coverage(
                self._args(check_clickhouse_coverage=False, clickhouse_password="")
            )
        )

        with self.assertRaisesRegex(SystemExit, "requires --clickhouse-password"):
            runner._load_clickhouse_coverage(
                self._args(
                    clickhouse_password="",
                    clickhouse_password_env="MISSING_TA_PASSWORD",
                )
            )

        with patch.dict(os.environ, {"TA_CLICKHOUSE_PASSWORD": "from-env"}):
            with patch.object(
                runner,
                "_clickhouse_query",
                side_effect=[
                    "table_name\tdays\tfirst_day\tlast_day\trows\nta_signals\tbad\t\t\t0\n",
                    "trading_day\tsignal_rows\tmicrobar_rows\n2026-05-22\t1\t1\n",
                ],
            ):
                coverage = runner._load_clickhouse_coverage(
                    self._args(clickhouse_password="", required_trading_days=0)
                )

        assert coverage is not None
        self.assertEqual(coverage["status"], "ok")
        self.assertEqual(coverage["summary"]["ta_signals_days"], 0)

    def test_parse_helpers_and_cli_defaults(self) -> None:
        self.assertEqual(runner._parse_tsv_with_names(""), [])
        self.assertEqual(
            runner._parse_tsv_with_names("a\tb\n1\n"),
            [{"a": "1", "b": ""}],
        )
        self.assertEqual(runner._parse_int_field(None, "days"), 0)
        self.assertEqual(runner._parse_int_field({"days": "bad"}, "days"), 0)
        self.assertIn("LIMIT 1 FORMAT TSVWithNames", runner._day_gap_query(0))

        argv = [
            "ta_replay_runner.py",
            "--replay-id",
            "proof",
            "--check-clickhouse-coverage",
            "--required-trading-days",
            "25",
            "--coverage-day-limit",
            "12",
            "--clickhouse-timeout-seconds",
            "3",
        ]
        with patch.object(sys, "argv", argv):
            with patch.dict(
                os.environ,
                {
                    "TA_CLICKHOUSE_HTTP_URL": "http://env-clickhouse:8123",
                    "TA_CLICKHOUSE_USERNAME": "env-user",
                },
            ):
                parsed = runner.parse_args()

        self.assertEqual(parsed.replay_id, "proof")
        self.assertTrue(parsed.check_clickhouse_coverage)
        self.assertEqual(parsed.required_trading_days, 25)
        self.assertEqual(parsed.coverage_day_limit, 12)
        self.assertEqual(parsed.clickhouse_timeout_seconds, 3)
        self.assertEqual(parsed.clickhouse_http_url, "http://env-clickhouse:8123")
        self.assertEqual(parsed.clickhouse_username, "env-user")
