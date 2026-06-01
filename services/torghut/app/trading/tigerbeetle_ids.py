"""Deterministic TigerBeetle 128-bit ID helpers for Torghut ledger events."""

from __future__ import annotations

import hashlib
import uuid


U128_MAX = (1 << 128) - 1


def uuid_to_u128(value: uuid.UUID) -> int:
    """Return the UUID integer value as a TigerBeetle-compatible u128."""

    if value.int == 0:
        raise ValueError("tigerbeetle_id_zero")
    return value.int


def stable_u128(namespace: str, key: str) -> int:
    """Derive a deterministic nonzero u128 from a namespaced source key."""

    normalized_namespace = namespace.strip()
    normalized_key = key.strip()
    if not normalized_namespace:
        raise ValueError("tigerbeetle_namespace_empty")
    if not normalized_key:
        raise ValueError("tigerbeetle_key_empty")
    digest = hashlib.sha256(
        f"{normalized_namespace}\0{normalized_key}".encode("utf-8")
    ).digest()
    value = int.from_bytes(digest[:16], byteorder="big", signed=False)
    if value == 0:
        raise ValueError("tigerbeetle_id_zero")
    return value


def u128_decimal(value: int) -> str:
    """Serialize a TigerBeetle u128 for Postgres storage."""

    if value <= 0 or value > U128_MAX:
        raise ValueError("tigerbeetle_id_out_of_range")
    return str(value)
