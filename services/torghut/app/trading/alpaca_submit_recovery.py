"""Strict Alpaca reads and terminal persistence for submit recovery."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import cast

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..alpaca_client import TorghutAlpacaClient
from ..models import Execution, ExecutionOrderEvent
from .broker_mutation_receipts import (
    BrokerMutationLinkedSubmissionSettlementRequest,
    BrokerMutationReceiptSnapshot,
    BrokerMutationSettlement,
    BrokerMutationSettlementRequest,
    build_broker_mutation_settlement,
    build_linked_submission_terminal_settlement,
    fingerprint_broker_endpoint,
)
from .broker_mutation_recovery_worker import BrokerSubmitRecoveryRead
from .execution import OrderExecutor
from .firewall import OrderFirewall


ALPACA_SUBMIT_RECOVERY_READ_SCHEMA_VERSION = "torghut.alpaca-submit-recovery-read.v1"
_HISTORY_LIMIT = 500
_HISTORY_PRE_IO_MARGIN = timedelta(minutes=5)
_STABLE_STATUS = re.compile(r"^[a-z0-9][a-z0-9_.:-]*$")
_ALPACA_ACKNOWLEDGED_ORDER_STATUSES = frozenset(
    {
        "accepted",
        "accepted_for_bidding",
        "calculated",
        "canceled",
        "done_for_day",
        "expired",
        "filled",
        "held",
        "new",
        "partially_filled",
        "pending_cancel",
        "pending_new",
        "pending_replace",
        "pending_review",
        "replaced",
        "stopped",
        "suspended",
    }
)
_ALPACA_REJECTED_ORDER_STATUSES = frozenset({"rejected"})


class AlpacaSubmitRecoveryRoute:
    """Alpaca recovery route that has no broker-mutation surface."""

    broker_route = "alpaca"

    def __init__(
        self,
        *,
        client: TorghutAlpacaClient,
        firewall: OrderFirewall,
        executor: OrderExecutor,
        account_label: str,
        endpoint_url: str,
    ) -> None:
        self._client = client
        self._firewall = firewall
        self._executor = executor
        self._account_label = account_label.strip()
        self._endpoint_fingerprint = fingerprint_broker_endpoint(endpoint_url)
        if not self._account_label:
            raise ValueError("alpaca_recovery_account_label_required")

    @property
    def account_label(self) -> str:
        return self._account_label

    @property
    def endpoint_fingerprint(self) -> str:
        return self._endpoint_fingerprint

    def observe(
        self,
        receipt: BrokerMutationReceiptSnapshot,
        *,
        observed_at: datetime,
    ) -> BrokerSubmitRecoveryRead:
        client_order_id = receipt.intent.client_request_id
        exact = self._client.get_order_by_client_order_id_strict(client_order_id)
        if exact is not None:
            return self._found_read(
                receipt,
                order=exact,
                exact_lookup="found",
                history_count=0,
                history_complete=False,
            )

        started_at = receipt.lifecycle.broker_io_started_at
        if started_at is None:
            return self._indeterminate_read(
                exact_lookup="not_found",
                history_count=0,
                history_complete=False,
                reason="broker_io_started_at_missing",
            )
        history = self._client.list_orders_recovery_window(
            after=started_at - _HISTORY_PRE_IO_MARGIN,
            until=observed_at,
            limit=_HISTORY_LIMIT,
        )
        matches = tuple(
            order
            for order in history.orders
            if _text(order.get("client_order_id")) == client_order_id
        )
        broker_ids = {
            _text(order.get("id") or order.get("order_id")) for order in matches
        }
        broker_ids.discard("")
        if len(matches) == 1 and len(broker_ids) == 1:
            return self._found_read(
                receipt,
                order=matches[0],
                exact_lookup="not_found",
                history_count=len(history.orders),
                history_complete=history.complete,
            )
        if len(matches) > 1 or len(broker_ids) > 1:
            return self._indeterminate_read(
                exact_lookup="not_found",
                history_count=len(history.orders),
                history_complete=history.complete,
                reason="conflicting_client_order_history",
                match_count=len(matches),
            )
        evidence = self._evidence(
            exact_lookup="not_found",
            history_count=len(history.orders),
            history_complete=history.complete,
            match_count=0,
        )
        return BrokerSubmitRecoveryRead(
            outcome="not_found" if history.complete else "indeterminate",
            evidence=evidence,
        )

    def independent_activity(
        self,
        session: Session,
        receipt: BrokerMutationReceiptSnapshot,
    ) -> tuple[str, ...]:
        client_order_id = receipt.intent.client_request_id
        activity: list[str] = []
        execution_count = session.execute(
            select(func.count())
            .select_from(Execution)
            .where(
                Execution.alpaca_account_label == receipt.intent.account_label,
                Execution.client_order_id == client_order_id,
            )
        ).scalar_one()
        if int(execution_count) > 0:
            activity.append("execution")
        order_event_count = session.execute(
            select(func.count())
            .select_from(ExecutionOrderEvent)
            .where(
                ExecutionOrderEvent.alpaca_account_label
                == receipt.intent.account_label,
                ExecutionOrderEvent.client_order_id == client_order_id,
            )
        ).scalar_one()
        if int(order_event_count) > 0:
            activity.append("order_feed_event")
        return tuple(activity)

    def build_found_settlement(
        self,
        session: Session,
        receipt: BrokerMutationReceiptSnapshot,
        read: BrokerSubmitRecoveryRead,
    ) -> BrokerMutationSettlement:
        order = read.broker_order
        if not isinstance(order, Mapping):
            raise ValueError("alpaca_recovery_found_order_required")
        normalized = _validated_alpaca_order(receipt, order)
        broker_status = cast(str, normalized["status"])
        broker_reference = cast(str, normalized["broker_reference"])
        submission_resolution = cast(str, normalized["submission_resolution"])
        recovery_evidence = {
            "schema_version": ALPACA_SUBMIT_RECOVERY_READ_SCHEMA_VERSION,
            "resolution_state": submission_resolution,
            "observation": dict(read.evidence),
            "automatic_resubmission_attempted": False,
        }
        claim_handle = receipt.submission_claim_handle
        if claim_handle is not None:
            if submission_resolution == "rejected":
                return build_linked_submission_terminal_settlement(
                    BrokerMutationLinkedSubmissionSettlementRequest(
                        source="recovery",
                        outcome="rejected",
                        claim_handle=claim_handle,
                        broker_status=broker_status,
                        rejection_code="broker_rejected",
                        broker_reference=None,
                        execution_id=None,
                        recovery_evidence_payload=recovery_evidence,
                    )
                )
            execution = self._executor.recover_linked_order_submission(
                session=session,
                execution_client=self._firewall,
                decision_id=claim_handle.decision_id,
                account_label=receipt.intent.account_label,
                order_response=order,
            )
            return build_linked_submission_terminal_settlement(
                BrokerMutationLinkedSubmissionSettlementRequest(
                    source="recovery",
                    outcome="reconciled",
                    claim_handle=claim_handle,
                    broker_status=broker_status,
                    rejection_code=None,
                    broker_reference=broker_reference,
                    execution_id=execution.id,
                    recovery_evidence_payload=recovery_evidence,
                )
            )
        return build_broker_mutation_settlement(
            BrokerMutationSettlementRequest(
                source="recovery",
                outcome=(
                    "rejected" if submission_resolution == "rejected" else "reconciled"
                ),
                broker_reference=broker_reference,
                execution_id=None,
                evidence_payload={
                    "route": self.broker_route,
                    "client_order_id": receipt.intent.client_request_id,
                    "broker_status": broker_status,
                    **recovery_evidence,
                },
            )
        )

    def _found_read(
        self,
        receipt: BrokerMutationReceiptSnapshot,
        *,
        order: Mapping[str, object],
        exact_lookup: str,
        history_count: int,
        history_complete: bool,
    ) -> BrokerSubmitRecoveryRead:
        try:
            normalized = _validated_alpaca_order(receipt, order)
        except ValueError as exc:
            return self._indeterminate_read(
                exact_lookup=exact_lookup,
                history_count=history_count,
                history_complete=history_complete,
                reason=str(exc),
                match_count=1,
            )
        return BrokerSubmitRecoveryRead(
            outcome="found",
            broker_order=order,
            evidence={
                **self._evidence(
                    exact_lookup=exact_lookup,
                    history_count=history_count,
                    history_complete=history_complete,
                    match_count=1,
                ),
                "broker_status": normalized["status"],
                "broker_reference": normalized["broker_reference"],
                "submission_resolution": normalized["submission_resolution"],
            },
        )

    def _indeterminate_read(
        self,
        *,
        exact_lookup: str,
        history_count: int,
        history_complete: bool,
        reason: str,
        match_count: int = 0,
    ) -> BrokerSubmitRecoveryRead:
        return BrokerSubmitRecoveryRead(
            outcome="indeterminate",
            evidence={
                **self._evidence(
                    exact_lookup=exact_lookup,
                    history_count=history_count,
                    history_complete=history_complete,
                    match_count=match_count,
                ),
                "reason": reason,
                "absence_proof_complete": False,
            },
        )

    @staticmethod
    def _evidence(
        *,
        exact_lookup: str,
        history_count: int,
        history_complete: bool,
        match_count: int,
    ) -> dict[str, object]:
        return {
            "schema_version": ALPACA_SUBMIT_RECOVERY_READ_SCHEMA_VERSION,
            "route": "alpaca",
            "exact_client_order_lookup": exact_lookup,
            "history_status": "all",
            "history_limit": _HISTORY_LIMIT,
            "history_count": history_count,
            "history_complete": history_complete,
            "history_match_count": match_count,
            "absence_proof_complete": (
                exact_lookup == "not_found" and history_complete and match_count == 0
            ),
        }


def _validated_alpaca_order(
    receipt: BrokerMutationReceiptSnapshot,
    order: Mapping[str, object],
) -> dict[str, object]:
    request = _broker_request(receipt)
    expected = {
        "client_order_id": receipt.intent.client_request_id,
        "symbol": _text(request.get("symbol")).upper(),
        "side": _text(request.get("side")).lower(),
        "qty": _decimal(request.get("qty"), field="request_qty"),
        "order_type": _text(request.get("order_type") or request.get("type")).lower(),
        "time_in_force": _text(request.get("time_in_force")).lower(),
        "limit_price": _optional_decimal(request.get("limit_price")),
        "stop_price": _optional_decimal(request.get("stop_price")),
    }
    actual = {
        "client_order_id": _text(order.get("client_order_id")),
        "symbol": _text(order.get("symbol")).upper(),
        "side": _text(order.get("side")).lower(),
        "qty": _decimal(order.get("qty"), field="order_qty"),
        "order_type": _text(order.get("type") or order.get("order_type")).lower(),
        "time_in_force": _text(order.get("time_in_force")).lower(),
        "limit_price": _optional_decimal(order.get("limit_price")),
        "stop_price": _optional_decimal(order.get("stop_price")),
    }
    for field, expected_value in expected.items():
        if actual[field] != expected_value:
            raise ValueError(f"alpaca_recovery_order_{field}_mismatch")
    broker_reference = _text(order.get("id") or order.get("order_id"))
    if not broker_reference:
        raise ValueError("alpaca_recovery_order_broker_reference_missing")
    status = _text(order.get("status")).lower().replace(" ", "_")
    if not status or _STABLE_STATUS.fullmatch(status) is None:
        raise ValueError("alpaca_recovery_order_status_invalid")
    if status in _ALPACA_ACKNOWLEDGED_ORDER_STATUSES:
        submission_resolution = "acknowledged"
    elif status in _ALPACA_REJECTED_ORDER_STATUSES:
        submission_resolution = "rejected"
    else:
        raise ValueError("alpaca_recovery_order_status_unknown")
    return {
        "broker_reference": broker_reference,
        "status": status,
        "submission_resolution": submission_resolution,
    }


def _broker_request(receipt: BrokerMutationReceiptSnapshot) -> Mapping[str, object]:
    try:
        document = json.loads(receipt.intent.canonical_intent_json)
    except (TypeError, ValueError) as exc:  # pragma: no cover - receipt verifier
        raise ValueError("alpaca_recovery_intent_invalid") from exc
    if not isinstance(document, dict):
        raise ValueError("alpaca_recovery_intent_invalid")
    payload = cast(dict[str, object], document)
    request = payload.get("request")
    if not isinstance(request, dict):
        raise ValueError("alpaca_recovery_request_invalid")
    nested = cast(dict[str, object], request).get("broker_request")
    if isinstance(nested, dict):
        return cast(dict[str, object], nested)
    return cast(dict[str, object], request)


def _text(value: object) -> str:
    enum_value = getattr(value, "value", value)
    return "" if enum_value is None else str(enum_value).strip()


def _decimal(value: object, *, field: str) -> Decimal:
    parsed = _optional_decimal(value)
    if parsed is None:
        raise ValueError(f"alpaca_recovery_{field}_invalid")
    return parsed


def _optional_decimal(value: object) -> Decimal | None:
    if value is None or str(value).strip() == "":
        return None
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError("alpaca_recovery_decimal_invalid") from exc
    if not parsed.is_finite():
        raise ValueError("alpaca_recovery_decimal_invalid")
    return parsed


__all__ = [
    "ALPACA_SUBMIT_RECOVERY_READ_SCHEMA_VERSION",
    "AlpacaSubmitRecoveryRoute",
]
