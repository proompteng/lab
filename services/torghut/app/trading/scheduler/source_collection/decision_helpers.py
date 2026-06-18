"""Source-collection helper functions split from the pipeline mixin."""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from datetime import datetime
from decimal import Decimal
from typing import Any, Protocol, cast

from sqlalchemy.orm import Session

from ....config import settings
from ...promotion_authority import source_collection_authority
from ...runtime_decision_authority import source_decision_mode_is_profit_proof_eligible
from ..target_plan_helpers import (
    PAPER_ROUTE_TARGET_OPEN_EXPOSURE_EPSILON as _PAPER_ROUTE_TARGET_OPEN_EXPOSURE_EPSILON,
    optional_decimal as _optional_decimal,
    paper_route_probe_lineage_from_params as _paper_route_probe_lineage_from_params,
    safe_text as _safe_text,
    target_bool as _target_bool,
    target_plan_lineage as _target_plan_lineage,
    target_symbols as _target_symbols,
)
from .collection_types import (
    SourceCollectionExposure,
    SourceCollectionMode,
    SourceCollectionTargetContext,
)


logger = logging.getLogger(__name__)


class FlatRepairSnapshotLookup(Protocol):
    def __call__(
        self,
        *,
        session: Session,
        account_label: str,
        symbol: str,
        after: datetime | None,
    ) -> bool: ...


def source_collection_window_active(
    window: tuple[datetime, datetime],
    now: datetime,
) -> bool:
    window_start, window_end = window
    return window_start <= now < window_end


def source_collection_strategy_exposure(
    rows: Sequence[Any],
) -> SourceCollectionExposure:
    exposure = SourceCollectionExposure(signed_qty=Decimal("0"), latest_fill_at=None)
    for row in rows:
        exposure = source_collection_accumulate_exposure(
            exposure,
            side=row[0],
            filled_qty=row[1],
            created_at=row[2] if len(row) > 2 else None,
        )
    return exposure


def source_collection_profit_proof_exposure(
    rows: Sequence[Any],
) -> SourceCollectionExposure:
    exposure = SourceCollectionExposure(signed_qty=Decimal("0"), latest_fill_at=None)
    for row in rows:
        raw_decision_json = row[2]
        if not source_collection_profit_row_eligible(raw_decision_json):
            continue
        exposure = source_collection_accumulate_exposure(
            exposure,
            side=row[0],
            filled_qty=row[1],
            created_at=row[3] if len(row) > 3 else None,
        )
    return exposure


def source_collection_profit_row_eligible(raw_decision_json: object) -> bool:
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


def source_collection_accumulate_exposure(
    exposure: SourceCollectionExposure,
    *,
    side: object,
    filled_qty: object,
    created_at: object,
) -> SourceCollectionExposure:
    qty = _optional_decimal(filled_qty)
    if qty is None or qty <= 0:
        return exposure
    signed_qty = exposure.signed_qty
    if str(side or "").strip().lower() == "sell":
        signed_qty -= qty
    else:
        signed_qty += qty
    return SourceCollectionExposure(
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


def source_collection_has_unrepaired_exposure(
    *,
    session: Session,
    account_label: str,
    symbol: str,
    exposure: SourceCollectionExposure,
    flat_repair_snapshot_lookup: FlatRepairSnapshotLookup,
) -> bool:
    if abs(exposure.signed_qty) <= _PAPER_ROUTE_TARGET_OPEN_EXPOSURE_EPSILON:
        return False
    if flat_repair_snapshot_lookup(
        session=session,
        account_label=account_label,
        symbol=symbol,
        after=exposure.latest_fill_at,
    ):
        return False
    return True


def source_collection_symbols(
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


def balanced_pair_needs_short_permission(
    pair_balance_state: str,
    symbol_actions: Mapping[str, str],
) -> bool:
    return (
        pair_balance_state == "balanced"
        and any(action == "sell" for action in symbol_actions.values())
        and not settings.trading_allow_shorts
    )


def source_collection_simple_lane(
    context: SourceCollectionTargetContext,
    *,
    metadata: Mapping[str, Any],
    mode: SourceCollectionMode,
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


def source_collection_params(
    context: SourceCollectionTargetContext,
    *,
    symbol: str,
    metadata: dict[str, Any],
    simple_lane: dict[str, Any],
    mode: SourceCollectionMode,
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
        **source_collection_authority(
            blockers=["runtime_ledger_source_collection_pending"],
        ).as_target_fields(),
        "live_capital_routing_enabled": False,
        **mode.execution_metadata,
        **source_collection_bounded_execution_params(mode.execution_metadata),
        **_target_plan_lineage([dict(context.target)], symbol),
    }
    if "exit_minute_after_open" in metadata:
        params["exit_minute_after_open"] = metadata["exit_minute_after_open"]
    return params


def source_collection_bounded_execution_params(
    execution_metadata: Mapping[str, Any],
) -> dict[str, Any]:
    if not execution_metadata:
        return {}
    return {
        "bounded_paper_route_submit_path": execution_metadata["submit_path"],
        "bounded_paper_route_execution_policy": execution_metadata["execution_policy"],
    }


def source_collection_timeframe(
    context: SourceCollectionTargetContext,
) -> str:
    return (
        _safe_text(context.target.get("timeframe"))
        or _safe_text(context.target.get("base_timeframe"))
        or _safe_text(context.strategy.base_timeframe)
        or "1Min"
    )


def log_target_notional_sizing_blocker(
    context: SourceCollectionTargetContext,
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


def apply_source_collection_quantity_resolution(
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


__all__ = [
    "FlatRepairSnapshotLookup",
    "apply_source_collection_quantity_resolution",
    "balanced_pair_needs_short_permission",
    "log_target_notional_sizing_blocker",
    "source_collection_has_unrepaired_exposure",
    "source_collection_params",
    "source_collection_profit_proof_exposure",
    "source_collection_simple_lane",
    "source_collection_strategy_exposure",
    "source_collection_symbols",
    "source_collection_timeframe",
    "source_collection_window_active",
]
