"""Shared candidate-spec parsing and hashing helpers."""

from __future__ import annotations

import hashlib
import json
from typing import Any, Mapping, Sequence, cast


def _stable_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _stable_int(payload: Mapping[str, Any]) -> int:
    return int(_stable_hash(payload)[:12], 16)


def _string(value: Any) -> str:
    return str(value or "").strip()


def _mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[Any, Any], value).items()}


def _string_sequence(value: Any) -> tuple[str, ...]:
    if not isinstance(value, Sequence) or isinstance(value, str):
        return ()
    return tuple(str(item) for item in cast(Sequence[Any], value))


mapping = _mapping
stable_hash = _stable_hash
stable_int = _stable_int
string = _string
string_sequence = _string_sequence


__all__ = (
    "_mapping",
    "_stable_hash",
    "_stable_int",
    "_string",
    "_string_sequence",
    "mapping",
    "stable_hash",
    "stable_int",
    "string",
    "string_sequence",
)
