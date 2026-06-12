# pyright: reportUnusedImport=false, reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownVariableType=false, reportAttributeAccessIssue=false

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Literal, cast

from sqlalchemy.orm import Session

from ...config import settings
from ...models import (
    Strategy,
    TradeDecision,
)
from ..models import StrategyDecision
from ..runtime_decision_authority import (
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
)
from .paper_route_materialization_processing import (
    SimplePipelinePaperRouteMaterializationProcessingMixin,
)
from .target_plan_helpers import (
    _bounded_sim_collection_blockers,
    _bounded_sim_collection_target_with_runtime_account_audit,
    _merge_paper_route_probe_lineage,
    _optional_decimal,
    _paper_route_probe_lineage_from_params,
    _parse_target_datetime,
    _safe_text,
    _target_plan_lineage,
    _target_probe_action,
    _target_probe_cap,
    _TargetProbeQuantityResolution,
    _target_probe_symbol_actions,
    _target_probe_symbol_quantities,
    _target_probe_window,
    _target_requires_bounded_sim_collection_gate,
    _target_symbols,
    _target_truthy,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _MaterializedDecisionBuild:
    target_symbols: list[str]
    symbol_quantities: Mapping[str, Decimal]
    metadata: dict[str, Any]
    execution_metadata: Mapping[str, Any]
    simple_lane: dict[str, Any]
    params: dict[str, Any]


@dataclass(frozen=True)
class _MaterializedPaperRouteCandidate:
    payload: Mapping[str, Any]
    target: Mapping[str, Any]
    strategy: Strategy
    symbol: str
    action: Literal["buy", "sell"]
    window_start: datetime
    window_end: datetime
    target_cap: Decimal


@dataclass(frozen=True)
class _MaterializedCandidateContext:
    session: Session
    strategies: Sequence[Strategy]
    positions: Sequence[Mapping[str, Any]]
    now: datetime


@dataclass(frozen=True)
class _MaterializedWindowCap:
    window_start: datetime
    window_end: datetime
    target_cap: Decimal


@dataclass(frozen=True)
class _MaterializedPlanningContext:
    session: Session
    strategies: Sequence[Strategy]
    positions: Sequence[Mapping[str, Any]]
    flat_check_positions: Sequence[Mapping[str, Any]]
    now: datetime


@dataclass(frozen=True)
class _MaterializedPlanningResult:
    candidate: _MaterializedPaperRouteCandidate | None
    expired: bool = False


@dataclass(frozen=True)
class _MaterializedPlanningWindowResult:
    window_cap: _MaterializedWindowCap | None
    expired: bool = False


class SimplePipelinePaperRouteMaterializationMixin(
    SimplePipelinePaperRouteMaterializationProcessingMixin,
):
    @staticmethod
    def _paper_route_materialized_source_payload(
        decision_row: TradeDecision,
    ) -> Mapping[str, Any] | None:
        payload = decision_row.decision_json
        if not isinstance(payload, Mapping):
            return None
        typed_payload = cast(Mapping[str, Any], payload)
        params = typed_payload.get("params")
        if not isinstance(params, Mapping):
            return None
        typed_params = cast(Mapping[str, Any], params)
        materialized = _target_truthy(
            typed_params.get("paper_route_target_plan_materialized")
        )
        if (
            not materialized
            and _safe_text(typed_payload.get("submission_stage"))
            != "bounded_paper_route_materialized"
        ):
            return None
        source = _safe_text(typed_payload.get("source")) or _safe_text(
            typed_params.get("source")
        )
        if source not in {None, "paper_route_target_plan_materializer"}:
            return None
        source_decision_mode = _safe_text(
            typed_payload.get("source_decision_mode")
        ) or _safe_text(typed_params.get("source_decision_mode"))
        if source_decision_mode != BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE:
            return None
        return typed_payload

    @staticmethod
    def _paper_route_materialized_target_from_payload(
        payload: Mapping[str, Any],
    ) -> dict[str, Any] | None:
        params = payload.get("params")
        if not isinstance(params, Mapping):
            return None
        typed_params = cast(Mapping[str, Any], params)
        target: dict[str, Any] | None = None
        for key in (
            "paper_route_target_plan_source_decision",
            "paper_route_target_plan",
            "paper_route_probe",
        ):
            raw_target = typed_params.get(key)
            if isinstance(raw_target, Mapping):
                target = dict(cast(Mapping[str, Any], raw_target))
                break
        if target is None:
            return None

        identity = payload.get("target_plan_identity")
        identity_mapping: Mapping[str, Any] = (
            cast(Mapping[str, Any], identity) if isinstance(identity, Mapping) else {}
        )
        for key in (
            "hypothesis_id",
            "candidate_id",
            "runtime_strategy_name",
            "strategy_name",
            "strategy_id",
            "account_label",
            "source_account_label",
            "source_kind",
            "source_plan_ref",
            "source_manifest_ref",
            "observed_stage",
            "bounded_collection_stage",
            "window_start",
            "window_end",
            "paper_route_probe_window_start",
            "paper_route_probe_window_end",
            "target_notional",
            "target_quantity",
            "paper_route_probe_next_session_max_notional",
        ):
            value = (
                target.get(key)
                or typed_params.get(key)
                or payload.get(key)
                or identity_mapping.get(key)
            )
            if value is not None:
                target.setdefault(key, value)
        target.setdefault("source", "paper_route_target_plan_materializer")
        target.setdefault(
            "paper_route_target_plan_source",
            "paper_route_target_plan_materializer",
        )
        target.setdefault("observed_stage", "paper")
        target.setdefault("bounded_collection_stage", "bounded_paper_collection")
        target.setdefault("promotion_allowed", False)
        target.setdefault("final_authority_ok", False)
        target.setdefault("final_promotion_authorized", False)
        target.setdefault("final_promotion_allowed", False)
        target.setdefault("live_capital_routing_enabled", False)
        if target.get("paper_route_probe_window_start") is None:
            target["paper_route_probe_window_start"] = target.get(
                "window_start"
            ) or identity_mapping.get("window_start")
        if target.get("paper_route_probe_window_end") is None:
            target["paper_route_probe_window_end"] = target.get(
                "window_end"
            ) or identity_mapping.get("window_end")

        runtime_identity = target.get("account_stage_runtime_identity")
        if not isinstance(runtime_identity, Mapping):
            target["account_stage_runtime_identity"] = {
                "account_label": _safe_text(target.get("account_label")),
                "source_account_label": _safe_text(target.get("source_account_label")),
                "observed_stage": _safe_text(target.get("observed_stage")) or "paper",
                "runtime_strategy_name": _safe_text(
                    target.get("runtime_strategy_name")
                ),
                "source_kind": _safe_text(target.get("source_kind")),
            }
        return target

    def _paper_route_materialized_metadata(
        self,
        *,
        decision_row: TradeDecision,
        target: Mapping[str, Any],
        strategy: Strategy,
        symbol: str,
        action: Literal["buy", "sell"],
        window_start: datetime,
        window_end: datetime,
        max_notional: Decimal,
    ) -> tuple[list[str], Mapping[str, Decimal], dict[str, Any], Mapping[str, Any]]:
        target_symbols = sorted(_target_symbols(target))
        symbol_quantities = _target_probe_symbol_quantities(target, target_symbols)
        metadata = self._paper_route_target_source_decision_metadata(
            target=target,
            strategy=strategy,
            symbol=symbol,
            window_start=window_start,
            window_end=window_end,
            max_notional=max_notional,
        )
        metadata["source"] = "paper_route_target_plan_materializer"
        metadata["paper_route_target_plan_source"] = (
            "paper_route_target_plan_materializer"
        )
        metadata["paper_route_target_plan_materialized"] = True
        metadata["materialized_trade_decision_id"] = str(decision_row.id)
        metadata["paper_route_probe_symbol_actions"] = _target_probe_symbol_actions(
            target,
            target_symbols,
        )
        if symbol_quantities:
            metadata["paper_route_probe_symbol_quantities"] = {
                item_symbol: str(quantity)
                for item_symbol, quantity in symbol_quantities.items()
            }
        metadata["paper_route_probe_leg_action"] = action

        execution_metadata = self._bounded_paper_route_execution_metadata(
            target=target,
            strategy=strategy,
            symbol=symbol,
            action=action,
            account_label=self.account_label,
            max_notional=max_notional,
        )
        metadata["source_decision_mode"] = (
            BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
        )
        metadata["profit_proof_eligible"] = True
        metadata["bounded_paper_route_submit_path"] = execution_metadata["submit_path"]
        metadata["bounded_paper_route_execution_policy"] = execution_metadata[
            "execution_policy"
        ]
        return target_symbols, symbol_quantities, metadata, execution_metadata

    @staticmethod
    def _paper_route_materialized_simple_lane(
        *,
        metadata: Mapping[str, Any],
        execution_metadata: Mapping[str, Any],
        symbol_quantities: Mapping[str, Decimal],
        action: Literal["buy", "sell"],
        window_start: datetime,
        window_end: datetime,
        max_notional: Decimal,
    ) -> dict[str, Any]:
        simple_lane = {
            "source": "paper_route_target_plan_materializer",
            "target_plan_source_decision": True,
            "paper_route_target_plan_materialized": True,
            "paper_route_probe_max_notional": str(max_notional),
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
            "paper_route_probe_symbol_actions": metadata[
                "paper_route_probe_symbol_actions"
            ],
            "paper_route_probe_leg_action": action,
            "live_capital_routing_enabled": False,
            "client_order_id_basis": "materialized_trade_decision_hash",
            "execution_account_label": execution_metadata["execution_account_label"],
            "submit_path": execution_metadata["submit_path"],
        }
        if symbol_quantities:
            simple_lane["paper_route_probe_symbol_quantities"] = {
                item_symbol: str(quantity)
                for item_symbol, quantity in symbol_quantities.items()
            }
        return simple_lane

    @staticmethod
    def _paper_route_materialized_params(
        *,
        decision_row: TradeDecision,
        target: Mapping[str, Any],
        metadata: Mapping[str, Any],
        execution_metadata: Mapping[str, Any],
        simple_lane: Mapping[str, Any],
        symbol: str,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "paper_route_target_plan_materialized": True,
            "paper_route_materialized_trade_decision_id": str(decision_row.id),
            "paper_route_materialized_decision_hash": decision_row.decision_hash,
            "paper_route_target_plan": metadata,
            "paper_route_target_plan_source_decision": metadata,
            "simple_lane": simple_lane,
            "source_decision_mode": BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
            "profit_proof_eligible": True,
            "hypothesis_id": metadata.get("hypothesis_id"),
            "candidate_id": metadata.get("candidate_id"),
            "strategy_name": metadata.get("strategy_name"),
            "runtime_strategy_name": metadata.get("runtime_strategy_name"),
            "account_label": metadata.get("account_label"),
            "source_account_label": metadata.get("source_account_label"),
            "source_kind": metadata.get("source_kind"),
            "source_manifest_ref": metadata.get("source_manifest_ref"),
            "source_plan_ref": metadata.get("source_plan_ref"),
            "paper_route_target_plan_source": metadata.get(
                "paper_route_target_plan_source"
            ),
            "paper_route_probe_scope_authority": metadata.get(
                "paper_route_probe_scope_authority"
            ),
            "paper_route_probe_symbols": metadata.get("paper_route_probe_symbols"),
            "observed_stage": _safe_text(target.get("observed_stage")) or "paper",
            "bounded_collection_stage": "bounded_paper_collection",
            "promotion_allowed": False,
            "final_promotion_authorized": False,
            "final_authority_ok": False,
            "final_promotion_allowed": False,
            "live_capital_routing_enabled": False,
            **execution_metadata,
            "bounded_paper_route_submit_path": execution_metadata["submit_path"],
            "bounded_paper_route_execution_policy": execution_metadata[
                "execution_policy"
            ],
            **_target_plan_lineage([dict(target)], symbol),
        }
        if "exit_minute_after_open" in metadata:
            params["exit_minute_after_open"] = metadata["exit_minute_after_open"]
        _merge_paper_route_probe_lineage(
            params,
            _paper_route_probe_lineage_from_params(params),
        )
        return params

    def _paper_route_materialized_build(
        self,
        *,
        decision_row: TradeDecision,
        target: Mapping[str, Any],
        strategy: Strategy,
        symbol: str,
        action: Literal["buy", "sell"],
        window_start: datetime,
        window_end: datetime,
        max_notional: Decimal,
    ) -> _MaterializedDecisionBuild:
        target_symbols, symbol_quantities, metadata, execution_metadata = (
            self._paper_route_materialized_metadata(
                decision_row=decision_row,
                target=target,
                strategy=strategy,
                symbol=symbol,
                action=action,
                window_start=window_start,
                window_end=window_end,
                max_notional=max_notional,
            )
        )
        simple_lane = self._paper_route_materialized_simple_lane(
            metadata=metadata,
            execution_metadata=execution_metadata,
            symbol_quantities=symbol_quantities,
            action=action,
            window_start=window_start,
            window_end=window_end,
            max_notional=max_notional,
        )
        params = self._paper_route_materialized_params(
            decision_row=decision_row,
            target=target,
            metadata=metadata,
            execution_metadata=execution_metadata,
            simple_lane=simple_lane,
            symbol=symbol,
        )
        return _MaterializedDecisionBuild(
            target_symbols=target_symbols,
            symbol_quantities=symbol_quantities,
            metadata=metadata,
            execution_metadata=execution_metadata,
            simple_lane=simple_lane,
            params=params,
        )

    @staticmethod
    def _paper_route_materialized_event_ts(
        *,
        decision_row: TradeDecision,
        payload: Mapping[str, Any],
    ) -> datetime:
        event_ts = _parse_target_datetime(payload.get("event_ts"))
        if event_ts is not None:
            return event_ts.astimezone(timezone.utc)
        raw_created_at = decision_row.created_at
        if raw_created_at.tzinfo is not None:
            return raw_created_at.astimezone(timezone.utc)
        return raw_created_at.replace(tzinfo=timezone.utc)

    @staticmethod
    def _paper_route_materialized_timeframe(
        *,
        payload: Mapping[str, Any],
        strategy: Strategy,
    ) -> str:
        return _safe_text(payload.get("timeframe")) or strategy.base_timeframe or "1Min"

    @staticmethod
    def _paper_route_materialized_order_type(
        payload: Mapping[str, Any],
    ) -> Literal["market", "limit", "stop", "stop_limit"]:
        order_type_text = _safe_text(payload.get("order_type")) or "market"
        if order_type_text in {"market", "limit", "stop", "stop_limit"}:
            return cast(
                Literal["market", "limit", "stop", "stop_limit"],
                order_type_text,
            )
        return "market"

    @staticmethod
    def _paper_route_materialized_time_in_force(
        payload: Mapping[str, Any],
    ) -> Literal["day", "gtc", "ioc", "fok"]:
        time_in_force_text = _safe_text(payload.get("time_in_force")) or "day"
        if time_in_force_text in {"day", "gtc", "ioc", "fok"}:
            return cast(Literal["day", "gtc", "ioc", "fok"], time_in_force_text)
        return "day"

    def _paper_route_materialized_quantity_resolution(
        self,
        *,
        decision_row: TradeDecision,
        payload: Mapping[str, Any],
        target: Mapping[str, Any],
        symbol: str,
        action: Literal["buy", "sell"],
        max_notional: Decimal,
        event_ts: datetime,
        timeframe: str,
        build: _MaterializedDecisionBuild,
    ) -> _TargetProbeQuantityResolution | None:
        payload_qty = _optional_decimal(payload.get("qty"))
        if payload_qty is not None and payload_qty <= 0:
            return None
        requested_qty = (
            payload_qty or build.symbol_quantities.get(symbol) or Decimal("1")
        )
        quantity_resolution = self._paper_route_target_quantity_resolution(
            target=target,
            symbol=symbol,
            symbols=build.target_symbols,
            action=action,
            requested_qty=requested_qty,
            symbol_quantities=build.symbol_quantities,
            max_notional=max_notional,
            event_ts=event_ts,
            timeframe=timeframe,
        )
        if quantity_resolution is None:
            return None
        if quantity_resolution.audit.get("sizing_source") == "target_notional":
            return quantity_resolution

        blockers = quantity_resolution.audit.get("blockers")
        blocker_items = (
            cast(list[object], blockers) if isinstance(blockers, list) else []
        )
        logger.warning(
            "Skipping materialized paper-route target source decision because "
            "target-notional sizing is not authoritative decision_id=%s "
            "symbol=%s blockers=%s",
            decision_row.id,
            symbol,
            ",".join(str(item) for item in blocker_items),
        )
        return None

    @staticmethod
    def _apply_materialized_quantity_resolution(
        *,
        build: _MaterializedDecisionBuild,
        quantity_resolution: _TargetProbeQuantityResolution,
    ) -> None:
        build.metadata["paper_route_target_notional_sizing"] = quantity_resolution.audit
        build.simple_lane["paper_route_target_notional_sizing"] = (
            quantity_resolution.audit
        )
        build.simple_lane["target_source_notional_sized"] = (
            quantity_resolution.audit.get("sizing_source") == "target_notional"
        )
        build.params["paper_route_target_notional_sizing"] = quantity_resolution.audit
        build.params.update(quantity_resolution.price_params)

    def _paper_route_materialized_decision_with_execution_metadata(
        self,
        *,
        decision_row: TradeDecision,
        payload: Mapping[str, Any],
        target: Mapping[str, Any],
        strategy: Strategy,
        symbol: str,
        action: Literal["buy", "sell"],
        window_start: datetime,
        window_end: datetime,
        max_notional: Decimal,
        now: datetime,
    ) -> StrategyDecision | None:
        build = self._paper_route_materialized_build(
            decision_row=decision_row,
            target=target,
            strategy=strategy,
            symbol=symbol,
            action=action,
            window_start=window_start,
            window_end=window_end,
            max_notional=max_notional,
        )

        event_ts = self._paper_route_materialized_event_ts(
            decision_row=decision_row,
            payload=payload,
        )
        timeframe = self._paper_route_materialized_timeframe(
            payload=payload,
            strategy=strategy,
        )
        quantity_resolution = self._paper_route_materialized_quantity_resolution(
            decision_row=decision_row,
            payload=payload,
            target=target,
            symbol=symbol,
            action=action,
            max_notional=max_notional,
            event_ts=event_ts,
            timeframe=timeframe,
            build=build,
        )
        if quantity_resolution is None:
            return None
        self._apply_materialized_quantity_resolution(
            build=build,
            quantity_resolution=quantity_resolution,
        )

        return StrategyDecision(
            strategy_id=str(strategy.id),
            symbol=symbol,
            event_ts=event_ts,
            timeframe=timeframe,
            action=action,
            qty=quantity_resolution.qty,
            order_type=self._paper_route_materialized_order_type(payload),
            time_in_force=self._paper_route_materialized_time_in_force(payload),
            rationale=("materialized bounded paper-route target plan source decision"),
            params=build.params,
        )

    @staticmethod
    def _expire_stale_materialized_paper_route_decision(
        *,
        decision_row: TradeDecision,
        payload: Mapping[str, Any],
        window_end: datetime,
        now: datetime,
        reason: str = "paper_route_materialized_window_expired_unsubmitted",
    ) -> bool:
        if decision_row.status != "planned":
            return False
        if now < window_end.astimezone(timezone.utc):
            return False
        decision_json = dict(payload)
        params = dict(cast(Mapping[str, Any], decision_json.get("params") or {}))
        expiry_payload = {
            "schema_version": "torghut.paper-route-materialized-expiry.v1",
            "reason": reason,
            "window_end": window_end.astimezone(timezone.utc).isoformat(),
            "expired_at": now.astimezone(timezone.utc).isoformat(),
            "previous_submission_stage": _safe_text(
                decision_json.get("submission_stage")
            )
            or "bounded_paper_route_materialized",
        }
        params["paper_route_materialized_unsubmitted"] = expiry_payload
        decision_json["params"] = params
        decision_json["submission_stage"] = "expired_paper_route_materialized_window"
        decision_json["submission_block_reason"] = reason
        decision_json["reject_reason_atomic"] = [reason]
        decision_json["paper_route_materialized_unsubmitted"] = expiry_payload
        decision_row.status = "rejected"
        decision_row.decision_json = decision_json
        return True

    def _paper_route_materialized_payload_and_target(
        self,
        *,
        session: Session,
        decision_row: TradeDecision,
        positions: Sequence[Mapping[str, Any]],
        log_blockers: bool = False,
    ) -> tuple[Mapping[str, Any], Mapping[str, Any]] | None:
        payload = self._paper_route_materialized_source_payload(decision_row)
        if payload is None:
            return None
        if self.executor.execution_exists(session, decision_row):
            return None
        raw_target = self._paper_route_materialized_target_from_payload(payload)
        if raw_target is None:
            return None
        target = _bounded_sim_collection_target_with_runtime_account_audit(
            raw_target,
            positions=positions,
            account_label=self.account_label,
        )
        if not _target_requires_bounded_sim_collection_gate(target):
            return None
        collection_blockers = _bounded_sim_collection_blockers(
            target,
            account_label=self.account_label,
        )
        if not collection_blockers:
            return payload, target
        if log_blockers:
            logger.warning(
                "Skipping materialized paper-route target source decision because "
                "bounded SIM collection is not authorized decision_id=%s blockers=%s",
                decision_row.id,
                ",".join(collection_blockers),
            )
        return None

    @staticmethod
    def _paper_route_materialized_window_cap(
        *,
        target: Mapping[str, Any],
        now: datetime,
    ) -> _MaterializedWindowCap | None:
        window = _target_probe_window(target)
        if window is None:
            return None
        window_start, window_end = window
        if now < window_start or now >= window_end:
            return None
        target_cap = _target_probe_cap(target)
        if target_cap is None or target_cap <= 0:
            return None
        return _MaterializedWindowCap(
            window_start=window_start,
            window_end=window_end,
            target_cap=target_cap,
        )

    def _paper_route_materialized_strategy_action(
        self,
        *,
        session: Session,
        decision_row: TradeDecision,
        payload: Mapping[str, Any],
        target: Mapping[str, Any],
        strategies: Sequence[Strategy],
    ) -> tuple[Strategy, str, Literal["buy", "sell"]] | None:
        strategy = session.get(Strategy, decision_row.strategy_id)
        if strategy is None:
            strategy = self._paper_route_target_strategy(target, strategies)
        if strategy is None:
            return None
        symbol = _safe_text(decision_row.symbol) or _safe_text(payload.get("symbol"))
        if symbol is None:
            return None
        symbol = symbol.upper()
        strategy_symbols = self._paper_route_target_strategy_symbols(strategy)
        if strategy_symbols and symbol not in strategy_symbols:
            return None
        symbol_actions = _target_probe_symbol_actions(target, [symbol])
        action_text = _safe_text(payload.get("action")) or symbol_actions.get(symbol)
        if action_text not in {"buy", "sell"}:
            action_text = _target_probe_action(target)
        if action_text == "sell" and not settings.trading_allow_shorts:
            return None
        return strategy, symbol, cast(Literal["buy", "sell"], action_text)

    def _paper_route_materialized_candidate(
        self,
        *,
        decision_row: TradeDecision,
        context: _MaterializedCandidateContext,
        log_blockers: bool = False,
    ) -> _MaterializedPaperRouteCandidate | None:
        payload_and_target = self._paper_route_materialized_payload_and_target(
            session=context.session,
            decision_row=decision_row,
            positions=context.positions,
            log_blockers=log_blockers,
        )
        if payload_and_target is None:
            return None
        payload, target = payload_and_target
        window_cap = self._paper_route_materialized_window_cap(
            target=target,
            now=context.now,
        )
        if window_cap is None:
            return None
        resolved = self._paper_route_materialized_strategy_action(
            session=context.session,
            decision_row=decision_row,
            payload=payload,
            target=target,
            strategies=context.strategies,
        )
        if resolved is None:
            return None
        strategy, symbol, action = resolved
        return _MaterializedPaperRouteCandidate(
            payload=payload,
            target=target,
            strategy=strategy,
            symbol=symbol,
            action=action,
            window_start=window_cap.window_start,
            window_end=window_cap.window_end,
            target_cap=window_cap.target_cap,
        )

    def _paper_route_materialized_planning_context(
        self,
        *,
        session: Session,
        rows: Sequence[TradeDecision],
        strategies: Sequence[Strategy],
        positions: Sequence[Mapping[str, Any]],
        now: datetime,
    ) -> _MaterializedPlanningContext:
        materialized_client_order_ids = (
            self._active_materialized_paper_route_client_order_ids(
                session=session,
                rows=rows,
                strategies=strategies,
                positions=positions,
                now=now,
            )
        )
        flat_check_positions = (
            self._paper_route_positions_without_materialized_open_order_projections(
                positions,
                materialized_client_order_ids,
            )
        )
        return _MaterializedPlanningContext(
            session=session,
            strategies=strategies,
            positions=positions,
            flat_check_positions=flat_check_positions,
            now=now,
        )

    def _paper_route_materialized_planned_window(
        self,
        *,
        decision_row: TradeDecision,
        payload: Mapping[str, Any],
        target: Mapping[str, Any],
        context: _MaterializedPlanningContext,
    ) -> _MaterializedPlanningWindowResult:
        window = _target_probe_window(target)
        if window is None:
            return _MaterializedPlanningWindowResult(window_cap=None)
        _, window_end = window
        if self._expire_stale_materialized_paper_route_decision(
            decision_row=decision_row,
            payload=payload,
            window_end=window_end,
            now=context.now,
        ):
            context.session.add(decision_row)
            return _MaterializedPlanningWindowResult(window_cap=None, expired=True)
        window_cap = self._paper_route_materialized_window_cap(
            target=target,
            now=context.now,
        )
        if window_cap is None or not self._is_market_session_open(context.now):
            return _MaterializedPlanningWindowResult(window_cap=None)
        return _MaterializedPlanningWindowResult(window_cap=window_cap)

    def _paper_route_materialized_has_open_exposure(
        self,
        *,
        context: _MaterializedPlanningContext,
        candidate: _MaterializedPaperRouteCandidate,
        decision_row: TradeDecision,
    ) -> bool:
        if self._paper_route_target_account_has_open_exposure(
            context.flat_check_positions
        ):
            logger.warning(
                "Skipping materialized paper-route target source decision because "
                "account is not flat for bounded SIM evidence decision_id=%s",
                decision_row.id,
            )
            return True
        if self._paper_route_target_symbol_has_open_position(
            context.flat_check_positions,
            candidate.symbol,
        ):
            return True
        if self._paper_route_target_symbol_has_open_strategy_exposure(
            session=context.session,
            strategy=candidate.strategy,
            symbol=candidate.symbol,
            account_label=self.account_label,
            window_start=candidate.window_start,
        ):
            return True
        return self._paper_route_target_symbol_has_open_profit_proof_exposure(
            session=context.session,
            strategy=candidate.strategy,
            symbol=candidate.symbol,
            account_label=self.account_label,
            window_start=candidate.window_start,
        )

    def _paper_route_materialized_planned_candidate(
        self,
        *,
        decision_row: TradeDecision,
        context: _MaterializedPlanningContext,
    ) -> _MaterializedPlanningResult:
        payload_and_target = self._paper_route_materialized_payload_and_target(
            session=context.session,
            decision_row=decision_row,
            positions=context.positions,
            log_blockers=True,
        )
        if payload_and_target is None:
            return _MaterializedPlanningResult(candidate=None)
        payload, target = payload_and_target
        window_result = self._paper_route_materialized_planned_window(
            decision_row=decision_row,
            payload=payload,
            target=target,
            context=context,
        )
        if window_result.expired:
            return _MaterializedPlanningResult(candidate=None, expired=True)
        if window_result.window_cap is None:
            return _MaterializedPlanningResult(candidate=None)

        resolved = self._paper_route_materialized_strategy_action(
            session=context.session,
            decision_row=decision_row,
            payload=payload,
            target=target,
            strategies=context.strategies,
        )
        if resolved is None:
            return _MaterializedPlanningResult(candidate=None)
        strategy, symbol, action = resolved
        candidate = _MaterializedPaperRouteCandidate(
            payload=payload,
            target=target,
            strategy=strategy,
            symbol=symbol,
            action=action,
            window_start=window_result.window_cap.window_start,
            window_end=window_result.window_cap.window_end,
            target_cap=window_result.window_cap.target_cap,
        )
        if self._paper_route_materialized_has_open_exposure(
            context=context,
            candidate=candidate,
            decision_row=decision_row,
        ):
            return _MaterializedPlanningResult(candidate=None)
        return _MaterializedPlanningResult(candidate=candidate)
