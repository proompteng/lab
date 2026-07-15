from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import replace
from decimal import Decimal

import pytest

from app.trading.broker_mutation_receipts import (
    build_linked_submission_terminal_settlement,
)
from app.trading.broker_mutation_receipts.canonicalization import (
    build_broker_mutation_intent,
    build_broker_mutation_recovery_observation,
    build_broker_mutation_settlement,
    canonicalize_broker_mutation_evidence,
    fingerprint_broker_endpoint,
    verify_broker_mutation_recovery_observation,
    verify_broker_mutation_settlement,
    verify_canonical_broker_mutation_evidence,
    verify_broker_mutation_intent,
)
from app.trading.broker_mutation_receipts.types import (
    BrokerMutationIntentRequest,
    BrokerMutationLinkedSubmissionSettlementRequest,
    BrokerMutationRecoveryObservationRequest,
    BrokerMutationSettlementRequest,
    BrokerMutationTarget,
)
from app.trading.broker_mutation_receipts.validation import (
    BrokerMutationReceiptValidationError,
)
from app.trading.decision_submission_claims import DecisionSubmissionClaimHandle


def _submit_intent(*, request: dict[str, object]) -> object:
    return build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="alpaca",
            account_label="paper",
            endpoint_fingerprint=fingerprint_broker_endpoint(
                "https://paper-api.alpaca.markets/v2"
            ),
            operation="submit_order",
            risk_class="risk_increasing",
            purpose="initial_submission",
            workflow_id="decision/123",
            client_request_id="a" * 64,
            target=BrokerMutationTarget(kind="order", key="a" * 64),
            request_payload=request,
            submission_claim_id=uuid.UUID("00000000-0000-0000-0000-000000000123"),
        )
    )


def test_endpoint_fingerprint_normalizes_only_credential_free_origin_and_path() -> None:
    assert fingerprint_broker_endpoint(
        "HTTPS://Paper-API.Alpaca.Markets:443/v2/"
    ) == fingerprint_broker_endpoint("https://paper-api.alpaca.markets/v2")

    for invalid in (
        "https://key:secret@paper-api.alpaca.markets/v2",
        "https://paper-api.alpaca.markets/v2?token=secret",
        "https://bad host.example/v2",
        "https://bad_host.example/v2",
        "ftp://paper-api.alpaca.markets/v2",
    ):
        with pytest.raises(BrokerMutationReceiptValidationError):
            fingerprint_broker_endpoint(invalid)


@pytest.mark.parametrize(
    ("variant", "canonical"),
    [
        (
            "https://[2001:0db8:0000:0000:0000:0000:0000:0001]:443/v2/../v3/",
            "https://[2001:db8::1]/v3",
        ),
        ("https://bücher.example./v2", "https://xn--bcher-kva.example/v2"),
        ("http://EXAMPLE.com:80/a/./b/../c/", "http://example.com/a/c"),
    ],
)
def test_endpoint_fingerprint_preserves_host_and_path_normalization(
    variant: str,
    canonical: str,
) -> None:
    assert fingerprint_broker_endpoint(variant) == fingerprint_broker_endpoint(
        canonical
    )


def test_intent_is_stable_and_uses_exact_decimal_strings() -> None:
    first = _submit_intent(
        request={
            "symbol": "AAPL",
            "qty": Decimal("1.2300"),
            "limit_price": Decimal("100.5000"),
            "flags": {"reduce_only": False, "post_only": True},
        }
    )
    second = _submit_intent(
        request={
            "flags": {"post_only": True, "reduce_only": False},
            "limit_price": Decimal("100.5"),
            "qty": Decimal("1.23"),
            "symbol": "AAPL",
        }
    )

    assert first.canonical_intent_sha256 == second.canonical_intent_sha256
    assert first.canonical_intent_json == second.canonical_intent_json
    payload = json.loads(first.canonical_intent_json)
    assert payload["request"]["qty"] == "1.23"
    assert payload["request"]["limit_price"] == "100.5"
    verify_broker_mutation_intent(first)
    with pytest.raises(
        BrokerMutationReceiptValidationError,
        match="intent_mismatch",
    ):
        verify_broker_mutation_intent(replace(first, purpose="operator"))


def test_canonicalization_rejects_floats_controls_and_changed_semantics() -> None:
    with pytest.raises(
        BrokerMutationReceiptValidationError,
        match="request.qty_float_forbidden",
    ):
        _submit_intent(request={"qty": 1.0})
    with pytest.raises(
        BrokerMutationReceiptValidationError,
        match="contains_control_character",
    ):
        _submit_intent(request={"symbol": "AAPL\n"})
    with pytest.raises(
        BrokerMutationReceiptValidationError,
        match="integer_too_large",
    ):
        _submit_intent(request={"qty": 1 << 300_000})

    buy = _submit_intent(request={"side": "buy", "qty": Decimal("1")})
    sell = _submit_intent(request={"side": "sell", "qty": Decimal("1")})
    assert buy.canonical_intent_sha256 != sell.canonical_intent_sha256


@pytest.mark.parametrize(
    "secret_key",
    [
        "Api.Key",
        "access-token",
        "AUTHORIZATION",
        "cookie",
        "db_password",
        "clientSecret",
        "credentials",
        "private-key",
        "bearer",
    ],
)
def test_canonical_payloads_reject_recursive_secret_bearing_keys(
    secret_key: str,
) -> None:
    payload = {"transport": {"metadata": {secret_key: "must-not-persist"}}}

    with pytest.raises(
        BrokerMutationReceiptValidationError,
        match="secret_bearing_key_forbidden",
    ):
        _submit_intent(request=payload)
    with pytest.raises(
        BrokerMutationReceiptValidationError,
        match="secret_bearing_key_forbidden",
    ):
        canonicalize_broker_mutation_evidence(payload)


@pytest.mark.parametrize(
    ("operation", "target", "risk_class", "claim_id"),
    [
        (
            "submit_order",
            BrokerMutationTarget(kind="order", key="order-1"),
            "risk_neutral",
            uuid.uuid4(),
        ),
        (
            "cancel_order",
            BrokerMutationTarget(kind="order", key="order-1"),
            "risk_increasing",
            None,
        ),
        (
            "cancel_all_orders",
            BrokerMutationTarget(kind="account", key="paper"),
            "risk_neutral",
            None,
        ),
    ],
)
def test_non_close_operations_preserve_the_callers_honest_risk_class(
    operation: str,
    target: BrokerMutationTarget,
    risk_class: str,
    claim_id: uuid.UUID | None,
) -> None:
    intent = build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="alpaca",
            account_label="paper",
            endpoint_fingerprint="a" * 64,
            operation=operation,
            risk_class=risk_class,
            purpose="operator",
            workflow_id="workflow-1",
            client_request_id=f"{operation}-request",
            target=target,
            request_payload={"operation": operation},
            submission_claim_id=claim_id,
        )
    )

    assert intent.risk_class == risk_class


def test_replace_is_only_unlinked_risk_neutral_repricing() -> None:
    valid = build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="alpaca",
            account_label="paper",
            endpoint_fingerprint="a" * 64,
            operation="replace_order",
            risk_class="risk_neutral",
            purpose="repricing",
            workflow_id="replace-order-1",
            client_request_id="replace-order-1",
            target=BrokerMutationTarget(kind="order", key="order-1"),
            request_payload={"limit_price": Decimal("100")},
        )
    )
    assert valid.submission_claim_id is None

    with pytest.raises(
        BrokerMutationReceiptValidationError,
        match="replace_order_contract_invalid",
    ):
        build_broker_mutation_intent(
            BrokerMutationIntentRequest(
                broker_route="alpaca",
                account_label="paper",
                endpoint_fingerprint="a" * 64,
                operation="replace_order",
                risk_class="risk_increasing",
                purpose="operator",
                workflow_id="replace-order-linked",
                client_request_id="replace-order-linked",
                target=BrokerMutationTarget(kind="order", key="order-1"),
                request_payload={"limit_price": Decimal("100")},
                submission_claim_id=uuid.uuid4(),
            )
        )

    with pytest.raises(
        BrokerMutationReceiptValidationError,
        match="replace_order_contract_invalid",
    ):
        build_broker_mutation_intent(
            BrokerMutationIntentRequest(
                broker_route="hyperliquid",
                account_label="testnet",
                endpoint_fingerprint="b" * 64,
                operation="replace_order",
                risk_class="risk_neutral",
                purpose="repricing",
                workflow_id="replace-order-hyperliquid",
                client_request_id="replace-order-hyperliquid",
                target=BrokerMutationTarget(kind="order", key="order-1"),
                request_payload={"limit_price": Decimal("100")},
            )
        )


def test_submit_claim_contract_is_route_specific() -> None:
    hyperliquid = build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="hyperliquid",
            account_label="hyperliquid-testnet",
            endpoint_fingerprint="b" * 64,
            operation="submit_order",
            risk_class="risk_increasing",
            purpose="initial_submission",
            workflow_id="signal/signal-1",
            client_request_id="0x" + "1" * 32,
            target=BrokerMutationTarget(kind="order", key="0x" + "1" * 32),
            request_payload={"coin": "BTC", "side": "buy", "size": Decimal("0.01")},
            submission_claim_id=None,
        )
    )

    assert hyperliquid.submission_claim_id is None
    verify_broker_mutation_intent(hyperliquid)

    for broker_route, claim_id in (
        ("alpaca", None),
        ("hyperliquid", uuid.uuid4()),
    ):
        with pytest.raises(
            BrokerMutationReceiptValidationError,
            match="submit_order_route_claim_contract_invalid",
        ):
            build_broker_mutation_intent(
                BrokerMutationIntentRequest(
                    broker_route=broker_route,
                    account_label="paper",
                    endpoint_fingerprint="b" * 64,
                    operation="submit_order",
                    risk_class="risk_increasing",
                    purpose="initial_submission",
                    workflow_id="workflow-1",
                    client_request_id="request-1",
                    target=BrokerMutationTarget(kind="order", key="request-1"),
                    request_payload={"side": "buy", "qty": Decimal("1")},
                    submission_claim_id=claim_id,
                )
            )


def test_unlinked_alpaca_submit_is_limited_to_risk_reducing_closeout() -> None:
    closeout = build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="alpaca",
            account_label="paper",
            endpoint_fingerprint="a" * 64,
            operation="submit_order",
            risk_class="risk_reducing",
            purpose="closeout",
            workflow_id="closeout-1",
            client_request_id="closeout-1",
            target=BrokerMutationTarget(kind="order", key="closeout-1"),
            request_payload={"side": "sell", "qty": Decimal("1")},
        )
    )

    assert closeout.submission_claim_id is None
    for risk_class, purpose in (
        ("risk_increasing", "closeout"),
        ("risk_reducing", "initial_submission"),
        ("risk_neutral", "flatten"),
    ):
        with pytest.raises(
            BrokerMutationReceiptValidationError,
            match="submit_order_route_claim_contract_invalid",
        ):
            build_broker_mutation_intent(
                BrokerMutationIntentRequest(
                    broker_route="alpaca",
                    account_label="paper",
                    endpoint_fingerprint="a" * 64,
                    operation="submit_order",
                    risk_class=risk_class,
                    purpose=purpose,
                    workflow_id="closeout-invalid",
                    client_request_id="closeout-invalid",
                    target=BrokerMutationTarget(
                        kind="order",
                        key="closeout-invalid",
                    ),
                    request_payload={"side": "sell", "qty": Decimal("1")},
                )
            )


@pytest.mark.parametrize(
    ("operation", "target_kind", "target_identifier", "risk_class", "claim_id"),
    [
        ("submit_order", "position", "AAPL", "risk_increasing", uuid.uuid4()),
        ("cancel_all_orders", "order", "order-1", "risk_neutral", None),
        ("close_position", "position", "AAPL", "risk_neutral", None),
        ("close_all_positions", "account", "wrong-account", "risk_reducing", None),
    ],
)
def test_operation_target_and_risk_contract_fails_closed(
    operation: str,
    target_kind: str,
    target_identifier: str,
    risk_class: str,
    claim_id: uuid.UUID | None,
) -> None:
    with pytest.raises(BrokerMutationReceiptValidationError):
        build_broker_mutation_intent(
            BrokerMutationIntentRequest(
                broker_route="alpaca",
                account_label="paper",
                endpoint_fingerprint="a" * 64,
                operation=operation,
                risk_class=risk_class,
                purpose="operator",
                workflow_id="workflow-1",
                client_request_id="request-1",
                target=BrokerMutationTarget(
                    kind=target_kind,
                    key=target_identifier,
                ),
                request_payload={"operation": operation},
                submission_claim_id=claim_id,
            ),
        )


def test_evidence_is_canonical_hashed_and_rejects_floats() -> None:
    encoded, fingerprint = canonicalize_broker_mutation_evidence(
        {"broker": {"status": "accepted", "order_id": "order-1"}}
    )
    assert json.loads(encoded)["broker"]["order_id"] == "order-1"
    assert len(fingerprint) == 64
    with pytest.raises(BrokerMutationReceiptValidationError):
        canonicalize_broker_mutation_evidence({"latency_seconds": 0.5})
    with pytest.raises(BrokerMutationReceiptValidationError, match="must_be_object"):
        canonicalize_broker_mutation_evidence("unstructured")


def test_evidence_normalization_preserves_canonical_edge_cases() -> None:
    encoded, _ = canonicalize_broker_mutation_evidence(
        {"values": (Decimal("-0.000"), Decimal("1E+2"), "e\u0301")}
    )

    assert json.loads(encoded) == {"values": ["0", "100", "é"]}
    with pytest.raises(BrokerMutationReceiptValidationError, match="key_collision"):
        canonicalize_broker_mutation_evidence({"é": 1, "e\u0301": 2})


def test_recovery_evidence_binds_identity_and_outcome() -> None:
    observation = build_broker_mutation_recovery_observation(
        BrokerMutationRecoveryObservationRequest(
            checked_client_request_id="request-1",
            checked_target_key="order-1",
            outcome="not_found",
            evidence_payload={"broker_status": "not_found"},
        )
    )
    verify_canonical_broker_mutation_evidence(
        observation.evidence_json,
        observation.evidence_sha256,
    )
    verify_broker_mutation_recovery_observation(observation)
    observation_document = json.loads(observation.evidence_json)
    assert observation_document == {
        "schema_version": "torghut.broker-mutation-recovery-evidence.v1",
        "checked_client_request_id": "request-1",
        "checked_target_key": "order-1",
        "outcome": "not_found",
        "observation": {"broker_status": "not_found"},
    }
    with pytest.raises(
        BrokerMutationReceiptValidationError,
        match="recovery_evidence_identity_mismatch",
    ):
        verify_broker_mutation_recovery_observation(
            replace(observation, outcome="indeterminate")
        )


def test_settlement_evidence_binds_every_terminal_fact() -> None:
    execution_id = uuid.uuid4()
    settlement = build_broker_mutation_settlement(
        BrokerMutationSettlementRequest(
            source="primary",
            outcome="acknowledged",
            broker_reference="broker-order-1",
            execution_id=execution_id,
            evidence_payload={"broker_status": "accepted"},
        )
    )
    assert settlement.broker_reference == "broker-order-1"
    verify_canonical_broker_mutation_evidence(
        settlement.evidence_json,
        settlement.evidence_sha256,
    )
    verify_broker_mutation_settlement(settlement)
    settlement_document = json.loads(settlement.evidence_json)
    assert settlement_document == {
        "schema_version": "torghut.broker-mutation-settlement-evidence.v1",
        "source": "primary",
        "outcome": "acknowledged",
        "broker_reference": "broker-order-1",
        "execution_id": str(execution_id),
        "evidence": {"broker_status": "accepted"},
    }
    with pytest.raises(
        BrokerMutationReceiptValidationError,
        match="settlement_evidence_identity_mismatch",
    ):
        verify_broker_mutation_settlement(
            replace(settlement, broker_reference="broker-order-2")
        )

    drifted_document = {**settlement_document, "outcome": "rejected"}
    drifted_json, drifted_sha256 = canonicalize_broker_mutation_evidence(
        drifted_document
    )
    with pytest.raises(
        BrokerMutationReceiptValidationError,
        match="settlement_evidence_identity_mismatch",
    ):
        verify_broker_mutation_settlement(
            replace(
                settlement,
                evidence_json=drifted_json,
                evidence_sha256=drifted_sha256,
            )
        )


def test_settlement_builder_enforces_source_and_outcome_contracts() -> None:
    invalid_pairs = (
        ("preflight", "rejected", None),
        ("primary", "already_satisfied", None),
        ("recovery", "acknowledged", "broker-order-1"),
        ("primary", "acknowledged", None),
    )
    for source, outcome, broker_reference in invalid_pairs:
        with pytest.raises(BrokerMutationReceiptValidationError):
            build_broker_mutation_settlement(
                BrokerMutationSettlementRequest(
                    source=source,
                    outcome=outcome,
                    broker_reference=broker_reference,
                    execution_id=None,
                    evidence_payload={"source": source, "outcome": outcome},
                )
            )


def test_evidence_builders_reject_secret_bearing_payloads() -> None:
    with pytest.raises(
        BrokerMutationReceiptValidationError,
        match="secret_bearing_key_forbidden",
    ):
        build_broker_mutation_recovery_observation(
            BrokerMutationRecoveryObservationRequest(
                checked_client_request_id="request-1",
                checked_target_key="order-1",
                outcome="not_found",
                evidence_payload={"transport": {"Authorization": "forbidden"}},
            )
        )
    with pytest.raises(
        BrokerMutationReceiptValidationError,
        match="secret_bearing_key_forbidden",
    ):
        build_broker_mutation_settlement(
            BrokerMutationSettlementRequest(
                source="primary",
                outcome="rejected",
                broker_reference=None,
                execution_id=None,
                evidence_payload={"transport": {"private-key": "forbidden"}},
            )
        )


def test_evidence_verifier_rejects_hash_and_encoding_drift() -> None:
    evidence_json, evidence_sha256 = canonicalize_broker_mutation_evidence(
        {"status": "accepted", "quantity": Decimal("1.25")}
    )

    with pytest.raises(BrokerMutationReceiptValidationError, match="hash_mismatch"):
        verify_canonical_broker_mutation_evidence(evidence_json, "0" * 64)
    with pytest.raises(BrokerMutationReceiptValidationError, match="encoding_mismatch"):
        verify_canonical_broker_mutation_evidence(
            evidence_json.replace(":", ": ", 1),
            hashlib.sha256(evidence_json.replace(":", ": ", 1).encode()).hexdigest(),
        )


def test_linked_terminal_builder_binds_exact_claim_and_rejection_semantics() -> None:
    handle = DecisionSubmissionClaimHandle(
        decision_id=uuid.UUID("00000000-0000-0000-0000-000000000123"),
        claim_token=uuid.UUID("00000000-0000-0000-0000-000000000456"),
        fencing_epoch=1,
        account_label="paper",
        client_order_id="a" * 64,
        claim_owner="writer-a",
    )
    settlement = build_linked_submission_terminal_settlement(
        BrokerMutationLinkedSubmissionSettlementRequest(
            source="primary",
            outcome="rejected",
            claim_handle=handle,
            broker_status="rejected",
            rejection_code="insufficient_buying_power",
            broker_reference=None,
            execution_id=None,
        )
    )
    document = json.loads(settlement.evidence_json)
    assert document["evidence"] == {
        "account_label": "paper",
        "broker_status": "rejected",
        "client_order_id": "a" * 64,
        "decision_id": "00000000-0000-0000-0000-000000000123",
        "rejection_code": "insufficient_buying_power",
        "schema_version": "torghut.linked-submission-terminal.v1",
    }
    with pytest.raises(BrokerMutationReceiptValidationError):
        build_linked_submission_terminal_settlement(
            BrokerMutationLinkedSubmissionSettlementRequest(
                source="primary",
                outcome="rejected",
                claim_handle=handle,
                broker_status="rejected",
                rejection_code=None,
                broker_reference=None,
                execution_id=None,
            )
        )
    with pytest.raises(BrokerMutationReceiptValidationError):
        build_linked_submission_terminal_settlement(
            BrokerMutationLinkedSubmissionSettlementRequest(
                source="primary",
                outcome="acknowledged",
                claim_handle=handle,
                broker_status="accepted",
                rejection_code=None,
                broker_reference="broker-order",
                execution_id=None,
            )
        )
    with pytest.raises(
        BrokerMutationReceiptValidationError,
        match="linked_submission_recovery_evidence_required",
    ):
        build_linked_submission_terminal_settlement(
            BrokerMutationLinkedSubmissionSettlementRequest(
                source="recovery",
                outcome="reconciled",
                claim_handle=handle,
                broker_status="accepted",
                rejection_code=None,
                broker_reference="broker-order",
                execution_id=uuid.uuid4(),
            )
        )
    recovered_execution_id = uuid.uuid4()
    recovery_settlement = build_linked_submission_terminal_settlement(
        BrokerMutationLinkedSubmissionSettlementRequest(
            source="recovery",
            outcome="reconciled",
            claim_handle=handle,
            broker_status="accepted",
            rejection_code=None,
            broker_reference="broker-order",
            execution_id=recovered_execution_id,
            recovery_evidence_payload={
                "schema_version": "torghut.test-submit-recovery.v1",
                "resolution_state": "acknowledged",
                "automatic_resubmission_attempted": False,
            },
        )
    )
    assert recovery_settlement.source == "recovery"
    assert recovery_settlement.outcome == "reconciled"
    assert recovery_settlement.execution_id == recovered_execution_id
    with pytest.raises(
        BrokerMutationReceiptValidationError,
        match="linked_submission_recovery_resolution_invalid",
    ):
        build_linked_submission_terminal_settlement(
            BrokerMutationLinkedSubmissionSettlementRequest(
                source="recovery",
                outcome="reconciled",
                claim_handle=handle,
                broker_status="accepted",
                rejection_code=None,
                broker_reference="broker-order",
                execution_id=uuid.uuid4(),
                recovery_evidence_payload={
                    "schema_version": "torghut.test-submit-recovery.v1",
                    "resolution_state": "expired",
                    "automatic_resubmission_attempted": False,
                },
            )
        )
    with pytest.raises(
        BrokerMutationReceiptValidationError,
        match="linked_submission_recovery_resolution_invalid",
    ):
        build_linked_submission_terminal_settlement(
            BrokerMutationLinkedSubmissionSettlementRequest(
                source="recovery",
                outcome="rejected",
                claim_handle=handle,
                broker_status="not_found",
                rejection_code="recovery_absence_proven",
                broker_reference=None,
                execution_id=None,
                recovery_evidence_payload={
                    "schema_version": "torghut.test-submit-recovery.v1",
                    "resolution_state": "expired",
                    "automatic_resubmission_attempted": False,
                },
            )
        )
    with pytest.raises(BrokerMutationReceiptValidationError):
        build_linked_submission_terminal_settlement(
            BrokerMutationLinkedSubmissionSettlementRequest(
                source="primary",
                outcome="rejected",
                claim_handle=handle,
                broker_status="rejected",
                rejection_code="broker_rejected",
                broker_reference="broker-order",
                execution_id=None,
            )
        )
    with pytest.raises(BrokerMutationReceiptValidationError):
        build_linked_submission_terminal_settlement(
            BrokerMutationLinkedSubmissionSettlementRequest(
                source="primary",
                outcome="acknowledged",
                claim_handle=handle,
                broker_status="accepted",
                rejection_code="unexpected_code",
                broker_reference="broker-order",
                execution_id=uuid.uuid4(),
            )
        )
    with pytest.raises(BrokerMutationReceiptValidationError):
        build_linked_submission_terminal_settlement(
            BrokerMutationLinkedSubmissionSettlementRequest(
                source="primary",
                outcome="rejected",
                claim_handle=handle,
                broker_status="rejected",
                rejection_code="Not Stable",
                broker_reference=None,
                execution_id=None,
            )
        )
