"""Source data loading and artifact helpers for runtime window imports."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping

from .parsers import as_mapping, text_or_none

# Import constants from the original module
RUNTIME_LEDGER_ARTIFACT_SCHEMAS = frozenset(
    {
        "torghut.exact_replay_ledger.rows.v1",
        "torghut.runtime-ledger-bucket.v1",
    }
)


def load_json_artifact(ref: str) -> dict[str, Any]:
    """Load a JSON artifact from file path or return empty dict."""
    text = ref.strip()
    if not text:
        return {}
    path = Path(text)
    if not path.exists():
        return {}
    try:
        payload = __import__("json").loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return as_mapping(payload)


def runtime_ledger_artifact_schema(payload: Mapping[str, Any]) -> str | None:
    """Extract schema version from runtime ledger artifact."""
    return text_or_none(
        payload.get("schema_version") or payload.get("ledger_schema_version")
    )


def runtime_ledger_artifact_rows(payload: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Extract rows from runtime ledger artifact."""
    if runtime_ledger_artifact_schema(payload) not in RUNTIME_LEDGER_ARTIFACT_SCHEMAS:
        return []
    defaults = {
        key: value
        for key in (
            "account_label",
            "strategy_id",
            "strategy_name",
            "execution_policy_hash",
            "execution_policy_sha256",
            "cost_model_hash",
            "cost_model_sha256",
            "lineage_hash",
            "candidate_lineage_hash",
            "replay_data_hash",
            "replay_tape_content_sha256",
            "dataset_snapshot_hash",
            "source_query_digest",
        )
        if (value := payload.get(key)) is not None
    }
    for key in ("runtime_ledger_rows", "ledger_rows", "rows", "events"):
        raw_rows = payload.get(key)
        if not isinstance(raw_rows, list):
            continue
        rows: list[dict[str, Any]] = []
        for raw_row in raw_rows:
            row = as_mapping(raw_row)
            if row:
                rows.append({**defaults, **row})
        if rows:
            return rows
    return []


def runtime_ledger_event_type(row: Mapping[str, Any]) -> str:
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


def runtime_ledger_row_time(row: Mapping[str, Any]) -> Any:
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
    # Return raw value, caller will handle parsing
    return raw
