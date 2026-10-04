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


def stable_ref_u128(
    *,
    cluster_id: int,
    account_label: str | None,
    source_type: str,
    source_id: str,
    transfer_kind: str,
    source_signature: str | None = None,
) -> int:
    """Derive a deterministic journal-ref ID from the audit source identity.

    This is deliberately separate from the TigerBeetle transfer ID so existing
    ledger transfers remain idempotent. The journal-ref ID gives proof/readiness
    consumers a stable audit handle whose derivation includes the cluster,
    account, source row, transfer kind, and optional source/economic signature.
    """

    normalized_cluster_id = int(cluster_id)
    normalized_account_label = (account_label or "unknown").strip() or "unknown"
    normalized_source_type = source_type.strip()
    normalized_source_id = source_id.strip()
    normalized_transfer_kind = transfer_kind.strip()
    normalized_source_signature = (source_signature or "none").strip() or "none"
    if normalized_cluster_id <= 0:
        raise ValueError("tigerbeetle_cluster_id_invalid")
    if not normalized_source_type:
        raise ValueError("tigerbeetle_source_type_empty")
    if not normalized_source_id:
        raise ValueError("tigerbeetle_source_id_empty")
    if not normalized_transfer_kind:
        raise ValueError("tigerbeetle_transfer_kind_empty")

    key = "\0".join(
        (
            f"cluster:{normalized_cluster_id}",
            f"account:{normalized_account_label}",
            f"source_type:{normalized_source_type}",
            f"source_id:{normalized_source_id}",
            f"transfer_kind:{normalized_transfer_kind}",
            f"source_signature:{normalized_source_signature}",
        )
    )
    return stable_u128("torghut.tigerbeetle.journal_ref", key)


def u128_decimal(value: int) -> str:
    """Serialize a TigerBeetle u128 for Postgres storage."""

    if value <= 0 or value > U128_MAX:
        raise ValueError("tigerbeetle_id_out_of_range")
    return str(value)
