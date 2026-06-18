"""Configured strategy fallback targets for Torghut proof collection."""

from __future__ import annotations

from typing import Any

from .common import (
    DEFAULT_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT,
    Mapping,
    PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL,
    Sequence,
    Session,
    Strategy,
    cast,
    select,
    settings,
)
from .health_checks import decimal_or_none as _decimal_or_none
from .vnext_helpers import decimal_to_string as _decimal_to_string


def strategy_universe_symbol_values(raw_symbols: object) -> list[str]:
    if isinstance(raw_symbols, str):
        values: Sequence[object] = raw_symbols.split(",")
    elif isinstance(raw_symbols, Sequence) and not isinstance(
        raw_symbols,
        (bytes, bytearray),
    ):
        values = cast(Sequence[object], raw_symbols)
    else:
        values = ()

    symbols: list[str] = []
    for raw_symbol in values:
        symbol = str(raw_symbol).strip().upper()
        if symbol and symbol not in symbols:
            symbols.append(symbol)
    return symbols


def configured_static_symbol_allowlist() -> list[str]:
    symbols: list[str] = []
    for raw_symbol in settings.trading_static_symbols:
        symbol = str(raw_symbol).strip().upper()
        if symbol and symbol not in symbols:
            symbols.append(symbol)
    return symbols


def configured_strategy_paper_collection_symbols(strategy: Strategy) -> list[str]:
    strategy_symbols = strategy_universe_symbol_values(strategy.universe_symbols)
    static_symbols = configured_static_symbol_allowlist()
    if strategy_symbols and static_symbols:
        return [symbol for symbol in strategy_symbols if symbol in static_symbols]
    if strategy_symbols:
        return strategy_symbols
    return static_symbols


def configured_strategy_paper_collection_hypothesis_id(strategy_name: str) -> str:
    return f"configured-paper-collection:{strategy_name}"


def configured_strategy_paper_collection_targets(
    session: Session,
    *,
    max_notional: str,
) -> list[dict[str, Any]]:
    rows = session.execute(
        select(Strategy).where(Strategy.enabled.is_(True)).order_by(Strategy.name)
    ).scalars()
    targets: list[dict[str, Any]] = []
    for strategy in rows:
        symbols = configured_strategy_paper_collection_symbols(strategy)
        if not symbols:
            continue
        strategy_name = str(strategy.name).strip()
        if not strategy_name:
            continue
        target = {
            "hypothesis_id": configured_strategy_paper_collection_hypothesis_id(
                strategy_name
            ),
            "candidate_id": f"configured:{strategy_name}",
            "strategy_name": strategy_name,
            "runtime_strategy_name": strategy_name,
            "strategy_lookup_names": [strategy_name],
            "strategy_family": str(strategy.universe_type or "").strip() or "static",
            "strategy_type": str(strategy.universe_type or "").strip() or "static",
            "account_label": PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL,
            "source_account_label": PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL,
            "observed_stage": "paper",
            "source_kind": "configured_simple_lane_paper_data_collection",
            "source_plan_ref": "configured-simple-lane-paper-data-collection",
            "source_decision_mode": "bounded_paper_route_collection",
            "paper_probation_authorized": True,
            "paper_data_collection_authorized": True,
            "bounded_evidence_collection_authorized": True,
            "bounded_live_paper_collection_authorized": True,
            "source_collection_authorized": True,
            "source_collection_authorization_scope": (
                "configured_strategy_catalog_evidence_collection_only"
            ),
            "paper_route_probe_scope_authority": "configured_strategy_catalog",
            "paper_route_probe_symbols": symbols,
            "paper_route_probe_raw_target_symbols": symbols,
            "paper_route_probe_strategy_universe_fallback": True,
            "paper_route_probe_next_session_max_notional": max_notional,
            "paper_route_probe_effective_max_notional": max_notional,
            "bounded_evidence_collection_max_notional": max_notional,
            "max_notional": max_notional,
            "promotion_allowed": False,
            "capital_promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_promotion_authorized": False,
        }
        targets.append(target)
        if len(targets) >= DEFAULT_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT:
            break
    return targets


def configured_paper_collection_target_plan(
    session: Session,
    *,
    simple_lane_status: Mapping[str, Any],
) -> dict[str, Any]:
    if (
        settings.trading_mode != "live"
        or not bool(simple_lane_status.get("paper_route_probe_enabled"))
        or not bool(simple_lane_status.get("paper_route_probe_allow_live_mode"))
    ):
        return {}

    max_notional_value = _decimal_or_none(
        simple_lane_status.get("paper_route_probe_max_notional")
    )
    if max_notional_value is None or max_notional_value <= 0:
        return {}
    max_notional = _decimal_to_string(max_notional_value)
    if max_notional is None:
        return {}
    targets = configured_strategy_paper_collection_targets(
        session,
        max_notional=max_notional,
    )
    if not targets:
        return {}
    return {
        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
        "source": "configured_simple_lane_paper_data_collection",
        "source_ref": "configured-simple-lane-paper-data-collection",
        "target_count": len(targets),
        "account_label": PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL,
        "observed_stage": "paper",
        "paper_data_collection_authorized": True,
        "bounded_evidence_collection_authorized": True,
        "bounded_evidence_collection_max_notional": max_notional,
        "promotion_allowed": False,
        "capital_promotion_allowed": False,
        "final_promotion_allowed": False,
        "final_promotion_authorized": False,
        "targets": targets,
    }


__all__ = [
    "strategy_universe_symbol_values",
    "configured_static_symbol_allowlist",
    "configured_strategy_paper_collection_symbols",
    "configured_strategy_paper_collection_hypothesis_id",
    "configured_strategy_paper_collection_targets",
    "configured_paper_collection_target_plan",
]
