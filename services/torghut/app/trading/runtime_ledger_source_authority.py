"""Shared source-authority checks for runtime-ledger proof payloads."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import cast

RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER = "runtime_ledger_source_window_missing"
RUNTIME_LEDGER_SOURCE_WINDOW_IDS_MISSING_BLOCKER = (
    "runtime_ledger_source_window_ids_missing"
)
RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER = "runtime_ledger_source_refs_missing"
RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER = (
    "runtime_ledger_trade_decision_refs_missing"
)
RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER = "runtime_ledger_execution_refs_missing"
RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER = (
    "runtime_ledger_execution_order_event_refs_missing"
)
RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER = "runtime_ledger_source_offsets_missing"
RUNTIME_LEDGER_SOURCE_MATERIALIZATION_MISSING_BLOCKER = (
    "runtime_ledger_source_materialization_missing"
)
RUNTIME_LEDGER_AUTHORITY_CLASS_MISSING_BLOCKER = (
    "runtime_ledger_authority_class_missing"
)

_PROMOTION_GRADE_SOURCE_MATERIALIZATIONS = frozenset(
    {
        "execution_order_events",
        "source_execution_lifecycle",
    }
)
_PROMOTION_GRADE_AUTHORITY_CLASSES = frozenset(
    {
        "runtime_order_feed_execution_source",
        "event_sourced_runtime_ledger_profit_proof",
        "source_execution_runtime_ledger_materialized",
        "execution_order_events_runtime_ledger",
        "source_execution_lifecycle_materialized_runtime_ledger",
    }
)
_PROMOTION_GRADE_SOURCE_REF_TABLES = frozenset(
    {
        "trade_decisions",
        "executions",
        "execution_order_events",
        "order_feed_source_windows",
    }
)


def _text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _parse_datetime(value: object) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    else:
        text = _text(value)
        if text is None:
            return None
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _string_list(value: object) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    return [
        text
        for item in cast(Sequence[object], value)
        if (text := _text(item)) is not None
    ]


def _positive_mapping_value_count(value: object) -> int:
    if not isinstance(value, Mapping):
        return 0
    count = 0
    for item in cast(Mapping[object, object], value).values():
        try:
            parsed = Decimal(str(item))
        except (InvalidOperation, ValueError):
            continue
        if parsed.is_finite() and parsed > 0:
            count += 1
    return count


def _source_ref_present(value: object) -> bool:
    if isinstance(value, Mapping):
        return len(cast(Mapping[object, object], value)) > 0
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return bool(_string_list(cast(Sequence[object], value)))
    return bool(_string_list(value) or _text(value) is not None)


def _source_refs_present(bucket: Mapping[str, object], *keys: str) -> bool:
    return any(_source_ref_present(bucket.get(key)) for key in keys)


def _source_ref_table_names(value: object) -> set[str]:
    refs = _string_list(value)
    table_names: set[str] = set()
    for ref in refs:
        normalized = ref.strip().lower()
        if normalized:
            table_names.add(normalized)
        if ":" in normalized:
            tail = normalized.rsplit(":", maxsplit=1)[-1]
            if tail:
                table_names.add(tail)
    return table_names


def _source_row_counts_have_positive_rows(
    bucket: Mapping[str, object], table_name: str
) -> bool:
    source_row_counts = bucket.get("source_row_counts")
    if not isinstance(source_row_counts, Mapping):
        return False
    value = cast(Mapping[object, object], source_row_counts).get(table_name)
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return False
    return parsed.is_finite() and parsed > 0


def _promotion_grade_source_refs_present(bucket: Mapping[str, object]) -> bool:
    source_ref_tables = _source_ref_table_names(bucket.get("source_refs"))
    return all(
        table_name in source_ref_tables
        and _source_row_counts_have_positive_rows(bucket, table_name)
        for table_name in _PROMOTION_GRADE_SOURCE_REF_TABLES
    )


def _source_offsets_present(bucket: Mapping[str, object]) -> bool:
    def has_source_offset_triplet(value: Mapping[object, object]) -> bool:
        return (
            _text(value.get("topic")) is not None
            and value.get("partition") is not None
            and value.get("offset") is not None
        )

    source_offsets = bucket.get("source_offsets")
    if isinstance(source_offsets, Mapping):
        return has_source_offset_triplet(cast(Mapping[object, object], source_offsets))
    if isinstance(source_offsets, Sequence) and not isinstance(
        source_offsets, (str, bytes, bytearray)
    ):
        for item in cast(Sequence[object], source_offsets):
            if isinstance(item, Mapping):
                if has_source_offset_triplet(cast(Mapping[object, object], item)):
                    return True
    return (
        _text(bucket.get("source_topic")) is not None
        and bucket.get("source_partition") is not None
        and bucket.get("source_offset") is not None
    )


def _promotion_grade_source_materialization_present(
    bucket: Mapping[str, object],
) -> bool:
    source_materialization = _text(bucket.get("source_materialization"))
    return (
        source_materialization is not None
        and source_materialization in _PROMOTION_GRADE_SOURCE_MATERIALIZATIONS
    )


def _promotion_grade_authority_class_present(bucket: Mapping[str, object]) -> bool:
    authority_values = (
        bucket.get("authority_class"),
        bucket.get("authority_reason"),
    )
    for value in authority_values:
        text = _text(value)
        if text in _PROMOTION_GRADE_AUTHORITY_CLASSES:
            return True
    return False


def runtime_ledger_source_window_present(bucket: Mapping[str, object]) -> bool:
    start = _parse_datetime(
        bucket.get("source_window_start")
        or bucket.get("runtime_ledger_source_window_start")
    )
    end = _parse_datetime(
        bucket.get("source_window_end")
        or bucket.get("runtime_ledger_source_window_end")
    )
    return start is not None and end is not None and end > start


def runtime_ledger_source_refs_present(bucket: Mapping[str, object]) -> bool:
    source_refs = _string_list(bucket.get("source_refs"))
    source_ref = bucket.get("source_ref")
    source_ref_present = bool(source_refs)
    if isinstance(source_ref, Mapping):
        source_ref_present = (
            source_ref_present or len(cast(Mapping[object, object], source_ref)) > 0
        )
    elif _text(source_ref) is not None:
        source_ref_present = True
    return (
        source_ref_present
        and _positive_mapping_value_count(bucket.get("source_row_counts")) > 0
    )


def runtime_ledger_source_authority_blockers(
    bucket: Mapping[str, object],
) -> list[str]:
    blockers: list[str] = []
    if not runtime_ledger_source_window_present(bucket):
        blockers.append(RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER)
    if not runtime_ledger_source_refs_present(bucket):
        blockers.append(RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER)
    return blockers


def runtime_ledger_promotion_source_authority_blockers(
    bucket: Mapping[str, object],
) -> list[str]:
    """Return blockers for promotion-grade runtime/order-feed source proof.

    Aggregate bucket fields are not enough for promotion authority. The bucket must
    also carry row-level runtime lineage back to order-feed lifecycle and execution
    sources so durable/source imports cannot become proof by shape alone.
    """

    blockers = runtime_ledger_source_authority_blockers(bucket)
    if not _promotion_grade_source_refs_present(bucket):
        blockers.append(RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER)
    if not _source_refs_present(
        bucket,
        "source_window_ids",
        "source_window_id",
        "runtime_ledger_source_window_ids",
        "runtime_ledger_source_window_id",
    ):
        blockers.append(RUNTIME_LEDGER_SOURCE_WINDOW_IDS_MISSING_BLOCKER)
    if not _source_refs_present(
        bucket,
        "trade_decision_ids",
        "trade_decision_refs",
        "trade_decision_id",
        "decision_ids",
        "decision_id",
    ):
        blockers.append(RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER)
    if not _source_refs_present(
        bucket,
        "execution_ids",
        "execution_refs",
        "execution_id",
    ):
        blockers.append(RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER)
    if not _source_refs_present(
        bucket,
        "execution_order_event_ids",
        "execution_order_event_refs",
        "execution_order_event_id",
    ):
        blockers.append(RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER)
    if not _source_offsets_present(bucket):
        blockers.append(RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER)
    if not _promotion_grade_source_materialization_present(bucket):
        blockers.append(RUNTIME_LEDGER_SOURCE_MATERIALIZATION_MISSING_BLOCKER)
    if not _promotion_grade_authority_class_present(bucket):
        blockers.append(RUNTIME_LEDGER_AUTHORITY_CLASS_MISSING_BLOCKER)
    return list(dict.fromkeys(blockers))


__all__ = [
    "RUNTIME_LEDGER_AUTHORITY_CLASS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_SOURCE_MATERIALIZATION_MISSING_BLOCKER",
    "RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_SOURCE_WINDOW_IDS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER",
    "RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER",
    "runtime_ledger_promotion_source_authority_blockers",
    "runtime_ledger_source_authority_blockers",
    "runtime_ledger_source_refs_present",
    "runtime_ledger_source_window_present",
]
