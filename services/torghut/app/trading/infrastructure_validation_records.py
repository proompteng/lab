"""Database-backed exclusion contract for infrastructure-validation events."""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import BrokerMutationReceipt, coerce_json_payload
from .evidence_contracts import (
    ArtifactProvenance,
    EvidenceMaturity,
    evidence_contract_payload,
)


_EVIDENCE_KEY = "_torghut_evidence_contract"
_EVIDENCE_SCHEMA_VERSION = "torghut.order-event-evidence-contract.v1"
_EVIDENCE_TAG = ArtifactProvenance.NON_PROMOTABLE_VALIDATION.value


@dataclass(frozen=True, slots=True)
class InfrastructureValidationEvidence:
    receipt_id: uuid.UUID
    permit_id: str
    permit_sha256: str


def load_infrastructure_validation_evidence(
    session: Session,
    *,
    account_label: str,
    client_order_id: str | None,
) -> InfrastructureValidationEvidence | None:
    """Resolve a broker order identity to its immutable validation receipt."""

    normalized_client_order_id = str(client_order_id or "").strip()
    if not normalized_client_order_id.startswith("ivp-"):
        return None
    receipts = (
        session.execute(
            select(BrokerMutationReceipt).where(
                BrokerMutationReceipt.account_label == account_label,
                BrokerMutationReceipt.client_request_id == normalized_client_order_id,
                BrokerMutationReceipt.purpose == "control_plane_validation",
            )
        )
        .scalars()
        .all()
    )
    if not receipts:
        return None
    if len(receipts) != 1:
        raise RuntimeError("infrastructure_validation_receipt_identity_split")
    receipt = receipts[0]
    try:
        intent = json.loads(receipt.canonical_intent_json)
        validation = intent["request"]["infrastructure_validation"]
        permit = validation["permit"]
        permit_id = str(permit["permit_id"]).strip()
        permit_sha256 = str(validation["permit_sha256"]).strip()
        evidence_tag = permit["evidence_tag"]
        promotable = permit["promotable"]
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            "infrastructure_validation_receipt_evidence_invalid"
        ) from exc
    if (
        not permit_id
        or re.fullmatch(r"[0-9a-f]{64}", permit_sha256) is None
        or evidence_tag != _EVIDENCE_TAG
        or promotable is not False
    ):
        raise RuntimeError("infrastructure_validation_receipt_evidence_invalid")
    return InfrastructureValidationEvidence(
        receipt_id=receipt.id,
        permit_id=permit_id,
        permit_sha256=permit_sha256,
    )


def tag_infrastructure_validation_event(
    raw_event: object,
    evidence: InfrastructureValidationEvidence,
) -> object:
    """Attach a database-proven non-promotable marker to one broker event."""

    coerced = coerce_json_payload(raw_event)
    payload = (
        {
            str(key): value
            for key, value in cast(Mapping[object, object], coerced).items()
        }
        if isinstance(coerced, Mapping)
        else {"payload": coerced}
    )
    payload[_EVIDENCE_KEY] = {
        "schema_version": _EVIDENCE_SCHEMA_VERSION,
        **evidence_contract_payload(
            provenance=ArtifactProvenance.NON_PROMOTABLE_VALIDATION,
            maturity=EvidenceMaturity.EMPIRICALLY_VALIDATED,
        ),
        "promotable": False,
        "broker_mutation_receipt_id": str(evidence.receipt_id),
        "permit_id": evidence.permit_id,
        "permit_sha256": evidence.permit_sha256,
    }
    return coerce_json_payload(payload)


def strip_unproven_infrastructure_validation_evidence(raw_event: object) -> object:
    """Remove caller-supplied validation evidence before durable persistence."""

    coerced = coerce_json_payload(raw_event)
    if not isinstance(coerced, Mapping):
        return coerced
    payload = {
        str(key): value
        for key, value in cast(Mapping[object, object], coerced).items()
        if str(key) != _EVIDENCE_KEY
    }
    return coerce_json_payload(payload)


def is_non_promotable_validation_event(raw_event: object) -> bool:
    """Return whether a persisted event carries the exact exclusion marker."""

    coerced = coerce_json_payload(raw_event)
    if not isinstance(coerced, Mapping):
        return False
    evidence = cast(Mapping[object, object], coerced).get(_EVIDENCE_KEY)
    if not isinstance(evidence, Mapping):
        return False
    values = cast(Mapping[object, object], evidence)
    return (
        values.get("schema_version") == _EVIDENCE_SCHEMA_VERSION
        and values.get("provenance") == _EVIDENCE_TAG
        and values.get("maturity") == EvidenceMaturity.EMPIRICALLY_VALIDATED.value
        and values.get("authoritative") is False
        and values.get("placeholder") is False
        and values.get("promotable") is False
        and bool(str(values.get("broker_mutation_receipt_id") or "").strip())
        and bool(str(values.get("permit_id") or "").strip())
        and re.fullmatch(
            r"[0-9a-f]{64}",
            str(values.get("permit_sha256") or ""),
        )
        is not None
    )


__all__ = [
    "InfrastructureValidationEvidence",
    "is_non_promotable_validation_event",
    "load_infrastructure_validation_evidence",
    "strip_unproven_infrastructure_validation_evidence",
    "tag_infrastructure_validation_event",
]
