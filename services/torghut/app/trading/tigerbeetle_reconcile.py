"""TigerBeetle reconciliation for Torghut ledger references."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings, settings
from app.models import (
    ExecutionOrderEvent,
    TigerBeetleReconciliationRun,
    TigerBeetleTransferRef,
    coerce_json_payload,
)
from app.trading.tigerbeetle_client import (
    TigerBeetleClientProtocol,
    create_tigerbeetle_client,
)
from app.trading.tigerbeetle_ledger_model import transfer_kind_for_event


SCHEMA_VERSION = "torghut.tigerbeetle-reconciliation.v1"
BLOCKER_TRANSFER_MISSING = "tigerbeetle_transfer_missing"
BLOCKER_AMOUNT_MISMATCH = "tigerbeetle_transfer_amount_mismatch"
BLOCKER_CODE_MISMATCH = "tigerbeetle_transfer_code_mismatch"
BLOCKER_LEDGER_MISMATCH = "tigerbeetle_transfer_ledger_mismatch"
BLOCKER_UNLINKED_EVENT = "tigerbeetle_unlinked_order_event"
BLOCKER_CLIENT_UNAVAILABLE = "tigerbeetle_client_unavailable"


def _attr(value: object, name: str) -> Any:
    if isinstance(value, Mapping):
        value_mapping = cast(Mapping[str, Any], value)
        result = value_mapping.get(name)
        if result is None and name == "id":
            result = value_mapping.get("transfer_id")
        return result
    if hasattr(value, name):
        return getattr(value, name)
    if name == "id" and hasattr(value, "transfer_id"):
        return getattr(value, "transfer_id")
    raise AttributeError(name)


def _latest_run_payload(
    row: TigerBeetleReconciliationRun | None,
) -> dict[str, object] | None:
    if row is None:
        return None
    raw_payload_json = cast(object, getattr(row, "payload_json", None))
    payload = (
        cast(dict[str, object], raw_payload_json)
        if isinstance(raw_payload_json, dict)
        else {}
    )
    raw_blockers = payload.get("blockers")
    blockers = (
        [str(item) for item in cast(Sequence[object], raw_blockers)]
        if isinstance(raw_blockers, Sequence)
        and not isinstance(raw_blockers, (str, bytes, bytearray))
        else []
    )
    return {
        "schema_version": SCHEMA_VERSION,
        "ok": row.status == "ok",
        "cluster_id": row.cluster_id,
        "status": row.status,
        "checked_transfer_count": row.checked_transfer_count,
        "missing_transfer_count": row.missing_transfer_count,
        "mismatched_transfer_count": row.mismatched_transfer_count,
        "started_at": row.started_at.isoformat(),
        "finished_at": row.finished_at.isoformat() if row.finished_at else None,
        "blockers": blockers,
    }


def latest_tigerbeetle_reconciliation_payload(
    session: Session,
    *,
    cluster_id: int,
) -> dict[str, object] | None:
    row = (
        session.execute(
            select(TigerBeetleReconciliationRun)
            .where(TigerBeetleReconciliationRun.cluster_id == cluster_id)
            .order_by(TigerBeetleReconciliationRun.started_at.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )
    return _latest_run_payload(row)


def reconcile_tigerbeetle_transfers(
    session: Session,
    *,
    settings_obj: Settings = settings,
    client: TigerBeetleClientProtocol | None = None,
    limit: int = 500,
    persist: bool = True,
) -> dict[str, object]:
    started_at = datetime.now(timezone.utc)
    refs = (
        session.execute(
            select(TigerBeetleTransferRef)
            .where(
                TigerBeetleTransferRef.cluster_id == settings_obj.tigerbeetle_cluster_id
            )
            .order_by(TigerBeetleTransferRef.created_at.desc())
            .limit(limit)
        )
        .scalars()
        .all()
    )
    checked_transfer_count = len(refs)
    missing_transfer_count = 0
    mismatched_transfer_count = 0
    blockers: list[str] = []

    transfer_lookup: dict[str, object] = {}
    try:
        if refs:
            tb_client = client or create_tigerbeetle_client(settings_obj)
            looked_up = tb_client.lookup_transfers(
                [int(ref.transfer_id) for ref in refs]
            )
            transfer_lookup = {str(_attr(item, "id")): item for item in looked_up}
    except Exception:
        blockers.append(BLOCKER_CLIENT_UNAVAILABLE)

    for ref in refs:
        actual = transfer_lookup.get(ref.transfer_id)
        if actual is None:
            missing_transfer_count += 1
            blockers.append(BLOCKER_TRANSFER_MISSING)
            continue
        if Decimal(str(_attr(actual, "amount"))) != ref.amount:
            mismatched_transfer_count += 1
            blockers.append(BLOCKER_AMOUNT_MISMATCH)
        if int(_attr(actual, "code")) != ref.code:
            mismatched_transfer_count += 1
            blockers.append(BLOCKER_CODE_MISMATCH)
        if int(_attr(actual, "ledger")) != ref.ledger:
            mismatched_transfer_count += 1
            blockers.append(BLOCKER_LEDGER_MISMATCH)

    event_ids_with_refs = {
        item
        for item in session.execute(
            select(TigerBeetleTransferRef.execution_order_event_id).where(
                TigerBeetleTransferRef.cluster_id
                == settings_obj.tigerbeetle_cluster_id,
                TigerBeetleTransferRef.execution_order_event_id.is_not(None),
            )
        ).scalars()
        if item is not None
    }
    recent_events = (
        session.execute(
            select(ExecutionOrderEvent)
            .order_by(ExecutionOrderEvent.created_at.desc())
            .limit(limit)
        )
        .scalars()
        .all()
    )
    unlinked_event_count = sum(
        1
        for event in recent_events
        if event.id not in event_ids_with_refs
        and transfer_kind_for_event(event.event_type, event.status) is not None
    )
    if unlinked_event_count:
        blockers.append(BLOCKER_UNLINKED_EVENT)

    unique_blockers = sorted(set(blockers))
    ok = not unique_blockers
    finished_at = datetime.now(timezone.utc)
    payload: dict[str, object] = {
        "schema_version": SCHEMA_VERSION,
        "ok": ok,
        "cluster_id": settings_obj.tigerbeetle_cluster_id,
        "checked_transfer_count": checked_transfer_count,
        "missing_transfer_count": missing_transfer_count,
        "mismatched_transfer_count": mismatched_transfer_count,
        "unlinked_event_count": unlinked_event_count,
        "blockers": unique_blockers,
    }
    if persist:
        session.add(
            TigerBeetleReconciliationRun(
                cluster_id=settings_obj.tigerbeetle_cluster_id,
                started_at=started_at,
                finished_at=finished_at,
                status="ok" if ok else "degraded",
                checked_transfer_count=checked_transfer_count,
                missing_transfer_count=missing_transfer_count,
                mismatched_transfer_count=mismatched_transfer_count,
                payload_json=coerce_json_payload(payload),
            )
        )
        session.flush()
    return payload
