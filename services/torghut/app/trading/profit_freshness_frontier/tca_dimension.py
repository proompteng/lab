"""Profit freshness frontier projection for zero-notional repair selection."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime
from decimal import Decimal
from typing import Any


from .shared_context import (
    ALPHA_FEATURE_REPLAY_PRIORITY_BONUS as _ALPHA_FEATURE_REPLAY_PRIORITY_BONUS,
    ALPHA_FEATURE_REPLAY_REASON_CODES as _ALPHA_FEATURE_REPLAY_REASON_CODES,
    ALPHA_FEATURE_ROUTEABILITY_PRIORITY_BONUS as _ALPHA_FEATURE_ROUTEABILITY_PRIORITY_BONUS,
    ALPHA_READINESS_ROUTEABILITY_REASON_CODES as _ALPHA_READINESS_ROUTEABILITY_REASON_CODES,
    BAD_STATES as _BAD_STATES,
    CURRENT_STATES as _CURRENT_STATES,
    DAILY_NET_PNL_UNLOCK_KEYS as _DAILY_NET_PNL_UNLOCK_KEYS,
    DIMENSION_ACTION as _DIMENSION_ACTION,
    DIMENSION_EXPECTED_BPS as _DIMENSION_EXPECTED_BPS,
    DIMENSION_REPAIR_CLASSES as _DIMENSION_REPAIR_CLASSES,
    DIMENSION_REPAIR_COST as _DIMENSION_REPAIR_COST,
    DIMENSION_SUCCESS as _DIMENSION_SUCCESS,
    NONBLOCKING_JANGAR_RELIABILITY_REASONS as _NONBLOCKING_JANGAR_RELIABILITY_REASONS,
    REPAIR_COST_PENALTY as _REPAIR_COST_PENALTY,
    ROUTEABILITY_TCA_REPAIR_ACTION as _ROUTEABILITY_TCA_REPAIR_ACTION,
    ROUTEABILITY_TCA_REPAIR_LOT_TYPES as _ROUTEABILITY_TCA_REPAIR_LOT_TYPES,
    ROUTEABILITY_TCA_REPAIR_REASON_FRAGMENTS as _ROUTEABILITY_TCA_REPAIR_REASON_FRAGMENTS,
    ROUTEABILITY_TCA_REPAIR_REASON_PREFIXES as _ROUTEABILITY_TCA_REPAIR_REASON_PREFIXES,
    ROUTE_SETTLED_ROW_STATES as _ROUTE_SETTLED_ROW_STATES,
    decimal as _decimal,
    decimal_text as _decimal_text,
    dimension as _dimension,
    float_value as _float,
    int_value as _int,
    mapping as _mapping,
    proof_dimension as _proof_dimension,
    route_rows as _route_rows,
    route_symbols as _route_symbols,
    routeability_only_tca_reason as _routeability_only_tca_reason,
    sequence as _sequence,
    stable_ref as _stable_ref,
    state_from_reasons as _state_from_reasons,
    strings as _strings,
    symbols as _symbols,
    text as _text,
    unique as _unique,
)


def tca_dimension(
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


def route_readiness_dimension(
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


def is_routeability_tca_repair_reason(reason: str) -> bool:
    normalized = reason.strip().lower()
    return normalized.startswith(_ROUTEABILITY_TCA_REPAIR_REASON_PREFIXES) or any(
        fragment in normalized for fragment in _ROUTEABILITY_TCA_REPAIR_REASON_FRAGMENTS
    )


def route_readiness_action(routeability_ledger: Mapping[str, Any]) -> str:
    for raw_lot in _sequence(routeability_ledger.get("lots")):
        lot = _mapping(raw_lot)
        if _text(lot.get("lot_type")) not in _ROUTEABILITY_TCA_REPAIR_LOT_TYPES:
            continue
        if _text(lot.get("current_state")).lower() in _CURRENT_STATES:
            continue
        if any(
            is_routeability_tca_repair_reason(reason)
            for reason in _strings(lot.get("blocking_reason_codes"))
        ):
            return _ROUTEABILITY_TCA_REPAIR_ACTION
    return _DIMENSION_ACTION["route_readiness"]


def zero_notional_action(
    dimension_name: str,
    *,
    routeability_ledger: Mapping[str, Any],
) -> str:
    if dimension_name == "route_readiness":
        return route_readiness_action(routeability_ledger)
    return _DIMENSION_ACTION.get(dimension_name, "observe_profit_freshness_frontier")


def schema_dimension(
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


def jangar_dimension(
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


def confidence_for_state(state: str) -> Decimal:
    if state == "stale":
        return Decimal("0.90")
    if state == "degraded":
        return Decimal("0.70")
    if state == "missing":
        return Decimal("0.55")
    if state == "blocked":
        return Decimal("0.50")
    return Decimal("0")


def routeability_confidence(routeability_ledger: Mapping[str, Any]) -> Decimal:
    state = _text(routeability_ledger.get("aggregate_state"), "missing").lower()
    if state == "accepted":
        return Decimal("1.00")
    if state in {"repairing", "stale"}:
        return Decimal("0.65")
    if state in {"blocked", "missing"}:
        return Decimal("0.45")
    return Decimal("0.55")


def jangar_confidence(jangar_reliability_settlement_ref: Mapping[str, Any]) -> Decimal:
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


def packet_dimension(packet: Mapping[str, Any]) -> str:
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


def packet_hypothesis_refs(packet: Mapping[str, Any]) -> list[str]:
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


def packet_symbols(packet: Mapping[str, Any]) -> list[str]:
    symbols = [_text(packet.get("symbol")).upper()]
    symbols.extend(_symbols(packet.get("symbol_set")))
    symbols.extend(_symbols(packet.get("symbols")))
    return _unique(symbols)


def daily_net_pnl_unlock(source: Mapping[str, Any]) -> Decimal | None:
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


def expected_daily_net_pnl_unlock(
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
        if packet_dimension(packet) != dimension_name:
            continue
        value = daily_net_pnl_unlock(packet)
        if value is None:
            continue
        packet_refs = packet_hypothesis_refs(packet)
        if (
            targets
            and packet_refs
            and "global" not in packet_refs
            and targets.isdisjoint(packet_refs)
        ):
            continue
        packet_symbol_set = packet_symbols(packet)
        if symbols and packet_symbol_set and symbols.isdisjoint(packet_symbol_set):
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


def target_notional_rankings(
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
        if packet_dimension(packet) != dimension_name:
            continue
        packet_refs = packet_hypothesis_refs(packet)
        if (
            targets
            and packet_refs
            and "global" not in packet_refs
            and targets.isdisjoint(packet_refs)
        ):
            continue
        packet_symbol_set = packet_symbols(packet)
        if symbols and packet_symbol_set and symbols.isdisjoint(packet_symbol_set):
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


def repair_lot(
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
    expected_unlock_value, profit_unlock_refs = expected_daily_net_pnl_unlock(
        dimension_name=dimension_name,
        quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
        blocking_hypotheses=blocking_hypotheses,
        candidate_ids=candidate_ids if dimension_name == "empirical_proof" else (),
        symbol_set=symbol_set,
    )
    target_rankings = target_notional_rankings(
        dimension_name=dimension_name,
        quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
        blocking_hypotheses=blocking_hypotheses,
        candidate_ids=candidate_ids if dimension_name == "empirical_proof" else (),
        symbol_set=symbol_set,
    )
    expected_profit = expected_unlock_value or expected_bps
    repair_priority = (
        expected_profit
        * confidence_for_state(state)
        * routeability_confidence(routeability_ledger)
        * jangar_confidence(jangar_reliability_settlement_ref)
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
        "zero_notional_action": zero_notional_action(
            dimension_name,
            routeability_ledger=routeability_ledger,
        ),
        "expected_profit_unlock_bps": float(expected_bps),
        "expected_daily_net_pnl_unlock": _decimal_text(expected_unlock_value),
        "profit_unlock_refs": profit_unlock_refs,
        "target_notional_rankings": target_rankings,
        "target_notional_ranking_basis": "non_authoritative_candidate_comparison",
        "repair_priority": round(float(repair_priority), 4),
        "priority_adjustments": priority_adjustments,
        "repair_priority_basis": (
            "expected_daily_net_pnl_unlock"
            if expected_unlock_value is not None
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
