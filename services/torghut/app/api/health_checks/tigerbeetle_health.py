"""Postgres and TigerBeetle dependency health payloads."""

from __future__ import annotations

import logging
import queue
import threading
from collections.abc import Mapping, Sequence
from typing import cast

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config import Settings, settings
from app.db import ping
from app.trading.tigerbeetle_client import (
    TigerBeetleClientProtocol,
    TigerBeetleHealth,
    check_tigerbeetle_health,
    create_tigerbeetle_client,
)
from app.trading.tigerbeetle_reconcile import (
    BLOCKER_RECONCILIATION_STALE,
    latest_tigerbeetle_reconciliation_payload,
    latest_tigerbeetle_reconciliation_status_payload,
    tigerbeetle_ref_counts,
)

logger = logging.getLogger(__name__)


class TigerBeetleProtocolHealthProbe:
    """Reuse one native client for process-local protocol health checks."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._reset_requested = threading.Event()
        self._client: TigerBeetleClientProtocol | None = None
        self._configuration: tuple[int, str, float] | None = None

    @staticmethod
    def _configuration_for(settings_obj: Settings) -> tuple[int, str, float]:
        return (
            settings_obj.tigerbeetle_cluster_id,
            settings_obj.tigerbeetle_replica_addresses,
            settings_obj.tigerbeetle_rpc_timeout_seconds,
        )

    def _close_client_locked(self) -> None:
        client = self._client
        self._client = None
        self._configuration = None
        self._close_client(client)

    @staticmethod
    def _close_client(client: TigerBeetleClientProtocol | None) -> None:
        if client is None:
            return
        close = getattr(client, "close", None)
        if not callable(close):
            return
        try:
            close()
        except (OSError, RuntimeError, ValueError) as exc:  # pragma: no cover
            logger.warning("TigerBeetle protocol health client cleanup failed: %s", exc)

    def request_reset(self) -> None:
        """Invalidate the client after a caller-side timeout without blocking."""

        self._reset_requested.set()

    def check(self, settings_obj: Settings) -> TigerBeetleHealth:
        configuration = self._configuration_for(settings_obj)
        if not self._lock.acquire(blocking=False):
            raise TigerBeetleProtocolHealthProbeBusyError(
                "tigerbeetle_protocol_health_probe_in_flight"
            )
        try:
            if self._reset_requested.is_set() or self._configuration != configuration:
                self._close_client_locked()
                self._reset_requested.clear()
            if self._client is None:
                self._client = create_tigerbeetle_client(settings_obj)
                self._configuration = configuration
            health = check_tigerbeetle_health(
                settings_obj,
                client=self._client,
            )
            if not health.ok or self._reset_requested.is_set():
                self._close_client_locked()
                self._reset_requested.clear()
            return health
        except (ImportError, OSError, RuntimeError, ValueError):
            self._close_client_locked()
            self._reset_requested.clear()
            raise
        finally:
            self._lock.release()

    def close(self, *, wait_timeout_seconds: float = 0.1) -> None:
        self.request_reset()
        if not self._lock.acquire(blocking=False):
            return
        try:
            client = self._client
            self._client = None
            self._configuration = None
            self._reset_requested.clear()
        finally:
            self._lock.release()
        if client is None:
            return
        cleanup = threading.Thread(
            target=self._close_client,
            args=(client,),
            name="torghut-tigerbeetle-health-cleanup",
            daemon=True,
        )
        cleanup.start()
        cleanup.join(timeout=max(0.0, float(wait_timeout_seconds)))


class TigerBeetleProtocolHealthProbeBusyError(RuntimeError):
    """Raised instead of queueing behind an already-running native probe."""


_tigerbeetle_protocol_health_probe = TigerBeetleProtocolHealthProbe()


def close_tigerbeetle_protocol_health_probe() -> None:
    """Close the process-local native client during application shutdown."""

    _tigerbeetle_protocol_health_probe.close()


def _run_tigerbeetle_protocol_health_probe(
    *,
    timeout_seconds: float,
) -> TigerBeetleHealth:
    result_queue: queue.Queue[TigerBeetleHealth | BaseException] = queue.Queue(
        maxsize=1
    )

    def run_probe() -> None:
        try:
            result_queue.put(
                _tigerbeetle_protocol_health_probe.check(settings),
                block=False,
            )
        except (ImportError, OSError, RuntimeError, ValueError) as exc:
            result_queue.put(exc, block=False)

    worker = threading.Thread(
        target=run_probe,
        name="torghut-tigerbeetle-health-probe",
        daemon=True,
    )
    worker.start()
    try:
        result = result_queue.get(timeout=timeout_seconds)
    except queue.Empty as exc:
        raise TimeoutError from exc
    if isinstance(result, BaseException):
        raise result
    return result


def apply_status_read_statement_timeout(
    session: Session,
    *,
    milliseconds: int,
) -> None:
    from ..status_helpers import (
        apply_status_read_statement_timeout as apply_statement_timeout,
    )

    apply_statement_timeout(session, milliseconds=milliseconds)


def sqlalchemy_error_indicates_statement_timeout(exc: SQLAlchemyError) -> bool:
    message = str(exc).lower()
    return (
        "statement timeout" in message
        or "querycanceled" in message
        or "query canceled" in message
    )


def check_postgres(session: Session) -> dict[str, object]:
    try:
        ping(session)
    except SQLAlchemyError as exc:
        return {"ok": False, "detail": f"postgres error: {exc}"}
    return {"ok": True, "detail": "ok"}


def check_tigerbeetle_protocol_health() -> dict[str, object]:
    if not settings.tigerbeetle_enabled:
        health = check_tigerbeetle_health(settings)
        payload = health.as_dict()
        payload["protocol_ok"] = True
        payload["protocol_probe_skipped"] = False
        return payload

    replica_addresses = [
        item.strip()
        for item in settings.tigerbeetle_replica_addresses.split(",")
        if item.strip()
    ]
    if not (settings.tigerbeetle_required or settings.tigerbeetle_reconcile_required):
        return {
            "enabled": True,
            "required": settings.tigerbeetle_required,
            "ok": True,
            "protocol_ok": False,
            "protocol_probe_skipped": True,
            "cluster_id": settings.tigerbeetle_cluster_id,
            "replica_addresses": replica_addresses,
            "last_error": None,
        }

    timeout_seconds = max(0.1, float(settings.tigerbeetle_health_timeout_seconds))
    try:
        health = _run_tigerbeetle_protocol_health_probe(
            timeout_seconds=timeout_seconds,
        )
    except TimeoutError:
        _tigerbeetle_protocol_health_probe.request_reset()
        return {
            "enabled": True,
            "required": settings.tigerbeetle_required,
            "ok": not settings.tigerbeetle_required,
            "protocol_ok": False,
            "protocol_probe_skipped": False,
            "cluster_id": settings.tigerbeetle_cluster_id,
            "replica_addresses": replica_addresses,
            "last_error": (
                f"TimeoutError: tigerbeetle protocol health timed out after "
                f"{timeout_seconds:.2f}s"
            ),
        }
    except TigerBeetleProtocolHealthProbeBusyError as exc:
        return {
            "enabled": True,
            "required": settings.tigerbeetle_required,
            "ok": not settings.tigerbeetle_required,
            "protocol_ok": False,
            "protocol_probe_skipped": False,
            "cluster_id": settings.tigerbeetle_cluster_id,
            "replica_addresses": replica_addresses,
            "last_error": f"{type(exc).__name__}: {exc}",
        }
    except (ImportError, OSError, RuntimeError, ValueError) as exc:
        _tigerbeetle_protocol_health_probe.request_reset()
        return {
            "enabled": True,
            "required": settings.tigerbeetle_required,
            "ok": not settings.tigerbeetle_required,
            "protocol_ok": False,
            "protocol_probe_skipped": False,
            "cluster_id": settings.tigerbeetle_cluster_id,
            "replica_addresses": replica_addresses,
            "last_error": f"{type(exc).__name__}: {exc}",
        }
    payload = health.as_dict()
    protocol_ok = bool(payload.get("ok"))
    payload["protocol_ok"] = protocol_ok
    payload["protocol_probe_skipped"] = False
    payload["ok"] = protocol_ok or not settings.tigerbeetle_required
    return payload


def tigerbeetle_status_int(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return 0


def empty_tigerbeetle_ref_counts(
    *,
    reason_codes: Sequence[str],
    last_error: str | None = None,
) -> dict[str, object]:
    return {
        "schema_version": "torghut.tigerbeetle-ref-counts.v1",
        "cluster_id": settings.tigerbeetle_cluster_id,
        "ref_counts_unavailable": True,
        "reason_codes": list(reason_codes),
        "last_error": last_error,
        "account_ref_count": 0,
        "transfer_ref_count": 0,
        "by_source_type": {},
        "order_event_ref_count": 0,
        "execution_ref_count": 0,
        "cost_ref_count": 0,
        "runtime_ledger_ref_count": 0,
        "stable_ref_count": 0,
        "stable_ref_missing_count": 0,
        "stable_ref_mismatch_count": 0,
        "stable_ref_diagnostic_bounded": True,
        "stable_ref_sample_size": 0,
        "runtime_ledger_required_bucket_count": 0,
        "runtime_ledger_signed_ref_count": 0,
        "runtime_ledger_missing_signed_ref_count": 0,
        "runtime_ledger_account_ref_count": 0,
        "runtime_ledger_missing_account_ref_count": 0,
        "runtime_ledger_missing_account_ids": [],
        "runtime_ledger_source_ids": [],
        "runtime_ledger_transfer_ids": [],
        "runtime_ledger_signed_bucket_ids": [],
        "runtime_ledger_ref_coverage_bounded": True,
        "runtime_ledger_ref_sample_size": 0,
        "source_materialization": {
            "account_ref_table": "tigerbeetle_account_refs",
            "transfer_ref_table": "tigerbeetle_transfer_refs",
            "reconciliation_run_table": "tigerbeetle_reconciliation_runs",
            "runtime_ledger_source_table": "strategy_runtime_ledger_buckets",
            "runtime_ledger_source_type": "strategy_runtime_ledger_bucket",
            "runtime_ledger_transfer_kind": "runtime_net_pnl",
        },
    }


def latest_reconciliation_ref_counts(
    latest_reconciliation: Mapping[str, object] | None,
) -> dict[str, object] | None:
    if latest_reconciliation is None:
        return None
    raw_ref_counts = latest_reconciliation.get("ref_counts")
    if not isinstance(raw_ref_counts, Mapping):
        return None
    ref_counts = dict(cast(Mapping[str, object], raw_ref_counts))
    required_keys = (
        "account_ref_count",
        "transfer_ref_count",
        "runtime_ledger_ref_count",
        "runtime_ledger_signed_ref_count",
        "runtime_ledger_missing_signed_ref_count",
        "runtime_ledger_missing_account_ref_count",
    )
    trusted_top_level_keys: set[str] | None = None
    raw_field_names = latest_reconciliation.get("ref_count_field_names")
    if isinstance(raw_field_names, Sequence) and not isinstance(
        raw_field_names,
        (str, bytes, bytearray),
    ):
        trusted_top_level_keys = {
            str(item) for item in cast(Sequence[object], raw_field_names)
        }
    for key in required_keys:
        if key in ref_counts or key not in latest_reconciliation:
            continue
        if trusted_top_level_keys is not None and key not in trusted_top_level_keys:
            continue
        if key not in ref_counts and key in latest_reconciliation:
            ref_counts[key] = latest_reconciliation[key]
    if not all(key in ref_counts for key in required_keys):
        return None
    ref_counts.setdefault("schema_version", "torghut.tigerbeetle-ref-counts.v1")
    ref_counts["source"] = "latest_tigerbeetle_reconciliation"
    ref_counts["source_reconciliation_status"] = latest_reconciliation.get("status")
    ref_counts["source_reconciliation_ok"] = bool(latest_reconciliation.get("ok"))
    ref_counts["source_reconciliation_age_seconds"] = latest_reconciliation.get(
        "age_seconds"
    )
    ref_counts["source_reconciliation_stale"] = bool(
        latest_reconciliation.get("reconciliation_stale")
    )
    ref_counts["bounded_status_live_query_skipped"] = True
    return ref_counts


def unavailable_tigerbeetle_reconciliation_payload(
    *,
    reason_codes: Sequence[str],
    last_error: str | None = None,
) -> dict[str, object]:
    return {
        "schema_version": "torghut.tigerbeetle-reconciliation-status.v1",
        "ok": False,
        "cluster_id": settings.tigerbeetle_cluster_id,
        "status": "unavailable",
        "age_seconds": None,
        "reconciliation_freshness": {
            "observed_at": None,
            "age_seconds": None,
            "max_age_seconds": max(
                1,
                int(settings.tigerbeetle_reconcile_max_age_seconds),
            ),
            "stale": True,
        },
        "authority": "accounting_parity_only",
        "promotion_authority": False,
        "overrides_runtime_ledger_authority": False,
        "reason_codes": list(reason_codes),
        "last_error": last_error,
        "blockers": list(reason_codes),
        "ref_counts": {},
    }


def build_tigerbeetle_ledger_status(session: Session) -> dict[str, object]:
    protocol = check_tigerbeetle_protocol_health()
    blockers: list[str] = []
    latest_reconciliation: dict[str, object] | None
    reconciliation_status_available = True
    try:
        apply_status_read_statement_timeout(session, milliseconds=750)
        latest_reconciliation = latest_tigerbeetle_reconciliation_status_payload(
            session,
            cluster_id=settings.tigerbeetle_cluster_id,
        )
        if latest_reconciliation is None:
            latest_reconciliation = latest_tigerbeetle_reconciliation_payload(
                session,
                cluster_id=settings.tigerbeetle_cluster_id,
            )
    except SQLAlchemyError as exc:
        logger.warning("TigerBeetle reconciliation status unavailable: %s", exc)
        session.rollback()
        reconciliation_status_available = False
        reason_codes = ["tigerbeetle_reconciliation_status_unavailable"]
        if sqlalchemy_error_indicates_statement_timeout(exc):
            reason_codes.append("tigerbeetle_reconciliation_status_query_timeout")
        blockers.extend(reason_codes)
        latest_reconciliation = unavailable_tigerbeetle_reconciliation_payload(
            reason_codes=reason_codes,
            last_error=str(exc),
        )

    reconciliation_required = bool(settings.tigerbeetle_reconcile_required)
    reconciliation_max_age_seconds = max(
        1,
        int(settings.tigerbeetle_reconcile_max_age_seconds),
    )
    latest_reconciliation_age_seconds = (
        tigerbeetle_status_int(latest_reconciliation.get("age_seconds"))
        if latest_reconciliation is not None
        else None
    )
    latest_reconciliation_stale = bool(
        latest_reconciliation is not None
        and (
            bool(latest_reconciliation.get("reconciliation_stale"))
            or (
                latest_reconciliation_age_seconds is not None
                and latest_reconciliation_age_seconds > reconciliation_max_age_seconds
            )
        )
    )

    ref_counts: dict[str, object]
    ref_counts_available = True
    latest_ref_counts = (
        latest_reconciliation_ref_counts(latest_reconciliation)
        if reconciliation_required and not latest_reconciliation_stale
        else None
    )
    if latest_ref_counts is not None:
        ref_counts = latest_ref_counts
    else:
        try:
            apply_status_read_statement_timeout(session, milliseconds=750)
            ref_counts = tigerbeetle_ref_counts(
                session,
                cluster_id=settings.tigerbeetle_cluster_id,
                full_ref_scan=False,
            )
        except SQLAlchemyError as exc:
            logger.warning("TigerBeetle ref-count status unavailable: %s", exc)
            session.rollback()
            ref_counts_available = False
            reason_codes = ["tigerbeetle_ref_counts_unavailable"]
            if sqlalchemy_error_indicates_statement_timeout(exc):
                reason_codes.append("tigerbeetle_ref_counts_query_timeout")
            blockers.extend(reason_codes)
            ref_counts = empty_tigerbeetle_ref_counts(
                reason_codes=reason_codes,
                last_error=str(exc),
            )
    runtime_ledger_ref_count = tigerbeetle_status_int(
        ref_counts.get("runtime_ledger_ref_count")
    )
    runtime_ledger_signed_ref_count = tigerbeetle_status_int(
        ref_counts.get("runtime_ledger_signed_ref_count")
    )
    runtime_ledger_missing_signed_ref_count = tigerbeetle_status_int(
        ref_counts.get("runtime_ledger_missing_signed_ref_count")
    )
    runtime_ledger_missing_account_ref_count = tigerbeetle_status_int(
        ref_counts.get("runtime_ledger_missing_account_ref_count")
    )
    claimed_by_runtime_evidence = runtime_ledger_ref_count > 0
    if (
        settings.tigerbeetle_enabled
        and not bool(protocol.get("protocol_ok"))
        and not bool(protocol.get("protocol_probe_skipped"))
    ):
        blockers.append("tigerbeetle_protocol_unhealthy")
    reconciliation_ok = True
    if latest_reconciliation is None:
        if reconciliation_required:
            reconciliation_ok = False
            blockers.append("tigerbeetle_reconciliation_missing")
    else:
        reconciliation_ok = bool(latest_reconciliation.get("ok"))
        reconciliation_age_seconds = tigerbeetle_status_int(
            latest_reconciliation.get("age_seconds")
        )
        reconciliation_max_age_seconds = max(
            1,
            int(settings.tigerbeetle_reconcile_max_age_seconds),
        )
        if reconciliation_age_seconds > reconciliation_max_age_seconds:
            reconciliation_ok = False
            blockers.append(BLOCKER_RECONCILIATION_STALE)
        raw_blockers = latest_reconciliation.get("blockers")
        if isinstance(raw_blockers, Sequence) and not isinstance(
            raw_blockers, (str, bytes, bytearray)
        ):
            blocker_items = cast(Sequence[object], raw_blockers)
            blockers.extend(str(item) for item in blocker_items)
    if not reconciliation_status_available:
        reconciliation_ok = False
    if not ref_counts_available:
        reconciliation_ok = False
    reconciliation_age_seconds = (
        tigerbeetle_status_int(latest_reconciliation.get("age_seconds"))
        if latest_reconciliation is not None
        else None
    )
    reconciliation_max_age_seconds = max(
        1,
        int(settings.tigerbeetle_reconcile_max_age_seconds),
    )
    reconciliation_stale = (
        reconciliation_age_seconds is not None
        and reconciliation_age_seconds > reconciliation_max_age_seconds
    )
    if runtime_ledger_missing_signed_ref_count:
        reconciliation_ok = False
        blockers.append("tigerbeetle_runtime_ledger_signed_refs_missing")
    if runtime_ledger_ref_count and runtime_ledger_signed_ref_count <= 0:
        reconciliation_ok = False
        blockers.append("tigerbeetle_runtime_ledger_signed_refs_missing")
    if runtime_ledger_missing_account_ref_count:
        reconciliation_ok = False
        blockers.append("tigerbeetle_runtime_ledger_account_refs_missing")

    protocol_gate_ok = bool(protocol.get("ok"))
    reconcile_gate_ok = reconciliation_ok or not reconciliation_required
    return {
        "schema_version": "torghut.tigerbeetle-ledger-status.v1",
        "enabled": settings.tigerbeetle_enabled,
        "journal_enabled": settings.tigerbeetle_journal_enabled,
        "required": settings.tigerbeetle_required,
        "reconcile_required": settings.tigerbeetle_reconcile_required,
        "claimed_by_runtime_evidence": claimed_by_runtime_evidence,
        "reconciliation_required": reconciliation_required,
        "ok": protocol_gate_ok and reconcile_gate_ok,
        "protocol_ok": bool(protocol.get("protocol_ok")),
        "protocol_probe_skipped": bool(protocol.get("protocol_probe_skipped")),
        "reconciliation_ok": reconciliation_ok,
        "reconciliation_age_seconds": reconciliation_age_seconds,
        "reconciliation_max_age_seconds": reconciliation_max_age_seconds,
        "reconciliation_stale": reconciliation_stale,
        "cluster_id": settings.tigerbeetle_cluster_id,
        "replica_addresses": protocol.get("replica_addresses", []),
        "last_error": protocol.get("last_error"),
        "ref_counts": ref_counts,
        "account_ref_count": ref_counts.get("account_ref_count", 0),
        "transfer_ref_count": ref_counts.get("transfer_ref_count", 0),
        "runtime_ledger_ref_count": runtime_ledger_ref_count,
        "runtime_ledger_signed_ref_count": runtime_ledger_signed_ref_count,
        "runtime_ledger_missing_signed_ref_count": (
            runtime_ledger_missing_signed_ref_count
        ),
        "runtime_ledger_missing_account_ref_count": (
            runtime_ledger_missing_account_ref_count
        ),
        "source_materialization": ref_counts.get("source_materialization", {}),
        "latest_reconciliation": latest_reconciliation,
        "blockers": sorted(set(blockers)),
    }


__all__ = (
    "TigerBeetleProtocolHealthProbe",
    "TigerBeetleProtocolHealthProbeBusyError",
    "apply_status_read_statement_timeout",
    "build_tigerbeetle_ledger_status",
    "check_postgres",
    "check_tigerbeetle_protocol_health",
    "close_tigerbeetle_protocol_health_probe",
    "empty_tigerbeetle_ref_counts",
    "latest_reconciliation_ref_counts",
    "sqlalchemy_error_indicates_statement_timeout",
    "tigerbeetle_status_int",
    "unavailable_tigerbeetle_reconciliation_payload",
)
