"""Parser helper functions for runtime window imports."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from decimal import Decimal, ROUND_CEILING
from typing import Any, Mapping, Sequence, cast

_CENT = Decimal("0.01")


def _flag(value: str) -> bool:
    """Parse a flag value."""
    return value.strip().lower() not in {"", "0", "false", "no", "off"}


def _parse_dt(value: str) -> datetime:
    """Parse a datetime from a string."""
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _parse_dt_or_none(value: Any) -> datetime | None:
    """Parse a datetime from a value, or None if not parseable."""
    if isinstance(value, datetime):
        return (
            value.astimezone(timezone.utc)
            if value.tzinfo
            else value.replace(tzinfo=timezone.utc)
        )
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return _parse_dt(text)
    except Exception:
        return None


def _decimal_or_none(value: Any) -> Decimal | None:
    """Parse a Decimal from a value, or None if not parseable."""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return Decimal(text)
    except Exception:
        return None


def _text_or_none(value: Any) -> str | None:
    """Extract text from a value, or None if empty."""
    text = str(value or "").strip()
    return text or None


def _nonnegative_int(value: Any) -> int:
    """Parse a non-negative integer from a value."""
    try:
        return max(0, int(Decimal(str(value))))
    except Exception:
        return 0


def _metadata_text_list(value: Any) -> list[str]:
    """Parse a list of metadata text values."""
    if isinstance(value, str):
        text = value.strip()
        return [text] if text else []
    if not isinstance(value, Sequence) or isinstance(value, (bytes, bytearray)):
        return []
    return [
        text for item in cast(Sequence[Any], value) if (text := str(item or "").strip())
    ]


def _stable_payload_digest(value: object) -> str | None:
    """Compute a stable hash digest for a payload."""
    if not isinstance(value, Mapping):
        return None
    payload = {str(item_key): item for item_key, item in value.items()}
    if not payload:
        return None
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        default=_json_default,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _json_default(value: object) -> str:
    """JSON default encoder for non-serializable types."""
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    return str(value)


def _as_mapping(value: Any) -> dict[str, Any]:
    """Convert value to a string-keyed mapping."""
    return (
        {str(key): item for key, item in value.items()}
        if isinstance(value, Mapping)
        else {}
    )


def _as_sequence(value: Any) -> list[Any] | None:
    """Convert value to a sequence, or None if not convertible."""
    if value is None:
        return []
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except Exception:
            return None
        return _as_sequence(parsed)
    if isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        return list(value)
    return None


def _first_decimal(row: Mapping[str, object], *keys: str) -> Decimal | None:
    """Get the first decimal value from keys in row payloads."""
    for payload in _row_payloads(row):
        for key in keys:
            value = payload.get(key)
            if (parsed := _decimal_or_none(value)) is not None:
                return parsed
    return None


def _first_positive_decimal(row: Mapping[str, object], *keys: str) -> Decimal | None:
    """Get the first positive decimal value from keys in row payloads."""
    for payload in _row_payloads(row):
        for key in keys:
            value = payload.get(key)
            if (parsed := _decimal_or_none(value)) is not None and parsed > 0:
                return parsed
    return None


def _first_text(row: Mapping[str, object], *keys: str) -> str | None:
    """Get the first text value from keys in row payloads."""
    for payload in _row_payloads(row):
        for key in keys:
            text = str(payload.get(key) or "").strip()
            if text:
                return text
    return None


def _direct_text(row: Mapping[str, object], *keys: str) -> str | None:
    """Get the first text value directly from row."""
    for key in keys:
        text = str(row.get(key) or "").strip()
        if text:
            return text
    return None


def _bool_value(value: object) -> bool | None:
    """Parse a boolean value."""
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float | Decimal):
        return bool(value)
    text = str(value or "").strip().lower()
    if text in {"1", "true", "yes", "on", "pass", "passed", "ok"}:
        return True
    if text in {"0", "false", "no", "off", "fail", "failed", "blocked"}:
        return False
    return None


def _direct_bool(row: Mapping[str, object], *keys: str) -> bool | None:
    """Get the first bool value directly from row."""
    for key in keys:
        value = row.get(key)
        if (parsed := _bool_value(value)) is not None:
            return parsed
    return None


def _text_values(row: Mapping[str, object], *keys: str) -> set[str]:
    """Get text values from row payloads."""
    values: set[str] = set()
    for payload in _row_payloads(row):
        for key in keys:
            raw_value = payload.get(key)
            if isinstance(raw_value, Sequence) and not isinstance(
                raw_value, (str, bytes, bytearray)
            ):
                for item in raw_value:
                    text = str(item or "").strip()
                    if text:
                        values.add(text)
            else:
                text = str(raw_value or "").strip()
                if text:
                    values.add(text)
    return values


def _first_bool(row: Mapping[str, object], *keys: str) -> bool | None:
    """Get the first bool value from row payloads."""
    for payload in _row_payloads(row):
        for key in keys:
            if (parsed := _bool_value(payload.get(key))) is not None:
                return parsed
    return None


def _row_payloads(row: Mapping[str, object]) -> list[Mapping[str, object]]:
    """Extract all payloads from a row, nested up to depth 4."""
    payloads: list[Mapping[str, object]] = []

    def append_payload(value: object, *, depth: int) -> None:
        if not isinstance(value, Mapping):
            return
        payload = {str(item_key): item for item_key, item in value.items()}
        payloads.append(payload)
        if depth <= 0:
            return
        for nested in payload.values():
            if isinstance(nested, Mapping):
                append_payload(nested, depth=depth - 1)

    append_payload(row, depth=4)
    return payloads


def _decimal_ceil_cent(value: Decimal) -> Decimal:
    """Round a decimal up to the nearest cent."""
    if value <= 0:
        return Decimal("0")
    return value.quantize(_CENT, rounding=ROUND_CEILING)


def _metadata_nonnegative_int_or_none(value: Any) -> int | None:
    """Parse a non-negative integer from metadata, or None."""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return _nonnegative_int(value)
