"""Broker-observed, one-use authority for monotonic risk reduction."""

from __future__ import annotations

import hmac
import json
import threading
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Literal, TypeAlias, cast

from .broker_mutation_receipts import (
    BrokerMutationOperation,
    BrokerMutationRoute,
    canonicalize_broker_mutation_evidence,
)
from .risk_reduction_primitives import (
    RiskReductionPermitError,
    aware_utc as _aware_utc,
    decimal_text as _decimal_text,
    nonnegative_decimal as _nonnegative_decimal,
    permit_tag as _permit_tag,
    positive_decimal as _positive_decimal,
    required_text as _required_text,
    symbol as _symbol,
)


RISK_REDUCTION_EVIDENCE_SCHEMA_VERSION = "torghut.risk-reduction-evidence.v1"
DEFAULT_OBSERVATION_MAX_AGE_SECONDS = 5
DEFAULT_PERMIT_TTL_SECONDS = 15

OrderSide = Literal["buy", "sell"]
RiskReductionRecoveryOutcome = Literal["resolved", "unresolved", "conflict"]
_OPEN_ORDER_STATUSES = frozenset(
    {
        "accepted",
        "accepted_for_bidding",
        "calculated",
        "held",
        "new",
        "open",
        "partially_filled",
        "pending_cancel",
        "pending_new",
        "pending_replace",
    }
)
RISK_REDUCTION_OPERATIONS = frozenset(
    {
        "submit_order",
        "replace_order",
        "cancel_order",
        "cancel_all_orders",
        "close_position",
        "close_all_positions",
    }
)
_PERMIT_CONSUMPTION_LOCK = threading.Lock()
_CONSUMED_PERMIT_EXPIRATIONS: dict[str, datetime] = {}


@dataclass(frozen=True, slots=True)
class BrokerOrderObservation:
    order_id: str
    symbol: str
    side: OrderSide
    quantity: Decimal
    filled_quantity: Decimal
    status: str
    limit_price: Decimal | None = None
    client_order_id: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "order_id", _required_text(self.order_id, field_name="order_id")
        )
        object.__setattr__(self, "symbol", _symbol(self.symbol))
        if self.side not in {"buy", "sell"}:
            raise RiskReductionPermitError("order_side_invalid")
        quantity = _positive_decimal(self.quantity, field_name="order_quantity")
        filled = _nonnegative_decimal(
            self.filled_quantity,
            field_name="order_filled_quantity",
        )
        if filled > quantity:
            raise RiskReductionPermitError("order_filled_quantity_exceeds_quantity")
        object.__setattr__(self, "quantity", quantity)
        object.__setattr__(self, "filled_quantity", filled)
        object.__setattr__(
            self,
            "status",
            _required_text(self.status, field_name="order_status", maximum=64).lower(),
        )
        if self.limit_price is not None:
            object.__setattr__(
                self,
                "limit_price",
                _positive_decimal(self.limit_price, field_name="order_limit_price"),
            )
        if self.client_order_id is not None:
            object.__setattr__(
                self,
                "client_order_id",
                _required_text(
                    self.client_order_id,
                    field_name="client_order_id",
                    maximum=128,
                ),
            )

    @property
    def remaining_quantity(self) -> Decimal:
        return self.quantity - self.filled_quantity

    @property
    def open(self) -> bool:
        return self.status in _OPEN_ORDER_STATUSES and self.remaining_quantity > 0


@dataclass(frozen=True, slots=True)
class BrokerPositionObservation:
    symbol: str
    signed_quantity: Decimal
    unit_notional: Decimal
    broker_symbol: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "symbol", _symbol(self.symbol))
        quantity = Decimal(self.signed_quantity)
        if not quantity.is_finite() or quantity == 0:
            raise RiskReductionPermitError("position_quantity_must_be_nonzero")
        object.__setattr__(self, "signed_quantity", quantity.normalize())
        object.__setattr__(
            self,
            "unit_notional",
            _positive_decimal(self.unit_notional, field_name="unit_notional"),
        )
        object.__setattr__(
            self,
            "broker_symbol",
            _required_text(
                self.broker_symbol or self.symbol,
                field_name="broker_symbol",
                maximum=128,
            ),
        )


@dataclass(frozen=True, slots=True)
class BrokerReductionSnapshot:
    broker_route: BrokerMutationRoute
    account_label: str
    endpoint_fingerprint: str
    observed_at: datetime
    complete: bool
    orders: tuple[BrokerOrderObservation, ...] = ()
    positions: tuple[BrokerPositionObservation, ...] = ()

    def __post_init__(self) -> None:
        if self.broker_route not in {"alpaca", "hyperliquid"}:
            raise RiskReductionPermitError("broker_route_invalid")
        object.__setattr__(
            self,
            "account_label",
            _required_text(self.account_label, field_name="account_label", maximum=64),
        )
        endpoint = self.endpoint_fingerprint.strip().lower()
        if len(endpoint) != 64 or any(
            character not in "0123456789abcdef" for character in endpoint
        ):
            raise RiskReductionPermitError("endpoint_fingerprint_invalid")
        object.__setattr__(self, "endpoint_fingerprint", endpoint)
        object.__setattr__(
            self,
            "observed_at",
            _aware_utc(self.observed_at, field_name="observed_at"),
        )
        order_ids = [order.order_id for order in self.orders]
        if len(set(order_ids)) != len(order_ids):
            raise RiskReductionPermitError("duplicate_observed_order_id")
        symbols = [position.symbol for position in self.positions]
        if len(set(symbols)) != len(symbols):
            raise RiskReductionPermitError("duplicate_observed_position_symbol")


@dataclass(frozen=True, slots=True)
class CancelOrderPlan:
    order_id: str

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "order_id", _required_text(self.order_id, field_name="order_id")
        )


@dataclass(frozen=True, slots=True)
class CancelAllOrdersPlan:
    pass


@dataclass(frozen=True, slots=True)
class ReplaceOrderPlan:
    order_id: str
    limit_price: Decimal

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "order_id", _required_text(self.order_id, field_name="order_id")
        )
        object.__setattr__(
            self,
            "limit_price",
            _positive_decimal(self.limit_price, field_name="replacement_limit_price"),
        )


@dataclass(frozen=True, slots=True)
class PositionCloseLeg:
    symbol: str
    side: OrderSide
    quantity: Decimal

    def __post_init__(self) -> None:
        object.__setattr__(self, "symbol", _symbol(self.symbol))
        if self.side not in {"buy", "sell"}:
            raise RiskReductionPermitError("close_side_invalid")
        object.__setattr__(
            self,
            "quantity",
            _positive_decimal(self.quantity, field_name="close_quantity"),
        )


@dataclass(frozen=True, slots=True)
class SubmitCloseOrderPlan:
    leg: PositionCloseLeg
    limit_price: Decimal
    time_in_force: Literal["gtc"] = "gtc"

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "limit_price",
            _positive_decimal(self.limit_price, field_name="close_limit_price"),
        )


@dataclass(frozen=True, slots=True)
class ClosePositionPlan:
    leg: PositionCloseLeg


@dataclass(frozen=True, slots=True)
class CloseAllPositionsPlan:
    legs: tuple[PositionCloseLeg, ...]

    def __post_init__(self) -> None:
        if not self.legs:
            raise RiskReductionPermitError("close_all_requires_legs")
        symbols = [leg.symbol for leg in self.legs]
        if len(set(symbols)) != len(symbols):
            raise RiskReductionPermitError("close_all_duplicate_symbol")


RiskReductionPlan: TypeAlias = (
    CancelOrderPlan
    | CancelAllOrdersPlan
    | ReplaceOrderPlan
    | SubmitCloseOrderPlan
    | ClosePositionPlan
    | CloseAllPositionsPlan
)


@dataclass(frozen=True, slots=True)
class RiskReductionPermit:
    broker_route: BrokerMutationRoute
    account_label: str
    endpoint_fingerprint: str
    operation: BrokerMutationOperation
    target_key: str
    action_sha256: str
    observation_sha256: str
    evidence_sha256: str
    observed_at: datetime
    expires_at: datetime
    gross_before: Decimal
    gross_after: Decimal
    net_before: Decimal
    net_after: Decimal
    authorization_tag: str = field(repr=False, compare=False)


@dataclass(frozen=True, slots=True)
class RiskReductionAuthorization:
    permit: RiskReductionPermit
    evidence_json: str = field(repr=False)

    @property
    def evidence_payload(self) -> Mapping[str, object]:
        payload = json.loads(self.evidence_json)
        if not isinstance(payload, Mapping):  # pragma: no cover - built internally
            raise RiskReductionPermitError("risk_reduction_evidence_invalid")
        return cast(Mapping[str, object], payload)


@dataclass(frozen=True, slots=True)
class RiskReductionRecoveryEvaluation:
    outcome: RiskReductionRecoveryOutcome
    reason: str
    before: Mapping[str, Decimal]
    current: Mapping[str, Decimal]


@dataclass(frozen=True, slots=True)
class RiskReductionPermitExpectation:
    broker_route: BrokerMutationRoute
    account_label: str
    endpoint_fingerprint: str
    operation: BrokerMutationOperation
    target_key: str
    request_payload: Mapping[str, object]


@dataclass(frozen=True, slots=True)
class _EvaluatedReduction:
    operation: BrokerMutationOperation
    target_key: str
    action: Mapping[str, object]
    positions_after: Mapping[str, Decimal]


@dataclass(frozen=True, slots=True)
class _ReductionExposure:
    gross_before: Decimal
    gross_after: Decimal
    net_before: Decimal
    net_after: Decimal


@dataclass(frozen=True, slots=True)
class _SealedReductionEvidence:
    canonical_json: str
    evidence_sha256: str
    action_sha256: str
    observation_sha256: str


def authorize_risk_reduction(
    snapshot: BrokerReductionSnapshot,
    plan: RiskReductionPlan,
    *,
    now: datetime | None = None,
    max_observation_age_seconds: int = DEFAULT_OBSERVATION_MAX_AGE_SECONDS,
    permit_ttl_seconds: int = DEFAULT_PERMIT_TTL_SECONDS,
) -> RiskReductionAuthorization:
    """Seal a fresh broker observation and one monotonic mutation plan."""

    evaluated_at = _validated_authorization_time(
        snapshot,
        now=now,
        max_observation_age_seconds=max_observation_age_seconds,
        permit_ttl_seconds=permit_ttl_seconds,
    )
    evaluated = _evaluate_plan(snapshot, plan)
    exposure = _evaluate_reduction_exposure(snapshot, evaluated)
    sealed = _seal_reduction_evidence(snapshot, evaluated, exposure)
    expires_at = min(
        evaluated_at + timedelta(seconds=permit_ttl_seconds),
        snapshot.observed_at + timedelta(seconds=max_observation_age_seconds),
    )
    return RiskReductionAuthorization(
        permit=RiskReductionPermit(
            broker_route=snapshot.broker_route,
            account_label=snapshot.account_label,
            endpoint_fingerprint=snapshot.endpoint_fingerprint,
            operation=evaluated.operation,
            target_key=evaluated.target_key,
            action_sha256=sealed.action_sha256,
            observation_sha256=sealed.observation_sha256,
            evidence_sha256=sealed.evidence_sha256,
            observed_at=snapshot.observed_at,
            expires_at=expires_at,
            gross_before=exposure.gross_before,
            gross_after=exposure.gross_after,
            net_before=exposure.net_before,
            net_after=exposure.net_after,
            authorization_tag=_permit_tag(
                (
                    snapshot.broker_route,
                    snapshot.account_label,
                    snapshot.endpoint_fingerprint,
                    evaluated.operation,
                    evaluated.target_key,
                    sealed.action_sha256,
                    sealed.observation_sha256,
                    sealed.evidence_sha256,
                    snapshot.observed_at,
                    expires_at,
                    exposure.gross_before,
                    exposure.gross_after,
                    exposure.net_before,
                    exposure.net_after,
                )
            ),
        ),
        evidence_json=sealed.canonical_json,
    )


def _validated_authorization_time(
    snapshot: BrokerReductionSnapshot,
    *,
    now: datetime | None,
    max_observation_age_seconds: int,
    permit_ttl_seconds: int,
) -> datetime:
    evaluated_at = _aware_utc(now or datetime.now(timezone.utc), field_name="now")
    if (
        type(max_observation_age_seconds) is not int
        or type(permit_ttl_seconds) is not int
        or max_observation_age_seconds <= 0
        or permit_ttl_seconds <= 0
    ):
        raise RiskReductionPermitError("risk_reduction_ttl_invalid")
    age = evaluated_at - snapshot.observed_at
    if age < timedelta(0) or age > timedelta(seconds=max_observation_age_seconds):
        raise RiskReductionPermitError("broker_reduction_observation_stale")
    return evaluated_at


def _evaluate_reduction_exposure(
    snapshot: BrokerReductionSnapshot,
    evaluated: _EvaluatedReduction,
) -> _ReductionExposure:
    positions_before = {
        position.symbol: position.signed_quantity for position in snapshot.positions
    }
    marks = {position.symbol: position.unit_notional for position in snapshot.positions}
    gross_before, net_before = _exposure(positions_before, marks)
    gross_after, net_after = _exposure(evaluated.positions_after, marks)
    if gross_after > gross_before:
        raise RiskReductionPermitError("risk_reduction_increases_gross_exposure")
    if abs(net_after) > abs(net_before):
        raise RiskReductionPermitError("risk_reduction_increases_net_exposure")
    return _ReductionExposure(gross_before, gross_after, net_before, net_after)


def _seal_reduction_evidence(
    snapshot: BrokerReductionSnapshot,
    evaluated: _EvaluatedReduction,
    exposure: _ReductionExposure,
) -> _SealedReductionEvidence:
    observation = _observation_payload(snapshot)
    evidence = {
        "account_label": snapshot.account_label,
        "action": evaluated.action,
        "broker_route": snapshot.broker_route,
        "endpoint_fingerprint": snapshot.endpoint_fingerprint,
        "exposure": {
            "gross_after": _decimal_text(exposure.gross_after),
            "gross_before": _decimal_text(exposure.gross_before),
            "net_after": _decimal_text(exposure.net_after),
            "net_before": _decimal_text(exposure.net_before),
        },
        "observation": observation,
        "schema_version": RISK_REDUCTION_EVIDENCE_SCHEMA_VERSION,
        "target_key": evaluated.target_key,
    }
    evidence_json, evidence_sha256 = canonicalize_broker_mutation_evidence(evidence)
    _, action_sha256 = canonicalize_broker_mutation_evidence(evaluated.action)
    _, observation_sha256 = canonicalize_broker_mutation_evidence(observation)
    return _SealedReductionEvidence(
        evidence_json,
        evidence_sha256,
        action_sha256,
        observation_sha256,
    )


def consume_risk_reduction_permit(
    permit: object,
    *,
    expectation: RiskReductionPermitExpectation,
    now: datetime | None = None,
) -> RiskReductionPermit:
    """Validate and atomically consume the exact sealed reduction capability."""

    evaluated_at = _aware_utc(now or datetime.now(timezone.utc), field_name="now")
    validated = validate_risk_reduction_permit(
        permit,
        expectation=expectation,
        now=evaluated_at,
    )
    with _PERMIT_CONSUMPTION_LOCK:
        expired_tags = tuple(
            tag
            for tag, expires_at in _CONSUMED_PERMIT_EXPIRATIONS.items()
            if expires_at < evaluated_at
        )
        for tag in expired_tags:
            del _CONSUMED_PERMIT_EXPIRATIONS[tag]
        if validated.authorization_tag in _CONSUMED_PERMIT_EXPIRATIONS:
            raise RiskReductionPermitError("risk_reduction_permit_already_consumed")
        _CONSUMED_PERMIT_EXPIRATIONS[validated.authorization_tag] = validated.expires_at
    return validated


def validate_risk_reduction_permit(
    permit: object,
    *,
    expectation: RiskReductionPermitExpectation,
    now: datetime | None = None,
) -> RiskReductionPermit:
    """Validate a sealed capability without consuming it."""

    if not isinstance(permit, RiskReductionPermit):
        raise RiskReductionPermitError("risk_reduction_permit_required")
    evaluated_at = _aware_utc(now or datetime.now(timezone.utc), field_name="now")
    evidence = expectation.request_payload.get("risk_reduction")
    if not isinstance(evidence, Mapping):
        raise RiskReductionPermitError("risk_reduction_evidence_required")
    evidence_map = cast(Mapping[str, object], evidence)
    _, evidence_sha256 = canonicalize_broker_mutation_evidence(evidence_map)
    unsigned_fields = (
        permit.broker_route,
        permit.account_label,
        permit.endpoint_fingerprint,
        permit.operation,
        permit.target_key,
        permit.action_sha256,
        permit.observation_sha256,
        permit.evidence_sha256,
        permit.observed_at,
        permit.expires_at,
        permit.gross_before,
        permit.gross_after,
        permit.net_before,
        permit.net_after,
    )
    expected_tag = _permit_tag(unsigned_fields)
    if not hmac.compare_digest(permit.authorization_tag, expected_tag):
        raise RiskReductionPermitError("risk_reduction_permit_invalid")
    if (
        permit.broker_route != expectation.broker_route
        or permit.account_label != expectation.account_label
        or permit.endpoint_fingerprint != expectation.endpoint_fingerprint
        or permit.operation != expectation.operation
        or permit.target_key != expectation.target_key
        or permit.operation not in RISK_REDUCTION_OPERATIONS
        or permit.evidence_sha256 != evidence_sha256
        or evaluated_at < permit.observed_at
        or evaluated_at > permit.expires_at
        or permit.gross_after > permit.gross_before
        or abs(permit.net_after) > abs(permit.net_before)
    ):
        raise RiskReductionPermitError("risk_reduction_permit_invalid")
    return permit


def flatten_observed_positions(
    snapshot: BrokerReductionSnapshot,
) -> CloseAllPositionsPlan:
    """Build the only exact flatten plan for a complete observed position set."""

    if not snapshot.complete:
        raise RiskReductionPermitError("complete_broker_snapshot_required")
    legs = tuple(
        PositionCloseLeg(
            symbol=position.symbol,
            side="sell" if position.signed_quantity > 0 else "buy",
            quantity=abs(position.signed_quantity),
        )
        for position in sorted(snapshot.positions, key=lambda value: value.symbol)
    )
    return CloseAllPositionsPlan(legs=legs)


def evaluate_position_reduction_recovery(
    evidence: Mapping[str, object],
    current_positions: tuple[BrokerPositionObservation, ...],
    *,
    operation: BrokerMutationOperation,
    target_key: str,
) -> RiskReductionRecoveryEvaluation:
    """Compare fresh broker positions with the sealed close intent."""

    if operation not in {"close_position", "close_all_positions"}:
        raise RiskReductionPermitError("position_recovery_operation_invalid")
    if evidence.get("schema_version") != RISK_REDUCTION_EVIDENCE_SCHEMA_VERSION:
        raise RiskReductionPermitError("position_recovery_evidence_schema_invalid")
    if evidence.get("target_key") != target_key:
        raise RiskReductionPermitError("position_recovery_target_mismatch")
    raw_action = evidence.get("action")
    if not isinstance(raw_action, Mapping):
        raise RiskReductionPermitError("position_recovery_action_invalid")
    action = cast(Mapping[str, object], raw_action)
    if action.get("type") != operation:
        raise RiskReductionPermitError("position_recovery_action_invalid")
    raw_observation = evidence.get("observation")
    if not isinstance(raw_observation, Mapping):
        raise RiskReductionPermitError("position_recovery_observation_invalid")
    observation = cast(Mapping[str, object], raw_observation)
    raw_before = observation.get("positions")
    if not isinstance(raw_before, list):
        raise RiskReductionPermitError("position_recovery_observation_invalid")
    before = _recovery_position_map(cast(list[object], raw_before))
    current = {
        position.symbol: position.signed_quantity for position in current_positions
    }
    if len(current) != len(current_positions):
        raise RiskReductionPermitError("position_recovery_duplicate_current_symbol")

    if operation == "close_position":
        return _evaluate_single_position_recovery(target_key, before, current)
    return _evaluate_flatten_recovery(before, current)


def _evaluate_single_position_recovery(
    target_key: str,
    before: Mapping[str, Decimal],
    current: Mapping[str, Decimal],
) -> RiskReductionRecoveryEvaluation:
    symbol = _symbol(target_key)
    if symbol not in before:
        raise RiskReductionPermitError("position_recovery_target_not_observed")
    if symbol not in current:
        return RiskReductionRecoveryEvaluation(
            "resolved", "target_position_flat", before, current
        )
    conflict = _position_recovery_conflict(before[symbol], current[symbol])
    if conflict is not None:
        return RiskReductionRecoveryEvaluation("conflict", conflict, before, current)
    if abs(current[symbol]) < abs(before[symbol]):
        return RiskReductionRecoveryEvaluation(
            "resolved", "target_position_reduced", before, current
        )
    return RiskReductionRecoveryEvaluation(
        "unresolved", "target_position_unchanged", before, current
    )


def _evaluate_flatten_recovery(
    before: Mapping[str, Decimal],
    current: Mapping[str, Decimal],
) -> RiskReductionRecoveryEvaluation:
    unexpected = sorted(set(current) - set(before))
    if unexpected:
        return RiskReductionRecoveryEvaluation(
            "conflict", "new_position_observed_during_flatten", before, current
        )
    for symbol, quantity in current.items():
        conflict = _position_recovery_conflict(before[symbol], quantity)
        if conflict is not None:
            return RiskReductionRecoveryEvaluation(
                "conflict", conflict, before, current
            )
    if current:
        return RiskReductionRecoveryEvaluation(
            "unresolved", "flatten_incomplete", before, current
        )
    return RiskReductionRecoveryEvaluation("resolved", "account_flat", before, current)


def _recovery_position_map(raw_positions: list[object]) -> dict[str, Decimal]:
    positions: dict[str, Decimal] = {}
    for item in raw_positions:
        if not isinstance(item, Mapping):
            raise RiskReductionPermitError("position_recovery_observation_invalid")
        item_map = cast(Mapping[str, object], item)
        symbol = _symbol(str(item_map.get("symbol") or ""))
        try:
            quantity = Decimal(str(item_map.get("signed_quantity")))
        except (ArithmeticError, ValueError) as exc:
            raise RiskReductionPermitError(
                "position_recovery_observation_invalid"
            ) from exc
        if not quantity.is_finite() or quantity == 0 or symbol in positions:
            raise RiskReductionPermitError("position_recovery_observation_invalid")
        positions[symbol] = quantity
    return positions


def _position_recovery_conflict(before: Decimal, current: Decimal) -> str | None:
    if before.is_signed() != current.is_signed():
        return "position_side_flipped"
    if abs(current) > abs(before):
        return "position_quantity_increased"
    return None


def _evaluate_plan(
    snapshot: BrokerReductionSnapshot,
    plan: RiskReductionPlan,
) -> _EvaluatedReduction:
    positions = {
        position.symbol: position.signed_quantity for position in snapshot.positions
    }
    if isinstance(plan, CancelOrderPlan):
        order = _required_open_order(snapshot, plan.order_id)
        return _EvaluatedReduction(
            operation="cancel_order",
            target_key=order.order_id,
            action={"order": _order_payload(order), "type": "cancel_order"},
            positions_after=positions,
        )
    if isinstance(plan, CancelAllOrdersPlan):
        _require_complete(snapshot)
        orders = tuple(
            sorted(
                (order for order in snapshot.orders if order.open),
                key=lambda value: value.order_id,
            )
        )
        return _EvaluatedReduction(
            operation="cancel_all_orders",
            target_key=snapshot.account_label,
            action={
                "orders": [_order_payload(order) for order in orders],
                "type": "cancel_all_orders",
            },
            positions_after=positions,
        )
    if isinstance(plan, ReplaceOrderPlan):
        _require_complete(snapshot)
        order = _required_open_order(snapshot, plan.order_id)
        if order.limit_price is None:
            raise RiskReductionPermitError("replacement_requires_limit_order")
        position = next(
            (value for value in snapshot.positions if value.symbol == order.symbol),
            None,
        )
        risk_reducing = position is not None and (
            (position.signed_quantity > 0 and order.side == "sell")
            or (position.signed_quantity < 0 and order.side == "buy")
        )
        if (
            position is not None
            and risk_reducing
            and order.remaining_quantity > abs(position.signed_quantity)
        ):
            raise RiskReductionPermitError("replacement_would_cross_position_zero")
        return _EvaluatedReduction(
            operation="replace_order",
            target_key=order.order_id,
            action={
                "causal_order": _order_payload(order),
                "causal_position": (
                    _position_identity_payload(position)
                    if position is not None
                    else None
                ),
                "limit_price": _decimal_text(plan.limit_price),
                "quantity": _decimal_text(order.remaining_quantity),
                "type": "replace_order",
            },
            positions_after=positions,
        )
    if isinstance(plan, SubmitCloseOrderPlan):
        _require_complete(snapshot)
        position = _required_position(snapshot, plan.leg.symbol)
        reducing_orders = tuple(
            order
            for order in snapshot.orders
            if order.open
            and order.symbol == plan.leg.symbol
            and order.side == plan.leg.side
        )
        reserved_quantity = sum(
            (order.remaining_quantity for order in reducing_orders),
            Decimal("0"),
        )
        if reserved_quantity + plan.leg.quantity > abs(position.signed_quantity):
            raise RiskReductionPermitError("close_order_would_cross_position_zero")
        after = _apply_close_leg(positions, plan.leg)
        return _EvaluatedReduction(
            operation="submit_order",
            target_key=plan.leg.symbol,
            action={
                "causal_position": _position_identity_payload(position),
                "existing_reducing_orders": [
                    _order_payload(order)
                    for order in sorted(
                        reducing_orders,
                        key=lambda value: value.order_id,
                    )
                ],
                "leg": _leg_payload(plan.leg),
                "limit_price": _decimal_text(plan.limit_price),
                "time_in_force": plan.time_in_force,
                "type": "submit_close_order",
            },
            positions_after=after,
        )
    if isinstance(plan, ClosePositionPlan):
        _require_complete(snapshot)
        position = _required_position(snapshot, plan.leg.symbol)
        after = _apply_close_leg(positions, plan.leg)
        return _EvaluatedReduction(
            operation="close_position",
            target_key=plan.leg.symbol,
            action={
                "causal_position": _position_identity_payload(position),
                "leg": _leg_payload(plan.leg),
                "type": "close_position",
            },
            positions_after=after,
        )
    _require_complete(snapshot)
    observed_symbols = set(positions)
    planned_symbols = {leg.symbol for leg in plan.legs}
    if observed_symbols != planned_symbols:
        raise RiskReductionPermitError("close_all_must_cover_exact_observed_positions")
    after = positions
    for leg in plan.legs:
        after = _apply_close_leg(after, leg)
    if any(quantity != 0 for quantity in after.values()):
        raise RiskReductionPermitError("close_all_must_flatten_observed_positions")
    return _EvaluatedReduction(
        operation="close_all_positions",
        target_key=snapshot.account_label,
        action={
            "causal_positions": [
                _position_identity_payload(position)
                for position in sorted(
                    snapshot.positions,
                    key=lambda value: value.symbol,
                )
            ],
            "legs": [
                _leg_payload(leg)
                for leg in sorted(plan.legs, key=lambda value: value.symbol)
            ],
            "type": "close_all_positions",
        },
        positions_after=after,
    )


def _apply_close_leg(
    positions: Mapping[str, Decimal],
    leg: PositionCloseLeg,
) -> dict[str, Decimal]:
    if leg.symbol not in positions:
        raise RiskReductionPermitError("close_would_create_new_symbol")
    before = positions[leg.symbol]
    if (before > 0 and leg.side != "sell") or (before < 0 and leg.side != "buy"):
        raise RiskReductionPermitError("close_side_does_not_reduce_position")
    signed_delta = leg.quantity if leg.side == "buy" else -leg.quantity
    after = before + signed_delta
    if abs(after) > abs(before) or (before > 0 > after) or (before < 0 < after):
        raise RiskReductionPermitError("close_would_flip_or_increase_position")
    result = dict(positions)
    result[leg.symbol] = after
    return result


def _required_open_order(
    snapshot: BrokerReductionSnapshot,
    order_id: str,
) -> BrokerOrderObservation:
    order = next(
        (value for value in snapshot.orders if value.order_id == order_id), None
    )
    if order is None:
        raise RiskReductionPermitError("target_order_not_observed")
    if not order.open:
        raise RiskReductionPermitError("target_order_not_open")
    return order


def _required_position(
    snapshot: BrokerReductionSnapshot,
    symbol: str,
) -> BrokerPositionObservation:
    position = next(
        (value for value in snapshot.positions if value.symbol == symbol),
        None,
    )
    if position is None:
        raise RiskReductionPermitError("close_would_create_new_symbol")
    return position


def _require_complete(snapshot: BrokerReductionSnapshot) -> None:
    if not snapshot.complete:
        raise RiskReductionPermitError("complete_broker_snapshot_required")


def _exposure(
    positions: Mapping[str, Decimal],
    marks: Mapping[str, Decimal],
) -> tuple[Decimal, Decimal]:
    gross = sum(
        (abs(quantity) * marks[symbol] for symbol, quantity in positions.items()),
        Decimal("0"),
    )
    net = sum(
        (quantity * marks[symbol] for symbol, quantity in positions.items()),
        Decimal("0"),
    )
    return gross, net


def _observation_payload(snapshot: BrokerReductionSnapshot) -> Mapping[str, object]:
    return {
        "complete": snapshot.complete,
        "observed_at": snapshot.observed_at.isoformat(),
        "orders": [
            _order_payload(order)
            for order in sorted(snapshot.orders, key=lambda value: value.order_id)
        ],
        "positions": [
            _position_payload(position)
            for position in sorted(snapshot.positions, key=lambda value: value.symbol)
        ],
    }


def _order_payload(order: BrokerOrderObservation) -> Mapping[str, object]:
    return {
        "client_order_id": order.client_order_id,
        "filled_quantity": _decimal_text(order.filled_quantity),
        "limit_price": (
            _decimal_text(order.limit_price) if order.limit_price is not None else None
        ),
        "order_id": order.order_id,
        "quantity": _decimal_text(order.quantity),
        "remaining_quantity": _decimal_text(order.remaining_quantity),
        "side": order.side,
        "status": order.status,
        "symbol": order.symbol,
    }


def _leg_payload(leg: PositionCloseLeg) -> Mapping[str, object]:
    return {
        "quantity": _decimal_text(leg.quantity),
        "side": leg.side,
        "symbol": leg.symbol,
    }


def _position_payload(position: BrokerPositionObservation) -> Mapping[str, object]:
    return {
        "broker_symbol": position.broker_symbol,
        "signed_quantity": _decimal_text(position.signed_quantity),
        "symbol": position.symbol,
        "unit_notional": _decimal_text(position.unit_notional),
    }


def _position_identity_payload(
    position: BrokerPositionObservation,
) -> Mapping[str, object]:
    """Return stable economic identity without volatile mark-price evidence."""

    return {
        "broker_symbol": position.broker_symbol,
        "signed_quantity": _decimal_text(position.signed_quantity),
        "symbol": position.symbol,
    }


__all__ = [
    "BrokerOrderObservation",
    "BrokerPositionObservation",
    "BrokerReductionSnapshot",
    "CancelAllOrdersPlan",
    "CancelOrderPlan",
    "CloseAllPositionsPlan",
    "ClosePositionPlan",
    "OrderSide",
    "PositionCloseLeg",
    "ReplaceOrderPlan",
    "RiskReductionAuthorization",
    "RiskReductionPermit",
    "RiskReductionPermitError",
    "RiskReductionPermitExpectation",
    "RiskReductionRecoveryEvaluation",
    "SubmitCloseOrderPlan",
    "authorize_risk_reduction",
    "consume_risk_reduction_permit",
    "evaluate_position_reduction_recovery",
    "flatten_observed_positions",
    "validate_risk_reduction_permit",
]
