#!/usr/bin/env python3
"""Run scheduled TigerBeetle journal commands with payload-based exit policy."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from app.trading.tigerbeetle_journal import (  # noqa: E402
    SOURCE_TYPE_EXECUTION,
    SOURCE_TYPE_EXECUTION_ORDER_EVENT,
    SOURCE_TYPE_EXECUTION_TCA_METRIC,
    SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
)
from scripts import journal_tigerbeetle_order_events as journal_script  # noqa: E402

MAX_TIGERBEETLE_BATCH_SIZE = 5000
LIVE_ORDER_EVENT_BATCH_SIZE = 50
LIVE_ORDER_EVENT_MAX_BATCHES = 1
LIVE_ORDER_EVENT_SCAN_LIMIT = 5000
LIVE_EXECUTION_BATCH_SIZE = 250
LIVE_EXECUTION_SLICE_COUNT = 1
LIVE_EXECUTION_PROGRESS_INTERVAL = 25
LIVE_TCA_METRIC_BATCH_SIZE = 100
LIVE_TCA_METRIC_MAX_BATCHES = 1
LIVE_RUNTIME_LEDGER_BATCH_SIZE = 100
LIVE_RECONCILE_LIMIT = 500
LIVE_JOURNAL_BATCH_CHUNK_SIZE = 25
LIVE_SUPERVISE_TIMEOUT_SECONDS = 120.0
SIM_SOURCE_BATCH_SIZE = 100
SIM_RUNTIME_LEDGER_BATCH_SIZE = 100
SIM_ORDER_EVENT_SCAN_LIMIT = 5000
RUNTIME_LEDGER_RECONCILE_TIMEOUT_SECONDS = 120.0


@dataclass(frozen=True)
class JournalCronCommand:
    source: str
    dsn_env: str
    batch_size: int
    max_batches: int
    reconcile_limit: int
    account_label: str | None = None
    event_scan_limit: int | None = None
    skip_reconcile: bool = False
    reconcile_empty_selection: bool = False
    allow_data_quality_degraded: bool = False
    commit_each_row: bool = False
    progress_interval: int | None = None
    journal_batch_chunk_size: int = LIVE_JOURNAL_BATCH_CHUNK_SIZE
    repeat_count: int = 1
    supervise_timeout_seconds: float | None = None


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run the scheduled Torghut TigerBeetle journal slices and normalize "
            "safe non-authoritative degraded payloads."
        ),
    )
    parser.add_argument("--preset", choices=("live", "sim"), required=True)
    parser.add_argument(
        "--execution-batch-size", type=int, default=LIVE_EXECUTION_BATCH_SIZE
    )
    parser.add_argument(
        "--tca-metric-batch-size",
        type=int,
        default=LIVE_TCA_METRIC_BATCH_SIZE,
    )
    parser.add_argument(
        "--order-event-batch-size",
        type=int,
        default=LIVE_ORDER_EVENT_BATCH_SIZE,
    )
    parser.add_argument(
        "--runtime-ledger-batch-size",
        type=int,
        default=LIVE_RUNTIME_LEDGER_BATCH_SIZE,
    )
    parser.add_argument("--sim-batch-size", type=int, default=SIM_SOURCE_BATCH_SIZE)
    parser.add_argument(
        "--journal-batch-chunk-size",
        type=int,
        default=LIVE_JOURNAL_BATCH_CHUNK_SIZE,
    )
    parser.add_argument(
        "--supervise-timeout-seconds",
        type=float,
        default=LIVE_SUPERVISE_TIMEOUT_SECONDS,
    )
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def _bounded_batch_size(value: object) -> int:
    return max(1, min(int(value), MAX_TIGERBEETLE_BATCH_SIZE))


def _live_commands(
    *,
    execution_batch_size: int,
    tca_metric_batch_size: int = LIVE_TCA_METRIC_BATCH_SIZE,
    order_event_batch_size: int = LIVE_ORDER_EVENT_BATCH_SIZE,
    runtime_ledger_batch_size: int = LIVE_RUNTIME_LEDGER_BATCH_SIZE,
    journal_batch_chunk_size: int = LIVE_JOURNAL_BATCH_CHUNK_SIZE,
) -> list[JournalCronCommand]:
    return [
        JournalCronCommand(
            source=SOURCE_TYPE_EXECUTION,
            dsn_env="DB_DSN",
            batch_size=execution_batch_size,
            max_batches=1,
            reconcile_limit=1000,
            skip_reconcile=True,
            allow_data_quality_degraded=True,
            commit_each_row=True,
            progress_interval=LIVE_EXECUTION_PROGRESS_INTERVAL,
            journal_batch_chunk_size=journal_batch_chunk_size,
            repeat_count=LIVE_EXECUTION_SLICE_COUNT,
        ),
        JournalCronCommand(
            source=SOURCE_TYPE_EXECUTION_TCA_METRIC,
            dsn_env="DB_DSN",
            batch_size=tca_metric_batch_size,
            max_batches=LIVE_TCA_METRIC_MAX_BATCHES,
            reconcile_limit=1000,
            skip_reconcile=True,
            commit_each_row=True,
            progress_interval=LIVE_EXECUTION_PROGRESS_INTERVAL,
            journal_batch_chunk_size=journal_batch_chunk_size,
        ),
        JournalCronCommand(
            source=SOURCE_TYPE_EXECUTION_ORDER_EVENT,
            dsn_env="DB_DSN",
            batch_size=order_event_batch_size,
            max_batches=LIVE_ORDER_EVENT_MAX_BATCHES,
            reconcile_limit=1000,
            event_scan_limit=LIVE_ORDER_EVENT_SCAN_LIMIT,
            skip_reconcile=True,
            allow_data_quality_degraded=True,
            journal_batch_chunk_size=journal_batch_chunk_size,
        ),
        JournalCronCommand(
            source=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
            dsn_env="DB_DSN",
            batch_size=runtime_ledger_batch_size,
            max_batches=1,
            reconcile_limit=LIVE_RECONCILE_LIMIT,
            reconcile_empty_selection=True,
            allow_data_quality_degraded=True,
            journal_batch_chunk_size=journal_batch_chunk_size,
            supervise_timeout_seconds=RUNTIME_LEDGER_RECONCILE_TIMEOUT_SECONDS,
        ),
    ]


def _sim_commands(
    *,
    batch_size: int = SIM_SOURCE_BATCH_SIZE,
    runtime_ledger_batch_size: int = SIM_RUNTIME_LEDGER_BATCH_SIZE,
    journal_batch_chunk_size: int = LIVE_JOURNAL_BATCH_CHUNK_SIZE,
) -> list[JournalCronCommand]:
    dsn_env = "SIM_DB_DSN"
    max_batches = 1
    reconcile_limit = 500
    account_label = "TORGHUT_SIM"
    return [
        JournalCronCommand(
            source=SOURCE_TYPE_EXECUTION,
            dsn_env=dsn_env,
            batch_size=batch_size,
            max_batches=max_batches,
            reconcile_limit=reconcile_limit,
            account_label=account_label,
            skip_reconcile=True,
            allow_data_quality_degraded=True,
            journal_batch_chunk_size=journal_batch_chunk_size,
        ),
        JournalCronCommand(
            source=SOURCE_TYPE_EXECUTION_TCA_METRIC,
            dsn_env=dsn_env,
            batch_size=batch_size,
            max_batches=max_batches,
            reconcile_limit=reconcile_limit,
            account_label=account_label,
            skip_reconcile=True,
            commit_each_row=True,
            progress_interval=LIVE_EXECUTION_PROGRESS_INTERVAL,
            journal_batch_chunk_size=journal_batch_chunk_size,
        ),
        JournalCronCommand(
            source=SOURCE_TYPE_EXECUTION_ORDER_EVENT,
            dsn_env=dsn_env,
            batch_size=batch_size,
            max_batches=max_batches,
            reconcile_limit=reconcile_limit,
            account_label=account_label,
            event_scan_limit=SIM_ORDER_EVENT_SCAN_LIMIT,
            skip_reconcile=True,
            allow_data_quality_degraded=True,
            journal_batch_chunk_size=journal_batch_chunk_size,
        ),
        JournalCronCommand(
            source=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
            dsn_env=dsn_env,
            batch_size=runtime_ledger_batch_size,
            max_batches=max_batches,
            reconcile_limit=reconcile_limit,
            account_label=account_label,
            reconcile_empty_selection=True,
            allow_data_quality_degraded=True,
            journal_batch_chunk_size=journal_batch_chunk_size,
            supervise_timeout_seconds=RUNTIME_LEDGER_RECONCILE_TIMEOUT_SECONDS,
        ),
    ]


def _commands_for_preset(args: argparse.Namespace) -> list[JournalCronCommand]:
    if args.preset == "live":
        return _live_commands(
            execution_batch_size=_bounded_batch_size(
                getattr(args, "execution_batch_size", LIVE_EXECUTION_BATCH_SIZE)
            ),
            tca_metric_batch_size=_bounded_batch_size(
                getattr(args, "tca_metric_batch_size", LIVE_TCA_METRIC_BATCH_SIZE)
            ),
            order_event_batch_size=_bounded_batch_size(
                getattr(args, "order_event_batch_size", LIVE_ORDER_EVENT_BATCH_SIZE)
            ),
            runtime_ledger_batch_size=_bounded_batch_size(
                getattr(
                    args,
                    "runtime_ledger_batch_size",
                    LIVE_RUNTIME_LEDGER_BATCH_SIZE,
                )
            ),
            journal_batch_chunk_size=_bounded_batch_size(
                getattr(
                    args,
                    "journal_batch_chunk_size",
                    LIVE_JOURNAL_BATCH_CHUNK_SIZE,
                )
            ),
        )
    return _sim_commands(
        batch_size=_bounded_batch_size(
            getattr(args, "sim_batch_size", SIM_SOURCE_BATCH_SIZE)
        ),
        runtime_ledger_batch_size=_bounded_batch_size(
            getattr(args, "runtime_ledger_batch_size", SIM_RUNTIME_LEDGER_BATCH_SIZE)
        ),
        journal_batch_chunk_size=_bounded_batch_size(
            getattr(args, "journal_batch_chunk_size", LIVE_JOURNAL_BATCH_CHUNK_SIZE)
        ),
    )


def _journal_script_path() -> str:
    return str(Path(__file__).with_name("journal_tigerbeetle_order_events.py"))


def _argv_for_command(
    command: JournalCronCommand,
    *,
    json_output: bool,
    supervise_timeout_seconds: float,
) -> list[str]:
    argv = [
        sys.executable,
        _journal_script_path(),
        "--dsn-env",
        command.dsn_env,
    ]
    if command.account_label:
        argv.extend(["--account-label", command.account_label])
    argv.extend(
        [
            "--sources",
            command.source,
            "--batch-size",
            str(command.batch_size),
            "--max-batches",
            str(command.max_batches),
        ]
    )
    if command.event_scan_limit is not None:
        argv.extend(["--event-scan-limit", str(command.event_scan_limit)])
    argv.extend(["--reconcile-limit", str(command.reconcile_limit)])
    if command.skip_reconcile:
        argv.append("--skip-reconcile")
    if command.reconcile_empty_selection:
        argv.append("--reconcile-empty-selection")
    argv.append("--fail-on-degraded")
    if command.allow_data_quality_degraded:
        argv.append("--allow-data-quality-degraded")
    if command.commit_each_row:
        argv.append("--commit-each-row")
    if command.progress_interval is not None:
        argv.extend(["--progress-interval", str(max(0, command.progress_interval))])
    argv.extend(
        [
            "--journal-batch-chunk-size",
            str(_bounded_batch_size(command.journal_batch_chunk_size)),
        ]
    )
    effective_supervise_timeout_seconds = max(
        float(supervise_timeout_seconds),
        float(command.supervise_timeout_seconds or 0.0),
        0.001,
    )
    argv.extend(
        ["--supervise-timeout-seconds", str(effective_supervise_timeout_seconds)]
    )
    if json_output:
        argv.append("--json")
    return argv


def _write_supervised_output(value: str | bytes | None, *, stream: Any) -> str:
    return journal_script._write_supervised_output(value, stream=stream)


def _last_journal_payload(text: str) -> dict[str, Any] | None:
    return journal_script._last_journal_payload(text)


def _safe_payload_allows_success(payload: Mapping[str, Any] | None) -> bool:
    return journal_script._safe_payload_allows_success(payload)


def _emit_runner_event(event: str, **fields: object) -> None:
    payload = {
        "schema_version": "torghut.tigerbeetle-journal-cron-runner.v1",
        "event": event,
        **fields,
    }
    print(json.dumps(payload, separators=(",", ":")), file=sys.stderr, flush=True)


def _payload_exit_nonzero(payload: Mapping[str, Any] | None) -> bool:
    if payload is None:
        return True
    return bool(payload.get("exit_nonzero", True))


def _run_command(argv: Sequence[str], *, source: str, json_output: bool) -> int:
    completed = subprocess.run(
        list(argv),
        check=False,
        capture_output=True,
        text=True,
    )
    stdout_text = _write_supervised_output(completed.stdout, stream=sys.stdout)
    stderr_text = _write_supervised_output(completed.stderr, stream=sys.stderr)
    payload = _last_journal_payload(stdout_text) or _last_journal_payload(stderr_text)
    return _normalize_command_returncode(
        returncode=int(completed.returncode),
        payload=payload,
        source=source,
        json_output=json_output,
    )


def _normalize_command_returncode(
    *,
    returncode: int,
    payload: Mapping[str, Any] | None,
    source: str,
    json_output: bool,
) -> int:
    if json_output and payload is None:
        _emit_runner_event(
            "journal_command_missing_payload",
            source=source,
            returncode=returncode,
        )
        return returncode or 1
    if returncode == 0:
        if _payload_exit_nonzero(payload):
            _emit_runner_event(
                "journal_command_payload_exit_mismatch",
                source=source,
                returncode=returncode,
                exit_nonzero=True,
            )
            return 1
        return 0
    if not _safe_payload_allows_success(payload):
        return returncode
    assert payload is not None
    _emit_runner_event(
        "journal_command_exit_mismatch_normalized",
        source=source,
        returncode=returncode,
        status=str(payload.get("status", "")),
        accounting_blockers=list(
            cast(Sequence[object], payload.get("accounting_blockers") or [])
        ),
        reconciliation_blockers=list(
            cast(Sequence[object], payload.get("reconciliation_blockers") or [])
        ),
    )
    return 0


def main() -> int:
    args = _parse_args()
    exit_code = 0
    for command in _commands_for_preset(args):
        for _ in range(max(1, int(command.repeat_count))):
            command_exit_code = _run_command(
                _argv_for_command(
                    command,
                    json_output=bool(args.json),
                    supervise_timeout_seconds=float(args.supervise_timeout_seconds),
                ),
                source=command.source,
                json_output=bool(args.json),
            )
            if command_exit_code:
                exit_code = 1
                break
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
