from __future__ import annotations

import uuid
from dataclasses import replace
from decimal import Decimal

import pytest
from alpaca.trading.enums import OrderStatus

from app.trading.broker_mutation_receipts import (
    BrokerMutationIntentRequest,
    BrokerMutationTarget,
    build_broker_mutation_intent,
)
from app.trading.execution.alpaca_recovery_observation import (
    AlpacaRecoveryObservationOutcome,
    AlpacaRecoveryObservationReason,
    validate_alpaca_recovery_observation,
)


_DECISION_ID = uuid.UUID("00000000-0000-0000-0000-000000000101")
_CLIENT_ORDER_ID = "client-order-101"
_PINNED_ORDER_STATUSES = frozenset(
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
        "rejected",
        "replaced",
        "stopped",
        "suspended",
    }
)
_ZERO_FILL_ORDER_STATUSES = frozenset(
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
_FULL_FILL_PERMITTED_ORDER_STATUSES = frozenset({"calculated", "filled"})
_PARTIAL_OR_ZERO_ORDER_STATUSES = _PINNED_ORDER_STATUSES.difference(
    _ZERO_FILL_ORDER_STATUSES,
    {"filled", "partially_filled"},
)


def _request(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "symbol": "AAPL",
        "side": "buy",
        "qty": Decimal("2"),
        "notional": None,
        "order_type": "limit",
        "time_in_force": "day",
        "limit_price": Decimal("190.25"),
        "stop_price": None,
        "trail_price": None,
        "trail_percent": None,
        "order_class": "simple",
        "position_intent": "buy_to_open",
        "extended_hours": False,
    }
    payload.update(overrides)
    return payload


def _intent(
    *,
    broker_route: str = "alpaca",
    operation: str = "submit_order",
    target: BrokerMutationTarget | None = None,
    submission_claim_id: uuid.UUID | None = _DECISION_ID,
    **request_overrides: object,
):
    return build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route=broker_route,
            account_label="paper-primary",
            endpoint_fingerprint="a" * 64,
            operation=operation,
            risk_class="risk_increasing",
            purpose="initial_submission",
            workflow_id="decision/101",
            client_request_id=_CLIENT_ORDER_ID,
            target=target or BrokerMutationTarget(kind="order", key=_CLIENT_ORDER_ID),
            request_payload=_request(**request_overrides),
            submission_claim_id=submission_claim_id,
        )
    )


def _broker_order(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": "broker-order-101",
        "client_order_id": _CLIENT_ORDER_ID,
        "status": "accepted",
        "symbol": "AAPL",
        "side": "buy",
        "qty": "2",
        "notional": None,
        "type": "limit",
        "time_in_force": "day",
        "limit_price": "190.25",
        "stop_price": None,
        "trail_price": None,
        "trail_percent": None,
        "order_class": "simple",
        "position_intent": "buy_to_open",
        "extended_hours": False,
        "filled_qty": "0",
        "filled_avg_price": None,
    }
    payload.update(overrides)
    return payload


def _observe(
    *,
    intent=None,
    account_label: object = "paper-primary",
    broker_order: object | None = None,
    expected_broker_order_id: object | None = None,
):
    return validate_alpaca_recovery_observation(
        intent=intent or _intent(),
        account_label=account_label,
        broker_order=_broker_order() if broker_order is None else broker_order,
        expected_broker_order_id=expected_broker_order_id,
    )


def _assert_indeterminate(
    reason: AlpacaRecoveryObservationReason,
    *,
    result,
) -> None:
    assert result.outcome is AlpacaRecoveryObservationOutcome.INDETERMINATE
    assert result.reason is reason
    assert result.order is None
    assert not result.validated


def test_valid_quantity_observation_preserves_exact_broker_truth() -> None:
    result = _observe(
        broker_order=_broker_order(
            status="partially_filled",
            filled_qty="0.75",
            filled_avg_price="190.125",
            alpaca_account_label="paper-primary",
        ),
        expected_broker_order_id="broker-order-101",
    )

    assert result.outcome is AlpacaRecoveryObservationOutcome.VALIDATED
    assert result.reason is None
    assert result.validated
    assert result.order is not None
    assert result.order.account_label == "paper-primary"
    assert result.order.broker_order_id == "broker-order-101"
    assert result.order.client_order_id == _CLIENT_ORDER_ID
    assert result.order.status == "partially_filled"
    assert result.order.filled_qty == Decimal("0.75")
    assert result.order.filled_avg_price == Decimal("190.125")
    assert result.order.terms.qty == Decimal("2")
    assert result.order.terms.limit_price == Decimal("190.25")
    assert result.order.terms.position_intent == "buy_to_open"


def test_blank_broker_order_class_normalizes_to_explicit_simple_intent() -> None:
    result = _observe(broker_order=_broker_order(order_class=""))

    assert result.validated
    assert result.order is not None
    assert result.order.terms.order_class == "simple"


def test_blank_canonical_order_class_remains_indeterminate() -> None:
    _assert_indeterminate(
        AlpacaRecoveryObservationReason.REQUEST_TERMS_INVALID,
        result=_observe(
            intent=_intent(order_class=""),
            broker_order=_broker_order(order_class=""),
        ),
    )


@pytest.mark.parametrize("broker_order_class", [" ", None, False, 0])
def test_only_exact_broker_blank_class_normalizes_to_simple(
    broker_order_class: object,
) -> None:
    _assert_indeterminate(
        AlpacaRecoveryObservationReason.ORDER_IDENTITY_MISMATCH,
        result=_observe(broker_order=_broker_order(order_class=broker_order_class)),
    )


def test_notional_intent_cannot_be_recovered_from_computed_broker_qty() -> None:
    result = _observe(
        intent=_intent(qty=None, notional=Decimal("100")),
        broker_order=_broker_order(
            qty="0.525624",
            notional=None,
            status="filled",
            filled_qty="0.525624",
            filled_avg_price="190.25",
        ),
    )

    _assert_indeterminate(
        AlpacaRecoveryObservationReason.NOTIONAL_INDETERMINATE,
        result=result,
    )


def test_qty_plus_notional_intent_is_always_indeterminate() -> None:
    _assert_indeterminate(
        AlpacaRecoveryObservationReason.NOTIONAL_INDETERMINATE,
        result=_observe(intent=_intent(notional=Decimal("100"))),
    )


@pytest.mark.parametrize(
    ("intent", "reason"),
    [
        (
            _intent(broker_route="hyperliquid"),
            AlpacaRecoveryObservationReason.ROUTE_INVALID,
        ),
        (
            _intent(operation="replace_order"),
            AlpacaRecoveryObservationReason.OPERATION_INVALID,
        ),
        (
            _intent(target=BrokerMutationTarget(kind="order", key="different-client")),
            AlpacaRecoveryObservationReason.LINKAGE_INVALID,
        ),
    ],
)
def test_intent_route_operation_and_linkage_are_fail_closed(intent, reason) -> None:
    _assert_indeterminate(reason, result=_observe(intent=intent))


def test_tampered_intent_is_nonterminal_invalid_data() -> None:
    intent = _intent()
    tampered = replace(intent, canonical_intent_sha256="f" * 64)

    _assert_indeterminate(
        AlpacaRecoveryObservationReason.INTENT_INVALID,
        result=_observe(intent=tampered),
    )


@pytest.mark.parametrize("account_label", [None, "", "   ", 7])
def test_account_is_explicitly_required_without_a_default(
    account_label: object,
) -> None:
    _assert_indeterminate(
        AlpacaRecoveryObservationReason.ACCOUNT_REQUIRED,
        result=_observe(account_label=account_label),
    )


@pytest.mark.parametrize(
    ("account_label", "broker_overrides"),
    [
        ("paper-secondary", {}),
        (" paper-primary ", {}),
        ("paper-primary", {"alpaca_account_label": "paper-secondary"}),
        ("paper-primary", {"account_label": "paper-secondary"}),
        (
            "paper-primary",
            {
                "account_label": "paper-primary",
                "alpaca_account_label": "paper-secondary",
            },
        ),
    ],
)
def test_account_context_and_payload_cannot_drift(
    account_label: object,
    broker_overrides: dict[str, object],
) -> None:
    _assert_indeterminate(
        AlpacaRecoveryObservationReason.ACCOUNT_MISMATCH,
        result=_observe(
            account_label=account_label,
            broker_order=_broker_order(**broker_overrides),
        ),
    )


@pytest.mark.parametrize(
    "request_overrides",
    [
        {"qty": None},
        {"qty": "not-a-number"},
        {"qty": Decimal("0")},
        {"qty": Decimal("-1")},
        {"qty": Decimal("1.000000001")},
        {"qty": Decimal("1000000000000")},
    ],
)
def test_original_quantity_must_be_positive_exact_numeric_20_8(
    request_overrides: dict[str, object],
) -> None:
    _assert_indeterminate(
        AlpacaRecoveryObservationReason.REQUEST_QTY_INVALID,
        result=_observe(intent=_intent(**request_overrides)),
    )


@pytest.mark.parametrize(
    ("intent_overrides", "broker_overrides", "reason"),
    [
        (
            {"qty": "1e13"},
            {},
            AlpacaRecoveryObservationReason.REQUEST_QTY_INVALID,
        ),
        (
            {},
            {"qty": "1e13"},
            AlpacaRecoveryObservationReason.BROKER_PAYLOAD_INVALID,
        ),
        (
            {},
            {"qty": Decimal("1e13")},
            AlpacaRecoveryObservationReason.BROKER_PAYLOAD_INVALID,
        ),
        (
            {},
            {"filled_qty": "1e13"},
            AlpacaRecoveryObservationReason.BROKER_FILL_INVALID,
        ),
        (
            {},
            {"filled_avg_price": "1e13"},
            AlpacaRecoveryObservationReason.BROKER_FILL_INVALID,
        ),
        (
            {"limit_price": "1e13"},
            {},
            AlpacaRecoveryObservationReason.REQUEST_TERMS_INVALID,
        ),
        (
            {},
            {"limit_price": "1e13"},
            AlpacaRecoveryObservationReason.ORDER_IDENTITY_MISMATCH,
        ),
    ],
)
def test_positive_exponent_values_cannot_bypass_numeric_20_8_integer_bounds(
    intent_overrides: dict[str, object],
    broker_overrides: dict[str, object],
    reason: AlpacaRecoveryObservationReason,
) -> None:
    _assert_indeterminate(
        reason,
        result=_observe(
            intent=_intent(**intent_overrides),
            broker_order=_broker_order(**broker_overrides),
        ),
    )


def test_twelve_integer_digit_scientific_values_remain_in_bounds() -> None:
    result = _observe(
        intent=_intent(qty="1e11", limit_price="1e11"),
        broker_order=_broker_order(
            qty="1e11",
            limit_price="1e11",
            filled_qty="0e13",
        ),
    )

    assert result.validated
    assert result.order is not None
    assert result.order.terms.qty == Decimal("1e11")
    assert result.order.terms.limit_price == Decimal("1e11")
    assert result.order.filled_qty == Decimal("0")


@pytest.mark.parametrize(
    "request_overrides",
    [
        {"symbol": "aapl"},
        {"side": "hold"},
        {"order_type": "unknown"},
        {"time_in_force": "never"},
        {"limit_price": None},
        {"limit_price": Decimal("0")},
        {"limit_price": Decimal("190.25"), "stop_price": Decimal("180")},
        {"trail_price": Decimal("1")},
        {"order_class": None},
        {"order_class": ""},
        {"position_intent": 1},
        {"extended_hours": "false"},
        {"type": "limit"},
    ],
)
def test_original_order_terms_must_be_unambiguous_and_complete(
    request_overrides: dict[str, object],
) -> None:
    _assert_indeterminate(
        AlpacaRecoveryObservationReason.REQUEST_TERMS_INVALID,
        result=_observe(intent=_intent(**request_overrides)),
    )


@pytest.mark.parametrize(
    ("order_class", "nested_terms"),
    [
        (
            "bracket",
            {
                "take_profit": {"limit_price": Decimal("210")},
                "stop_loss": {"stop_price": Decimal("180")},
            },
        ),
        (
            "oto",
            {"take_profit": {"limit_price": Decimal("210")}},
        ),
        (
            "oco",
            {
                "legs": [
                    {"type": "limit", "limit_price": Decimal("210")},
                    {"type": "stop", "stop_price": Decimal("180")},
                ]
            },
        ),
    ],
)
def test_matching_complex_order_classes_remain_indeterminate_until_legs_are_modeled(
    order_class: str,
    nested_terms: dict[str, object],
) -> None:
    result = _observe(
        intent=_intent(order_class=order_class, **nested_terms),
        broker_order=_broker_order(order_class=order_class, **nested_terms),
    )

    _assert_indeterminate(
        AlpacaRecoveryObservationReason.REQUEST_TERMS_INVALID,
        result=result,
    )


@pytest.mark.parametrize("trail_field", ["trail_price", "trail_percent"])
def test_trailing_stop_validates_exactly_one_trail_term(trail_field: str) -> None:
    request_overrides = {
        "order_type": "trailing_stop",
        "limit_price": None,
        trail_field: Decimal("1.25"),
    }
    broker_overrides = {
        "type": "trailing_stop",
        "limit_price": None,
        trail_field: "1.25",
    }

    result = _observe(
        intent=_intent(**request_overrides),
        broker_order=_broker_order(**broker_overrides),
    )

    assert result.validated
    assert result.order is not None
    assert getattr(result.order.terms, trail_field) == Decimal("1.25")


@pytest.mark.parametrize(
    "broker_order",
    [
        None,
        [],
        {1: "non-string-key"},
    ],
)
def test_broker_payload_must_be_a_string_keyed_mapping(broker_order: object) -> None:
    _assert_indeterminate(
        AlpacaRecoveryObservationReason.BROKER_PAYLOAD_INVALID,
        result=validate_alpaca_recovery_observation(
            intent=_intent(),
            account_label="paper-primary",
            broker_order=broker_order,
        ),
    )


@pytest.mark.parametrize("broker_order_id", [None, "", " broker ", 1])
def test_broker_order_id_is_required_and_bounded(broker_order_id: object) -> None:
    _assert_indeterminate(
        AlpacaRecoveryObservationReason.BROKER_ORDER_ID_INVALID,
        result=_observe(broker_order=_broker_order(id=broker_order_id)),
    )


@pytest.mark.parametrize("expected", ["different", "", 7])
def test_known_broker_order_id_must_match_exactly(expected: object) -> None:
    _assert_indeterminate(
        AlpacaRecoveryObservationReason.BROKER_ORDER_ID_MISMATCH,
        result=_observe(expected_broker_order_id=expected),
    )


@pytest.mark.parametrize("client_order_id", [None, "different", 7])
def test_client_order_id_must_match_canonical_linkage(client_order_id: object) -> None:
    _assert_indeterminate(
        AlpacaRecoveryObservationReason.CLIENT_ORDER_ID_MISMATCH,
        result=_observe(broker_order=_broker_order(client_order_id=client_order_id)),
    )


@pytest.mark.parametrize(
    "broker_overrides",
    [
        {"symbol": "MSFT"},
        {"side": "sell"},
        {"qty": "2.00000001"},
        {"notional": "100"},
        {"type": "market", "limit_price": None},
        {"time_in_force": "gtc"},
        {"limit_price": "190.26"},
        {"stop_price": "180"},
        {"trail_percent": "1"},
        {"order_class": "bracket"},
        {"position_intent": "sell_to_close"},
        {"extended_hours": True},
    ],
)
def test_broker_identity_and_all_applicable_terms_must_match_exactly(
    broker_overrides: dict[str, object],
) -> None:
    _assert_indeterminate(
        AlpacaRecoveryObservationReason.ORDER_IDENTITY_MISMATCH,
        result=_observe(broker_order=_broker_order(**broker_overrides)),
    )


@pytest.mark.parametrize("status", [None, "", "unknown", 1])
def test_broker_status_is_explicit_and_recognized(status: object) -> None:
    _assert_indeterminate(
        AlpacaRecoveryObservationReason.BROKER_STATUS_INVALID,
        result=_observe(broker_order=_broker_order(status=status)),
    )


def test_pinned_sdk_order_status_allow_list_has_no_unreviewed_drift() -> None:
    assert frozenset(status.value for status in OrderStatus) == _PINNED_ORDER_STATUSES


@pytest.mark.parametrize("status", tuple(status.value for status in OrderStatus))
@pytest.mark.parametrize(
    ("filled_qty", "filled_avg_price"),
    [("0", None), ("1", "190"), ("2", "190")],
)
def test_every_pinned_status_has_exhaustive_zero_partial_and_full_fill_coverage(
    status: str,
    filled_qty: str,
    filled_avg_price: str | None,
) -> None:
    result = _observe(
        broker_order=_broker_order(
            status=status,
            filled_qty=filled_qty,
            filled_avg_price=filled_avg_price,
        )
    )
    expected_valid = (
        (status in _FULL_FILL_PERMITTED_ORDER_STATUSES and filled_qty == "2")
        or (status == "partially_filled" and filled_qty == "1")
        or (status in _ZERO_FILL_ORDER_STATUSES and filled_qty == "0")
        or (status in _PARTIAL_OR_ZERO_ORDER_STATUSES and filled_qty in {"0", "1"})
    )

    assert result.validated is expected_valid
    if expected_valid:
        assert result.order is not None
        assert result.order.status == status
    else:
        assert result.reason is AlpacaRecoveryObservationReason.BROKER_LIFECYCLE_INVALID
        assert result.order is None


@pytest.mark.parametrize(
    ("filled_qty", "filled_avg_price"),
    [("0", None), ("1", "190"), ("2", "190")],
)
def test_calculated_explicitly_preserves_zero_partial_and_complete_fill_truth(
    filled_qty: str,
    filled_avg_price: str | None,
) -> None:
    result = _observe(
        broker_order=_broker_order(
            status="calculated",
            filled_qty=filled_qty,
            filled_avg_price=filled_avg_price,
        )
    )

    assert result.validated
    assert result.order is not None
    assert result.order.status == "calculated"
    assert result.order.filled_qty == Decimal(filled_qty)


@pytest.mark.parametrize(
    "broker_overrides",
    [
        {"filled_qty": None},
        {"filled_qty": 1.0},
        {"filled_qty": "NaN"},
        {"filled_qty": "-1"},
        {"filled_qty": "0.000000001"},
        {"filled_qty": "1000000000000"},
        {"filled_avg_price": 190.0},
        {"filled_avg_price": "NaN"},
        {"filled_avg_price": "0.000000001"},
    ],
)
def test_fill_numbers_must_be_explicit_finite_and_numeric_20_8(
    broker_overrides: dict[str, object],
) -> None:
    _assert_indeterminate(
        AlpacaRecoveryObservationReason.BROKER_FILL_INVALID,
        result=_observe(broker_order=_broker_order(**broker_overrides)),
    )


@pytest.mark.parametrize("missing", ["filled_qty", "filled_avg_price"])
def test_fill_fields_cannot_be_defaulted_when_missing(missing: str) -> None:
    broker_order = _broker_order()
    del broker_order[missing]

    _assert_indeterminate(
        AlpacaRecoveryObservationReason.BROKER_FILL_INVALID,
        result=_observe(broker_order=broker_order),
    )


@pytest.mark.parametrize(
    "zero_avg_price",
    ["0", "0.00000000", "0e13", Decimal("0"), Decimal("-0")],
)
def test_numeric_zero_average_normalizes_to_none_for_zero_fill(
    zero_avg_price: object,
) -> None:
    result = _observe(
        broker_order=_broker_order(
            status="accepted",
            filled_qty="0",
            filled_avg_price=zero_avg_price,
        )
    )

    assert result.validated
    assert result.order is not None
    assert result.order.filled_qty == Decimal("0")
    assert result.order.filled_avg_price is None


@pytest.mark.parametrize(
    "invalid_avg_price",
    ["", "not-a-number", 0.0, False, True],
)
def test_malformed_float_and_boolean_zero_fill_averages_remain_invalid(
    invalid_avg_price: object,
) -> None:
    _assert_indeterminate(
        AlpacaRecoveryObservationReason.BROKER_FILL_INVALID,
        result=_observe(
            broker_order=_broker_order(
                filled_qty="0",
                filled_avg_price=invalid_avg_price,
            )
        ),
    )


@pytest.mark.parametrize("invalid_filled_qty", ["", "not-a-number", 0.0, False, True])
def test_malformed_float_and_boolean_filled_quantities_remain_invalid(
    invalid_filled_qty: object,
) -> None:
    _assert_indeterminate(
        AlpacaRecoveryObservationReason.BROKER_FILL_INVALID,
        result=_observe(
            broker_order=_broker_order(
                filled_qty=invalid_filled_qty,
                filled_avg_price=None,
            )
        ),
    )


@pytest.mark.parametrize("zero_avg_price", ["0", Decimal("0")])
def test_zero_average_with_positive_fill_remains_lifecycle_invalid(
    zero_avg_price: object,
) -> None:
    _assert_indeterminate(
        AlpacaRecoveryObservationReason.BROKER_LIFECYCLE_INVALID,
        result=_observe(
            broker_order=_broker_order(
                status="partially_filled",
                filled_qty="1",
                filled_avg_price=zero_avg_price,
            )
        ),
    )


@pytest.mark.parametrize("nonzero_avg_price", ["190", Decimal("190")])
def test_nonzero_average_with_zero_fill_remains_lifecycle_invalid(
    nonzero_avg_price: object,
) -> None:
    _assert_indeterminate(
        AlpacaRecoveryObservationReason.BROKER_LIFECYCLE_INVALID,
        result=_observe(
            broker_order=_broker_order(
                filled_qty="0",
                filled_avg_price=nonzero_avg_price,
            )
        ),
    )


@pytest.mark.parametrize(
    "broker_overrides",
    [
        {"filled_qty": "0", "filled_avg_price": "190"},
        {"filled_qty": "0.5", "filled_avg_price": None},
        {"filled_qty": "2.1", "filled_avg_price": "190"},
        {"status": "filled", "filled_qty": "1", "filled_avg_price": "190"},
        {"status": "filled", "filled_qty": "0", "filled_avg_price": None},
        {
            "status": "partially_filled",
            "filled_qty": "0",
            "filled_avg_price": None,
        },
        {
            "status": "partially_filled",
            "filled_qty": "2",
            "filled_avg_price": "190",
        },
        {"status": "accepted", "filled_qty": "1", "filled_avg_price": "190"},
        {"status": "rejected", "filled_qty": "1", "filled_avg_price": "190"},
    ],
)
def test_status_fill_lifecycle_bounds_are_fail_closed(
    broker_overrides: dict[str, object],
) -> None:
    _assert_indeterminate(
        AlpacaRecoveryObservationReason.BROKER_LIFECYCLE_INVALID,
        result=_observe(broker_order=_broker_order(**broker_overrides)),
    )


@pytest.mark.parametrize(
    "broker_overrides",
    [
        {"status": "filled", "filled_qty": "2", "filled_avg_price": "190"},
        {
            "status": "canceled",
            "filled_qty": "0.5",
            "filled_avg_price": "190",
        },
        {"status": "expired", "filled_qty": "0", "filled_avg_price": None},
    ],
)
def test_supported_terminal_and_partial_lifecycle_truth_is_preserved(
    broker_overrides: dict[str, object],
) -> None:
    result = _observe(broker_order=_broker_order(**broker_overrides))

    assert result.validated
    assert result.order is not None
    assert result.order.status == broker_overrides["status"]


def test_reason_values_are_stable_strings_for_future_persistence() -> None:
    assert AlpacaRecoveryObservationReason.NOTIONAL_INDETERMINATE.value == (
        "notional_submission_recovery_indeterminate"
    )
    assert AlpacaRecoveryObservationReason.ACCOUNT_REQUIRED.value == (
        "alpaca_recovery_account_required"
    )
