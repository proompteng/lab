"""Parser and conversion helpers for runtime window imports."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Mapping, Sequence, cast


def flag(value: str) -> bool:
    """Parse a flag string into a boolean."""
    return value.strip().lower() not in {"", "0", "false", "no", "off"}


def parse_dt(value: str) -> datetime:
    """Parse an ISO datetime string to UTC datetime."""
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def parse_dt_or_none(value: Any) -> datetime | None:
    """Parse an ISO datetime string to UTC datetime or None."""
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
        return parse_dt(text)
    except Exception:
        return None


def as_mapping(value: Any) -> dict[str, Any]:
    """Convert a Mapping to dict[str, Any] or return empty dict."""
    return (
        {str(key): item for key, item in value.items()}
        if isinstance(value, Mapping)
        else {}
    )


def as_sequence(value: Any) -> list[Any] | None:
    """Convert value to list or None."""
    if value is None:
        return []
    if isinstance(value, str):
        try:
            parsed = __import__("json").loads(value)
        except Exception:
            return None
        return as_sequence(parsed)
    if isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        return list(value)
    return None


def parse_target_metadata(raw: str) -> dict[str, Any]:
    """Parse target metadata JSON string."""
    text = str(raw or "").strip()
    if not text:
        return {}
    try:
        payload = __import__("json").loads(text)
    except Exception as exc:
        raise RuntimeError("target_metadata_json_invalid") from exc
    if not isinstance(payload, Mapping):
        raise RuntimeError("target_metadata_json_not_mapping")
    return {str(key): value for key, value in payload.items()}


def decimal_or_none(value: Any) -> Decimal | None:
    """Convert value to Decimal or None."""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return Decimal(text)
    except Exception:
        return None


def text_or_none(value: Any) -> str | None:
    """Convert value to stripped string or None."""
    text = str(value or "").strip()
    return text or None


def bool_value(value: object) -> bool | None:
    """Convert various types to boolean or None."""
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


def metadata_text_list(value: Any) -> list[str]:
    """Convert various types to list of non-empty stripped strings."""
    if isinstance(value, str):
        text = value.strip()
        return [text] if text else []
    if not isinstance(value, Sequence) or isinstance(value, (bytes, bytearray)):
        return []
    return [
        text for item in cast(Sequence[Any], value) if (text := str(item or "").strip())
    ]


def metadata_symbol_list(value: Any) -> list[str]:
    """Extract and normalize symbol list from metadata."""
    symbols: list[str] = []
    for item in metadata_text_list(value):
        symbol = item.strip().upper()
        if symbol:
            symbols.append(symbol)
    return list(dict.fromkeys(symbols))


def nonnegative_int(value: Any) -> int:
    """Convert value to non-negative int."""
    try:
        return max(0, int(Decimal(str(value))))
    except Exception:
        return 0
