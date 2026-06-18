"""Source decision and mode helpers for runtime window imports."""

from __future__ import annotations

from typing import Mapping, Sequence

from app.trading.runtime_decision_authority import (
    normalize_source_decision_mode,
    source_decision_mode_counts_have_non_profit_proof_modes,
    source_decision_mode_counts_have_profit_proof_modes,
)

from .parsers import as_mapping, bool_value, text_or_none

SOURCE_LINEAGE_CANDIDATE_KEYS = (
    "candidate_id",
    "candidate_ids",
    "strategy_candidate_id",
    "strategy_candidate_ids",
    "source_candidate_id",
    "source_candidate_ids",
)
SOURCE_LINEAGE_HYPOTHESIS_KEYS = (
    "hypothesis_id",
    "hypothesis_ids",
    "strategy_hypothesis_id",
    "strategy_hypothesis_ids",
    "source_hypothesis_id",
    "source_hypothesis_ids",
)
SOURCE_DECISION_MODE_MISSING_PARTITION = "source_decision_mode_missing"
_SOURCE_DECISION_PRIORITY_PAYLOAD_KEYS = (
    "paper_route_target_plan_source_decision",
    "paper_route_target_plan",
    "paper_route_target",
)


def source_decision_priority_payloads(
    row: Mapping[str, object],
) -> list[Mapping[str, object]]:
    """Extract priority payloads from a decision row."""
    payloads: list[Mapping[str, object]] = [row]
    decision_json = as_mapping(row.get("decision_json"))
    if decision_json:
        payloads.append(decision_json)
        params = as_mapping(decision_json.get("params"))
        if params:
            payloads.append(params)
        for key in _SOURCE_DECISION_PRIORITY_PAYLOAD_KEYS:
            if nested := as_mapping(decision_json.get(key)):
                payloads.append(nested)
        if params:
            for key in _SOURCE_DECISION_PRIORITY_PAYLOAD_KEYS:
                if nested := as_mapping(params.get(key)):
                    payloads.append(nested)
    return payloads


def source_decision_mode(row: Mapping[str, object]) -> str | None:
    """Extract and normalize source decision mode from row."""
    for payload in source_decision_priority_payloads(row):
        explicit = normalize_source_decision_mode(
            text_or_none(payload.get("source_decision_mode"))
        )
        if explicit is not None:
            return explicit
    explicit = normalize_source_decision_mode(text_or_none(as_mapping(row.get("mode"))))
    if explicit is not None:
        return explicit
    return normalize_source_decision_mode(row.get("mode"))


def source_decision_profit_proof_flag(row: Mapping[str, object]) -> bool | None:
    """Check if source decision is profit proof eligible."""
    for payload in source_decision_priority_payloads(row):
        value = bool_value(payload.get("profit_proof_eligible"))
        if value is not None:
            return value
        value = bool_value(payload.get("post_cost_promotion_eligible"))
        if value is not None:
            return value
    value = bool_value(row.get("profit_proof_eligible"))
    if value is not None:
        return value
    value = bool_value(row.get("post_cost_promotion_eligible"))
    if value is not None:
        return value
    return None


def source_row_matches_lineage(
    row: Mapping[str, object],
    *,
    candidate_id: str | None,
    hypothesis_id: str | None,
    require_source_lineage: bool,
) -> bool:
    """Check if row matches source lineage constraints."""
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


def source_row_lineage_missing_or_matches(
    row: Mapping[str, object],
    *,
    candidate_id: str | None,
    hypothesis_id: str | None,
) -> bool:
    """Check if lineage is missing or matches."""
    if candidate_id is not None:
        candidate_values = _text_values(row, *SOURCE_LINEAGE_CANDIDATE_KEYS)
        if candidate_values and candidate_id not in candidate_values:
            return False
    if hypothesis_id is not None:
        hypothesis_values = _text_values(row, *SOURCE_LINEAGE_HYPOTHESIS_KEYS)
        if hypothesis_values and hypothesis_id not in hypothesis_values:
            return False
    return True


def source_row_is_paper_route_probe_exit(row: Mapping[str, object]) -> bool:
    """Check if a source row is a paper route probe exit."""
    if bool_value(
        row.get("post_window_closeout")
        or row.get("runtime_ledger_post_window_closeout")
    ):
        return True
    for payload in source_decision_priority_payloads(row):
        metadata = as_mapping(payload.get("paper_route_probe_exit"))
        if text_or_none(metadata.get("mode")) == "paper_route_exit":
            return True
    return False


def source_decision_identifier_values(row: Mapping[str, object]) -> set[str]:
    """Extract decision identifiers from row."""
    return set(
        text_or_none(row.get(key))
        for key in ("trade_decision_id", "decision_id", "decision_hash")
        if text_or_none(row.get(key))
    )


def paper_route_probe_exit_identifiers(
    rows: Sequence[Mapping[str, object]],
) -> set[str]:
    """Extract paper route probe exit identifiers from rows."""
    identifiers: set[str] = set()
    for row in rows:
        if source_row_is_paper_route_probe_exit(row):
            identifiers.update(source_decision_identifier_values(row))
    return identifiers


def source_row_is_paper_route_probe_exit_or_linked(
    row: Mapping[str, object],
    *,
    paper_route_probe_exit_identifiers: set[str],
) -> bool:
    """Check if row is a paper route probe exit or linked to one."""
    if source_row_is_paper_route_probe_exit(row):
        return True
    return bool(
        source_decision_identifier_values(row) & paper_route_probe_exit_identifiers
    )


def source_decision_mode_counts(
    rows: Sequence[Mapping[str, object]],
) -> dict[str, int]:
    """Count decision modes in rows."""
    counts: dict[str, int] = {}
    paper_route_identifiers = paper_route_probe_exit_identifiers(rows)
    for row in rows:
        if source_row_is_paper_route_probe_exit_or_linked(
            row,
            paper_route_probe_exit_identifiers=paper_route_identifiers,
        ):
            continue
        mode = source_decision_mode(row)
        if mode is None:
            continue
        counts[mode] = counts.get(mode, 0) + 1
    return dict(sorted(counts.items()))


def source_decision_mode_lookup(
    rows: Sequence[Mapping[str, object]],
) -> dict[str, str]:
    """Build lookup of identifiers to decision modes."""
    modes_by_identifier: dict[str, str] = {}
    conflicting_identifiers: set[str] = set()
    for row in rows:
        mode = source_decision_mode(row)
        if mode is None:
            continue
        for identifier in source_decision_identifier_values(row):
            existing = modes_by_identifier.get(identifier)
            if existing is not None and existing != mode:
                conflicting_identifiers.add(identifier)
                continue
            modes_by_identifier[identifier] = mode
    for identifier in conflicting_identifiers:
        modes_by_identifier.pop(identifier, None)
    return modes_by_identifier


def source_decision_mode_partition_key(
    row: Mapping[str, object],
    *,
    modes_by_identifier: Mapping[str, str],
) -> str:
    """Determine partition key for a source row."""
    explicit = source_decision_mode(row)
    if explicit is not None:
        return explicit
    inferred_modes = {
        modes_by_identifier[identifier]
        for identifier in source_decision_identifier_values(row)
        if identifier in modes_by_identifier
    }
    if len(inferred_modes) == 1:
        return next(iter(inferred_modes))
    return SOURCE_DECISION_MODE_MISSING_PARTITION


def source_decision_rows_profit_proof_eligible(
    rows: Sequence[Mapping[str, object]],
) -> bool:
    """Check if source decision rows are profit proof eligible."""
    modes = source_decision_mode_counts(rows)
    if source_decision_mode_counts_have_non_profit_proof_modes(modes):
        return False
    explicit: list[bool] = []
    paper_route_identifiers = paper_route_probe_exit_identifiers(rows)
    for row in rows:
        if source_row_is_paper_route_probe_exit_or_linked(
            row,
            paper_route_probe_exit_identifiers=paper_route_identifiers,
        ):
            continue
        value = source_decision_profit_proof_flag(row)
        if value is not None:
            explicit.append(value)
    if any(value is False for value in explicit):
        return False
    return source_decision_mode_counts_have_profit_proof_modes(modes) or any(
        value is True for value in explicit
    )


def _text_values(row: Mapping[str, object], *keys: str) -> set[str]:
    """Extract text values from row for multiple keys."""
    values: set[str] = set()
    for payload in [row]:
        for key in keys:
            raw_value = payload.get(key)
            row_values: list[str] = []
            if isinstance(raw_value, Sequence) and not isinstance(
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
                values.update(row_values)
                break
    return values
