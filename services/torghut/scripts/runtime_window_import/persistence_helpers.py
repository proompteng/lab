"""Persistence helpers for runtime window imports."""

from __future__ import annotations

from typing import Any, Sequence

from .parsers import metadata_text_list, nonnegative_int


def merge_count_mappings(
    existing: dict[str, int],
    incoming: dict[str, int],
) -> dict[str, int]:
    """Merge two count mappings, taking maximum of each key."""
    merged = {str(key): nonnegative_int(value) for key, value in existing.items()}
    for key, value in incoming.items():
        merged[str(key)] = max(0, int(value)) + merged.get(str(key), 0)
    return dict(sorted((key, value) for key, value in merged.items() if value > 0))


def with_runtime_ledger_source_authority_context(
    bucket: dict[str, Any],
    *,
    source_window_start: Any,
    source_window_end: Any,
    source_refs: Sequence[str],
    source_row_counts: dict[str, int],
    **kwargs: Any,
) -> dict[str, Any]:
    """Add source authority context to a bucket."""
    from .parsers import as_mapping

    payload = dict(bucket)
    payload.setdefault("source_window_start", str(source_window_start))
    payload.setdefault("source_window_end", str(source_window_end))
    if source_refs:
        existing_refs = metadata_text_list(payload.get("source_refs"))
        payload["source_refs"] = list(dict.fromkeys([*existing_refs, *source_refs]))
    for source_key, alias_keys in (
        (
            "trade_decision_ids",
            ("trade_decision_refs", "decision_ids", "decision_refs"),
        ),
        ("execution_ids", ("execution_refs", "runtime_ledger_execution_ids")),
        (
            "execution_tca_metric_ids",
            (
                "execution_tca_metric_refs",
                "runtime_ledger_execution_tca_metric_ids",
                "runtime_ledger_execution_tca_metric_refs",
            ),
        ),
        (
            "execution_order_event_ids",
            (
                "execution_order_event_refs",
                "runtime_ledger_execution_order_event_ids",
                "runtime_ledger_execution_order_event_refs",
            ),
        ),
        (
            "source_window_ids",
            (
                "source_window_refs",
                "runtime_ledger_source_window_ids",
                "runtime_ledger_source_window_refs",
            ),
        ),
    ):
        values = metadata_text_list(payload.get(source_key))
        if not values:
            continue
        for alias_key in alias_keys:
            existing_values = metadata_text_list(payload.get(alias_key))
            payload[alias_key] = list(dict.fromkeys([*existing_values, *values]))
    if source_row_counts:
        existing_counts = as_mapping(payload.get("source_row_counts"))
        merged_counts: dict[str, int] = {
            str(key): nonnegative_int(value) for key, value in existing_counts.items()
        }
        for key, value in source_row_counts.items():
            table_name = str(key)
            merged_counts[table_name] = max(
                merged_counts.get(table_name, 0),
                max(0, int(value)),
            )
        if merged_counts:
            payload["source_row_counts"] = dict(sorted(merged_counts.items()))
    existing_blockers = metadata_text_list(payload.get("blockers"))
    if existing_blockers:
        payload["blockers"] = existing_blockers
    return payload


def append_runtime_ledger_tca_row_blocker(
    *,
    tca_rows: list[dict[str, Any]],
    blocker: str,
) -> None:
    """Append a blocker to all TCA rows."""
    for row in tca_rows:
        bucket = row.get("runtime_ledger_bucket")
        if not isinstance(bucket, dict):
            continue
        bucket_payload = {str(key): item for key, item in bucket.items()}
        blockers = metadata_text_list(bucket_payload.get("blockers"))
        if blocker not in blockers:
            blockers.append(blocker)
        bucket_payload["blockers"] = blockers
        row["runtime_ledger_bucket"] = bucket_payload
        row["runtime_ledger_blockers"] = blockers
        row["post_cost_promotion_eligible"] = False
