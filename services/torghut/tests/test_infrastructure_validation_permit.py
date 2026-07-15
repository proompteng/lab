from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from app.trading.evidence_contracts import (
    ArtifactProvenance,
    EvidenceMaturity,
    evidence_contract_payload,
    parse_evidence_contract,
)
from app.trading.infrastructure_validation import (
    InfrastructureValidationLifecyclePlan,
    InfrastructureValidationOrderPlan,
    InfrastructureValidationPermit,
    authorize_infrastructure_validation,
    authorize_infrastructure_validation_order,
    infrastructure_validation_client_order_id,
    infrastructure_validation_lifecycle_plan_sha256,
    infrastructure_validation_order_plan_sha256,
    infrastructure_validation_request_payload,
    infrastructure_validation_terminal_state_sha256,
    is_infrastructure_validation_lifecycle_plan_schema,
)


_NOW = datetime(2026, 7, 14, 12, 0, tzinfo=timezone.utc)


@pytest.mark.parametrize(
    ("schema_version", "expected"),
    (
        ("torghut.infrastructure-validation-lifecycle-plan.v1", True),
        ("torghut.infrastructure-validation-lifecycle-plan.v2", True),
        ("torghut.infrastructure-validation-lifecycle-plan.v3", False),
        (" torghut.infrastructure-validation-lifecycle-plan.v2", False),
        (None, False),
    ),
)
def test_lifecycle_schema_recognizer_is_explicitly_version_bounded(
    schema_version: object,
    expected: bool,
) -> None:
    assert (
        is_infrastructure_validation_lifecycle_plan_schema(schema_version) is expected
    )


def _permit_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "schema_version": "torghut.infrastructure-validation-permit.v2",
        "permit_id": "ivp-20260714-001",
        "purpose": "control_plane_validation",
        "venue": "alpaca",
        "asset_class": "equity",
        "account_mode": "paper",
        "market_session": "regular",
        "account_label": "dedicated-validation-paper",
        "broker_base_url": "https://paper-api.alpaca.markets",
        "symbols": ["AAPL"],
        "sides": ["buy", "sell"],
        "order_types": ["limit"],
        "max_orders": 1,
        "max_outstanding_intents": 1,
        "max_notional_usd": "10",
        "max_loss_usd": "1",
        "issued_by": "infrastructure-owner",
        "approved_by": "independent-infrastructure-owner",
        "issued_at": _NOW,
        "expires_at": _NOW + timedelta(minutes=5),
        "test_plan_digest": "a" * 64,
        "expected_terminal_state": "no_open_orders_no_positions_no_unsettled_claims",
        "expected_terminal_state_digest": "b" * 64,
        "evidence_tag": "non_promotable_validation",
        "promotable": False,
    }
    payload.update(overrides)
    return payload


def test_dedicated_paper_permit_is_short_lived_and_non_promotable() -> None:
    permit = InfrastructureValidationPermit.model_validate(_permit_payload())

    authorize_infrastructure_validation(
        permit,
        account_label="dedicated-validation-paper",
        account_mode="paper",
        broker_base_url="https://paper-api.alpaca.markets",
        now=_NOW,
    )
    assert permit.promotable is False
    assert permit.evidence_tag == "non_promotable_validation"


@pytest.mark.parametrize(
    "overrides",
    [
        {"account_mode": "live"},
        {"broker_base_url": "https://api.alpaca.markets"},
        {"broker_base_url": "https://paper-api.alpaca.markets:444"},
        {"broker_base_url": "https://paper-api.alpaca.markets/v2"},
        {"broker_base_url": "https://paper-api.alpaca.markets?token=secret"},
        {"market_session": "continuous"},
        {"promotable": True},
        {"evidence_tag": "paper_runtime_observed"},
        {"approved_by": "infrastructure-owner"},
        {"expires_at": _NOW + timedelta(hours=2)},
        {"max_notional_usd": "Infinity"},
        {"symbols": ["AAPL", "aapl"]},
        {"symbols": ["AAPL", ""]},
        {"sides": ["buy", "buy"]},
        {"approved_by": "Infrastructure-Owner"},
        {"max_orders": 1, "max_outstanding_intents": 2},
    ],
)
def test_live_promotable_or_unbounded_permits_fail_schema_validation(
    overrides: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        InfrastructureValidationPermit.model_validate(_permit_payload(**overrides))


def test_runtime_binding_rejects_an_expired_or_different_account() -> None:
    permit = InfrastructureValidationPermit.model_validate(_permit_payload())

    with pytest.raises(ValueError, match="infrastructure_validation_permit_expired"):
        authorize_infrastructure_validation(
            permit,
            account_label=permit.account_label,
            account_mode="paper",
            broker_base_url=str(permit.broker_base_url),
            now=permit.expires_at,
        )
    with pytest.raises(ValueError, match="account_mismatch"):
        authorize_infrastructure_validation(
            permit,
            account_label="some-other-paper-account",
            account_mode="paper",
            broker_base_url=str(permit.broker_base_url),
            now=_NOW,
        )


def test_hyperliquid_permit_requires_the_testnet_boundary() -> None:
    permit = InfrastructureValidationPermit.model_validate(
        _permit_payload(
            venue="hyperliquid",
            asset_class="perpetual",
            account_mode="sandbox",
            market_session="continuous",
            broker_base_url="https://api.hyperliquid-testnet.xyz",
        )
    )

    assert permit.venue == "hyperliquid"
    assert permit.account_mode == "sandbox"


def test_crypto_ioc_plan_is_immutably_bound_to_one_non_promotable_identity() -> None:
    plan = InfrastructureValidationOrderPlan.model_validate(
        {
            "schema_version": "torghut.infrastructure-validation-order-plan.v1",
            "venue": "alpaca",
            "asset_class": "crypto",
            "symbol": "BTC/USD",
            "side": "buy",
            "qty": "1",
            "order_type": "limit",
            "time_in_force": "ioc",
            "limit_price": "1",
            "stop_price": None,
        }
    )
    permit = InfrastructureValidationPermit.model_validate(
        _permit_payload(
            asset_class="crypto",
            market_session="continuous",
            symbols=["BTC/USD"],
            sides=["buy"],
            order_types=["limit"],
            max_notional_usd="1",
            max_loss_usd="1",
            test_plan_digest=infrastructure_validation_order_plan_sha256(plan),
            expected_terminal_state_digest=infrastructure_validation_terminal_state_sha256(),
        )
    )

    authorize_infrastructure_validation_order(
        permit,
        plan,
        account_label=permit.account_label,
        broker_base_url="https://paper-api.alpaca.markets",
        now=_NOW,
    )
    client_order_id = infrastructure_validation_client_order_id(permit, plan)
    payload = infrastructure_validation_request_payload(permit, plan)

    assert len(client_order_id) == 48
    assert client_order_id.startswith("ivp-")
    assert payload["broker_request"]["extra_params"] == {
        "client_order_id": client_order_id
    }
    validation = payload["infrastructure_validation"]
    assert validation["permit"]["evidence_tag"] == "non_promotable_validation"
    assert validation["permit"]["promotable"] is False


def test_lifecycle_plan_allows_one_bounded_fill_and_only_resting_reductions() -> None:
    plan = InfrastructureValidationLifecyclePlan.model_validate(
        {
            "schema_version": "torghut.infrastructure-validation-lifecycle-plan.v2",
            "venue": "alpaca",
            "asset_class": "crypto",
            "symbol": "BTC/USD",
            "side": "buy",
            "qty": "0.0004",
            "order_type": "limit",
            "time_in_force": "ioc",
            "limit_price": "70000",
            "stop_price": None,
            "resting_close_limit_price": "130000",
            "replacement_close_limit_price": "140000",
            "partial_close_qty": "0.0002",
        }
    )
    permit = InfrastructureValidationPermit.model_validate(
        _permit_payload(
            asset_class="crypto",
            market_session="continuous",
            symbols=["BTC/USD"],
            sides=["buy"],
            order_types=["limit"],
            max_notional_usd="30",
            max_loss_usd="30",
            test_plan_digest=infrastructure_validation_lifecycle_plan_sha256(plan),
            expected_terminal_state_digest=infrastructure_validation_terminal_state_sha256(),
        )
    )

    authorize_infrastructure_validation_order(
        permit,
        plan,
        account_label=permit.account_label,
        broker_base_url="https://paper-api.alpaca.markets",
        now=_NOW,
    )

    assert plan.notional_usd == 28
    assert (
        infrastructure_validation_request_payload(permit, plan)["broker_request"][
            "limit_price"
        ]
        == "70000"
    )


@pytest.mark.parametrize(
    ("partial_close_qty", "error"),
    [
        ("0.0001", "partial_close_plan_notional_below_broker_cost_basis_floor"),
        ("0.0003", "residual_close_plan_notional_below_broker_cost_basis_floor"),
    ],
)
def test_lifecycle_authority_requires_two_broker_valid_close_legs(
    partial_close_qty: str,
    error: str,
) -> None:
    plan = InfrastructureValidationLifecyclePlan.model_validate(
        {
            "schema_version": "torghut.infrastructure-validation-lifecycle-plan.v2",
            "venue": "alpaca",
            "asset_class": "crypto",
            "symbol": "BTC/USD",
            "side": "buy",
            "qty": "0.0004",
            "order_type": "limit",
            "time_in_force": "ioc",
            "limit_price": "70000",
            "stop_price": None,
            "resting_close_limit_price": "130000",
            "replacement_close_limit_price": "140000",
            "partial_close_qty": partial_close_qty,
        }
    )
    permit = InfrastructureValidationPermit.model_validate(
        _permit_payload(
            asset_class="crypto",
            market_session="continuous",
            symbols=["BTC/USD"],
            sides=["buy"],
            order_types=["limit"],
            max_notional_usd="30",
            max_loss_usd="30",
            test_plan_digest=infrastructure_validation_lifecycle_plan_sha256(plan),
            expected_terminal_state_digest=infrastructure_validation_terminal_state_sha256(),
        )
    )

    with pytest.raises(ValueError, match=error):
        authorize_infrastructure_validation_order(
            permit,
            plan,
            account_label=permit.account_label,
            broker_base_url="https://paper-api.alpaca.markets",
            now=_NOW,
        )


@pytest.mark.parametrize(
    ("overrides", "error"),
    [
        ({"partial_close_qty": "0.00004"}, "partial_close_not_partial"),
        ({"resting_close_limit_price": "100000"}, "close_price_not_resting"),
        (
            {"replacement_close_limit_price": "125000"},
            "replacement_not_resting",
        ),
    ],
)
def test_lifecycle_plan_rejects_nonreducing_schedule(
    overrides: dict[str, object],
    error: str,
) -> None:
    payload: dict[str, object] = {
        "schema_version": "torghut.infrastructure-validation-lifecycle-plan.v2",
        "venue": "alpaca",
        "asset_class": "crypto",
        "symbol": "BTC/USD",
        "side": "buy",
        "qty": "0.00004",
        "order_type": "limit",
        "time_in_force": "ioc",
        "limit_price": "100000",
        "stop_price": None,
        "resting_close_limit_price": "125000",
        "replacement_close_limit_price": "150000",
        "partial_close_qty": "0.00002",
    }
    payload.update(overrides)

    with pytest.raises(ValidationError, match=error):
        InfrastructureValidationLifecyclePlan.model_validate(payload)


@pytest.mark.parametrize(
    ("permit_overrides", "plan_overrides", "error"),
    [
        ({"max_orders": 2}, {}, "requires_single_intent"),
        ({"symbols": ["BTC/USD", "ETH/USD"]}, {}, "bounds_not_exact"),
        ({"sides": ["buy", "sell"]}, {}, "bounds_not_exact"),
        ({"order_types": ["limit", "market"]}, {}, "bounds_not_exact"),
        (
            {"max_notional_usd": "0.5", "max_loss_usd": "0.5"},
            {},
            "notional_out_of_bounds",
        ),
        (
            {"max_notional_usd": "2", "max_loss_usd": "1"},
            {},
            "exceeds_absolute_cap",
        ),
        ({"symbols": ["ETH/USD"]}, {}, "symbol_out_of_bounds"),
        ({"sides": ["sell"]}, {}, "side_out_of_bounds"),
    ],
)
def test_order_plan_cannot_escape_permit_bounds(
    permit_overrides: dict[str, object],
    plan_overrides: dict[str, object],
    error: str,
) -> None:
    plan_payload: dict[str, object] = {
        "schema_version": "torghut.infrastructure-validation-order-plan.v1",
        "venue": "alpaca",
        "asset_class": "crypto",
        "symbol": "BTC/USD",
        "side": "buy",
        "qty": "1",
        "order_type": "limit",
        "time_in_force": "ioc",
        "limit_price": "1",
        "stop_price": None,
    }
    plan_payload.update(plan_overrides)
    plan = InfrastructureValidationOrderPlan.model_validate(plan_payload)
    permit_payload = _permit_payload(
        asset_class="crypto",
        market_session="continuous",
        symbols=["BTC/USD"],
        sides=["buy"],
        order_types=["limit"],
        max_notional_usd="1",
        max_loss_usd="1",
        test_plan_digest=infrastructure_validation_order_plan_sha256(plan),
        expected_terminal_state_digest=infrastructure_validation_terminal_state_sha256(),
    )
    permit_payload.update(permit_overrides)
    permit = InfrastructureValidationPermit.model_validate(permit_payload)

    with pytest.raises(ValueError, match=error):
        authorize_infrastructure_validation_order(
            permit,
            plan,
            account_label=permit.account_label,
            broker_base_url="https://paper-api.alpaca.markets",
            now=_NOW,
        )


def test_submit_plan_rejects_a_short_or_sell_probe() -> None:
    with pytest.raises(ValidationError):
        InfrastructureValidationOrderPlan.model_validate(
            {
                "schema_version": "torghut.infrastructure-validation-order-plan.v1",
                "venue": "alpaca",
                "asset_class": "crypto",
                "symbol": "BTC/USD",
                "side": "sell",
                "qty": "1",
                "order_type": "limit",
                "time_in_force": "ioc",
                "limit_price": "1",
                "stop_price": None,
            }
        )


def test_submit_plan_does_not_claim_unimplemented_equity_session_authority() -> None:
    with pytest.raises(ValidationError):
        InfrastructureValidationOrderPlan.model_validate(
            {
                "schema_version": "torghut.infrastructure-validation-order-plan.v1",
                "venue": "alpaca",
                "asset_class": "equity",
                "symbol": "AAPL",
                "side": "buy",
                "qty": "1",
                "order_type": "limit",
                "time_in_force": "ioc",
                "limit_price": "1",
                "stop_price": None,
            }
        )


def test_validation_provenance_is_non_authoritative() -> None:
    contract = evidence_contract_payload(
        provenance=ArtifactProvenance.NON_PROMOTABLE_VALIDATION,
        maturity=EvidenceMaturity.EMPIRICALLY_VALIDATED,
        authoritative=True,
    )

    assert contract["authoritative"] is False
    assert contract["placeholder"] is False
    assert (
        parse_evidence_contract(
            {
                **contract,
                "authoritative": True,
            }
        )["authoritative"]
        is False
    )
