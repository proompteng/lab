"""Atomic, append-only census manifests for order-lineage repair evidence."""

from __future__ import annotations

import hashlib
import uuid
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Final, Mapping, Sequence, cast

from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..models import (
    OrderLineageCanonicalExecutionImport,
    OrderLineageRepairReceipt,
    OrderLineageRepairRun,
    coerce_json_payload,
)
from .order_lineage_receipts import (
    CLASSIFICATIONS,
    CONFIDENCES,
    EXECUTION_SOURCES,
    ORDER_LINEAGE_REPAIR_VERSION,
    OrderLineageReceiptDraft,
    canonical_jsonb_text,
    canonical_timestamptz_text,
    persist_order_lineage_receipt,
)


ORDER_LINEAGE_CENSUS_INPUT_SCHEMA_VERSION: Final = (
    "torghut.order-lineage-census-input.v1"
)
ORDER_LINEAGE_CENSUS_RESULT_SCHEMA_VERSION: Final = (
    "torghut.order-lineage-census-result.v1"
)
ORDER_LINEAGE_CANONICAL_EXECUTION_IMPORT_SCHEMA_VERSION: Final = (
    "torghut.order-lineage-canonical-execution-import.v1"
)
_SOURCE_COVERAGE_CLASSES: Final = (
    "both",
    "broker_activity_only",
    "order_feed_only",
)


@dataclass(frozen=True, slots=True)
class OrderLineageCanonicalExecutionImportDraft:
    provider: str
    environment: str
    account_label: str
    source_database_sha256: str
    canonical_account_label_sha256: str
    execution_count: int
    execution_set_sha256: str
    latest_updated_at: datetime | None
    manifest: dict[str, object]
    manifest_canonical_json: str
    manifest_sha256: str


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
    canonical_execution_import: OrderLineageCanonicalExecutionImportDraft


@dataclass(frozen=True, slots=True)
class OrderLineageRepairRunDraft:
    repair_version: str
    provider: str
    environment: str
    account_label: str
    broker_economic_input_id: uuid.UUID
    canonical_execution_import_sha256: str
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


def build_order_lineage_canonical_execution_import(
    *,
    provider: str,
    environment: str,
    account_label: str,
    source_database_sha256: str,
    execution_manifest: Mapping[str, object],
) -> OrderLineageCanonicalExecutionImportDraft:
    """Bind the cross-database execution component to one immutable import."""

    normalized_provider = _required_text(provider, "order_lineage_provider_missing")
    normalized_environment = _required_text(
        environment,
        "order_lineage_environment_missing",
    )
    normalized_account = _required_text(
        account_label,
        "order_lineage_account_label_missing",
    )
    source_database = _sha256_value(
        source_database_sha256,
        "order_lineage_source_database_hash_invalid",
    )
    canonical_account = _sha256_value(
        execution_manifest.get("canonical_account_label_sha256"),
        "order_lineage_canonical_scope_hash_invalid",
    )
    execution_count = _nonnegative_int(
        execution_manifest.get("canonical_execution_count"),
        "order_lineage_canonical_execution_count_invalid",
    )
    execution_set = _sha256_value(
        execution_manifest.get("canonical_execution_set_sha256"),
        "order_lineage_canonical_execution_set_hash_invalid",
    )
    latest_updated_at = _optional_utc_text(
        execution_manifest.get("canonical_latest_updated_at"),
        "order_lineage_canonical_latest_updated_at_invalid",
    )
    manifest: dict[str, object] = {
        "canonical_account_label_sha256": canonical_account,
        "execution_count": execution_count,
        "execution_set_sha256": execution_set,
        "latest_updated_at": (
            canonical_timestamptz_text(latest_updated_at)
            if latest_updated_at is not None
            else None
        ),
        "schema_version": ORDER_LINEAGE_CANONICAL_EXECUTION_IMPORT_SCHEMA_VERSION,
        "scope": {
            "account_label": normalized_account,
            "environment": normalized_environment,
            "provider": normalized_provider,
        },
        "source": "canonical_cross_dsn",
        "source_database_sha256": source_database,
    }
    canonical_json = canonical_jsonb_text(manifest)
    return OrderLineageCanonicalExecutionImportDraft(
        provider=normalized_provider,
        environment=normalized_environment,
        account_label=normalized_account,
        source_database_sha256=source_database,
        canonical_account_label_sha256=canonical_account,
        execution_count=execution_count,
        execution_set_sha256=execution_set,
        latest_updated_at=latest_updated_at,
        manifest=coerce_json_payload(manifest),
        manifest_canonical_json=canonical_json,
        manifest_sha256=_sha256(canonical_json),
    )


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
    confidence_counts = Counter(receipt.confidence for receipt in ordered_receipts)
    execution_source_counts = Counter(
        receipt.execution_source for receipt in ordered_receipts
    )
    source_coverage_counts = Counter(
        _source_coverage(receipt) for receipt in ordered_receipts
    )
    execution_manifest = coerce_json_payload(normalized_sources.execution_manifest)
    execution_manifest["canonical_execution_import_sha256"] = (
        normalized_sources.canonical_execution_import.manifest_sha256
    )
    input_manifest: dict[str, object] = {
        "broker_economic_source": normalized_sources.broker_economic_source,
        "broker_economic_input_id": str(normalized_sources.broker_economic_input_id),
        "broker_economic_manifest_sha256": (
            normalized_sources.broker_economic_manifest_sha256
        ),
        "broker_source_watermark": canonical_timestamptz_text(
            normalized_sources.broker_source_watermark
        ),
        "broker_activity_count": normalized_sources.broker_activity_count,
        "expected_order_identity_count": len(ordered_receipts),
        "broker_order_links": coerce_json_payload(
            normalized_sources.broker_order_link_manifest
        ),
        "executions": execution_manifest,
        "order_feed": coerce_json_payload(normalized_sources.order_feed_manifest),
        "repair_version": ORDER_LINEAGE_REPAIR_VERSION,
        "schema_version": ORDER_LINEAGE_CENSUS_INPUT_SCHEMA_VERSION,
        "scope": {
            "account_label": normalized_sources.account_label,
            "environment": normalized_sources.environment,
            "provider": normalized_sources.provider,
        },
    }
    input_json = canonical_jsonb_text(input_manifest)
    result: dict[str, object] = {
        "classification_counts": {
            classification: classification_counts.get(classification, 0)
            for classification in sorted(CLASSIFICATIONS)
        },
        "confidence_counts": {
            confidence: confidence_counts.get(confidence, 0)
            for confidence in sorted(CONFIDENCES)
        },
        "execution_source_counts": {
            source: execution_source_counts.get(source, 0)
            for source in sorted(EXECUTION_SOURCES)
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
    result_json = canonical_jsonb_text(result)
    return OrderLineageRepairRunDraft(
        repair_version=ORDER_LINEAGE_REPAIR_VERSION,
        provider=normalized_sources.provider,
        environment=normalized_sources.environment,
        account_label=normalized_sources.account_label,
        broker_economic_input_id=normalized_sources.broker_economic_input_id,
        canonical_execution_import_sha256=(
            normalized_sources.canonical_execution_import.manifest_sha256
        ),
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

    normalized_sources = _normalize_sources(sources)
    _acquire_scope_lock(session, normalized_sources)
    _persist_canonical_execution_import(
        session,
        normalized_sources.canonical_execution_import,
        observed_at=observed_at,
    )
    persisted_receipts = [
        persist_order_lineage_receipt(
            session,
            receipt,
            observed_at=observed_at,
        )
        for receipt in receipts
    ]
    run_draft = build_order_lineage_repair_run(
        normalized_sources,
        [
            _draft_from_persisted_receipt(receipt.receipt)
            for receipt in persisted_receipts
        ],
    )
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
        canonical_execution_import_sha256=(draft.canonical_execution_import_sha256),
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


def load_order_lineage_repair_status(
    session: Session,
    *,
    provider: str,
    environment: str,
    account_label: str,
) -> dict[str, object]:
    """Return bounded current-version coverage without granting authority."""

    row = session.scalar(
        select(OrderLineageRepairRun)
        .where(
            OrderLineageRepairRun.repair_version == ORDER_LINEAGE_REPAIR_VERSION,
            OrderLineageRepairRun.provider == provider,
            OrderLineageRepairRun.environment == environment,
            OrderLineageRepairRun.account_label == account_label,
        )
        .order_by(
            OrderLineageRepairRun.created_at.desc(),
            OrderLineageRepairRun.id.desc(),
        )
        .limit(1)
    )
    if row is None:
        return _unavailable_status(
            state="missing",
            reason="order_lineage_closed_census_missing",
        )
    result = coerce_json_payload(row.result)
    classification_counts = _status_counts(
        result,
        "classification_counts",
        CLASSIFICATIONS,
        row.receipt_count,
    )
    confidence_counts = _status_counts(
        result,
        "confidence_counts",
        CONFIDENCES,
        row.receipt_count,
    )
    execution_source_counts = _status_counts(
        result,
        "execution_source_counts",
        EXECUTION_SOURCES,
        row.receipt_count,
    )
    source_coverage_counts = _status_counts(
        result,
        "source_coverage_counts",
        frozenset(_SOURCE_COVERAGE_CLASSES),
        row.receipt_count,
    )
    if not all(
        (
            classification_counts,
            confidence_counts,
            execution_source_counts,
            source_coverage_counts,
        )
    ):
        return _unavailable_status(
            state="invalid",
            reason="order_lineage_closed_census_invalid",
        )
    complete_count = classification_counts.get("complete", 0)
    reason_codes = (
        []
        if complete_count == row.receipt_count
        else ["order_lineage_incomplete_or_unproved"]
    )
    return {
        "schema_version": "torghut.order-lineage-repair-status.v1",
        "state": "closed",
        "closed_census": True,
        "current_version": True,
        "repair_version": row.repair_version,
        "observed_at": row.observed_at,
        "created_at": row.created_at,
        "receipt_count": row.receipt_count,
        "causal_complete_count": complete_count,
        "causal_incomplete_count": row.receipt_count - complete_count,
        "classification_counts": classification_counts,
        "confidence_counts": confidence_counts,
        "execution_source_counts": execution_source_counts,
        "source_coverage_counts": source_coverage_counts,
        "broker_economic_input_id": str(row.broker_economic_input_id),
        "canonical_execution_import_sha256": (row.canonical_execution_import_sha256),
        "input_manifest_sha256": row.input_manifest_sha256,
        "result_sha256": row.result_sha256,
        "receipt_set_sha256": result.get("receipt_set_sha256"),
        "diagnostic_only": True,
        "promotion_authority_eligible": False,
        "reason_codes": reason_codes,
    }


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
    canonical_import = _normalize_canonical_execution_import(
        sources.canonical_execution_import
    )
    if (
        canonical_import.provider != provider
        or canonical_import.environment != environment
        or canonical_import.account_label != account_label
    ):
        raise ValueError("order_lineage_execution_import_scope_mismatch")
    execution_manifest = coerce_json_payload(sources.execution_manifest)
    expected_canonical_fields = {
        "canonical_account_label_sha256": (
            canonical_import.canonical_account_label_sha256
        ),
        "canonical_execution_count": canonical_import.execution_count,
        "canonical_execution_set_sha256": canonical_import.execution_set_sha256,
        "canonical_latest_updated_at": (
            canonical_timestamptz_text(canonical_import.latest_updated_at)
            if canonical_import.latest_updated_at is not None
            else None
        ),
    }
    if any(
        execution_manifest.get(key) != value
        for key, value in expected_canonical_fields.items()
    ):
        raise ValueError("order_lineage_execution_import_manifest_mismatch")
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
        execution_manifest=execution_manifest,
        canonical_execution_import=canonical_import,
    )


def _normalize_canonical_execution_import(
    draft: OrderLineageCanonicalExecutionImportDraft,
) -> OrderLineageCanonicalExecutionImportDraft:
    rebuilt = build_order_lineage_canonical_execution_import(
        provider=draft.provider,
        environment=draft.environment,
        account_label=draft.account_label,
        source_database_sha256=draft.source_database_sha256,
        execution_manifest={
            "canonical_account_label_sha256": (draft.canonical_account_label_sha256),
            "canonical_execution_count": draft.execution_count,
            "canonical_execution_set_sha256": draft.execution_set_sha256,
            "canonical_latest_updated_at": (
                canonical_timestamptz_text(draft.latest_updated_at)
                if draft.latest_updated_at is not None
                else None
            ),
        },
    )
    if (
        draft.manifest != rebuilt.manifest
        or draft.manifest_canonical_json != rebuilt.manifest_canonical_json
        or draft.manifest_sha256 != rebuilt.manifest_sha256
    ):
        raise ValueError("order_lineage_execution_import_document_mismatch")
    return rebuilt


def _persist_canonical_execution_import(
    session: Session,
    draft: OrderLineageCanonicalExecutionImportDraft,
    *,
    observed_at: datetime,
) -> OrderLineageCanonicalExecutionImport:
    existing = session.get(
        OrderLineageCanonicalExecutionImport,
        draft.manifest_sha256,
    )
    if existing is not None:
        _validate_reused_execution_import(existing, draft)
        return existing
    row = OrderLineageCanonicalExecutionImport(
        manifest_sha256=draft.manifest_sha256,
        provider=draft.provider,
        environment=draft.environment,
        account_label=draft.account_label,
        source_database_sha256=draft.source_database_sha256,
        canonical_account_label_sha256=(draft.canonical_account_label_sha256),
        execution_count=draft.execution_count,
        execution_set_sha256=draft.execution_set_sha256,
        latest_updated_at=draft.latest_updated_at,
        manifest=draft.manifest,
        manifest_canonical_json=draft.manifest_canonical_json,
        observed_at=_required_utc(observed_at),
    )
    try:
        with session.begin_nested():
            session.add(row)
            session.flush()
    except IntegrityError:
        existing = session.get(
            OrderLineageCanonicalExecutionImport,
            draft.manifest_sha256,
        )
        if existing is None:
            raise
        _validate_reused_execution_import(existing, draft)
        return existing
    return row


def _validate_reused_execution_import(
    existing: OrderLineageCanonicalExecutionImport,
    draft: OrderLineageCanonicalExecutionImportDraft,
) -> None:
    if (
        existing.provider != draft.provider
        or existing.environment != draft.environment
        or existing.account_label != draft.account_label
        or existing.source_database_sha256 != draft.source_database_sha256
        or existing.canonical_account_label_sha256
        != draft.canonical_account_label_sha256
        or existing.execution_count != draft.execution_count
        or existing.execution_set_sha256 != draft.execution_set_sha256
        or _optional_persisted_utc(existing.latest_updated_at)
        != draft.latest_updated_at
        or coerce_json_payload(existing.manifest) != draft.manifest
        or existing.manifest_canonical_json != draft.manifest_canonical_json
    ):
        raise ValueError("order_lineage_execution_import_hash_collision")


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


def _status_counts(
    result: Mapping[str, object],
    key: str,
    expected_keys: frozenset[str],
    expected_total: int,
) -> dict[str, int]:
    raw_counts = result.get(key)
    if not isinstance(raw_counts, dict):
        return {}
    typed_counts = cast(dict[object, object], raw_counts)
    counts: dict[str, int] = {}
    for raw_key, raw_value in typed_counts.items():
        if not isinstance(raw_key, str) or not isinstance(raw_value, int):
            return {}
        if raw_value < 0:
            return {}
        counts[raw_key] = raw_value
    if frozenset(counts) != expected_keys or sum(counts.values()) != expected_total:
        return {}
    return counts


def _unavailable_status(*, state: str, reason: str) -> dict[str, object]:
    return {
        "schema_version": "torghut.order-lineage-repair-status.v1",
        "state": state,
        "closed_census": False,
        "current_version": False,
        "diagnostic_only": True,
        "promotion_authority_eligible": False,
        "reason_codes": [reason],
    }


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
    if (
        existing.result_sha256 != draft.result_sha256
        or existing.canonical_execution_import_sha256
        != draft.canonical_execution_import_sha256
    ):
        raise ValueError("order_lineage_run_nondeterministic")
    return PersistedOrderLineageRepairRun(run=existing, reused_existing=True)


def _draft_from_persisted_receipt(
    receipt: OrderLineageRepairReceipt,
) -> OrderLineageReceiptDraft:
    """Bind a run to the exact receipt projection accepted by persistence."""

    return OrderLineageReceiptDraft(
        repair_version=receipt.repair_version,
        provider=receipt.provider,
        environment=receipt.environment,
        account_label=receipt.account_label,
        order_identity_sha256=receipt.order_identity_sha256,
        alpaca_order_id=receipt.alpaca_order_id,
        client_order_id=receipt.client_order_id,
        classification=receipt.classification,
        confidence=receipt.confidence,
        execution_source=receipt.execution_source,
        source_first_at=_persisted_utc(receipt.source_first_at),
        source_last_at=_persisted_utc(receipt.source_last_at),
        evidence=coerce_json_payload(receipt.evidence),
        evidence_canonical_json=receipt.evidence_canonical_json,
        evidence_sha256=receipt.evidence_sha256,
        promotion_authority_eligible=receipt.promotion_authority_eligible,
    )


def _acquire_scope_lock(
    session: Session,
    sources: OrderLineageCensusSources,
) -> None:
    if session.get_bind().dialect.name != "postgresql":
        return
    scope = "\x1f".join(
        (
            ORDER_LINEAGE_REPAIR_VERSION,
            sources.provider,
            sources.environment,
            sources.account_label,
        )
    )
    session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:scope, 0))"),
        {"scope": scope},
    )


def _canonical_sha256(value: object) -> str:
    return _sha256(canonical_jsonb_text(value))


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _required_text(value: object, error: str) -> str:
    normalized = str(value).strip() if value is not None else ""
    if not normalized:
        raise ValueError(error)
    return normalized


def _sha256_value(value: object, error: str) -> str:
    normalized = str(value).strip().lower() if value is not None else ""
    if len(normalized) != 64 or any(
        character not in "0123456789abcdef" for character in normalized
    ):
        raise ValueError(error)
    return normalized


def _nonnegative_int(value: object, error: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(error)
    return value


def _optional_utc_text(value: object, error: str) -> datetime | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(error)
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(error) from exc
    if parsed.tzinfo is None:
        raise ValueError(error)
    return parsed.astimezone(timezone.utc)


def _required_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise ValueError("order_lineage_timestamp_timezone_missing")
    return value.astimezone(timezone.utc)


def _persisted_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _optional_persisted_utc(value: datetime | None) -> datetime | None:
    return _persisted_utc(value) if value is not None else None


__all__ = (
    "ORDER_LINEAGE_CENSUS_INPUT_SCHEMA_VERSION",
    "ORDER_LINEAGE_CENSUS_RESULT_SCHEMA_VERSION",
    "ORDER_LINEAGE_CANONICAL_EXECUTION_IMPORT_SCHEMA_VERSION",
    "OrderLineageCanonicalExecutionImportDraft",
    "OrderLineageCensusSources",
    "OrderLineageRepairRunDraft",
    "PersistedOrderLineageCensus",
    "PersistedOrderLineageRepairRun",
    "build_order_lineage_canonical_execution_import",
    "build_order_lineage_repair_run",
    "load_order_lineage_repair_status",
    "persist_order_lineage_census",
    "persist_order_lineage_repair_run",
)
