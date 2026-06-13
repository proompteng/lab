#!/usr/bin/env python3
"""Safely materialize bounded H-PAIRS paper-route targets into TORGHUT_SIM."""

from __future__ import annotations

import argparse
import json
import time
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from http.client import HTTPConnection, HTTPSConnection
from pathlib import Path
from typing import Any, cast
from urllib.parse import urlsplit


from app.trading.paper_route_target_plan import (
    PAPER_ROUTE_MATERIALIZATION_HPAIRS_HYPOTHESIS_ID,
    paper_route_target_execution_capacity_blockers,
    paper_route_target_plan_from_payload,
    paper_route_target_plan_targets,
)


SCHEMA_VERSION = "torghut.bounded-paper-route-target-materialization-cli.v1"

OPERATOR_CONFIRMATION = "MATERIALIZE_BOUNDED_TORGHUT_SIM_PAPER_ROUTE_TARGETS"

DEFAULT_DYNAMIC_SELECTED_PLAN_SOURCE = (
    "live_submission_gate.runtime_ledger_paper_probation_import_plan"
)

DEFAULT_DYNAMIC_SELECTED_PLAN_SOURCES = (
    DEFAULT_DYNAMIC_SELECTED_PLAN_SOURCE,
    "trading_proofs",
    "runtime_ledger_paper_probation_import_plan",
    "latest_closed_paper_route_runtime_window_targets",
    "next_paper_route_runtime_window_targets",
    "next_clean_paper_route_runtime_window_targets_after_discard",
)

PROMOTION_FLAG_FIELDS = (
    "promotion_allowed",
    "promotion_authorized",
    "final_authority_ok",
    "final_promotion_allowed",
    "final_promotion_authorized",
    "capital_promotion_allowed",
    "capital_promotion_authorized",
    "live_capital_routing_enabled",
)

LIVE_LABEL_MARKERS = ("LIVE", "PROD", "REAL")

TARGET_PLAN_RESPONSE_LIMIT_BYTES = 5_000_000

ACTIVE_TARGET_WINDOW_SKIP_REASON = (
    "paper_route_materialization_active_target_window_not_open"
)

ACTIVE_TARGET_WINDOW_REQUIRED_BLOCKER = (
    "paper_route_materialization_active_target_window_required"
)


def _json_default(value: object) -> str:
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _safe_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _safe_decimal(value: object) -> Decimal:
    if value is None:
        return Decimal("0")
    try:
        return Decimal(str(value).strip())
    except (InvalidOperation, TypeError, ValueError):
        return Decimal("0")


def _decimal_text(value: Decimal) -> str:
    return format(value, "f")


def _truthy(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float | Decimal):
        return bool(value)
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _to_str_map(value: object) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[object, Any], value).items()}


def _target_symbol_actions(target: Mapping[str, Any]) -> dict[str, str]:
    raw_actions = _to_str_map(target.get("paper_route_probe_symbol_actions"))
    actions: dict[str, str] = {}
    for raw_symbol, raw_action in raw_actions.items():
        symbol = str(raw_symbol).strip().upper()
        action = str(raw_action).strip().lower()
        if symbol and action in {"buy", "sell"}:
            actions[symbol] = action
    return actions


def _target_symbol_quantities(target: Mapping[str, Any]) -> dict[str, Decimal]:
    quantities: dict[str, Decimal] = {}
    for field in (
        "paper_route_probe_symbol_quantities",
        "target_symbol_quantities",
        "symbol_quantities",
    ):
        raw_quantities = _to_str_map(target.get(field))
        for raw_symbol, raw_quantity in raw_quantities.items():
            symbol = str(raw_symbol).strip().upper()
            quantity = _safe_decimal(raw_quantity)
            if symbol and quantity > 0:
                quantities[symbol] = quantity
    fallback_quantity = _first_positive_decimal(
        target,
        ("target_quantity", "paper_route_probe_target_quantity", "qty", "quantity"),
    )
    if fallback_quantity > 0:
        for symbol in _target_symbol_actions(target):
            quantities.setdefault(symbol, fallback_quantity)
    return quantities


def _first_positive_decimal(
    payload: Mapping[str, Any],
    fields: Sequence[str],
) -> Decimal:
    for field in fields:
        value = _safe_decimal(payload.get(field))
        if value > 0:
            return value
    return Decimal("0")


def _target_notional(target: Mapping[str, Any]) -> Decimal:
    return _first_positive_decimal(
        target,
        (
            "target_notional",
            "paper_route_probe_target_notional",
            "paper_route_probe_effective_max_notional",
            "bounded_evidence_collection_max_notional",
            "paper_route_probe_next_session_max_notional",
            "max_notional",
        ),
    )


def _target_quantity(target: Mapping[str, Any]) -> Decimal:
    explicit_quantity = _first_positive_decimal(
        target,
        ("target_quantity", "paper_route_probe_target_quantity", "qty", "quantity"),
    )
    if explicit_quantity > 0:
        return explicit_quantity
    return sum(_target_symbol_quantities(target).values(), Decimal("0"))


def _target_plan_ref(target: Mapping[str, Any]) -> str | None:
    return (
        _safe_text(target.get("source_plan_ref"))
        or _safe_text(target.get("source_plan_id"))
        or _safe_text(target.get("source_manifest_ref"))
        or _safe_text(target.get("paper_route_target_plan_source"))
    )


def _target_window_start(target: Mapping[str, Any]) -> str | None:
    return (
        _safe_text(target.get("window_start"))
        or _safe_text(target.get("paper_route_probe_window_start"))
        or _safe_text(target.get("source_window_start"))
        or _safe_text(target.get("runtime_window_start"))
    )


def _target_window_end(target: Mapping[str, Any]) -> str | None:
    return (
        _safe_text(target.get("window_end"))
        or _safe_text(target.get("paper_route_probe_window_end"))
        or _safe_text(target.get("source_window_end"))
        or _safe_text(target.get("runtime_window_end"))
    )


def _parse_utc_datetime(value: object) -> datetime | None:
    text = _safe_text(value)
    if text is None:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _resolve_now_utc(args: argparse.Namespace) -> datetime:
    configured_now = _safe_text(getattr(args, "now_utc", None))
    if configured_now:
        parsed = _parse_utc_datetime(configured_now)
        if parsed is not None:
            return parsed
    return datetime.now(timezone.utc)


def _load_json_file(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, Mapping):
        raise ValueError("paper_route_target_plan_json_must_be_object")
    return dict(cast(Mapping[str, Any], payload))


def _nested_mapping(payload: Mapping[str, Any], *keys: str) -> dict[str, Any]:
    current: object = payload
    for key in keys:
        if not isinstance(current, Mapping):
            return {}
        current = cast(Mapping[str, Any], current).get(key)
    return _to_str_map(current)


def _target_bounded_materialization_authorized(target: Mapping[str, Any]) -> bool:
    return _truthy(target.get("bounded_evidence_collection_authorized")) and _truthy(
        target.get("evidence_collection_ok")
    )


def _target_materialization_score(target: Mapping[str, Any]) -> tuple[int, int, int]:
    materializable_shape = int(
        bool(_target_symbol_actions(target)) and _target_notional(target) > 0
    )
    bounded_authorized = int(
        _target_bounded_materialization_authorized(target) and materializable_shape
    )
    return (
        materializable_shape,
        bounded_authorized,
        int(
            _safe_text(target.get("hypothesis_id"))
            == PAPER_ROUTE_MATERIALIZATION_HPAIRS_HYPOTHESIS_ID
        ),
    )


def _plan_materialization_score(plan: Mapping[str, Any]) -> tuple[int, int, int, int]:
    bounded_authorized = 0
    hpairs = 0
    materializable_shape = 0
    targets = paper_route_target_plan_targets(plan)
    for target in targets:
        target_shape, target_authorized, target_hpairs = _target_materialization_score(
            target
        )
        bounded_authorized += target_authorized
        hpairs += target_hpairs
        materializable_shape += target_shape
    return (materializable_shape, bounded_authorized, hpairs, -len(targets))


def _candidate_materialization_plans(
    payload: Mapping[str, Any],
) -> list[tuple[str, dict[str, Any]]]:
    return [
        (
            "trading_proofs",
            paper_route_target_plan_from_payload(payload)
            if str(payload.get("schema_version") or "").strip() == "torghut.proofs.v1"
            else {},
        ),
        (
            "live_submission_gate.runtime_ledger_paper_probation_import_plan",
            _nested_mapping(
                payload,
                "live_submission_gate",
                "runtime_ledger_paper_probation_import_plan",
            ),
        ),
        (
            "runtime_ledger_paper_probation_import_plan",
            _to_str_map(payload.get("runtime_ledger_paper_probation_import_plan")),
        ),
        (
            "latest_closed_paper_route_runtime_window_targets",
            _to_str_map(
                payload.get("latest_closed_paper_route_runtime_window_targets")
            ),
        ),
        (
            "next_paper_route_runtime_window_targets",
            _to_str_map(payload.get("next_paper_route_runtime_window_targets")),
        ),
        (
            "next_clean_paper_route_runtime_window_targets_after_discard",
            _to_str_map(
                payload.get(
                    "next_clean_paper_route_runtime_window_targets_after_discard"
                )
            ),
        ),
        (
            "source_runtime_window_import_plan",
            _to_str_map(payload.get("source_runtime_window_import_plan")),
        ),
        (
            "runtime_window_import_plan",
            _to_str_map(payload.get("runtime_window_import_plan")),
        ),
        (
            "observed_strategy_source_runtime_window_import_plan",
            _to_str_map(
                payload.get("observed_strategy_source_runtime_window_import_plan")
            ),
        ),
        ("payload", dict(payload) if paper_route_target_plan_targets(payload) else {}),
    ]


def _materialization_plan_from_payload(
    payload: Mapping[str, Any],
    *,
    selected_plan_sources: set[str] | None = None,
) -> tuple[dict[str, Any], str | None]:
    best_plan: dict[str, Any] = {}
    best_source: str | None = None
    best_score = (-1, -1, -1, -1_000_000)
    for source, plan in _candidate_materialization_plans(payload):
        if selected_plan_sources and source not in selected_plan_sources:
            continue
        if not paper_route_target_plan_targets(plan):
            continue
        score = _plan_materialization_score(plan)
        if score > best_score:
            best_plan = dict(plan)
            best_source = source
            best_score = score
    return best_plan, best_source


def _fetch_plan_url_payload_once(url: str, *, timeout_seconds: float) -> dict[str, Any]:
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
        connection.request(
            "GET",
            path,
            headers={
                "Accept": "application/json",
                "Connection": "close",
                "Host": parsed.netloc or parsed.hostname,
            },
        )
        response = connection.getresponse()
        if response.status < 200 or response.status >= 300:
            return {
                "load_error": f"paper_route_target_plan_http_status:{response.status}"
            }
        raw = response.read(TARGET_PLAN_RESPONSE_LIMIT_BYTES + 1)
    except Exception as exc:
        return {"load_error": f"paper_route_target_plan_fetch_failed:{exc}"}
    finally:
        connection.close()

    if len(raw) > TARGET_PLAN_RESPONSE_LIMIT_BYTES:
        return {"load_error": "paper_route_target_plan_response_too_large"}
    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        return {"load_error": f"paper_route_target_plan_invalid_json:{exc}"}
    if not isinstance(payload, Mapping):
        return {"load_error": "paper_route_target_plan_invalid_payload"}
    return dict(cast(Mapping[str, Any], payload))


def _fetch_plan_url_payload(
    url: str,
    *,
    timeout_seconds: float,
    attempts: int,
    retry_backoff_seconds: float = 0.25,
) -> dict[str, Any]:
    max_attempts = max(int(attempts), 1)
    payload: dict[str, Any] = {}
    for attempt in range(1, max_attempts + 1):
        payload = _fetch_plan_url_payload_once(url, timeout_seconds=timeout_seconds)
        if not _safe_text(payload.get("load_error")):
            if attempt > 1:
                payload = dict(payload)
                payload["fetch_attempts"] = attempt
            return payload
        if attempt < max_attempts:
            time.sleep(max(float(retry_backoff_seconds), 0.0))
    if max_attempts > 1:
        payload = dict(payload)
        payload["fetch_attempts"] = max_attempts
    return payload


def _load_plan(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any]]:
    plan_file = cast(Path | None, args.plan_json)
    plan_url = _safe_text(args.plan_url)
    selected_plan_sources = _confirmed_selected_plan_sources(
        getattr(args, "confirm_selected_plan_source", None)
    )
    if plan_file is None and plan_url is None:
        raise ValueError("paper_route_target_plan_source_required")
    if plan_file is not None and plan_url is not None:
        raise ValueError("paper_route_target_plan_single_source_required")

    if plan_file is not None:
        payload = _load_json_file(plan_file)
        plan, selected_plan = _materialization_plan_from_payload(
            payload,
            selected_plan_sources=selected_plan_sources,
        )
        if not plan:
            plan = payload
        return (
            dict(plan),
            {
                "kind": "file",
                "path": str(plan_file),
                "selected_plan": selected_plan,
            },
        )

    assert plan_url is not None
    payload = _fetch_plan_url_payload(
        plan_url,
        timeout_seconds=float(args.plan_url_timeout_seconds),
        attempts=max(int(args.plan_url_attempts), 1),
    )
    load_error = _safe_text(payload.get("load_error"))
    if load_error:
        raise ValueError(load_error)
    plan, selected_plan = _materialization_plan_from_payload(
        payload,
        selected_plan_sources=selected_plan_sources,
    )
    if not plan:
        raise ValueError("paper_route_target_plan_missing")
    return (
        dict(plan),
        {
            "kind": "url",
            "url": plan_url,
            "selected_plan": selected_plan,
            "fetch_attempts": payload.get("fetch_attempts"),
        },
    )


def _unique_texts(values: Sequence[object]) -> list[str]:
    return sorted({text for value in values if (text := _safe_text(value))})


def _target_runtime_strategy_confirmation_names(
    target: Mapping[str, Any],
) -> list[str]:
    names: list[object] = [
        target.get("runtime_strategy_name"),
        target.get("strategy_name"),
    ]
    target_lookup_names = target.get("strategy_lookup_names")
    if isinstance(target_lookup_names, Sequence) and not isinstance(
        target_lookup_names, (str, bytes)
    ):
        names.extend(target_lookup_names)
    readiness = target.get("source_decision_readiness")
    if isinstance(readiness, Mapping):
        lookup_names = readiness.get("strategy_lookup_names")
        if isinstance(lookup_names, Sequence) and not isinstance(
            lookup_names, (str, bytes)
        ):
            names.extend(lookup_names)
        matched_strategy = readiness.get("matched_strategy")
        if isinstance(matched_strategy, Mapping):
            names.append(matched_strategy.get("strategy_name"))
            names.append(matched_strategy.get("name"))
    return _unique_texts(names)


def _target_summaries(plan: Mapping[str, Any]) -> list[dict[str, Any]]:
    summaries: list[dict[str, Any]] = []
    for index, target in enumerate(paper_route_target_plan_targets(plan)):
        actions = _target_symbol_actions(target)
        quantities = _target_symbol_quantities(target)
        target_notional = _target_notional(target)
        capacity_contract = _to_str_map(
            target.get("paper_route_execution_capacity_contract")
        )
        bounded_evidence_collection_authorized = _truthy(
            target.get("bounded_evidence_collection_authorized")
        )
        summaries.append(
            {
                "target_index": index,
                "hypothesis_id": _safe_text(target.get("hypothesis_id")),
                "candidate_id": _safe_text(target.get("candidate_id")),
                "runtime_strategy_name": _safe_text(target.get("runtime_strategy_name"))
                or _safe_text(target.get("strategy_name")),
                "runtime_strategy_confirmation_names": (
                    _target_runtime_strategy_confirmation_names(target)
                ),
                "strategy_name": _safe_text(target.get("strategy_name")),
                "account_label": _safe_text(target.get("account_label")),
                "target_plan_ref": _target_plan_ref(target),
                "source_manifest_ref": _safe_text(target.get("source_manifest_ref")),
                "window_start": _target_window_start(target),
                "window_end": _target_window_end(target),
                "bounded_collection_stage": _safe_text(
                    target.get("bounded_collection_stage")
                )
                or _safe_text(target.get("evidence_collection_stage"))
                or _safe_text(target.get("observed_stage")),
                "target_notional": _decimal_text(target_notional),
                "target_quantity": _decimal_text(_target_quantity(target)),
                "bounded_evidence_collection_authorized": (
                    bounded_evidence_collection_authorized
                ),
                "bounded_materialization_authorized": (
                    _target_bounded_materialization_authorized(target)
                ),
                "evidence_collection_ok": _truthy(target.get("evidence_collection_ok")),
                "execution_capacity_state": _safe_text(capacity_contract.get("state")),
                "execution_capacity_blockers": (
                    paper_route_target_execution_capacity_blockers(target)
                ),
                "symbols": sorted(actions),
                "symbol_actions": actions,
                "symbol_quantities": {
                    symbol: _decimal_text(quantity)
                    for symbol, quantity in sorted(quantities.items())
                },
            }
        )
    return summaries


def _active_target_window_check(
    summaries: Sequence[Mapping[str, Any]],
    *,
    now: datetime,
) -> dict[str, Any]:
    normalized_now = now.astimezone(timezone.utc)
    targets: list[dict[str, Any]] = []
    active_count = 0
    missing_count = 0
    inactive_count = 0
    for summary in summaries:
        target_index = int(summary.get("target_index", 0))
        window_start = _parse_utc_datetime(summary.get("window_start"))
        window_end = _parse_utc_datetime(summary.get("window_end"))
        if window_start is None or window_end is None:
            state = "missing_window"
            missing_count += 1
        elif window_start <= normalized_now < window_end:
            state = "open"
            active_count += 1
        else:
            state = "not_open"
            inactive_count += 1
        targets.append(
            {
                "target_index": target_index,
                "state": state,
                "window_start": summary.get("window_start"),
                "window_end": summary.get("window_end"),
            }
        )
    return {
        "schema_version": "torghut.bounded-paper-route-target-window-check.v1",
        "now_utc": normalized_now.isoformat(),
        "required": bool(summaries),
        "active": bool(summaries) and active_count == len(summaries),
        "active_count": active_count,
        "missing_count": missing_count,
        "inactive_count": inactive_count,
        "target_count": len(summaries),
        "targets": targets,
    }


def _target_window_check_active_indexes(
    target_window_check: Mapping[str, Any] | None,
) -> list[int]:
    if not isinstance(target_window_check, Mapping):
        return []
    indexes: list[int] = []
    for target in cast(Sequence[object], target_window_check.get("targets", [])):
        if not isinstance(target, Mapping):
            continue
        target_mapping = cast(Mapping[str, Any], target)
        if _safe_text(target_mapping.get("state")) != "open":
            continue
        indexes.append(int(target_mapping.get("target_index", 0)))
    return indexes


def _plan_with_target_indexes(
    plan: Mapping[str, Any],
    target_indexes: Sequence[int],
) -> dict[str, Any]:
    selected_indexes = set(target_indexes)
    return {
        **dict(plan),
        "targets": [
            target
            for index, target in enumerate(paper_route_target_plan_targets(plan))
            if index in selected_indexes
        ],
    }


def _confirmed_selected_plan_sources(value: object) -> set[str]:
    text = _safe_text(value)
    if text is None:
        return set()
    return {item.strip() for item in text.split(",") if item.strip()}


def _confirmed_dynamic_target_filters(args: argparse.Namespace) -> dict[str, str]:
    if not bool(args.commit) or not bool(args.allow_dynamic_target_plan):
        return {}
    filters = {
        "hypothesis_id": _safe_text(args.confirm_hypothesis_id),
        "runtime_strategy_name": _safe_text(args.confirm_runtime_strategy_name),
        "candidate_id": _safe_text(args.confirm_candidate_id),
        "target_plan_ref": _safe_text(args.confirm_target_plan_ref),
    }
    return {field: value for field, value in filters.items() if value}
