"""Execution TCA lineage hash helpers."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Collection, Mapping
from decimal import Decimal
from typing import cast

from ...models import Execution, TradeDecision
from .adaptive_policy import decimal_or_none

_EXECUTION_POLICY_HASH_KEYS = (
    "execution_policy_hash",
    "execution_policy_sha256",
    "policy_hash",
)

_EXECUTION_POLICY_PRIMARY_PAYLOAD_KEYS = (
    "execution_policy",
    "execution_policy_context",
)

_EXECUTION_POLICY_ADVISORY_PAYLOAD_KEYS = (
    "execution_advisor",
    "_execution_advice_provenance",
)

_LINEAGE_HASH_KEYS = (
    "lineage_hash",
    "candidate_lineage_hash",
    "replay_lineage_hash",
    "candidate_evaluation_key",
    "replay_data_hash",
    "replay_tape_content_sha256",
    "dataset_snapshot_hash",
    "source_query_digest",
)


def mapping_from_any(value: object | None) -> dict[str, object]:
    if not isinstance(value, Mapping):
        return {}
    mapping = cast(Mapping[object, object], value)
    return {str(key): item for key, item in mapping.items()}


def _observed_broker_order_policy_hash(*, execution: Execution) -> str | None:
    raw_order = mapping_from_any(execution.raw_order)
    if not raw_order:
        return None

    side = text_from_payload(raw_order, "side")
    order_type = text_from_payload(raw_order, "order_type", "type")
    time_in_force = text_from_payload(raw_order, "time_in_force")
    broker_order_id = (
        text_from_payload(raw_order, "id")
        or str(execution.alpaca_order_id or "").strip()
    )
    submitted_qty = text_from_payload(raw_order, "qty")
    notional = text_from_payload(raw_order, "notional")
    if not side or not order_type or not time_in_force or not broker_order_id:
        return None
    if not submitted_qty and notional is None:
        return None

    policy_payload = {
        "source": "observed_broker_order_execution_policy",
        "broker": "alpaca",
        "alpaca_account_label": execution.alpaca_account_label,
        "alpaca_order_id": broker_order_id,
        "client_order_id": text_from_payload(raw_order, "client_order_id")
        or execution.client_order_id,
        "symbol": text_from_payload(raw_order, "symbol") or execution.symbol,
        "side": side,
        "order_type": order_type,
        "time_in_force": time_in_force,
        "submitted_qty": submitted_qty,
        "notional": notional,
        "limit_price": text_from_payload(raw_order, "limit_price"),
        "stop_price": text_from_payload(raw_order, "stop_price"),
        "extended_hours": raw_order.get("extended_hours"),
        "order_class": text_from_payload(raw_order, "order_class"),
        "position_intent": text_from_payload(raw_order, "position_intent"),
    }
    return stable_payload_digest(
        {key: value for key, value in policy_payload.items() if value is not None}
    )


def execution_policy_hash_candidates(
    *,
    source_payloads: Collection[Mapping[str, object]],
    decision: TradeDecision | None,
    decision_payload: Mapping[str, object],
    execution: Execution,
    source_fields: dict[str, object],
) -> set[str]:
    explicit_hashes = hash_candidates(
        source_payloads,
        hash_keys=_EXECUTION_POLICY_HASH_KEYS,
        payload_keys=(),
    )
    if explicit_hashes:
        if len(explicit_hashes) == 1:
            source_fields["execution_policy_hash"] = (
                _existing_lineage_source_field(source_payloads, "execution_policy_hash")
                or "execution_policy_hash"
            )
        return explicit_hashes

    payload_hashes = hash_candidates(
        source_payloads,
        hash_keys=(),
        payload_keys=_EXECUTION_POLICY_PRIMARY_PAYLOAD_KEYS,
    )
    if payload_hashes:
        if len(payload_hashes) == 1:
            source_fields["execution_policy_hash"] = "execution_policy_payload"
        return payload_hashes

    payload_hashes = hash_candidates(
        source_payloads,
        hash_keys=(),
        payload_keys=_EXECUTION_POLICY_ADVISORY_PAYLOAD_KEYS,
    )
    if payload_hashes:
        if len(payload_hashes) == 1:
            source_fields["execution_policy_hash"] = "execution_policy_advisor_payload"
        return payload_hashes

    decision_policy_hash = _decision_execution_policy_hash(
        decision=decision,
        decision_payload=decision_payload,
        execution=execution,
    )
    if decision_policy_hash is not None:
        source_fields["execution_policy_hash"] = (
            "trade_decisions.decision_json+executions.order_fields"
        )
        return {decision_policy_hash}

    observed_order_policy_hash = _observed_broker_order_policy_hash(execution=execution)
    if observed_order_policy_hash is None:
        return set()
    source_fields["execution_policy_hash"] = "executions.raw_order_observed_policy"
    return {observed_order_policy_hash}


def _existing_lineage_source_field(
    payloads: Collection[Mapping[str, object]], key: str
) -> object | None:
    for payload in payloads:
        source_fields = payload.get("source_fields")
        if not isinstance(source_fields, Mapping):
            continue
        source_field = cast(Mapping[object, object], source_fields).get(key)
        if source_field is not None:
            return source_field
    return None


def hash_candidates(
    payloads: Collection[Mapping[str, object]],
    *,
    hash_keys: Collection[str],
    payload_keys: Collection[str],
) -> set[str]:
    candidates: set[str] = set()
    for payload in payloads:
        for key in hash_keys:
            text = text_from_payload(payload, key)
            if text is not None:
                candidates.add(text)
        for key in payload_keys:
            value = payload.get(key)
            if value is not None and (digest := stable_payload_digest(value)):
                candidates.add(digest)
    return candidates


def resolve_lineage_hash(
    *,
    source_payloads: Collection[Mapping[str, object]],
    execution: Execution,
    decision: TradeDecision | None,
) -> str:
    explicit_hashes = hash_candidates(
        source_payloads,
        hash_keys=_LINEAGE_HASH_KEYS,
        payload_keys=("lineage", "candidate_lineage", "source_lineage"),
    )
    if len(explicit_hashes) == 1:
        return next(iter(explicit_hashes))
    return stable_payload_digest(
        {
            "alpaca_account_label": execution.alpaca_account_label,
            "alpaca_order_id": execution.alpaca_order_id,
            "client_order_id": execution.client_order_id,
            "decision_hash": decision.decision_hash if decision is not None else None,
            "execution_id": str(execution.id),
            "trade_decision_id": str(execution.trade_decision_id)
            if execution.trade_decision_id
            else None,
        }
    )


def stable_payload_digest(value: object) -> str:
    body = json.dumps(value, default=str, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def text_from_payload(payload: Mapping[str, object], *keys: str) -> str | None:
    for key in keys:
        text = str(payload.get(key) or "").strip()
        if text:
            return text
    return None


def non_negative_decimal(value: object | None) -> Decimal | None:
    parsed = decimal_or_none(value)
    if parsed is None or parsed < 0:
        return None
    return parsed


def dedupe_texts(values: Collection[str]) -> list[str]:
    deduped: list[str] = []
    for value in values:
        text = value.strip()
        if text and text not in deduped:
            deduped.append(text)
    return deduped


def _decision_execution_policy_hash(
    *,
    decision: TradeDecision | None,
    decision_payload: Mapping[str, object],
    execution: Execution,
) -> str | None:
    if decision is None:
        return None
    action = (
        text_from_payload(decision_payload, "action")
        or str(execution.side or "").strip()
    )
    order_type = (
        text_from_payload(decision_payload, "order_type")
        or str(execution.order_type or "").strip()
    )
    time_in_force = (
        text_from_payload(decision_payload, "time_in_force")
        or str(execution.time_in_force or "").strip()
    )
    if not action or not order_type or not time_in_force:
        return None
    policy_payload = {
        "source": "trade_decision_execution_policy",
        "decision_hash": decision.decision_hash,
        "strategy_id": str(decision.strategy_id) if decision.strategy_id else None,
        "symbol": decision.symbol or execution.symbol,
        "action": action,
        "order_type": order_type,
        "time_in_force": time_in_force,
        "limit_price": text_from_payload(decision_payload, "limit_price"),
        "stop_price": text_from_payload(decision_payload, "stop_price"),
        "submission_stage": text_from_payload(decision_payload, "submission_stage"),
    }
    return stable_payload_digest(
        {key: value for key, value in policy_payload.items() if value is not None}
    )


__all__ = [
    "dedupe_texts",
    "execution_policy_hash_candidates",
    "hash_candidates",
    "mapping_from_any",
    "non_negative_decimal",
    "resolve_lineage_hash",
    "stable_payload_digest",
    "text_from_payload",
]
