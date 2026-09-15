#!/usr/bin/env python3
"""Journal existing order-feed events into TigerBeetle and persist reconciliation."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from typing import Any, cast

from app.config import Settings
from app.trading.tigerbeetle_reconcile import (
    latest_tigerbeetle_reconciliation_payload,
)

from .journal_core import (
    DEFAULT_JOURNAL_BATCH_CHUNK_SIZE,
    INFRASTRUCTURE_RECONCILIATION_BLOCKERS,
    MAX_JOURNAL_BATCH_CHUNK_SIZE,
    _emit_progress,
    _parse_sources,
)


def _has_text_items(value: object) -> bool:
    if isinstance(value, Sequence) and not isinstance(
        value,
        (str, bytes, bytearray),
    ):
        return any(str(item).strip() for item in value)
    return bool(value)


def _fresh_reconciliation_for_empty_selection(
    session: Any,
    *,
    settings_obj: Settings,
    account_label: str | None,
    freshness_headroom_seconds: int = 0,
) -> dict[str, object] | None:
    latest = latest_tigerbeetle_reconciliation_payload(
        session,
        cluster_id=settings_obj.tigerbeetle_cluster_id,
    )
    if latest is None:
        return None
    max_age_seconds = int(latest.get("reconciliation_max_age_seconds") or 0)
    latest_account_label = latest.get("account_label")
    blocked = (
        not bool(latest.get("ok"))
        or str(latest.get("status") or "") != "ok"
        or bool(latest.get("reconciliation_stale"))
        or max_age_seconds <= 0
        or _has_text_items(latest.get("blockers"))
        or not bool(latest.get("client_lookup_ok", True))
        or bool(account_label and latest_account_label != account_label)
    )
    if blocked:
        return None
    age_seconds = int(latest.get("age_seconds") or 0)
    remaining_freshness_seconds = max_age_seconds - age_seconds
    required_headroom_seconds = max(0, int(freshness_headroom_seconds))
    if remaining_freshness_seconds < required_headroom_seconds:
        return None
    return {
        "ok": True,
        "status": "skipped",
        "reason": "fresh_reconciliation_available",
        "fresh_reconciliation_available": True,
        "account_label": latest_account_label,
        "latest_status": str(latest.get("status") or ""),
        "latest_started_at": latest.get("started_at"),
        "latest_finished_at": latest.get("finished_at"),
        "age_seconds": age_seconds,
        "reconciliation_stale": False,
        "reconciliation_max_age_seconds": max_age_seconds,
        "remaining_freshness_seconds": remaining_freshness_seconds,
        "required_freshness_headroom_seconds": required_headroom_seconds,
        "checked_transfer_count": int(latest.get("checked_transfer_count") or 0),
        "runtime_ledger_checked_transfer_count": int(
            latest.get("runtime_ledger_checked_transfer_count") or 0
        ),
        "runtime_ledger_signed_transfer_count": int(
            latest.get("runtime_ledger_signed_transfer_count") or 0
        ),
        "runtime_ledger_missing_signed_ref_count": int(
            latest.get("runtime_ledger_missing_signed_ref_count") or 0
        ),
        "blockers": [],
    }


def _payload(
    *,
    args: argparse.Namespace,
    started_at: datetime,
    batches: list[dict[str, Any]],
    reconciliation: dict[str, object] | None,
) -> dict[str, Any]:
    selected = sum(int(batch["selected"]) for batch in batches)
    journaled = sum(int(batch["journaled"]) for batch in batches)
    skipped = sum(int(batch["skipped"]) for batch in batches)
    failed = sum(int(batch["failed"]) for batch in batches)
    reconciliation_ok = (
        True
        if reconciliation is None
        else bool(reconciliation.get("ok", reconciliation.get("status") == "ok"))
    )
    status = "ok" if failed == 0 and reconciliation_ok else "degraded"
    stop_reasons = [
        str(batch.get("stop_reason"))
        for batch in batches
        if str(batch.get("stop_reason") or "").strip()
    ]
    reconciliation_blockers = _reconciliation_blockers(reconciliation)
    hard_failure_reasons = _hard_failure_reasons(
        failed=failed,
        stop_reasons=stop_reasons,
        reconciliation_blockers=reconciliation_blockers,
        reconciliation_ok=reconciliation_ok,
    )
    accounting_blockers = [
        blocker
        for blocker in reconciliation_blockers
        if blocker not in INFRASTRUCTURE_RECONCILIATION_BLOCKERS
    ]
    exit_nonzero = _should_exit_nonzero(
        status=status,
        fail_on_degraded=bool(args.fail_on_degraded),
        allow_data_quality_degraded=bool(
            getattr(args, "allow_data_quality_degraded", False)
        ),
        hard_failure_reasons=hard_failure_reasons,
    )
    return {
        "schema_version": "torghut.tigerbeetle-journal-order-events.v1",
        "ok": status == "ok",
        "status": status,
        "authority": "non_authoritative_tigerbeetle_journal_telemetry",
        "promotion_authority": False,
        "overrides_runtime_ledger_authority": False,
        "fail_on_degraded": bool(args.fail_on_degraded),
        "allow_data_quality_degraded": bool(
            getattr(args, "allow_data_quality_degraded", False)
        ),
        "exit_nonzero": exit_nonzero,
        "exit_policy": (
            "fail_on_hard_failures_only"
            if bool(getattr(args, "allow_data_quality_degraded", False))
            else "fail_on_any_degraded"
        ),
        "dry_run": bool(args.dry_run),
        "dsn_env": args.dsn_env,
        "account_label": args.account_label,
        "batch_size": max(1, min(int(args.batch_size), 5000)),
        "max_batches": max(1, int(args.max_batches)),
        "event_scan_limit": getattr(args, "event_scan_limit", None),
        "sources": list(_parse_sources(getattr(args, "sources", "all"))),
        "skip_reconcile": bool(getattr(args, "skip_reconcile", False)),
        "reconcile_empty_selection": bool(
            getattr(args, "reconcile_empty_selection", False)
        ),
        "commit_each_row": bool(getattr(args, "commit_each_row", False)),
        "supervised_worker": bool(getattr(args, "supervised_worker", False)),
        "supervise_timeout_seconds": float(
            getattr(args, "supervise_timeout_seconds", 0.0) or 0.0
        ),
        "stopped_early": bool(stop_reasons),
        "stop_reasons": stop_reasons,
        "hard_failure_reasons": hard_failure_reasons,
        "accounting_blockers": accounting_blockers,
        "reconciliation_blockers": reconciliation_blockers,
        "started_at": started_at.isoformat(),
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "selected": selected,
        "journaled": journaled,
        "skipped": skipped,
        "failed": failed,
        "batches": batches,
        "reconciliation": reconciliation,
    }


def _reconciliation_blockers(
    reconciliation: Mapping[str, object] | None,
) -> list[str]:
    if reconciliation is None:
        return []
    raw_blockers = reconciliation.get("blockers")
    if not isinstance(raw_blockers, Sequence) or isinstance(
        raw_blockers,
        (str, bytes, bytearray),
    ):
        return []
    return sorted({str(item) for item in raw_blockers if str(item).strip()})


def _hard_failure_reasons(
    *,
    failed: int,
    stop_reasons: Sequence[str],
    reconciliation_blockers: Sequence[str],
    reconciliation_ok: bool,
) -> list[str]:
    reasons: list[str] = []
    if failed:
        reasons.append("journal_batch_failures")
    if (
        not reconciliation_ok
        and not reconciliation_blockers
        and not failed
        and not stop_reasons
    ):
        reasons.append("reconciliation_degraded_without_blockers")
    for reason in stop_reasons:
        clean_reason = str(reason).strip()
        if clean_reason and clean_reason not in reasons:
            reasons.append(clean_reason)
    for blocker in reconciliation_blockers:
        if blocker in INFRASTRUCTURE_RECONCILIATION_BLOCKERS and blocker not in reasons:
            reasons.append(blocker)
    return reasons


def _should_exit_nonzero(
    *,
    status: str,
    fail_on_degraded: bool,
    allow_data_quality_degraded: bool,
    hard_failure_reasons: Sequence[str],
) -> bool:
    if not fail_on_degraded or status == "ok":
        return False
    if allow_data_quality_degraded:
        return bool(hard_failure_reasons)
    return True


def _supervised_timeout_payload(
    *,
    args: argparse.Namespace,
    started_at: datetime,
    timeout_seconds: float,
) -> dict[str, Any]:
    stop_reason = "tigerbeetle_journal_worker_timeout"
    batch = {
        "source": "supervised_worker",
        "selected": 0,
        "journaled": 0,
        "skipped": 0,
        "failed": 1,
        "error_counts": {stop_reason: 1},
        "sample_errors": [
            {
                "error_type": "TimeoutExpired",
                "error": f"journal worker exceeded {timeout_seconds:.3f}s",
            }
        ],
        "stopped_early": True,
        "stop_reason": stop_reason,
    }
    reconciliation = {
        "ok": False,
        "status": "skipped",
        "reason": stop_reason,
    }
    payload = _payload(
        args=args,
        started_at=started_at,
        batches=[batch],
        reconciliation=reconciliation,
    )
    payload.update(
        {
            "supervised_worker": False,
            "supervise_timeout_seconds": timeout_seconds,
        }
    )
    return payload


def _without_arg(argv: Sequence[str], option: str) -> list[str]:
    filtered: list[str] = []
    skip_next = False
    for item in argv:
        if skip_next:
            skip_next = False
            continue
        if item == option:
            skip_next = True
            continue
        if item.startswith(f"{option}="):
            continue
        filtered.append(item)
    return filtered


def _with_source_arg(argv: Sequence[str], source: str | None) -> list[str]:
    worker_args = [item for item in argv if item != "--supervised-worker"]
    if source is None:
        return worker_args
    return [*_without_arg(worker_args, "--sources"), "--sources", source]


def _args_for_source(
    args: argparse.Namespace, source: str | None
) -> argparse.Namespace:
    if source is None:
        return args
    source_args = vars(args).copy()
    source_args["sources"] = source
    return argparse.Namespace(**source_args)


def _supervised_worker_argv(source: str | None = None) -> list[str]:
    return [
        sys.executable,
        "-m",
        "scripts.journal_tigerbeetle_order_events",
        *_with_source_arg(sys.argv[1:], source),
        "--supervised-worker",
    ]


def _write_supervised_output(value: str | bytes | None, *, stream: Any) -> str:
    if value is None:
        return ""
    text = (
        value.decode("utf-8", errors="replace") if isinstance(value, bytes) else value
    )
    if text:
        stream.write(text)
        stream.flush()
    return text


def _last_journal_payload(text: str) -> dict[str, Any] | None:
    payload: dict[str, Any] | None = None
    for line in text.splitlines():
        clean_line = line.strip()
        if not clean_line.startswith("{"):
            continue
        try:
            candidate = json.loads(clean_line)
        except json.JSONDecodeError:
            continue
        if (
            isinstance(candidate, dict)
            and candidate.get("schema_version")
            == "torghut.tigerbeetle-journal-order-events.v1"
        ):
            payload = candidate
    return payload


def _journal_progress_events(text: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for line in text.splitlines():
        clean_line = line.strip()
        if not clean_line.startswith("{"):
            continue
        try:
            candidate = json.loads(clean_line)
        except json.JSONDecodeError:
            continue
        if (
            isinstance(candidate, dict)
            and candidate.get("schema_version")
            == "torghut.tigerbeetle-journal-progress.v1"
        ):
            events.append(candidate)
    return events


def _progress_int(value: object) -> int:
    try:
        return int(value)
    except (TypeError, ValueError, ArithmeticError):
        return 0


def _completed_progress_batch_from_timeout(
    text: str,
    *,
    worker_args: argparse.Namespace,
) -> dict[str, Any] | None:
    sources = _parse_sources(getattr(worker_args, "sources", "all"))
    if not bool(getattr(worker_args, "skip_reconcile", False)) or len(sources) != 1:
        return None
    source = sources[0]
    events = _journal_progress_events(text)
    complete_events = [
        event
        for event in events
        if event.get("event") == "source_batch_complete"
        and str(event.get("source") or "").strip() == source
    ]
    if not complete_events:
        return None
    complete = complete_events[-1]
    selected = _progress_int(complete.get("selected"))
    journaled = _progress_int(complete.get("journaled"))
    skipped = _progress_int(complete.get("skipped"))
    failed = _progress_int(complete.get("failed"))
    incomplete_progress = (
        failed != 0
        or bool(complete.get("stopped_early"))
        or str(complete.get("stop_reason") or "").strip()
        or journaled + skipped + failed != selected
    )
    if incomplete_progress:
        return None
    chunk_events = [
        event
        for event in events
        if event.get("event") == "source_batch_chunk_complete"
        and str(event.get("source") or "").strip() == source
    ]
    return {
        "source": source,
        "selected": selected,
        "journaled": journaled,
        "skipped": skipped,
        "failed": failed,
        "error_counts": {},
        "sample_errors": [],
        "stopped_early": False,
        "stop_reason": None,
        "journal_batch_chunk_size": max(
            1,
            min(
                int(
                    getattr(
                        worker_args,
                        "journal_batch_chunk_size",
                        DEFAULT_JOURNAL_BATCH_CHUNK_SIZE,
                    )
                    or DEFAULT_JOURNAL_BATCH_CHUNK_SIZE
                ),
                MAX_JOURNAL_BATCH_CHUNK_SIZE,
            ),
        ),
        "journal_batch_chunks": len(chunk_events),
        "supervised_worker_timeout_normalized": True,
    }


def _payload_from_completed_timeout_progress(
    text: str,
    *,
    worker_args: argparse.Namespace,
    started_at: datetime,
    timeout_seconds: float,
) -> dict[str, Any] | None:
    batch = _completed_progress_batch_from_timeout(text, worker_args=worker_args)
    if batch is None:
        return None
    payload = _payload(
        args=worker_args,
        started_at=started_at,
        batches=[batch],
        reconciliation=None,
    )
    payload.update(
        {
            "supervised_worker": False,
            "supervise_timeout_seconds": timeout_seconds,
            "supervised_worker_timeout_normalized": True,
            "supervised_worker_timeout_reason": "worker_completed_batch_before_process_exit_timeout",
        }
    )
    return payload


def _safe_payload_allows_success(payload: Mapping[str, Any] | None) -> bool:
    if not payload:
        return False
    return (
        payload.get("schema_version") == "torghut.tigerbeetle-journal-order-events.v1"
        and not bool(payload.get("exit_nonzero", True))
        and not bool(payload.get("promotion_authority", True))
        and not bool(payload.get("overrides_runtime_ledger_authority", True))
        and int(payload.get("failed") or 0) == 0
        and not any(
            _has_text_items(payload.get(key))
            for key in ("hard_failure_reasons", "stop_reasons")
        )
    )


def _normalize_supervised_returncode(
    *,
    returncode: int,
    payload: Mapping[str, Any] | None,
    worker_args: argparse.Namespace,
) -> int:
    if returncode == 0:
        return 0
    if not _safe_payload_allows_success(payload):
        return returncode
    assert payload is not None
    _emit_progress(
        "supervised_worker_exit_mismatch_normalized",
        returncode=returncode,
        sources=list(_parse_sources(getattr(worker_args, "sources", "all"))),
        status=str(payload.get("status", "")),
        accounting_blockers=list(
            cast(Sequence[object], payload.get("accounting_blockers") or [])
        ),
        reconciliation_blockers=list(
            cast(Sequence[object], payload.get("reconciliation_blockers") or [])
        ),
    )
    return 0


def _run_supervised_worker_once(
    args: argparse.Namespace,
    *,
    started_at: datetime,
    source: str | None = None,
) -> int:
    worker_args = _args_for_source(args, source)
    timeout_seconds = max(float(worker_args.supervise_timeout_seconds), 0.001)
    stdout_text = ""
    stderr_text = ""
    try:
        completed = subprocess.run(
            _supervised_worker_argv(source),
            check=False,
            timeout=timeout_seconds,
            capture_output=True,
            text=True,
        )
    except subprocess.TimeoutExpired as exc:
        stdout_text += _write_supervised_output(exc.stdout, stream=sys.stdout)
        stderr_text += _write_supervised_output(exc.stderr, stream=sys.stderr)
        completed_payload = _payload_from_completed_timeout_progress(
            stdout_text + "\n" + stderr_text,
            worker_args=worker_args,
            started_at=started_at,
            timeout_seconds=timeout_seconds,
        )
        if completed_payload is not None:
            _emit_progress(
                "supervised_worker_timeout_after_complete_normalized",
                timeout_seconds=timeout_seconds,
                sources=list(_parse_sources(getattr(worker_args, "sources", "all"))),
            )
            print(
                json.dumps(completed_payload, separators=(",", ":"))
                if worker_args.json
                else json.dumps(completed_payload, indent=2)
            )
            return 0
        _emit_progress(
            "supervised_worker_timeout",
            timeout_seconds=timeout_seconds,
            sources=list(_parse_sources(getattr(worker_args, "sources", "all"))),
        )
        payload = _supervised_timeout_payload(
            args=worker_args,
            started_at=started_at,
            timeout_seconds=timeout_seconds,
        )
        print(
            json.dumps(payload, separators=(",", ":"))
            if worker_args.json
            else json.dumps(payload, indent=2)
        )
        return 1 if bool(payload["exit_nonzero"]) else 0
    stdout_text += _write_supervised_output(completed.stdout, stream=sys.stdout)
    stderr_text += _write_supervised_output(completed.stderr, stream=sys.stderr)
    payload = _last_journal_payload(stdout_text)
    if payload is None:
        payload = _last_journal_payload(stderr_text)
    return _normalize_supervised_returncode(
        returncode=int(completed.returncode),
        payload=payload,
        worker_args=worker_args,
    )


def _run_supervised_worker(args: argparse.Namespace, *, started_at: datetime) -> int:
    sources = _parse_sources(getattr(args, "sources", "all"))
    if len(sources) <= 1:
        return _run_supervised_worker_once(args, started_at=started_at)

    exit_code = 0
    for source in sources:
        source_exit_code = _run_supervised_worker_once(
            args,
            started_at=started_at,
            source=source,
        )
        if source_exit_code:
            exit_code = 1
    return exit_code
