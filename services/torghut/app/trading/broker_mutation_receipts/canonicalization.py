"""Canonical broker-mutation intent and endpoint fingerprints."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import posixpath
import re
import unicodedata
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from typing import cast
from urllib.parse import SplitResult, urlsplit, urlunsplit

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
    MAX_CANONICAL_NESTING,
    BrokerMutationReceiptValidationError,
    enum_value,
    optional_uuid,
    optional_text,
    reject_control_characters,
    required_text,
    sha256_hex,
)


BROKER_MUTATION_INTENT_SCHEMA_VERSION = "torghut.broker-mutation-intent.v1"
_DNS_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")

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
)
_SETTLEMENT_OUTCOMES: tuple[BrokerMutationSettlementOutcome, ...] = (
    "acknowledged",
    "reconciled",
    "rejected",
    "already_satisfied",
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

    normalized = _normalized_endpoint_url(endpoint_url)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _normalized_endpoint_url(endpoint_url: str) -> str:
    raw = required_text(endpoint_url, field="endpoint_url", maximum=2048)
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except ValueError as exc:
        raise BrokerMutationReceiptValidationError("endpoint_url_invalid") from exc
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        raise BrokerMutationReceiptValidationError("endpoint_url_scheme_invalid")
    if parsed.username is not None or parsed.password is not None:
        raise BrokerMutationReceiptValidationError("endpoint_url_credentials_forbidden")
    if parsed.query or parsed.fragment:
        raise BrokerMutationReceiptValidationError(
            "endpoint_url_query_or_fragment_forbidden"
        )
    hostname = parsed.hostname
    if hostname is None:
        raise BrokerMutationReceiptValidationError("endpoint_url_host_required")
    normalized_host = _normalized_endpoint_host(hostname)
    if ":" in normalized_host:
        normalized_host = f"[{normalized_host}]"
    default_port = 443 if scheme == "https" else 80
    authority = (
        normalized_host if port in {None, default_port} else f"{normalized_host}:{port}"
    )
    path = _normalized_endpoint_path(parsed.path)
    normalized = urlunsplit(SplitResult(scheme, authority, path, "", ""))
    reject_control_characters(normalized, field="endpoint_url")
    return normalized


def _normalized_endpoint_host(hostname: str) -> str:
    if "%" in hostname:
        raise BrokerMutationReceiptValidationError("endpoint_url_host_invalid")
    try:
        return ipaddress.ip_address(hostname).compressed.lower()
    except ValueError:
        pass
    try:
        normalized = hostname.rstrip(".").encode("idna").decode("ascii").lower()
    except UnicodeError as exc:
        raise BrokerMutationReceiptValidationError("endpoint_url_host_invalid") from exc
    if (
        not normalized
        or len(normalized) > 253
        or any(_DNS_LABEL.fullmatch(label) is None for label in normalized.split("."))
    ):
        raise BrokerMutationReceiptValidationError("endpoint_url_host_invalid")
    return normalized


def _normalized_endpoint_path(path: str) -> str:
    if not path or path == "/":
        return "/"
    if not path.startswith("/"):
        raise BrokerMutationReceiptValidationError("endpoint_url_path_invalid")
    normalized = posixpath.normpath(path)
    if path.endswith("/") and normalized != "/":
        normalized = normalized.rstrip("/")
    return normalized


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
        request_payload=_canonical_json_value(
            request.request_payload, path="request", depth=0
        ),
        submission_claim_id=optional_uuid(
            request.submission_claim_id, field="submission_claim_id"
        ),
    )
    _validate_operation_contract(
        operation=normalized.operation,
        risk_class=normalized.risk_class,
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
    normalized = _canonical_json_value(
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
            "checked_client_request_id": checked_client_request_id,
            "checked_target_key": checked_target_key,
            "observation": evidence_payload,
        }
    )
    return BrokerMutationRecoveryObservation(
        checked_client_request_id=checked_client_request_id,
        checked_target_key=checked_target_key,
        outcome=outcome,
        evidence_json=evidence_json,
        evidence_sha256=evidence_sha256,
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
    evidence_json, evidence_sha256 = canonicalize_broker_mutation_evidence(
        request.evidence_payload
    )
    return BrokerMutationSettlement(
        source=source,
        outcome=outcome,
        broker_reference=broker_reference,
        execution_id=optional_uuid(request.execution_id, field="execution_id"),
        evidence_json=evidence_json,
        evidence_sha256=evidence_sha256,
    )


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
    operation: BrokerMutationOperation,
    risk_class: BrokerMutationRiskClass,
    account_label: str,
    target: BrokerMutationTarget,
    submission_claim_id: uuid.UUID | None,
) -> None:
    if operation in {"submit_order", "replace_order"}:
        if target.kind != "order" or submission_claim_id is None:
            raise BrokerMutationReceiptValidationError(
                f"{operation}_requires_order_target_and_submission_claim"
            )
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


def _canonical_json_value(
    value: object, *, path: str, depth: int
) -> CanonicalJsonValue:
    if depth > MAX_CANONICAL_NESTING:
        raise BrokerMutationReceiptValidationError(
            f"canonical_intent_nesting_too_deep:{MAX_CANONICAL_NESTING}"
        )
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        if value.bit_length() > MAX_CANONICAL_INTENT_BYTES * 4:
            raise BrokerMutationReceiptValidationError(f"{path}_integer_too_large")
        try:
            rendered_integer = str(value)
        except (MemoryError, ValueError) as exc:
            raise BrokerMutationReceiptValidationError(
                f"{path}_integer_too_large"
            ) from exc
        if len(rendered_integer) > MAX_CANONICAL_INTENT_BYTES:
            raise BrokerMutationReceiptValidationError(f"{path}_integer_too_large")
        return value
    if isinstance(value, float):
        raise BrokerMutationReceiptValidationError(f"{path}_float_forbidden")
    if isinstance(value, Decimal):
        return _canonical_decimal(value, path=path)
    if isinstance(value, str):
        reject_control_characters(value, field=path)
        return unicodedata.normalize("NFC", value)
    if isinstance(value, Mapping):
        return _canonical_mapping(
            cast(Mapping[object, object], value),
            path=path,
            depth=depth,
        )
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [
            _canonical_json_value(item, path=f"{path}[{index}]", depth=depth + 1)
            for index, item in enumerate(cast(Sequence[object], value))
        ]
    raise BrokerMutationReceiptValidationError(
        f"{path}_type_unsupported:{type(value).__name__}"
    )


def _canonical_mapping(
    value: Mapping[object, object],
    *,
    path: str,
    depth: int,
) -> dict[str, CanonicalJsonValue]:
    normalized: dict[str, CanonicalJsonValue] = {}
    for raw_key, raw_value in value.items():
        if not isinstance(raw_key, str):
            raise BrokerMutationReceiptValidationError(f"{path}_key_must_be_string")
        key = required_text(raw_key, field=f"{path}_key", maximum=128)
        if key != unicodedata.normalize("NFC", raw_key):
            raise BrokerMutationReceiptValidationError(
                f"{path}_key_surrounding_whitespace_forbidden"
            )
        if key in normalized:
            raise BrokerMutationReceiptValidationError(f"{path}_key_collision:{key}")
        normalized[key] = _canonical_json_value(
            raw_value,
            path=f"{path}.{key}",
            depth=depth + 1,
        )
    return normalized


def _canonical_decimal(value: Decimal, *, path: str) -> str:
    if not value.is_finite():
        raise BrokerMutationReceiptValidationError(f"{path}_decimal_non_finite")
    if value.is_zero():
        return "0"
    sign, raw_digits, raw_exponent = value.as_tuple()
    exponent = cast(int, raw_exponent)
    digits = list(raw_digits)
    while digits and digits[-1] == 0:
        digits.pop()
        exponent += 1
    coefficient = "".join(str(digit) for digit in digits) or "0"
    if exponent >= 0:
        if len(coefficient) + exponent > MAX_CANONICAL_INTENT_BYTES:
            raise BrokerMutationReceiptValidationError(f"{path}_decimal_too_large")
        rendered = coefficient + ("0" * exponent)
    else:
        decimal_position = len(coefficient) + exponent
        if decimal_position > 0:
            rendered = (
                f"{coefficient[:decimal_position]}.{coefficient[decimal_position:]}"
            )
        else:
            leading_zeros = -decimal_position
            if len(coefficient) + leading_zeros > MAX_CANONICAL_INTENT_BYTES:
                raise BrokerMutationReceiptValidationError(f"{path}_decimal_too_large")
            rendered = f"0.{('0' * leading_zeros)}{coefficient}"
    return f"-{rendered}" if sign else rendered


__all__ = [
    "BROKER_MUTATION_INTENT_SCHEMA_VERSION",
    "build_broker_mutation_intent",
    "build_broker_mutation_recovery_observation",
    "build_broker_mutation_settlement",
    "canonicalize_broker_mutation_evidence",
    "fingerprint_broker_endpoint",
    "verify_broker_mutation_intent",
    "verify_canonical_broker_mutation_evidence",
]
