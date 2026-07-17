"""Atomic, append-only census manifests for order-lineage repair evidence."""

from __future__ import annotations

import hashlib
import json
import uuid
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Final, Mapping, Sequence, cast

from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..models import OrderLineageRepairRun, coerce_json_payload
from .order_lineage_receipts import (
    CLASSIFICATIONS,
    ORDER_LINEAGE_REPAIR_VERSION,
    OrderLineageReceiptDraft,
    persist_order_lineage_receipt,
)


ORDER_LINEAGE_CENSUS_INPUT_SCHEMA_VERSION: Final = (
    "torghut.order-lineage-census-input.v1"
)
ORDER_LINEAGE_CENSUS_RESULT_SCHEMA_VERSION: Final = (
    "torghut.order-lineage-census-result.v1"
)
_SOURCE_COVERAGE_CLASSES: Final = (
    "both",
    "broker_activity_only",
    "order_feed_only",
)


@dataclass(frozen=True, slots=True)
class OrderLineageCensusSources:
    provider: str
    environment: str
    account_label: str
    broker_economic_input_id: uuid.UUID
    broker_economic_source: str
    broker_economic_manifest_sha256: str
    broker_activity_count: int
    broker_source_watermark: datetime
    broker_order_link_manifest: Mapping[str, object]
    order_feed_manifest: Mapping[str, object]
    execution_manifest: Mapping[str, object]


@dataclass(frozen=True, slots=True)
class OrderLineageRepairRunDraft:
    repair_version: str
    provider: str
    environment: str
    account_label: str
    broker_economic_input_id: uuid.UUID
    input_manifest: dict[str, object]
    input_manifest_canonical_json: str
    input_manifest_sha256: str
    receipt_count: int
    result: dict[str, object]
    result_canonical_json: str
    result_sha256: str
    promotion_authority_eligible: bool = False


@dataclass(frozen=True, slots=True)
class PersistedOrderLineageRepairRun:
    run: OrderLineageRepairRun
    reused_existing: bool


@dataclass(frozen=True, slots=True)
class PersistedOrderLineageCensus:
    run: PersistedOrderLineageRepairRun
    inserted_receipt_count: int
    reused_receipt_count: int


def build_order_lineage_repair_run(
    sources: OrderLineageCensusSources,
    receipts: Sequence[OrderLineageReceiptDraft],
) -> OrderLineageRepairRunDraft:
    """Seal one deterministic current receipt set over closed source manifests."""

    normalized_sources = _normalize_sources(sources)
    ordered_receipts = _validated_receipts(normalized_sources, receipts)
    receipt_set_payload = [
        [receipt.order_identity_sha256, receipt.evidence_sha256]
        for receipt in ordered_receipts
    ]
    classification_counts = Counter(
        receipt.classification for receipt in ordered_receipts
    )
    source_coverage_counts = Counter(
        _source_coverage(receipt) for receipt in ordered_receipts
    )
    input_manifest: dict[str, object] = {
        "broker_economic_source": normalized_sources.broker_economic_source,
        "broker_economic_input_id": str(normalized_sources.broker_economic_input_id),
        "broker_economic_manifest_sha256": (
            normalized_sources.broker_economic_manifest_sha256
        ),
        "broker_source_watermark": (
            normalized_sources.broker_source_watermark.isoformat()
        ),
        "broker_activity_count": normalized_sources.broker_activity_count,
        "expected_order_identity_count": len(ordered_receipts),
        "broker_order_links": coerce_json_payload(
            normalized_sources.broker_order_link_manifest
        ),
        "executions": coerce_json_payload(normalized_sources.execution_manifest),
        "order_feed": coerce_json_payload(normalized_sources.order_feed_manifest),
        "repair_version": ORDER_LINEAGE_REPAIR_VERSION,
        "schema_version": ORDER_LINEAGE_CENSUS_INPUT_SCHEMA_VERSION,
        "scope": {
            "account_label": normalized_sources.account_label,
            "environment": normalized_sources.environment,
            "provider": normalized_sources.provider,
        },
    }
    input_json = _canonical_json(input_manifest)
    result: dict[str, object] = {
        "classification_counts": {
            classification: classification_counts.get(classification, 0)
            for classification in sorted(CLASSIFICATIONS)
        },
        "promotion_authority_eligible": False,
        "receipt_count": len(ordered_receipts),
        "receipt_set_sha256": _canonical_sha256(receipt_set_payload),
        "repair_version": ORDER_LINEAGE_REPAIR_VERSION,
        "schema_version": ORDER_LINEAGE_CENSUS_RESULT_SCHEMA_VERSION,
        "source_coverage_counts": {
            classification: source_coverage_counts.get(classification, 0)
            for classification in _SOURCE_COVERAGE_CLASSES
        },
    }
    result_json = _canonical_json(result)
    return OrderLineageRepairRunDraft(
        repair_version=ORDER_LINEAGE_REPAIR_VERSION,
        provider=normalized_sources.provider,
        environment=normalized_sources.environment,
        account_label=normalized_sources.account_label,
        broker_economic_input_id=normalized_sources.broker_economic_input_id,
        input_manifest=coerce_json_payload(input_manifest),
        input_manifest_canonical_json=input_json,
        input_manifest_sha256=_sha256(input_json),
        receipt_count=len(ordered_receipts),
        result=coerce_json_payload(result),
        result_canonical_json=result_json,
        result_sha256=_sha256(result_json),
    )


def persist_order_lineage_census(
    session: Session,
    sources: OrderLineageCensusSources,
    receipts: Sequence[OrderLineageReceiptDraft],
    *,
    observed_at: datetime,
) -> PersistedOrderLineageCensus:
    """Persist changed receipt states and the closed run in one caller transaction."""

    run_draft = build_order_lineage_repair_run(sources, receipts)
    _acquire_scope_lock(session, run_draft)
    persisted_receipts = [
        persist_order_lineage_receipt(
            session,
            receipt,
            observed_at=observed_at,
        )
        for receipt in receipts
    ]
    persisted_run = persist_order_lineage_repair_run(
        session,
        run_draft,
        observed_at=observed_at,
    )
    return PersistedOrderLineageCensus(
        run=persisted_run,
        inserted_receipt_count=sum(
            not receipt.reused_existing for receipt in persisted_receipts
        ),
        reused_receipt_count=sum(
            receipt.reused_existing for receipt in persisted_receipts
        ),
    )


def persist_order_lineage_repair_run(
    session: Session,
    draft: OrderLineageRepairRunDraft,
    *,
    observed_at: datetime,
) -> PersistedOrderLineageRepairRun:
    """Append one closed run or reuse the deterministic existing result."""

    existing = _existing_run(session, draft)
    if existing is not None:
        return _reused_run(existing, draft)
    row = OrderLineageRepairRun(
        repair_version=draft.repair_version,
        provider=draft.provider,
        environment=draft.environment,
        account_label=draft.account_label,
        broker_economic_input_id=draft.broker_economic_input_id,
        input_manifest=draft.input_manifest,
        input_manifest_canonical_json=draft.input_manifest_canonical_json,
        input_manifest_sha256=draft.input_manifest_sha256,
        receipt_count=draft.receipt_count,
        result=draft.result,
        result_canonical_json=draft.result_canonical_json,
        result_sha256=draft.result_sha256,
        promotion_authority_eligible=draft.promotion_authority_eligible,
        observed_at=_required_utc(observed_at),
    )
    try:
        with session.begin_nested():
            session.add(row)
            session.flush()
    except IntegrityError:
        existing = _existing_run(session, draft)
        if existing is None:
            raise
        return _reused_run(existing, draft)
    return PersistedOrderLineageRepairRun(run=row, reused_existing=False)


def _normalize_sources(
    sources: OrderLineageCensusSources,
) -> OrderLineageCensusSources:
    provider = _required_text(sources.provider, "order_lineage_provider_missing")
    environment = _required_text(
        sources.environment,
        "order_lineage_environment_missing",
    )
    account_label = _required_text(
        sources.account_label,
        "order_lineage_account_label_missing",
    )
    broker_economic_source = _required_text(
        sources.broker_economic_source,
        "order_lineage_broker_source_missing",
    )
    manifest_sha = sources.broker_economic_manifest_sha256.strip().lower()
    if len(manifest_sha) != 64 or any(
        value not in "0123456789abcdef" for value in manifest_sha
    ):
        raise ValueError("order_lineage_broker_manifest_hash_invalid")
    if sources.broker_activity_count < 0:
        raise ValueError("order_lineage_broker_activity_count_invalid")
    return OrderLineageCensusSources(
        provider=provider,
        environment=environment,
        account_label=account_label,
        broker_economic_input_id=uuid.UUID(str(sources.broker_economic_input_id)),
        broker_economic_source=broker_economic_source,
        broker_economic_manifest_sha256=manifest_sha,
        broker_activity_count=sources.broker_activity_count,
        broker_source_watermark=_required_utc(sources.broker_source_watermark),
        broker_order_link_manifest=coerce_json_payload(
            sources.broker_order_link_manifest
        ),
        order_feed_manifest=coerce_json_payload(sources.order_feed_manifest),
        execution_manifest=coerce_json_payload(sources.execution_manifest),
    )


def _validated_receipts(
    sources: OrderLineageCensusSources,
    receipts: Sequence[OrderLineageReceiptDraft],
) -> list[OrderLineageReceiptDraft]:
    identities: set[str] = set()
    ordered: list[OrderLineageReceiptDraft] = []
    for receipt in sorted(receipts, key=lambda value: value.order_identity_sha256):
        if (
            receipt.repair_version != ORDER_LINEAGE_REPAIR_VERSION
            or receipt.provider != sources.provider
            or receipt.environment != sources.environment
            or receipt.account_label != sources.account_label
        ):
            raise ValueError("order_lineage_receipt_scope_mismatch")
        if receipt.order_identity_sha256 in identities:
            raise ValueError("order_lineage_duplicate_order_identity")
        identities.add(receipt.order_identity_sha256)
        ordered.append(receipt)
    return ordered


def _source_coverage(receipt: OrderLineageReceiptDraft) -> str:
    sources_value = receipt.evidence.get("sources")
    if not isinstance(sources_value, dict):
        raise ValueError("order_lineage_receipt_sources_missing")
    sources = cast(dict[object, object], sources_value)
    counts_value = sources.get("counts")
    if not isinstance(counts_value, dict):
        raise ValueError("order_lineage_receipt_source_counts_missing")
    counts = cast(dict[object, object], counts_value)
    order_event_count = _count_value(counts, "order_events")
    broker_activity_count = _count_value(counts, "broker_activities")
    if order_event_count and broker_activity_count:
        return "both"
    if broker_activity_count:
        return "broker_activity_only"
    if order_event_count:
        return "order_feed_only"
    raise ValueError("order_lineage_receipt_source_counts_empty")


def _count_value(counts: dict[object, object], key: str) -> int:
    value = counts.get(key)
    if not isinstance(value, int) or value < 0:
        raise ValueError("order_lineage_receipt_source_count_invalid")
    return value


def _existing_run(
    session: Session,
    draft: OrderLineageRepairRunDraft,
) -> OrderLineageRepairRun | None:
    return session.scalar(
        select(OrderLineageRepairRun).where(
            OrderLineageRepairRun.repair_version == draft.repair_version,
            OrderLineageRepairRun.provider == draft.provider,
            OrderLineageRepairRun.environment == draft.environment,
            OrderLineageRepairRun.account_label == draft.account_label,
            OrderLineageRepairRun.input_manifest_sha256 == draft.input_manifest_sha256,
        )
    )


def _reused_run(
    existing: OrderLineageRepairRun,
    draft: OrderLineageRepairRunDraft,
) -> PersistedOrderLineageRepairRun:
    if existing.result_sha256 != draft.result_sha256:
        raise ValueError("order_lineage_run_nondeterministic")
    return PersistedOrderLineageRepairRun(run=existing, reused_existing=True)


def _acquire_scope_lock(
    session: Session,
    draft: OrderLineageRepairRunDraft,
) -> None:
    if session.get_bind().dialect.name != "postgresql":
        return
    scope = "\x1f".join(
        (
            draft.repair_version,
            draft.provider,
            draft.environment,
            draft.account_label,
        )
    )
    session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:scope, 0))"),
        {"scope": scope},
    )


def _canonical_json(value: object) -> str:
    return json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _canonical_sha256(value: object) -> str:
    return _sha256(_canonical_json(value))


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _required_text(value: object, error: str) -> str:
    normalized = str(value).strip() if value is not None else ""
    if not normalized:
        raise ValueError(error)
    return normalized


def _required_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise ValueError("order_lineage_timestamp_timezone_missing")
    return value.astimezone(timezone.utc)


__all__ = (
    "ORDER_LINEAGE_CENSUS_INPUT_SCHEMA_VERSION",
    "ORDER_LINEAGE_CENSUS_RESULT_SCHEMA_VERSION",
    "OrderLineageCensusSources",
    "OrderLineageRepairRunDraft",
    "PersistedOrderLineageCensus",
    "PersistedOrderLineageRepairRun",
    "build_order_lineage_repair_run",
    "persist_order_lineage_census",
    "persist_order_lineage_repair_run",
)
