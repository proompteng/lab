"""Consume durable and broker-observed capabilities at one mutation boundary."""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from dataclasses import dataclass
from typing import cast

from .broker_mutation_receipts import (
    BrokerMutationIoPermit,
    BrokerMutationIoPermitExpectation,
    BrokerMutationOperation,
    BrokerMutationPurpose,
    BrokerMutationRiskClass,
    BrokerMutationRoute,
    BrokerMutationTargetKind,
    canonicalize_broker_mutation_evidence,
    consume_broker_mutation_io_permit,
    validate_broker_mutation_io_permit,
)
from .risk_reduction import (
    RISK_REDUCTION_OPERATIONS,
    RiskReductionPermit,
    RiskReductionPermitError,
    RiskReductionPermitExpectation,
    consume_risk_reduction_permit,
    validate_risk_reduction_permit,
)


@dataclass(frozen=True, slots=True)
class RiskReductionMutationAuthority:
    """The exact durable and broker-observed capabilities for one mutation."""

    request_payload: Mapping[str, object]
    mutation_permit: BrokerMutationIoPermit
    reduction_permit: RiskReductionPermit


@dataclass(frozen=True, slots=True)
class RiskReductionMutationExpectation:
    broker_route: BrokerMutationRoute
    account_label: str
    endpoint_fingerprint: str
    operation: BrokerMutationOperation
    risk_class: BrokerMutationRiskClass
    target_key: str


def risk_reduction_request_id(
    operation: BrokerMutationOperation,
    request_payload: Mapping[str, object],
    *,
    target_kind: BrokerMutationTargetKind,
    target_key: str,
    purpose: BrokerMutationPurpose | None = None,
) -> str:
    """Derive one stable economic identity while retaining full observation evidence."""

    if operation not in RISK_REDUCTION_OPERATIONS:
        raise RiskReductionPermitError("risk_reduction_operation_invalid")
    normalized_target_key = str(target_key).strip()
    if target_kind not in {"account", "order", "position"}:
        raise RiskReductionPermitError("risk_reduction_target_kind_invalid")
    if not normalized_target_key:
        raise RiskReductionPermitError("risk_reduction_target_key_invalid")
    reduction = request_payload.get("risk_reduction")
    if isinstance(reduction, Mapping):
        action = cast(Mapping[str, object], reduction).get("action")
        if not isinstance(action, Mapping):
            raise RiskReductionPermitError("risk_reduction_action_invalid")
        identity: Mapping[str, object] = {
            "action": cast(Mapping[str, object], action),
            "broker_request": {
                key: value
                for key, value in request_payload.items()
                if key not in {"risk_reduction", "schema_version"}
            },
        }
    elif request_payload.get("already_satisfied") is True:
        if purpose is None:
            raise RiskReductionPermitError("risk_reduction_preflight_purpose_required")
        identity = {
            "already_satisfied": True,
            "purpose": purpose,
        }
    else:
        raise RiskReductionPermitError("risk_reduction_evidence_required")
    canonical_json, _ = canonicalize_broker_mutation_evidence(
        {
            **identity,
            "operation": operation,
            "target": {
                "kind": target_kind,
                "key": normalized_target_key,
            },
        }
    )
    digest = hashlib.sha256(canonical_json.encode("utf-8")).hexdigest()
    return f"rr-{operation.replace('_', '-')}-{digest}"


def consume_risk_reduction_mutation_authority(
    authority: RiskReductionMutationAuthority,
    expectation: RiskReductionMutationExpectation,
) -> None:
    """Validate both capabilities, then consume both before broker I/O.

    A concurrent consumption race can stop progress after one capability is
    consumed, but it always fails before the broker call.
    """

    io_expectation = BrokerMutationIoPermitExpectation(
        broker_route=expectation.broker_route,
        operation=expectation.operation,
        risk_class=expectation.risk_class,
        account_label=expectation.account_label,
        endpoint_fingerprint=expectation.endpoint_fingerprint,
        request_payload=authority.request_payload,
    )
    reduction_expectation = RiskReductionPermitExpectation(
        broker_route=expectation.broker_route,
        account_label=expectation.account_label,
        endpoint_fingerprint=expectation.endpoint_fingerprint,
        operation=expectation.operation,
        target_key=expectation.target_key,
        request_payload=authority.request_payload,
    )
    validate_broker_mutation_io_permit(
        authority.mutation_permit,
        expectation=io_expectation,
    )
    validate_risk_reduction_permit(
        authority.reduction_permit,
        expectation=reduction_expectation,
    )
    consume_broker_mutation_io_permit(
        authority.mutation_permit,
        expectation=io_expectation,
    )
    consume_risk_reduction_permit(
        authority.reduction_permit,
        expectation=reduction_expectation,
    )


__all__ = [
    "RiskReductionMutationAuthority",
    "RiskReductionMutationExpectation",
    "consume_risk_reduction_mutation_authority",
    "risk_reduction_request_id",
]
