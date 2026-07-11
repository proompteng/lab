"""Strict validation primitives for durable broker-mutation receipts."""

from __future__ import annotations

import re
import unicodedata
import uuid
from datetime import datetime, timezone
from typing import TypeVar, cast


RECEIPT_MIN_LEASE_SECONDS = 5
RECEIPT_MAX_LEASE_SECONDS = 300
RECEIPT_DEFAULT_LEASE_SECONDS = 30
RECEIPT_MIN_RECOVERY_SECONDS = 30
RECEIPT_MAX_RECOVERY_SECONDS = 3600
RECEIPT_DEFAULT_RECOVERY_SECONDS = 120
MAX_CANONICAL_INTENT_BYTES = 65_536
MAX_CANONICAL_EVIDENCE_BYTES = 4_096
MAX_CANONICAL_NESTING = 32

_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_EnumValue = TypeVar("_EnumValue", bound=str)


class BrokerMutationReceiptError(RuntimeError):
    """Base error for unsafe or inconsistent receipt operations."""


class BrokerMutationReceiptValidationError(BrokerMutationReceiptError):
    """A caller supplied invalid receipt identity or evidence."""


class BrokerMutationReceiptFenceError(BrokerMutationReceiptError):
    """A stale primary or recovery owner attempted a mutation."""


class BrokerMutationReceiptConflictError(BrokerMutationReceiptError):
    """Durable receipt truth conflicts with the requested mutation."""


def required_text(value: object, *, field: str, maximum: int) -> str:
    """Normalize a bounded identifier while rejecting control characters."""

    if not isinstance(value, str):
        raise BrokerMutationReceiptValidationError(f"{field}_must_be_string")
    normalized = unicodedata.normalize("NFC", value).strip()
    if not normalized:
        raise BrokerMutationReceiptValidationError(f"{field}_required")
    if len(normalized) > maximum:
        raise BrokerMutationReceiptValidationError(f"{field}_too_long:{maximum}")
    reject_control_characters(normalized, field=field)
    return normalized


def optional_text(value: object | None, *, field: str, maximum: int) -> str | None:
    if value is None:
        return None
    return required_text(value, field=field, maximum=maximum)


def reject_control_characters(value: str, *, field: str) -> None:
    if any(unicodedata.category(character) == "Cc" for character in value):
        raise BrokerMutationReceiptValidationError(
            f"{field}_contains_control_character"
        )


def enum_value(
    value: object,
    *,
    field: str,
    allowed: tuple[_EnumValue, ...],
) -> _EnumValue:
    normalized = required_text(value, field=field, maximum=64)
    if normalized not in allowed:
        raise BrokerMutationReceiptValidationError(f"{field}_invalid:{normalized}")
    return cast(_EnumValue, normalized)


def as_uuid(value: uuid.UUID | str, *, field: str) -> uuid.UUID:
    try:
        return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))
    except (TypeError, ValueError) as exc:
        raise BrokerMutationReceiptValidationError(f"{field}_invalid") from exc


def optional_uuid(
    value: uuid.UUID | str | None,
    *,
    field: str,
) -> uuid.UUID | None:
    return None if value is None else as_uuid(value, field=field)


def positive_integer(value: object, *, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise BrokerMutationReceiptValidationError(f"{field}_must_be_integer")
    if value <= 0:
        raise BrokerMutationReceiptValidationError(f"{field}_must_be_positive")
    return value


def nonnegative_integer(value: object, *, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise BrokerMutationReceiptValidationError(f"{field}_must_be_integer")
    if value < 0:
        raise BrokerMutationReceiptValidationError(f"{field}_must_be_nonnegative")
    return value


def bounded_seconds(value: object, *, minimum: int, maximum: int, field: str) -> int:
    normalized = positive_integer(value, field=field)
    if normalized < minimum or normalized > maximum:
        raise BrokerMutationReceiptValidationError(
            f"{field}_outside_bounds:{minimum}:{maximum}"
        )
    return normalized


def sha256_hex(value: object, *, field: str) -> str:
    if not isinstance(value, str) or _SHA256_PATTERN.fullmatch(value) is None:
        raise BrokerMutationReceiptValidationError(f"{field}_must_be_sha256_hex")
    return value


def as_utc_datetime(value: object, *, field: str) -> datetime:
    if not isinstance(value, datetime):
        raise BrokerMutationReceiptValidationError(f"{field}_must_be_datetime")
    if value.tzinfo is None:
        raise BrokerMutationReceiptValidationError(f"{field}_must_be_timezone_aware")
    return value.astimezone(timezone.utc)


__all__ = [
    "MAX_CANONICAL_INTENT_BYTES",
    "MAX_CANONICAL_EVIDENCE_BYTES",
    "MAX_CANONICAL_NESTING",
    "RECEIPT_DEFAULT_LEASE_SECONDS",
    "RECEIPT_DEFAULT_RECOVERY_SECONDS",
    "RECEIPT_MAX_LEASE_SECONDS",
    "RECEIPT_MAX_RECOVERY_SECONDS",
    "RECEIPT_MIN_LEASE_SECONDS",
    "RECEIPT_MIN_RECOVERY_SECONDS",
    "BrokerMutationReceiptConflictError",
    "BrokerMutationReceiptError",
    "BrokerMutationReceiptFenceError",
    "BrokerMutationReceiptValidationError",
    "as_utc_datetime",
    "as_uuid",
    "bounded_seconds",
    "enum_value",
    "nonnegative_integer",
    "optional_text",
    "optional_uuid",
    "positive_integer",
    "reject_control_characters",
    "required_text",
    "sha256_hex",
]
