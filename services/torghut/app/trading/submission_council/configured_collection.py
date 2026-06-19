"""Configured bounded paper collection fallback targets."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from ...models import Strategy
from ..promotion_authority import capital_blocked_authority, source_collection_authority

from .common import (
    bounded_paper_route_probe_collection_payload,
    decimal_text,
    safe_decimal,
    settings,
)
from .paper_probation import (
    BOUNDED_PAPER_ROUTE_COLLECTION_PROMOTION_BLOCKERS,
    RUNTIME_LEDGER_PAPER_PROBATION_IMPORT_SCHEMA_VERSION,
)

_CONFIGURED_COLLECTION_SOURCE = "configured_simple_lane_paper_data_collection"
_CONFIGURED_COLLECTION_ACCOUNT_LABEL = "TORGHUT_SIM"
_CONFIGURED_COLLECTION_LIMIT = 8


def with_configured_paper_collection_targets(
    plan: Mapping[str, object],
    *,
    session: Session | None,
) -> dict[str, object]:
    merged_plan = dict(plan)
    max_notional = safe_decimal(settings.trading_simple_paper_route_probe_max_notional)
    configured_collection_enabled = (
        session is not None
        and settings.trading_mode == "live"
        and settings.trading_simple_paper_route_probe_enabled
        and settings.trading_simple_paper_route_probe_allow_live_mode
        and max_notional is not None
        and max_notional > 0
    )
    if not configured_collection_enabled:
        return merged_plan

    symbols = _configured_static_symbols()
    if not symbols:
        return merged_plan

    assert session is not None
    assert max_notional is not None
    max_notional_text = decimal_text(max_notional)
    targets = _configured_strategy_targets(
        session,
        static_symbols=symbols,
        max_notional=max_notional_text,
        existing_targets=_mapping_items(merged_plan.get("targets")),
    )
    if not targets:
        return merged_plan

    existing_targets = _mapping_items(merged_plan.get("targets"))
    merged_targets = [*existing_targets, *targets]
    existing_source_count = _int_value(
        merged_plan.get("source_collection_target_count")
    )
    source = str(merged_plan.get("source") or "").strip()
    merged_plan.update(
        {
            "schema_version": RUNTIME_LEDGER_PAPER_PROBATION_IMPORT_SCHEMA_VERSION,
            "target_count": len(merged_targets),
            "source_collection_target_count": existing_source_count + len(targets),
            "configured_bounded_collection_target_count": len(targets),
            "bounded_collection_account_label": _CONFIGURED_COLLECTION_ACCOUNT_LABEL,
            "observed_stage": "paper",
            "paper_data_collection_authorized": True,
            "bounded_evidence_collection_authorized": True,
            "bounded_live_paper_collection_authorized": True,
            "bounded_evidence_collection_max_notional": max_notional_text,
            "promotion_allowed": False,
            "capital_promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_promotion_authorized": False,
            "paper_route_target_plan_fallback": True,
            "paper_route_target_plan_fallback_reason": (
                "configured_static_universe_paper_collection"
            ),
            "targets": merged_targets,
        }
    )
    if not source or _target_count(plan) <= 0:
        merged_plan["source"] = _CONFIGURED_COLLECTION_SOURCE
        merged_plan["source_ref"] = "configured-static-universe-paper-data-collection"
        merged_plan["account_label"] = _CONFIGURED_COLLECTION_ACCOUNT_LABEL
        merged_plan["source_account_label"] = _CONFIGURED_COLLECTION_ACCOUNT_LABEL
    else:
        merged_plan["configured_collection_source"] = _CONFIGURED_COLLECTION_SOURCE
        merged_plan["configured_collection_source_ref"] = (
            "configured-static-universe-paper-data-collection"
        )
    return merged_plan


def _mapping_items(value: object) -> list[dict[str, object]]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    return [
        dict(cast(Mapping[str, object], item))
        for item in cast(Sequence[object], value)
        if isinstance(item, Mapping)
    ]


def _int_value(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return 0


def _target_count(plan: Mapping[str, object]) -> int:
    targets = _mapping_items(plan.get("targets"))
    if targets:
        return len(targets)
    return _int_value(plan.get("target_count"))


def _configured_static_symbols() -> list[str]:
    symbols: list[str] = []
    for raw_symbol in settings.trading_static_symbols:
        symbol = str(raw_symbol).strip().upper()
        if symbol and symbol not in symbols:
            symbols.append(symbol)
    return symbols


def _configured_strategy_targets(
    session: Session,
    *,
    static_symbols: Sequence[str],
    max_notional: str,
    existing_targets: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    rows = session.execute(
        select(Strategy).where(Strategy.enabled.is_(True)).order_by(Strategy.name)
    ).scalars()
    targets: list[dict[str, object]] = []
    for strategy in rows:
        symbols = _strategy_collection_symbols(strategy, static_symbols=static_symbols)
        if not symbols:
            continue
        strategy_name = str(strategy.name or "").strip()
        if not strategy_name:
            continue
        hypothesis_id = f"configured-paper-collection:{strategy_name}"
        candidate_id = f"configured:{strategy_name}"
        if _has_target(
            existing_targets,
            hypothesis_id=hypothesis_id,
            candidate_id=candidate_id,
        ):
            continue
        targets.append(
            _configured_strategy_target(
                strategy=strategy,
                symbols=symbols,
                max_notional=max_notional,
            )
        )
        if len(targets) >= _CONFIGURED_COLLECTION_LIMIT:
            break
    return targets


def _has_target(
    targets: Sequence[Mapping[str, object]],
    *,
    hypothesis_id: str,
    candidate_id: str,
) -> bool:
    for target in targets:
        if (
            str(target.get("hypothesis_id") or "").strip() == hypothesis_id
            and str(target.get("candidate_id") or "").strip() == candidate_id
        ):
            return True
    return False


def _strategy_collection_symbols(
    strategy: Strategy,
    *,
    static_symbols: Sequence[str],
) -> list[str]:
    strategy_symbols = _strategy_symbol_values(strategy.universe_symbols)
    if strategy_symbols:
        return [symbol for symbol in strategy_symbols if symbol in static_symbols]
    return list(static_symbols)


def _strategy_symbol_values(raw_symbols: object) -> list[str]:
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


def _configured_strategy_target(
    *,
    strategy: Strategy,
    symbols: Sequence[str],
    max_notional: str,
) -> dict[str, object]:
    strategy_name = str(strategy.name or "").strip()
    hypothesis_id = f"configured-paper-collection:{strategy_name}"
    candidate_id = f"configured:{strategy_name}"
    symbol_actions = {symbol: "buy" for symbol in symbols}
    strategy_family = str(strategy.universe_type or "").strip() or "static"
    target = {
        "hypothesis_id": hypothesis_id,
        "candidate_id": candidate_id,
        "strategy_id": str(strategy.id or ""),
        "strategy_name": strategy_name,
        "runtime_strategy_name": strategy_name,
        "strategy_lookup_names": [strategy_name],
        "strategy_family": strategy_family,
        "strategy_type": strategy_family,
        "account_label": _CONFIGURED_COLLECTION_ACCOUNT_LABEL,
        "source_account_label": _CONFIGURED_COLLECTION_ACCOUNT_LABEL,
        "execution_account_label": settings.trading_account_label,
        "paper_account_label": settings.trading_account_label,
        "paper_route_runtime_account_label": settings.trading_account_label,
        "bounded_collection_account_label": _CONFIGURED_COLLECTION_ACCOUNT_LABEL,
        "account_stage_runtime_identity": {
            "account_label": _CONFIGURED_COLLECTION_ACCOUNT_LABEL,
            "source_account_label": _CONFIGURED_COLLECTION_ACCOUNT_LABEL,
            "execution_account_label": settings.trading_account_label,
            "runtime_account_label": settings.trading_account_label,
            "paper_account_label": settings.trading_account_label,
            "paper_route_runtime_account_label": settings.trading_account_label,
            "observed_stage": "paper",
            "source_kind": _CONFIGURED_COLLECTION_SOURCE,
        },
        "observed_stage": "paper",
        "source_kind": _CONFIGURED_COLLECTION_SOURCE,
        "source_plan_ref": "configured-static-universe-paper-data-collection",
        "source_manifest_ref": (
            f"configured-static-universe-paper-data-collection:{strategy_name}"
        ),
        "source_decision_mode": "bounded_paper_route_collection",
        "paper_probation_authorized": True,
        "paper_data_collection_authorized": True,
        "bounded_evidence_collection_authorized": True,
        "bounded_live_paper_collection_authorized": True,
        "source_collection_authorized": True,
        "source_collection_authorization_scope": (
            "configured_strategy_catalog_evidence_collection_only"
        ),
        "paper_route_probe_scope_authority": "configured_static_universe",
        "paper_route_probe_symbols": list(symbols),
        "paper_route_probe_raw_target_symbols": list(symbols),
        "paper_route_probe_symbol_actions": symbol_actions,
        "target_symbol_actions": symbol_actions,
        "symbol_actions": symbol_actions,
        "paper_route_probe_symbol_quantities": {},
        "target_symbol_quantities": {},
        "paper_route_probe_strategy_universe_fallback": not bool(
            _strategy_symbol_values(strategy.universe_symbols)
        ),
        "paper_route_probe_next_session_max_notional": max_notional,
        "paper_route_probe_effective_max_notional": max_notional,
        "bounded_evidence_collection_max_notional": max_notional,
        "target_notional": max_notional,
        "max_notional": max_notional,
        "promotion_allowed": False,
        "capital_promotion_allowed": False,
        "final_promotion_allowed": False,
        "final_promotion_authorized": False,
        "evidence_collection_ok": True,
        **capital_blocked_authority(
            blockers=["configured_collection_not_capital_promotion_authority"],
        ).as_target_fields(),
        **source_collection_authority(
            blockers=list(BOUNDED_PAPER_ROUTE_COLLECTION_PROMOTION_BLOCKERS),
            bounded_live_paper_collection_authorized=True,
        ).as_target_fields(),
        **bounded_paper_route_probe_collection_payload(authorized=True),
    }
    return target


__all__ = [
    "with_configured_paper_collection_targets",
]
