from __future__ import annotations

import argparse
import io
import json
import subprocess
from contextlib import redirect_stderr, redirect_stdout
from unittest import TestCase
from unittest.mock import patch

from app.trading.tigerbeetle_journal import (
    SOURCE_TYPE_EXECUTION,
    SOURCE_TYPE_EXECUTION_ORDER_EVENT,
    SOURCE_TYPE_EXECUTION_TCA_METRIC,
    SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
)
from scripts import run_tigerbeetle_journal_cron as runner


class RunTigerBeetleJournalCronTest(TestCase):
    def test_parse_args_and_preset_commands_clamp_live_batch_size(self) -> None:
        with patch(
            "scripts.run_tigerbeetle_journal_cron.sys.argv",
            [
                "run_tigerbeetle_journal_cron.py",
                "--preset",
                "live",
                "--execution-batch-size",
                "0",
                "--supervise-timeout-seconds",
                "3.5",
                "--json",
            ],
        ):
            args = runner._parse_args()

        self.assertEqual(args.preset, "live")
        self.assertTrue(args.json)
        self.assertEqual(args.supervise_timeout_seconds, 3.5)
        self.assertEqual(
            runner._commands_for_preset(args)[0].batch_size,
            1,
        )
        self.assertEqual(
            runner._commands_for_preset(argparse.Namespace(preset="sim"))[0].dsn_env,
            "SIM_DB_DSN",
        )

    def test_default_live_execution_batch_size_drains_backlog_under_cron_cadence(
        self,
    ) -> None:
        with patch(
            "scripts.run_tigerbeetle_journal_cron.sys.argv",
            [
                "run_tigerbeetle_journal_cron.py",
                "--preset",
                "live",
            ],
        ):
            args = runner._parse_args()

        [command] = [
            item
            for item in runner._commands_for_preset(args)
            if item.source == SOURCE_TYPE_EXECUTION
        ]

        self.assertEqual(runner.LIVE_EXECUTION_BATCH_SIZE, 25)
        self.assertEqual(command.batch_size, runner.LIVE_EXECUTION_BATCH_SIZE)
        self.assertEqual(command.max_batches, 1)
        self.assertTrue(command.skip_reconcile)
        self.assertTrue(command.allow_data_quality_degraded)

    def test_live_preset_raises_only_execution_batch_size(self) -> None:
        commands = runner._live_commands(execution_batch_size=10)

        self.assertEqual(commands[0].source, SOURCE_TYPE_EXECUTION)
        self.assertEqual(commands[0].batch_size, 10)
        self.assertEqual(commands[0].max_batches, 1)
        self.assertTrue(commands[0].skip_reconcile)
        self.assertTrue(commands[0].allow_data_quality_degraded)
        self.assertEqual(commands[1].source, SOURCE_TYPE_EXECUTION_TCA_METRIC)
        self.assertEqual(commands[1].batch_size, runner.LIVE_TCA_METRIC_BATCH_SIZE)
        self.assertEqual(commands[1].batch_size, 5)
        self.assertEqual(commands[1].max_batches, runner.LIVE_TCA_METRIC_MAX_BATCHES)
        self.assertEqual(commands[1].max_batches, 1)
        self.assertTrue(commands[1].skip_reconcile)
        self.assertEqual(commands[2].source, SOURCE_TYPE_EXECUTION_ORDER_EVENT)
        self.assertEqual(commands[2].batch_size, runner.LIVE_ORDER_EVENT_BATCH_SIZE)
        self.assertEqual(commands[2].batch_size, 1)
        self.assertEqual(commands[2].max_batches, runner.LIVE_ORDER_EVENT_MAX_BATCHES)
        self.assertEqual(commands[2].max_batches, 1)
        self.assertLessEqual(commands[2].max_batches, 2)
        self.assertEqual(
            commands[2].event_scan_limit,
            runner.LIVE_ORDER_EVENT_SCAN_LIMIT,
        )
        self.assertEqual(commands[3].source, SOURCE_TYPE_RUNTIME_LEDGER_BUCKET)
        self.assertFalse(commands[3].skip_reconcile)
        self.assertFalse(commands[3].reconcile_empty_selection)

    def test_live_runtime_ledger_command_skips_empty_selection_reconcile(self) -> None:
        command = runner._live_commands(execution_batch_size=5)[-1]

        argv = runner._argv_for_command(
            command,
            json_output=True,
            supervise_timeout_seconds=45.0,
        )

        self.assertNotIn("--reconcile-empty-selection", argv)
        self.assertNotIn("--skip-reconcile", argv)

    def test_sim_runtime_ledger_command_skips_empty_selection_reconcile(self) -> None:
        command = runner._sim_commands()[-1]

        argv = runner._argv_for_command(
            command,
            json_output=True,
            supervise_timeout_seconds=45.0,
        )

        self.assertNotIn("--reconcile-empty-selection", argv)
        self.assertNotIn("--skip-reconcile", argv)

    def test_live_order_event_argv_keeps_slice_bounded_under_watchdog(self) -> None:
        [command] = [
            item
            for item in runner._live_commands(execution_batch_size=5)
            if item.source == SOURCE_TYPE_EXECUTION_ORDER_EVENT
        ]

        argv = runner._argv_for_command(
            command,
            json_output=True,
            supervise_timeout_seconds=45.0,
        )

        self.assertEqual(argv[argv.index("--sources") + 1], "execution_order_event")
        self.assertEqual(
            argv[argv.index("--batch-size") + 1],
            str(runner.LIVE_ORDER_EVENT_BATCH_SIZE),
        )
        self.assertEqual(
            argv[argv.index("--max-batches") + 1],
            str(runner.LIVE_ORDER_EVENT_MAX_BATCHES),
        )
        self.assertLessEqual(int(argv[argv.index("--max-batches") + 1]), 2)
        self.assertEqual(int(argv[argv.index("--batch-size") + 1]), 1)
        self.assertEqual(int(argv[argv.index("--max-batches") + 1]), 1)
        self.assertEqual(
            argv[argv.index("--event-scan-limit") + 1],
            str(runner.LIVE_ORDER_EVENT_SCAN_LIMIT),
        )
        self.assertEqual(argv[argv.index("--supervise-timeout-seconds") + 1], "45.0")
        self.assertIn("--fail-on-degraded", argv)
        self.assertIn("--allow-data-quality-degraded", argv)
        self.assertIn("--json", argv)

    def test_live_tca_metric_argv_keeps_slice_bounded_under_watchdog(self) -> None:
        [command] = [
            item
            for item in runner._live_commands(execution_batch_size=5)
            if item.source == SOURCE_TYPE_EXECUTION_TCA_METRIC
        ]

        argv = runner._argv_for_command(
            command,
            json_output=True,
            supervise_timeout_seconds=45.0,
        )

        self.assertEqual(argv[argv.index("--sources") + 1], "execution_tca_metric")
        self.assertEqual(
            argv[argv.index("--batch-size") + 1],
            str(runner.LIVE_TCA_METRIC_BATCH_SIZE),
        )
        self.assertEqual(
            argv[argv.index("--max-batches") + 1],
            str(runner.LIVE_TCA_METRIC_MAX_BATCHES),
        )
        self.assertEqual(int(argv[argv.index("--max-batches") + 1]), 1)
        self.assertEqual(argv[argv.index("--supervise-timeout-seconds") + 1], "45.0")
        self.assertIn("--skip-reconcile", argv)
        self.assertIn("--fail-on-degraded", argv)
        self.assertIn("--json", argv)

    def test_safe_non_authority_payload_normalizes_nonzero_command_exit(self) -> None:
        safe_payload = {
            "schema_version": "torghut.tigerbeetle-journal-order-events.v1",
            "ok": False,
            "status": "degraded",
            "promotion_authority": False,
            "overrides_runtime_ledger_authority": False,
            "exit_nonzero": False,
            "failed": 0,
            "hard_failure_reasons": [],
            "stop_reasons": [],
            "accounting_blockers": ["tigerbeetle_unlinked_execution"],
            "reconciliation_blockers": ["tigerbeetle_unlinked_execution"],
        }

        stderr = io.StringIO()
        with redirect_stderr(stderr):
            exit_code = runner._normalize_command_returncode(
                returncode=1,
                payload=safe_payload,
                source=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                json_output=True,
            )

        self.assertEqual(exit_code, 0)
        progress = json.loads(stderr.getvalue())
        self.assertEqual(
            progress["event"],
            "journal_command_exit_mismatch_normalized",
        )
        self.assertEqual(progress["source"], SOURCE_TYPE_RUNTIME_LEDGER_BUCKET)
        self.assertEqual(progress["returncode"], 1)

    def test_unsafe_payload_keeps_nonzero_exit(self) -> None:
        unsafe_payload = {
            "schema_version": "torghut.tigerbeetle-journal-order-events.v1",
            "ok": False,
            "status": "degraded",
            "promotion_authority": False,
            "overrides_runtime_ledger_authority": False,
            "exit_nonzero": True,
            "failed": 1,
            "hard_failure_reasons": ["journal_batch_failures"],
            "stop_reasons": [],
        }

        self.assertEqual(
            runner._normalize_command_returncode(
                returncode=1,
                payload=unsafe_payload,
                source=SOURCE_TYPE_EXECUTION,
                json_output=True,
            ),
            1,
        )

    def test_success_with_exit_nonzero_payload_fails_closed(self) -> None:
        payload = {
            "schema_version": "torghut.tigerbeetle-journal-order-events.v1",
            "exit_nonzero": True,
        }
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            exit_code = runner._normalize_command_returncode(
                returncode=0,
                payload=payload,
                source=SOURCE_TYPE_EXECUTION,
                json_output=True,
            )

        self.assertEqual(exit_code, 1)
        self.assertEqual(
            json.loads(stderr.getvalue())["event"],
            "journal_command_payload_exit_mismatch",
        )

    def test_success_with_clean_payload_returns_zero(self) -> None:
        self.assertEqual(
            runner._normalize_command_returncode(
                returncode=0,
                payload={"exit_nonzero": False},
                source=SOURCE_TYPE_EXECUTION,
                json_output=True,
            ),
            0,
        )

    def test_payload_exit_nonzero_fails_closed_without_payload(self) -> None:
        self.assertTrue(runner._payload_exit_nonzero(None))

    def test_json_mode_requires_payload(self) -> None:
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            exit_code = runner._normalize_command_returncode(
                returncode=0,
                payload=None,
                source=SOURCE_TYPE_EXECUTION,
                json_output=True,
            )

        self.assertEqual(exit_code, 1)
        self.assertEqual(
            json.loads(stderr.getvalue())["event"],
            "journal_command_missing_payload",
        )

    def test_run_command_replays_output_and_normalizes_safe_payload(self) -> None:
        safe_payload = {
            "schema_version": "torghut.tigerbeetle-journal-order-events.v1",
            "ok": False,
            "status": "degraded",
            "promotion_authority": False,
            "overrides_runtime_ledger_authority": False,
            "exit_nonzero": False,
            "failed": 0,
            "hard_failure_reasons": [],
            "stop_reasons": [],
            "accounting_blockers": ["tigerbeetle_unlinked_execution_cost"],
            "reconciliation_blockers": ["tigerbeetle_unlinked_execution_cost"],
        }
        stdout = io.StringIO()
        stderr = io.StringIO()
        with (
            patch(
                "scripts.run_tigerbeetle_journal_cron.subprocess.run",
                return_value=subprocess.CompletedProcess(
                    args=["python", "journal"],
                    returncode=1,
                    stdout=json.dumps(safe_payload, separators=(",", ":")) + "\n",
                    stderr="",
                ),
            ),
            redirect_stdout(stdout),
            redirect_stderr(stderr),
        ):
            exit_code = runner._run_command(
                ["python", "journal"],
                source=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                json_output=True,
            )

        self.assertEqual(exit_code, 0)
        self.assertEqual(json.loads(stdout.getvalue()), safe_payload)
        self.assertEqual(
            json.loads(stderr.getvalue())["event"],
            "journal_command_exit_mismatch_normalized",
        )

    def test_main_runs_all_commands_and_clamps_timeout_and_batch_size(self) -> None:
        observed: list[tuple[list[str], str, bool]] = []

        def fake_run(argv: list[str], *, source: str, json_output: bool) -> int:
            observed.append((argv, source, json_output))
            return 1 if source == SOURCE_TYPE_RUNTIME_LEDGER_BUCKET else 0

        with (
            patch(
                "scripts.run_tigerbeetle_journal_cron._parse_args",
                return_value=argparse.Namespace(
                    preset="live",
                    execution_batch_size=50_000,
                    supervise_timeout_seconds=0,
                    json=True,
                ),
            ),
            patch(
                "scripts.run_tigerbeetle_journal_cron._run_command",
                side_effect=fake_run,
            ),
        ):
            exit_code = runner.main()

        self.assertEqual(exit_code, 1)
        self.assertEqual(len(observed), 4)
        first_argv = observed[0][0]
        self.assertEqual(first_argv[first_argv.index("--batch-size") + 1], "5000")
        self.assertEqual(
            first_argv[first_argv.index("--supervise-timeout-seconds") + 1],
            "0.001",
        )
        self.assertTrue(all(json_output for _, _, json_output in observed))
