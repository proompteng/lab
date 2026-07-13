"""Transaction-local materialization of validated Alpaca recovery evidence.

Recovery is deliberately split into three boundaries:

* :mod:`alpaca_recovery_observation` validates an untrusted broker response;
* this module turns only that validated, quantity-based observation into one
  ``Execution`` row; and
* the recovery worker (a later slice) settles the paired claim and receipt.

This module does not perform broker I/O, mutate a receipt, advance a claim, or
commit the caller's transaction.  Keeping those boundaries separate is what
prevents an indeterminate response from being turned into a broker order or a
terminal execution record.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import cast

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from ...models import (
    Execution,
    TradeDecision,
    TradeDecisionSubmissionClaim,
    coerce_json_payload,
)
from ..broker_mutation_receipts import BrokerMutationIntent
from ..broker_mutation_receipts.canonicalization import verify_broker_mutation_intent
from ..broker_mutation_receipts.persistence import (
    broker_mutation_identity_lock_keys,
    lock_broker_mutation_identities,
)
from ..broker_mutation_receipts.validation import BrokerMutationReceiptValidationError
from .alpaca_recovery_observation import (
    AlpacaOrderTerms,
    AlpacaRecoveryObservation,
    AlpacaRecoveryObservationOutcome,
    ValidatedAlpacaRecoveryOrder,
    validate_alpaca_recovery_observation,
)


_NUMERIC_PRECISION = 20
_NUMERIC_SCALE = 8
_MATERIALIZATION_IDENTITY_SCHEMA = "torghut.execution-recovery-materialization.v1"
_MATERIALIZATION_AUDIT_KEY = "recovery_materialization"

_STATUS_PHASE: dict[str, int] = {
    "pending_new": 0,
    "new": 1,
    "accepted": 1,
    "accepted_for_bidding": 1,
    "held": 1,
    "pending_review": 1,
    "partially_filled": 2,
    "pending_cancel": 2,
    "pending_replace": 2,
    "done_for_day": 3,
    "canceled": 3,
    "expired": 3,
    "replaced": 3,
    "stopped": 3,
    "rejected": 3,
    "suspended": 3,
    "calculated": 3,
    "filled": 4,
}
_TERMINAL_STATUSES = frozenset(
    {
        "calculated",
        "canceled",
        "done_for_day",
        "expired",
        "filled",
        "rejected",
        "replaced",
        "stopped",
        "suspended",
    }
)
_ZERO_FILL_STATUSES = frozenset(
    {
        "accepted",
        "accepted_for_bidding",
        "held",
        "new",
        "pending_new",
        "pending_review",
        "rejected",
    }
)


class RecoveryMaterializationError(ValueError):
    """Base error for fail-closed recovery materialization."""


class RecoveryMaterializationIdentityConflict(RecoveryMaterializationError):
    """The observation or persisted row conflicts with canonical identity."""


class RecoveryMaterializationLifecycleConflict(RecoveryMaterializationError):
    """The observation would move an execution backwards or corrupt fills."""


@dataclass(frozen=True, slots=True)
class RecoveryMaterializationIdentity:  # pylint: disable=too-many-instance-attributes
    """Immutable identity attached to every row materialized by this module."""

    trade_decision_id: uuid.UUID
    account_label: str
    client_order_id: str
    broker_order_id: str
    symbol: str
    side: str
    submitted_qty: Decimal
    order_type: str
    time_in_force: str
    order_class: str
    position_intent: str | None
    extended_hours: bool
    limit_price: Decimal | None
    stop_price: Decimal | None
    trail_price: Decimal | None
    trail_percent: Decimal | None


def materialize_validated_alpaca_recovery(
    session: Session,
    *,
    intent: BrokerMutationIntent,
    observation: object,
) -> Execution:
    """Stage one execution from one validated, quantity-only Alpaca observation.

    The caller owns the transaction.  The function locks every broker and
    decision identity, locks the matching rows, then flushes the insert/update
    without committing.  An indeterminate observation, notional request,
    complex order, forged observation, identity mismatch, or lifecycle
    regression raises before an execution ID can be allocated.
    """

    order = _validated_observation(intent=intent, observation=observation)
    decision_id = _validated_intent(intent)

    # The lock keys are transaction-scoped on PostgreSQL.  They also document
    # the exact identity that must be serialized before the row lookups below.
    lock_broker_mutation_identities(session, broker_mutation_identity_lock_keys(intent))

    decision = _lock_decision(session, decision_id)
    _verify_decision_identity(decision, order=order, intent=intent)
    claim = _lock_submission_claim(session, decision_id)
    _verify_claim_identity(claim, order=order, intent=intent)

    existing = _lock_existing_execution(
        session,
        account_label=order.account_label,
        broker_order_id=order.broker_order_id,
        client_order_id=order.client_order_id,
    )
    _verify_claim_execution_identity(claim, existing=existing)
    identity = _materialization_identity(
        decision_id=decision_id,
        account_label=order.account_label,
        order=order,
    )
    state = _materialization_state(order)
    payload = _execution_payload(identity=identity, state=state, order=order)

    if existing is not None:
        _require_existing_identity(existing, identity=identity)
        _require_existing_state(existing, incoming=state)
        _merge_existing_payload(existing, payload)
        session.add(existing)
        session.flush()
        return existing

    # The UUID is allocated only after all evidence, identity, claim, and
    # decision checks pass.  An INDETERMINATE observation can never reach here.
    execution = Execution(id=uuid.uuid4(), **payload)
    session.add(execution)
    session.flush()
    return execution


def materialize_alpaca_recovery_observation(
    session: Session,
    observation: object,
    *,
    intent: BrokerMutationIntent,
) -> Execution:
    """Positional-observation compatibility wrapper for the strict API."""

    return materialize_validated_alpaca_recovery(
        session,
        intent=intent,
        observation=observation,
    )


def _validated_intent(intent: BrokerMutationIntent) -> uuid.UUID:
    try:
        verify_broker_mutation_intent(intent)
    except (
        BrokerMutationReceiptValidationError,
        AttributeError,
        TypeError,
        ValueError,
    ) as exc:
        raise RecoveryMaterializationIdentityConflict(
            "recovery_intent_invalid"
        ) from exc
    if (
        intent.broker_route != "alpaca"
        or intent.operation != "submit_order"
        or intent.target.kind != "order"
        or intent.target.key != intent.client_request_id
        or intent.submission_claim_id is None
    ):
        raise RecoveryMaterializationIdentityConflict("recovery_intent_linkage_invalid")
    return intent.submission_claim_id


def _validated_observation(
    *,
    intent: BrokerMutationIntent,
    observation: object,
) -> ValidatedAlpacaRecoveryOrder:
    if not isinstance(observation, AlpacaRecoveryObservation):
        raise RecoveryMaterializationError("recovery_observation_invalid")
    if observation.outcome is not AlpacaRecoveryObservationOutcome.VALIDATED:
        raise RecoveryMaterializationError("recovery_observation_not_validated")
    order = observation.order
    if not isinstance(order, ValidatedAlpacaRecoveryOrder):
        raise RecoveryMaterializationError("recovery_observation_order_missing")

    # Re-run the public validator against the normalized order.  Dataclasses
    # are intentionally not treated as an unforgeable capability: this check
    # ensures a caller cannot hand us a manually constructed VALIDATED object
    # whose terms differ from the canonical intent.
    result = validate_alpaca_recovery_observation(
        intent=intent,
        account_label=order.account_label,
        expected_broker_order_id=order.broker_order_id,
        broker_order=_broker_payload(order),
    )
    if not result.validated or result.order != order:
        raise RecoveryMaterializationIdentityConflict(
            "recovery_observation_identity_invalid"
        )
    return order


def _broker_payload(order: ValidatedAlpacaRecoveryOrder) -> dict[str, object]:
    terms = order.terms
    return {
        "id": order.broker_order_id,
        "client_order_id": order.client_order_id,
        "alpaca_account_label": order.account_label,
        "symbol": terms.symbol,
        "side": terms.side,
        "qty": terms.qty,
        "notional": None,
        "type": terms.order_type,
        "time_in_force": terms.time_in_force,
        "limit_price": terms.limit_price,
        "stop_price": terms.stop_price,
        "trail_price": terms.trail_price,
        "trail_percent": terms.trail_percent,
        "order_class": terms.order_class,
        "position_intent": terms.position_intent,
        "extended_hours": terms.extended_hours,
        "status": order.status,
        "filled_qty": order.filled_qty,
        "filled_avg_price": order.filled_avg_price,
    }


def _lock_decision(session: Session, decision_id: uuid.UUID) -> TradeDecision:
    decision = session.execute(
        select(TradeDecision)
        .where(TradeDecision.id == decision_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()
    if decision is None:
        raise RecoveryMaterializationIdentityConflict("recovery_decision_not_found")
    return decision


def _lock_submission_claim(
    session: Session,
    decision_id: uuid.UUID,
) -> TradeDecisionSubmissionClaim:
    claim = session.execute(
        select(TradeDecisionSubmissionClaim)
        .where(TradeDecisionSubmissionClaim.trade_decision_id == decision_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()
    if claim is None:
        raise RecoveryMaterializationIdentityConflict(
            "recovery_submission_claim_not_found"
        )
    if claim.state not in {"broker_io", "submitted"}:
        raise RecoveryMaterializationIdentityConflict(
            f"recovery_submission_claim_state_invalid:{claim.state}"
        )
    return claim


def _verify_decision_identity(
    decision: TradeDecision,
    *,
    order: ValidatedAlpacaRecoveryOrder,
    intent: BrokerMutationIntent,
) -> None:
    if decision.alpaca_account_label != intent.account_label:
        raise RecoveryMaterializationIdentityConflict(
            "recovery_decision_account_mismatch"
        )
    if decision.symbol.strip().upper() != order.terms.symbol:
        raise RecoveryMaterializationIdentityConflict(
            "recovery_decision_symbol_mismatch"
        )


def _verify_claim_identity(
    claim: TradeDecisionSubmissionClaim,
    *,
    order: ValidatedAlpacaRecoveryOrder,
    intent: BrokerMutationIntent,
) -> None:
    if (
        claim.account_label != intent.account_label
        or claim.client_order_id != intent.client_request_id
        or claim.client_order_id != order.client_order_id
    ):
        raise RecoveryMaterializationIdentityConflict(
            "recovery_submission_claim_identity_mismatch"
        )
    if (
        claim.broker_order_id is not None
        and claim.broker_order_id != order.broker_order_id
    ):
        raise RecoveryMaterializationIdentityConflict(
            "recovery_submission_claim_broker_order_mismatch"
        )
    if (
        claim.broker_client_order_id is not None
        and claim.broker_client_order_id != order.client_order_id
    ):
        raise RecoveryMaterializationIdentityConflict(
            "recovery_submission_claim_client_order_mismatch"
        )


def _verify_claim_execution_identity(
    claim: TradeDecisionSubmissionClaim,
    *,
    existing: Execution | None,
) -> None:
    if claim.execution_id is None:
        if claim.state == "submitted":
            raise RecoveryMaterializationIdentityConflict(
                "recovery_submitted_claim_execution_missing"
            )
        return
    if existing is None or existing.id != claim.execution_id:
        raise RecoveryMaterializationIdentityConflict(
            "recovery_submission_claim_execution_mismatch"
        )


def _lock_existing_execution(
    session: Session,
    *,
    account_label: str,
    broker_order_id: str,
    client_order_id: str,
) -> Execution | None:
    rows = list(
        session.execute(
            select(Execution)
            .where(
                or_(
                    and_(
                        Execution.alpaca_account_label == account_label,
                        Execution.alpaca_order_id == broker_order_id,
                    ),
                    and_(
                        Execution.alpaca_account_label == account_label,
                        Execution.client_order_id == client_order_id,
                    ),
                )
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        ).scalars()
    )
    if len(rows) > 1:
        raise RecoveryMaterializationIdentityConflict(
            "recovery_execution_identity_split"
        )
    return rows[0] if rows else None


def _materialization_identity(
    *,
    decision_id: uuid.UUID,
    account_label: str,
    order: ValidatedAlpacaRecoveryOrder,
) -> RecoveryMaterializationIdentity:
    terms = order.terms
    return RecoveryMaterializationIdentity(
        trade_decision_id=decision_id,
        account_label=account_label,
        client_order_id=order.client_order_id,
        broker_order_id=order.broker_order_id,
        symbol=terms.symbol,
        side=terms.side,
        submitted_qty=terms.qty,
        order_type=terms.order_type,
        time_in_force=terms.time_in_force,
        order_class=terms.order_class,
        position_intent=terms.position_intent,
        extended_hours=terms.extended_hours,
        limit_price=terms.limit_price,
        stop_price=terms.stop_price,
        trail_price=terms.trail_price,
        trail_percent=terms.trail_percent,
    )


@dataclass(frozen=True, slots=True)
class _MaterializationState:
    status: str
    submitted_qty: Decimal
    filled_qty: Decimal
    avg_fill_price: Decimal | None


def _materialization_state(
    order: ValidatedAlpacaRecoveryOrder,
) -> _MaterializationState:
    status = _bounded_status(order.status)
    submitted_qty = _numeric_decimal(
        order.terms.qty, field="submitted_qty", positive=True
    )
    filled_qty = _numeric_decimal(order.filled_qty, field="filled_qty", positive=False)
    avg_price = (
        _numeric_decimal(
            order.filled_avg_price, field="filled_avg_price", positive=True
        )
        if order.filled_avg_price is not None
        else None
    )
    if filled_qty > submitted_qty:
        raise RecoveryMaterializationLifecycleConflict(
            "filled_qty_exceeds_submitted_qty"
        )
    if filled_qty == 0 and avg_price is not None:
        raise RecoveryMaterializationLifecycleConflict(
            "filled_avg_price_forbidden_without_fills"
        )
    if filled_qty > 0 and avg_price is None:
        raise RecoveryMaterializationLifecycleConflict(
            "filled_avg_price_required_for_fills"
        )
    if status == "filled" and filled_qty != submitted_qty:
        raise RecoveryMaterializationLifecycleConflict(
            "filled_status_requires_complete_fill"
        )
    if status == "partially_filled" and not 0 < filled_qty < submitted_qty:
        raise RecoveryMaterializationLifecycleConflict(
            "partially_filled_status_requires_partial_fill"
        )
    if status in _ZERO_FILL_STATUSES and filled_qty != 0:
        raise RecoveryMaterializationLifecycleConflict(f"{status}_status_forbids_fills")
    return _MaterializationState(
        status=status,
        submitted_qty=submitted_qty,
        filled_qty=filled_qty,
        avg_fill_price=avg_price,
    )


def _bounded_status(value: object) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise RecoveryMaterializationLifecycleConflict("status_invalid")
    normalized = value.lower()
    if normalized not in _STATUS_PHASE:
        raise RecoveryMaterializationLifecycleConflict("status_unrecognized")
    return normalized


def _numeric_decimal(value: object, *, field: str, positive: bool) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, (Decimal, int, str)):
        raise RecoveryMaterializationLifecycleConflict(f"{field}_must_be_decimal")
    try:
        normalized = Decimal(value)
    except (ArithmeticError, ValueError) as exc:
        raise RecoveryMaterializationLifecycleConflict(
            f"{field}_must_be_decimal"
        ) from exc
    if not normalized.is_finite() or normalized < 0 or (positive and normalized <= 0):
        raise RecoveryMaterializationLifecycleConflict(f"{field}_outside_numeric_20_8")
    sign, digits, exponent = normalized.as_tuple()
    del sign
    exponent_value = int(exponent)
    scale = max(-exponent_value, 0)
    integer_digits = max(len(digits) + exponent_value, 0)
    if (
        scale > _NUMERIC_SCALE
        or integer_digits > _NUMERIC_PRECISION - _NUMERIC_SCALE
        or integer_digits + scale > _NUMERIC_PRECISION
    ):
        raise RecoveryMaterializationLifecycleConflict(f"{field}_outside_numeric_20_8")
    return Decimal(format(normalized, "f"))


def _execution_payload(
    *,
    identity: RecoveryMaterializationIdentity,
    state: _MaterializationState,
    order: ValidatedAlpacaRecoveryOrder,
) -> dict[str, object]:
    terms = order.terms
    raw_order = _safe_order_payload(order)
    audit = {
        _MATERIALIZATION_AUDIT_KEY: {
            "schema_version": _MATERIALIZATION_IDENTITY_SCHEMA,
            "observation_outcome": AlpacaRecoveryObservationOutcome.VALIDATED.value,
            "status": state.status,
            "filled_qty": str(state.filled_qty),
            "filled_avg_price": (
                str(state.avg_fill_price) if state.avg_fill_price is not None else None
            ),
        },
        "materialization_identity": _identity_payload(identity),
    }
    return {
        "trade_decision_id": identity.trade_decision_id,
        "alpaca_account_label": identity.account_label,
        "alpaca_order_id": identity.broker_order_id,
        "client_order_id": identity.client_order_id,
        "symbol": terms.symbol,
        "side": terms.side,
        "order_type": terms.order_type,
        "time_in_force": terms.time_in_force,
        "submitted_qty": state.submitted_qty,
        "filled_qty": state.filled_qty,
        "avg_fill_price": state.avg_fill_price,
        "status": state.status,
        "execution_expected_adapter": "alpaca",
        "execution_actual_adapter": "alpaca",
        "execution_audit_json": coerce_json_payload(audit),
        "raw_order": coerce_json_payload(raw_order),
        "last_update_at": datetime.now(timezone.utc),
    }


def _safe_order_payload(order: ValidatedAlpacaRecoveryOrder) -> dict[str, object]:
    terms = order.terms
    return {
        "id": order.broker_order_id,
        "client_order_id": order.client_order_id,
        "alpaca_account_label": order.account_label,
        "symbol": terms.symbol,
        "side": terms.side,
        "qty": str(terms.qty),
        "notional": None,
        "type": terms.order_type,
        "time_in_force": terms.time_in_force,
        "limit_price": _optional_decimal_text(terms.limit_price),
        "stop_price": _optional_decimal_text(terms.stop_price),
        "trail_price": _optional_decimal_text(terms.trail_price),
        "trail_percent": _optional_decimal_text(terms.trail_percent),
        "order_class": terms.order_class,
        "position_intent": terms.position_intent,
        "extended_hours": terms.extended_hours,
        "status": order.status,
        "filled_qty": str(order.filled_qty),
        "filled_avg_price": _optional_decimal_text(order.filled_avg_price),
    }


def _optional_decimal_text(value: Decimal | None) -> str | None:
    return str(value) if value is not None else None


def _canonical_decimal_text(value: object, *, field: str) -> str:
    """Encode numeric(20,8) identity values with one stable scale."""

    normalized = _numeric_decimal(value, field=field, positive=False)
    return f"{normalized:.{_NUMERIC_SCALE}f}"


def _identity_payload(
    identity: RecoveryMaterializationIdentity,
) -> dict[str, object | None]:
    return {
        "schema_version": _MATERIALIZATION_IDENTITY_SCHEMA,
        "trade_decision_id": str(identity.trade_decision_id),
        "account_label": identity.account_label,
        "client_order_id": identity.client_order_id,
        "broker_order_id": identity.broker_order_id,
        "symbol": identity.symbol,
        "side": identity.side,
        "submitted_qty": _canonical_decimal_text(
            identity.submitted_qty,
            field="identity.submitted_qty",
        ),
        "order_type": identity.order_type,
        "time_in_force": identity.time_in_force,
        "order_class": identity.order_class,
        "position_intent": identity.position_intent,
        "extended_hours": identity.extended_hours,
        "limit_price": (
            _canonical_decimal_text(identity.limit_price, field="identity.limit_price")
            if identity.limit_price is not None
            else None
        ),
        "stop_price": (
            _canonical_decimal_text(identity.stop_price, field="identity.stop_price")
            if identity.stop_price is not None
            else None
        ),
        "trail_price": (
            _canonical_decimal_text(identity.trail_price, field="identity.trail_price")
            if identity.trail_price is not None
            else None
        ),
        "trail_percent": (
            _canonical_decimal_text(
                identity.trail_percent,
                field="identity.trail_percent",
            )
            if identity.trail_percent is not None
            else None
        ),
    }


def _require_existing_identity(
    existing: Execution,
    *,
    identity: RecoveryMaterializationIdentity,
) -> None:
    observed = _existing_identity(existing)
    expected = _identity_payload(identity)
    conflicts = tuple(
        field
        for field in sorted(set(expected) | set(observed))
        if expected.get(field) != observed.get(field)
    )
    if conflicts:
        raise RecoveryMaterializationIdentityConflict(
            "recovery_execution_identity_conflict:" + ",".join(conflicts)
        )


def _existing_identity(existing: Execution) -> dict[str, object | None]:
    audit = existing.execution_audit_json
    if not isinstance(audit, Mapping):
        raise RecoveryMaterializationIdentityConflict(
            "recovery_execution_identity_missing"
        )
    value = cast(Mapping[object, object], audit).get("materialization_identity")
    if not isinstance(value, Mapping):
        raise RecoveryMaterializationIdentityConflict(
            "recovery_execution_identity_missing"
        )
    normalized = {
        str(key): item for key, item in cast(Mapping[object, object], value).items()
    }
    if normalized.get("schema_version") != _MATERIALIZATION_IDENTITY_SCHEMA:
        raise RecoveryMaterializationIdentityConflict(
            "recovery_execution_identity_schema_invalid"
        )
    for field in (
        "submitted_qty",
        "limit_price",
        "stop_price",
        "trail_price",
        "trail_percent",
    ):
        raw_value = normalized.get(field)
        if raw_value is None:
            continue
        try:
            normalized[field] = _canonical_decimal_text(
                raw_value,
                field=f"existing_identity.{field}",
            )
        except RecoveryMaterializationLifecycleConflict as exc:
            raise RecoveryMaterializationIdentityConflict(
                f"recovery_execution_identity_decimal_invalid:{field}"
            ) from exc
    return normalized


def _require_existing_state(
    existing: Execution,
    *,
    incoming: _MaterializationState,
) -> None:
    observed = _materialization_state(
        ValidatedAlpacaRecoveryOrder(
            account_label=existing.alpaca_account_label,
            broker_order_id=existing.alpaca_order_id,
            client_order_id=existing.client_order_id or "",
            status=existing.status,
            filled_qty=Decimal(str(existing.filled_qty)),
            filled_avg_price=(
                Decimal(str(existing.avg_fill_price))
                if existing.avg_fill_price is not None
                else None
            ),
            terms=AlpacaOrderTerms(
                symbol=existing.symbol,
                side=existing.side,
                qty=Decimal(str(existing.submitted_qty)),
                order_type=existing.order_type,
                time_in_force=existing.time_in_force,
                limit_price=None,
                stop_price=None,
                trail_price=None,
                trail_percent=None,
                order_class="simple",
                position_intent=None,
                extended_hours=False,
            ),
        )
    )
    if incoming.submitted_qty != observed.submitted_qty:
        raise RecoveryMaterializationLifecycleConflict("submitted_qty_drift")
    if incoming.filled_qty < observed.filled_qty:
        raise RecoveryMaterializationLifecycleConflict("filled_qty_regression")
    if existing.status in _TERMINAL_STATUSES and incoming.status != existing.status:
        raise RecoveryMaterializationLifecycleConflict("terminal_status_regression")
    if _STATUS_PHASE[incoming.status] < _STATUS_PHASE[observed.status]:
        raise RecoveryMaterializationLifecycleConflict("status_regression")
    if (
        incoming.filled_qty == observed.filled_qty
        and incoming.avg_fill_price != observed.avg_fill_price
    ):
        raise RecoveryMaterializationLifecycleConflict("fill_price_drift")


def _merge_existing_payload(existing: Execution, payload: Mapping[str, object]) -> None:
    existing_audit = existing.execution_audit_json
    incoming_audit = payload.get("execution_audit_json")
    if not isinstance(existing_audit, Mapping) or not isinstance(
        incoming_audit, Mapping
    ):
        raise RecoveryMaterializationIdentityConflict(
            "recovery_execution_audit_missing"
        )
    existing_identity = _existing_identity(existing)
    incoming_identity_value = cast(Mapping[object, object], incoming_audit).get(
        "materialization_identity"
    )
    if not isinstance(incoming_identity_value, Mapping):
        raise RecoveryMaterializationIdentityConflict(
            "recovery_execution_identity_missing"
        )
    incoming_identity = {
        str(key): value
        for key, value in cast(Mapping[object, object], incoming_identity_value).items()
    }
    for field in (
        "submitted_qty",
        "limit_price",
        "stop_price",
        "trail_price",
        "trail_percent",
    ):
        raw_value = incoming_identity.get(field)
        if raw_value is not None:
            incoming_identity[field] = _canonical_decimal_text(
                raw_value,
                field=f"incoming_identity.{field}",
            )
    if existing_identity != incoming_identity:
        raise RecoveryMaterializationIdentityConflict(
            "recovery_execution_identity_conflict"
        )
    merged_audit = {
        str(key): value
        for key, value in cast(Mapping[object, object], existing_audit).items()
    }
    merged_audit.update(
        {
            str(key): value
            for key, value in cast(Mapping[object, object], incoming_audit).items()
        }
    )
    updated = dict(payload)
    updated["execution_audit_json"] = coerce_json_payload(merged_audit)
    for key, value in updated.items():
        setattr(existing, key, value)


__all__ = [
    "RecoveryMaterializationError",
    "RecoveryMaterializationIdentity",
    "RecoveryMaterializationIdentityConflict",
    "RecoveryMaterializationLifecycleConflict",
    "materialize_alpaca_recovery_observation",
    "materialize_validated_alpaca_recovery",
]
