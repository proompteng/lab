"""Persistence and bounded read models for strategy capital authorities."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import cast
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import (
    EvidenceEpochRecord,
    Strategy,
    StrategyCapitalAuthorityRecord,
    TradeDecision,
)
from .strategy_capital_authority import (
    BROKER_RISK_STAGES,
    STRATEGY_CAPITAL_AUTHORITY_SCHEMA_VERSION,
    STRATEGY_CAPITAL_AUTHORITY_STATUS_SCHEMA_VERSION,
    CapitalStage,
    StrategyCapitalAuthority,
    canonical_payload_digest,
    required_evidence_epoch_decision,
    runtime_artifact_binding_reasons,
    validate_strategy_capital_authority,
)


_STATUS_LIMIT = 500


@dataclass(frozen=True)
class StrategyCapitalEvidenceBinding:
    evidence_epoch_id: str
    evidence_digest: str
    fresh_until: datetime


@dataclass(frozen=True)
class StrategyCapitalUsageQuery:
    strategy_id: UUID
    decision_id: UUID
    account_label: str
    observed_at: datetime
    session_started_at: datetime


@dataclass(frozen=True)
class _StatusObservation:
    observed_at: datetime
    runtime_code_commit: str | None
    runtime_image_digest: str | None


@dataclass(frozen=True)
class _StrategyStatusItem:
    payload: dict[str, object]
    stage: str
    enabled: bool
    grant_active: bool


def _payload_mapping(value: object) -> Mapping[str, object] | None:
    if not isinstance(value, Mapping):
        return None
    return cast(Mapping[str, object], value)


def _normalized_persisted_timestamp(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None or value.utcoffset() is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _payload_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return _normalized_persisted_timestamp(parsed)


def _reason_codes_have_blockers(value: object) -> bool:
    if not isinstance(value, list):
        return True
    return any(str(reason).strip() for reason in cast(list[object], value))


def _required_evidence_scope(stage: CapitalStage) -> str | None:
    return {
        CapitalStage.PAPER_PROBATION: "paper",
        CapitalStage.PAPER_VERIFIED: "paper",
        CapitalStage.MICRO_LIVE_ALLOWED: "canary",
        CapitalStage.CAPITAL_ALLOWED: "live",
        CapitalStage.SCALED: "scale",
    }.get(stage)


def activate_strategy_capital_authority(
    session: Session,
    *,
    strategy: Strategy,
    authority: StrategyCapitalAuthority,
) -> StrategyCapitalAuthorityRecord:
    """Insert an immutable authority once and atomically select it for a strategy."""

    authority = StrategyCapitalAuthority.model_validate(authority.to_payload())
    if strategy.name != authority.strategy_ref:
        raise ValueError("strategy capital authority does not bind the target strategy")
    session.flush()

    existing = session.execute(
        select(StrategyCapitalAuthorityRecord).where(
            StrategyCapitalAuthorityRecord.authority_id == authority.authority_id
        )
    ).scalar_one_or_none()
    payload = authority.to_payload()
    if existing is None:
        existing = StrategyCapitalAuthorityRecord(
            authority_id=authority.authority_id,
            strategy_id=strategy.id,
            schema_version=authority.schema_version,
            stage=authority.stage.value,
            authority_digest=authority.digest,
            payload_json=payload,
            issued_at=authority.issued_at,
            expires_at=authority.expires_at,
        )
        session.add(existing)
        session.flush()
    elif (
        existing.strategy_id != strategy.id
        or existing.schema_version != authority.schema_version
        or existing.stage != authority.stage.value
        or existing.authority_digest != authority.digest
        or existing.payload_json != payload
        or _normalized_persisted_timestamp(existing.issued_at) != authority.issued_at
        or _normalized_persisted_timestamp(existing.expires_at) != authority.expires_at
    ):
        raise ValueError("authority_id already identifies different immutable content")

    strategy.active_capital_authority = existing
    strategy.active_capital_authority_id = existing.id
    return existing


def load_active_strategy_capital_authority(
    session: Session,
    *,
    strategy: Strategy,
    lock_for_update: bool = False,
    lock_for_share: bool = False,
) -> StrategyCapitalAuthorityRecord | None:
    if lock_for_update and lock_for_share:
        raise ValueError("capital authority lock modes are mutually exclusive")
    statement = select(Strategy.active_capital_authority_id).where(
        Strategy.id == strategy.id
    )
    if lock_for_update:
        statement = statement.with_for_update()
    elif lock_for_share:
        statement = statement.with_for_update(read=True)
    active_authority_id = session.execute(statement).scalar_one_or_none()
    if active_authority_id is None:
        return None
    record = session.get(
        StrategyCapitalAuthorityRecord,
        active_authority_id,
    )
    if record is None:
        return None
    if record.strategy_id != strategy.id:
        raise ValueError("active capital authority points to another strategy")
    return record


def validate_strategy_capital_authority_record(
    *,
    strategy: Strategy,
    record: StrategyCapitalAuthorityRecord | None,
) -> tuple[StrategyCapitalAuthority | None, tuple[str, ...]]:
    if record is None:
        return None, ("authority_missing",)
    if record.strategy_id != strategy.id:
        return None, ("authority_record_strategy_id_mismatch",)
    authority, reasons = validate_strategy_capital_authority(
        payload=_payload_mapping(record.payload_json),
        persisted_digest=record.authority_digest,
        expected_strategy_ref=strategy.name,
    )
    if authority is None or reasons:
        return authority, reasons

    record_reasons: list[str] = []
    if record.authority_id != authority.authority_id:
        record_reasons.append("authority_record_id_mismatch")
    if record.schema_version != authority.schema_version:
        record_reasons.append("authority_record_schema_mismatch")
    if record.stage != authority.stage.value:
        record_reasons.append("authority_record_stage_mismatch")
    if _normalized_persisted_timestamp(record.issued_at) != authority.issued_at:
        record_reasons.append("authority_record_issued_at_mismatch")
    if _normalized_persisted_timestamp(record.expires_at) != authority.expires_at:
        record_reasons.append("authority_record_expires_at_mismatch")
    return authority, tuple(record_reasons)


def count_strategy_authority_usage(
    session: Session,
    *,
    query: StrategyCapitalUsageQuery,
) -> tuple[int, int]:
    observed_utc = query.observed_at.astimezone(timezone.utc)
    minute_started_at = observed_utc - timedelta(minutes=1)
    statement = select(
        func.count(TradeDecision.id)
        .filter(
            TradeDecision.strategy_capital_authority_evaluated_at >= minute_started_at
        )
        .label("orders_last_minute"),
        func.count(TradeDecision.id)
        .filter(
            TradeDecision.strategy_capital_authority_evaluated_at
            >= query.session_started_at
        )
        .label("orders_this_session"),
    ).where(
        TradeDecision.strategy_id == query.strategy_id,
        TradeDecision.id != query.decision_id,
        TradeDecision.alpaca_account_label == query.account_label,
        TradeDecision.strategy_capital_authority_evaluated_at <= observed_utc,
        TradeDecision.strategy_capital_authority_allowed.is_(True),
    )
    row = session.execute(statement).one()
    return int(row.orders_last_minute or 0), int(row.orders_this_session or 0)


def _evidence_payload_digest(
    value: object,
) -> tuple[Mapping[str, object] | None, str | None]:
    payload = _payload_mapping(value)
    if payload is None:
        return None, None
    try:
        return payload, canonical_payload_digest(payload)
    except (TypeError, ValueError):
        return None, None


def _evidence_record_reasons(
    authority: StrategyCapitalAuthority,
    record: EvidenceEpochRecord,
    observed_at: datetime,
    fresh_until: datetime | None,
    evidence_digest: str,
) -> list[str]:
    assert authority.account_label is not None
    assert authority.proofs is not None
    reasons: list[str] = []
    if evidence_digest != authority.proofs.evidence_digest:
        reasons.append("authority_evidence_digest_mismatch")
    if record.account_label != authority.account_label:
        reasons.append("authority_evidence_account_mismatch")
    required_decision = required_evidence_epoch_decision(authority.stage)
    if required_decision is None or record.decision != required_decision:
        reasons.append("authority_evidence_decision_mismatch")
    required_scope = _required_evidence_scope(authority.stage)
    if required_scope is None or record.stage_scope != required_scope:
        reasons.append("authority_evidence_scope_mismatch")
    if fresh_until is None:
        reasons.append("authority_evidence_freshness_unavailable")
    elif observed_at >= fresh_until:
        reasons.append("authority_evidence_expired")
    if _reason_codes_have_blockers(record.reason_codes_json):
        reasons.append("authority_evidence_has_blockers")
    return reasons


def _evidence_payload_reasons(
    payload: Mapping[str, object],
    record: EvidenceEpochRecord,
    fresh_until: datetime | None,
) -> list[str]:
    reasons: list[str] = []
    if payload.get("schema_version") != "torghut.evidence-epoch.v1":
        reasons.append("authority_evidence_schema_mismatch")
    if payload.get("evidence_epoch_id") != record.evidence_epoch_id:
        reasons.append("authority_evidence_payload_id_mismatch")
    if payload.get("account_label") != record.account_label:
        reasons.append("authority_evidence_payload_account_mismatch")
    if payload.get("stage_scope") != record.stage_scope:
        reasons.append("authority_evidence_payload_scope_mismatch")
    if payload.get("decision") != record.decision:
        reasons.append("authority_evidence_payload_decision_mismatch")
    if _payload_timestamp(payload.get("fresh_until")) != fresh_until:
        reasons.append("authority_evidence_payload_freshness_mismatch")
    if _reason_codes_have_blockers(payload.get("reason_codes")):
        reasons.append("authority_evidence_payload_has_blockers")
    return reasons


def load_strategy_capital_evidence_binding(
    session: Session,
    *,
    authority: StrategyCapitalAuthority,
    observed_at: datetime,
) -> tuple[StrategyCapitalEvidenceBinding | None, tuple[str, ...]]:
    """Validate the exact persisted evidence epoch bound by a broker grant."""

    if authority.stage not in BROKER_RISK_STAGES:
        return None, ()
    assert authority.evidence_epoch_id is not None
    assert authority.account_label is not None
    assert authority.proofs is not None
    observed_utc = _normalized_persisted_timestamp(observed_at)
    if observed_utc is None:
        return None, ("authority_evidence_observation_time_invalid",)
    record = session.execute(
        select(EvidenceEpochRecord).where(
            EvidenceEpochRecord.evidence_epoch_id == authority.evidence_epoch_id
        )
    ).scalar_one_or_none()
    if record is None:
        return None, ("authority_evidence_epoch_missing",)

    payload, evidence_digest = _evidence_payload_digest(record.payload_json)
    if payload is None or evidence_digest is None:
        return None, ("authority_evidence_payload_invalid",)
    fresh_until = _normalized_persisted_timestamp(record.fresh_until)
    reasons = _evidence_record_reasons(
        authority,
        record,
        observed_utc,
        fresh_until,
        evidence_digest,
    )
    reasons.extend(_evidence_payload_reasons(payload, record, fresh_until))
    normalized_reasons = tuple(dict.fromkeys(reasons))
    if normalized_reasons or fresh_until is None:
        return None, normalized_reasons
    return (
        StrategyCapitalEvidenceBinding(
            evidence_epoch_id=record.evidence_epoch_id,
            evidence_digest=evidence_digest,
            fresh_until=fresh_until,
        ),
        (),
    )


def _broker_grant_active(
    authority: StrategyCapitalAuthority | None,
    reasons: tuple[str, ...],
    *,
    observed_at: datetime,
) -> bool:
    return bool(
        not reasons
        and authority is not None
        and authority.stage in BROKER_RISK_STAGES
        and not authority.reduce_only
        and authority.issued_at is not None
        and authority.expires_at is not None
        and authority.issued_at <= observed_at < authority.expires_at
        and authority.session is not None
        and authority.session.contains(observed_at)
    )


def _strategy_status_item(
    session: Session,
    strategy: Strategy,
    record: StrategyCapitalAuthorityRecord | None,
    observation: _StatusObservation,
) -> _StrategyStatusItem:
    authority, contract_reasons = validate_strategy_capital_authority_record(
        strategy=strategy,
        record=record,
    )
    stage = authority.stage.value if authority is not None else "quarantined"
    broker_stage = authority is not None and authority.stage in BROKER_RISK_STAGES
    runtime_reasons = (
        runtime_artifact_binding_reasons(
            authority=authority,
            runtime_code_commit=observation.runtime_code_commit,
            runtime_image_digest=observation.runtime_image_digest,
        )
        if authority is not None
        else ()
    )
    evidence_binding: StrategyCapitalEvidenceBinding | None = None
    evidence_reasons: tuple[str, ...] = ()
    if broker_stage:
        assert authority is not None
        evidence_binding, evidence_reasons = load_strategy_capital_evidence_binding(
            session,
            authority=authority,
            observed_at=observation.observed_at,
        )
    strategy_reasons = () if strategy.enabled else ("strategy_disabled",)
    effective_reasons = tuple(
        dict.fromkeys(
            [
                *contract_reasons,
                *strategy_reasons,
                *runtime_reasons,
                *evidence_reasons,
            ]
        )
    )
    grant_active = _broker_grant_active(
        authority,
        effective_reasons,
        observed_at=observation.observed_at,
    )
    return _StrategyStatusItem(
        stage=stage,
        enabled=strategy.enabled,
        grant_active=grant_active,
        payload={
            "strategy_id": str(strategy.id),
            "strategy_ref": strategy.name,
            "enabled": strategy.enabled,
            "configured": record is not None,
            "contract_valid": not contract_reasons,
            "authority_id": authority.authority_id if authority is not None else None,
            "authority_digest": record.authority_digest if record is not None else None,
            "stage": stage,
            "account_mode": authority.account_mode.value
            if authority is not None
            else "none",
            "venue": authority.venue.value if authority is not None else "none",
            "issued_at": authority.issued_at if authority is not None else None,
            "expires_at": authority.expires_at if authority is not None else None,
            "broker_risk_increase_grant_active": grant_active,
            "runtime_artifact_match": not runtime_reasons if broker_stage else None,
            "evidence_epoch_current": evidence_binding is not None
            if broker_stage
            else None,
            "blockers": list(authority.blockers) if authority is not None else [],
            "reason_codes": list(effective_reasons),
        },
    )


def strategy_capital_authority_status(
    session: Session,
    *,
    observed_at: datetime,
    runtime_code_commit: str | None = None,
    runtime_image_digest: str | None = None,
) -> dict[str, object]:
    observed_utc = observed_at.astimezone(timezone.utc)
    rows = session.execute(
        select(Strategy, StrategyCapitalAuthorityRecord)
        .outerjoin(
            StrategyCapitalAuthorityRecord,
            Strategy.active_capital_authority_id == StrategyCapitalAuthorityRecord.id,
        )
        .order_by(Strategy.name.asc(), Strategy.id.asc())
        .limit(_STATUS_LIMIT + 1)
    ).all()
    truncated = len(rows) > _STATUS_LIMIT
    rows = rows[:_STATUS_LIMIT]
    observation = _StatusObservation(
        observed_at=observed_utc,
        runtime_code_commit=runtime_code_commit,
        runtime_image_digest=runtime_image_digest,
    )
    items: list[dict[str, object]] = []
    stage_counts: dict[str, int] = {}
    enabled_count = 0
    active_broker_grant_count = 0
    for strategy, record in rows:
        status_item = _strategy_status_item(session, strategy, record, observation)
        enabled_count += int(status_item.enabled)
        stage_counts[status_item.stage] = stage_counts.get(status_item.stage, 0) + 1
        active_broker_grant_count += int(status_item.grant_active)
        items.append(status_item.payload)
    return {
        "schema_version": STRATEGY_CAPITAL_AUTHORITY_STATUS_SCHEMA_VERSION,
        "authority_schema_version": STRATEGY_CAPITAL_AUTHORITY_SCHEMA_VERSION,
        "observed_at": observed_utc,
        "strategy_count": len(items),
        "enabled_strategy_count": enabled_count,
        "active_broker_grant_count": active_broker_grant_count,
        "stage_counts": stage_counts,
        "truncated": truncated,
        "strategies": items,
    }


__all__ = (
    "StrategyCapitalEvidenceBinding",
    "StrategyCapitalUsageQuery",
    "activate_strategy_capital_authority",
    "count_strategy_authority_usage",
    "load_active_strategy_capital_authority",
    "load_strategy_capital_evidence_binding",
    "strategy_capital_authority_status",
    "validate_strategy_capital_authority_record",
)
