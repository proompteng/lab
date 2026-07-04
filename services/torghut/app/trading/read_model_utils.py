"""Shared helpers for Torghut additive read-model payload builders."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from typing import Any, cast


def as_mapping(value: object) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, Any], value)
    return {}


def as_sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return ()


def as_text(value: object, default: str = "") -> str:
    if value is None:
        return default
    normalized = str(value).strip()
    return normalized or default


def as_int(value: object, default: int = 0) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            return int(float(value.strip()))
        except ValueError:
            return default
    return default


def as_bool(value: object, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on", "allow", "allowed", "ok"}:
            return True
        if normalized in {"0", "false", "no", "off", "deny", "blocked", "hold"}:
            return False
    return default


def unique_text_list(value: object) -> list[str]:
    items: list[str] = []
    seen: set[str] = set()
    for item in as_sequence(value):
        normalized = as_text(item)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        items.append(normalized)
    return items


def append_unique_text(items: list[str], *values: object) -> list[str]:
    seen = set(items)
    for value in values:
        if isinstance(value, Sequence) and not isinstance(
            value, (str, bytes, bytearray)
        ):
            candidates = unique_text_list(cast(Sequence[object], value))
        else:
            candidates = [as_text(value)]
        for candidate in candidates:
            if not candidate or candidate in seen:
                continue
            seen.add(candidate)
            items.append(candidate)
    return items


def stable_hash24(prefix: str, payload: Mapping[str, object]) -> str:
    encoded = json.dumps(
        {"prefix": prefix, **dict(payload)},
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:24]


def parse_datetime_utc(value: object) -> datetime | None:
    raw = as_text(value)
    if not raw:
        return None
    normalized = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc)


def first_mapping(values: Sequence[object]) -> Mapping[str, Any]:
    for item in values:
        payload = as_mapping(item)
        if payload:
            return payload
    return {}


def is_alpha_readiness_repair(item: Mapping[str, Any]) -> bool:
    return as_text(item.get("code")) == "repair_alpha_readiness"


def routeable_candidate_count(evidence: Mapping[str, Any]) -> int:
    repair_bid_settlement = as_mapping(evidence.get("repair_bid_settlement"))
    routeability_acceptance = as_mapping(evidence.get("routeability_acceptance"))
    route_clearinghouse = as_mapping(evidence.get("route_evidence_clearinghouse"))
    return max(
        as_int(repair_bid_settlement.get("routeable_candidate_count")),
        as_int(routeability_acceptance.get("accepted_routeable_candidate_count")),
        as_int(route_clearinghouse.get("accepted_routeable_candidate_count")),
    )


def zero_notional_or_stale_evidence_rate(evidence: Mapping[str, Any]) -> object:
    routeability_acceptance = as_mapping(evidence.get("routeability_acceptance"))
    route_clearinghouse = as_mapping(evidence.get("route_evidence_clearinghouse"))
    return routeability_acceptance.get(
        "zero_notional_or_stale_evidence_rate",
        route_clearinghouse.get("zero_notional_or_stale_evidence_rate", 1),
    )


__all__ = [
    "append_unique_text",
    "as_bool",
    "as_int",
    "as_mapping",
    "as_sequence",
    "as_text",
    "first_mapping",
    "is_alpha_readiness_repair",
    "parse_datetime_utc",
    "routeable_candidate_count",
    "stable_hash24",
    "unique_text_list",
    "zero_notional_or_stale_evidence_rate",
]
