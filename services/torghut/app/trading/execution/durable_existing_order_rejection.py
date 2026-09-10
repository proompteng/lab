"""Decision-state staging for durable existing-order rejection recovery."""

from __future__ import annotations

from sqlalchemy.orm import Session

from ...models import TradeDecision
from .order_executor_core_support import (
    coerce_json,
    coerce_string_list,
    merge_unique_strings,
    normalize_reject_reasons,
)


_BROKER_REJECTED_REASON = "broker_rejected"


def stage_broker_rejected_decision(
    session: Session,
    *,
    decision_row: TradeDecision,
    account_label: str,
) -> None:
    """Stage durable broker-rejection metadata without committing the session."""

    decision_json = coerce_json(decision_row.decision_json)
    decision_json["submission_stage"] = "rejected"
    decision_json["risk_reasons"] = merge_unique_strings(
        coerce_string_list(decision_json.get("risk_reasons")),
        [_BROKER_REJECTED_REASON],
    )
    normalized_reasons = normalize_reject_reasons(_BROKER_REJECTED_REASON)
    reject_atomic = merge_unique_strings(
        coerce_string_list(decision_json.get("reject_reason_atomic")),
        [normalized.atomic_reason for normalized in normalized_reasons],
    )
    if reject_atomic:
        primary = normalized_reasons[0]
        decision_json["reject_reason_atomic"] = reject_atomic
        decision_json["reject_class"] = primary.reject_class
        decision_json["reject_origin"] = primary.reject_origin
    decision_row.status = "rejected"
    decision_row.alpaca_account_label = account_label
    decision_row.decision_json = decision_json
    session.add(decision_row)


__all__ = ["stage_broker_rejected_decision"]
