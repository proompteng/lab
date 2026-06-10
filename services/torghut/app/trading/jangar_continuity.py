"""Jangar continuity packet loading for Torghut route repair admission."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from threading import Lock
from typing import Any, cast
from urllib.request import Request, urlopen

from ..config import settings

_CACHE_LOCK = Lock()
_STATUS_CACHE: dict[str, object] = {}


def _text(value: object, default: str = "") -> str:
    if value is None:
        return default
    normalized = str(value).strip()
    return normalized or default


def _mapping(value: object) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, Any], value)
    return {}


def _sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return []


def _parse_timestamp(value: object) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str) and value.strip():
        raw = value.strip()
        if raw.endswith("Z"):
            raw = f"{raw[:-1]}+00:00"
        try:
            parsed = datetime.fromisoformat(raw)
        except ValueError:
            return None
    else:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _error_packet(reason: str, message: str | None = None) -> dict[str, object]:
    packet: dict[str, object] = {
        "epoch_id": None,
        "state": "missing",
        "decision": "missing",
        "fresh_until": None,
        "blocking_reasons": [reason],
        "source": "internal",
    }
    if message:
        packet["message"] = message
    return packet


def _normalize_packet(
    packet: dict[str, object], *, now: datetime | None = None
) -> dict[str, object]:
    fresh_until = _parse_timestamp(packet.get("fresh_until"))
    reasons = [
        _text(item) for item in _sequence(packet.get("blocking_reasons")) if _text(item)
    ]
    if fresh_until is not None and fresh_until <= (now or datetime.now(timezone.utc)):
        packet["state"] = "stale"
        packet["decision"] = "hold"
        if "internal_continuity_epoch_stale" not in reasons:
            reasons.append("internal_continuity_epoch_stale")
    if (
        not _text(packet.get("epoch_id"))
        and "internal_continuity_epoch_missing" not in reasons
    ):
        reasons.append("internal_continuity_epoch_missing")
    packet["blocking_reasons"] = reasons
    return packet


def _quality_ref_fields(
    source: Mapping[str, Any],
    *,
    fallback: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    fallback_payload = _mapping(fallback)
    quality_ref = (
        _text(source.get("internal_evidence_quality_ref"))
        or _text(source.get("evidence_quality_ref"))
        or _text(source.get("quality_ledger_ref"))
        or _text(fallback_payload.get("internal_evidence_quality_ref"))
        or _text(fallback_payload.get("evidence_quality_ref"))
        or _text(fallback_payload.get("quality_ledger_ref"))
    )
    payload: dict[str, object] = {}
    if quality_ref:
        payload["internal_evidence_quality_ref"] = quality_ref
    quality_state = (
        _text(source.get("quality_state"))
        or _text(source.get("evidence_quality_state"))
        or _text(fallback_payload.get("quality_state"))
        or _text(fallback_payload.get("evidence_quality_state"))
    )
    if quality_state:
        payload["quality_state"] = quality_state
    if "non_promoting_receipt" in source:
        payload["non_promoting_receipt"] = bool(source.get("non_promoting_receipt"))
    elif "non_promoting_receipt" in fallback_payload:
        payload["non_promoting_receipt"] = bool(
            fallback_payload.get("non_promoting_receipt")
        )
    return payload


def _status_payload_from_url(url: str) -> Mapping[str, Any] | None:
    ttl_seconds = 0
    now = datetime.now(timezone.utc)
    if ttl_seconds > 0:
        with _CACHE_LOCK:
            cached = cast(dict[str, Any] | None, _STATUS_CACHE.get(url))
            if cached is not None:
                checked_at = cast(datetime | None, cached.get("checked_at"))
                if (
                    checked_at is not None
                    and (now - checked_at).total_seconds() <= ttl_seconds
                ):
                    return _mapping(cached.get("payload"))
    request = Request(url, method="GET", headers={"accept": "application/json"})
    with urlopen(
        request, timeout=30.0
    ) as response:
        if response.status < 200 or response.status >= 300:
            raise RuntimeError(f"internal_status_http_{response.status}")
        decoded = json.loads(response.read().decode("utf-8"))
    payload = _mapping(decoded)
    if ttl_seconds > 0:
        with _CACHE_LOCK:
            _STATUS_CACHE[url] = {"checked_at": now, "payload": dict(payload)}
    return payload


def build_jangar_route_continuity_packet(
    status_payload: Mapping[str, Any],
    *,
    action_class: str = "paper_canary",
    now: datetime | None = None,
) -> dict[str, object]:
    """Extract the Jangar packet that should guard Torghut route repair capital."""

    ledger = _mapping(status_payload.get("continuity_witness_ledger"))
    if ledger:
        packet: dict[str, object] = {
            "epoch_id": _text(
                ledger.get("epoch_id"),
                _text(ledger.get("current_epoch_id"), _text(ledger.get("ledger_id"))),
            )
            or None,
            "state": _text(ledger.get("state"), "present"),
            "decision": _text(
                ledger.get("continuity_decision"),
                _text(
                    ledger.get("decision"),
                    _text(ledger.get("action_decision"), "unknown"),
                ),
            ),
            "fresh_until": ledger.get("fresh_until"),
            "blocking_reasons": [
                _text(item)
                for item in _sequence(ledger.get("blocking_reasons"))
                if _text(item)
            ],
            "source": "continuity_witness_ledger",
            "action_class": action_class,
        }
        packet.update(_quality_ref_fields(ledger))
        return _normalize_packet(packet, now=now)

    truth_exchange = _mapping(status_payload.get("source_rollout_truth_exchange"))
    receipts: list[Mapping[str, Any]] = [
        _mapping(item)
        for item in _sequence(truth_exchange.get("receipts"))
        if _mapping(item)
    ]
    selected: Mapping[str, Any] = {}
    for receipt in receipts:
        if _text(receipt.get("action_class")) == action_class:
            selected = receipt
            break
    if selected:
        decision = _text(selected.get("action_decision"), "unknown")
        packet = {
            "epoch_id": _text(selected.get("receipt_id"))
            or _text(truth_exchange.get("exchange_id"))
            or None,
            "state": "present",
            "decision": decision,
            "fresh_until": selected.get("fresh_until")
            or truth_exchange.get("fresh_until"),
            "blocking_reasons": [
                _text(item)
                for item in _sequence(selected.get("blocking_reasons"))
                if _text(item)
            ],
            "source": "source_rollout_truth_exchange",
            "action_class": action_class,
            "exchange_id": truth_exchange.get("exchange_id"),
            "settlement_state": selected.get("settlement_state"),
            "rollback_target": selected.get("rollback_target"),
        }
        packet.update(_quality_ref_fields(selected, fallback=truth_exchange))
        return _normalize_packet(packet, now=now)

    return _normalize_packet(
        {
            "epoch_id": _text(truth_exchange.get("exchange_id")) or None,
            "state": "missing",
            "decision": "missing",
            "fresh_until": truth_exchange.get("fresh_until"),
            "blocking_reasons": [f"internal_{action_class}_receipt_missing"],
            "source": "source_rollout_truth_exchange"
            if truth_exchange
            else "internal_control_plane_status",
            "action_class": action_class,
        },
        now=now,
    )


def load_jangar_route_continuity_packet(
    *, action_class: str = "paper_canary"
) -> dict[str, object]:
    status_url = ""
    if not status_url:
        return _error_packet("internal_control_plane_status_url_missing")
    try:
        payload = _status_payload_from_url(status_url)
    except Exception as exc:
        return _error_packet(
            "internal_continuity_status_fetch_failed",
            f"Jangar continuity status fetch failed: {exc}",
        )
    if not payload:
        return _error_packet("internal_continuity_status_payload_invalid")
    return build_internal_route_continuity_packet(payload, action_class=action_class)


__all__ = [
    "build_jangar_route_continuity_packet",
    "load_jangar_route_continuity_packet",
]
