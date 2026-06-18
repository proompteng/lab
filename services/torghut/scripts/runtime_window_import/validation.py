"""Validation helpers for runtime window imports."""

from __future__ import annotations

from typing import Any, Mapping

from app.trading.runtime_cost_authority import (
    cost_basis_counts_have_non_promotion_grade_costs,
    is_non_promotion_grade_runtime_cost_basis,
)
from app.trading.runtime_ledger_source_authority import (
    runtime_ledger_promotion_source_authority_blockers as _base_runtime_ledger_promotion_source_authority_blockers,
)

from .parsers import as_mapping, metadata_text_list, nonnegative_int, text_or_none

# Constants
RUNTIME_LEDGER_AUTHORITY_CLASS_MISSING_BLOCKER = (
    "runtime_ledger_authority_class_missing"
)
EXECUTION_TCA_MISSING_BLOCKER = "execution_tca_missing"
RUNTIME_LEDGER_EXECUTION_TCA_REFS_MISSING_BLOCKER = (
    "runtime_ledger_execution_tca_refs_missing"
)
RUNTIME_LEDGER_SOURCE_AUTHORITY_BLOCKERS = frozenset(
    {
        "runtime_ledger_source_window_missing",
        "runtime_ledger_source_window_ids_missing",
        "runtime_ledger_source_refs_missing",
        "runtime_ledger_trade_decision_refs_missing",
        "runtime_ledger_execution_refs_missing",
        "runtime_ledger_execution_order_event_refs_missing",
        "runtime_ledger_source_offsets_missing",
        "runtime_ledger_source_materialization_missing",
        "runtime_ledger_authority_class_missing",
        "order_feed_source_window_gap",
        "order_feed_lifecycle_missing",
        "execution_economics_missing",
    }
)
_RUNTIME_LEDGER_PROMOTION_GRADE_AUTHORITY_MARKERS = frozenset(
    {
        "runtime_order_feed_execution_source",
        "event_sourced_runtime_ledger_profit_proof",
        "source_execution_runtime_ledger_materialized",
        "execution_order_events_runtime_ledger",
        "source_execution_lifecycle_materialized_runtime_ledger",
    }
)


def promotion_grade_runtime_ledger_authority_marker_present(
    bucket: Mapping[str, object],
    key: str,
) -> bool:
    """Check if a promotion grade authority marker is present."""
    marker = text_or_none(bucket.get(key))
    return (
        marker is not None
        and marker in _RUNTIME_LEDGER_PROMOTION_GRADE_AUTHORITY_MARKERS
    )


def runtime_ledger_promotion_source_authority_blockers(
    bucket: Mapping[str, object],
) -> list[str]:
    """Get promotion source authority blockers for a bucket."""
    blockers = _base_runtime_ledger_promotion_source_authority_blockers(bucket)
    if not (
        promotion_grade_runtime_ledger_authority_marker_present(
            bucket, "authority_class"
        )
        and promotion_grade_runtime_ledger_authority_marker_present(
            bucket, "authority_reason"
        )
    ):
        blockers.append(RUNTIME_LEDGER_AUTHORITY_CLASS_MISSING_BLOCKER)
    return list(dict.fromkeys(blockers))


def runtime_ledger_promotion_source_authority_present(
    bucket: Mapping[str, object],
) -> bool:
    """Check if promotion source authority is present."""
    return not runtime_ledger_promotion_source_authority_blockers(bucket)


def runtime_ledger_bucket_profit_proof_blockers(
    bucket: Mapping[str, object],
) -> list[str]:
    """Get profit proof blockers for a runtime ledger bucket."""
    from .summary import runtime_ledger_bucket_profit_proof_blockers as summary_blockers

    return summary_blockers(bucket)


def runtime_ledger_bucket_profit_proof_present(
    bucket: Mapping[str, object],
) -> bool:
    """Check if profit proof is present in bucket."""
    return not runtime_ledger_bucket_profit_proof_blockers(bucket)


def runtime_ledger_explicit_costs_present(bucket: Mapping[str, object]) -> bool:
    """Check if explicit costs are present in bucket."""
    cost_amount = text_or_none(
        as_mapping(bucket).get("cost_amount")
        if as_mapping(bucket).get("cost_amount") is not None
        else as_mapping(bucket).get("runtime_ledger_cost_amount")
    )
    if cost_amount is None:
        return False
    try:
        cost_decimal = __import__("decimal").Decimal(cost_amount)
    except Exception:
        return False
    if cost_decimal < 0:
        return False
    if is_non_promotion_grade_runtime_cost_basis(as_mapping(bucket).get("cost_basis")):
        return False
    if cost_basis_counts_have_non_promotion_grade_costs(
        as_mapping(bucket).get("cost_basis_counts")
    ) or cost_basis_counts_have_non_promotion_grade_costs(
        as_mapping(bucket).get("post_cost_basis_counts")
    ):
        return False
    if positive_count_mapping_present(as_mapping(bucket).get("cost_basis_counts")):
        return True
    if positive_count_mapping_present(as_mapping(bucket).get("post_cost_basis_counts")):
        return True
    return (
        text_or_none(
            as_mapping(bucket).get("cost_basis")
            or as_mapping(bucket).get("cost_source")
            or as_mapping(bucket).get("fee_basis")
            or as_mapping(bucket).get("commission_basis")
            or as_mapping(bucket).get("broker_fee_basis")
        )
        is not None
    )


def runtime_ledger_execution_tca_metric_refs(bucket: Mapping[str, object]) -> list[str]:
    """Extract TCA metric refs from bucket."""
    refs: list[str] = []
    for key in (
        "execution_tca_metric_ids",
        "execution_tca_metric_refs",
        "execution_tca_metric_id",
        "execution_tca_metric_ref",
        "execution_tca_metrics",
        "runtime_ledger_execution_tca_metric_ids",
        "runtime_ledger_execution_tca_metric_refs",
        "runtime_ledger_execution_tca_metric_id",
        "runtime_ledger_execution_tca_metric_ref",
    ):
        refs.extend(metadata_text_list(as_mapping(bucket).get(key)))
    return list(dict.fromkeys(refs))


def mapping_hash_count(value: object) -> int:
    """Count non-empty keys in mapping."""
    if not isinstance(value, Mapping):
        return 0
    return sum(1 for key in value.keys() if str(key).strip())


def positive_count_mapping_present(value: object) -> bool:
    """Check if mapping has positive count values."""
    if not isinstance(value, Mapping):
        return False
    try:
        from decimal import Decimal
    except ImportError:
        Decimal = __import__("decimal").Decimal
    for item in value.values():
        try:
            parsed = Decimal(str(item))
        except Exception:
            continue
        if parsed.is_finite() and parsed > 0:
            return True
    return False


def with_runtime_ledger_source_authority_context(
    bucket: dict[str, Any],
    *,
    source_window_start: Any,
    source_window_end: Any,
    source_refs: list[str],
    source_row_counts: dict[str, int],
    **kwargs: Any,
) -> dict[str, Any]:
    """Add source authority context to a bucket."""
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
