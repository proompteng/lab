"""ClickHouse query helpers for trading pipeline."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Optional

_SYMBOL_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$")


def normalize_symbol(symbol: object) -> Optional[str]:
    if not isinstance(symbol, str):
        return None
    cleaned = symbol.strip()
    if not cleaned:
        return None
    if _SYMBOL_PATTERN.fullmatch(cleaned) is None:
        return None
    return cleaned


def to_datetime64(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    else:
        value = value.astimezone(timezone.utc)
    millis = value.microsecond // 1000
    formatted = f"{value:%Y-%m-%d %H:%M:%S}.{millis:03d}"
    return f"toDateTime64('{formatted}', 3, 'UTC')"


__all__ = ["normalize_symbol", "to_datetime64"]
