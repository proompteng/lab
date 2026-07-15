"""Strict Alpaca reads and terminal persistence for mutation recovery."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Literal, cast

from alpaca.common.exceptions import APIError, RetryException
from requests.exceptions import RequestException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..alpaca_client import (
    AlpacaStrictOrderLookupMalformedError,
    TorghutAlpacaClient,
)
from ..models import Execution, ExecutionOrderEvent
from .alpaca_observations import (
    alpaca_order_observation,
    alpaca_position_observation,
    optional_decimal,
)
from .broker_mutation_receipts import (
    BrokerMutationLinkedSubmissionSettlementRequest,
    BrokerMutationReceiptSnapshot,
    BrokerMutationSettlement,
    BrokerMutationSettlementRequest,
    build_broker_mutation_settlement,
    build_linked_submission_terminal_settlement,
    fingerprint_broker_endpoint,
)
from .broker_mutation_recovery_worker import (
    BrokerMutationRecoveryRouteError,
    BrokerMutationRecoveryRead,
)
from .execution import OrderExecutor
from .firewall import OrderFirewall
from .risk_reduction import (
    BrokerPositionObservation,
    RiskReductionPermitError,
    evaluate_position_reduction_recovery,
)


ALPACA_SUBMIT_RECOVERY_READ_SCHEMA_VERSION = "torghut.alpaca-submit-recovery-read.v1"
ALPACA_REDUCTION_RECOVERY_READ_SCHEMA_VERSION = (
    "torghut.alpaca-reduction-recovery-read.v1"
)
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


class AlpacaMutationRecoveryRoute:
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
    ) -> BrokerMutationRecoveryRead:
        try:
            if receipt.intent.operation == "submit_order":
                return self._observe_submit(receipt, observed_at=observed_at)
            return self._observe_reduction(receipt)
        except AlpacaStrictOrderLookupMalformedError:
            if receipt.intent.operation != "submit_order":
                return self._reduction_read(
                    receipt,
                    outcome="indeterminate",
                    reason="strict_order_lookup_malformed",
                )
            return self._indeterminate_read(
                evidence=self._evidence(
                    exact_lookup="malformed",
                    history_count=0,
                    history_complete=False,
                    match_count=0,
                ),
                reason="exact_client_order_lookup_malformed",
            )
        except (
            APIError,
            RetryException,
            RequestException,
            OSError,
            TimeoutError,
        ) as exc:
            raise BrokerMutationRecoveryRouteError(
                f"alpaca_mutation_recovery_read_failed:{type(exc).__name__}"
            ) from exc

    def _observe_submit(
        self,
        receipt: BrokerMutationReceiptSnapshot,
        *,
        observed_at: datetime,
    ) -> BrokerMutationRecoveryRead:
        client_order_id = receipt.intent.client_request_id
        exact = self._client.get_order_by_client_order_id_strict(client_order_id)
        if exact is not None:
            return self._found_read(
                receipt,
                order=exact,
                evidence=self._evidence(
                    exact_lookup="found",
                    history_count=0,
                    history_complete=False,
                    match_count=1,
                ),
            )

        started_at = receipt.lifecycle.broker_io_started_at
        if started_at is None:
            return self._indeterminate_read(
                evidence=self._evidence(
                    exact_lookup="not_found",
                    history_count=0,
                    history_complete=False,
                    match_count=0,
                ),
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
                evidence=self._evidence(
                    exact_lookup="not_found",
                    history_count=len(history.orders),
                    history_complete=history.complete,
                    match_count=1,
                ),
            )
        if len(matches) > 1 or len(broker_ids) > 1:
            return self._indeterminate_read(
                evidence=self._evidence(
                    exact_lookup="not_found",
                    history_count=len(history.orders),
                    history_complete=history.complete,
                    match_count=len(matches),
                ),
                reason="conflicting_client_order_history",
            )
        evidence = self._evidence(
            exact_lookup="not_found",
            history_count=len(history.orders),
            history_complete=history.complete,
            match_count=0,
        )
        return BrokerMutationRecoveryRead(
            outcome="not_found" if history.complete else "indeterminate",
            evidence=evidence,
        )

    def _observe_reduction(
        self,
        receipt: BrokerMutationReceiptSnapshot,
    ) -> BrokerMutationRecoveryRead:
        try:
            operation = receipt.intent.operation
            if operation == "cancel_order":
                return self._observe_cancel_order(receipt)
            if operation == "cancel_all_orders":
                return self._observe_cancel_all_orders(receipt)
            if operation == "replace_order":
                return self._observe_replace_order(receipt)
            if operation in {"close_position", "close_all_positions"}:
                return self._observe_position_reduction(receipt)
            return self._reduction_read(
                receipt,
                outcome="indeterminate",
                reason="recovery_operation_unsupported",
            )
        except (RiskReductionPermitError, ValueError) as exc:
            return self._reduction_read(
                receipt,
                outcome="indeterminate",
                reason=str(exc) or type(exc).__name__,
            )

    def _observe_cancel_order(
        self,
        receipt: BrokerMutationReceiptSnapshot,
    ) -> BrokerMutationRecoveryRead:
        order_id = receipt.intent.target.key
        raw = self._client.get_order_by_id_strict(order_id)
        if raw is None:
            return self._reduction_read(
                receipt,
                outcome="found",
                reason="target_order_absent",
                payload={"broker_reference": order_id, "status": "absent"},
            )
        order = alpaca_order_observation(raw)
        if order.order_id != order_id:
            raise ValueError("alpaca_cancel_recovery_order_identity_mismatch")
        if order.open:
            return self._reduction_read(
                receipt,
                outcome="not_found",
                reason="target_order_still_open",
                payload={"broker_status": order.status},
            )
        return self._reduction_read(
            receipt,
            outcome="found",
            reason="target_order_terminal",
            payload={
                "broker_reference": order.order_id,
                "status": order.status,
            },
        )

    def _observe_cancel_all_orders(
        self,
        receipt: BrokerMutationReceiptSnapshot,
    ) -> BrokerMutationRecoveryRead:
        request = _broker_request(receipt)
        target_ids = _required_string_set(
            request.get("target_order_ids"),
            field="target_order_ids",
        )
        raw_open = self._client.list_orders(status="open", limit=_HISTORY_LIMIT)
        if len(raw_open) >= _HISTORY_LIMIT:
            return self._reduction_read(
                receipt,
                outcome="indeterminate",
                reason="open_order_snapshot_incomplete",
                payload={"open_order_count": len(raw_open)},
            )
        observed_orders = tuple(alpaca_order_observation(order) for order in raw_open)
        observed_ids = [order.order_id for order in observed_orders]
        if len(set(observed_ids)) != len(observed_ids):
            raise ValueError("alpaca_cancel_all_recovery_duplicate_order_id")
        open_ids = {order.order_id for order in observed_orders if order.open}
        remaining = sorted(target_ids & open_ids)
        if remaining:
            return self._reduction_read(
                receipt,
                outcome="not_found",
                reason="sealed_orders_still_open",
                payload={"remaining_target_order_ids": remaining},
            )
        return self._reduction_read(
            receipt,
            outcome="found",
            reason="sealed_orders_absent",
            payload={
                "broker_reference": receipt.intent.target.key,
                "target_order_ids": sorted(target_ids),
            },
        )

    def _observe_replace_order(
        self,
        receipt: BrokerMutationReceiptSnapshot,
    ) -> BrokerMutationRecoveryRead:
        original_id = receipt.intent.target.key
        original = self._client.get_order_by_id_strict(original_id)
        if original is None:
            return self._reduction_read(
                receipt,
                outcome="indeterminate",
                reason="original_order_absent_without_replacement_identity",
            )
        original_observation = alpaca_order_observation(original)
        if original_observation.order_id != original_id:
            raise ValueError("alpaca_replace_recovery_order_identity_mismatch")
        if original_observation.status != "replaced":
            outcome = "not_found" if original_observation.open else "indeterminate"
            return self._reduction_read(
                receipt,
                outcome=outcome,
                reason=(
                    "original_order_still_open"
                    if original_observation.open
                    else "original_order_terminal_without_replacement"
                ),
                payload={"broker_status": original_observation.status},
            )
        replacement_id = _text(original.get("replaced_by"))
        if not replacement_id:
            return self._reduction_read(
                receipt,
                outcome="indeterminate",
                reason="replacement_identity_missing",
            )
        replacement = self._client.get_order_by_id_strict(replacement_id)
        if replacement is None:
            return self._reduction_read(
                receipt,
                outcome="indeterminate",
                reason="replacement_order_absent",
            )
        _validate_alpaca_replacement(receipt, original_id, replacement)
        return self._reduction_read(
            receipt,
            outcome="found",
            reason="replacement_observed",
            payload={
                "broker_reference": replacement_id,
                "original_order_id": original_id,
                "status": _text(replacement.get("status")),
            },
        )

    def _observe_position_reduction(
        self,
        receipt: BrokerMutationReceiptSnapshot,
    ) -> BrokerMutationRecoveryRead:
        current = self._current_positions()
        evaluation = evaluate_position_reduction_recovery(
            _risk_reduction_evidence(receipt),
            current,
            operation=receipt.intent.operation,
            target_key=receipt.intent.target.key,
        )
        current_quantities = {
            position.symbol: str(position.signed_quantity) for position in current
        }
        outcome: Literal["found", "not_found", "indeterminate"]
        if evaluation.outcome == "resolved":
            outcome = "found"
        elif evaluation.outcome == "unresolved":
            outcome = "not_found"
        else:
            outcome = "indeterminate"
        return self._reduction_read(
            receipt,
            outcome=outcome,
            reason=evaluation.reason,
            payload={
                "current_positions": current_quantities,
                **(
                    {
                        "broker_reference": receipt.intent.target.key,
                        "status": "reduced",
                    }
                    if outcome == "found"
                    else {}
                ),
            },
        )

    def _current_positions(self) -> tuple[BrokerPositionObservation, ...]:
        positions: list[BrokerPositionObservation] = []
        for raw in self._client.list_positions():
            positions.append(alpaca_position_observation(raw))
        return tuple(positions)

    def _reduction_read(
        self,
        receipt: BrokerMutationReceiptSnapshot,
        *,
        outcome: Literal["found", "not_found", "indeterminate"],
        reason: str,
        payload: Mapping[str, object] | None = None,
    ) -> BrokerMutationRecoveryRead:
        result_payload = dict(payload or {})
        return BrokerMutationRecoveryRead(
            outcome=outcome,
            broker_result=result_payload if outcome == "found" and payload else None,
            evidence={
                "schema_version": ALPACA_REDUCTION_RECOVERY_READ_SCHEMA_VERSION,
                "route": self.broker_route,
                "operation": receipt.intent.operation,
                "target_key": receipt.intent.target.key,
                "reason": reason,
                "absence_proof_complete": False,
                **result_payload,
            },
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
        read: BrokerMutationRecoveryRead,
    ) -> BrokerMutationSettlement:
        if receipt.intent.operation != "submit_order":
            return self._build_reduction_settlement(receipt, read)
        order = read.broker_result
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
                claim_handle=claim_handle,
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

    def _build_reduction_settlement(
        self,
        receipt: BrokerMutationReceiptSnapshot,
        read: BrokerMutationRecoveryRead,
    ) -> BrokerMutationSettlement:
        result = read.broker_result
        if not isinstance(result, Mapping):
            raise ValueError("alpaca_reduction_recovery_result_required")
        broker_reference = _text(result.get("broker_reference"))
        if not broker_reference:
            raise ValueError("alpaca_reduction_recovery_reference_required")
        return build_broker_mutation_settlement(
            BrokerMutationSettlementRequest(
                source="recovery",
                outcome="reconciled",
                broker_reference=broker_reference,
                execution_id=None,
                evidence_payload={
                    "schema_version": ALPACA_REDUCTION_RECOVERY_READ_SCHEMA_VERSION,
                    "route": self.broker_route,
                    "operation": receipt.intent.operation,
                    "target_key": receipt.intent.target.key,
                    "observation": dict(read.evidence),
                    "broker_result": dict(result),
                    "automatic_broker_mutation_attempted": False,
                },
            )
        )

    def _found_read(
        self,
        receipt: BrokerMutationReceiptSnapshot,
        *,
        order: Mapping[str, object],
        evidence: Mapping[str, object],
    ) -> BrokerMutationRecoveryRead:
        try:
            normalized = _validated_alpaca_order(receipt, order)
        except ValueError as exc:
            return self._indeterminate_read(
                evidence=evidence,
                reason=str(exc),
            )
        return BrokerMutationRecoveryRead(
            outcome="found",
            broker_result=order,
            evidence={
                **dict(evidence),
                "broker_status": normalized["status"],
                "broker_reference": normalized["broker_reference"],
                "submission_resolution": normalized["submission_resolution"],
            },
        )

    def _indeterminate_read(
        self,
        *,
        evidence: Mapping[str, object],
        reason: str,
    ) -> BrokerMutationRecoveryRead:
        return BrokerMutationRecoveryRead(
            outcome="indeterminate",
            evidence={
                **dict(evidence),
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


def _required_string_set(value: object, *, field: str) -> set[str]:
    if not isinstance(value, list):
        raise ValueError(f"alpaca_recovery_{field}_invalid")
    normalized = {_text(item) for item in cast(list[object], value)}
    if not normalized or "" in normalized:
        raise ValueError(f"alpaca_recovery_{field}_invalid")
    return normalized


def _risk_reduction_evidence(
    receipt: BrokerMutationReceiptSnapshot,
) -> Mapping[str, object]:
    request = _intent_request(receipt)
    evidence = request.get("risk_reduction")
    if not isinstance(evidence, dict):
        raise ValueError("alpaca_recovery_risk_reduction_evidence_invalid")
    evidence_map = cast(dict[str, object], evidence)
    if evidence_map.get("broker_route") != "alpaca":
        raise ValueError("alpaca_recovery_risk_reduction_route_mismatch")
    if evidence_map.get("target_key") != receipt.intent.target.key:
        raise ValueError("alpaca_recovery_risk_reduction_target_mismatch")
    return evidence_map


def _validate_alpaca_replacement(
    receipt: BrokerMutationReceiptSnapshot,
    original_id: str,
    replacement: Mapping[str, object],
) -> None:
    request = _broker_request(receipt)
    desired_limit = optional_decimal(request.get("limit_price"))
    if desired_limit is None or desired_limit <= 0:
        raise ValueError("alpaca_replace_recovery_limit_price_invalid")
    evidence = _risk_reduction_evidence(receipt)
    action = evidence.get("action")
    if not isinstance(action, dict):
        raise ValueError("alpaca_replace_recovery_action_invalid")
    action_map = cast(dict[str, object], action)
    causal_order = action_map.get("causal_order")
    if not isinstance(causal_order, dict):
        raise ValueError("alpaca_replace_recovery_causal_order_invalid")
    causal = cast(dict[str, object], causal_order)
    expected_quantity = optional_decimal(action_map.get("quantity"))
    if expected_quantity is None or expected_quantity <= 0:
        raise ValueError("alpaca_replace_recovery_quantity_invalid")

    observed = alpaca_order_observation(replacement)
    if observed.symbol != _text(causal.get("symbol")).upper():
        raise ValueError("alpaca_replace_recovery_symbol_mismatch")
    if observed.side != _text(causal.get("side")).lower():
        raise ValueError("alpaca_replace_recovery_side_mismatch")
    if observed.remaining_quantity > expected_quantity:
        raise ValueError("alpaca_replace_recovery_quantity_increased")
    if optional_decimal(replacement.get("limit_price")) != desired_limit:
        raise ValueError("alpaca_replace_recovery_limit_price_mismatch")
    replaces = _text(replacement.get("replaces"))
    if replaces and replaces != original_id:
        raise ValueError("alpaca_replace_recovery_causal_identity_mismatch")
    if not observed.open and observed.status != "filled":
        raise ValueError("alpaca_replace_recovery_status_invalid")


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


def _intent_request(receipt: BrokerMutationReceiptSnapshot) -> Mapping[str, object]:
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
    return cast(dict[str, object], request)


def _broker_request(receipt: BrokerMutationReceiptSnapshot) -> Mapping[str, object]:
    request = _intent_request(receipt)
    nested = request.get("broker_request")
    if isinstance(nested, dict):
        return cast(dict[str, object], nested)
    return request


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
    "AlpacaMutationRecoveryRoute",
]
