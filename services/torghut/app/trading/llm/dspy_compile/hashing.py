"""Deterministic canonical hashing utilities for DSPy artifact workflows."""

from __future__ import annotations

import hashlib
import json
from typing import Any


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def hash_payload(value: Any) -> str:
    return sha256_hex(canonical_json(value))


__all__ = ["canonical_json", "hash_payload", "sha256_hex"]
