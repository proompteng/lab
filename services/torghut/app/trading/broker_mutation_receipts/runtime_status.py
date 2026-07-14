"""Operator-visible code wiring status for broker-mutation safety."""

from __future__ import annotations

from datetime import datetime
from typing import cast

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...models import BrokerMutationReceiptEvent
from ..action_authority import BROKER_MUTATION_RUNTIME_STATUS_SCHEMA_VERSION

# Entry submissions are wired through the durable coordinator. Reduction and
# recovery remain fail-closed until their dedicated roadmap slices are proven.
BROKER_MUTATION_RUNTIME_WIRED = True
BROKER_MUTATION_ENTRY_FENCING_PROVEN = True
BROKER_MUTATION_REDUCTION_FENCING_PROVEN = False
BROKER_MUTATION_RECOVERY_WORKER_WIRED = False


def build_broker_mutation_runtime_status() -> dict[str, object]:
    """Return current code wiring truth without adding status-path database load."""

    return {
        "schema_version": BROKER_MUTATION_RUNTIME_STATUS_SCHEMA_VERSION,
        "runtime_wired": BROKER_MUTATION_RUNTIME_WIRED,
        "entry_fencing_proven": BROKER_MUTATION_ENTRY_FENCING_PROVEN,
        "reduction_fencing_proven": BROKER_MUTATION_REDUCTION_FENCING_PROVEN,
        "recovery_worker_wired": BROKER_MUTATION_RECOVERY_WORKER_WIRED,
        "recovery_degraded": True,
        "database_status": "not_checked",
        "reason_codes": [
            "broker_mutation_reduction_fencing_unproven",
            "broker_mutation_recovery_unproven",
        ],
    }


def load_broker_mutation_runtime_status(session: Session) -> dict[str, object]:
    """Merge code wiring truth with the latest durable receipt states."""

    latest_sequence = (
        select(
            BrokerMutationReceiptEvent.receipt_id.label("receipt_id"),
            func.max(BrokerMutationReceiptEvent.sequence_no).label("sequence_no"),
        )
        .group_by(BrokerMutationReceiptEvent.receipt_id)
        .subquery()
    )
    latest = (
        select(BrokerMutationReceiptEvent)
        .join(
            latest_sequence,
            (BrokerMutationReceiptEvent.receipt_id == latest_sequence.c.receipt_id)
            & (BrokerMutationReceiptEvent.sequence_no == latest_sequence.c.sequence_no),
        )
        .subquery()
    )
    state_rows = session.execute(
        select(latest.c.state, func.count()).group_by(latest.c.state)
    ).all()
    state_counts = {
        state: int(count) for state, count in state_rows if isinstance(state, str)
    }
    recovery_due_count = int(
        session.execute(
            select(func.count())
            .select_from(latest)
            .where(
                latest.c.state == "broker_io",
                latest.c.recovery_after.is_not(None),
                latest.c.recovery_after <= func.current_timestamp(),
            )
        ).scalar_one()
    )
    latest_recorded_at = session.execute(
        select(func.max(BrokerMutationReceiptEvent.recorded_at))
    ).scalar_one_or_none()
    payload = build_broker_mutation_runtime_status()
    unresolved_count = state_counts.get("broker_io", 0)
    if unresolved_count > 0:
        reason_codes = payload.get("reason_codes")
        payload["reason_codes"] = [
            "broker_mutation_submit_unresolved",
            *(
                [
                    reason
                    for reason in cast(list[object], reason_codes)
                    if isinstance(reason, str)
                ]
                if isinstance(reason_codes, list)
                else []
            ),
        ]
    payload.update(
        database_status="current",
        receipt_state_counts={
            state: state_counts.get(state, 0)
            for state in ("claimed", "released", "broker_io", "settled")
        },
        pre_io_receipt_count=(
            state_counts.get("claimed", 0) + state_counts.get("released", 0)
        ),
        unresolved_receipt_count=unresolved_count,
        recovery_due_receipt_count=recovery_due_count,
        settled_receipt_count=state_counts.get("settled", 0),
        latest_receipt_event_at=(
            latest_recorded_at.isoformat()
            if isinstance(latest_recorded_at, datetime)
            else None
        ),
    )
    return payload


def unavailable_broker_mutation_runtime_status() -> dict[str, object]:
    """Fail entry capability closed when durable receipt state is unreadable."""

    payload = build_broker_mutation_runtime_status()
    reason_codes = payload.get("reason_codes")
    existing_reason_codes = (
        [
            reason
            for reason in cast(list[object], reason_codes)
            if isinstance(reason, str)
        ]
        if isinstance(reason_codes, list)
        else []
    )
    payload.update(
        entry_fencing_proven=False,
        database_status="unavailable",
        receipt_state_counts=None,
        pre_io_receipt_count=None,
        unresolved_receipt_count=None,
        recovery_due_receipt_count=None,
        settled_receipt_count=None,
        latest_receipt_event_at=None,
        reason_codes=[
            "broker_mutation_database_status_unavailable",
            *existing_reason_codes,
        ],
    )
    return payload


__all__ = [
    "BROKER_MUTATION_ENTRY_FENCING_PROVEN",
    "BROKER_MUTATION_RECOVERY_WORKER_WIRED",
    "BROKER_MUTATION_REDUCTION_FENCING_PROVEN",
    "BROKER_MUTATION_RUNTIME_WIRED",
    "build_broker_mutation_runtime_status",
    "load_broker_mutation_runtime_status",
    "unavailable_broker_mutation_runtime_status",
]
