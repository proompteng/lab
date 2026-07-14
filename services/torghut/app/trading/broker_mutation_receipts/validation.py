"""Strict normalization and validation primitives for broker-mutation receipts."""

from __future__ import annotations

import ipaddress
import hashlib
import json
import posixpath
import re
import unicodedata
import uuid
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal
from typing import TypeVar, cast
from urllib.parse import SplitResult, urlsplit, urlunsplit


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
_DNS_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_SECRET_BEARING_KEY_MARKERS = (
    "apikey",
    "authorization",
    "bearer",
    "cookie",
    "credential",
    "password",
    "passwd",
    "privatekey",
    "secret",
    "token",
)
_EnumValue = TypeVar("_EnumValue", bound=str)


class BrokerMutationReceiptError(RuntimeError):
    """Base error for unsafe or inconsistent receipt operations."""


class BrokerMutationReceiptValidationError(BrokerMutationReceiptError):
    """A caller supplied invalid receipt identity or evidence."""


class BrokerMutationReceiptFenceError(BrokerMutationReceiptError):
    """A stale primary or recovery owner attempted a mutation."""


class BrokerMutationReceiptConflictError(BrokerMutationReceiptError):
    """Durable receipt truth conflicts with the requested mutation."""


class BrokerMutationBrokerIoError(RuntimeError):
    """A known broker dependency failed after durable I/O authorization."""


def canonical_broker_request_sha256(payload: Mapping[str, object]) -> str:
    """Hash one normalized broker request independently from its receipt metadata."""

    normalized = canonical_json_value(payload, path="request", depth=0)
    encoded = json.dumps(
        normalized,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    if len(encoded) > MAX_CANONICAL_INTENT_BYTES:
        raise BrokerMutationReceiptValidationError(
            f"canonical_intent_too_large:{MAX_CANONICAL_INTENT_BYTES}"
        )
    return hashlib.sha256(encoded).hexdigest()


def canonical_broker_request_sha256_from_intent_json(
    canonical_intent_json: str,
) -> str:
    """Extract and hash the request already sealed inside a canonical intent."""

    try:
        document = json.loads(canonical_intent_json, parse_float=Decimal)
    except (TypeError, ValueError) as exc:
        raise BrokerMutationReceiptValidationError(
            "canonical_intent_json_invalid"
        ) from exc
    if not isinstance(document, Mapping):
        raise BrokerMutationReceiptValidationError("canonical_intent_document_invalid")
    request_payload = cast(Mapping[object, object], document).get("request")
    if not isinstance(request_payload, Mapping):
        raise BrokerMutationReceiptValidationError("canonical_intent_document_invalid")
    request_mapping = cast(Mapping[object, object], request_payload)
    normalized_request: dict[str, object] = {}
    for key, value in request_mapping.items():
        if not isinstance(key, str):
            raise BrokerMutationReceiptValidationError(
                "canonical_intent_document_invalid"
            )
        normalized_request[key] = value
    return canonical_broker_request_sha256(normalized_request)


def normalize_endpoint_url(endpoint_url: str) -> str:
    """Normalize a credential-free HTTP endpoint before fingerprinting."""

    raw = required_text(endpoint_url, field="endpoint_url", maximum=2048)
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except ValueError as exc:
        raise BrokerMutationReceiptValidationError("endpoint_url_invalid") from exc
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        raise BrokerMutationReceiptValidationError("endpoint_url_scheme_invalid")
    if parsed.username is not None or parsed.password is not None:
        raise BrokerMutationReceiptValidationError("endpoint_url_credentials_forbidden")
    if parsed.query or parsed.fragment:
        raise BrokerMutationReceiptValidationError(
            "endpoint_url_query_or_fragment_forbidden"
        )
    hostname = parsed.hostname
    if hostname is None:
        raise BrokerMutationReceiptValidationError("endpoint_url_host_required")
    normalized_host = _normalize_endpoint_host(hostname)
    if ":" in normalized_host:
        normalized_host = f"[{normalized_host}]"
    default_port = 443 if scheme == "https" else 80
    authority = (
        normalized_host if port in {None, default_port} else f"{normalized_host}:{port}"
    )
    path = _normalize_endpoint_path(parsed.path)
    normalized = urlunsplit(SplitResult(scheme, authority, path, "", ""))
    reject_control_characters(normalized, field="endpoint_url")
    return normalized


def _normalize_endpoint_host(hostname: str) -> str:
    if "%" in hostname:
        raise BrokerMutationReceiptValidationError("endpoint_url_host_invalid")
    try:
        return ipaddress.ip_address(hostname).compressed.lower()
    except ValueError:
        pass
    try:
        normalized = hostname.rstrip(".").encode("idna").decode("ascii").lower()
    except UnicodeError as exc:
        raise BrokerMutationReceiptValidationError("endpoint_url_host_invalid") from exc
    if (
        not normalized
        or len(normalized) > 253
        or any(_DNS_LABEL.fullmatch(label) is None for label in normalized.split("."))
    ):
        raise BrokerMutationReceiptValidationError("endpoint_url_host_invalid")
    return normalized


def _normalize_endpoint_path(path: str) -> str:
    if not path or path == "/":
        return "/"
    if not path.startswith("/"):
        raise BrokerMutationReceiptValidationError("endpoint_url_path_invalid")
    normalized = posixpath.normpath(path)
    if path.endswith("/") and normalized != "/":
        normalized = normalized.rstrip("/")
    return normalized


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


def canonical_json_value(value: object, *, path: str, depth: int) -> object:
    """Normalize a bounded JSON value while rejecting unsafe representations."""

    if depth > MAX_CANONICAL_NESTING:
        raise BrokerMutationReceiptValidationError(
            f"canonical_intent_nesting_too_deep:{MAX_CANONICAL_NESTING}"
        )
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        if value.bit_length() > MAX_CANONICAL_INTENT_BYTES * 4:
            raise BrokerMutationReceiptValidationError(f"{path}_integer_too_large")
        try:
            rendered_integer = str(value)
        except (MemoryError, ValueError) as exc:
            raise BrokerMutationReceiptValidationError(
                f"{path}_integer_too_large"
            ) from exc
        if len(rendered_integer) > MAX_CANONICAL_INTENT_BYTES:
            raise BrokerMutationReceiptValidationError(f"{path}_integer_too_large")
        return value
    if isinstance(value, float):
        raise BrokerMutationReceiptValidationError(f"{path}_float_forbidden")
    if isinstance(value, Decimal):
        return _canonical_decimal(value, path=path)
    if isinstance(value, str):
        reject_control_characters(value, field=path)
        return unicodedata.normalize("NFC", value)
    if isinstance(value, Mapping):
        return _canonical_mapping(
            cast(Mapping[object, object], value),
            path=path,
            depth=depth,
        )
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [
            canonical_json_value(item, path=f"{path}[{index}]", depth=depth + 1)
            for index, item in enumerate(cast(Sequence[object], value))
        ]
    raise BrokerMutationReceiptValidationError(
        f"{path}_type_unsupported:{type(value).__name__}"
    )


def _canonical_mapping(
    value: Mapping[object, object],
    *,
    path: str,
    depth: int,
) -> dict[str, object]:
    normalized: dict[str, object] = {}
    for raw_key, raw_value in value.items():
        if not isinstance(raw_key, str):
            raise BrokerMutationReceiptValidationError(f"{path}_key_must_be_string")
        key = required_text(raw_key, field=f"{path}_key", maximum=128)
        if key != unicodedata.normalize("NFC", raw_key):
            raise BrokerMutationReceiptValidationError(
                f"{path}_key_surrounding_whitespace_forbidden"
            )
        _reject_secret_bearing_key(key, path=path)
        if key in normalized:
            raise BrokerMutationReceiptValidationError(f"{path}_key_collision:{key}")
        normalized[key] = canonical_json_value(
            raw_value,
            path=f"{path}.{key}",
            depth=depth + 1,
        )
    return normalized


def _reject_secret_bearing_key(key: str, *, path: str) -> None:
    security_key = re.sub(
        r"[^a-z0-9]",
        "",
        unicodedata.normalize("NFKC", key).casefold(),
    )
    if any(marker in security_key for marker in _SECRET_BEARING_KEY_MARKERS):
        raise BrokerMutationReceiptValidationError(
            f"{path}_secret_bearing_key_forbidden"
        )


def _canonical_decimal(value: Decimal, *, path: str) -> str:
    if not value.is_finite():
        raise BrokerMutationReceiptValidationError(f"{path}_decimal_non_finite")
    if value.is_zero():
        return "0"
    sign, raw_digits, raw_exponent = value.as_tuple()
    exponent = cast(int, raw_exponent)
    digits = list(raw_digits)
    while digits and digits[-1] == 0:
        digits.pop()
        exponent += 1
    coefficient = "".join(str(digit) for digit in digits) or "0"
    if exponent >= 0:
        if len(coefficient) + exponent > MAX_CANONICAL_INTENT_BYTES:
            raise BrokerMutationReceiptValidationError(f"{path}_decimal_too_large")
        rendered = coefficient + ("0" * exponent)
    else:
        decimal_position = len(coefficient) + exponent
        if decimal_position > 0:
            rendered = (
                f"{coefficient[:decimal_position]}.{coefficient[decimal_position:]}"
            )
        else:
            leading_zeros = -decimal_position
            if len(coefficient) + leading_zeros > MAX_CANONICAL_INTENT_BYTES:
                raise BrokerMutationReceiptValidationError(f"{path}_decimal_too_large")
            rendered = f"0.{('0' * leading_zeros)}{coefficient}"
    return f"-{rendered}" if sign else rendered


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
    "canonical_broker_request_sha256",
    "canonical_broker_request_sha256_from_intent_json",
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
