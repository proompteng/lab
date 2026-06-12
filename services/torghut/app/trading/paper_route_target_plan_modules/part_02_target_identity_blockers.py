# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
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

from ...config import settings
from ...models import Strategy, TradeDecision, coerce_json_payload
from ..runtime_decision_authority import (
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    source_decision_mode_is_profit_proof_eligible,
)

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_26 import *


def _target_identity_blockers(identity: Mapping[str, Any]) -> list[str]:
    required = (
        "hypothesis_id",
        "candidate_id",
        "runtime_strategy_name",
        "account_label",
        "source_plan_ref",
        "target_notional",
        "bounded_collection_stage",
    )
    blockers = [
        f"paper_route_target_identity_{field}_missing"
        for field in required
        if not _safe_text(identity.get(field))
        or (field == "target_notional" and _safe_decimal(identity.get(field)) <= 0)
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


def _hpairs_materialization_blockers(identity: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    if (
        _safe_text(identity.get("hypothesis_id"))
        != PAPER_ROUTE_MATERIALIZATION_HPAIRS_HYPOTHESIS_ID
    ):
        blockers.append("paper_route_target_hpairs_hypothesis_required")
    return blockers


def _source_decision_readiness_blockers(target: Mapping[str, Any]) -> list[str]:
    readiness = target.get("source_decision_readiness")
    if not isinstance(readiness, Mapping):
        return ["paper_route_source_decision_readiness_missing"]

    typed_readiness = cast(Mapping[str, Any], readiness)
    blockers = _text_items(typed_readiness.get("blockers"))
    if not _truthy(typed_readiness.get("ready")):
        blockers.insert(0, "paper_route_source_decision_not_ready")
    return sorted(dict.fromkeys(blockers))


def _target_materialization_blockers(
    target: Mapping[str, Any],
    *,
    identity: Mapping[str, Any],
    bounded_notional_limit: Decimal,
) -> list[str]:
    blockers = _target_identity_blockers(identity)
    blockers.extend(_hpairs_materialization_blockers(identity))
    blockers.extend(_clean_window_baseline_blockers(target))
    blockers.extend(_source_decision_readiness_blockers(target))
    blockers.extend(paper_route_target_execution_capacity_blockers(target))
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
    if missing_quantity_symbols and target_notional <= 0:
        blockers.append("paper_route_target_symbol_quantities_missing")
    return sorted(dict.fromkeys(blockers))


def paper_route_target_execution_capacity_blockers(
    target: Mapping[str, Any],
) -> list[str]:
    contract = _to_str_map(target.get("paper_route_execution_capacity_contract"))
    target_notional = _target_notional(target)
    explicit_quantities = _target_symbol_quantities(target)
    if target_notional > 0 and not explicit_quantities and not contract:
        return ["paper_route_execution_capacity_contract_missing"]
    if not contract:
        return []

    blockers: list[str] = []
    raw_blockers = contract.get("blockers")
    if isinstance(raw_blockers, Sequence) and not isinstance(
        raw_blockers, (str, bytes, bytearray)
    ):
        blockers.extend(
            item_text
            for item in cast(Sequence[object], raw_blockers)
            if (item_text := _safe_text(item))
        )
    state = _safe_text(contract.get("state"))
    if state != "capacity_ready":
        blockers.append("paper_route_execution_capacity_not_ready")
    return sorted({item for item in blockers if item})


def _blocked_target_readiness(blockers: Sequence[str]) -> dict[str, Any]:
    blocker_set = {blocker for blocker in blockers if blocker}
    if "paper_route_target_notional_exceeds_bounded_collection_limit" in blocker_set:
        next_action = "reduce_notional"
    elif any(
        blocker.startswith("paper_route_execution_capacity") for blocker in blocker_set
    ):
        next_action = "repair_execution_capacity_contract"
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


def _paper_route_source_materialization_blockers(
    payload: object,
    *,
    identity: Mapping[str, Any],
) -> list[str]:
    payload_mapping = _to_str_map(payload)
    params = _to_str_map(payload_mapping.get("params"))
    source_metadata = _to_str_map(params.get("paper_route_target_plan_source_decision"))
    if not source_metadata:
        source_metadata = _to_str_map(payload_mapping.get("paper_route_target_plan"))
    required_values = {
        "hypothesis_id": identity.get("hypothesis_id"),
        "candidate_id": identity.get("candidate_id"),
        "runtime_strategy_name": identity.get("runtime_strategy_name"),
        "account_label": PAPER_ROUTE_MATERIALIZATION_ACCOUNT_LABEL,
        "bounded_collection_stage": PAPER_ROUTE_MATERIALIZATION_STAGE,
        "source_plan_ref": identity.get("source_plan_ref"),
    }
    blockers: list[str] = []
    for key, expected in required_values.items():
        expected_text = _safe_text(expected)
        observed_text = (
            _safe_text(payload_mapping.get(key))
            or _safe_text(params.get(key))
            or _safe_text(source_metadata.get(key))
        )
        if expected_text is None:
            blockers.append(f"paper_route_target_plan_expected_{key}_missing")
        elif observed_text != expected_text:
            blockers.append(f"paper_route_source_decision_{key}_missing")
    mode = (
        _safe_text(payload_mapping.get("source_decision_mode"))
        or _safe_text(params.get("source_decision_mode"))
        or _safe_text(source_metadata.get("source_decision_mode"))
    )
    if mode != BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE:
        blockers.append("paper_route_source_decision_mode_missing")
    expected_decision_strategy_id = _safe_text(
        identity.get("strategy_id")
    ) or _safe_text(identity.get("runtime_strategy_name"))
    observed_decision_strategy_id = _safe_text(payload_mapping.get("strategy_id"))
    if expected_decision_strategy_id and (
        observed_decision_strategy_id != expected_decision_strategy_id
    ):
        blockers.append("paper_route_source_decision_strategy_id_missing")
    if not bool(payload_mapping.get("final_promotion_allowed") is False) or not bool(
        params.get("final_promotion_allowed") is False
    ):
        blockers.append("paper_route_source_decision_final_promotion_not_blocked")
    return sorted(dict.fromkeys(blockers))


def _paper_route_source_decision_needs_refresh(
    existing: TradeDecision,
    *,
    identity: Mapping[str, Any],
) -> bool:
    if existing.alpaca_account_label != PAPER_ROUTE_MATERIALIZATION_ACCOUNT_LABEL:
        return True
    if _safe_text(existing.status) != "planned":
        return False
    return bool(
        _paper_route_source_materialization_blockers(
            existing.decision_json,
            identity=identity,
        )
    )


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
    decision_strategy_id = _safe_text(identity.get("strategy_id")) or _safe_text(
        identity.get("runtime_strategy_name")
    )
    explicit_symbol_quantities = _target_symbol_quantities(target)
    quantity_source = (
        "target_plan_explicit_quantity"
        if symbol in explicit_symbol_quantities
        else "target_notional_runtime_sizing_seed"
    )
    target_notional_sizing_required = (
        target_notional > 0 and symbol not in explicit_symbol_quantities
    )
    source_decision_metadata: dict[str, Any] = {
        "mode": "paper_route_target_plan_source_decision",
        "source": PAPER_ROUTE_MATERIALIZATION_SOURCE,
        "source_decision_mode": source_decision_mode,
        "profit_proof_eligible": source_decision_mode_is_profit_proof_eligible(
            source_decision_mode
        ),
        "profit_proof_eligible_scope": "bounded_paper_collection_only",
        "stage": PAPER_ROUTE_MATERIALIZATION_STAGE,
        "observed_stage": "paper",
        "hypothesis_id": identity.get("hypothesis_id"),
        "candidate_id": identity.get("candidate_id"),
        "runtime_strategy_name": identity.get("runtime_strategy_name"),
        "strategy_name": identity.get("strategy_name"),
        "strategy_id": identity.get("strategy_id"),
        "account_label": identity.get("account_label"),
        "source_account_label": identity.get("source_account_label"),
        "source_kind": identity.get("source_kind"),
        "source_plan_ref": identity.get("source_plan_ref"),
        "source_manifest_ref": identity.get("source_manifest_ref"),
        "symbol": symbol,
        "action": action,
        "paper_route_probe_leg_action": action,
        "qty": _decimal_text(quantity),
        "target_quantity": _decimal_text(quantity),
        "target_notional": _decimal_text(target_notional),
        "target_quantity_source": quantity_source,
        "target_notional_sizing_required": target_notional_sizing_required,
        "paper_route_probe_next_session_max_notional": _decimal_text(target_notional),
        "paper_route_probe_effective_max_notional": _decimal_text(target_notional),
        "paper_route_probe_window_start": identity.get("window_start"),
        "paper_route_probe_window_end": identity.get("window_end"),
        "paper_route_probe_symbols": sorted(_target_symbol_actions(target)),
        "paper_route_probe_symbol_actions": _target_symbol_actions(target),
        "paper_route_probe_symbol_quantity_source": quantity_source,
        "paper_route_probe_symbol_quantities": {
            item_symbol: _decimal_text(item_quantity)
            for item_symbol, item_quantity in sorted(explicit_symbol_quantities.items())
        },
        "bounded_collection_stage": PAPER_ROUTE_MATERIALIZATION_STAGE,
        "bounded_evidence_collection_authorized": True,
        "bounded_live_paper_collection_authorized": True,
        "canary_collection_authorized": True,
        "evidence_collection_ok": True,
        "bounded_evidence_collection_scope": "paper_route_probe_next_session_only",
        "capital_promotion_allowed": False,
        "promotion_allowed": False,
        "final_authority_ok": False,
        "final_promotion_authorized": False,
        "final_promotion_allowed": False,
        "live_capital_routing_enabled": False,
        "account_stage_runtime_identity": {
            "account_label": identity.get("account_label"),
            "source_account_label": identity.get("source_account_label"),
            "observed_stage": "paper",
            "runtime_strategy_name": identity.get("runtime_strategy_name"),
            "source_kind": identity.get("source_kind"),
        },
    }
    for key in (
        "source_decision_readiness",
        "paper_route_target_account_audit_state",
        "paper_route_target_account_audit_blockers",
        "paper_route_account_pre_session_blockers",
        "paper_route_account_contamination_blockers",
        "paper_route_clean_window_baseline_state",
        "paper_route_clean_window_baseline_blockers",
        "paper_route_clean_window_state",
        "paper_route_probe_pair_balance_state",
        "runtime_window_import_health_gate_blockers",
        "bounded_evidence_collection_blockers",
        "price_snapshot",
        "executable_quote",
        "quote",
        "nbbo",
        "market_snapshot",
        "paper_route_probe_symbol_quotes",
        "source_symbol_quotes",
        "symbol_quotes",
        "executable_quotes",
        "price_snapshots",
        "latest_quotes",
    ):
        if key in target:
            source_decision_metadata[key] = target[key]

    return {
        "schema_version": PAPER_ROUTE_MATERIALIZATION_SCHEMA_VERSION,
        "source": PAPER_ROUTE_MATERIALIZATION_SOURCE,
        "source_decision_mode": source_decision_mode,
        "source_decision_mode_profit_proof_eligible": (
            source_decision_mode_is_profit_proof_eligible(source_decision_mode)
        ),
        "profit_proof_eligible_scope": "bounded_paper_collection_only",
        "stage": PAPER_ROUTE_MATERIALIZATION_STAGE,
        "observed_stage": "paper",
        "hypothesis_id": identity.get("hypothesis_id"),
        "candidate_id": identity.get("candidate_id"),
        "strategy_id": decision_strategy_id,
        "runtime_strategy_name": identity.get("runtime_strategy_name"),
        "strategy_name": identity.get("strategy_name"),
        "account_label": identity.get("account_label"),
        "source_account_label": identity.get("source_account_label"),
        "source_kind": identity.get("source_kind"),
        "source_plan_ref": identity.get("source_plan_ref"),
        "source_manifest_ref": identity.get("source_manifest_ref"),
        "target_plan_identity": identity,
        "symbol": symbol,
        "action": action,
        "qty": _decimal_text(quantity),
        "target_quantity": _decimal_text(quantity),
        "target_notional": _decimal_text(target_notional),
        "target_quantity_source": quantity_source,
        "target_notional_sizing_required": target_notional_sizing_required,
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
            "target_quantity_source": quantity_source,
            "target_notional_sizing_required": target_notional_sizing_required,
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
        "final_authority_ok": False,
        "final_promotion_authorized": False,
        "final_promotion_allowed": False,
        "final_promotion_blockers": list(
            PAPER_ROUTE_MATERIALIZATION_FINAL_PROMOTION_BLOCKERS
        ),
        "live_capital_routing_enabled": False,
        "route_submission_enabled": True,
        "params": {
            "paper_route_target_plan_materialized": True,
            "paper_route_target_plan": source_decision_metadata,
            "paper_route_target_plan_source_decision": source_decision_metadata,
            "paper_route_probe": source_decision_metadata,
            "source_decision_mode": source_decision_mode,
            "profit_proof_eligible": source_decision_mode_is_profit_proof_eligible(
                source_decision_mode
            ),
            "candidate_id": identity.get("candidate_id"),
            "hypothesis_id": identity.get("hypothesis_id"),
            "runtime_strategy_name": identity.get("runtime_strategy_name"),
            "source_account_label": identity.get("source_account_label"),
            "source_kind": identity.get("source_kind"),
            "source_plan_ref": identity.get("source_plan_ref"),
            "target_notional": _decimal_text(target_notional),
            "target_quantity": _decimal_text(quantity),
            "target_quantity_source": quantity_source,
            "target_notional_sizing_required": target_notional_sizing_required,
            "bounded_collection_stage": PAPER_ROUTE_MATERIALIZATION_STAGE,
            "promotion_allowed": False,
            "final_authority_ok": False,
            "final_promotion_authorized": False,
            "final_promotion_allowed": False,
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
    repaired_decision_count = 0
    existing_decision_count = 0
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
            quantity = _target_source_decision_quantities(target)[symbol]
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
            else:
                existing_decision_count += 1
                if _paper_route_source_decision_needs_refresh(
                    existing,
                    identity=identity,
                ):
                    existing.strategy_id = strategy.id
                    existing.symbol = symbol
                    existing.timeframe = "1Min"
                    existing.decision_json = coerce_json_payload(payload)
                    existing.rationale = (
                        "bounded H-PAIRS paper-route target materialization; "
                        "live-capital routing disabled"
                    )
                    session.add(existing)
                    session.flush()
                    repaired_decision_count += 1
            integrity_blockers = _paper_route_source_materialization_blockers(
                existing.decision_json,
                identity=identity,
            )
            if integrity_blockers:
                blocked_targets.append(
                    {
                        "target_index": target_index,
                        "hypothesis_id": identity.get("hypothesis_id"),
                        "candidate_id": identity.get("candidate_id"),
                        "symbol": symbol,
                        "blockers": integrity_blockers,
                        "readiness": _blocked_target_readiness(integrity_blockers),
                        "target_identity": identity,
                        "trade_decision_id": str(existing.id),
                    }
                )
                continue
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
                    "final_authority_ok": False,
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
        "source_decision_count": len(materialized_decisions),
        "target_plan_source_decision_count": len(materialized_decisions),
        "existing_decision_count": existing_decision_count,
        "repaired_decision_count": repaired_decision_count,
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
        "final_authority_ok": False,
        "final_promotion_authorized": False,
        "final_promotion_allowed": False,
        "live_capital_routing_enabled": False,
        "blocked_targets": blocked_targets,
    }


__all__ = [
    "fetch_paper_route_target_plan_url",
    "materialize_bounded_paper_route_target_plan",
    "mapping_items",
    "paper_route_target_execution_capacity_blockers",
    "paper_route_target_plan_from_payload",
    "paper_route_target_plan_probe_symbols",
    "paper_route_target_plan_targets",
]


__all__ = [name for name in globals() if not name.startswith("__")]
