"""Signal ingestion from ClickHouse."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Mapping, cast


from ..simulation import (
    resolve_simulation_context,
)


from .shared_context import (
    SignalBatch as SignalBatch,
)
from .clickhouse_signal_ingestor_persistence_methods import (
    ClickHouseSignalIngestor as ClickHouseSignalIngestor,
    coerce_seq as _coerce_seq,
)


def _attach_simulation_context(
    *,
    payload: dict[str, Any],
    row: Mapping[str, Any],
    event_ts: datetime,
) -> dict[str, Any]:
    source_context: Mapping[str, Any] | None = None
    existing = payload.get("simulation_context")
    if isinstance(existing, Mapping):
        source_context = cast(Mapping[str, Any], existing)

    row_context: dict[str, Any] = {}
    for field_name in (
        "dataset_event_id",
        "source_topic",
        "source_partition",
        "source_offset",
        "replay_topic",
    ):
        value = row.get(field_name)
        if value is None:
            continue
        row_context[field_name] = value
    if row_context:
        combined = dict(source_context or {})
        combined.update(row_context)
        source_context = combined

    context = resolve_simulation_context(
        source=source_context,
    )
    if context is None:
        return payload
    if context.get("signal_event_ts") in (None, ""):
        context["signal_event_ts"] = event_ts.isoformat()
    seq_value = row.get("seq")
    if seq_value is not None and context.get("signal_seq") in (None, ""):
        context["signal_seq"] = _coerce_seq(seq_value)

    updated = dict(payload)
    updated["simulation_context"] = context
    return updated


def _split_table(table: str) -> tuple[str, str]:
    if "." in table:
        database, raw_table = table.split(".", 1)
        return database, raw_table
    return "default", table


_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _safe_identifier(value: str, *, kind: str) -> str:
    cleaned = value.strip()
    if not cleaned or not _IDENTIFIER_RE.fullmatch(cleaned):
        raise ValueError(f"invalid_{kind}_identifier:{value}")
    return cleaned


def _qualified_table_name(table: str) -> str:
    database, raw_table = _split_table(table)
    safe_database = _safe_identifier(database, kind="database")
    safe_table = _safe_identifier(raw_table, kind="table")
    return f"{safe_database}.{safe_table}"


# Public aliases used by split-module consumers.
attach_simulation_context_payload = _attach_simulation_context
qualified_table_name = _qualified_table_name
safe_identifier = _safe_identifier

__all__ = (
    "attach_simulation_context_payload",
    "qualified_table_name",
    "safe_identifier",
)
