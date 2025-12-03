from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Hashable

import orjson


def to_iso(value: Any) -> Any:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat()
    return value


def normalize(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: normalize(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [normalize(v) for v in value]
    if isinstance(value, datetime):
        return to_iso(value)
    return value


def payload_to_dict(payload: Any) -> Dict[str, Any]:
    if payload is None:
        return {}
    if hasattr(payload, "model_dump"):
        data = payload.model_dump()
    elif hasattr(payload, "dict"):
        try:
            data = payload.dict()
        except Exception:  # pragma: no cover - defensive
            data = dict(payload)
    elif hasattr(payload, "__dict__"):
        data = {k: v for k, v in payload.__dict__.items() if not k.startswith("_")}
    else:
        try:
            data = orjson.loads(orjson.dumps(payload, default=str))
        except TypeError:
            data = {"value": str(payload)}
    return normalize(data)


def build_envelope(
    *,
    channel: str,
    symbol: str,
    seq: int,
    payload: Any,
    event_ts: Any,
    is_final: bool = False,
    source: str = "alpaca",
    key: Hashable | None = None,
) -> Dict[str, Any]:
    ingest_ts = datetime.now(timezone.utc).isoformat()
    envelope = {
        "ingest_ts": ingest_ts,
        "event_ts": to_iso(event_ts) if event_ts else None,
        "channel": channel,
        "symbol": symbol,
        "seq": seq,
        "payload": payload_to_dict(payload),
        "is_final": bool(is_final),
        "source": source,
    }
    if key is not None:
        envelope["key"] = str(key)
    return envelope
