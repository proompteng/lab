"""Canonical broker-mutation intent and endpoint fingerprints."""

from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import cast

from .types import (
    BrokerMutationIntent,
    BrokerMutationIntentRequest,
    BrokerMutationOperation,
    BrokerMutationPurpose,
    BrokerMutationRecoveryObservation,
    BrokerMutationRecoveryObservationOutcome,
    BrokerMutationRecoveryObservationRequest,
    BrokerMutationRiskClass,
    BrokerMutationRoute,
    BrokerMutationSettlement,
    BrokerMutationSettlementOutcome,
    BrokerMutationSettlementRequest,
    BrokerMutationSettlementSource,
    BrokerMutationTarget,
    BrokerMutationTargetKind,
    CanonicalJsonValue,
)
from .validation import (
    MAX_CANONICAL_INTENT_BYTES,
    MAX_CANONICAL_EVIDENCE_BYTES,
    BrokerMutationReceiptValidationError,
    canonical_json_value,
    enum_value,
    normalize_endpoint_url,
    optional_uuid,
    optional_text,
    required_text,
    sha256_hex,
)


BROKER_MUTATION_INTENT_SCHEMA_VERSION = "torghut.broker-mutation-intent.v1"
_RECOVERY_EVIDENCE_SCHEMA_VERSION = "torghut.broker-mutation-recovery-evidence.v1"
_SETTLEMENT_EVIDENCE_SCHEMA_VERSION = "torghut.broker-mutation-settlement-evidence.v1"
_ROUTES: tuple[BrokerMutationRoute, ...] = ("alpaca", "hyperliquid")
_OPERATIONS: tuple[BrokerMutationOperation, ...] = (
    "submit_order",
    "replace_order",
    "cancel_order",
    "cancel_all_orders",
    "close_position",
    "close_all_positions",
)
_RISK_CLASSES: tuple[BrokerMutationRiskClass, ...] = (
    "risk_increasing",
    "risk_reducing",
    "risk_neutral",
)
_PURPOSES: tuple[BrokerMutationPurpose, ...] = (
    "initial_submission",
    "repricing",
    "inventory_conflict",
    "opposite_side_cleanup",
    "kill_switch",
    "governance",
    "closeout",
    "flatten",
    "operator",
    "control_plane_validation",
)
_TARGET_KINDS: tuple[BrokerMutationTargetKind, ...] = (
    "order",
    "position",
    "account",
)
_RECOVERY_OUTCOMES: tuple[BrokerMutationRecoveryObservationOutcome, ...] = (
    "not_found",
    "indeterminate",
)
_SETTLEMENT_SOURCES: tuple[BrokerMutationSettlementSource, ...] = (
    "primary",
    "recovery",
    "preflight",
    "operator_confirmation",
)
_SETTLEMENT_OUTCOMES: tuple[BrokerMutationSettlementOutcome, ...] = (
    "acknowledged",
    "reconciled",
    "rejected",
    "already_satisfied",
    "validation_quarantine_closed",
)


@dataclass(frozen=True, slots=True)
class _NormalizedIntentFields:
    broker_route: BrokerMutationRoute
    account_label: str
    endpoint_fingerprint: str
    operation: BrokerMutationOperation
    risk_class: BrokerMutationRiskClass
    purpose: BrokerMutationPurpose
    workflow_id: str
    client_request_id: str
    target: BrokerMutationTarget
    request_payload: CanonicalJsonValue
    submission_claim_id: uuid.UUID | None


def fingerprint_broker_endpoint(endpoint_url: str) -> str:
    """Hash a credential-free normalized endpoint without returning the URL."""

    normalized = normalize_endpoint_url(endpoint_url)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def build_broker_mutation_intent(
    request: BrokerMutationIntentRequest,
) -> BrokerMutationIntent:
    """Build the only accepted schema-v1 semantic receipt identity."""

    normalized = _normalize_intent_request(request)
    document = _intent_document(normalized)
    canonical_json, canonical_hash = _encode_canonical_intent(document)
    return BrokerMutationIntent(
        broker_route=normalized.broker_route,
        account_label=normalized.account_label,
        endpoint_fingerprint=normalized.endpoint_fingerprint,
        operation=normalized.operation,
        risk_class=normalized.risk_class,
        purpose=normalized.purpose,
        workflow_id=normalized.workflow_id,
        client_request_id=normalized.client_request_id,
        target=normalized.target,
        submission_claim_id=normalized.submission_claim_id,
        intent_schema_version=BROKER_MUTATION_INTENT_SCHEMA_VERSION,
        canonical_intent_json=canonical_json,
        canonical_intent_sha256=canonical_hash,
    )


def _normalize_intent_request(
    request: BrokerMutationIntentRequest,
) -> _NormalizedIntentFields:
    normalized = _NormalizedIntentFields(
        broker_route=cast(
            BrokerMutationRoute,
            enum_value(request.broker_route, field="broker_route", allowed=_ROUTES),
        ),
        account_label=required_text(
            request.account_label, field="account_label", maximum=64
        ),
        endpoint_fingerprint=sha256_hex(
            request.endpoint_fingerprint, field="endpoint_fingerprint"
        ),
        operation=cast(
            BrokerMutationOperation,
            enum_value(request.operation, field="operation", allowed=_OPERATIONS),
        ),
        risk_class=cast(
            BrokerMutationRiskClass,
            enum_value(request.risk_class, field="risk_class", allowed=_RISK_CLASSES),
        ),
        purpose=cast(
            BrokerMutationPurpose,
            enum_value(request.purpose, field="purpose", allowed=_PURPOSES),
        ),
        workflow_id=required_text(
            request.workflow_id, field="workflow_id", maximum=128
        ),
        client_request_id=required_text(
            request.client_request_id, field="client_request_id", maximum=128
        ),
        target=_normalize_target(request.target),
        request_payload=cast(
            CanonicalJsonValue,
            canonical_json_value(request.request_payload, path="request", depth=0),
        ),
        submission_claim_id=optional_uuid(
            request.submission_claim_id, field="submission_claim_id"
        ),
    )
    _validate_operation_contract(
        broker_route=normalized.broker_route,
        operation=normalized.operation,
        risk_class=normalized.risk_class,
        purpose=normalized.purpose,
        account_label=normalized.account_label,
        target=normalized.target,
        submission_claim_id=normalized.submission_claim_id,
    )
    return normalized


def _intent_document(
    normalized: _NormalizedIntentFields,
) -> dict[str, CanonicalJsonValue]:
    return {
        "account_label": normalized.account_label,
        "client_request_id": normalized.client_request_id,
        "endpoint_fingerprint": normalized.endpoint_fingerprint,
        "operation": normalized.operation,
        "purpose": normalized.purpose,
        "request": normalized.request_payload,
        "risk_class": normalized.risk_class,
        "broker_route": normalized.broker_route,
        "schema_version": BROKER_MUTATION_INTENT_SCHEMA_VERSION,
        "submission_claim_id": (
            str(normalized.submission_claim_id)
            if normalized.submission_claim_id is not None
            else None
        ),
        "target": {
            "key": normalized.target.key,
            "kind": normalized.target.kind,
        },
        "workflow_id": normalized.workflow_id,
    }


def _encode_canonical_intent(
    document: dict[str, CanonicalJsonValue],
) -> tuple[str, str]:
    canonical_json = json.dumps(
        document,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )
    encoded = canonical_json.encode("utf-8")
    if len(encoded) > MAX_CANONICAL_INTENT_BYTES:
        raise BrokerMutationReceiptValidationError(
            f"canonical_intent_too_large:{MAX_CANONICAL_INTENT_BYTES}"
        )
    return canonical_json, hashlib.sha256(encoded).hexdigest()


def verify_broker_mutation_intent(intent: object) -> None:
    """Rebuild a caller-supplied intent and reject any manual identity drift."""

    if not isinstance(intent, BrokerMutationIntent):
        raise BrokerMutationReceiptValidationError("broker_mutation_intent_invalid")
    try:
        raw_document = json.loads(intent.canonical_intent_json, parse_float=Decimal)
    except (TypeError, ValueError) as exc:
        raise BrokerMutationReceiptValidationError(
            "canonical_intent_json_invalid"
        ) from exc
    if not isinstance(raw_document, Mapping):
        raise BrokerMutationReceiptValidationError("canonical_intent_document_invalid")
    document = cast(Mapping[str, object], raw_document)
    request_payload = document.get("request")
    if not isinstance(request_payload, Mapping):
        raise BrokerMutationReceiptValidationError("canonical_intent_document_invalid")
    try:
        rebuilt = build_broker_mutation_intent(
            BrokerMutationIntentRequest(
                broker_route=intent.broker_route,
                account_label=intent.account_label,
                endpoint_fingerprint=intent.endpoint_fingerprint,
                operation=intent.operation,
                risk_class=intent.risk_class,
                purpose=intent.purpose,
                workflow_id=intent.workflow_id,
                client_request_id=intent.client_request_id,
                target=intent.target,
                request_payload=cast(
                    Mapping[str, object],
                    request_payload,
                ),
                submission_claim_id=intent.submission_claim_id,
            )
        )
    except (AttributeError, TypeError) as exc:
        raise BrokerMutationReceiptValidationError(
            "broker_mutation_intent_invalid"
        ) from exc
    if rebuilt != intent:
        raise BrokerMutationReceiptValidationError(
            "canonical_broker_mutation_intent_mismatch"
        )


def canonicalize_broker_mutation_evidence(payload: object) -> tuple[str, str]:
    """Return bounded canonical evidence JSON and its SHA-256 fingerprint."""

    if not isinstance(payload, Mapping):
        raise BrokerMutationReceiptValidationError("evidence_must_be_object")
    normalized = canonical_json_value(
        cast(Mapping[object, object], payload),
        path="evidence",
        depth=0,
    )
    canonical_json = json.dumps(
        normalized,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )
    encoded = canonical_json.encode("utf-8")
    if len(encoded) > MAX_CANONICAL_EVIDENCE_BYTES:
        raise BrokerMutationReceiptValidationError(
            f"canonical_evidence_too_large:{MAX_CANONICAL_EVIDENCE_BYTES}"
        )
    return canonical_json, hashlib.sha256(encoded).hexdigest()


def verify_canonical_broker_mutation_evidence(
    evidence_json: object,
    evidence_sha256: str,
) -> None:
    """Reject non-canonical or mismatched evidence supplied to a transition."""

    if not isinstance(evidence_json, str):
        raise BrokerMutationReceiptValidationError("evidence_json_must_be_string")
    normalized_hash = sha256_hex(evidence_sha256, field="evidence_sha256")
    encoded = evidence_json.encode("utf-8")
    if not encoded or len(encoded) > MAX_CANONICAL_EVIDENCE_BYTES:
        raise BrokerMutationReceiptValidationError(
            f"canonical_evidence_too_large:{MAX_CANONICAL_EVIDENCE_BYTES}"
        )
    if hashlib.sha256(encoded).hexdigest() != normalized_hash:
        raise BrokerMutationReceiptValidationError("canonical_evidence_hash_mismatch")
    try:
        payload = json.loads(evidence_json, parse_float=Decimal)
    except (TypeError, ValueError) as exc:
        raise BrokerMutationReceiptValidationError(
            "canonical_evidence_json_invalid"
        ) from exc
    canonical_json, canonical_hash = canonicalize_broker_mutation_evidence(payload)
    if canonical_json != evidence_json or canonical_hash != normalized_hash:
        raise BrokerMutationReceiptValidationError(
            "canonical_evidence_encoding_mismatch"
        )


def build_broker_mutation_recovery_observation(
    request: BrokerMutationRecoveryObservationRequest,
) -> BrokerMutationRecoveryObservation:
    outcome = cast(
        BrokerMutationRecoveryObservationOutcome,
        enum_value(
            request.outcome,
            field="recovery_outcome",
            allowed=_RECOVERY_OUTCOMES,
        ),
    )
    checked_client_request_id = required_text(
        request.checked_client_request_id,
        field="checked_client_request_id",
        maximum=128,
    )
    checked_target_key = required_text(
        request.checked_target_key,
        field="checked_target_key",
        maximum=256,
    )
    raw_evidence: object = request.evidence_payload
    if not isinstance(raw_evidence, Mapping):
        raise BrokerMutationReceiptValidationError("recovery_evidence_must_be_object")
    evidence_payload = cast(Mapping[str, object], raw_evidence)
    evidence_json, evidence_sha256 = canonicalize_broker_mutation_evidence(
        {
            "schema_version": _RECOVERY_EVIDENCE_SCHEMA_VERSION,
            "checked_client_request_id": checked_client_request_id,
            "checked_target_key": checked_target_key,
            "outcome": outcome,
            "observation": evidence_payload,
        }
    )
    observation = BrokerMutationRecoveryObservation(
        checked_client_request_id=checked_client_request_id,
        checked_target_key=checked_target_key,
        outcome=outcome,
        evidence_json=evidence_json,
        evidence_sha256=evidence_sha256,
    )
    verify_broker_mutation_recovery_observation(observation)
    return observation


def verify_broker_mutation_recovery_observation(
    observation: object,
) -> None:
    """Verify that immutable recovery evidence binds every asserted fact."""

    if not isinstance(observation, BrokerMutationRecoveryObservation):
        raise BrokerMutationReceiptValidationError(
            "broker_mutation_recovery_observation_invalid"
        )
    checked_client_request_id = required_text(
        observation.checked_client_request_id,
        field="checked_client_request_id",
        maximum=128,
    )
    checked_target_key = required_text(
        observation.checked_target_key,
        field="checked_target_key",
        maximum=256,
    )
    outcome = enum_value(
        observation.outcome,
        field="recovery_outcome",
        allowed=_RECOVERY_OUTCOMES,
    )
    evidence = _verified_evidence_document(
        observation.evidence_json,
        observation.evidence_sha256,
    )
    expected_keys = {
        "schema_version",
        "checked_client_request_id",
        "checked_target_key",
        "outcome",
        "observation",
    }
    if (
        set(evidence) != expected_keys
        or evidence.get("schema_version") != _RECOVERY_EVIDENCE_SCHEMA_VERSION
        or evidence.get("checked_client_request_id") != checked_client_request_id
        or evidence.get("checked_target_key") != checked_target_key
        or evidence.get("outcome") != outcome
        or not isinstance(evidence.get("observation"), Mapping)
    ):
        raise BrokerMutationReceiptValidationError(
            "recovery_evidence_identity_mismatch"
        )


def build_broker_mutation_settlement(
    request: BrokerMutationSettlementRequest,
) -> BrokerMutationSettlement:
    source = cast(
        BrokerMutationSettlementSource,
        enum_value(
            request.source,
            field="settlement_source",
            allowed=_SETTLEMENT_SOURCES,
        ),
    )
    outcome = cast(
        BrokerMutationSettlementOutcome,
        enum_value(
            request.outcome,
            field="settlement_outcome",
            allowed=_SETTLEMENT_OUTCOMES,
        ),
    )
    _validate_settlement_contract(source=source, outcome=outcome)
    broker_reference = optional_text(
        request.broker_reference,
        field="broker_reference",
        maximum=256,
    )
    if outcome in {"acknowledged", "reconciled"} and broker_reference is None:
        raise BrokerMutationReceiptValidationError(
            f"{outcome}_requires_broker_reference"
        )
    execution_id = optional_uuid(request.execution_id, field="execution_id")
    raw_evidence: object = request.evidence_payload
    if not isinstance(raw_evidence, Mapping):
        raise BrokerMutationReceiptValidationError("settlement_evidence_must_be_object")
    evidence_payload = cast(Mapping[str, object], raw_evidence)
    evidence_json, evidence_sha256 = canonicalize_broker_mutation_evidence(
        {
            "schema_version": _SETTLEMENT_EVIDENCE_SCHEMA_VERSION,
            "source": source,
            "outcome": outcome,
            "broker_reference": broker_reference,
            "execution_id": str(execution_id) if execution_id is not None else None,
            "evidence": evidence_payload,
        }
    )
    settlement = BrokerMutationSettlement(
        source=source,
        outcome=outcome,
        broker_reference=broker_reference,
        execution_id=execution_id,
        evidence_json=evidence_json,
        evidence_sha256=evidence_sha256,
    )
    verify_broker_mutation_settlement(settlement)
    return settlement


def verify_broker_mutation_settlement(settlement: object) -> None:
    """Verify that immutable settlement evidence binds every terminal fact."""

    if not isinstance(settlement, BrokerMutationSettlement):
        raise BrokerMutationReceiptValidationError("broker_mutation_settlement_invalid")
    source = cast(
        BrokerMutationSettlementSource,
        enum_value(
            settlement.source,
            field="settlement_source",
            allowed=_SETTLEMENT_SOURCES,
        ),
    )
    outcome = cast(
        BrokerMutationSettlementOutcome,
        enum_value(
            settlement.outcome,
            field="settlement_outcome",
            allowed=_SETTLEMENT_OUTCOMES,
        ),
    )
    _validate_settlement_contract(source=source, outcome=outcome)
    broker_reference = optional_text(
        settlement.broker_reference,
        field="broker_reference",
        maximum=256,
    )
    if outcome in {"acknowledged", "reconciled"} and broker_reference is None:
        raise BrokerMutationReceiptValidationError(
            f"{outcome}_requires_broker_reference"
        )
    execution_id = optional_uuid(settlement.execution_id, field="execution_id")
    evidence = _verified_evidence_document(
        settlement.evidence_json,
        settlement.evidence_sha256,
    )
    expected_keys = {
        "schema_version",
        "source",
        "outcome",
        "broker_reference",
        "execution_id",
        "evidence",
    }
    if (
        set(evidence) != expected_keys
        or evidence.get("schema_version") != _SETTLEMENT_EVIDENCE_SCHEMA_VERSION
        or evidence.get("source") != source
        or evidence.get("outcome") != outcome
        or evidence.get("broker_reference") != broker_reference
        or evidence.get("execution_id")
        != (str(execution_id) if execution_id is not None else None)
        or not isinstance(evidence.get("evidence"), Mapping)
    ):
        raise BrokerMutationReceiptValidationError(
            "settlement_evidence_identity_mismatch"
        )


def _verified_evidence_document(
    evidence_json: object,
    evidence_sha256: str,
) -> Mapping[str, object]:
    verify_canonical_broker_mutation_evidence(evidence_json, evidence_sha256)
    if not isinstance(evidence_json, str):  # pragma: no cover - verified above
        raise BrokerMutationReceiptValidationError("evidence_json_must_be_string")
    document = json.loads(evidence_json, parse_float=Decimal)
    if not isinstance(document, Mapping):  # pragma: no cover - canonical verifier
        raise BrokerMutationReceiptValidationError("evidence_must_be_object")
    return cast(Mapping[str, object], document)


def _validate_settlement_contract(
    *,
    source: BrokerMutationSettlementSource,
    outcome: BrokerMutationSettlementOutcome,
) -> None:
    if source == "preflight" and outcome != "already_satisfied":
        raise BrokerMutationReceiptValidationError(
            "preflight_requires_already_satisfied"
        )
    if source != "preflight" and outcome == "already_satisfied":
        raise BrokerMutationReceiptValidationError(
            "already_satisfied_requires_preflight"
        )
    if source == "recovery" and outcome == "acknowledged":
        raise BrokerMutationReceiptValidationError(
            "recovery_cannot_acknowledge_new_broker_io"
        )
    if outcome == "validation_quarantine_closed" and source != "operator_confirmation":
        raise BrokerMutationReceiptValidationError(
            "validation_quarantine_closed_requires_operator_confirmation"
        )
    if source == "operator_confirmation" and outcome != "validation_quarantine_closed":
        raise BrokerMutationReceiptValidationError(
            "operator_confirmation_requires_validation_quarantine_closed"
        )


def _normalize_target(target: BrokerMutationTarget) -> BrokerMutationTarget:
    return BrokerMutationTarget(
        kind=cast(
            BrokerMutationTargetKind,
            enum_value(target.kind, field="target_kind", allowed=_TARGET_KINDS),
        ),
        key=required_text(
            target.key,
            field="target_key",
            maximum=256,
        ),
    )


def _validate_operation_contract(
    *,
    broker_route: BrokerMutationRoute,
    operation: BrokerMutationOperation,
    risk_class: BrokerMutationRiskClass,
    purpose: BrokerMutationPurpose,
    account_label: str,
    target: BrokerMutationTarget,
    submission_claim_id: uuid.UUID | None,
) -> None:
    if operation == "submit_order":
        linked_claim_valid = (
            broker_route == "alpaca" and submission_claim_id is not None
        )
        alpaca_closeout_valid = (
            broker_route == "alpaca"
            and submission_claim_id is None
            and risk_class == "risk_reducing"
            and purpose in {"closeout", "flatten"}
        )
        hyperliquid_entry_valid = (
            broker_route == "hyperliquid"
            and submission_claim_id is None
            and risk_class == "risk_increasing"
            and purpose == "initial_submission"
        )
        alpaca_validation_valid = (
            broker_route == "alpaca"
            and submission_claim_id is None
            and risk_class == "risk_neutral"
            and purpose == "control_plane_validation"
        )
        if target.kind != "order" or not (
            linked_claim_valid
            or alpaca_closeout_valid
            or hyperliquid_entry_valid
            or alpaca_validation_valid
        ):
            raise BrokerMutationReceiptValidationError(
                "submit_order_route_claim_contract_invalid"
            )
        return
    if operation == "replace_order":
        repricing_valid = (
            broker_route == "alpaca"
            and submission_claim_id is None
            and risk_class == "risk_neutral"
            and purpose == "repricing"
        )
        if target.kind != "order" or not repricing_valid:
            raise BrokerMutationReceiptValidationError("replace_order_contract_invalid")
        return
    if submission_claim_id is not None:
        raise BrokerMutationReceiptValidationError(
            "non_submit_operation_forbids_submission_claim"
        )
    if operation == "cancel_order":
        if target.kind != "order":
            raise BrokerMutationReceiptValidationError("cancel_order_contract_invalid")
        return
    if operation == "cancel_all_orders":
        if target.kind != "account" or target.key != account_label:
            raise BrokerMutationReceiptValidationError(
                "cancel_all_orders_contract_invalid"
            )
        return
    if operation == "close_position":
        if target.kind != "position" or risk_class != "risk_reducing":
            raise BrokerMutationReceiptValidationError(
                "close_position_contract_invalid"
            )
        return
    if operation == "close_all_positions" and (
        target.kind != "account"
        or target.key != account_label
        or risk_class != "risk_reducing"
    ):
        raise BrokerMutationReceiptValidationError(
            "close_all_positions_contract_invalid"
        )


__all__ = [
    "BROKER_MUTATION_INTENT_SCHEMA_VERSION",
    "build_broker_mutation_intent",
    "build_broker_mutation_recovery_observation",
    "build_broker_mutation_settlement",
    "canonicalize_broker_mutation_evidence",
    "fingerprint_broker_endpoint",
    "verify_broker_mutation_recovery_observation",
    "verify_broker_mutation_settlement",
    "verify_broker_mutation_intent",
    "verify_canonical_broker_mutation_evidence",
]
