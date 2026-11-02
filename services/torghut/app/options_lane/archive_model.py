"""Deterministic work units for the options-contract archive."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
import hashlib
import json


ARCHIVE_COMPONENT = "catalog_archive"
ARCHIVE_SCOPE_TYPE = "expiration_shard"
ARCHIVE_QUERY_SCHEMA_VERSION = 1
ARCHIVE_CONTRACTS_PATH = "/v2/options/contracts"


@dataclass(frozen=True, slots=True)
class ArchiveShard:
    """One fixed calendar-week expiration shard."""

    start: date
    end: date

    def __post_init__(self) -> None:
        if self.end < self.start:
            raise ValueError("archive shard end precedes start")
        if (self.end - self.start).days >= 7:
            raise ValueError("archive shard must not exceed seven calendar days")

    @property
    def key(self) -> str:
        return f"{self.start.isoformat()}/{self.end.isoformat()}"


def archive_shards(
    *,
    today: date,
    horizon_days: int,
    coverage_start: date | None = None,
) -> tuple[ArchiveShard, ...]:
    """Return calendar-week shards covering stale active rows and the horizon."""

    if horizon_days < 0:
        raise ValueError("archive horizon must not be negative")
    first_day = min(today, coverage_start or today)
    first_monday = first_day - timedelta(days=first_day.weekday())
    last_day = today + timedelta(days=horizon_days)
    last_monday = last_day - timedelta(days=last_day.weekday())
    count = ((last_monday - first_monday).days // 7) + 1
    return tuple(
        ArchiveShard(
            start=first_monday + timedelta(days=index * 7),
            end=first_monday + timedelta(days=index * 7 + 6),
        )
        for index in range(count)
    )


def archive_query_fingerprint(*, shard: ArchiveShard, page_limit: int) -> str:
    """Fingerprint every provider query input that affects archive membership."""

    if not 1 <= page_limit <= 10_000:
        raise ValueError("archive page limit must be between 1 and 10000")
    payload = {
        "endpoint": ARCHIVE_CONTRACTS_PATH,
        "expiration_date_gte": shard.start.isoformat(),
        "expiration_date_lte": shard.end.isoformat(),
        "limit": page_limit,
        "schema_version": ARCHIVE_QUERY_SCHEMA_VERSION,
        "status": "active",
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()
