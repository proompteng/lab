# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Profit freshness frontier projection for zero-notional repair selection."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import json
from typing import Any, cast

from ..market_context_domains import (
    active_market_context_mapping,
    active_market_context_reasons,
)

# ruff: noqa: F401,F403,F405,F811,F821

from .shared_context import (
    PROFIT_FRESHNESS_FRONTIER_SCHEMA_VERSION,
    _ALPHA_FEATURE_REPLAY_PRIORITY_BONUS,
    _ALPHA_FEATURE_REPLAY_REASON_CODES,
    _ALPHA_FEATURE_ROUTEABILITY_PRIORITY_BONUS,
    _ALPHA_READINESS_ROUTEABILITY_REASON_CODES,
    _BAD_STATES,
    _CURRENT_STATES,
    _DAILY_NET_PNL_UNLOCK_KEYS,
    _DIMENSION_ACTION,
    _DIMENSION_EXPECTED_BPS,
    _DIMENSION_REPAIR_CLASSES,
    _DIMENSION_REPAIR_COST,
    _DIMENSION_SUCCESS,
    _FRESHNESS_SECONDS,
    _NONBLOCKING_JANGAR_RELIABILITY_REASONS,
    _NONBLOCKING_QUANT_HEALTH_REASONS,
    _REPAIRABLE_DIMENSIONS,
    _REPAIR_COST_PENALTY,
    _ROUTEABILITY_ONLY_TCA_REASON_CODES,
    _ROUTEABILITY_ONLY_TCA_REASON_PREFIXES,
    _ROUTEABILITY_TCA_REPAIR_ACTION,
    _ROUTEABILITY_TCA_REPAIR_LOT_TYPES,
    _ROUTEABILITY_TCA_REPAIR_REASON_FRAGMENTS,
    _ROUTEABILITY_TCA_REPAIR_REASON_PREFIXES,
    _ROUTE_SETTLED_ROW_STATES,
    _bool,
    _decimal,
    _decimal_text,
    _dimension,
    _empirical_dimension,
    _float,
    _hypothesis_dimension,
    _hypothesis_ids_for_reasons,
    _hypothesis_items,
    _hypothesis_summary,
    _int,
    _mapping,
    _market_dimension,
    _market_domain_states,
    _proof_dimension,
    _reason_total,
    _route_rows,
    _route_symbols,
    _routeability_only_tca_reason,
    _sequence,
    _signal_dimension,
    _stable_ref,
    _state_from_reasons,
    _strings,
    _symbols,
    _text,
    _timestamp,
    _unique,
)


def _tca_dimension(
    *,
    proof_floor_receipt: Mapping[str, Any],
    routeability_ledger: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    generated_at: datetime,
) -> dict[str, object]:
    execution_tca = _proof_dimension(proof_floor_receipt, "execution_tca")
    route_lot: Mapping[str, Any] = {}
    for raw_lot in _sequence(routeability_ledger.get("lots")):
        lot = _mapping(raw_lot)
        if _text(lot.get("lot_type")) == "route_universe_tca_repair":
            route_lot = lot
            break
    proof_state = _text(execution_tca.get("state"), "missing").lower()
    reasons: list[str] = []
    if not execution_tca:
        reasons.append("execution_tca_missing")
    else:
        for reason in _strings(execution_tca.get("blocking_reason_codes")):
            if proof_state not in _CURRENT_STATES or not _routeability_only_tca_reason(
                reason
            ):
                reasons.append(reason)
    proof_reason = _text(execution_tca.get("reason"))
    if proof_state not in _CURRENT_STATES:
        if proof_reason:
            reasons.append(proof_reason)
        elif proof_state == "missing":
            reasons.append("execution_tca_missing")
        elif proof_state == "stale":
            reasons.append("execution_tca_stale")
        elif proof_state:
            reasons.append(f"execution_tca_{proof_state}")
    routeability_reasons: list[str] = [
        *_strings(routeability_ledger.get("aggregate_blocking_reason_codes")),
        *_strings(route_lot.get("blocking_reason_codes")),
    ]
    blocked_symbols: list[str] = []
    for row in _route_rows(route_reacquisition_board):
        row_state = _text(row.get("state")).lower()
        blocker = _text(row.get("current_blocker"))
        if blocker and row_state not in _ROUTE_SETTLED_ROW_STATES:
            routeability_reasons.append(blocker)
            if symbol := _text(row.get("symbol")).upper():
                blocked_symbols.append(symbol)
    freshness_seconds = _int(execution_tca.get("freshness_seconds"), default=-1)
    missing = proof_state == "missing" or any("missing" in reason for reason in reasons)
    stale = proof_state == "stale"
    return _dimension(
        name="tca_fill_quality",
        state=_state_from_reasons(
            reasons,
            missing=missing,
            stale=stale,
            blocked=proof_state in _BAD_STATES and not missing and not stale,
        ),
        generated_at=generated_at,
        reason_codes=reasons,
        evidence_refs=[
            _text(routeability_ledger.get("ledger_id"), "routeability_acceptance"),
            "execution_tca",
        ],
        blocking_hypotheses=_strings(route_lot.get("hypothesis_ids"))
        if reasons
        else [],
        staleness_seconds=None if freshness_seconds < 0 else freshness_seconds,
        observed_at=_mapping(execution_tca.get("source_ref")).get("last_computed_at"),
        details={
            "symbols": _route_symbols(route_reacquisition_board),
            "routeability_blocker_codes": _unique(routeability_reasons),
            "routeability_blocked_symbols": _unique(blocked_symbols),
        },
    )


def _route_readiness_dimension(
    *,
    routeability_ledger: Mapping[str, Any],
    generated_at: datetime,
) -> dict[str, object]:
    aggregate_state = _text(
        routeability_ledger.get("aggregate_state"), "missing"
    ).lower()
    accepted_count = _int(routeability_ledger.get("accepted_routeable_candidate_count"))
    reasons = [
        *_strings(routeability_ledger.get("aggregate_blocking_reason_codes")),
    ]
    if aggregate_state not in {"accepted", "current"}:
        reasons.append(f"routeability_acceptance_{aggregate_state}")
    if aggregate_state in {"accepted", "current"} and accepted_count <= 0:
        reasons.append("routeability_candidate_count_zero")
    return _dimension(
        name="route_readiness",
        state="current" if not reasons else _state_from_reasons(reasons, blocked=True),
        generated_at=generated_at,
        reason_codes=reasons,
        evidence_refs=[
            _text(routeability_ledger.get("ledger_id"), "routeability_acceptance")
        ],
        details={
            "accepted_routeable_candidate_count": accepted_count,
            "aggregate_state": aggregate_state,
        },
    )


def _is_routeability_tca_repair_reason(reason: str) -> bool:
    normalized = reason.strip().lower()
    return normalized.startswith(_ROUTEABILITY_TCA_REPAIR_REASON_PREFIXES) or any(
        fragment in normalized for fragment in _ROUTEABILITY_TCA_REPAIR_REASON_FRAGMENTS
    )


def _route_readiness_action(routeability_ledger: Mapping[str, Any]) -> str:
    for raw_lot in _sequence(routeability_ledger.get("lots")):
        lot = _mapping(raw_lot)
        if _text(lot.get("lot_type")) not in _ROUTEABILITY_TCA_REPAIR_LOT_TYPES:
            continue
        if _text(lot.get("current_state")).lower() in _CURRENT_STATES:
            continue
        if any(
            _is_routeability_tca_repair_reason(reason)
            for reason in _strings(lot.get("blocking_reason_codes"))
        ):
            return _ROUTEABILITY_TCA_REPAIR_ACTION
    return _DIMENSION_ACTION["route_readiness"]


def _zero_notional_action(
    dimension_name: str,
    *,
    routeability_ledger: Mapping[str, Any],
) -> str:
    if dimension_name == "route_readiness":
        return _route_readiness_action(routeability_ledger)
    return _DIMENSION_ACTION.get(dimension_name, "observe_profit_freshness_frontier")


def _schema_dimension(
    *,
    proof_floor_receipt: Mapping[str, Any],
    generated_at: datetime,
) -> dict[str, object]:
    reasons = [
        reason
        for reason in _strings(proof_floor_receipt.get("blocking_reasons"))
        if "schema" in reason or "migration" in reason or "lineage" in reason
    ]
    return _dimension(
        name="schema_migration_state",
        state=_state_from_reasons(reasons, missing=bool(reasons)),
        generated_at=generated_at,
        reason_codes=reasons,
        evidence_refs=[_text(proof_floor_receipt.get("schema_version"), "proof_floor")],
    )


def _jangar_dimension(
    *,
    jangar_reliability_settlement_ref: Mapping[str, Any],
    generated_at: datetime,
) -> dict[str, object]:
    decision = _text(
        jangar_reliability_settlement_ref.get("decision")
        or jangar_reliability_settlement_ref.get("state")
        or jangar_reliability_settlement_ref.get("status"),
        "missing",
    ).lower()
    state = _text(
        jangar_reliability_settlement_ref.get("state") or decision, "missing"
    ).lower()
    raw_reasons = [
        *_strings(jangar_reliability_settlement_ref.get("reason_codes")),
        *_strings(jangar_reliability_settlement_ref.get("blocking_reasons")),
        *_strings(jangar_reliability_settlement_ref.get("reasons")),
    ]
    reasons = [
        reason
        for reason in raw_reasons
        if reason not in _NONBLOCKING_JANGAR_RELIABILITY_REASONS
    ]
    if decision not in _CURRENT_STATES:
        reasons.append(f"jangar_reliability_settlement_{decision}")
    if state in _BAD_STATES and state != decision:
        reasons.append(f"jangar_reliability_settlement_{state}")
    return _dimension(
        name="jangar_settlement",
        state="current"
        if not reasons
        else _state_from_reasons(reasons, missing=decision == "missing", blocked=True),
        generated_at=generated_at,
        reason_codes=reasons,
        evidence_refs=[
            _text(
                jangar_reliability_settlement_ref.get("ledger_id")
                or jangar_reliability_settlement_ref.get("settlement_ref"),
                "jangar_reliability_settlement",
            )
        ],
        observed_at=jangar_reliability_settlement_ref.get("generated_at"),
        fresh_until=jangar_reliability_settlement_ref.get("fresh_until"),
        details={
            "decision": decision,
            "state": state,
            "source": jangar_reliability_settlement_ref.get("source"),
            "informational_reason_codes": [
                reason
                for reason in raw_reasons
                if reason in _NONBLOCKING_JANGAR_RELIABILITY_REASONS
            ],
        },
    )


def _confidence_for_state(state: str) -> Decimal:
    if state == "stale":
        return Decimal("0.90")
    if state == "degraded":
        return Decimal("0.70")
    if state == "missing":
        return Decimal("0.55")
    if state == "blocked":
        return Decimal("0.50")
    return Decimal("0")


def _routeability_confidence(routeability_ledger: Mapping[str, Any]) -> Decimal:
    state = _text(routeability_ledger.get("aggregate_state"), "missing").lower()
    if state == "accepted":
        return Decimal("1.00")
    if state in {"repairing", "stale"}:
        return Decimal("0.65")
    if state in {"blocked", "missing"}:
        return Decimal("0.45")
    return Decimal("0.55")


def _jangar_confidence(jangar_reliability_settlement_ref: Mapping[str, Any]) -> Decimal:
    decision = _text(
        jangar_reliability_settlement_ref.get("decision")
        or jangar_reliability_settlement_ref.get("state"),
        "missing",
    ).lower()
    if decision in _CURRENT_STATES:
        return Decimal("1.00")
    if decision in {"delay", "hold"}:
        return Decimal("0.45")
    if decision in {"block", "missing"}:
        return Decimal("0.15")
    return Decimal("0.30")


def _packet_dimension(packet: Mapping[str, Any]) -> str:
    explicit = _text(
        packet.get("blocked_dimension")
        or packet.get("dimension")
        or packet.get("repair_dimension")
    ).lower()
    if explicit in _DIMENSION_EXPECTED_BPS:
        return explicit
    repair_class = _text(
        packet.get("repair_class")
        or packet.get("lot_type")
        or packet.get("repair_type")
    ).lower()
    for dimension_name, repair_classes in _DIMENSION_REPAIR_CLASSES.items():
        if repair_class in repair_classes:
            return dimension_name
    return ""


def _packet_hypothesis_refs(packet: Mapping[str, Any]) -> list[str]:
    refs = [
        _text(packet.get(key))
        for key in (
            "hypothesis_ref",
            "hypothesis_id",
            "candidate_id",
            "strategy_id",
        )
    ]
    refs.extend(_strings(packet.get("hypothesis_ids")))
    refs.extend(_strings(packet.get("candidate_ids")))
    return _unique(refs)


def _packet_symbols(packet: Mapping[str, Any]) -> list[str]:
    symbols = [_text(packet.get("symbol")).upper()]
    symbols.extend(_symbols(packet.get("symbol_set")))
    symbols.extend(_symbols(packet.get("symbols")))
    return _unique(symbols)


def _daily_net_pnl_unlock(source: Mapping[str, Any]) -> Decimal | None:
    for key in _DAILY_NET_PNL_UNLOCK_KEYS:
        parsed = _decimal(source.get(key))
        if parsed is not None:
            return parsed
    for nested_key in (
        "profit_metrics",
        "metrics",
        "objective_scorecard",
        "scorecard",
        "selection_objectives",
    ):
        nested = _mapping(source.get(nested_key))
        for key in _DAILY_NET_PNL_UNLOCK_KEYS:
            parsed = _decimal(nested.get(key))
            if parsed is not None:
                return parsed
    return None


def _expected_daily_net_pnl_unlock(
    *,
    dimension_name: str,
    quality_adjusted_profit_frontier: Mapping[str, Any],
    blocking_hypotheses: Sequence[str],
    candidate_ids: Sequence[str],
    symbol_set: Sequence[str],
) -> tuple[Decimal | None, list[str]]:
    targets = set(blocking_hypotheses) | set(candidate_ids)
    symbols = {symbol.upper() for symbol in symbol_set if symbol}
    best_value: Decimal | None = None
    best_refs: list[str] = []

    for raw_packet in _sequence(quality_adjusted_profit_frontier.get("packets")):
        packet = _mapping(raw_packet)
        if _packet_dimension(packet) != dimension_name:
            continue
        value = _daily_net_pnl_unlock(packet)
        if value is None:
            continue
        packet_refs = _packet_hypothesis_refs(packet)
        if (
            targets
            and packet_refs
            and "global" not in packet_refs
            and targets.isdisjoint(packet_refs)
        ):
            continue
        packet_symbols = _packet_symbols(packet)
        if symbols and packet_symbols and symbols.isdisjoint(packet_symbols):
            continue
        packet_ref = _text(
            packet.get("packet_id")
            or packet.get("receipt_id")
            or packet.get("evidence_ref"),
            "quality_adjusted_profit_frontier",
        )
        if best_value is None or value > best_value:
            best_value = value
            best_refs = [packet_ref]
        elif value == best_value:
            best_refs.append(packet_ref)

    return best_value, _unique(best_refs)


def _target_notional_rankings(
    *,
    dimension_name: str,
    quality_adjusted_profit_frontier: Mapping[str, Any],
    blocking_hypotheses: Sequence[str],
    candidate_ids: Sequence[str],
    symbol_set: Sequence[str],
) -> list[dict[str, object]]:
    targets = set(blocking_hypotheses) | set(candidate_ids)
    symbols = {symbol.upper() for symbol in symbol_set if symbol}
    rankings: list[dict[str, object]] = []
    for raw_packet in _sequence(quality_adjusted_profit_frontier.get("packets")):
        packet = _mapping(raw_packet)
        if _packet_dimension(packet) != dimension_name:
            continue
        packet_refs = _packet_hypothesis_refs(packet)
        if (
            targets
            and packet_refs
            and "global" not in packet_refs
            and targets.isdisjoint(packet_refs)
        ):
            continue
        packet_symbols = _packet_symbols(packet)
        if symbols and packet_symbols and symbols.isdisjoint(packet_symbols):
            continue
        ranking = _mapping(packet.get("target_notional_ranking"))
        if not ranking:
            continue
        rankings.append(
            {
                "packet_ref": _text(
                    packet.get("packet_id")
                    or packet.get("receipt_id")
                    or packet.get("evidence_ref"),
                    "quality_adjusted_profit_frontier",
                ),
                "status": _text(ranking.get("status"), "blocked"),
                "target_daily_net_pnl": ranking.get("target_daily_net_pnl"),
                "observed_post_cost_expectancy_bps": ranking.get(
                    "observed_post_cost_expectancy_bps"
                ),
                "required_daily_notional": ranking.get("required_daily_notional"),
                "capacity_daily_notional": ranking.get("capacity_daily_notional"),
                "drawdown_budget": ranking.get("drawdown_budget"),
                "blocking_reasons": _strings(ranking.get("blocking_reasons")),
                "authority": "ranking_metadata_only",
            }
        )
    rankings.sort(
        key=lambda item: (
            0 if _text(item.get("status")) == "feasible" else 1,
            _float(item.get("required_daily_notional")) or 0.0,
            -(_float(item.get("observed_post_cost_expectancy_bps")) or 0.0),
            _text(item.get("packet_ref")),
        )
    )
    return rankings[:3]


def _repair_lot(
    *,
    dimension: Mapping[str, Any],
    routeability_ledger: Mapping[str, Any],
    quality_adjusted_profit_frontier: Mapping[str, Any],
    jangar_reliability_settlement_ref: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
) -> dict[str, object]:
    dimension_name = _text(dimension.get("dimension"))
    state = _text(dimension.get("state"), "unknown")
    repair_cost_class = _DIMENSION_REPAIR_COST.get(dimension_name, "medium")
    expected_bps = _DIMENSION_EXPECTED_BPS.get(dimension_name, Decimal("5"))
    reason_codes = _strings(dimension.get("reason_codes"))
    priority_adjustments: list[str] = []
    priority_bonus = Decimal("0")
    if dimension_name == "feature_coverage" and set(reason_codes).intersection(
        _ALPHA_FEATURE_REPLAY_REASON_CODES
    ):
        priority_adjustments.append("alpha_feature_replay_closure")
        priority_bonus += _ALPHA_FEATURE_REPLAY_PRIORITY_BONUS
        routeability_reasons = set(
            _strings(routeability_ledger.get("aggregate_blocking_reason_codes"))
        )
        if routeability_reasons.intersection(
            _ALPHA_READINESS_ROUTEABILITY_REASON_CODES
        ):
            priority_adjustments.append("alpha_readiness_routeability_closure")
            priority_bonus += _ALPHA_FEATURE_ROUTEABILITY_PRIORITY_BONUS
    blocking_hypotheses = _strings(dimension.get("blocking_hypotheses"))
    candidate_ids = _strings(empirical_jobs_status.get("candidate_ids"))
    symbol_set = _route_symbols(route_reacquisition_board)
    expected_daily_net_pnl_unlock, profit_unlock_refs = _expected_daily_net_pnl_unlock(
        dimension_name=dimension_name,
        quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
        blocking_hypotheses=blocking_hypotheses,
        candidate_ids=candidate_ids if dimension_name == "empirical_proof" else (),
        symbol_set=symbol_set,
    )
    target_rankings = _target_notional_rankings(
        dimension_name=dimension_name,
        quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
        blocking_hypotheses=blocking_hypotheses,
        candidate_ids=candidate_ids if dimension_name == "empirical_proof" else (),
        symbol_set=symbol_set,
    )
    expected_profit = expected_daily_net_pnl_unlock or expected_bps
    repair_priority = (
        expected_profit
        * _confidence_for_state(state)
        * _routeability_confidence(routeability_ledger)
        * _jangar_confidence(jangar_reliability_settlement_ref)
        - _REPAIR_COST_PENALTY.get(repair_cost_class, Decimal("5"))
        + priority_bonus
    )
    lot_id = _stable_ref(
        "profit-freshness-repair-lot",
        {
            "dimension": dimension_name,
            "state": state,
            "reason_codes": reason_codes,
            "hypotheses": blocking_hypotheses,
            "symbols": symbol_set,
        },
    )
    return {
        "lot_id": lot_id,
        "hypothesis_id": blocking_hypotheses[0] if blocking_hypotheses else None,
        "candidate_id": candidate_ids[0] if candidate_ids else None,
        "symbol_set": symbol_set,
        "blocked_dimension": dimension_name,
        "before_refs": _strings(dimension.get("evidence_refs")),
        "zero_notional_action": _zero_notional_action(
            dimension_name,
            routeability_ledger=routeability_ledger,
        ),
        "expected_profit_unlock_bps": float(expected_bps),
        "expected_daily_net_pnl_unlock": _decimal_text(expected_daily_net_pnl_unlock),
        "profit_unlock_refs": profit_unlock_refs,
        "target_notional_rankings": target_rankings,
        "target_notional_ranking_basis": "non_authoritative_candidate_comparison",
        "repair_priority": round(float(repair_priority), 4),
        "priority_adjustments": priority_adjustments,
        "repair_priority_basis": (
            "expected_daily_net_pnl_unlock"
            if expected_daily_net_pnl_unlock is not None
            else "expected_profit_unlock_bps_proxy"
        ),
        "repair_cost_class": repair_cost_class,
        "validation_window": "next_market_session",
        "success_criteria": _DIMENSION_SUCCESS.get(
            dimension_name, "dimension state becomes current"
        ),
        "guardrail_failures": [
            reason
            for reason in reason_codes
            if "guardrail" in reason or "slippage" in reason or "capital" in reason
        ],
        "after_refs": [],
        "state": "queued_zero_notional_repair",
        "paper_notional_limit": "0",
        "live_notional_limit": "0",
    }


__all__ = [name for name in globals() if not name.startswith("__")]
