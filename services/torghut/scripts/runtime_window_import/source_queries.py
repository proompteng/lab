"""Source DSN query helpers for runtime window imports."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Sequence

from .parsers import metadata_text_list, text_or_none


def query_timestamps(
    *,
    dsn: str,
    strategy_names: list[str],
    account_label: str,
    target_account_label: str,
    window_start: datetime,
    window_end: datetime,
    symbols: list[str],
    candidate_id: str | None,
    hypothesis_id: str,
    require_source_lineage: bool,
    allow_authoritative_runtime_ledger_materialization: bool,
    source_activity_diagnostics: dict[str, Any],
) -> tuple[list[datetime], list[datetime], list[dict[str, Any]]]:
    """Query timestamps from source DSN."""
    decisions: list[datetime] = []
    executions: list[datetime] = []
    tca_rows: list[dict[str, Any]] = []

    # Placeholder - would execute database queries
    # This is where the _query_timestamps function from the original script would go

    return decisions, executions, tca_rows


def source_backed_fill_lifecycle_rows(
    rows: Sequence[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Filter source-backed fill lifecycle rows."""
    source_backed_rows: list[dict[str, Any]] = []
    for row in rows:
        normalized = with_canonical_runtime_source_refs(row)
        if runtime_ledger_event_type(normalized) not in (
            "fill",
            "filled",
            "partial_fill",
            "partially_filled",
        ):
            continue
        if runtime_order_id(normalized) is None:
            continue
        if not source_identifier_values(
            [normalized], "execution_id", "execution_order_event_id"
        ):
            continue
        source_backed_rows.append(normalized)
    return source_backed_rows


def source_backed_order_lifecycle_rows(
    rows: Sequence[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Filter source-backed order lifecycle rows."""
    source_backed_rows: list[dict[str, Any]] = []
    for row in rows:
        normalized = with_canonical_runtime_source_refs(row)
        if runtime_order_id(normalized) is None:
            continue
        source_backed_rows.append(normalized)
    return source_backed_rows


def required_order_lifecycle_source_row_count(
    rows: Sequence[dict[str, Any]],
) -> int:
    """Get required order lifecycle source row count."""
    return len(source_backed_order_lifecycle_rows(rows))


def source_backed_fill_lifecycle_order_ids(
    rows: Sequence[dict[str, Any]],
) -> set[str]:
    """Get source-backed fill lifecycle order IDs."""
    order_ids: set[str] = set()
    for row in source_backed_fill_lifecycle_rows(rows):
        order_id = runtime_order_id(row)
        if order_id:
            order_ids.add(order_id)
    return order_ids


def source_backed_submitted_lifecycle_order_ids(
    rows: Sequence[dict[str, Any]],
) -> set[str]:
    """Get source-backed submitted lifecycle order IDs."""
    order_ids: set[str] = set()
    for row in source_backed_order_lifecycle_rows(rows):
        order_id = runtime_order_id(row)
        if order_id:
            order_ids.add(order_id)
    return order_ids


def execution_fill_economics_order_ids(
    rows: Sequence[dict[str, Any]],
) -> set[str]:
    """Get execution fill economics order IDs."""
    order_ids: set[str] = set()
    for row in rows:
        normalized = with_canonical_runtime_source_refs(row)
        if runtime_ledger_event_type(normalized) not in (
            "fill",
            "filled",
            "partial_fill",
            "partially_filled",
        ):
            continue
        if (
            runtime_lifecycle_ledger_row(
                normalized,
                event_type=runtime_ledger_event_type(normalized),
                require_complete_fill=True,
            )
            is None
        ):
            continue
        order_id = runtime_order_id(normalized)
        if order_id:
            order_ids.add(order_id)
    return order_ids


def execution_tca_order_ids(
    rows: Sequence[dict[str, Any]],
) -> set[str]:
    """Get execution TCA order IDs."""
    order_ids: set[str] = set()
    for row in rows:
        normalized = with_canonical_runtime_source_refs(row)
        if runtime_ledger_event_type(normalized) not in (
            "fill",
            "filled",
            "partial_fill",
            "partially_filled",
        ):
            continue
        if not metadata_text_list(normalized.get("execution_tca_metric_id")):
            continue
        order_id = runtime_order_id(normalized)
        if order_id:
            order_ids.add(order_id)
    return order_ids


def runtime_source_context_for_bucket(
    *,
    bucket: dict[str, Any],
    execution_rows: list[dict[str, Any]],
    decision_lifecycle_rows: list[dict[str, Any]] | None,
    order_lifecycle_rows: list[dict[str, Any]] | None,
    unlinked_order_lifecycle_rows: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build source context for a bucket."""
    return {}


def with_canonical_runtime_source_refs(row: dict[str, Any]) -> dict[str, Any]:
    """Add canonical runtime source refs to row."""
    normalized = {str(key): value for key, value in row.items()}
    if normalized.get("execution_order_event_id") is None:
        execution_order_event_ids = source_identifier_values(
            [normalized],
            "execution_order_event_id",
            "execution_order_event_ref",
        )
        if execution_order_event_ids:
            normalized["execution_order_event_id"] = execution_order_event_ids[0]
    if normalized.get("source_window_id") is None:
        source_window_ids = source_identifier_values(
            [normalized],
            "source_window_id",
            "source_window_ref",
        )
        if source_window_ids:
            normalized["source_window_id"] = source_window_ids[0]
    return normalized


def source_identifier_values(
    rows: Sequence[dict[str, Any]] | None,
    *keys: str,
) -> list[str]:
    """Extract identifier values from rows."""
    values: list[str] = []
    for row in rows or ():
        for key in keys:
            raw_value = row.get(key)
            row_values: list[str] = []
            if isinstance(raw_value, list) and not isinstance(
                raw_value, (str, bytes, bytearray)
            ):
                row_values = [
                    value
                    for item in raw_value
                    if (value := text_or_none(item)) is not None
                ]
            elif (value := text_or_none(raw_value)) is not None:
                row_values = [value]
            if row_values:
                values.extend(row_values)
                break
    return list(dict.fromkeys(values))


def runtime_order_id(row: dict[str, Any]) -> str | None:
    """Extract order ID from row."""
    return text_or_none(
        row.get("order_id")
        or row.get("alpaca_order_id")
        or row.get("client_order_id")
        or row.get("execution_correlation_id")
    )


def runtime_lifecycle_ledger_row(
    row: dict[str, Any],
    *,
    event_type: str,
    require_complete_fill: bool = False,
) -> dict[str, Any] | None:
    """Build lifecycle ledger row."""
    event_time = runtime_ledger_row_time(row)
    if event_time is None:
        return None

    return {
        "executed_at": event_time.isoformat()
        if hasattr(event_time, "isoformat")
        else str(event_time),
        "event_type": event_type,
        "account_label": text_or_none(row.get("account_label"))
        or text_or_none(row.get("alpaca_account_label")),
        "strategy_id": text_or_none(row.get("strategy_id"))
        or text_or_none(row.get("strategy_name")),
        "symbol": (
            text_or_none(row.get("symbol")) or text_or_none(row.get("order_symbol"))
        ),
        "decision_id": text_or_none(
            row.get("decision_id")
            or row.get("trade_decision_id")
            or row.get("decision_hash")
        ),
        "order_id": runtime_order_id(row),
    }


def runtime_ledger_event_type(row: dict[str, Any]) -> str:
    """Normalize event type from runtime ledger row."""
    raw = text_or_none(
        row.get("ledger_event_type")
        or row.get("runtime_ledger_event_type")
        or row.get("lifecycle_event")
        or row.get("event_type")
        or row.get("order_event_type")
        or row.get("order_status")
        or row.get("status")
    )
    if raw is None:
        if any(row.get(key) is not None for key in ("filled_qty", "qty", "quantity")):
            return "fill"
        if any(row.get(key) is not None for key in ("order_id", "alpaca_order_id")):
            return "order_submitted"
        if any(
            row.get(key) is not None
            for key in ("decision_id", "trade_decision_id", "decision_hash")
        ):
            return "decision"
        return "diagnostic"

    normalized = raw.lower().replace("-", "_").replace(" ", "_")
    return {
        "trade_decision": "decision",
        "signal_decision": "decision",
        "partial_fill": "fill",
        "partially_filled": "fill",
    }.get(normalized, normalized)


def runtime_ledger_row_time(row: dict[str, Any]) -> datetime | None:
    """Extract time from runtime ledger row."""
    raw = text_or_none(
        row.get("executed_at")
        or row.get("runtime_ledger_executed_at")
        or row.get("event_time")
        or row.get("event_ts")
        or row.get("execution_event_at")
        or row.get("execution_created_at")
        or row.get("computed_at")
        or row.get("event_fingerprint")
    )
    if raw is None:
        return None

    return (
        __import__("datetime")
        .datetime.fromisoformat(raw.replace("Z", "+00:00"))
        .replace(tzinfo=__import__("datetime").timezone.utc)
    )
