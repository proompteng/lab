#!/usr/bin/env python
"""Read-only H-PAIRS/TORGHUT_SIM source-proof census/readback CLI.

This command deliberately performs diagnostics only: it reads SQLAlchemy rows or
fixture JSON and emits a deterministic machine-readable census of the gap between
paper-route activity and authority-grade runtime-ledger proof. It never writes
proof artifacts, promotion state, or database rows.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from decimal import Decimal


from .shared_context import (
    CensusIdentity,
    CensusSourceRows,
)


def _mapping(value: object) -> Mapping[str, object]:
    from .parse_timestamp import _mapping as owned

    return owned(value)


def _sequence(value: object) -> Sequence[object]:
    from .parse_timestamp import _sequence as owned

    return owned(value)


def _text(value: object, *, default: str | None = None) -> str | None:
    from .parse_timestamp import _text as owned

    return owned(value, default=default)


def _int(value: object) -> int:
    from .parse_timestamp import _int as owned

    return owned(value)


def _decimal(value: object) -> Decimal:
    from .parse_timestamp import _decimal as owned

    return owned(value)


def _decimal_text(value: Decimal) -> str:
    from .parse_timestamp import _decimal_text as owned

    return owned(value)


def _sum_daily_int(daily: Sequence[Mapping[str, object]], key: str) -> int:
    from .blocker_ladder import _sum_daily_int as owned

    return owned(daily, key)


def _row_days(
    rows: Sequence[Mapping[str, object]],
    key: str,
    *,
    fallback_key: str | None = None,
) -> set[str]:
    from .blocker_ladder import _row_days as owned

    return owned(rows, key, fallback_key=fallback_key)


def _ledger_days(ledger_report: Mapping[str, object]) -> set[str]:
    from .blocker_ladder import _ledger_days as owned

    return owned(ledger_report)


def _rows_on_day(
    rows: Sequence[Mapping[str, object]],
    day: str,
    key: str,
    *,
    fallback_key: str | None = None,
) -> list[Mapping[str, object]]:
    from .blocker_ladder import _rows_on_day as owned

    return owned(rows, day, key, fallback_key=fallback_key)


def _filled_execution(row: Mapping[str, object]) -> bool:
    from .blocker_ladder import _filled_execution as owned

    return owned(row)


def _fill_event(row: Mapping[str, object]) -> bool:
    from .blocker_ladder import _fill_event as owned

    return owned(row)


def _event_quantity_present(row: Mapping[str, object]) -> bool:
    from .blocker_ladder import _event_quantity_present as owned

    return owned(row)


def _event_source_offset_present(row: Mapping[str, object]) -> bool:
    from .blocker_ladder import _event_source_offset_present as owned

    return owned(row)


def _source_event_row_matches_identity(
    row: Mapping[str, object],
    *,
    identity: CensusIdentity,
    source_account_label: str,
    target_account_label: str,
    canonical_decision_ids: set[str],
    canonical_execution_ids: set[str],
    canonical_order_ids: set[str] | None = None,
    canonical_client_order_ids: set[str] | None = None,
) -> bool:
    canonical_order_ids = canonical_order_ids or set()
    canonical_client_order_ids = canonical_client_order_ids or set()
    account_label = _row_account_label(row)
    if account_label in (None, target_account_label):
        return True
    if (
        account_label != source_account_label
        or source_account_label == target_account_label
    ):
        return False
    if _row_ref_matches(row, "trade_decision_id", canonical_decision_ids):
        return True
    if _row_ref_matches(row, "decision_id", canonical_decision_ids):
        return True
    if _row_ref_matches(row, "execution_id", canonical_execution_ids):
        return True
    if _row_has_any_ref(row, "trade_decision_id", "decision_id", "execution_id"):
        return False
    if _row_ref_matches(row, "alpaca_order_id", canonical_order_ids):
        return True
    if _row_ref_matches(row, "client_order_id", canonical_client_order_ids):
        return True
    if _row_has_any_ref(row, "alpaca_order_id", "client_order_id"):
        return False
    return False


def _source_window_row_matches_identity(
    row: Mapping[str, object],
    *,
    identity: CensusIdentity,
    source_account_label: str,
    target_account_label: str,
    canonical_source_window_ids: set[str],
) -> bool:
    account_label = _row_account_label(row)
    if account_label in (None, target_account_label):
        return True
    if (
        account_label != source_account_label
        or source_account_label == target_account_label
    ):
        return False
    if _row_ref_matches(row, "id", canonical_source_window_ids):
        return True
    if _row_ref_matches(row, "source_window_id", canonical_source_window_ids):
        return True
    if _row_has_any_ref(row, "id", "source_window_id"):
        return False
    return False


def _ledger_row_matches_identity(
    row: Mapping[str, object],
    identity: CensusIdentity,
) -> bool:
    return (
        _text(row.get("candidate_id")) in (None, identity.candidate_id)
        and _text(row.get("hypothesis_id")) in (None, identity.hypothesis_id)
        and _text(row.get("runtime_strategy_name"))
        in (None, identity.runtime_strategy_name)
        and _text(row.get("account_label")) in (None, identity.account_label)
        and _text(row.get("observed_stage")) in (None, identity.observed_stage)
    )


def _row_account_label(row: Mapping[str, object]) -> str | None:
    return _text(row.get("alpaca_account_label")) or _text(row.get("account_label"))


def _row_ids(rows: Sequence[Mapping[str, object]]) -> set[str]:
    return {row_id for row in rows if (row_id := _text(row.get("id"))) is not None}


def _row_text_values(rows: Sequence[Mapping[str, object]], key: str) -> set[str]:
    return {value for row in rows if (value := _text(row.get(key))) is not None}


def _optional_row_ref_matches(
    row: Mapping[str, object],
    key: str,
    candidates: set[str],
) -> bool:
    value = _text(row.get(key))
    return value is None or not candidates or value in candidates


def _row_ref_matches(
    row: Mapping[str, object],
    key: str,
    candidates: set[str],
) -> bool:
    value = _text(row.get(key))
    return value is not None and value in candidates


def _row_has_any_ref(row: Mapping[str, object], *keys: str) -> bool:
    return any(_text(row.get(key)) is not None for key in keys)


def _source_event_ref_diagnostics(
    events: Sequence[Mapping[str, object]],
    *,
    executions: Sequence[Mapping[str, object]],
    trade_decisions: Sequence[Mapping[str, object]],
) -> dict[str, int]:
    execution_ids = _row_ids(executions)
    decision_ids = _row_ids(trade_decisions)
    execution_decision_ids = _unique_row_value_map(
        executions, key="id", value_key="trade_decision_id"
    )
    execution_ids_by_order_id = _unique_row_value_map(
        executions, key="alpaca_order_id", value_key="id"
    )
    execution_ids_by_client_order_id = _unique_row_value_map(
        executions, key="client_order_id", value_key="id"
    )
    decisions_by_client_order_id = _unique_row_value_map(
        trade_decisions, key="decision_hash", value_key="id"
    )
    diagnostics = {
        "direct_execution_ref_count": 0,
        "direct_trade_decision_ref_count": 0,
        "effective_execution_ref_count": 0,
        "effective_trade_decision_ref_count": 0,
        "broker_order_link_count": 0,
        "client_order_link_count": 0,
    }
    for row in events:
        direct_execution_id = _text(row.get("execution_id"))
        direct_decision_id = _text(row.get("trade_decision_id")) or _text(
            row.get("decision_id")
        )
        linked_execution_id = _linked_execution_id(
            row,
            execution_ids_by_order_id=execution_ids_by_order_id,
            execution_ids_by_client_order_id=execution_ids_by_client_order_id,
        )
        linked_decision_id = (
            execution_decision_ids.get(linked_execution_id)
            if linked_execution_id is not None
            else None
        )
        client_decision_id = decisions_by_client_order_id.get(
            _text(row.get("client_order_id")) or ""
        )
        if direct_execution_id is not None:
            diagnostics["direct_execution_ref_count"] += 1
        if direct_decision_id is not None:
            diagnostics["direct_trade_decision_ref_count"] += 1
        if _row_ref_matches(row, "alpaca_order_id", set(execution_ids_by_order_id)):
            diagnostics["broker_order_link_count"] += 1
        if _row_ref_matches(
            row, "client_order_id", set(execution_ids_by_client_order_id)
        ) or _row_ref_matches(
            row, "client_order_id", set(decisions_by_client_order_id)
        ):
            diagnostics["client_order_link_count"] += 1
        if (
            direct_execution_id is not None
            and (not execution_ids or direct_execution_id in execution_ids)
        ) or linked_execution_id is not None:
            diagnostics["effective_execution_ref_count"] += 1
        if (
            (
                direct_decision_id is not None
                and (not decision_ids or direct_decision_id in decision_ids)
            )
            or (
                linked_decision_id is not None
                and (not decision_ids or linked_decision_id in decision_ids)
            )
            or (
                client_decision_id is not None
                and (not decision_ids or client_decision_id in decision_ids)
            )
        ):
            diagnostics["effective_trade_decision_ref_count"] += 1
    return diagnostics


def _effective_linked_order_event_fill_count(
    events: Sequence[Mapping[str, object]],
    *,
    executions: Sequence[Mapping[str, object]],
    trade_decisions: Sequence[Mapping[str, object]],
) -> int:
    count = 0
    for row in events:
        ref_diagnostics = _source_event_ref_diagnostics(
            [row], executions=executions, trade_decisions=trade_decisions
        )
        if (
            _fill_event(row)
            and ref_diagnostics["effective_execution_ref_count"] == 1
            and ref_diagnostics["effective_trade_decision_ref_count"] == 1
            and _text(row.get("source_window_id")) is not None
            and _event_source_offset_present(row)
            and _event_quantity_present(row)
            and _decimal(row.get("avg_fill_price")) > 0
            and _decimal(row.get("filled_notional_delta")) > 0
        ):
            count += 1
    return count


def _linked_execution_id(
    row: Mapping[str, object],
    *,
    execution_ids_by_order_id: Mapping[str, str],
    execution_ids_by_client_order_id: Mapping[str, str],
) -> str | None:
    alpaca_order_id = _text(row.get("alpaca_order_id"))
    if alpaca_order_id is not None:
        execution_id = execution_ids_by_order_id.get(alpaca_order_id)
        if execution_id is not None:
            return execution_id
    client_order_id = _text(row.get("client_order_id"))
    if client_order_id is not None:
        return execution_ids_by_client_order_id.get(client_order_id)
    return None


def _unique_row_value_map(
    rows: Sequence[Mapping[str, object]],
    *,
    key: str,
    value_key: str,
) -> dict[str, str]:
    values_by_key: dict[str, set[str]] = {}
    for row in rows:
        map_key = _text(row.get(key))
        map_value = _text(row.get(value_key))
        if map_key is None or map_value is None:
            continue
        values_by_key.setdefault(map_key, set()).add(map_value)
    return {
        map_key: next(iter(map_values))
        for map_key, map_values in values_by_key.items()
        if len(map_values) == 1
    }


def _source_account_event_scope_diagnostics(
    rows: Sequence[Mapping[str, object]],
    *,
    source_account_label: str,
    target_account_label: str,
    canonical_decision_ids: set[str],
    canonical_execution_ids: set[str],
    canonical_order_ids: set[str],
    canonical_client_order_ids: set[str],
) -> dict[str, int]:
    diagnostics = {"alias_only_count": 0, "canonical_ref_mismatch_count": 0}
    if source_account_label == target_account_label:
        return diagnostics
    for row in rows:
        if _row_account_label(row) != source_account_label:
            continue
        has_matching_ref = (
            _row_ref_matches(row, "trade_decision_id", canonical_decision_ids)
            or _row_ref_matches(row, "decision_id", canonical_decision_ids)
            or _row_ref_matches(row, "execution_id", canonical_execution_ids)
            or _row_ref_matches(row, "alpaca_order_id", canonical_order_ids)
            or _row_ref_matches(row, "client_order_id", canonical_client_order_ids)
        )
        has_any_supported_ref = _row_has_any_ref(
            row,
            "trade_decision_id",
            "decision_id",
            "execution_id",
            "alpaca_order_id",
            "client_order_id",
        )
        if _source_event_has_canonical_ref_mismatch(
            row,
            canonical_decision_ids=canonical_decision_ids,
            canonical_execution_ids=canonical_execution_ids,
            canonical_order_ids=canonical_order_ids,
            canonical_client_order_ids=canonical_client_order_ids,
        ):
            diagnostics["canonical_ref_mismatch_count"] += 1
        elif (
            not has_matching_ref
            and not has_any_supported_ref
            and _row_aliases_target_account(row, target_account_label)
        ):
            diagnostics["alias_only_count"] += 1
    return diagnostics


def _source_account_window_scope_diagnostics(
    rows: Sequence[Mapping[str, object]],
    *,
    source_account_label: str,
    target_account_label: str,
    canonical_source_window_ids: set[str],
) -> dict[str, int]:
    diagnostics = {"alias_only_count": 0, "canonical_ref_mismatch_count": 0}
    if source_account_label == target_account_label:
        return diagnostics
    for row in rows:
        if _row_account_label(row) != source_account_label:
            continue
        has_matching_ref = _row_ref_matches(
            row, "id", canonical_source_window_ids
        ) or _row_ref_matches(row, "source_window_id", canonical_source_window_ids)
        has_any_supported_ref = _row_has_any_ref(row, "id", "source_window_id")
        if _source_window_has_canonical_ref_mismatch(
            row, canonical_source_window_ids=canonical_source_window_ids
        ):
            diagnostics["canonical_ref_mismatch_count"] += 1
        elif (
            not has_matching_ref
            and not has_any_supported_ref
            and _row_aliases_target_account(row, target_account_label)
        ):
            diagnostics["alias_only_count"] += 1
    return diagnostics


def _source_event_has_canonical_ref_mismatch(
    row: Mapping[str, object],
    *,
    canonical_decision_ids: set[str],
    canonical_execution_ids: set[str],
    canonical_order_ids: set[str],
    canonical_client_order_ids: set[str],
) -> bool:
    return (
        _row_ref_mismatches(row, "trade_decision_id", canonical_decision_ids)
        or _row_ref_mismatches(row, "decision_id", canonical_decision_ids)
        or _row_ref_mismatches(row, "execution_id", canonical_execution_ids)
        or _row_ref_mismatches(row, "alpaca_order_id", canonical_order_ids)
        or _row_ref_mismatches(row, "client_order_id", canonical_client_order_ids)
    )


def _source_window_has_canonical_ref_mismatch(
    row: Mapping[str, object],
    *,
    canonical_source_window_ids: set[str],
) -> bool:
    return _row_ref_mismatches(
        row, "id", canonical_source_window_ids
    ) or _row_ref_mismatches(row, "source_window_id", canonical_source_window_ids)


def _row_ref_mismatches(
    row: Mapping[str, object],
    key: str,
    candidates: set[str],
) -> bool:
    value = _text(row.get(key))
    return value is not None and value not in candidates


def _payload_identifier_values(
    rows: Sequence[Mapping[str, object]],
    *keys: str,
) -> set[str]:
    values: set[str] = set()
    for row in rows:
        payload = _mapping(row.get("payload"))
        for source in (row, payload):
            for key in keys:
                values.update(_text_values(source.get(key)))
    return values


def _text_values(value: object) -> set[str]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return {item_text for item in value if (item_text := _text(item)) is not None}
    text = _text(value)
    if text is not None:
        return {text}
    return set()


def _row_aliases_target_account(
    row: Mapping[str, object],
    target_account_label: str,
) -> bool:
    return _mapping_aliases_target(row, target_account_label, alias_context=False)


def _mapping_aliases_target(
    payload: Mapping[str, object],
    target_account_label: str,
    *,
    alias_context: bool,
) -> bool:
    for key, value in payload.items():
        normalized_key = str(key).lower()
        next_alias_context = alias_context or any(
            marker in normalized_key
            for marker in (
                "alias",
                "canonical",
                "logical",
                "materialized",
                "target_account",
            )
        )
        if next_alias_context and _value_mentions_text(value, target_account_label):
            return True
        if isinstance(value, Mapping) and _mapping_aliases_target(
            value,
            target_account_label,
            alias_context=next_alias_context,
        ):
            return True
        if isinstance(value, Sequence) and not isinstance(
            value, (str, bytes, bytearray)
        ):
            for item in value:
                if isinstance(item, Mapping) and _mapping_aliases_target(
                    item,
                    target_account_label,
                    alias_context=next_alias_context,
                ):
                    return True
    return False


def _value_mentions_text(value: object, expected: str) -> bool:
    if _text(value) == expected:
        return True
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return any(_text(item) == expected for item in value)
    if isinstance(value, Mapping):
        return any(_value_mentions_text(item, expected) for item in value.values())
    return False


def _daily_census(
    rows: CensusSourceRows, ledger_report: Mapping[str, object]
) -> list[dict[str, object]]:
    days = sorted(
        {
            *_row_days(rows.trade_decisions, "created_at"),
            *_row_days(rows.executions, "created_at"),
            *_row_days(
                rows.execution_order_events, "event_ts", fallback_key="created_at"
            ),
            *_row_days(rows.execution_tca_metrics, "computed_at"),
            *_row_days(rows.order_feed_source_windows, "window_started_at"),
            *_ledger_days(ledger_report),
        }
    )
    return [_daily_payload(day, rows, ledger_report) for day in days]


def _daily_payload(
    day: str, rows: CensusSourceRows, ledger_report: Mapping[str, object]
) -> dict[str, object]:
    day_ledgers = [
        _mapping(item) for item in _sequence(ledger_report.get("trading_days"))
    ]
    ledger_by_day = {str(item.get("trading_day")): item for item in day_ledgers}
    ledger = ledger_by_day.get(day, {})
    day_executions = _rows_on_day(rows.executions, day, "created_at")
    day_events = _rows_on_day(
        rows.execution_order_events, day, "event_ts", fallback_key="created_at"
    )
    day_tca_metrics = _rows_on_day(rows.execution_tca_metrics, day, "computed_at")
    event_ref_diagnostics = _source_event_ref_diagnostics(
        day_events,
        executions=rows.executions,
        trade_decisions=rows.trade_decisions,
    )
    return {
        "trading_day": day,
        "trade_decision_count": len(
            _rows_on_day(rows.trade_decisions, day, "created_at")
        ),
        "execution_count": len(day_executions),
        "filled_execution_count": sum(
            1 for row in day_executions if _filled_execution(row)
        ),
        "execution_order_event_count": len(day_events),
        "fill_lifecycle_event_count": sum(1 for row in day_events if _fill_event(row)),
        "linked_order_event_fill_count": _effective_linked_order_event_fill_count(
            day_events,
            executions=rows.executions,
            trade_decisions=rows.trade_decisions,
        ),
        "execution_order_events_with_execution_ref_count": event_ref_diagnostics[
            "effective_execution_ref_count"
        ],
        "execution_order_events_with_direct_execution_ref_count": event_ref_diagnostics[
            "direct_execution_ref_count"
        ],
        "execution_order_events_with_trade_decision_ref_count": event_ref_diagnostics[
            "effective_trade_decision_ref_count"
        ],
        "execution_order_events_with_direct_trade_decision_ref_count": event_ref_diagnostics[
            "direct_trade_decision_ref_count"
        ],
        "execution_order_events_with_broker_order_link_count": event_ref_diagnostics[
            "broker_order_link_count"
        ],
        "execution_order_events_with_client_order_link_count": event_ref_diagnostics[
            "client_order_link_count"
        ],
        "execution_order_events_with_filled_notional_delta_count": sum(
            1 for row in day_events if _decimal(row.get("filled_notional_delta")) > 0
        ),
        "execution_order_events_with_quantity_count": sum(
            1 for row in day_events if _event_quantity_present(row)
        ),
        "execution_order_events_with_avg_price_count": sum(
            1 for row in day_events if _decimal(row.get("avg_fill_price")) > 0
        ),
        "tca_cost_row_count": len(day_tca_metrics),
        "tca_cost_rows_with_execution_ref_count": sum(
            1 for row in day_tca_metrics if _text(row.get("execution_id")) is not None
        ),
        "tca_cost_rows_with_trade_decision_ref_count": sum(
            1
            for row in day_tca_metrics
            if _text(row.get("trade_decision_id")) is not None
        ),
        "source_window_count": len(
            _rows_on_day(rows.order_feed_source_windows, day, "window_started_at")
        ),
        "execution_order_events_with_source_window_count": sum(
            1 for row in day_events if _text(row.get("source_window_id")) is not None
        ),
        "execution_order_events_with_source_offset_count": sum(
            1 for row in day_events if _event_source_offset_present(row)
        ),
        "runtime_ledger_bucket_count": _int(ledger.get("bucket_count")),
        "blocker_free_runtime_ledger_bucket_count": _int(
            ledger.get("source_authority_bucket_count")
        ),
        "explicit_cost_runtime_ledger_bucket_count": _int(
            ledger.get("explicit_cost_bucket_count")
        ),
        "closed_trade_count": _int(ledger.get("closed_trade_count")),
        "open_position_count": _int(ledger.get("open_position_count")),
        "filled_notional": _decimal_text(_decimal(ledger.get("filled_notional"))),
        "post_cost_pnl": _decimal_text(
            _decimal(ledger.get("net_strategy_pnl_after_costs"))
        ),
        "blockers": sorted(str(item) for item in _sequence(ledger.get("blockers"))),
    }
