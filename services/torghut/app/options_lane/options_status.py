"""Status payload helpers for the options lane."""

from __future__ import annotations

from typing import Any


def build_status_payload(
    *,
    component: str,
    status: str,
    session_value: str,
    last_success_ts: str | None,
    active_contracts: int | None,
    hot_contracts: int | None,
    rest_backlog: int | None,
    error_code: str | None,
    error_detail: str | None,
    watermark_lag_ms: int | None = None,
) -> dict[str, Any]:
    """Build the raw options status payload contract."""

    return {
        "component": component,
        "status": status,
        "session_state": session_value,
        "watermark_lag_ms": watermark_lag_ms,
        "active_contracts": active_contracts,
        "hot_contracts": hot_contracts,
        "rest_backlog": rest_backlog,
        "error_code": error_code,
        "error_detail": error_detail,
        "last_success_ts": last_success_ts,
        "heartbeat": True,
        "schema_version": 1,
    }
