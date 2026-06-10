"""Cross-plane Torghut evidence epoch compilation and persistence."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal, cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import EvidenceEpochRecord, EvidenceReceiptRecord
from .evidence_receipts import EvidenceReceipt

EvidenceEpochDecision = Literal[
    "shadow_only",
    "research_allowed",
    "paper_allowed",
    "canary_allowed",
    "live_allowed",
    "scale_allowed",
    "quarantined",
]

_BASE_REQUIRED_RECEIPTS = (
    "internal_authority",
    "service_health",
    "schema",
    "data_freshness",
    "empirical_jobs",
    "artifact_parity",
)
_CAPITAL_REQUIRED_RECEIPTS = (*_BASE_REQUIRED_RECEIPTS, "portfolio_proof")
_BLOCKING_STATES = {"fail", "missing", "stale", "timeout", "unknown"}
_STAGE_DECISIONS: dict[str, EvidenceEpochDecision] = {
    "research": "research_allowed",
    "paper": "paper_allowed",
    "canary": "canary_allowed",
    "live": "live_allowed",
    "scale": "scale_allowed",
}


@dataclass(frozen=True)
class EvidenceEpoch:
    evidence_epoch_id: str
    account_label: str
    stage_scope: str
    created_at: datetime
    fresh_until: datetime
    decision: EvidenceEpochDecision
    reason_codes: tuple[str, ...]
    receipts: tuple[EvidenceReceipt, ...]

    def to_payload(self) -> dict[str, object]:
        receipt_payloads = [receipt.to_payload() for receipt in self.receipts]
        return {
            "schema_version": "torghut.evidence-epoch.v1",
            "evidence_epoch_id": self.evidence_epoch_id,
            "account_label": self.account_label,
            "stage_scope": self.stage_scope,
            "created_at": _datetime_iso(self.created_at),
            "fresh_until": _datetime_iso(self.fresh_until),
            "decision": self.decision,
            "reason_codes": list(self.reason_codes),
            "receipt_ids": [receipt.receipt_id for receipt in self.receipts],
            "receipts": receipt_payloads,
        }


def _datetime_iso(value: datetime) -> str:
    return _ensure_aware(value).isoformat()


def _ensure_aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _epoch_id(
    *,
    account_label: str,
    stage_scope: str,
    created_at: datetime,
    receipt_ids: Sequence[str],
) -> str:
    payload = {
        "account_label": account_label,
        "stage_scope": stage_scope,
        "created_at": _datetime_iso(created_at),
        "receipt_ids": list(receipt_ids),
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return f"tee-{hashlib.sha256(encoded).hexdigest()[:32]}"


def _dedupe_reasons(reasons: Sequence[str]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(reason for reason in reasons if reason.strip()))


def _required_receipts_for_stage(stage_scope: str) -> tuple[str, ...]:
    if stage_scope in {"paper", "canary", "live", "scale"}:
        return _CAPITAL_REQUIRED_RECEIPTS
    if stage_scope == "research":
        return _BASE_REQUIRED_RECEIPTS
    return ()


def _decision_for_stage(
    stage_scope: str, blockers: Sequence[str]
) -> EvidenceEpochDecision:
    if stage_scope in {"shadow", "shadow_only", ""}:
        return "shadow_only"
    if blockers:
        return "quarantined"
    return _STAGE_DECISIONS.get(stage_scope, "shadow_only")


def compile_evidence_epoch(
    *,
    account_label: str,
    stage_scope: str,
    receipts: Sequence[EvidenceReceipt],
    created_at: datetime | None = None,
) -> EvidenceEpoch:
    normalized_stage = stage_scope.strip().lower().replace("-", "_") or "shadow"
    created = _ensure_aware(created_at or datetime.now(timezone.utc))
    receipt_tuple = tuple(receipts)
    receipt_types = {receipt.receipt_type for receipt in receipt_tuple}
    required_receipts = _required_receipts_for_stage(normalized_stage)
    blockers: list[str] = []

    for required_type in required_receipts:
        if required_type not in receipt_types:
            blockers.append(f"receipt_missing:{required_type}")

    for receipt in receipt_tuple:
        if (
            receipt.receipt_type in required_receipts
            and receipt.state in _BLOCKING_STATES
        ):
            blockers.extend(
                f"{receipt.receipt_type}:{reason}" for reason in receipt.reason_codes
            )
            if not receipt.reason_codes:
                blockers.append(f"{receipt.receipt_type}:receipt_state_{receipt.state}")

    reason_codes = _dedupe_reasons(blockers)
    fresh_candidates = [_ensure_aware(receipt.fresh_until) for receipt in receipt_tuple]
    fresh_until = min(fresh_candidates) if fresh_candidates else created
    decision = _decision_for_stage(normalized_stage, reason_codes)
    if decision == "quarantined":
        fresh_until = created

    return EvidenceEpoch(
        evidence_epoch_id=_epoch_id(
            account_label=account_label,
            stage_scope=normalized_stage,
            created_at=created,
            receipt_ids=[receipt.receipt_id for receipt in receipt_tuple],
        ),
        account_label=account_label,
        stage_scope=normalized_stage,
        created_at=created,
        fresh_until=fresh_until,
        decision=decision,
        reason_codes=reason_codes,
        receipts=receipt_tuple,
    )


def persist_evidence_epoch(
    session: Session, epoch: EvidenceEpoch
) -> EvidenceEpochRecord:
    epoch_payload = epoch.to_payload()
    for receipt in epoch.receipts:
        session.add(
            EvidenceReceiptRecord(
                receipt_id=receipt.receipt_id,
                evidence_epoch_id=epoch.evidence_epoch_id,
                receipt_type=receipt.receipt_type,
                producer=receipt.producer,
                subject_ref=receipt.subject_ref,
                state=receipt.state,
                decision=receipt.decision,
                observed_at=receipt.observed_at,
                fresh_until=receipt.fresh_until,
                reason_codes_json=list(receipt.reason_codes),
                payload_json=receipt.to_payload(),
            )
        )
    record = EvidenceEpochRecord(
        evidence_epoch_id=epoch.evidence_epoch_id,
        account_label=epoch.account_label,
        stage_scope=epoch.stage_scope,
        decision=epoch.decision,
        fresh_until=epoch.fresh_until,
        reason_codes_json=list(epoch.reason_codes),
        receipt_ids_json=[receipt.receipt_id for receipt in epoch.receipts],
        payload_json=epoch_payload,
    )
    session.add(record)
    return record


def load_evidence_epoch_payload(
    session: Session,
    evidence_epoch_id: str,
) -> dict[str, object] | None:
    record = session.execute(
        select(EvidenceEpochRecord).where(
            EvidenceEpochRecord.evidence_epoch_id == evidence_epoch_id
        )
    ).scalar_one_or_none()
    if record is None:
        return None
    return _payload_from_record(record)


def load_latest_evidence_epoch_payload(
    session: Session,
    *,
    account_label: str | None = None,
    stage_scope: str | None = None,
) -> dict[str, object] | None:
    statement = select(EvidenceEpochRecord)
    if account_label is not None:
        statement = statement.where(EvidenceEpochRecord.account_label == account_label)
    if stage_scope is not None:
        statement = statement.where(
            EvidenceEpochRecord.stage_scope
            == stage_scope.strip().lower().replace("-", "_")
        )
    record = session.execute(
        statement.order_by(EvidenceEpochRecord.created_at.desc()).limit(1)
    ).scalar_one_or_none()
    if record is None:
        return None
    return _payload_from_record(record)


def _payload_from_record(record: EvidenceEpochRecord) -> dict[str, object]:
    payload = record.payload_json
    if isinstance(payload, Mapping):
        return dict(cast(Mapping[str, object], payload))
    return {
        "schema_version": "torghut.evidence-epoch.v1",
        "evidence_epoch_id": record.evidence_epoch_id,
        "account_label": record.account_label,
        "stage_scope": record.stage_scope,
        "created_at": _datetime_iso(record.created_at),
        "fresh_until": _datetime_iso(record.fresh_until),
        "decision": record.decision,
        "reason_codes": list(cast(list[object], record.reason_codes_json or [])),
        "receipt_ids": list(cast(list[object], record.receipt_ids_json or [])),
        "receipts": [],
    }


__all__ = [
    "EvidenceEpoch",
    "EvidenceEpochDecision",
    "compile_evidence_epoch",
    "load_evidence_epoch_payload",
    "load_latest_evidence_epoch_payload",
    "persist_evidence_epoch",
]
