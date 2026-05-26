"""Helpers for external paper-route runtime-window target plans."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from http.client import HTTPConnection, HTTPSConnection
from typing import Any, cast
from urllib.parse import urlsplit


def _to_str_map(value: object) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[object, Any], value).items()}


def mapping_items(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    return [
        _to_str_map(cast(object, item))
        for item in cast(Sequence[object], value)
        if isinstance(item, Mapping)
    ]


def paper_route_target_plan_targets(plan: Mapping[str, Any]) -> list[dict[str, Any]]:
    return mapping_items(plan.get("targets"))


def paper_route_target_plan_from_payload(payload: Mapping[str, Any]) -> dict[str, Any]:
    live_gate = _to_str_map(payload.get("live_submission_gate"))
    runtime_window_plan = _to_str_map(payload.get("runtime_window_import_plan"))
    next_paper_route_plan = _to_str_map(
        payload.get("next_paper_route_runtime_window_targets")
    )
    paper_route_payload = (
        payload.get("schema_version") == "torghut.paper-route-evidence.v1"
    )
    paper_route_plans = [next_paper_route_plan] if paper_route_payload else []
    candidate_plans = [
        runtime_window_plan,
        *paper_route_plans,
        _to_str_map(live_gate.get("runtime_ledger_paper_probation_import_plan")),
        _to_str_map(payload.get("runtime_ledger_paper_probation_import_plan")),
        *([] if paper_route_payload else [next_paper_route_plan]),
        dict(payload) if paper_route_target_plan_targets(payload) else {},
    ]
    for plan in candidate_plans:
        if paper_route_target_plan_targets(plan):
            return plan
    return {}


def fetch_paper_route_target_plan_url(
    url: str,
    *,
    timeout_seconds: float,
) -> dict[str, Any]:
    parsed = urlsplit(url)
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        return {
            "load_error": f"paper_route_target_plan_invalid_scheme:{scheme or 'missing'}"
        }
    if not parsed.hostname:
        return {"load_error": "paper_route_target_plan_invalid_host"}

    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    connection_class = HTTPSConnection if scheme == "https" else HTTPConnection
    connection = connection_class(
        parsed.hostname,
        parsed.port,
        timeout=max(float(timeout_seconds), 0.1),
    )
    try:
        connection.request("GET", path, headers={"Accept": "application/json"})
        response = connection.getresponse()
        if response.status < 200 or response.status >= 300:
            return {
                "load_error": f"paper_route_target_plan_http_status:{response.status}"
            }
        raw = response.read(5_000_001)
    except Exception as exc:  # pragma: no cover - depends on network
        return {"load_error": f"paper_route_target_plan_fetch_failed:{exc}"}
    finally:
        connection.close()

    if len(raw) > 5_000_000:
        return {"load_error": "paper_route_target_plan_response_too_large"}
    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        return {"load_error": f"paper_route_target_plan_invalid_json:{exc}"}
    if not isinstance(payload, Mapping):
        return {"load_error": "paper_route_target_plan_invalid_payload"}
    plan = paper_route_target_plan_from_payload(cast(Mapping[str, Any], payload))
    if not plan:
        return {"load_error": "paper_route_target_plan_missing"}
    plan = dict(plan)
    plan.setdefault("source", "external_paper_route_target_plan")
    return plan


def paper_route_target_plan_probe_symbols(plan: Mapping[str, Any]) -> set[str]:
    symbols: set[str] = set()
    for target in paper_route_target_plan_targets(plan):
        raw_symbols = target.get("paper_route_probe_symbols")
        if isinstance(raw_symbols, str):
            values: Sequence[object] = raw_symbols.split(",")
        elif isinstance(raw_symbols, Sequence) and not isinstance(
            raw_symbols, (bytes, bytearray)
        ):
            values = cast(Sequence[object], raw_symbols)
        else:
            values = ()
        for raw_symbol in values:
            symbol = str(raw_symbol).strip().upper()
            if symbol:
                symbols.add(symbol)
    return symbols


__all__ = [
    "fetch_paper_route_target_plan_url",
    "mapping_items",
    "paper_route_target_plan_from_payload",
    "paper_route_target_plan_probe_symbols",
    "paper_route_target_plan_targets",
]
