"""Shared source-authority checks for runtime-ledger proof payloads."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import cast

from .runtime_cost_authority import (
    cost_basis_counts_have_non_promotion_grade_costs,
    is_non_promotion_grade_runtime_cost_basis,
)

RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER = "runtime_ledger_source_window_missing"
RUNTIME_LEDGER_SOURCE_WINDOW_IDS_MISSING_BLOCKER = (
    "runtime_ledger_source_window_ids_missing"
)
RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER = "runtime_ledger_source_refs_missing"
RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER = (
    "runtime_ledger_trade_decision_refs_missing"
)
RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER = "runtime_ledger_execution_refs_missing"
RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER = (
    "runtime_ledger_execution_order_event_refs_missing"
)
RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER = "runtime_ledger_source_offsets_missing"
RUNTIME_LEDGER_SOURCE_MATERIALIZATION_MISSING_BLOCKER = (
    "runtime_ledger_source_materialization_missing"
)
RUNTIME_LEDGER_AUTHORITY_CLASS_MISSING_BLOCKER = (
    "runtime_ledger_authority_class_missing"
)
ORDER_FEED_SOURCE_WINDOW_GAP_BLOCKER = "order_feed_source_window_gap"
ORDER_FEED_LIFECYCLE_MISSING_BLOCKER = "order_feed_lifecycle_missing"
EXECUTION_ECONOMICS_MISSING_BLOCKER = "execution_economics_missing"

_PROMOTION_GRADE_SOURCE_MATERIALIZATIONS = frozenset(
    {
        "execution_order_events",
        "source_execution_lifecycle",
    }
)
_PROMOTION_GRADE_AUTHORITY_MARKERS = frozenset(
    {
        "runtime_order_feed_execution_source",
        "event_sourced_runtime_ledger_profit_proof",
        "source_execution_runtime_ledger_materialized",
        "execution_order_events_runtime_ledger",
        "source_execution_lifecycle_materialized_runtime_ledger",
    }
)
_PROMOTION_GRADE_SOURCE_REF_TABLES = frozenset(
    {
        "trade_decisions",
        "executions",
        "execution_order_events",
        "order_feed_source_windows",
    }
)
_NON_PROMOTION_AUTHORITY_MARKERS = frozenset(
    {
        "aggregate_only",
        "exact_replay",
        "artifact_only",
        "paper_route_probe",
        "probe",
        "recovery",
        "replay_artifact",
        "route_acquisition",
        "route_reacquisition",
        "simulation_source_replay_only",
    }
)


def _text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _parse_datetime(value: object) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    else:
        text = _text(value)
        if text is None:
            return None
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _string_list(value: object) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    return [
        text
        for item in cast(Sequence[object], value)
        if (text := _text(item)) is not None
    ]


def _positive_mapping_value_count(value: object) -> int:
    if not isinstance(value, Mapping):
        return 0
    count = 0
    for item in cast(Mapping[object, object], value).values():
        try:
            parsed = Decimal(str(item))
        except (InvalidOperation, ValueError):
            continue
        if parsed.is_finite() and parsed > 0:
            count += 1
    return count


def _source_ref_present(value: object) -> bool:
    if isinstance(value, Mapping):
        return _source_ref_count({"refs": cast(object, value)}, "refs") > 0
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return bool(_string_list(cast(Sequence[object], value)))
    return bool(_string_list(value) or _text(value) is not None)


def _source_refs_present(bucket: Mapping[str, object], *keys: str) -> bool:
    return any(_source_ref_present(bucket.get(key)) for key in keys)


def _source_ref_count(bucket: Mapping[str, object], *keys: str) -> int:
    refs: set[str] = set()
    for key in keys:
        value = bucket.get(key)
        if isinstance(value, Mapping):
            for ref_key, ref_value in cast(Mapping[object, object], value).items():
                if ref_value is None or ref_value is False:
                    continue
                ref_text = _text(ref_value)
                if ref_value is True or ref_text is None:
                    ref_text = _text(ref_key)
                if ref_text is not None:
                    refs.add(ref_text)
            continue
        if isinstance(value, Sequence) and not isinstance(
            value, (str, bytes, bytearray)
        ):
            refs.update(_string_list(cast(Sequence[object], value)))
            continue
        if (ref := _text(value)) is not None:
            refs.add(ref)
    return len(refs)


def _source_row_count(bucket: Mapping[str, object], table_name: str) -> int:
    source_row_counts = bucket.get("source_row_counts")
    if not isinstance(source_row_counts, Mapping):
        return 0
    value = cast(Mapping[object, object], source_row_counts).get(table_name)
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return 0
    if not parsed.is_finite() or parsed <= 0:
        return 0
    return int(parsed)


def _source_ref_table_names(value: object) -> set[str]:
    refs = _string_list(value)
    table_names: set[str] = set()
    for ref in refs:
        normalized = ref.strip().lower()
        if normalized:
            table_names.add(normalized)
        if ":" in normalized:
            tail = normalized.rsplit(":", maxsplit=1)[-1]
            if tail:
                table_names.add(tail)
    return table_names


def _source_row_counts_have_positive_rows(
    bucket: Mapping[str, object], table_name: str
) -> bool:
    return _source_row_count(bucket, table_name) > 0


def _nonnegative_mapping_total(value: object) -> int:
    if not isinstance(value, Mapping):
        return 0
    total = 0
    for item in cast(Mapping[object, object], value).values():
        try:
            parsed = Decimal(str(item))
        except (InvalidOperation, ValueError):
            continue
        if parsed.is_finite() and parsed > 0:
            total += int(parsed)
    return total


def _nonnegative_int(value: object) -> int:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return 0
    if not parsed.is_finite() or parsed <= 0:
        return 0
    return int(parsed)


def _truthy_flag(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    text = _text(value)
    if text is None:
        return None
    normalized = text.lower()
    if normalized in {"1", "true", "yes", "y"}:
        return True
    if normalized in {"0", "false", "no", "n"}:
        return False
    return None


def _promotion_grade_source_refs_present(bucket: Mapping[str, object]) -> bool:
    source_ref_tables = _source_ref_table_names(bucket.get("source_refs"))
    return all(
        table_name in source_ref_tables
        and _source_row_counts_have_positive_rows(bucket, table_name)
        for table_name in _PROMOTION_GRADE_SOURCE_REF_TABLES
    )


def _source_offsets_present(bucket: Mapping[str, object]) -> bool:
    return _source_offset_count(bucket) > 0


def _source_offset_count(bucket: Mapping[str, object]) -> int:
    def has_source_offset_triplet(value: Mapping[object, object]) -> bool:
        return (
            _text(value.get("topic")) is not None
            and value.get("partition") is not None
            and value.get("offset") is not None
        )

    source_offsets = bucket.get("source_offsets")
    if isinstance(source_offsets, Mapping):
        return int(
            has_source_offset_triplet(cast(Mapping[object, object], source_offsets))
        )
    if isinstance(source_offsets, Sequence) and not isinstance(
        source_offsets, (str, bytes, bytearray)
    ):
        offsets: set[tuple[str, str, str]] = set()
        for item in cast(Sequence[object], source_offsets):
            if isinstance(item, Mapping):
                typed_item = cast(Mapping[object, object], item)
                if has_source_offset_triplet(typed_item):
                    offsets.add(
                        (
                            str(typed_item.get("topic")),
                            str(typed_item.get("partition")),
                            str(typed_item.get("offset")),
                        )
                    )
        return len(offsets)
    return int(
        _text(bucket.get("source_topic")) is not None
        and bucket.get("source_partition") is not None
        and bucket.get("source_offset") is not None
    )


def _source_window_gap_count(bucket: Mapping[str, object]) -> int:
    count = _nonnegative_int(
        bucket.get("source_window_gap_count")
        or bucket.get("order_feed_source_window_gap_count")
    )
    if count > 0:
        return count
    gap_ranges = bucket.get("source_window_gap_ranges") or bucket.get(
        "order_feed_source_window_gap_ranges"
    )
    if isinstance(gap_ranges, Sequence) and not isinstance(
        gap_ranges, (str, bytes, bytearray)
    ):
        return len(cast(Sequence[object], gap_ranges))
    return _nonnegative_mapping_total(bucket.get("source_window_gap_counts"))


def _source_window_classification_count(
    bucket: Mapping[str, object],
    *classification_names: str,
) -> int:
    counts = bucket.get("source_window_classification_counts") or bucket.get(
        "order_feed_source_window_classification_counts"
    )
    if not isinstance(counts, Mapping):
        return 0
    total = 0
    for name in classification_names:
        total += _nonnegative_int(cast(Mapping[object, object], counts).get(name))
    return total


def _promotion_grade_source_materialization_present(
    bucket: Mapping[str, object],
) -> bool:
    source_materialization = _text(bucket.get("source_materialization"))
    return (
        source_materialization is not None
        and source_materialization in _PROMOTION_GRADE_SOURCE_MATERIALIZATIONS
    )


def _non_promotion_authority_marker_present(value: object) -> bool:
    text = _text(value)
    if text is None:
        return False
    normalized = text.lower().replace("-", "_")
    return any(marker in normalized for marker in _NON_PROMOTION_AUTHORITY_MARKERS)


def _promotion_grade_authority_marker_present(bucket: Mapping[str, object]) -> bool:
    for key in ("authority_class", "authority_reason"):
        marker = _text(bucket.get(key))
        if marker in _PROMOTION_GRADE_AUTHORITY_MARKERS:
            return True
    return False


def _non_promotion_derivation_present(bucket: Mapping[str, object]) -> bool:
    promotion_authority = _truthy_flag(bucket.get("promotion_authority"))
    if promotion_authority is False:
        return True
    return any(
        _non_promotion_authority_marker_present(bucket.get(key))
        for key in (
            "authority_class",
            "authority_reason",
            "pnl_derivation",
            "source",
            "source_kind",
            "promotion_authority",
        )
    )


def _positive_decimal_present(value: object) -> bool:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return False
    return parsed.is_finite() and parsed > 0


def _filled_notional_present(bucket: Mapping[str, object]) -> bool:
    return any(
        _positive_decimal_present(bucket.get(key))
        for key in (
            "filled_notional",
            "runtime_ledger_filled_notional",
            "filled_notional_delta",
            "fill_notional_delta",
            "delta_filled_notional",
        )
    )


def _explicit_cost_basis_present(bucket: Mapping[str, object]) -> bool:
    if is_non_promotion_grade_runtime_cost_basis(bucket.get("cost_basis")):
        return False
    if cost_basis_counts_have_non_promotion_grade_costs(bucket.get("cost_basis_counts")):
        return False
    if cost_basis_counts_have_non_promotion_grade_costs(
        bucket.get("post_cost_basis_counts")
    ):
        return False
    cost_basis_counts = bucket.get("cost_basis_counts") or bucket.get(
        "post_cost_basis_counts"
    )
    if _positive_mapping_value_count(cost_basis_counts) > 0:
        return True
    return _text(
        bucket.get("cost_basis")
        or bucket.get("cost_source")
        or bucket.get("fee_basis")
        or bucket.get("commission_basis")
        or bucket.get("broker_fee_basis")
    ) is not None


def _explicit_cost_amount_present(bucket: Mapping[str, object]) -> bool:
    for key in (
        "cost_amount",
        "runtime_ledger_cost_amount",
        "explicit_cost",
        "explicit_cost_amount",
        "commission",
        "fees",
        "fee_amount",
        "broker_fee",
    ):
        if bucket.get(key) is None:
            continue
        try:
            parsed = Decimal(str(bucket.get(key)))
        except (InvalidOperation, ValueError):
            continue
        if parsed.is_finite() and parsed >= 0:
            return True
    # Bucket-level readback can prove explicit zero/non-zero costs with a cost
    # basis histogram and a cost-model lineage hash even when it does not carry
    # per-fill fee amounts in payload_json.
    cost_basis_counts = bucket.get("cost_basis_counts") or bucket.get(
        "post_cost_basis_counts"
    )
    return _positive_mapping_value_count(cost_basis_counts) > 0 and (
        _positive_mapping_value_count(bucket.get("cost_model_hash_counts")) > 0
        or _source_refs_present(bucket, "cost_model_hashes", "cost_model_hash")
    )


def _execution_economics_present(bucket: Mapping[str, object]) -> bool:
    return (
        _filled_notional_present(bucket)
        and _explicit_cost_basis_present(bucket)
        and _explicit_cost_amount_present(bucket)
    )


def runtime_ledger_source_window_present(bucket: Mapping[str, object]) -> bool:
    start = _parse_datetime(
        bucket.get("source_window_start")
        or bucket.get("runtime_ledger_source_window_start")
    )
    end = _parse_datetime(
        bucket.get("source_window_end")
        or bucket.get("runtime_ledger_source_window_end")
    )
    return start is not None and end is not None and end > start


def runtime_ledger_source_refs_present(bucket: Mapping[str, object]) -> bool:
    source_refs = _string_list(bucket.get("source_refs"))
    source_ref = bucket.get("source_ref")
    source_ref_present = bool(source_refs)
    if isinstance(source_ref, Mapping):
        source_ref_present = (
            source_ref_present or len(cast(Mapping[object, object], source_ref)) > 0
        )
    elif _text(source_ref) is not None:
        source_ref_present = True
    return (
        source_ref_present
        and _positive_mapping_value_count(bucket.get("source_row_counts")) > 0
    )


def runtime_ledger_source_authority_blockers(
    bucket: Mapping[str, object],
) -> list[str]:
    blockers: list[str] = []
    if not runtime_ledger_source_window_present(bucket):
        blockers.append(RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER)
    if not runtime_ledger_source_refs_present(bucket):
        blockers.append(RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER)
    return blockers


def runtime_ledger_promotion_source_authority_blockers(
    bucket: Mapping[str, object],
) -> list[str]:
    """Return blockers for promotion-grade runtime/order-feed source proof.

    Aggregate bucket fields are not enough for promotion authority. The bucket must
    also carry row-level runtime lineage back to order-feed lifecycle and execution
    sources so durable/source imports cannot become proof by shape alone.
    """

    blockers = runtime_ledger_source_authority_blockers(bucket)
    if not _promotion_grade_source_refs_present(bucket):
        blockers.append(RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER)
    if not _source_refs_present(
        bucket,
        "source_window_ids",
        "source_window_id",
        "runtime_ledger_source_window_ids",
        "runtime_ledger_source_window_id",
    ) or _source_ref_count(
        bucket,
        "source_window_ids",
        "source_window_id",
        "runtime_ledger_source_window_ids",
        "runtime_ledger_source_window_id",
    ) < _source_row_count(bucket, "order_feed_source_windows"):
        blockers.append(RUNTIME_LEDGER_SOURCE_WINDOW_IDS_MISSING_BLOCKER)
    if not _source_refs_present(
        bucket,
        "trade_decision_ids",
        "trade_decision_refs",
        "trade_decision_id",
        "decision_ids",
        "decision_id",
    ) or _source_ref_count(
        bucket,
        "trade_decision_ids",
        "trade_decision_refs",
        "trade_decision_id",
        "decision_ids",
        "decision_id",
    ) < _source_row_count(bucket, "trade_decisions"):
        blockers.append(RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER)
    if not _source_refs_present(
        bucket,
        "execution_ids",
        "execution_refs",
        "execution_id",
    ) or _source_ref_count(
        bucket,
        "execution_ids",
        "execution_refs",
        "execution_id",
    ) < _source_row_count(bucket, "executions"):
        blockers.append(RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER)
    if not _source_refs_present(
        bucket,
        "execution_order_event_ids",
        "execution_order_event_refs",
        "execution_order_event_id",
    ) or _source_ref_count(
        bucket,
        "execution_order_event_ids",
        "execution_order_event_refs",
        "execution_order_event_id",
    ) < _source_row_count(bucket, "execution_order_events"):
        blockers.append(RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER)
    if not _source_offsets_present(bucket) or _source_offset_count(
        bucket
    ) < _source_row_count(bucket, "execution_order_events"):
        blockers.append(RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER)
    if _source_window_gap_count(bucket) > 0:
        blockers.append(ORDER_FEED_SOURCE_WINDOW_GAP_BLOCKER)
    lifecycle_complete = _truthy_flag(bucket.get("order_feed_lifecycle_complete"))
    if lifecycle_complete is False or _source_window_classification_count(
        bucket,
        "unlinked_execution",
        "unlinked_decision",
        "missing_order_identity",
        "missing_trade_update_payload",
        "malformed_json",
        "out_of_scope_account",
        "failed_unhandled",
    ) > 0:
        blockers.append(ORDER_FEED_LIFECYCLE_MISSING_BLOCKER)
    economics_complete = _truthy_flag(bucket.get("execution_economics_complete"))
    economics_required = _truthy_flag(
        bucket.get("execution_economics_required")
        or bucket.get("requires_execution_economics")
    )
    if economics_complete is False or (
        economics_required is True and not _execution_economics_present(bucket)
    ):
        blockers.append(EXECUTION_ECONOMICS_MISSING_BLOCKER)
    if (
        not _promotion_grade_source_materialization_present(bucket)
        or _non_promotion_authority_marker_present(bucket.get("source_materialization"))
    ):
        blockers.append(RUNTIME_LEDGER_SOURCE_MATERIALIZATION_MISSING_BLOCKER)
    if (
        not _promotion_grade_authority_marker_present(bucket)
        or _non_promotion_derivation_present(bucket)
    ):
        blockers.append(RUNTIME_LEDGER_AUTHORITY_CLASS_MISSING_BLOCKER)
    return list(dict.fromkeys(blockers))


def runtime_ledger_promotion_source_authority_present(
    bucket: Mapping[str, object],
) -> bool:
    return not runtime_ledger_promotion_source_authority_blockers(bucket)


__all__ = [
    "RUNTIME_LEDGER_AUTHORITY_CLASS_MISSING_BLOCKER",
    "EXECUTION_ECONOMICS_MISSING_BLOCKER",
    "ORDER_FEED_LIFECYCLE_MISSING_BLOCKER",
    "ORDER_FEED_SOURCE_WINDOW_GAP_BLOCKER",
    "RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_SOURCE_MATERIALIZATION_MISSING_BLOCKER",
    "RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_SOURCE_WINDOW_IDS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER",
    "RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER",
    "runtime_ledger_promotion_source_authority_blockers",
    "runtime_ledger_promotion_source_authority_present",
    "runtime_ledger_source_authority_blockers",
    "runtime_ledger_source_refs_present",
    "runtime_ledger_source_window_present",
]
