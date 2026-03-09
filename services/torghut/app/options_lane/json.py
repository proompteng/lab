"""JSON helpers for the options lane."""

from __future__ import annotations

import json
from datetime import date, datetime
from decimal import Decimal
from typing import Any


def json_default(value: Any) -> Any:
    """Normalize non-JSON-native values for Kafka payloads."""

    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    raise TypeError(f"Unsupported JSON value: {type(value)!r}")


def dump_json(payload: dict[str, Any]) -> str:
    """Serialize a compact JSON payload."""

    return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=json_default)
