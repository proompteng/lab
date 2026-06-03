#!/usr/bin/env python3
"""Safely materialize bounded H-PAIRS paper-route targets into TORGHUT_SIM."""

from __future__ import annotations

import argparse
import json
import os
import time
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from http.client import HTTPConnection, HTTPSConnection
from pathlib import Path
from typing import Any, cast
from urllib.parse import urlsplit

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.models import Base, Strategy
from app.trading.paper_route_target_plan import (
    PAPER_ROUTE_MATERIALIZATION_ACCOUNT_LABEL,
    PAPER_ROUTE_MATERIALIZATION_HPAIRS_HYPOTHESIS_ID,
    materialize_bounded_paper_route_target_plan,
    paper_route_target_plan_targets,
)

SCHEMA_VERSION = "torghut.bounded-paper-route-target-materialization-cli.v1"
OPERATOR_CONFIRMATION = "MATERIALIZE_BOUNDED_TORGHUT_SIM_PAPER_ROUTE_TARGETS"
DEFAULT_DYNAMIC_SELECTED_PLAN_SOURCE = (
    "live_submission_gate.runtime_ledger_paper_probation_import_plan"
)
DEFAULT_DYNAMIC_SELECTED_PLAN_SOURCES = (
    DEFAULT_DYNAMIC_SELECTED_PLAN_SOURCE,
    "runtime_ledger_paper_probation_import_plan",
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


def _target_materialization_score(target: Mapping[str, Any]) -> tuple[int, int, int]:
    return (
        int(
            _safe_text(target.get("hypothesis_id"))
            == PAPER_ROUTE_MATERIALIZATION_HPAIRS_HYPOTHESIS_ID
        ),
        int(
            bool(_target_symbol_actions(target))
            and _target_notional(target) > 0
            and _target_quantity(target) > 0
        ),
        int(_truthy(target.get("bounded_evidence_collection_authorized"))),
    )


def _plan_materialization_score(plan: Mapping[str, Any]) -> tuple[int, int, int, int]:
    hpairs = 0
    materializable_shape = 0
    bounded_authorized = 0
    targets = paper_route_target_plan_targets(plan)
    for target in targets:
        target_hpairs, target_shape, target_authorized = _target_materialization_score(
            target
        )
        hpairs += target_hpairs
        materializable_shape += target_shape
        bounded_authorized += target_authorized
    return (hpairs, materializable_shape, bounded_authorized, len(targets))


def _candidate_materialization_plans(
    payload: Mapping[str, Any],
) -> list[tuple[str, dict[str, Any]]]:
    return [
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
) -> tuple[dict[str, Any], str | None]:
    best_plan: dict[str, Any] = {}
    best_source: str | None = None
    best_score = (0, 0, 0, 0)
    for source, plan in _candidate_materialization_plans(payload):
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
    if plan_file is None and plan_url is None:
        raise ValueError("paper_route_target_plan_source_required")
    if plan_file is not None and plan_url is not None:
        raise ValueError("paper_route_target_plan_single_source_required")

    if plan_file is not None:
        payload = _load_json_file(plan_file)
        plan, selected_plan = _materialization_plan_from_payload(payload)
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
    plan, selected_plan = _materialization_plan_from_payload(payload)
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


def _target_summaries(plan: Mapping[str, Any]) -> list[dict[str, Any]]:
    summaries: list[dict[str, Any]] = []
    for index, target in enumerate(paper_route_target_plan_targets(plan)):
        actions = _target_symbol_actions(target)
        quantities = _target_symbol_quantities(target)
        target_notional = _target_notional(target)
        summaries.append(
            {
                "target_index": index,
                "hypothesis_id": _safe_text(target.get("hypothesis_id")),
                "candidate_id": _safe_text(target.get("candidate_id")),
                "runtime_strategy_name": _safe_text(target.get("runtime_strategy_name"))
                or _safe_text(target.get("strategy_name")),
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


def _unique_texts(values: Sequence[object]) -> list[str]:
    return sorted({text for value in values if (text := _safe_text(value))})


def _confirmed_selected_plan_sources(value: object) -> set[str]:
    text = _safe_text(value)
    if text is None:
        return set()
    return {item.strip() for item in text.split(",") if item.strip()}


def _plan_flag_blockers(plan: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    for field in PROMOTION_FLAG_FIELDS:
        if _truthy(plan.get(field)):
            blockers.append(f"paper_route_materialization_plan_{field}_must_be_false")
    for index, target in enumerate(paper_route_target_plan_targets(plan)):
        for field in PROMOTION_FLAG_FIELDS:
            if _truthy(target.get(field)):
                blockers.append(
                    f"paper_route_materialization_target_{index}_{field}_must_be_false"
                )
    return blockers


def _confirmation_blockers(
    *,
    args: argparse.Namespace,
    summaries: Sequence[Mapping[str, Any]],
    plan_source: Mapping[str, Any],
    dsn_env: str,
) -> list[str]:
    if not bool(args.commit):
        return []

    blockers: list[str] = []
    dynamic_target_plan = bool(args.allow_dynamic_target_plan)
    confirmations = {
        "account_label": (
            _safe_text(args.confirm_account_label),
            PAPER_ROUTE_MATERIALIZATION_ACCOUNT_LABEL,
        ),
        "dsn_env": (_safe_text(args.confirm_dsn_env), dsn_env),
        "hypothesis_id": (
            _safe_text(args.confirm_hypothesis_id),
            ",".join(_unique_texts([item.get("hypothesis_id") for item in summaries])),
        ),
        "runtime_strategy_name": (
            _safe_text(args.confirm_runtime_strategy_name),
            ",".join(
                _unique_texts([item.get("runtime_strategy_name") for item in summaries])
            ),
        ),
        "max_notional": (
            _safe_text(args.confirm_max_notional),
            _safe_text(args.max_notional),
        ),
    }
    for name, (observed, expected) in confirmations.items():
        if expected is None or not observed or observed != expected:
            blockers.append(
                f"paper_route_materialization_commit_confirm_{name}_missing"
            )

    if not dynamic_target_plan:
        exact_confirmations = {
            "candidate_id": (
                _safe_text(args.confirm_candidate_id),
                ",".join(
                    _unique_texts([item.get("candidate_id") for item in summaries])
                ),
            ),
            "target_plan_ref": (
                _safe_text(args.confirm_target_plan_ref),
                ",".join(
                    _unique_texts([item.get("target_plan_ref") for item in summaries])
                ),
            ),
        }
        for name, (observed, expected) in exact_confirmations.items():
            if expected is None or not observed or observed != expected:
                blockers.append(
                    f"paper_route_materialization_commit_confirm_{name}_missing"
                )
    else:
        selected_plan = _safe_text(plan_source.get("selected_plan"))
        confirmed_selected_plans = _confirmed_selected_plan_sources(
            args.confirm_selected_plan_source
        )
        if (
            not selected_plan
            or not confirmed_selected_plans
            or selected_plan not in confirmed_selected_plans
        ):
            blockers.append(
                "paper_route_materialization_commit_confirm_selected_plan_source_missing"
            )
        minimum_target_count = int(args.confirm_target_count_min or 0)
        if minimum_target_count <= 0 or len(summaries) < minimum_target_count:
            blockers.append(
                "paper_route_materialization_commit_confirm_target_count_min_missing"
            )

    if _safe_text(args.operator_confirmation) != OPERATOR_CONFIRMATION:
        blockers.append("paper_route_materialization_operator_confirmation_missing")
    return blockers


def _safety_blockers(
    *,
    args: argparse.Namespace,
    plan: Mapping[str, Any],
    plan_source: Mapping[str, Any],
    summaries: Sequence[Mapping[str, Any]],
    dsn: str | None,
    dsn_env: str,
) -> list[str]:
    blockers: list[str] = []
    account_label = _safe_text(args.account_label)
    if account_label != PAPER_ROUTE_MATERIALIZATION_ACCOUNT_LABEL:
        blockers.append("paper_route_materialization_account_label_must_be_torghut_sim")
    if account_label and any(
        marker in account_label.upper() for marker in LIVE_LABEL_MARKERS
    ):
        blockers.append("paper_route_materialization_live_account_label_rejected")
    if not dsn:
        blockers.append("paper_route_materialization_database_dsn_env_missing")

    max_notional = _safe_decimal(args.max_notional)
    if max_notional <= 0:
        blockers.append("paper_route_materialization_bounded_max_notional_required")

    capital_mode = _safe_text(args.capital_mode) or ""
    if capital_mode.lower() in {"live", "prod", "production", "real"}:
        blockers.append("paper_route_materialization_non_live_capital_mode_required")
    for flag_name in (
        "promotion_allowed",
        "final_promotion_allowed",
        "final_authority_ok",
        "capital_promotion_allowed",
    ):
        if bool(getattr(args, flag_name)):
            blockers.append(
                f"paper_route_materialization_request_{flag_name}_must_be_false"
            )

    blockers.extend(_plan_flag_blockers(plan))
    if not summaries:
        blockers.append("paper_route_materialization_target_plan_targets_missing")

    for summary in summaries:
        index = int(summary.get("target_index", 0))
        target_account_label = _safe_text(summary.get("account_label"))
        if target_account_label != PAPER_ROUTE_MATERIALIZATION_ACCOUNT_LABEL:
            blockers.append(
                f"paper_route_materialization_target_{index}_account_label_must_be_torghut_sim"
            )
        if target_account_label and any(
            marker in target_account_label.upper() for marker in LIVE_LABEL_MARKERS
        ):
            blockers.append(
                f"paper_route_materialization_target_{index}_live_account_label_rejected"
            )
        for field in (
            "hypothesis_id",
            "candidate_id",
            "runtime_strategy_name",
            "target_plan_ref",
            "bounded_collection_stage",
        ):
            if not _safe_text(summary.get(field)):
                blockers.append(
                    f"paper_route_materialization_target_{index}_{field}_missing"
                )
        target_notional = _safe_decimal(summary.get("target_notional"))
        if target_notional <= 0:
            blockers.append(
                f"paper_route_materialization_target_{index}_target_notional_missing"
            )
        elif max_notional > 0 and target_notional > max_notional:
            blockers.append(
                f"paper_route_materialization_target_{index}_target_notional_exceeds_max"
            )
        if _safe_decimal(summary.get("target_quantity")) <= 0:
            blockers.append(
                f"paper_route_materialization_target_{index}_target_quantity_missing"
            )
        if not cast(Sequence[object], summary.get("symbols", [])):
            blockers.append(
                f"paper_route_materialization_target_{index}_symbol_actions_missing"
            )

    blockers.extend(
        _confirmation_blockers(
            args=args,
            summaries=summaries,
            plan_source=plan_source,
            dsn_env=dsn_env,
        )
    )
    return sorted(dict.fromkeys(blockers))


def _session_factory(dsn: str) -> sessionmaker[Session]:
    engine = create_engine(_sqlalchemy_dsn(dsn), pool_pre_ping=True, future=True)
    return sessionmaker(
        bind=engine,
        autoflush=False,
        expire_on_commit=False,
        future=True,
    )


def _sqlalchemy_dsn(dsn: str) -> str:
    text = dsn.strip()
    if text.startswith("postgresql+psycopg://"):
        return text
    if text.startswith("postgres://"):
        return text.replace("postgres://", "postgresql+psycopg://", 1)
    if text.startswith("postgresql://"):
        return text.replace("postgresql://", "postgresql+psycopg://", 1)
    return text


def _strategy_names_from_summaries(
    summaries: Sequence[Mapping[str, Any]],
) -> list[str]:
    return _unique_texts([item.get("runtime_strategy_name") for item in summaries])


def _copy_preview_strategies(
    *,
    source_session: Session,
    preview_session: Session,
    strategy_names: Sequence[str],
) -> None:
    if not strategy_names:
        return
    strategies = list(
        source_session.execute(
            select(Strategy).where(Strategy.name.in_(list(strategy_names)))
        )
        .scalars()
        .all()
    )
    for strategy in strategies:
        preview_session.add(
            Strategy(
                name=strategy.name,
                description=strategy.description,
                enabled=strategy.enabled,
                base_timeframe=strategy.base_timeframe,
                universe_type=strategy.universe_type,
                universe_symbols=strategy.universe_symbols,
                max_position_pct_equity=strategy.max_position_pct_equity,
                max_notional_per_trade=strategy.max_notional_per_trade,
            )
        )
    preview_session.commit()


def _run_dry_run_materialization(
    *,
    source_session: Session,
    plan: Mapping[str, Any],
    max_notional: Decimal,
    summaries: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    preview_engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    try:
        Base.metadata.create_all(preview_engine)
        preview_session_factory = sessionmaker(
            bind=preview_engine,
            autoflush=False,
            expire_on_commit=False,
            future=True,
        )
        with preview_session_factory() as preview_session:
            _copy_preview_strategies(
                source_session=source_session,
                preview_session=preview_session,
                strategy_names=_strategy_names_from_summaries(summaries),
            )
            return _run_materialization(
                session=preview_session,
                plan=plan,
                max_notional=max_notional,
                commit=False,
            )
    finally:
        preview_engine.dispose()


def _run_materialization(
    *,
    session: Session,
    plan: Mapping[str, Any],
    max_notional: Decimal,
    commit: bool,
) -> dict[str, Any]:
    result = materialize_bounded_paper_route_target_plan(
        session,
        plan,
        generated_at=datetime.now(timezone.utc),
        bounded_notional_limit=max_notional,
    )
    if commit and not result.get("blockers"):
        session.commit()
    else:
        session.rollback()
    return result


def build_report(args: argparse.Namespace) -> tuple[int, dict[str, Any]]:
    dsn_env = _safe_text(args.database_dsn_env) or "DB_DSN"
    dsn = _safe_text(os.environ.get(dsn_env))
    max_notional = _safe_decimal(args.max_notional)
    commit = bool(args.commit)
    dry_run = not commit

    try:
        plan, plan_source = _load_plan(args)
        load_blockers: list[str] = []
    except Exception as exc:
        plan = {}
        plan_source = {"kind": "unavailable"}
        load_blockers = [f"paper_route_materialization_plan_load_failed:{exc}"]

    source_plan = plan
    source_summaries = _target_summaries(source_plan)
    materialization_plan = source_plan
    summaries = source_summaries
    active_target_window_filter_applied = False
    target_window_check: dict[str, Any] | None = None
    skip_reason: str | None = None
    if bool(args.skip_unless_active_target_window) or bool(
        args.require_active_target_window
    ):
        target_window_check = _active_target_window_check(
            source_summaries,
            now=_resolve_now_utc(args),
        )
        active_target_indexes = _target_window_check_active_indexes(target_window_check)
        if active_target_indexes and len(active_target_indexes) < len(source_summaries):
            materialization_plan = _plan_with_target_indexes(
                source_plan,
                active_target_indexes,
            )
            summaries = _target_summaries(materialization_plan)
            active_target_window_filter_applied = True

    blockers = load_blockers + _safety_blockers(
        args=args,
        plan=materialization_plan,
        plan_source=plan_source,
        summaries=summaries,
        dsn=dsn,
        dsn_env=dsn_env,
    )
    if target_window_check is not None and not _target_window_check_active_indexes(
        target_window_check
    ):
        if bool(args.skip_unless_active_target_window) and not blockers:
            skip_reason = ACTIVE_TARGET_WINDOW_SKIP_REASON
        else:
            blockers.append(ACTIVE_TARGET_WINDOW_REQUIRED_BLOCKER)

    materialization: dict[str, Any] = {}
    if not blockers and skip_reason is None and dsn is not None:
        try:
            factory = _session_factory(dsn)
            with factory() as session:
                if commit:
                    materialization = _run_materialization(
                        session=session,
                        plan=materialization_plan,
                        max_notional=max_notional,
                        commit=True,
                    )
                else:
                    materialization = _run_dry_run_materialization(
                        source_session=session,
                        plan=materialization_plan,
                        max_notional=max_notional,
                        summaries=summaries,
                    )
            blockers.extend(str(item) for item in materialization.get("blockers", []))
        except Exception as exc:
            blockers.append(f"paper_route_materialization_database_failed:{exc}")

    blockers = sorted(dict.fromkeys(blockers))
    report = {
        "schema_version": SCHEMA_VERSION,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "mode": "commit" if commit else "dry_run",
        "dry_run": dry_run,
        "commit": commit,
        "skipped": skip_reason is not None,
        "skip_reason": skip_reason,
        "materialized": commit and not blockers and skip_reason is None,
        "account_label": _safe_text(args.account_label),
        "required_account_label": PAPER_ROUTE_MATERIALIZATION_ACCOUNT_LABEL,
        "database_dsn_env": dsn_env,
        "database_dsn_configured": bool(dsn),
        "plan_source": plan_source,
        "max_notional": _decimal_text(max_notional),
        "capital_mode": _safe_text(args.capital_mode),
        "promotion_allowed": False,
        "final_authority_ok": False,
        "final_promotion_allowed": False,
        "capital_promotion_allowed": False,
        "operator_confirmation_required": OPERATOR_CONFIRMATION if commit else None,
        "dynamic_target_plan_confirmation": bool(args.allow_dynamic_target_plan),
        "default_dynamic_selected_plan_source": DEFAULT_DYNAMIC_SELECTED_PLAN_SOURCE,
        "target_window_check": target_window_check,
        "active_target_window_filter_applied": active_target_window_filter_applied,
        "source_target_count": len(source_summaries),
        "target_count": len(summaries),
        "hypothesis_ids": _unique_texts(
            [item.get("hypothesis_id") for item in summaries]
        ),
        "candidate_ids": _unique_texts(
            [item.get("candidate_id") for item in summaries]
        ),
        "runtime_strategy_names": _unique_texts(
            [item.get("runtime_strategy_name") for item in summaries]
        ),
        "target_plan_refs": _unique_texts(
            [item.get("target_plan_ref") for item in summaries]
        ),
        "targets": summaries,
        "source_targets": source_summaries
        if active_target_window_filter_applied
        else None,
        "materialization": materialization,
        "materialized_decision_count": int(
            materialization.get("materialized_decision_count", 0)
        ),
        "route_submission_count": int(materialization.get("route_submission_count", 0)),
        "blockers": blockers,
        "blocked": bool(blockers),
    }
    return (2 if blockers else 0), report


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Materialize bounded H-PAIRS paper-route target-plan rows for "
            "TORGHUT_SIM evidence collection. Defaults to dry-run and rolls back all "
            "database writes unless --commit and every confirmation are supplied."
        )
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--plan-json", type=Path, default=None)
    source.add_argument("--plan-url", default=None)
    parser.add_argument("--plan-url-timeout-seconds", type=float, default=5.0)
    parser.add_argument("--plan-url-attempts", type=int, default=1)
    parser.add_argument("--database-dsn-env", default="DB_DSN")
    parser.add_argument(
        "--account-label", default=PAPER_ROUTE_MATERIALIZATION_ACCOUNT_LABEL
    )
    parser.add_argument("--max-notional", default=None)
    parser.add_argument("--capital-mode", default="paper")
    parser.add_argument("--dry-run", action="store_true", default=True)
    parser.add_argument("--commit", action="store_true")
    parser.add_argument("--promotion-allowed", action="store_true")
    parser.add_argument("--final-promotion-allowed", action="store_true")
    parser.add_argument("--final-authority-ok", action="store_true")
    parser.add_argument("--capital-promotion-allowed", action="store_true")
    parser.add_argument("--confirm-account-label", default=None)
    parser.add_argument("--confirm-dsn-env", default=None)
    parser.add_argument("--confirm-hypothesis-id", default=None)
    parser.add_argument("--confirm-candidate-id", default=None)
    parser.add_argument("--confirm-runtime-strategy-name", default=None)
    parser.add_argument("--confirm-target-plan-ref", default=None)
    parser.add_argument("--confirm-selected-plan-source", default=None)
    parser.add_argument("--confirm-target-count-min", type=int, default=None)
    parser.add_argument("--confirm-max-notional", default=None)
    parser.add_argument("--allow-dynamic-target-plan", action="store_true")
    target_window = parser.add_mutually_exclusive_group()
    target_window.add_argument(
        "--skip-unless-active-target-window", action="store_true"
    )
    target_window.add_argument("--require-active-target-window", action="store_true")
    parser.add_argument("--now-utc", default=None)
    parser.add_argument("--operator-confirmation", default=None)
    parser.add_argument("--output", type=Path, default=None)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    exit_code, report = build_report(args)
    payload = json.dumps(report, indent=2, sort_keys=True, default=_json_default)
    output_path = cast(Path | None, args.output)
    if output_path is not None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(payload + "\n", encoding="utf-8")
    print(payload)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
