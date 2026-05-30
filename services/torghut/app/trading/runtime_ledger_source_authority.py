"""Shared source-authority checks for runtime-ledger proof payloads."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import cast

RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER = "runtime_ledger_source_window_missing"
RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER = "runtime_ledger_source_refs_missing"


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


__all__ = [
    "RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER",
    "runtime_ledger_source_authority_blockers",
    "runtime_ledger_source_refs_present",
    "runtime_ledger_source_window_present",
]
