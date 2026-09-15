from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass


@dataclass(frozen=True)
class ClickHouseTaSessionStalenessGate:
    accepted_source_state: str
    regular_session_open: object
    suppress_stale: bool


def clickhouse_ta_session_staleness_gate(
    clickhouse_ta_status: Mapping[str, object],
) -> ClickHouseTaSessionStalenessGate:
    accepted_source_state = _clean_text(
        clickhouse_ta_status.get("accepted_source_state")
    ).lower()
    regular_session_open = clickhouse_ta_status.get("regular_session_open")
    blocking_reason = _clean_text(clickhouse_ta_status.get("blocking_reason"))
    suppress_stale = (
        accepted_source_state == "outside_regular_session"
        or regular_session_open is False
    ) and not blocking_reason
    return ClickHouseTaSessionStalenessGate(
        accepted_source_state=accepted_source_state,
        regular_session_open=regular_session_open,
        suppress_stale=suppress_stale,
    )


def _clean_text(value: object) -> str:
    return str(value or "").strip()
