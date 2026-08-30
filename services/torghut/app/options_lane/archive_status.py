"""Shared contracts for low-WAL options archive status reconciliation."""

from __future__ import annotations

import hashlib


ARCHIVE_STATUS_TABLE = "torghut_options_contract_archive_status"
ACTIVE_CATALOG_VIEW = "torghut_options_active_contract_catalog"
DEFAULT_ARCHIVE_LOCK_NAME = "torghut:options-catalog-archive"
ARCHIVE_STATUS_RECONCILE_LOCK_NAME = "torghut:options-catalog-archive-status"


def archive_advisory_lock_id(name: str = DEFAULT_ARCHIVE_LOCK_NAME) -> int:
    """Return a stable signed 64-bit PostgreSQL advisory-lock identifier."""

    digest = hashlib.sha256(name.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], byteorder="big", signed=True)


ARCHIVE_STATUS_RECONCILE_LOCK_ID = archive_advisory_lock_id(
    ARCHIVE_STATUS_RECONCILE_LOCK_NAME
)
