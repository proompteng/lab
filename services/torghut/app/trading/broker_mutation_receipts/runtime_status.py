"""Operator-visible code wiring status for broker-mutation safety."""

from __future__ import annotations

from collections import Counter
from datetime import datetime
from typing import cast

from sqlalchemy import cast as sql_cast
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from ...models import BrokerMutationReceipt, BrokerMutationReceiptEvent
from ...config import settings
from ..action_authority import BROKER_MUTATION_RUNTIME_STATUS_SCHEMA_VERSION

# Entry submissions, observation-only recovery, and every reachable reduction
# mutation are wired through the durable coordinator. Slice 6 graduated only
# after the promoted Alpaca-paper lifecycle exercised submit, replace, cancel,
# targeted close, and final flatten as one excluded, fully settled causal chain.
BROKER_MUTATION_RUNTIME_WIRED = True
BROKER_MUTATION_ENTRY_FENCING_PROVEN = True
BROKER_MUTATION_REDUCTION_FENCING_PROVEN = True
BROKER_MUTATION_RECOVERY_WORKER_WIRED = True


def build_broker_mutation_runtime_status() -> dict[str, object]:
    """Return current code wiring truth without adding status-path database load."""

    recovery_enabled = settings.trading_broker_mutation_recovery_enabled
    reason_codes = (
        []
        if BROKER_MUTATION_REDUCTION_FENCING_PROVEN
        else ["broker_mutation_reduction_fencing_unproven"]
    )
    if not recovery_enabled:
        reason_codes.append("broker_mutation_recovery_disabled")
    return {
        "schema_version": BROKER_MUTATION_RUNTIME_STATUS_SCHEMA_VERSION,
        "runtime_wired": BROKER_MUTATION_RUNTIME_WIRED,
        "entry_fencing_proven": BROKER_MUTATION_ENTRY_FENCING_PROVEN,
        "reduction_fencing_proven": BROKER_MUTATION_REDUCTION_FENCING_PROVEN,
        "recovery_worker_wired": BROKER_MUTATION_RECOVERY_WORKER_WIRED,
        "recovery_worker_enabled": recovery_enabled,
        "recovery_degraded": not recovery_enabled,
        "database_status": "not_checked",
        "unresolved_submit_receipt_count": None,
        "unresolved_reduction_receipt_count": None,
        "reason_codes": reason_codes,
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
    state_counts = Counter(
        {state: int(count) for state, count in state_rows if isinstance(state, str)}
    )
    unresolved_operation_rows = session.execute(
        select(BrokerMutationReceipt.operation, func.count())
        .join(latest, latest.c.receipt_id == BrokerMutationReceipt.id)
        .where(latest.c.state == "broker_io")
        .group_by(BrokerMutationReceipt.operation)
    ).all()
    unresolved_operation_counts = Counter(
        {
            operation: int(count)
            for operation, count in unresolved_operation_rows
            if isinstance(operation, str)
        }
    )
    settlement_rows = session.execute(
        select(latest.c.settlement_outcome, func.count())
        .where(latest.c.state == "settled")
        .group_by(latest.c.settlement_outcome)
    ).all()
    settlement_counts = Counter(
        {
            outcome: int(count)
            for outcome, count in settlement_rows
            if isinstance(outcome, str)
        }
    )
    resolution_state = (
        func.jsonb_extract_path_text(
            sql_cast(latest.c.recovery_evidence_json, JSONB),
            "observation",
            "resolution_state",
        )
        if session.get_bind().dialect.name == "postgresql"
        else func.json_extract(
            latest.c.recovery_evidence_json,
            "$.observation.resolution_state",
        )
    )
    resolution_rows = session.execute(
        select(resolution_state, func.count())
        .where(
            latest.c.state == "broker_io",
            latest.c.recovery_evidence_json.is_not(None),
        )
        .group_by(resolution_state)
    ).all()
    unresolved_resolution_counts = Counter(
        {
            state: int(count)
            for state, count in resolution_rows
            if isinstance(state, str)
            and state in {"submitted_unknown", "expired", "manual_review"}
        }
    )
    manual_review_count = unresolved_resolution_counts.get("manual_review", 0)
    expired_count = unresolved_resolution_counts.get("expired", 0)
    rejected_count = settlement_counts.get("rejected", 0)
    validation_quarantine_closed_count = settlement_counts.get(
        "validation_quarantine_closed", 0
    )
    acknowledged_count = sum(
        settlement_counts.get(outcome, 0)
        for outcome in ("acknowledged", "reconciled", "already_satisfied")
    )
    submitted_unknown_count = max(
        0,
        state_counts.get("broker_io", 0) - manual_review_count - expired_count,
    ) + max(
        0,
        state_counts.get("settled", 0)
        - acknowledged_count
        - rejected_count
        - validation_quarantine_closed_count,
    )
    resolution_state_counts: Counter[str] = Counter(
        {
            "claimed": state_counts.get("claimed", 0) + state_counts.get("released", 0),
            "submitted_unknown": submitted_unknown_count,
            "acknowledged": acknowledged_count,
            "rejected": rejected_count,
            "expired": expired_count,
            "manual_review": manual_review_count,
            "validation_quarantine_closed": validation_quarantine_closed_count,
        }
    )
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
    unresolved_submit_count = unresolved_operation_counts.get("submit_order", 0)
    unresolved_reduction_count = unresolved_count - unresolved_submit_count
    if unresolved_count > 0:
        reason_codes = payload.get("reason_codes")
        payload["reason_codes"] = [
            "broker_mutation_unresolved",
            *(
                ["broker_mutation_submit_unresolved"]
                if unresolved_submit_count > 0
                else []
            ),
            *(
                ["broker_mutation_reduction_unresolved"]
                if unresolved_reduction_count > 0
                else []
            ),
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
        payload["recovery_degraded"] = True
    if manual_review_count > 0:
        reason_codes = payload.get("reason_codes")
        payload["reason_codes"] = [
            "broker_mutation_recovery_manual_review",
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
        payload["recovery_degraded"] = True
    if expired_count > 0:
        reason_codes = payload.get("reason_codes")
        payload["reason_codes"] = [
            "broker_mutation_recovery_expired",
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
        payload["recovery_degraded"] = True
    payload.update(
        database_status="current",
        receipt_state_counts={
            state: state_counts.get(state, 0)
            for state in ("claimed", "released", "broker_io", "settled")
        },
        recovery_resolution_state_counts={
            state: resolution_state_counts.get(state, 0)
            for state in (
                "claimed",
                "submitted_unknown",
                "acknowledged",
                "rejected",
                "expired",
                "manual_review",
                "validation_quarantine_closed",
            )
        },
        pre_io_receipt_count=(
            state_counts.get("claimed", 0) + state_counts.get("released", 0)
        ),
        unresolved_receipt_count=unresolved_count,
        unresolved_submit_receipt_count=unresolved_submit_count,
        unresolved_reduction_receipt_count=unresolved_reduction_count,
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
        recovery_degraded=True,
        database_status="unavailable",
        receipt_state_counts=None,
        recovery_resolution_state_counts=None,
        pre_io_receipt_count=None,
        unresolved_receipt_count=None,
        unresolved_submit_receipt_count=None,
        unresolved_reduction_receipt_count=None,
        recovery_due_receipt_count=None,
        settled_receipt_count=None,
        latest_receipt_event_at=None,
        reason_codes=[
            "broker_mutation_database_status_unavailable",
            "broker_mutation_recovery_database_status_unavailable",
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
