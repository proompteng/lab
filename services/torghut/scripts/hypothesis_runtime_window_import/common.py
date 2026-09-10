from __future__ import annotations

import hashlib
import json
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Any, Mapping, Sequence, cast

from app.config import settings
from app.trading.economic_policy import (
    alpaca_equity_fee_schedule_cost,
    alpaca_equity_fee_schedule_hash,
    load_effective_economic_policy,
)

from scripts.hypothesis_runtime_window_import.constants import (
    CONFIGURED_PAPER_COLLECTION_HYPOTHESIS_PREFIX,
    CONFIGURED_SIMPLE_LANE_PAPER_SOURCE_KIND,
    _AUTHORITATIVE_RUNTIME_LEDGER_MATERIALIZATION_SOURCE_KINDS,
    _EXECUTION_ORDER_EVENT_REF_KEYS,
    _EXECUTION_TCA_REF_KEYS,
    _LINEAGE_CONTEXT_KEYS,
    _RUNTIME_LEDGER_EQUITY_DENOMINATOR_KEYS,
    _SOURCE_WINDOW_REF_KEYS,
)


def _manifest_strategy_family_for_resolution(
    *,
    hypothesis_id: str,
    strategy_family: str,
    source_kind: str,
    source_manifest_ref: str,
) -> str | None:
    normalized_strategy_family = strategy_family.strip() or None
    if (
        hypothesis_id.startswith(CONFIGURED_PAPER_COLLECTION_HYPOTHESIS_PREFIX)
        and source_kind == CONFIGURED_SIMPLE_LANE_PAPER_SOURCE_KIND
        and source_manifest_ref.strip()
    ):
        return None
    return normalized_strategy_family


def _parse_dt(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _parse_dt_or_none(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return (
            value.astimezone(timezone.utc)
            if value.tzinfo
            else value.replace(tzinfo=timezone.utc)
        )
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return _parse_dt(text)
    except Exception:
        return None


def _as_mapping(value: Any) -> dict[str, Any]:
    return (
        {str(key): item for key, item in value.items()}
        if isinstance(value, Mapping)
        else {}
    )


def _as_sequence(value: Any) -> list[Any] | None:
    if value is None:
        return []
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except Exception:
            return None
        return _as_sequence(parsed)
    if isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        return list(value)
    return None


def _parse_target_metadata(raw: str) -> dict[str, Any]:
    text = str(raw or "").strip()
    if not text:
        return {}
    try:
        payload = json.loads(text)
    except Exception as exc:
        raise RuntimeError("target_metadata_json_invalid") from exc
    if not isinstance(payload, Mapping):
        raise RuntimeError("target_metadata_json_not_mapping")
    return {str(key): value for key, value in payload.items()}


def _decimal_or_none(value: Any) -> Decimal | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return Decimal(text)
    except Exception:
        return None


def _text_or_none(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None


def _row_payloads(row: Mapping[str, object]) -> list[Mapping[str, object]]:
    payloads: list[Mapping[str, object]] = []

    def append_payload(value: object, *, depth: int) -> None:
        if not isinstance(value, Mapping):
            return
        payload = {str(item_key): item for item_key, item in value.items()}
        payloads.append(payload)
        if depth <= 0:
            return
        for nested in payload.values():
            if isinstance(nested, Mapping):
                append_payload(nested, depth=depth - 1)

    append_payload(row, depth=4)
    return payloads


def _first_decimal(row: Mapping[str, object], *keys: str) -> Decimal | None:
    for payload in _row_payloads(row):
        for key in keys:
            value = payload.get(key)
            if (parsed := _decimal_or_none(value)) is not None:
                return parsed
    return None


def _first_positive_decimal(row: Mapping[str, object], *keys: str) -> Decimal | None:
    for payload in _row_payloads(row):
        for key in keys:
            value = payload.get(key)
            if (parsed := _decimal_or_none(value)) is not None and parsed > 0:
                return parsed
    return None


def _first_text(row: Mapping[str, object], *keys: str) -> str | None:
    for payload in _row_payloads(row):
        for key in keys:
            text = str(payload.get(key) or "").strip()
            if text:
                return text
    return None


def _direct_text(row: Mapping[str, object], *keys: str) -> str | None:
    for key in keys:
        text = str(row.get(key) or "").strip()
        if text:
            return text
    return None


def _bool_value(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float | Decimal):
        return bool(value)
    text = str(value or "").strip().lower()
    if text in {"1", "true", "yes", "on", "pass", "passed", "ok"}:
        return True
    if text in {"0", "false", "no", "off", "fail", "failed", "blocked"}:
        return False
    return None


def _direct_bool(row: Mapping[str, object], *keys: str) -> bool | None:
    for key in keys:
        value = row.get(key)
        if (parsed := _bool_value(value)) is not None:
            return parsed
    return None


def _text_values(row: Mapping[str, object], *keys: str) -> set[str]:
    values: set[str] = set()
    for payload in _row_payloads(row):
        for key in keys:
            raw_value = payload.get(key)
            if isinstance(raw_value, Sequence) and not isinstance(
                raw_value, (str, bytes, bytearray)
            ):
                for item in raw_value:
                    text = str(item or "").strip()
                    if text:
                        values.add(text)
            else:
                text = str(raw_value or "").strip()
                if text:
                    values.add(text)
    return values


def _first_bool(row: Mapping[str, object], *keys: str) -> bool | None:
    for payload in _row_payloads(row):
        for key in keys:
            if (parsed := _bool_value(payload.get(key))) is not None:
                return parsed
    return None


def _position_snapshot_open_position_count(positions: object) -> int | None:
    position_rows = _as_sequence(positions)
    if position_rows is None:
        return None
    count = 0
    for raw_position in position_rows:
        position = _as_mapping(raw_position)
        if not position:
            return None
        qty = _decimal_or_none(
            position.get("qty")
            or position.get("quantity")
            or position.get("filled_qty")
            or position.get("position_qty")
        )
        if qty is None:
            return None
        if qty != 0:
            count += 1
    return count


def _flat_start_position_snapshot_authority(
    snapshot: Mapping[str, object] | None,
) -> dict[str, object] | None:
    if not snapshot:
        return None
    snapshot_id = _text_or_none(
        snapshot.get("snapshot_id")
        or snapshot.get("position_snapshot_id")
        or snapshot.get("id")
    )
    snapshot_as_of = _text_or_none(
        snapshot.get("snapshot_as_of")
        or snapshot.get("position_snapshot_as_of")
        or snapshot.get("as_of")
    )
    if snapshot_id is None or snapshot_as_of is None:
        return None
    if _metadata_text_list(snapshot.get("blockers")):
        return None
    explicit_flat = _first_bool(
        snapshot, "flat", "account_flat", "zero_open_position_evidence"
    )
    positions = snapshot.get("positions")
    position_count = _nonnegative_int(snapshot.get("position_count"))
    if positions is not None:
        position_count = _position_snapshot_open_position_count(positions)
        if position_count is None:
            return None
    if explicit_flat is not True or position_count != 0:
        return None
    return {
        "flat_start_position_snapshot_id": snapshot_id,
        "flat_start_position_snapshot_as_of": snapshot_as_of,
        "flat_start_position_snapshot_source": _text_or_none(
            snapshot.get("snapshot_source") or snapshot.get("source")
        )
        or "position_snapshots",
        "flat_start_position_snapshot_scope": _text_or_none(snapshot.get("scope"))
        or "account_position_snapshot_at_runtime_window_start",
        "carry_in_rows_suppressed_by_flat_start_snapshot": True,
    }


def _runtime_ledger_equity_denominator_from_rows(
    rows: Sequence[Mapping[str, object]],
) -> tuple[Decimal, str] | None:
    denominators: list[tuple[Decimal, str]] = []
    for row in rows:
        for key in _RUNTIME_LEDGER_EQUITY_DENOMINATOR_KEYS:
            value = _first_decimal(row, key)
            if value is not None and value > 0:
                denominators.append((value, key))
                break
    if not denominators:
        return None
    return min(denominators, key=lambda item: item[0])


def _json_default(value: object) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    return str(value)


def _stable_payload_digest(value: object) -> str | None:
    if not isinstance(value, Mapping):
        return None
    payload = {str(item_key): item for item_key, item in value.items()}
    if not payload:
        return None
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        default=_json_default,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _runtime_source_lineage_hash(
    *,
    candidate_id: str | None,
    hypothesis_id: str | None,
) -> str | None:
    payload = {
        key: value
        for key, value in {
            "candidate_id": candidate_id,
            "hypothesis_id": hypothesis_id,
            "source": "runtime_window_lineage_filter",
        }.items()
        if value
    }
    return _stable_payload_digest(payload)


def _attach_source_lineage_context(
    rows: Sequence[Mapping[str, object]],
    *,
    candidate_id: str | None,
    hypothesis_id: str | None,
) -> list[dict[str, object]]:
    lineage_hash = _runtime_source_lineage_hash(
        candidate_id=candidate_id,
        hypothesis_id=hypothesis_id,
    )
    contextualized: list[dict[str, object]] = []
    for row in rows:
        payload = dict(row)
        if candidate_id:
            payload.setdefault("source_candidate_id", candidate_id)
        if hypothesis_id:
            payload.setdefault("source_hypothesis_id", hypothesis_id)
        if lineage_hash:
            payload["lineage_hash"] = lineage_hash
        contextualized.append(payload)
    return contextualized


def _row_has_alpaca_us_equity_order_source(row: Mapping[str, object]) -> bool:
    alpaca_markers = {
        str(item or "").strip().lower()
        for item in (
            *_text_values(row, "feed", "source_topic", "channel", "submit_path"),
            *_text_values(row, "source"),
        )
    }
    if not any(
        "alpaca" in marker or marker == "trade_updates" for marker in alpaca_markers
    ):
        return False
    asset_classes = {
        value.strip().lower().replace("-", "_")
        for value in _text_values(row, "asset_class")
    }
    return not asset_classes or any(
        item in {"us_equity", "us_equities", "equity", "equities"}
        for item in asset_classes
    )


def _alpaca_2026_equity_fee_schedule_cost(
    row: Mapping[str, object],
    *,
    side: Any,
    filled_qty: Decimal | None,
    filled_notional: Decimal,
) -> tuple[Decimal, str] | None:
    if (
        filled_qty is None
        or filled_qty <= 0
        or filled_notional <= 0
        or not _row_has_alpaca_us_equity_order_source(row)
    ):
        return None
    return alpaca_equity_fee_schedule_cost(
        side=side,
        filled_qty=filled_qty,
        filled_notional=filled_notional,
        policy=load_effective_economic_policy(settings),
    )


def _alpaca_2026_equity_fee_schedule_hash() -> str:
    return alpaca_equity_fee_schedule_hash(
        policy=load_effective_economic_policy(settings)
    )


def _cost_basis_is_alpaca_fee_schedule(value: object) -> bool:
    normalized = str(value or "").strip()
    return normalized.startswith(("alpaca_2026_equity_", "modeled_alpaca_2026_equity_"))


def _first_payload_digest(row: Mapping[str, object], *keys: str) -> str | None:
    for payload in _row_payloads(row):
        for key in keys:
            if digest := _stable_payload_digest(payload.get(key)):
                return digest
    return None


def _first_lineage_digest(row: Mapping[str, object]) -> str | None:
    if digest := _first_payload_digest(
        row, "lineage", "candidate_lineage", "source_lineage"
    ):
        return digest
    for payload in _row_payloads(row):
        lineage_payload = {
            key: value
            for key in _LINEAGE_CONTEXT_KEYS
            if (value := payload.get(key)) is not None
        }
        if digest := _stable_payload_digest(lineage_payload):
            return digest
    return None


def _merge_count_mappings(
    existing: Mapping[object, object],
    incoming: Mapping[str, int],
) -> dict[str, int]:
    merged = {str(key): _nonnegative_int(value) for key, value in existing.items()}
    for key, value in incoming.items():
        merged[str(key)] = max(0, int(value)) + merged.get(str(key), 0)
    return dict(sorted((key, value) for key, value in merged.items() if value > 0))


def _source_identifier_values(
    rows: Sequence[Mapping[str, object]] | None,
    *keys: str,
) -> list[str]:
    values: list[str] = []
    for row in rows or ():
        for key in keys:
            raw_value = row.get(key)
            row_values: list[str] = []
            if isinstance(raw_value, Sequence) and not isinstance(
                raw_value,
                (str, bytes, bytearray),
            ):
                row_values = [
                    value
                    for item in raw_value
                    if (value := _text_or_none(item)) is not None
                ]
            elif (value := _text_or_none(raw_value)) is not None:
                row_values = [value]
            if row_values:
                values.extend(row_values)
                break
    return list(dict.fromkeys(values))


def _source_offset_values(
    rows: Sequence[Mapping[str, object]] | None,
) -> list[dict[str, object]]:
    offsets: list[dict[str, object]] = []
    seen: set[tuple[str, str, str]] = set()
    for row in rows or ():
        topic = _text_or_none(row.get("source_topic"))
        partition = row.get("source_partition")
        offset = row.get("source_offset")
        if topic is None or partition is None or offset is None:
            continue
        key = (topic, str(partition), str(offset))
        if key in seen:
            continue
        offsets.append({"topic": topic, "partition": partition, "offset": offset})
        seen.add(key)
    return offsets


def _with_canonical_runtime_source_refs(
    row: Mapping[str, object],
) -> dict[str, object]:
    normalized = {str(key): value for key, value in row.items()}
    if normalized.get("execution_order_event_id") is None:
        execution_order_event_ids = _source_identifier_values(
            [normalized],
            *_EXECUTION_ORDER_EVENT_REF_KEYS,
        )
        if execution_order_event_ids:
            normalized["execution_order_event_id"] = execution_order_event_ids[0]
    if normalized.get("source_window_id") is None:
        source_window_ids = _source_identifier_values(
            [normalized],
            *_SOURCE_WINDOW_REF_KEYS,
        )
        if source_window_ids:
            normalized["source_window_id"] = source_window_ids[0]
    return normalized


def _nonnegative_int(value: Any) -> int:
    try:
        return max(0, int(Decimal(str(value))))
    except Exception:
        return 0


def _metadata_text_list(value: Any) -> list[str]:
    if isinstance(value, str):
        text = value.strip()
        return [text] if text else []
    if not isinstance(value, Sequence) or isinstance(value, (bytes, bytearray)):
        return []
    return [
        text for item in cast(Sequence[Any], value) if (text := str(item or "").strip())
    ]


def _runtime_ledger_tca_ref_texts(value: Any) -> list[str]:
    if isinstance(value, Mapping):
        mapping = cast(Mapping[object, object], value)
        for key in _EXECUTION_TCA_REF_KEYS + ("id", "ref"):
            if (text := _text_or_none(mapping.get(key))) is not None:
                return [text]
        return []
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        refs: list[str] = []
        for item in cast(Sequence[object], value):
            if isinstance(item, Mapping):
                refs.extend(_runtime_ledger_tca_ref_texts(item))
                continue
            if (text := _text_or_none(item)) is not None:
                refs.append(text)
        return refs
    text = _text_or_none(value)
    return [text] if text is not None else []


def _runtime_ledger_execution_tca_metric_refs(
    bucket: Mapping[str, object],
) -> list[str]:
    refs: list[str] = []
    for key in _EXECUTION_TCA_REF_KEYS:
        refs.extend(_runtime_ledger_tca_ref_texts(bucket.get(key)))
    return list(dict.fromkeys(refs))


def _metadata_symbol_list(value: Any) -> list[str]:
    symbols: list[str] = []
    for item in _metadata_text_list(value):
        symbol = item.strip().upper()
        if symbol:
            symbols.append(symbol)
    return list(dict.fromkeys(symbols))


def _target_metadata_source_symbols(target_metadata: Mapping[str, Any]) -> list[str]:
    return _metadata_symbol_list(target_metadata.get("paper_route_probe_symbols"))


def _runtime_ledger_target_metadata_artifact_refs(
    target_metadata: Mapping[str, Any],
) -> list[str]:
    refs: list[str] = []
    for key in (
        "runtime_ledger_artifact_refs",
        "exact_replay_ledger_artifact_refs",
    ):
        refs.extend(_metadata_text_list(target_metadata.get(key)))
    for key in (
        "runtime_ledger_artifact_ref",
        "exact_replay_ledger_artifact_ref",
    ):
        refs.extend(_metadata_text_list(target_metadata.get(key)))
    return list(dict.fromkeys(refs))


def _metadata_nonnegative_int_or_none(value: Any) -> int | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return _nonnegative_int(value)


def _runtime_window_source_kind_is_informational(
    *,
    source_kind: str,
    target_metadata: Mapping[str, Any],
) -> bool:
    normalized = source_kind.strip().lower().replace("-", "_")
    if normalized.startswith("simulation_"):
        return True
    if any(
        marker in normalized
        for marker in (
            "informational",
            "non_authoritative",
            "offline_replay_triage",
            "selection_only",
        )
    ):
        return True
    return False


def _source_collection_target_authorization_blockers(
    target_metadata: Mapping[str, Any],
) -> list[str]:
    blockers: list[str] = []
    if target_metadata.get("source_collection_authorized") is not True:
        blockers.append("source_collection_authorization_missing")
    if (
        str(target_metadata.get("source_collection_authorization_scope") or "").strip()
        != "source_window_evidence_collection_only"
    ):
        blockers.append("source_collection_authorization_scope_invalid")
    return blockers


def _source_kind_allows_runtime_ledger_materialization(
    *,
    source_kind: str,
    target_metadata: Mapping[str, Any],
) -> bool:
    if _runtime_window_source_kind_is_informational(
        source_kind=source_kind,
        target_metadata=target_metadata,
    ):
        return False
    normalized = source_kind.strip().lower().replace("-", "_")
    if normalized == "runtime_ledger_source_collection_candidate":
        return not _source_collection_target_authorization_blockers(target_metadata)
    return normalized in _AUTHORITATIVE_RUNTIME_LEDGER_MATERIALIZATION_SOURCE_KINDS


def _runtime_ledger_event_type(row: Mapping[str, Any]) -> str:
    raw = _text_or_none(
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
        "new_order": "order_submitted",
        "submitted": "order_submitted",
        "accepted": "order_submitted",
        "new": "order_submitted",
        "filled": "fill",
        "partially_filled": "partial_fill",
    }.get(normalized, normalized)


def _runtime_ledger_row_time(row: Mapping[str, Any]) -> datetime | None:
    for key in ("executed_at", "filled_at", "event_ts", "created_at", "computed_at"):
        if (parsed := _parse_dt_or_none(row.get(key))) is not None:
            return parsed
    return None


def _parse_artifact_window_datetime(
    value: Any,
    *,
    date_end: bool = False,
) -> datetime | None:
    if isinstance(value, datetime):
        return (
            value.astimezone(timezone.utc)
            if value.tzinfo
            else value.replace(tzinfo=timezone.utc)
        )
    text = str(value or "").strip()
    if not text:
        return None
    try:
        if "T" not in text and len(text) == 10:
            parsed_date = date.fromisoformat(text)
            parsed = datetime.combine(parsed_date, time.min, tzinfo=timezone.utc)
            return parsed + timedelta(days=1) if date_end else parsed
        return _parse_dt(text)
    except Exception:
        return None


def _window_weekday_count(*, start: datetime, end: datetime) -> int:
    count = 0
    current = datetime.combine(start.date(), time.min, tzinfo=timezone.utc)
    while current < end:
        next_day = current + timedelta(days=1)
        if current.weekday() < 5 and next_day > start:
            count += 1
        current = next_day
    return count


def _runtime_ledger_artifact_candidate_ids(
    *,
    payload: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
) -> list[str]:
    candidates: list[str] = []
    for key in (
        "candidate_id",
        "candidateId",
        "strategy_candidate_id",
        "strategyCandidateId",
    ):
        if candidate_id := _text_or_none(payload.get(key)):
            candidates.append(candidate_id)
    for row in rows:
        for key in (
            "candidate_id",
            "candidateId",
            "strategy_candidate_id",
            "strategyCandidateId",
        ):
            if candidate_id := _text_or_none(row.get(key)):
                candidates.append(candidate_id)
    return sorted(dict.fromkeys(candidates))


def _execution_signed_qty(*, side: Any, qty: Any) -> Decimal:
    normalized_side = str(side or "").strip().lower().replace("-", "_")
    quantity = _decimal_or_none(qty)
    if quantity is None or quantity <= 0:
        return Decimal("0")
    if normalized_side in {"buy", "buy_to_cover", "cover"}:
        return quantity
    if normalized_side in {"sell", "sell_short", "short"}:
        return -quantity
    return Decimal("0")


def _execution_row_has_fill(row: Mapping[str, object]) -> bool:
    filled_qty = _first_positive_decimal(
        row,
        "filled_qty",
        "filled_quantity",
        "qty",
        "quantity",
    )
    avg_fill_price = _first_positive_decimal(
        row,
        "avg_fill_price",
        "filled_avg_price",
        "filled_average_price",
        "average_fill_price",
        "fill_price",
        "filled_price",
    )
    return (
        filled_qty is not None
        and filled_qty > 0
        and avg_fill_price is not None
        and avg_fill_price > 0
    )


def _source_authority_order_event_row(row: Mapping[str, object]) -> bool:
    return any(
        row.get(key) is not None
        for key in (
            "execution_order_event_id",
            "source_window_id",
            "source_offset",
        )
    )


def _runtime_source_row_symbol(row: Mapping[str, object]) -> str | None:
    symbol = _first_text(row, "symbol", "ticker")
    return symbol.upper() if symbol is not None else None


__all__ = [
    "_runtime_source_row_symbol",
    "_source_authority_order_event_row",
    "_execution_row_has_fill",
    "_execution_signed_qty",
    "_manifest_strategy_family_for_resolution",
    "_parse_dt",
    "_parse_dt_or_none",
    "_as_mapping",
    "_as_sequence",
    "_parse_target_metadata",
    "_decimal_or_none",
    "_text_or_none",
    "_row_payloads",
    "_first_decimal",
    "_first_positive_decimal",
    "_first_text",
    "_direct_text",
    "_bool_value",
    "_direct_bool",
    "_text_values",
    "_first_bool",
    "_position_snapshot_open_position_count",
    "_flat_start_position_snapshot_authority",
    "_runtime_ledger_equity_denominator_from_rows",
    "_json_default",
    "_stable_payload_digest",
    "_runtime_source_lineage_hash",
    "_attach_source_lineage_context",
    "_row_has_alpaca_us_equity_order_source",
    "_alpaca_2026_equity_fee_schedule_cost",
    "_alpaca_2026_equity_fee_schedule_hash",
    "_cost_basis_is_alpaca_fee_schedule",
    "_first_payload_digest",
    "_first_lineage_digest",
    "_merge_count_mappings",
    "_source_identifier_values",
    "_source_offset_values",
    "_with_canonical_runtime_source_refs",
    "_nonnegative_int",
    "_metadata_text_list",
    "_runtime_ledger_tca_ref_texts",
    "_runtime_ledger_execution_tca_metric_refs",
    "_metadata_symbol_list",
    "_target_metadata_source_symbols",
    "_runtime_ledger_target_metadata_artifact_refs",
    "_metadata_nonnegative_int_or_none",
    "_runtime_window_source_kind_is_informational",
    "_source_collection_target_authorization_blockers",
    "_source_kind_allows_runtime_ledger_materialization",
    "_runtime_ledger_event_type",
    "_runtime_ledger_row_time",
    "_parse_artifact_window_datetime",
    "_window_weekday_count",
    "_runtime_ledger_artifact_candidate_ids",
]
