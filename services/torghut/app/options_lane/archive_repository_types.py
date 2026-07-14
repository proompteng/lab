"""Persistence value objects and serializers for the options archive."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, datetime
import json
from typing import cast

from .archive_model import ArchiveShard


@dataclass(frozen=True, slots=True)
class ArchiveCheckpoint:
    shard: ArchiveShard
    query_fingerprint: str
    status: str
    cursor: str | None
    page_count: int
    seen_count: int
    retry_count: int
    next_eligible_at: datetime | None
    last_success_at: datetime | None
    finalize_snapshot_at: datetime | None = None
    finalize_after_expiration_date: date | None = None
    finalize_after_contract_symbol: str | None = None
    transitioned_count: int = 0

    def due(self, now: datetime) -> bool:
        return self.next_eligible_at is None or self.next_eligible_at <= now


@dataclass(frozen=True, slots=True)
class ArchiveCompletion:
    checkpoint: ArchiveCheckpoint
    transitioned_count: int
    batch_scanned_count: int = 0
    batch_transitioned_count: int = 0


@dataclass(frozen=True, slots=True)
class ArchiveFailure:
    error_code: str
    error_detail: str
    retry_base_seconds: int
    retry_max_seconds: int


@dataclass(frozen=True, slots=True)
class ArchiveResetRequest:
    shard: ArchiveShard
    query_fingerprint: str
    observed_at: datetime
    reason: str
    last_success_at: datetime | None


def metadata_from_value(value: object) -> dict[str, object]:
    if isinstance(value, dict):
        raw = cast(dict[object, object], value)
        return {str(key): item for key, item in raw.items()}
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        if isinstance(parsed, dict):
            raw = cast(dict[object, object], parsed)
            return {str(key): item for key, item in raw.items()}
    return {}


def metadata_json(
    checkpoint: ArchiveCheckpoint,
    *,
    extra: Mapping[str, object] | None = None,
) -> str:
    payload: dict[str, object] = {
        "expiration_date_gte": checkpoint.shard.start.isoformat(),
        "expiration_date_lte": checkpoint.shard.end.isoformat(),
        "page_count": checkpoint.page_count,
        "query_fingerprint": checkpoint.query_fingerprint,
        "seen_count": checkpoint.seen_count,
        "status": checkpoint.status,
        "finalize_snapshot_at": (
            checkpoint.finalize_snapshot_at.isoformat()
            if checkpoint.finalize_snapshot_at is not None
            else None
        ),
        "finalize_after_expiration_date": (
            checkpoint.finalize_after_expiration_date.isoformat()
            if checkpoint.finalize_after_expiration_date is not None
            else None
        ),
        "finalize_after_contract_symbol": checkpoint.finalize_after_contract_symbol,
        "transitioned_count": checkpoint.transitioned_count,
    }
    if extra:
        payload.update(extra)
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)


def as_int(value: object, default: int = 0) -> int:
    try:
        return int(cast(int | float | str, value))
    except (TypeError, ValueError, ArithmeticError):
        return default


def as_date(value: object) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value)
        except ValueError:
            return None
    return None


def as_datetime(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None
