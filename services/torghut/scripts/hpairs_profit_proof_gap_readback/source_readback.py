#!/usr/bin/env python
"""Read-only H-PAIRS profit proof-gap readback CLI.

The command reads operator-provided endpoint URLs or fixture paths and emits one
machine-readable JSON payload that names the first remaining proof blocker.  It
never writes database rows, calls promotion endpoints, mutates Kubernetes, or
changes runtime configuration.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from decimal import Decimal, InvalidOperation
from typing import Any, cast

from .profit_gap_core import (
    DAILY_COLLECTION_KEYS,
    NET_PNL_KEYS,
    SOURCE_MISSING_WORDS,
    SOURCE_REF_KEYS,
    SOURCE_WINDOW_KEYS,
    main,
)


def _first_positive_source_row_count(
    payloads: Sequence[Mapping[str, Any]], keys: Sequence[str]
) -> int | None:
    for payload in payloads:
        total = sum(_source_row_count(payload, key) for key in keys)
        if total > 0:
            return total
    return None


def _first_positive_key_count(
    payloads: Sequence[Mapping[str, Any]], keys: Sequence[str]
) -> int | None:
    for payload in payloads:
        for key, value in _walk_items(payload):
            if key not in keys:
                continue
            if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
                if len(value) > 0:
                    return len(value)
                continue
            parsed = _int_or_none(value)
            if parsed is not None and parsed > 0:
                return parsed
    return None


def _source_ref_observation_count(payload: Mapping[str, Any]) -> int:
    return (
        _first_positive_key_count((payload,), SOURCE_REF_KEYS)
        or _source_row_count(payload, "executions")
        or _source_row_count(payload, "trade_decisions")
        or 0
    )


def _source_window_observation_count(payload: Mapping[str, Any]) -> int:
    return (
        _first_positive_key_count((payload,), SOURCE_WINDOW_KEYS)
        or _source_row_count(payload, "order_feed_source_windows")
        or 0
    )


def _has_order_lifecycle_rows(payload: Mapping[str, Any]) -> bool:
    if not payload:
        return False
    return (
        _source_row_count(payload, "execution_order_events") > 0
        and _source_row_count(payload, "trade_decisions") > 0
        and _source_row_count(payload, "executions") > 0
    )


def _has_execution_economics_rows(payload: Mapping[str, Any]) -> bool:
    if not payload:
        return False
    if _source_row_count(payload, "execution_tca_metrics") > 0:
        return True
    return _decimal(payload.get("cost_amount")) is not None


def _has_positive_key(payload: Mapping[str, Any], keys: Sequence[str]) -> bool:
    for key, value in _walk_items(payload):
        if key in keys:
            if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
                return len(value) > 0
            integer = _int_or_none(value)
            if integer is not None:
                return integer > 0
            if value:
                return True
    return False


def _source_row_count(payload: Mapping[str, Any], key: str) -> int:
    value = _mapping(payload.get("source_row_counts")).get(key)
    parsed = _int_or_none(value)
    return parsed if parsed is not None else 0


def _daily_net_pnls(payloads: Sequence[Mapping[str, Any]]) -> list[Decimal]:
    values: list[Decimal] = []
    for payload in payloads:
        for key, value in _walk_items(payload):
            if (
                key in DAILY_COLLECTION_KEYS
                and isinstance(value, Sequence)
                and not isinstance(value, (str, bytes))
            ):
                for item in value:
                    if isinstance(item, Mapping):
                        number = _first_decimal_at_keys(
                            [cast(Mapping[str, Any], item)], NET_PNL_KEYS
                        )
                    else:
                        number = _decimal(item)
                    if number is not None:
                        values.append(number)
            elif key in NET_PNL_KEYS and not isinstance(value, (Mapping, list, tuple)):
                # Single aggregate PnL values are used only when explicitly named daily.
                if "daily" in key:
                    number = _decimal(value)
                    if number is not None:
                        values.append(number)
    return values


def _reported_blockers(*payloads: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    for payload in payloads:
        for key, value in _walk_items(payload):
            if key in {
                "blockers",
                "authority_blockers",
                "blocking_reasons",
                "candidate_blockers",
                "final_promotion_blockers",
                "proof_blockers",
                "failed_checks",
                "runtime_ledger_target_metadata_blockers",
            }:
                blockers.extend(_text_list(value))
    return _stable_texts(blockers)


def _source_missing_blockers(blockers: Sequence[str]) -> list[str]:
    return [
        blocker
        for blocker in blockers
        if any(word in blocker for word in SOURCE_MISSING_WORDS)
    ]


def _first_text_at_keys(payload: Mapping[str, Any], keys: Sequence[str]) -> str | None:
    for key, value in _walk_items(payload):
        if key in keys:
            text = _text(value)
            if text:
                return text
    return None


def _first_bool_at_keys(
    payloads: Sequence[Mapping[str, Any]], keys: Sequence[str]
) -> bool | None:
    for payload in payloads:
        for key, value in _walk_items(payload):
            if key in keys:
                parsed = _bool_or_none(value)
                if parsed is not None:
                    return parsed
    return None


def _first_int_at_keys(
    payloads: Sequence[Mapping[str, Any]], keys: Sequence[str]
) -> int | None:
    for payload in payloads:
        for key, value in _walk_items(payload):
            if key in keys:
                parsed = _int_or_none(value)
                if parsed is not None:
                    return parsed
                if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
                    return len(value)
    return None


def _first_decimal_at_keys(
    payloads: Sequence[Mapping[str, Any]], keys: Sequence[str]
) -> Decimal | None:
    for payload in payloads:
        for key, value in _walk_items(payload):
            if key in keys:
                parsed = _decimal(value)
                if parsed is not None:
                    return parsed
    return None


def _walk_items(payload: Mapping[str, Any]) -> Iterable[tuple[str, Any]]:
    stack: list[Any] = [payload]
    while stack:
        item = stack.pop()
        if isinstance(item, Mapping):
            for raw_key, value in cast(Mapping[str, Any], item).items():
                key = str(raw_key)
                yield key, value
                if isinstance(value, (Mapping, list, tuple)):
                    stack.append(value)
        elif isinstance(item, (list, tuple)):
            stack.extend(item)


def _non_empty_payloads(*payloads: object) -> list[Mapping[str, Any]]:
    result: list[Mapping[str, Any]] = []
    for payload in payloads:
        if isinstance(payload, Mapping) and payload:
            result.append(cast(Mapping[str, Any], payload))
    return result


def _mapping(value: object) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, Any], value)
    return {}


def _compact_mapping(value: Mapping[str, Any]) -> dict[str, Any]:
    keys = (
        "hypothesis_id",
        "candidate_id",
        "runtime_strategy_name",
        "strategy_name",
        "account_label",
        "alpaca_account_label",
        "route_enabled",
        "paper_route_enabled",
        "paper_route_eligible",
        "route_eligible",
        "submit_enabled",
        "simple_submit_enabled",
        "promotion_allowed",
        "final_authority_ok",
        "final_promotion_allowed",
        "blockers",
    )
    return {key: value[key] for key in keys if key in value}


def _text(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    if isinstance(value, (int, float, bool, Decimal)):
        return str(value)
    return None


def _text_list(value: object) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, Mapping):
        return [str(key) for key, item in value.items() if item]
    if isinstance(value, Iterable):
        result: list[str] = []
        for item in value:
            text = _text(item)
            if text:
                result.append(text)
        return result
    text = _text(value)
    return [] if text is None else [text]


def _stable_texts(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        normalized = value.strip()
        if normalized and normalized not in seen:
            seen.add(normalized)
            result.append(normalized)
    return result


def _bool_or_none(*values: object) -> bool | None:
    for value in values:
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized in {
                "true",
                "1",
                "yes",
                "y",
                "ok",
                "ready",
                "active",
                "enabled",
            }:
                return True
            if normalized in {
                "false",
                "0",
                "no",
                "n",
                "blocked",
                "inactive",
                "disabled",
            }:
                return False
        if isinstance(value, int) and value in {0, 1}:
            return bool(value)
    return None


def _int_or_none(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, Decimal):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _decimal(value: object) -> Decimal | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, str):
        try:
            return Decimal(value.strip())
        except (InvalidOperation, ValueError):
            return None
    return None


def _decimal_text(value: Decimal | None) -> str | None:
    if value is None:
        return None
    return format(value, "f")


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
