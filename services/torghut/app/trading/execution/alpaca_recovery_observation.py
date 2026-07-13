"""Pure validation for an Alpaca order observed during submission recovery.

This module deliberately has no persistence or execution-materialization imports. A
recovery worker must first obtain a ``VALIDATED`` result before it can consider a
separate terminal transition.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from enum import StrEnum
from typing import cast

from alpaca.trading.enums import OrderStatus, PositionIntent

from ..broker_mutation_receipts import BrokerMutationIntent
from ..broker_mutation_receipts.canonicalization import (
    verify_broker_mutation_intent,
)
from ..broker_mutation_receipts.validation import (
    BrokerMutationReceiptValidationError,
)


_SYMBOL = re.compile(r"^[A-Z][A-Z0-9./-]{0,31}$")
_ORDER_TYPES = frozenset({"market", "limit", "stop", "stop_limit", "trailing_stop"})
_TIME_IN_FORCE = frozenset({"day", "gtc", "opg", "cls", "ioc", "fok"})
_BROKER_STATUSES = frozenset(status.value for status in OrderStatus)
_POSITION_INTENTS = frozenset(
    position_intent.value for position_intent in PositionIntent
)
_FULL_FILL_PERMITTED_STATUSES = frozenset({"calculated", "filled"})
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


class AlpacaRecoveryObservationOutcome(StrEnum):
    """Whether an observed broker payload is safe for later recovery use."""

    VALIDATED = "validated"
    INDETERMINATE = "indeterminate"


class AlpacaRecoveryObservationReason(StrEnum):
    """Stable fail-closed classifications for nonterminal recovery evidence."""

    INTENT_INVALID = "alpaca_recovery_intent_invalid"
    ROUTE_INVALID = "alpaca_recovery_route_invalid"
    OPERATION_INVALID = "alpaca_recovery_operation_invalid"
    LINKAGE_INVALID = "alpaca_recovery_linkage_invalid"
    ACCOUNT_REQUIRED = "alpaca_recovery_account_required"
    ACCOUNT_MISMATCH = "alpaca_recovery_account_mismatch"
    REQUEST_INVALID = "alpaca_recovery_request_invalid"
    NOTIONAL_INDETERMINATE = "notional_submission_recovery_indeterminate"
    REQUEST_QTY_INVALID = "alpaca_recovery_request_qty_invalid"
    REQUEST_TERMS_INVALID = "alpaca_recovery_request_terms_invalid"
    BROKER_PAYLOAD_INVALID = "alpaca_recovery_broker_payload_invalid"
    BROKER_ORDER_ID_INVALID = "alpaca_recovery_broker_order_id_invalid"
    BROKER_ORDER_ID_MISMATCH = "alpaca_recovery_broker_order_id_mismatch"
    CLIENT_ORDER_ID_MISMATCH = "alpaca_recovery_client_order_id_mismatch"
    ORDER_IDENTITY_MISMATCH = "alpaca_recovery_order_identity_mismatch"
    BROKER_STATUS_INVALID = "alpaca_recovery_broker_status_invalid"
    BROKER_FILL_INVALID = "alpaca_recovery_broker_fill_invalid"
    BROKER_LIFECYCLE_INVALID = "alpaca_recovery_broker_lifecycle_invalid"


@dataclass(frozen=True, slots=True)
class AlpacaOrderTerms:
    """Exact economic and routing terms shared by request and broker order."""

    symbol: str
    side: str
    qty: Decimal
    order_type: str
    time_in_force: str
    limit_price: Decimal | None
    stop_price: Decimal | None
    trail_price: Decimal | None
    trail_percent: Decimal | None
    order_class: str
    position_intent: str | None
    extended_hours: bool


@dataclass(frozen=True, slots=True)
class ValidatedAlpacaRecoveryOrder:
    """Broker truth that exactly matches one canonical quantity submission."""

    account_label: str
    broker_order_id: str
    client_order_id: str
    status: str
    filled_qty: Decimal
    filled_avg_price: Decimal | None
    terms: AlpacaOrderTerms


@dataclass(frozen=True, slots=True)
class AlpacaRecoveryObservation:
    """A pure, nonterminal classification of one exact broker lookup result."""

    outcome: AlpacaRecoveryObservationOutcome
    reason: AlpacaRecoveryObservationReason | None
    order: ValidatedAlpacaRecoveryOrder | None

    @property
    def validated(self) -> bool:
        return self.outcome is AlpacaRecoveryObservationOutcome.VALIDATED


@dataclass(frozen=True, slots=True)
class _ExpectedRecovery:
    account_label: str
    terms: AlpacaOrderTerms


@dataclass(frozen=True, slots=True)
class _BrokerIdentity:
    broker_order_id: str
    client_order_id: str
    terms: AlpacaOrderTerms


def validate_alpaca_recovery_observation(
    *,
    intent: BrokerMutationIntent,
    account_label: object,
    broker_order: object,
    expected_broker_order_id: object | None = None,
) -> AlpacaRecoveryObservation:
    """Classify broker evidence without mutating a receipt, claim, or execution."""

    intent_failure = _validate_intent_identity(intent)
    if intent_failure is not None:
        return _indeterminate(intent_failure)
    expected = _expected_recovery(intent, account_label)
    if isinstance(expected, AlpacaRecoveryObservationReason):
        return _indeterminate(expected)
    broker_payload = _broker_payload(broker_order)
    if broker_payload is None:
        return _indeterminate(AlpacaRecoveryObservationReason.BROKER_PAYLOAD_INVALID)
    identity = _broker_identity(
        broker_payload,
        intent=intent,
        expected=expected,
        expected_broker_order_id=expected_broker_order_id,
    )
    if isinstance(identity, AlpacaRecoveryObservationReason):
        return _indeterminate(identity)
    lifecycle = _broker_lifecycle(
        broker_payload,
        submitted_qty=expected.terms.qty,
    )
    if isinstance(lifecycle, AlpacaRecoveryObservationReason):
        return _indeterminate(lifecycle)
    status, filled_qty, filled_avg_price = lifecycle
    return AlpacaRecoveryObservation(
        outcome=AlpacaRecoveryObservationOutcome.VALIDATED,
        reason=None,
        order=ValidatedAlpacaRecoveryOrder(
            account_label=expected.account_label,
            broker_order_id=identity.broker_order_id,
            client_order_id=identity.client_order_id,
            status=status,
            filled_qty=filled_qty,
            filled_avg_price=filled_avg_price,
            terms=identity.terms,
        ),
    )


def _expected_recovery(
    intent: BrokerMutationIntent,
    account_label: object,
) -> _ExpectedRecovery | AlpacaRecoveryObservationReason:
    account = _validated_account(intent, account_label)
    if isinstance(account, AlpacaRecoveryObservationReason):
        return account
    terms = _canonical_request_terms(intent)
    if isinstance(terms, AlpacaRecoveryObservationReason):
        return terms
    return _ExpectedRecovery(account_label=account, terms=terms)


def _validated_account(
    intent: BrokerMutationIntent,
    account_label: object,
) -> str | AlpacaRecoveryObservationReason:
    if not isinstance(account_label, str) or not account_label.strip():
        return AlpacaRecoveryObservationReason.ACCOUNT_REQUIRED
    observed_account = account_label.strip()
    if observed_account != account_label or observed_account != intent.account_label:
        return AlpacaRecoveryObservationReason.ACCOUNT_MISMATCH
    return observed_account


def _canonical_request_terms(
    intent: BrokerMutationIntent,
) -> AlpacaOrderTerms | AlpacaRecoveryObservationReason:
    request = _canonical_request(intent)
    if request is None:
        return AlpacaRecoveryObservationReason.REQUEST_INVALID
    request_client_order_id = request.get("client_order_id")
    if (
        request_client_order_id is not None
        and _bounded_text(request_client_order_id, maximum=128)
        != intent.client_request_id
    ):
        return AlpacaRecoveryObservationReason.REQUEST_INVALID
    sizing = _request_sizing(request)
    if isinstance(sizing, AlpacaRecoveryObservationReason):
        return sizing
    terms = _parse_terms(request, qty=sizing, broker=False)
    if terms is None:
        return AlpacaRecoveryObservationReason.REQUEST_TERMS_INVALID
    return terms


def _broker_payload(value: object) -> Mapping[str, object] | None:
    if not isinstance(value, Mapping):
        return None
    payload = cast(Mapping[object, object], value)
    if any(not isinstance(key, str) for key in payload):
        return None
    return cast(Mapping[str, object], payload)


def _broker_identity(
    payload: Mapping[str, object],
    *,
    intent: BrokerMutationIntent,
    expected: _ExpectedRecovery,
    expected_broker_order_id: object | None,
) -> _BrokerIdentity | AlpacaRecoveryObservationReason:
    linkage = _broker_linkage(
        payload,
        intent=intent,
        account_label=expected.account_label,
        expected_broker_order_id=expected_broker_order_id,
    )
    if isinstance(linkage, AlpacaRecoveryObservationReason):
        return linkage
    broker_order_id, client_order_id = linkage
    terms = _broker_terms(payload, expected=expected.terms)
    if isinstance(terms, AlpacaRecoveryObservationReason):
        return terms
    return _BrokerIdentity(
        broker_order_id=broker_order_id,
        client_order_id=client_order_id,
        terms=terms,
    )


def _broker_linkage(
    payload: Mapping[str, object],
    *,
    intent: BrokerMutationIntent,
    account_label: str,
    expected_broker_order_id: object | None,
) -> tuple[str, str] | AlpacaRecoveryObservationReason:
    account_failure = _validate_broker_account(
        payload,
        observed_account=account_label,
    )
    if account_failure is not None:
        return account_failure
    broker_order_id = _bounded_text(payload.get("id"), maximum=128)
    if broker_order_id is None:
        return AlpacaRecoveryObservationReason.BROKER_ORDER_ID_INVALID
    if not _broker_order_id_matches(broker_order_id, expected_broker_order_id):
        return AlpacaRecoveryObservationReason.BROKER_ORDER_ID_MISMATCH
    client_order_id = _bounded_text(payload.get("client_order_id"), maximum=128)
    if client_order_id != intent.client_request_id:
        return AlpacaRecoveryObservationReason.CLIENT_ORDER_ID_MISMATCH
    return broker_order_id, cast(str, client_order_id)


def _broker_order_id_matches(
    broker_order_id: str,
    expected_broker_order_id: object | None,
) -> bool:
    if expected_broker_order_id is None:
        return True
    expected_id = _bounded_text(expected_broker_order_id, maximum=128)
    return expected_id == broker_order_id


def _broker_terms(
    payload: Mapping[str, object],
    *,
    expected: AlpacaOrderTerms,
) -> AlpacaOrderTerms | AlpacaRecoveryObservationReason:
    broker_qty = _decimal(payload.get("qty"), positive=True, allow_zero=False)
    if broker_qty is None:
        return AlpacaRecoveryObservationReason.BROKER_PAYLOAD_INVALID
    if payload.get("notional") is not None:
        return AlpacaRecoveryObservationReason.ORDER_IDENTITY_MISMATCH
    terms = _parse_terms(payload, qty=broker_qty, broker=True)
    if terms is None or terms != expected:
        return AlpacaRecoveryObservationReason.ORDER_IDENTITY_MISMATCH
    return terms


def _broker_lifecycle(
    payload: Mapping[str, object],
    *,
    submitted_qty: Decimal,
) -> tuple[str, Decimal, Decimal | None] | AlpacaRecoveryObservationReason:
    status = _bounded_text(payload.get("status"), maximum=64)
    if status is None or status.lower() not in _BROKER_STATUSES:
        return AlpacaRecoveryObservationReason.BROKER_STATUS_INVALID
    normalized_status = status.lower()
    fill = _parse_fill(payload)
    if fill is None:
        return AlpacaRecoveryObservationReason.BROKER_FILL_INVALID
    filled_qty, filled_avg_price = fill
    if not _lifecycle_is_valid(
        status=normalized_status,
        submitted_qty=submitted_qty,
        filled_qty=filled_qty,
        filled_avg_price=filled_avg_price,
    ):
        return AlpacaRecoveryObservationReason.BROKER_LIFECYCLE_INVALID
    return normalized_status, filled_qty, filled_avg_price


def _validate_intent_identity(
    intent: BrokerMutationIntent,
) -> AlpacaRecoveryObservationReason | None:
    try:
        verify_broker_mutation_intent(intent)
    except (
        BrokerMutationReceiptValidationError,
        AttributeError,
        TypeError,
        ValueError,
    ):
        return AlpacaRecoveryObservationReason.INTENT_INVALID
    if intent.broker_route != "alpaca":
        return AlpacaRecoveryObservationReason.ROUTE_INVALID
    if intent.operation != "submit_order":
        return AlpacaRecoveryObservationReason.OPERATION_INVALID
    if (
        intent.submission_claim_id is None
        or intent.target.kind != "order"
        or intent.target.key != intent.client_request_id
    ):
        return AlpacaRecoveryObservationReason.LINKAGE_INVALID
    return None


def _canonical_request(intent: BrokerMutationIntent) -> Mapping[str, object] | None:
    try:
        document = json.loads(intent.canonical_intent_json)
    except (TypeError, ValueError):  # pragma: no cover - verifier owns this failure
        return None
    if not isinstance(document, Mapping):
        return None
    request = cast(Mapping[str, object], document).get("request")
    if not isinstance(request, Mapping):
        return None
    untyped_request = cast(Mapping[object, object], request)
    if any(not isinstance(key, str) for key in untyped_request):
        return None
    return cast(Mapping[str, object], untyped_request)


def _request_sizing(
    request: Mapping[str, object],
) -> Decimal | AlpacaRecoveryObservationReason:
    if request.get("notional") is not None:
        return AlpacaRecoveryObservationReason.NOTIONAL_INDETERMINATE
    normalized_qty = _decimal(request.get("qty"), positive=True, allow_zero=False)
    if normalized_qty is None:
        return AlpacaRecoveryObservationReason.REQUEST_QTY_INVALID
    return normalized_qty


def _parse_terms(
    payload: Mapping[str, object],
    *,
    qty: Decimal,
    broker: bool,
) -> AlpacaOrderTerms | None:
    symbol = _bounded_text(payload.get("symbol"), maximum=32)
    side = _lower_text(payload.get("side"), maximum=8)
    type_key = "type" if broker else _request_type_key(payload)
    if type_key is None:
        return None
    order_type = _lower_text(payload.get(type_key), maximum=32)
    time_in_force = _lower_text(payload.get("time_in_force"), maximum=16)
    order_class = _normalized_order_class(payload.get("order_class"), broker=broker)
    position_intent = _optional_position_intent(payload.get("position_intent"))
    extended_hours = payload.get("extended_hours")
    if (
        symbol is None
        or _SYMBOL.fullmatch(symbol) is None
        or side not in {"buy", "sell"}
        or order_type not in _ORDER_TYPES
        or time_in_force not in _TIME_IN_FORCE
        or order_class != "simple"
        or position_intent is _INVALID
        or not isinstance(extended_hours, bool)
    ):
        return None
    prices = _parse_prices(payload)
    if prices is None or not _price_contract_is_valid(order_type, prices):
        return None
    return AlpacaOrderTerms(
        symbol=symbol,
        side=side,
        qty=qty,
        order_type=order_type,
        time_in_force=time_in_force,
        limit_price=prices[0],
        stop_price=prices[1],
        trail_price=prices[2],
        trail_percent=prices[3],
        order_class=order_class,
        position_intent=cast(str | None, position_intent),
        extended_hours=extended_hours,
    )


def _parse_prices(
    payload: Mapping[str, object],
) -> tuple[Decimal | None, Decimal | None, Decimal | None, Decimal | None] | None:
    parsed = tuple(
        _optional_positive_decimal(payload.get(field))
        for field in ("limit_price", "stop_price", "trail_price", "trail_percent")
    )
    if _INVALID in parsed:
        return None
    return cast(
        tuple[Decimal | None, Decimal | None, Decimal | None, Decimal | None],
        parsed,
    )


def _request_type_key(payload: Mapping[str, object]) -> str | None:
    present = [key for key in ("order_type", "type") if key in payload]
    return present[0] if len(present) == 1 else None


def _normalized_order_class(value: object, *, broker: bool) -> str | None:
    if broker and isinstance(value, str) and value == "":
        return "simple"
    return _lower_text(value, maximum=32)


def _validate_broker_account(
    payload: Mapping[str, object],
    *,
    observed_account: str,
) -> AlpacaRecoveryObservationReason | None:
    account_values = [
        payload[key]
        for key in ("alpaca_account_label", "account_label")
        if key in payload
    ]
    if not account_values:
        return None
    normalized = [_bounded_text(value, maximum=64) for value in account_values]
    if any(value is None for value in normalized):
        return AlpacaRecoveryObservationReason.BROKER_PAYLOAD_INVALID
    if any(value != observed_account for value in normalized):
        return AlpacaRecoveryObservationReason.ACCOUNT_MISMATCH
    return None


def _parse_fill(
    payload: Mapping[str, object],
) -> tuple[Decimal, Decimal | None] | None:
    if "filled_qty" not in payload or "filled_avg_price" not in payload:
        return None
    filled_qty = _decimal(payload.get("filled_qty"), positive=False, allow_zero=True)
    if filled_qty is None:
        return None
    raw_avg = payload.get("filled_avg_price")
    if raw_avg is None:
        return filled_qty, None
    avg_price = _decimal(raw_avg, positive=False, allow_zero=True)
    if avg_price is None:
        return None
    if filled_qty == 0 and avg_price == 0:
        return filled_qty, None
    return filled_qty, avg_price


def _lifecycle_is_valid(
    *,
    status: str,
    submitted_qty: Decimal,
    filled_qty: Decimal,
    filled_avg_price: Decimal | None,
) -> bool:
    if filled_qty > submitted_qty or (
        filled_avg_price is not None and filled_avg_price <= 0
    ):
        return False
    if (filled_qty == 0) != (filled_avg_price is None):
        return False
    if (status == "filled" and filled_qty != submitted_qty) or (
        filled_qty == submitted_qty and status not in _FULL_FILL_PERMITTED_STATUSES
    ):
        return False
    if status == "partially_filled" and not 0 < filled_qty < submitted_qty:
        return False
    if status in _ZERO_FILL_STATUSES and filled_qty != 0:
        return False
    return True


def _price_contract_is_valid(
    order_type: str,
    prices: tuple[Decimal | None, Decimal | None, Decimal | None, Decimal | None],
) -> bool:
    limit_price, stop_price, trail_price, trail_percent = prices
    if order_type == "market":
        return all(value is None for value in prices)
    if order_type == "limit":
        return limit_price is not None and all(
            value is None for value in (stop_price, trail_price, trail_percent)
        )
    if order_type == "stop":
        return stop_price is not None and all(
            value is None for value in (limit_price, trail_price, trail_percent)
        )
    if order_type == "stop_limit":
        return (
            limit_price is not None
            and stop_price is not None
            and all(value is None for value in (trail_price, trail_percent))
        )
    return (
        limit_price is None
        and stop_price is None
        and (trail_price is None) != (trail_percent is None)
    )


def _decimal(
    value: object,
    *,
    positive: bool,
    allow_zero: bool,
) -> Decimal | None:
    if (
        isinstance(value, bool)
        or isinstance(value, float)
        or not isinstance(value, (str, int, Decimal))
    ):
        return None
    try:
        normalized = Decimal(value)
    except (InvalidOperation, ValueError):
        return None
    if not normalized.is_finite():
        return None
    if (
        normalized < 0
        or (positive and normalized == 0)
        or (not allow_zero and normalized == 0)
    ):
        return None
    if normalized == 0:
        normalized = Decimal("0")
    sign, digits, exponent = normalized.as_tuple()
    del sign
    normalized_exponent = cast(int, exponent)
    scale = max(-normalized_exponent, 0)
    integer_digits = max(len(digits) + normalized_exponent, 0)
    if scale > 8 or integer_digits > 12:
        return None
    return normalized


class _Invalid:
    pass


_INVALID = _Invalid()


def _optional_positive_decimal(value: object) -> Decimal | None | _Invalid:
    if value is None:
        return None
    normalized = _decimal(value, positive=True, allow_zero=False)
    return normalized if normalized is not None else _INVALID


def _bounded_text(value: object, *, maximum: int) -> str | None:
    if not isinstance(value, str):
        return None
    if not value or value != value.strip() or len(value) > maximum:
        return None
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        return None
    return value


def _lower_text(value: object, *, maximum: int) -> str | None:
    normalized = _bounded_text(value, maximum=maximum)
    return normalized.lower() if normalized is not None else None


def _optional_lower_text(value: object, *, maximum: int) -> str | None | _Invalid:
    if value is None:
        return None
    normalized = _lower_text(value, maximum=maximum)
    return normalized if normalized is not None else _INVALID


def _optional_position_intent(value: object) -> str | None | _Invalid:
    normalized = _optional_lower_text(value, maximum=32)
    if normalized is None or normalized is _INVALID:
        return normalized
    return normalized if normalized in _POSITION_INTENTS else _INVALID


def _indeterminate(
    reason: AlpacaRecoveryObservationReason,
) -> AlpacaRecoveryObservation:
    return AlpacaRecoveryObservation(
        outcome=AlpacaRecoveryObservationOutcome.INDETERMINATE,
        reason=reason,
        order=None,
    )


__all__ = [
    "AlpacaOrderTerms",
    "AlpacaRecoveryObservation",
    "AlpacaRecoveryObservationOutcome",
    "AlpacaRecoveryObservationReason",
    "ValidatedAlpacaRecoveryOrder",
    "validate_alpaca_recovery_observation",
]
