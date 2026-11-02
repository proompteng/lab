from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Mapping, Sequence

from app.trading.runtime_decision_authority import (
    normalize_source_decision_mode,
    source_decision_mode_counts_have_non_profit_proof_modes,
    source_decision_mode_counts_have_profit_proof_modes,
    source_decision_mode_is_profit_proof_eligible,
)
from scripts.hypothesis_runtime_window_import.common import (
    _as_mapping,
    _direct_bool,
    _direct_text,
    _execution_row_has_fill,
    _execution_signed_qty,
    _first_bool,
    _first_positive_decimal,
    _first_text,
    _metadata_text_list,
    _runtime_ledger_event_type,
    _runtime_ledger_row_time,
    _runtime_source_row_symbol,
    _source_authority_order_event_row,
    _source_identifier_values,
    _text_or_none,
    _text_values,
)
from scripts.hypothesis_runtime_window_import.constants import (
    RUNTIME_LEDGER_POST_WINDOW_CLOSEOUT_LOOKAHEAD,
    SOURCE_DECISION_MODE_MISSING_PARTITION,
    SOURCE_LINEAGE_CANDIDATE_KEYS,
    SOURCE_LINEAGE_HYPOTHESIS_KEYS,
    _RUNTIME_LEDGER_FILL_EVENTS,
)
from scripts.hypothesis_runtime_window_import.source_windows import (
    _execution_query_row_has_tca_ref,
)


def _source_decision_priority_payloads(
    row: Mapping[str, object],
) -> list[Mapping[str, object]]:
    payloads: list[Mapping[str, object]] = [row]
    decision_json = _as_mapping(row.get("decision_json"))
    if decision_json:
        payloads.append(decision_json)
        params = _as_mapping(decision_json.get("params"))
        if params:
            payloads.append(params)
        for key in (
            "strategy_signal_paper",
            "paper_route_target_plan_source_decision",
            "paper_route_target_plan",
            "paper_route_target",
        ):
            if nested := _as_mapping(decision_json.get(key)):
                payloads.append(nested)
        if params:
            for key in (
                "strategy_signal_paper",
                "paper_route_target_plan_source_decision",
                "paper_route_target_plan",
                "paper_route_target",
            ):
                if nested := _as_mapping(params.get(key)):
                    payloads.append(nested)
    return payloads


def _source_decision_mode(row: Mapping[str, object]) -> str | None:
    for payload in _source_decision_priority_payloads(row):
        explicit = normalize_source_decision_mode(
            _direct_text(payload, "source_decision_mode")
        )
        if explicit is not None:
            return explicit
    explicit = normalize_source_decision_mode(_first_text(row, "source_decision_mode"))
    if explicit is not None:
        return explicit
    return normalize_source_decision_mode(row.get("mode"))


def _source_decision_profit_proof_flag(row: Mapping[str, object]) -> bool | None:
    for payload in _source_decision_priority_payloads(row):
        value = _direct_bool(
            payload,
            "profit_proof_eligible",
            "post_cost_promotion_eligible",
        )
        if value is not None:
            return value
    return _first_bool(row, "profit_proof_eligible", "post_cost_promotion_eligible")


def _source_decision_target_notional_sizing_audit(
    row: Mapping[str, object],
) -> dict[str, object] | None:
    for payload in _source_decision_priority_payloads(row):
        audit = _as_mapping(payload.get("paper_route_target_notional_sizing"))
        if audit:
            return {str(key): value for key, value in audit.items()}
        simple_lane = _as_mapping(payload.get("simple_lane"))
        audit = _as_mapping(simple_lane.get("paper_route_target_notional_sizing"))
        if audit:
            return {str(key): value for key, value in audit.items()}
    return None


def _source_decision_target_notional_sizing_summary(
    rows: Sequence[Mapping[str, object]],
) -> dict[str, object]:
    source_row_count = len(rows)
    paper_route_probe_exit_identifiers = _paper_route_probe_exit_identifiers(rows)
    sizing_required_rows = [
        row
        for row in rows
        if not _source_row_is_paper_route_probe_exit_or_linked(
            row,
            paper_route_probe_exit_identifiers=paper_route_probe_exit_identifiers,
        )
    ]
    sizing_required_row_count = len(sizing_required_rows)
    audits: list[dict[str, object]] = []
    authoritative_count = 0
    non_authoritative_source_counts: dict[str, int] = {}
    blocker_counts: dict[str, int] = {}
    for row in sizing_required_rows:
        audit = _source_decision_target_notional_sizing_audit(row)
        if audit is None:
            continue
        audits.append(audit)
        sizing_source = _text_or_none(audit.get("sizing_source")) or "missing"
        if sizing_source == "target_notional":
            authoritative_count += 1
        else:
            non_authoritative_source_counts[sizing_source] = (
                non_authoritative_source_counts.get(sizing_source, 0) + 1
            )
        for blocker in _metadata_text_list(audit.get("blockers")):
            blocker_counts[blocker] = blocker_counts.get(blocker, 0) + 1

    mode_counts = _source_decision_mode_counts(rows)
    requires_target_notional_sizing = (
        bool(audits)
        or mode_counts.get("bounded_paper_route_collection", 0) > 0
        or any(
            _first_text(row, "paper_route_probe_target_notional", "target_notional")
            for row in sizing_required_rows
        )
    )
    missing_count = max(sizing_required_row_count - len(audits), 0)
    blockers: list[str] = []
    if requires_target_notional_sizing and missing_count:
        blockers.append("paper_route_target_notional_sizing_missing")
    if non_authoritative_source_counts:
        blockers.append("paper_route_target_notional_sizing_not_authoritative")
    blockers.extend(blocker_counts)
    return {
        "source_row_count": source_row_count,
        "target_notional_sizing_required_source_row_count": (sizing_required_row_count),
        "excluded_paper_route_probe_exit_row_count": (
            source_row_count - sizing_required_row_count
        ),
        "audit_count": len(audits),
        "authoritative_target_notional_sizing_count": authoritative_count,
        "missing_target_notional_sizing_count": (
            missing_count if requires_target_notional_sizing else 0
        ),
        "non_authoritative_sizing_source_counts": dict(
            sorted(non_authoritative_source_counts.items())
        ),
        "sizing_blocker_counts": dict(sorted(blocker_counts.items())),
        "requires_target_notional_sizing": requires_target_notional_sizing,
        "blockers": list(dict.fromkeys(blockers)),
    }


def _source_row_is_paper_route_probe_exit(row: Mapping[str, object]) -> bool:
    if _first_bool(row, "post_window_closeout", "runtime_ledger_post_window_closeout"):
        return True
    for payload in _source_decision_priority_payloads(row):
        metadata = _as_mapping(payload.get("paper_route_probe_exit"))
        if _direct_text(metadata, "mode") == "paper_route_exit":
            return True
    return False


def _source_decision_identifier_values(row: Mapping[str, object]) -> set[str]:
    return _text_values(
        row,
        "trade_decision_id",
        "decision_id",
        "decision_hash",
    )


def _paper_route_probe_exit_identifiers(
    rows: Sequence[Mapping[str, object]],
) -> set[str]:
    identifiers: set[str] = set()
    for row in rows:
        if _source_row_is_paper_route_probe_exit(row):
            identifiers.update(_source_decision_identifier_values(row))
    return identifiers


def _source_row_is_paper_route_probe_exit_or_linked(
    row: Mapping[str, object],
    *,
    paper_route_probe_exit_identifiers: set[str],
) -> bool:
    if _source_row_is_paper_route_probe_exit(row):
        return True
    return bool(
        _source_decision_identifier_values(row) & paper_route_probe_exit_identifiers
    )


def _source_decision_mode_counts(
    rows: Sequence[Mapping[str, object]],
) -> dict[str, int]:
    counts: dict[str, int] = {}
    paper_route_probe_exit_identifiers = _paper_route_probe_exit_identifiers(rows)
    for row in rows:
        if _source_row_is_paper_route_probe_exit_or_linked(
            row,
            paper_route_probe_exit_identifiers=paper_route_probe_exit_identifiers,
        ):
            continue
        mode = _source_decision_mode(row)
        if mode is None:
            continue
        counts[mode] = counts.get(mode, 0) + 1
    return dict(sorted(counts.items()))


def _source_decision_mode_lookup(
    rows: Sequence[Mapping[str, object]],
) -> dict[str, str]:
    modes_by_identifier: dict[str, str] = {}
    conflicting_identifiers: set[str] = set()
    for row in rows:
        mode = _source_decision_mode(row)
        if mode is None:
            continue
        for identifier in _source_decision_identifier_values(row):
            existing = modes_by_identifier.get(identifier)
            if existing is not None and existing != mode:
                conflicting_identifiers.add(identifier)
                continue
            modes_by_identifier[identifier] = mode
    for identifier in conflicting_identifiers:
        modes_by_identifier.pop(identifier, None)
    return modes_by_identifier


def _source_decision_mode_partition_key(
    row: Mapping[str, object],
    *,
    modes_by_identifier: Mapping[str, str],
) -> str:
    explicit = _source_decision_mode(row)
    if explicit is not None:
        return explicit
    inferred_modes = {
        modes_by_identifier[identifier]
        for identifier in _source_decision_identifier_values(row)
        if identifier in modes_by_identifier
    }
    if len(inferred_modes) == 1:
        return next(iter(inferred_modes))
    return SOURCE_DECISION_MODE_MISSING_PARTITION


def _partition_runtime_source_rows_by_decision_mode(
    *,
    execution_rows: list[dict[str, object]],
    decision_lifecycle_rows: list[dict[str, object]] | None,
    order_lifecycle_rows: list[dict[str, object]] | None,
    unlinked_order_lifecycle_rows: list[dict[str, object]] | None = None,
    carry_in_execution_rows: list[dict[str, object]] | None = None,
    carry_in_decision_lifecycle_rows: list[dict[str, object]] | None = None,
    carry_in_order_lifecycle_rows: list[dict[str, object]] | None = None,
) -> (
    list[
        tuple[
            str,
            list[dict[str, object]],
            list[dict[str, object]] | None,
            list[dict[str, object]] | None,
            list[dict[str, object]] | None,
            list[dict[str, object]] | None,
            list[dict[str, object]] | None,
            list[dict[str, object]] | None,
        ]
    ]
    | None
):
    current_source_rows: list[dict[str, object]] = [
        *execution_rows,
        *(decision_lifecycle_rows or []),
        *(order_lifecycle_rows or []),
        *(unlinked_order_lifecycle_rows or []),
    ]
    source_rows: list[dict[str, object]] = [
        *current_source_rows,
        *(carry_in_execution_rows or []),
        *(carry_in_decision_lifecycle_rows or []),
        *(carry_in_order_lifecycle_rows or []),
    ]
    if not source_rows:
        return None
    modes_by_identifier = _source_decision_mode_lookup(source_rows)
    paper_route_probe_exit_identifiers = _paper_route_probe_exit_identifiers(
        source_rows
    )
    partition_relevant_source_rows = [
        row
        for row in current_source_rows
        if not _source_row_is_paper_route_probe_exit_or_linked(
            row,
            paper_route_probe_exit_identifiers=paper_route_probe_exit_identifiers,
        )
    ]
    relevant_mode_keys = {
        _source_decision_mode_partition_key(
            row,
            modes_by_identifier=modes_by_identifier,
        )
        for row in partition_relevant_source_rows
    }
    if len(relevant_mode_keys) <= 1:
        return None
    mode_keys = {
        _source_decision_mode_partition_key(
            row,
            modes_by_identifier=modes_by_identifier,
        )
        for row in source_rows
    }

    partitions: list[
        tuple[
            str,
            list[dict[str, object]],
            list[dict[str, object]] | None,
            list[dict[str, object]] | None,
            list[dict[str, object]] | None,
            list[dict[str, object]] | None,
            list[dict[str, object]] | None,
            list[dict[str, object]] | None,
        ]
    ] = []
    for mode_key in sorted(mode_keys):
        partition_execution_rows = [
            row
            for row in execution_rows
            if _source_decision_mode_partition_key(
                row,
                modes_by_identifier=modes_by_identifier,
            )
            == mode_key
        ]
        partition_decision_rows = [
            row
            for row in decision_lifecycle_rows or []
            if _source_decision_mode_partition_key(
                row,
                modes_by_identifier=modes_by_identifier,
            )
            == mode_key
        ]
        partition_order_rows = [
            row
            for row in order_lifecycle_rows or []
            if _source_decision_mode_partition_key(
                row,
                modes_by_identifier=modes_by_identifier,
            )
            == mode_key
        ]
        partition_unlinked_order_rows = []
        for row in unlinked_order_lifecycle_rows or []:
            partition_key = _source_decision_mode_partition_key(
                row,
                modes_by_identifier=modes_by_identifier,
            )
            if partition_key == mode_key or (
                partition_key == SOURCE_DECISION_MODE_MISSING_PARTITION
                and mode_key != SOURCE_DECISION_MODE_MISSING_PARTITION
            ):
                partition_unlinked_order_rows.append(row)
        partition_carry_in_execution_rows = [
            row
            for row in carry_in_execution_rows or []
            if _source_decision_mode_partition_key(
                row,
                modes_by_identifier=modes_by_identifier,
            )
            == mode_key
        ]
        partition_carry_in_decision_rows = [
            row
            for row in carry_in_decision_lifecycle_rows or []
            if _source_decision_mode_partition_key(
                row,
                modes_by_identifier=modes_by_identifier,
            )
            == mode_key
        ]
        partition_carry_in_order_rows = [
            row
            for row in carry_in_order_lifecycle_rows or []
            if _source_decision_mode_partition_key(
                row,
                modes_by_identifier=modes_by_identifier,
            )
            == mode_key
        ]
        partitions.append(
            (
                mode_key,
                partition_execution_rows,
                partition_decision_rows or None,
                partition_order_rows or None,
                partition_unlinked_order_rows or None,
                partition_carry_in_execution_rows or None,
                partition_carry_in_decision_rows or None,
                partition_carry_in_order_rows or None,
            )
        )
    return partitions


def _source_decision_rows_profit_proof_eligible(
    rows: Sequence[Mapping[str, object]],
) -> bool:
    modes = _source_decision_mode_counts(rows)
    if source_decision_mode_counts_have_non_profit_proof_modes(modes):
        return False
    explicit: list[bool] = []
    paper_route_probe_exit_identifiers = _paper_route_probe_exit_identifiers(rows)
    for row in rows:
        if _source_row_is_paper_route_probe_exit_or_linked(
            row,
            paper_route_probe_exit_identifiers=paper_route_probe_exit_identifiers,
        ):
            continue
        value = _source_decision_profit_proof_flag(row)
        if value is not None:
            explicit.append(value)
    if any(value is False for value in explicit):
        return False
    return source_decision_mode_counts_have_profit_proof_modes(modes) or any(
        value is True for value in explicit
    )


def _source_row_matches_lineage(
    row: Mapping[str, object],
    *,
    candidate_id: str | None,
    hypothesis_id: str | None,
    require_source_lineage: bool,
) -> bool:
    if not require_source_lineage:
        return True
    if candidate_id is not None and candidate_id not in _text_values(
        row, *SOURCE_LINEAGE_CANDIDATE_KEYS
    ):
        return False
    if hypothesis_id is not None and hypothesis_id not in _text_values(
        row, *SOURCE_LINEAGE_HYPOTHESIS_KEYS
    ):
        return False
    return True


def _source_row_lineage_missing_or_matches(
    row: Mapping[str, object],
    *,
    candidate_id: str | None,
    hypothesis_id: str | None,
) -> bool:
    if candidate_id is not None:
        candidate_values = _text_values(row, *SOURCE_LINEAGE_CANDIDATE_KEYS)
        if candidate_values and candidate_id not in candidate_values:
            return False
    if hypothesis_id is not None:
        hypothesis_values = _text_values(row, *SOURCE_LINEAGE_HYPOTHESIS_KEYS)
        if hypothesis_values and hypothesis_id not in hypothesis_values:
            return False
    return True


def _source_row_time_before(
    row: Mapping[str, object],
    *,
    window_end: datetime,
) -> bool:
    event_time = _runtime_ledger_row_time(row)
    return event_time is None or event_time < window_end


def _source_row_time_after_window(
    row: Mapping[str, object],
    *,
    window_end: datetime,
    closeout_end: datetime,
) -> bool:
    event_time = _runtime_ledger_row_time(row)
    return (
        event_time is not None
        and event_time > window_end
        and event_time <= closeout_end
    )


def _runtime_open_qtys_by_symbol_from_execution_rows(
    rows: Sequence[Mapping[str, object]],
) -> dict[str, Decimal]:
    open_qtys: dict[str, Decimal] = {}
    for row in rows:
        if not _execution_row_has_fill(row):
            continue
        symbol = _runtime_source_row_symbol(row)
        if symbol is None:
            continue
        signed_qty = _execution_signed_qty(
            side=_first_text(row, "side", "action", "order_side"),
            qty=_first_positive_decimal(
                row,
                "filled_qty",
                "filled_quantity",
                "qty",
                "quantity",
            ),
        )
        if signed_qty == 0:
            continue
        open_qtys[symbol] = open_qtys.get(symbol, Decimal("0")) + signed_qty
    return {symbol: qty for symbol, qty in sorted(open_qtys.items()) if qty != 0}


def _source_decision_action_offsets_open_qty(
    row: Mapping[str, object],
    *,
    open_qtys: Mapping[str, Decimal],
) -> bool:
    symbol = _runtime_source_row_symbol(row)
    if symbol is None:
        return False
    open_qty = open_qtys.get(symbol, Decimal("0"))
    if open_qty == 0:
        return False
    action = (_first_text(row, "action", "side", "order_side") or "").lower()
    if open_qty > 0:
        return action in {"sell", "short", "sell_short"}
    return action in {"buy", "cover", "buy_to_cover"}


def _source_row_decision_ids(row: Mapping[str, object]) -> set[str]:
    return set(
        _source_identifier_values(
            [row],
            "trade_decision_id",
            "decision_id",
            "decision_hash",
        )
    )


def _source_row_execution_ids(row: Mapping[str, object]) -> set[str]:
    return set(_source_identifier_values([row], "execution_id"))


def _mark_post_window_closeout_source_row(
    row: Mapping[str, object],
) -> dict[str, object]:
    return {
        **dict(row),
        "post_window_closeout": True,
        "runtime_ledger_post_window_closeout": True,
        "runtime_ledger_closeout_reason": "post_window_fill_offsets_window_open_qty",
    }


def _filter_source_rows_for_runtime_window(
    *,
    decision_rows: list[dict[str, object]],
    execution_rows: list[dict[str, object]],
    order_lifecycle_rows: list[dict[str, object]],
    window_end: datetime,
    closeout_end: datetime,
    candidate_id: str | None,
    hypothesis_id: str | None,
    require_source_lineage: bool,
) -> tuple[
    list[dict[str, object]],
    list[dict[str, object]],
    list[dict[str, object]],
    dict[str, object],
]:
    lineaged_decision_rows = [
        row
        for row in decision_rows
        if _source_row_time_before(row, window_end=window_end)
        and _source_row_matches_lineage(
            row,
            candidate_id=candidate_id,
            hypothesis_id=hypothesis_id,
            require_source_lineage=require_source_lineage,
        )
    ]
    lineaged_execution_rows = [
        row
        for row in execution_rows
        if _source_row_time_before(row, window_end=window_end)
        and _source_row_matches_lineage(
            row,
            candidate_id=candidate_id,
            hypothesis_id=hypothesis_id,
            require_source_lineage=require_source_lineage,
        )
    ]
    lineaged_order_rows = [
        row
        for row in order_lifecycle_rows
        if _source_row_time_before(row, window_end=window_end)
        and _source_row_matches_lineage(
            row,
            candidate_id=candidate_id,
            hypothesis_id=hypothesis_id,
            require_source_lineage=require_source_lineage,
        )
    ]
    diagnostics: dict[str, object] = {
        "post_window_closeout_lookahead_seconds": int(
            RUNTIME_LEDGER_POST_WINDOW_CLOSEOUT_LOOKAHEAD.total_seconds()
        ),
        "post_window_closeout_query_end": closeout_end.isoformat(),
    }
    if closeout_end <= window_end:
        diagnostics.update(
            {
                "post_window_closeout_open_qty_by_symbol": {},
                "post_window_closeout_decision_count": 0,
                "post_window_closeout_execution_count": 0,
                "post_window_closeout_order_event_count": 0,
            }
        )
        return (
            lineaged_decision_rows,
            lineaged_execution_rows,
            lineaged_order_rows,
            diagnostics,
        )

    open_qtys = _runtime_open_qtys_by_symbol_from_execution_rows(
        lineaged_execution_rows
    )
    diagnostics["post_window_closeout_open_qty_by_symbol"] = {
        symbol: str(qty) for symbol, qty in open_qtys.items()
    }
    if not open_qtys:
        diagnostics.update(
            {
                "post_window_closeout_decision_count": 0,
                "post_window_closeout_execution_count": 0,
                "post_window_closeout_order_event_count": 0,
            }
        )
        return (
            lineaged_decision_rows,
            lineaged_execution_rows,
            lineaged_order_rows,
            diagnostics,
        )

    closeout_decision_rows = [
        row
        for row in decision_rows
        if _source_row_time_after_window(
            row,
            window_end=window_end,
            closeout_end=closeout_end,
        )
        and source_decision_mode_is_profit_proof_eligible(_source_decision_mode(row))
        and _source_row_lineage_missing_or_matches(
            row,
            candidate_id=candidate_id,
            hypothesis_id=hypothesis_id,
        )
        and _source_decision_action_offsets_open_qty(row, open_qtys=open_qtys)
    ]
    closeout_decision_ids = set[str]()
    for row in closeout_decision_rows:
        closeout_decision_ids.update(_source_row_decision_ids(row))
    if not closeout_decision_ids:
        diagnostics.update(
            {
                "post_window_closeout_decision_count": 0,
                "post_window_closeout_execution_count": 0,
                "post_window_closeout_order_event_count": 0,
            }
        )
        return (
            lineaged_decision_rows,
            lineaged_execution_rows,
            lineaged_order_rows,
            diagnostics,
        )

    closeout_execution_rows = [
        row
        for row in execution_rows
        if _source_row_time_after_window(
            row,
            window_end=window_end,
            closeout_end=closeout_end,
        )
        and _source_row_decision_ids(row) & closeout_decision_ids
        and _execution_row_has_fill(row)
        and _execution_query_row_has_tca_ref(row)
    ]
    closeout_execution_decision_ids = set[str]()
    closeout_execution_ids = set[str]()
    for row in closeout_execution_rows:
        closeout_execution_decision_ids.update(_source_row_decision_ids(row))
        closeout_execution_ids.update(_source_row_execution_ids(row))

    closeout_order_rows = [
        row
        for row in order_lifecycle_rows
        if _source_row_time_after_window(
            row,
            window_end=window_end,
            closeout_end=closeout_end,
        )
        and (
            _source_row_decision_ids(row) & closeout_decision_ids
            or _source_row_execution_ids(row) & closeout_execution_ids
        )
        and _source_authority_order_event_row(row)
    ]
    fill_order_decision_ids = set[str]()
    for row in closeout_order_rows:
        if _runtime_ledger_event_type(row) not in _RUNTIME_LEDGER_FILL_EVENTS:
            continue
        fill_order_decision_ids.update(_source_row_decision_ids(row))
        if _source_row_execution_ids(row) & closeout_execution_ids:
            fill_order_decision_ids.update(closeout_execution_decision_ids)

    eligible_decision_ids = (
        closeout_decision_ids
        & closeout_execution_decision_ids
        & fill_order_decision_ids
    )
    eligible_execution_ids = {
        execution_id
        for row in closeout_execution_rows
        if _source_row_decision_ids(row) & eligible_decision_ids
        for execution_id in _source_row_execution_ids(row)
    }
    eligible_closeout_decision_rows = [
        _mark_post_window_closeout_source_row(row)
        for row in closeout_decision_rows
        if _source_row_decision_ids(row) & eligible_decision_ids
    ]
    eligible_closeout_execution_rows = [
        _mark_post_window_closeout_source_row(row)
        for row in closeout_execution_rows
        if _source_row_decision_ids(row) & eligible_decision_ids
    ]
    eligible_closeout_order_rows = [
        _mark_post_window_closeout_source_row(row)
        for row in closeout_order_rows
        if (
            _source_row_decision_ids(row) & eligible_decision_ids
            or _source_row_execution_ids(row) & eligible_execution_ids
        )
    ]
    diagnostics.update(
        {
            "post_window_closeout_decision_count": len(eligible_closeout_decision_rows),
            "post_window_closeout_execution_count": len(
                eligible_closeout_execution_rows
            ),
            "post_window_closeout_order_event_count": len(eligible_closeout_order_rows),
        }
    )
    return (
        [*lineaged_decision_rows, *eligible_closeout_decision_rows],
        [*lineaged_execution_rows, *eligible_closeout_execution_rows],
        [*lineaged_order_rows, *eligible_closeout_order_rows],
        diagnostics,
    )


__all__ = [
    "_source_decision_priority_payloads",
    "_source_decision_mode",
    "_source_decision_profit_proof_flag",
    "_source_decision_target_notional_sizing_audit",
    "_source_decision_target_notional_sizing_summary",
    "_source_row_is_paper_route_probe_exit",
    "_source_decision_identifier_values",
    "_paper_route_probe_exit_identifiers",
    "_source_row_is_paper_route_probe_exit_or_linked",
    "_source_decision_mode_counts",
    "_source_decision_mode_lookup",
    "_source_decision_mode_partition_key",
    "_partition_runtime_source_rows_by_decision_mode",
    "_source_decision_rows_profit_proof_eligible",
    "_source_row_matches_lineage",
    "_source_row_lineage_missing_or_matches",
    "_source_row_time_before",
    "_source_row_time_after_window",
    "_runtime_open_qtys_by_symbol_from_execution_rows",
    "_source_decision_action_offsets_open_qty",
    "_source_row_decision_ids",
    "_source_row_execution_ids",
    "_mark_post_window_closeout_source_row",
    "_filter_source_rows_for_runtime_window",
]
