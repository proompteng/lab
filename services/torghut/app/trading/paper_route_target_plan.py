"""Helpers for external paper-route runtime-window target plans."""

from __future__ import annotations

import json
import time
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from hashlib import sha256
from http.client import HTTPConnection, HTTPSConnection
from typing import Any, cast
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import Strategy, TradeDecision, coerce_json_payload
from .runtime_decision_authority import (
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    source_decision_mode_is_profit_proof_eligible,
)


PAPER_ROUTE_MATERIALIZATION_SCHEMA_VERSION = (
    "torghut.paper-route-target-materialization.v1"
)
PAPER_ROUTE_MATERIALIZATION_ACCOUNT_LABEL = "TORGHUT_SIM"
PAPER_ROUTE_MATERIALIZATION_STAGE = "bounded_paper_collection"
PAPER_ROUTE_MATERIALIZATION_SOURCE = "paper_route_target_plan_materializer"
PAPER_ROUTE_MATERIALIZATION_FINAL_PROMOTION_BLOCKERS = (
    "paper_route_bounded_collection_only",
    "runtime_ledger_live_or_live_paper_required",
    "paper_route_runtime_ledger_import_pending",
)


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
    next_clean_after_discard_plan = _to_str_map(
        payload.get("next_clean_paper_route_runtime_window_targets_after_discard")
    )
    runtime_window_plan = _to_str_map(payload.get("runtime_window_import_plan"))
    source_runtime_window_plan = _to_str_map(
        payload.get("source_runtime_window_import_plan")
    )
    next_paper_route_plan = _to_str_map(
        payload.get("next_paper_route_runtime_window_targets")
    )
    candidate_plans = [
        next_clean_after_discard_plan,
        next_paper_route_plan,
        source_runtime_window_plan,
        runtime_window_plan,
        _to_str_map(live_gate.get("runtime_ledger_paper_probation_import_plan")),
        _to_str_map(payload.get("runtime_ledger_paper_probation_import_plan")),
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
    attempts: int = 1,
    retry_backoff_seconds: float = 0.25,
) -> dict[str, Any]:
    max_attempts = max(int(attempts), 1)
    result: dict[str, Any] = {}
    for attempt in range(1, max_attempts + 1):
        result = _fetch_paper_route_target_plan_url_once(
            url,
            timeout_seconds=timeout_seconds,
        )
        if not str(result.get("load_error") or "").strip():
            if attempt > 1:
                result = dict(result)
                result["fetch_attempts"] = attempt
            return result
        if attempt < max_attempts:
            time.sleep(max(float(retry_backoff_seconds), 0.0))

    if max_attempts > 1:
        result = dict(result)
        result["fetch_attempts"] = max_attempts
    return result


def _fetch_paper_route_target_plan_url_once(
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
        host_header = parsed.netloc or parsed.hostname
        connection.request(
            "GET",
            path,
            headers={
                "Accept": "application/json",
                "Connection": "close",
                "Host": host_header,
            },
        )
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


def _safe_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _safe_decimal(value: object) -> Decimal:
    if value is None:
        return Decimal("0")
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal("0")


def _decimal_text(value: Decimal) -> str:
    return format(value, "f")


def _positive_decimal_from_fields(
    payload: Mapping[str, Any],
    fields: Sequence[str],
) -> Decimal:
    for field in fields:
        value = _safe_decimal(payload.get(field))
        if value > 0:
            return value
    return Decimal("0")


def _text_items(value: object) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    return [
        str(item).strip() for item in cast(Sequence[object], value) if str(item).strip()
    ]


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
    fallback_quantity = _positive_decimal_from_fields(
        target,
        (
            "target_quantity",
            "paper_route_probe_target_quantity",
            "qty",
            "quantity",
        ),
    )
    if fallback_quantity > 0:
        for symbol in _target_symbol_actions(target):
            quantities.setdefault(symbol, fallback_quantity)
    return quantities


def _target_notional(target: Mapping[str, Any]) -> Decimal:
    return _positive_decimal_from_fields(
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
    explicit_quantity = _positive_decimal_from_fields(
        target,
        (
            "target_quantity",
            "paper_route_probe_target_quantity",
            "qty",
            "quantity",
        ),
    )
    if explicit_quantity > 0:
        return explicit_quantity
    return sum(_target_symbol_quantities(target).values(), Decimal("0"))


def _configured_bounded_collection_limit(
    *,
    bounded_notional_limit: Decimal | int | float | str | None,
) -> Decimal:
    if bounded_notional_limit is not None:
        return _safe_decimal(bounded_notional_limit)
    return _safe_decimal(settings.trading_simple_paper_route_probe_max_notional)


def _clean_window_baseline_blockers(target: Mapping[str, Any]) -> list[str]:
    state = _to_str_map(target.get("paper_route_clean_window_baseline_state"))
    blockers = _text_items(target.get("paper_route_clean_window_baseline_blockers"))
    if not blockers:
        blockers = _text_items(state.get("blockers"))
    baseline_state = _safe_text(state.get("state"))
    if baseline_state != "clean":
        blockers.append("paper_route_clean_window_baseline_missing_or_dirty")
    if _safe_text(target.get("paper_route_clean_window_state")) not in {
        "clean_window_collection_ready",
        "clean",
    }:
        blockers.append("paper_route_clean_window_gate_not_passed")
    return sorted(dict.fromkeys(blockers))


def _target_identity(
    target: Mapping[str, Any],
    *,
    target_index: int,
) -> dict[str, Any]:
    source_plan_ref = (
        _safe_text(target.get("source_plan_ref"))
        or _safe_text(target.get("source_plan_id"))
        or _safe_text(target.get("source_manifest_ref"))
        or _safe_text(target.get("paper_route_target_plan_source"))
    )
    bounded_collection_stage = (
        _safe_text(target.get("bounded_collection_stage"))
        or _safe_text(target.get("evidence_collection_stage"))
        or _safe_text(target.get("observed_stage"))
    )
    return {
        "schema_version": "torghut.paper-route-target-identity.v1",
        "target_index": target_index,
        "hypothesis_id": _safe_text(target.get("hypothesis_id")),
        "candidate_id": _safe_text(target.get("candidate_id")),
        "runtime_strategy_name": _safe_text(target.get("runtime_strategy_name"))
        or _safe_text(target.get("strategy_name")),
        "strategy_name": _safe_text(target.get("strategy_name")),
        "strategy_id": _safe_text(target.get("strategy_id")),
        "account_label": _safe_text(target.get("account_label")),
        "source_plan_ref": source_plan_ref,
        "source_manifest_ref": _safe_text(target.get("source_manifest_ref")),
        "target_notional": _decimal_text(_target_notional(target)),
        "target_quantity": _decimal_text(_target_quantity(target)),
        "target_symbol_quantities": {
            symbol: _decimal_text(quantity)
            for symbol, quantity in sorted(_target_symbol_quantities(target).items())
        },
        "bounded_collection_stage": bounded_collection_stage,
        "window_start": _safe_text(target.get("window_start"))
        or _safe_text(target.get("paper_route_probe_window_start")),
        "window_end": _safe_text(target.get("window_end"))
        or _safe_text(target.get("paper_route_probe_window_end")),
        "source_kind": _safe_text(target.get("source_kind")),
        "paper_route_probe_symbols": sorted(_target_symbol_actions(target)),
    }


def _target_identity_blockers(identity: Mapping[str, Any]) -> list[str]:
    required = (
        "hypothesis_id",
        "candidate_id",
        "runtime_strategy_name",
        "account_label",
        "source_plan_ref",
        "target_notional",
        "target_quantity",
        "bounded_collection_stage",
    )
    blockers = [
        f"paper_route_target_identity_{field}_missing"
        for field in required
        if not _safe_text(identity.get(field))
        or (field == "target_notional" and _safe_decimal(identity.get(field)) <= 0)
        or (field == "target_quantity" and _safe_decimal(identity.get(field)) <= 0)
    ]
    if (
        _safe_text(identity.get("account_label"))
        != PAPER_ROUTE_MATERIALIZATION_ACCOUNT_LABEL
    ):
        blockers.append("paper_route_target_torghut_sim_account_required")
    if _safe_text(identity.get("bounded_collection_stage")) not in {
        "paper",
        PAPER_ROUTE_MATERIALIZATION_STAGE,
        "bounded_live_paper_collection",
    }:
        blockers.append("paper_route_target_bounded_collection_stage_required")
    return blockers


def _target_materialization_blockers(
    target: Mapping[str, Any],
    *,
    identity: Mapping[str, Any],
    bounded_notional_limit: Decimal,
) -> list[str]:
    blockers = _target_identity_blockers(identity)
    blockers.extend(_clean_window_baseline_blockers(target))
    if not bool(target.get("evidence_collection_ok")):
        blockers.append("paper_route_evidence_collection_gate_not_passed")
    if not bool(target.get("bounded_evidence_collection_authorized")):
        blockers.append("paper_route_bounded_collection_not_authorized")
    target_notional = _safe_decimal(identity.get("target_notional"))
    if bounded_notional_limit <= 0:
        blockers.append("paper_route_bounded_collection_limit_missing")
    elif target_notional > bounded_notional_limit:
        blockers.append("paper_route_target_notional_exceeds_bounded_collection_limit")
    actions = _target_symbol_actions(target)
    quantities = _target_symbol_quantities(target)
    if not actions:
        blockers.append("paper_route_target_symbol_actions_missing")
    missing_quantity_symbols = sorted(
        symbol for symbol in actions if symbol not in quantities
    )
    if missing_quantity_symbols:
        blockers.append("paper_route_target_symbol_quantities_missing")
    return sorted(dict.fromkeys(blockers))


def _blocked_target_readiness(blockers: Sequence[str]) -> dict[str, Any]:
    blocker_set = {blocker for blocker in blockers if blocker}
    if "paper_route_target_notional_exceeds_bounded_collection_limit" in blocker_set:
        next_action = "reduce_notional"
    elif (
        "paper_route_target_symbol_actions_missing" in blocker_set
        or "paper_route_target_symbol_quantities_missing" in blocker_set
        or "paper_route_target_bounded_collection_stage_required" in blocker_set
        or "paper_route_target_torghut_sim_account_required" in blocker_set
    ):
        next_action = "skip_symbol"
    elif (
        "paper_route_evidence_collection_gate_not_passed" in blocker_set
        or "paper_route_bounded_collection_not_authorized" in blocker_set
    ):
        next_action = "wait_for_fresh_quote"
    else:
        next_action = "refresh_source_snapshot"
    return {
        "schema_version": "torghut.paper-route-target-plan-readiness.v1",
        "state": "blocked",
        "blockers": list(blockers),
        "next_operator_action": next_action,
        "promotion_allowed": False,
        "final_authority_ok": False,
        "final_promotion_allowed": False,
    }


def _paper_route_decision_hash(payload: Mapping[str, Any]) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return sha256(canonical.encode("utf-8")).hexdigest()


def _paper_route_decision_payload(
    *,
    target: Mapping[str, Any],
    identity: Mapping[str, Any],
    symbol: str,
    action: str,
    quantity: Decimal,
    target_notional: Decimal,
    generated_at: datetime,
) -> dict[str, Any]:
    source_decision_mode = BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
    return {
        "schema_version": PAPER_ROUTE_MATERIALIZATION_SCHEMA_VERSION,
        "source": PAPER_ROUTE_MATERIALIZATION_SOURCE,
        "source_decision_mode": source_decision_mode,
        "source_decision_mode_profit_proof_eligible": (
            source_decision_mode_is_profit_proof_eligible(source_decision_mode)
        ),
        "profit_proof_eligible_scope": "bounded_paper_collection_only",
        "hypothesis_id": identity.get("hypothesis_id"),
        "candidate_id": identity.get("candidate_id"),
        "runtime_strategy_name": identity.get("runtime_strategy_name"),
        "strategy_name": identity.get("strategy_name"),
        "account_label": identity.get("account_label"),
        "source_plan_ref": identity.get("source_plan_ref"),
        "source_manifest_ref": identity.get("source_manifest_ref"),
        "target_plan_identity": identity,
        "symbol": symbol,
        "action": action,
        "qty": _decimal_text(quantity),
        "target_quantity": _decimal_text(quantity),
        "target_notional": _decimal_text(target_notional),
        "bounded_collection_stage": PAPER_ROUTE_MATERIALIZATION_STAGE,
        "bounded_evidence_collection_max_notional": _safe_text(
            target.get("bounded_evidence_collection_max_notional")
        )
        or _safe_text(target.get("paper_route_probe_effective_max_notional")),
        "order_type": "market",
        "time_in_force": "day",
        "timeframe": "1Min",
        "event_ts": generated_at.isoformat(),
        "submission_stage": "bounded_paper_route_materialized",
        "paper_route_order_submission": {
            "schema_version": "torghut.paper-route-order-submission.v1",
            "account_label": PAPER_ROUTE_MATERIALIZATION_ACCOUNT_LABEL,
            "symbol": symbol,
            "side": action,
            "qty": _decimal_text(quantity),
            "target_notional": _decimal_text(target_notional),
            "order_type": "market",
            "time_in_force": "day",
            "live_capital_routing_enabled": False,
            "submission_enabled": True,
            "submission_authority": "bounded_paper_collection_only",
            "execution_adapter_scope": "paper_or_sim",
            "idempotency_key_basis": "trade_decision_hash_client_order_id",
            "order_feed_linkage_keys": [
                "alpaca_account_label",
                "client_order_id",
            ],
        },
        "capital_promotion_allowed": False,
        "promotion_allowed": False,
        "final_promotion_authorized": False,
        "final_promotion_allowed": False,
        "final_promotion_blockers": list(
            PAPER_ROUTE_MATERIALIZATION_FINAL_PROMOTION_BLOCKERS
        ),
        "live_capital_routing_enabled": False,
        "route_submission_enabled": True,
        "params": {
            "paper_route_target_plan_materialized": True,
            "source_decision_mode": source_decision_mode,
            "candidate_id": identity.get("candidate_id"),
            "hypothesis_id": identity.get("hypothesis_id"),
            "runtime_strategy_name": identity.get("runtime_strategy_name"),
            "source_plan_ref": identity.get("source_plan_ref"),
            "target_notional": _decimal_text(target_notional),
            "target_quantity": _decimal_text(quantity),
            "bounded_collection_stage": PAPER_ROUTE_MATERIALIZATION_STAGE,
            "live_capital_routing_enabled": False,
            "route_submission_enabled": True,
        },
    }


def materialize_bounded_paper_route_target_plan(
    session: Session,
    plan: Mapping[str, Any],
    *,
    generated_at: datetime | None = None,
    bounded_notional_limit: Decimal | int | float | str | None = None,
) -> dict[str, Any]:
    """Persist bounded paper-route target decisions without enabling live routing."""

    event_ts = generated_at or datetime.now(timezone.utc)
    if event_ts.tzinfo is None:
        event_ts = event_ts.replace(tzinfo=timezone.utc)
    event_ts = event_ts.astimezone(timezone.utc)
    limit = _configured_bounded_collection_limit(
        bounded_notional_limit=bounded_notional_limit
    )
    materialized_decisions: list[dict[str, Any]] = []
    route_submissions: list[dict[str, Any]] = []
    blocked_targets: list[dict[str, Any]] = []
    for target_index, target in enumerate(paper_route_target_plan_targets(plan)):
        identity = _target_identity(target, target_index=target_index)
        blockers = _target_materialization_blockers(
            target,
            identity=identity,
            bounded_notional_limit=limit,
        )
        if blockers:
            blocked_targets.append(
                {
                    "target_index": target_index,
                    "hypothesis_id": identity.get("hypothesis_id"),
                    "candidate_id": identity.get("candidate_id"),
                    "blockers": blockers,
                    "readiness": _blocked_target_readiness(blockers),
                    "target_identity": identity,
                }
            )
            continue
        strategy_name = _safe_text(identity.get("runtime_strategy_name"))
        strategy = (
            session.execute(select(Strategy).where(Strategy.name == strategy_name))
            .scalars()
            .first()
        )
        if strategy is None:
            blocked_targets.append(
                {
                    "target_index": target_index,
                    "hypothesis_id": identity.get("hypothesis_id"),
                    "candidate_id": identity.get("candidate_id"),
                    "blockers": ["paper_route_target_strategy_missing"],
                    "readiness": _blocked_target_readiness(
                        ["paper_route_target_strategy_missing"]
                    ),
                    "target_identity": identity,
                }
            )
            continue

        target_notional = _safe_decimal(identity.get("target_notional"))
        for symbol, action in _target_symbol_actions(target).items():
            quantity = _target_symbol_quantities(target)[symbol]
            payload = _paper_route_decision_payload(
                target=target,
                identity=identity,
                symbol=symbol,
                action=action,
                quantity=quantity,
                target_notional=target_notional,
                generated_at=event_ts,
            )
            digest = _paper_route_decision_hash(
                {
                    "source": PAPER_ROUTE_MATERIALIZATION_SOURCE,
                    "account_label": PAPER_ROUTE_MATERIALIZATION_ACCOUNT_LABEL,
                    "symbol": symbol,
                    "action": action,
                    "qty": _decimal_text(quantity),
                    "target_identity": identity,
                }
            )
            existing = (
                session.execute(
                    select(TradeDecision).where(
                        TradeDecision.decision_hash == digest,
                        TradeDecision.alpaca_account_label
                        == PAPER_ROUTE_MATERIALIZATION_ACCOUNT_LABEL,
                    )
                )
                .scalars()
                .first()
            )
            if existing is None:
                existing = TradeDecision(
                    strategy_id=strategy.id,
                    alpaca_account_label=PAPER_ROUTE_MATERIALIZATION_ACCOUNT_LABEL,
                    symbol=symbol,
                    timeframe="1Min",
                    decision_json=coerce_json_payload(payload),
                    rationale=(
                        "bounded H-PAIRS paper-route target materialization; "
                        "live-capital routing disabled"
                    ),
                    decision_hash=digest,
                    status="planned",
                    created_at=event_ts,
                )
                session.add(existing)
                session.flush()
            route_submission = dict(
                cast(Mapping[str, Any], payload["paper_route_order_submission"])
            )
            route_submission["client_order_id"] = digest
            route_submission["trade_decision_id"] = str(existing.id)
            route_submissions.append(route_submission)
            materialized_decisions.append(
                {
                    "trade_decision_id": str(existing.id),
                    "decision_hash": digest,
                    "symbol": symbol,
                    "action": action,
                    "qty": _decimal_text(quantity),
                    "target_notional": _decimal_text(target_notional),
                    "source_decision_mode": (
                        BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
                    ),
                    "target_identity": identity,
                    "promotion_allowed": False,
                    "final_promotion_authorized": False,
                    "live_capital_routing_enabled": False,
                }
            )

    return {
        "schema_version": PAPER_ROUTE_MATERIALIZATION_SCHEMA_VERSION,
        "source": PAPER_ROUTE_MATERIALIZATION_SOURCE,
        "source_decision_mode": BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
        "source_decision_mode_profit_proof_eligible": (
            source_decision_mode_is_profit_proof_eligible(
                BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
            )
        ),
        "profit_proof_eligible_scope": "bounded_paper_collection_only",
        "account_label": PAPER_ROUTE_MATERIALIZATION_ACCOUNT_LABEL,
        "bounded_collection_stage": PAPER_ROUTE_MATERIALIZATION_STAGE,
        "bounded_notional_limit": _decimal_text(limit),
        "target_count": len(paper_route_target_plan_targets(plan)),
        "materialized_decision_count": len(materialized_decisions),
        "route_submission_count": len(route_submissions),
        "blocked_target_count": len(blocked_targets),
        "blocked": bool(blocked_targets),
        "blockers": sorted(
            {
                blocker
                for item in blocked_targets
                for blocker in cast(Sequence[str], item.get("blockers", []))
            }
        ),
        "decisions": materialized_decisions,
        "route_submissions": route_submissions,
        "capital_promotion_allowed": False,
        "promotion_allowed": False,
        "final_promotion_authorized": False,
        "final_promotion_allowed": False,
        "live_capital_routing_enabled": False,
        "blocked_targets": blocked_targets,
    }


__all__ = [
    "fetch_paper_route_target_plan_url",
    "materialize_bounded_paper_route_target_plan",
    "mapping_items",
    "paper_route_target_plan_from_payload",
    "paper_route_target_plan_probe_symbols",
    "paper_route_target_plan_targets",
]
