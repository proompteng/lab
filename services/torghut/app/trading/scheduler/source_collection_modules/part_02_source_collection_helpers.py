# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnusedImport=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportPrivateUsage=false, reportUnsupportedDunderAll=false
"""Source-collection helper functions split from the pipeline mixin."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime
from decimal import Decimal
from typing import Any, cast

from ....config import settings
from ....models import TradeDecision
from ...models import StrategyDecision
from ..target_plan_helpers import _optional_decimal, _safe_text

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_80 import *
from .part_02_simplepipelinesourcecollectionmixinmethods import *


def _source_collection_window_active(
    window: tuple[datetime, datetime],
    now: datetime,
) -> bool:
    window_start, window_end = window
    return window_start <= now < window_end


def _source_collection_strategy_exposure(
    rows: Sequence[Any],
) -> _SourceCollectionExposure:
    exposure = _SourceCollectionExposure(signed_qty=Decimal("0"), latest_fill_at=None)
    for row in rows:
        exposure = _source_collection_accumulate_exposure(
            exposure,
            side=row[0],
            filled_qty=row[1],
            created_at=row[2] if len(row) > 2 else None,
        )
    return exposure


def _source_collection_profit_proof_exposure(
    rows: Sequence[Any],
) -> _SourceCollectionExposure:
    exposure = _SourceCollectionExposure(signed_qty=Decimal("0"), latest_fill_at=None)
    for row in rows:
        raw_decision_json = row[2]
        if not _source_collection_profit_row_eligible(raw_decision_json):
            continue
        exposure = _source_collection_accumulate_exposure(
            exposure,
            side=row[0],
            filled_qty=row[1],
            created_at=row[3] if len(row) > 3 else None,
        )
    return exposure


def _source_collection_profit_row_eligible(raw_decision_json: object) -> bool:
    if not isinstance(raw_decision_json, Mapping):
        return False
    decision_json = cast(Mapping[str, Any], raw_decision_json)
    raw_params = decision_json.get("params")
    if not isinstance(raw_params, Mapping):
        return False
    lineage = _paper_route_probe_lineage_from_params(
        cast(Mapping[str, Any], raw_params)
    )
    profit_proof_eligible = _target_bool(lineage.get("profit_proof_eligible"))
    if profit_proof_eligible is False:
        return False
    if profit_proof_eligible is True:
        return True
    return source_decision_mode_is_profit_proof_eligible(
        lineage.get("source_decision_mode")
    )


def _source_collection_accumulate_exposure(
    exposure: _SourceCollectionExposure,
    *,
    side: object,
    filled_qty: object,
    created_at: object,
) -> _SourceCollectionExposure:
    qty = _optional_decimal(filled_qty)
    if qty is None or qty <= 0:
        return exposure
    signed_qty = exposure.signed_qty
    if str(side or "").strip().lower() == "sell":
        signed_qty -= qty
    else:
        signed_qty += qty
    return _SourceCollectionExposure(
        signed_qty=signed_qty,
        latest_fill_at=_latest_fill_at(exposure.latest_fill_at, created_at),
    )


def _latest_fill_at(
    current: datetime | None,
    candidate: object,
) -> datetime | None:
    if not isinstance(candidate, datetime):
        return current
    if current is None or candidate > current:
        return candidate
    return current


def _source_collection_has_unrepaired_exposure(
    *,
    session: Session,
    account_label: str,
    symbol: str,
    exposure: _SourceCollectionExposure,
) -> bool:
    if abs(exposure.signed_qty) <= _PAPER_ROUTE_TARGET_OPEN_EXPOSURE_EPSILON:
        return False
    if SimplePipelineSourceCollectionMixin._paper_route_target_symbol_has_flat_repair_snapshot(
        session=session,
        account_label=account_label,
        symbol=symbol,
        after=exposure.latest_fill_at,
    ):
        return False
    return True


def _source_collection_symbols(
    target: Mapping[str, Any],
    *,
    target_symbols: set[str],
    normalized_allowed: set[str],
    strategy_symbols: set[str],
) -> list[str]:
    symbols = sorted(_target_symbols(target) & target_symbols)
    if normalized_allowed:
        symbols = [symbol for symbol in symbols if symbol in normalized_allowed]
    if strategy_symbols:
        symbols = [symbol for symbol in symbols if symbol in strategy_symbols]
    return symbols


def _balanced_pair_needs_short_permission(
    pair_balance_state: str,
    symbol_actions: Mapping[str, str],
) -> bool:
    return (
        pair_balance_state == "balanced"
        and any(action == "sell" for action in symbol_actions.values())
        and not settings.trading_allow_shorts
    )


def _source_collection_simple_lane(
    context: _SourceCollectionTargetContext,
    *,
    metadata: Mapping[str, Any],
    mode: _SourceCollectionMode,
    action: str,
) -> dict[str, Any]:
    simple_lane: dict[str, Any] = {
        "source": "external_target_plan_url",
        "target_plan_source_decision": True,
        "paper_route_probe_max_notional": str(context.target_cap),
        "paper_route_probe_window_start": context.window_start.isoformat(),
        "paper_route_probe_window_end": context.window_end.isoformat(),
        "paper_route_probe_symbol_actions": dict(context.symbol_actions),
        "paper_route_probe_pair_balance_state": context.pair_balance_state,
        "paper_route_probe_leg_action": action,
        "live_capital_routing_enabled": False,
        "client_order_id_basis": "trade_decision_hash",
    }
    if context.symbol_quantities:
        simple_lane["paper_route_probe_symbol_quantities"] = {
            item_symbol: str(quantity)
            for item_symbol, quantity in context.symbol_quantities.items()
        }
    if mode.execution_metadata:
        simple_lane["execution_account_label"] = mode.execution_metadata[
            "execution_account_label"
        ]
        simple_lane["submit_path"] = mode.execution_metadata["submit_path"]
    del metadata
    return simple_lane


def _source_collection_params(
    context: _SourceCollectionTargetContext,
    *,
    symbol: str,
    metadata: dict[str, Any],
    simple_lane: dict[str, Any],
    mode: _SourceCollectionMode,
) -> dict[str, Any]:
    params: dict[str, Any] = {
        "paper_route_target_plan": metadata,
        "paper_route_target_plan_source_decision": metadata,
        "simple_lane": simple_lane,
        "source_decision_mode": mode.source_decision_mode,
        "profit_proof_eligible": mode.profit_proof_eligible,
        "hypothesis_id": metadata.get("hypothesis_id"),
        "candidate_id": metadata.get("candidate_id"),
        "strategy_name": metadata.get("strategy_name"),
        "runtime_strategy_name": metadata.get("runtime_strategy_name"),
        "account_label": metadata.get("account_label"),
        "source_account_label": metadata.get("source_account_label"),
        "source_kind": metadata.get("source_kind"),
        "source_manifest_ref": metadata.get("source_manifest_ref"),
        "paper_route_target_plan_source": metadata.get(
            "paper_route_target_plan_source"
        ),
        "paper_route_probe_scope_authority": metadata.get(
            "paper_route_probe_scope_authority"
        ),
        "paper_route_probe_symbols": metadata.get("paper_route_probe_symbols"),
        "observed_stage": _safe_text(context.target.get("observed_stage")) or "paper",
        "bounded_collection_stage": "bounded_paper_collection",
        "promotion_allowed": False,
        "final_promotion_authorized": False,
        "final_authority_ok": False,
        "final_promotion_allowed": False,
        "live_capital_routing_enabled": False,
        **mode.execution_metadata,
        **_source_collection_bounded_execution_params(mode.execution_metadata),
        **_target_plan_lineage([dict(context.target)], symbol),
    }
    if "exit_minute_after_open" in metadata:
        params["exit_minute_after_open"] = metadata["exit_minute_after_open"]
    return params


def _source_collection_bounded_execution_params(
    execution_metadata: Mapping[str, Any],
) -> dict[str, Any]:
    if not execution_metadata:
        return {}
    return {
        "bounded_paper_route_submit_path": execution_metadata["submit_path"],
        "bounded_paper_route_execution_policy": execution_metadata["execution_policy"],
    }


def _source_collection_timeframe(
    context: _SourceCollectionTargetContext,
) -> str:
    return (
        _safe_text(context.target.get("timeframe"))
        or _safe_text(context.target.get("base_timeframe"))
        or _safe_text(context.strategy.base_timeframe)
        or "1Min"
    )


def _log_target_notional_sizing_blocker(
    context: _SourceCollectionTargetContext,
    *,
    symbol: str,
    blockers: object,
) -> None:
    blocker_items = cast(list[object], blockers) if isinstance(blockers, list) else []
    blocker_text = ",".join(str(item) for item in blocker_items)
    logger.warning(
        "Skipping paper-route target source decision because "
        "target-notional sizing is not authoritative strategy=%s "
        "symbol=%s blockers=%s",
        context.strategy.name,
        symbol,
        blocker_text,
    )


def _apply_source_collection_quantity_resolution(
    *,
    metadata: dict[str, Any],
    simple_lane: dict[str, Any],
    params: dict[str, Any],
    quantity_resolution: Any,
) -> None:
    metadata["paper_route_target_notional_sizing"] = quantity_resolution.audit
    simple_lane["paper_route_target_notional_sizing"] = quantity_resolution.audit
    simple_lane["target_source_notional_sized"] = (
        quantity_resolution.audit.get("sizing_source") == "target_notional"
    )
    params["paper_route_target_notional_sizing"] = quantity_resolution.audit
    params.update(quantity_resolution.price_params)


__all__ = [name for name in globals() if not name.startswith("__")]
