# pyright: reportUnusedImport=false, reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownVariableType=false, reportAttributeAccessIssue=false

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Literal, cast
from uuid import UUID

from sqlalchemy import select  # pyright: ignore[reportUnknownVariableType]
from sqlalchemy.orm import Session

from ...config import settings
from ...models import (
    Strategy,
    TradeDecision,
    coerce_json_payload,
)
from ..models import StrategyDecision
from ..runtime_decision_authority import (
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
)
from .target_plan_helpers import (
    _bounded_sim_collection_blockers,
    _bounded_sim_collection_metadata_from_decision,
    _bounded_sim_collection_target_with_runtime_account_audit,
    _merge_paper_route_probe_lineage,
    _optional_decimal,
    _paper_route_probe_lineage_from_params,
    _parse_target_datetime,
    _safe_int,
    _safe_text,
    _target_plan_lineage,
    _target_probe_action,
    _target_probe_cap,
    _target_probe_symbol_actions,
    _target_probe_symbol_quantities,
    _target_probe_window,
    _target_requires_bounded_sim_collection_gate,
    _target_symbols,
    _target_truthy,
)

logger = logging.getLogger(__name__)


class SimplePipelinePaperRouteMaterializationMixin:
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
        source_decision_mode = BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
        metadata["source_decision_mode"] = source_decision_mode
        metadata["profit_proof_eligible"] = True
        metadata["bounded_paper_route_submit_path"] = execution_metadata["submit_path"]
        metadata["bounded_paper_route_execution_policy"] = execution_metadata[
            "execution_policy"
        ]

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

        params: dict[str, Any] = {
            "paper_route_target_plan_materialized": True,
            "paper_route_materialized_trade_decision_id": str(decision_row.id),
            "paper_route_materialized_decision_hash": decision_row.decision_hash,
            "paper_route_target_plan": metadata,
            "paper_route_target_plan_source_decision": metadata,
            "simple_lane": simple_lane,
            "source_decision_mode": source_decision_mode,
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

        event_ts = _parse_target_datetime(payload.get("event_ts"))
        if event_ts is None:
            raw_created_at = decision_row.created_at
            event_ts = (
                raw_created_at
                if raw_created_at.tzinfo is not None
                else raw_created_at.replace(tzinfo=timezone.utc)
            )
        event_ts = event_ts.astimezone(timezone.utc)
        timeframe = (
            _safe_text(payload.get("timeframe")) or strategy.base_timeframe or "1Min"
        )
        payload_qty = _optional_decimal(payload.get("qty"))
        if payload_qty is not None and payload_qty <= 0:
            return None
        requested_qty = payload_qty or symbol_quantities.get(symbol) or Decimal("1")
        quantity_resolution = self._paper_route_target_quantity_resolution(
            target=target,
            symbol=symbol,
            symbols=target_symbols,
            action=action,
            requested_qty=requested_qty,
            symbol_quantities=symbol_quantities,
            max_notional=max_notional,
            event_ts=event_ts,
            timeframe=timeframe,
        )
        if quantity_resolution is None:
            return None
        if quantity_resolution.audit.get("sizing_source") != "target_notional":
            blockers = quantity_resolution.audit.get("blockers")
            blocker_items = (
                cast(list[object], blockers) if isinstance(blockers, list) else []
            )
            blocker_text = ",".join(str(item) for item in blocker_items)
            logger.warning(
                "Skipping materialized paper-route target source decision because "
                "target-notional sizing is not authoritative decision_id=%s "
                "symbol=%s blockers=%s",
                decision_row.id,
                symbol,
                blocker_text,
            )
            return None
        qty = quantity_resolution.qty
        metadata["paper_route_target_notional_sizing"] = quantity_resolution.audit
        simple_lane["paper_route_target_notional_sizing"] = quantity_resolution.audit
        simple_lane["target_source_notional_sized"] = (
            quantity_resolution.audit.get("sizing_source") == "target_notional"
        )
        params["paper_route_target_notional_sizing"] = quantity_resolution.audit
        params.update(quantity_resolution.price_params)

        order_type_text = _safe_text(payload.get("order_type")) or "market"
        order_type: Literal["market", "limit", "stop", "stop_limit"] = (
            cast(
                Literal["market", "limit", "stop", "stop_limit"],
                order_type_text,
            )
            if order_type_text in {"market", "limit", "stop", "stop_limit"}
            else "market"
        )
        time_in_force_text = _safe_text(payload.get("time_in_force")) or "day"
        time_in_force: Literal["day", "gtc", "ioc", "fok"] = (
            cast(Literal["day", "gtc", "ioc", "fok"], time_in_force_text)
            if time_in_force_text in {"day", "gtc", "ioc", "fok"}
            else "day"
        )

        return StrategyDecision(
            strategy_id=str(strategy.id),
            symbol=symbol,
            event_ts=event_ts or now,
            timeframe=timeframe,
            action=action,
            qty=qty,
            order_type=order_type,
            time_in_force=time_in_force,
            rationale=("materialized bounded paper-route target plan source decision"),
            params=params,
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

    def _active_materialized_paper_route_client_order_ids(
        self,
        *,
        session: Session,
        rows: Sequence[TradeDecision],
        strategies: Sequence[Strategy],
        positions: Sequence[Mapping[str, Any]],
        now: datetime,
    ) -> set[str]:
        client_order_ids: set[str] = set()
        for decision_row in rows:
            decision_hash = _safe_text(decision_row.decision_hash)
            if decision_hash is None:
                continue
            payload = self._paper_route_materialized_source_payload(decision_row)
            if payload is None:
                continue
            if self.executor.execution_exists(session, decision_row):
                continue
            raw_target = self._paper_route_materialized_target_from_payload(payload)
            if raw_target is None:
                continue
            target = _bounded_sim_collection_target_with_runtime_account_audit(
                raw_target,
                positions=positions,
                account_label=self.account_label,
            )
            if not _target_requires_bounded_sim_collection_gate(target):
                continue
            collection_blockers = _bounded_sim_collection_blockers(
                target,
                account_label=self.account_label,
            )
            if collection_blockers:
                continue
            window = _target_probe_window(target)
            if window is None:
                continue
            window_start, window_end = window
            if now < window_start or now >= window_end:
                continue
            target_cap = _target_probe_cap(target)
            if target_cap is None or target_cap <= 0:
                continue
            strategy = session.get(Strategy, decision_row.strategy_id)
            if strategy is None:
                strategy = self._paper_route_target_strategy(target, strategies)
            if strategy is None:
                continue
            symbol = _safe_text(decision_row.symbol) or _safe_text(
                payload.get("symbol")
            )
            if symbol is None:
                continue
            symbol = symbol.upper()
            strategy_symbols = self._paper_route_target_strategy_symbols(strategy)
            if strategy_symbols and symbol not in strategy_symbols:
                continue
            symbol_actions = _target_probe_symbol_actions(target, [symbol])
            action_text = _safe_text(payload.get("action")) or symbol_actions.get(
                symbol
            )
            if action_text not in {"buy", "sell"}:
                action_text = _target_probe_action(target)
            if action_text == "sell" and not settings.trading_allow_shorts:
                continue
            client_order_ids.add(decision_hash)
        return client_order_ids

    def _paper_route_materialized_planned_decisions(
        self,
        *,
        session: Session,
        strategies: Sequence[Strategy],
        allowed_symbols: set[str],
        positions: Sequence[Mapping[str, Any]],
    ) -> list[StrategyDecision]:
        if settings.trading_mode != "paper":
            return []
        if not settings.trading_simple_paper_route_probe_enabled:
            return []
        now = self._trading_now().astimezone(timezone.utc)

        rows = (
            session.execute(
                select(TradeDecision)
                .where(
                    TradeDecision.status == "planned",
                    TradeDecision.alpaca_account_label == self.account_label,
                )
                .order_by(TradeDecision.created_at.asc(), TradeDecision.symbol.asc())
                .limit(100)
            )
            .scalars()
            .all()
        )
        decisions: list[StrategyDecision] = []
        seen: set[str] = set()
        expired_count = 0
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
        for decision_row in rows:
            if str(decision_row.id) in seen:
                continue
            payload = self._paper_route_materialized_source_payload(decision_row)
            if payload is None:
                continue
            if self.executor.execution_exists(session, decision_row):
                continue
            raw_target = self._paper_route_materialized_target_from_payload(payload)
            if raw_target is None:
                continue
            target = _bounded_sim_collection_target_with_runtime_account_audit(
                raw_target,
                positions=positions,
                account_label=self.account_label,
            )
            if _target_requires_bounded_sim_collection_gate(target):
                collection_blockers = _bounded_sim_collection_blockers(
                    target,
                    account_label=self.account_label,
                )
                if collection_blockers:
                    logger.warning(
                        "Skipping materialized paper-route target source decision "
                        "because bounded SIM collection is not authorized "
                        "decision_id=%s blockers=%s",
                        decision_row.id,
                        ",".join(collection_blockers),
                    )
                    continue
            else:
                continue

            window = _target_probe_window(target)
            if window is None:
                continue
            window_start, window_end = window
            if self._expire_stale_materialized_paper_route_decision(
                decision_row=decision_row,
                payload=payload,
                window_end=window_end,
                now=now,
            ):
                session.add(decision_row)
                expired_count += 1
                seen.add(str(decision_row.id))
                continue
            if now < window_start or now >= window_end:
                continue
            if not self._is_market_session_open(now):
                continue
            target_cap = _target_probe_cap(target)
            if target_cap is None or target_cap <= 0:
                continue
            strategy = session.get(Strategy, decision_row.strategy_id)
            if strategy is None:
                strategy = self._paper_route_target_strategy(target, strategies)
            if strategy is None:
                continue
            symbol = _safe_text(decision_row.symbol) or _safe_text(
                payload.get("symbol")
            )
            if symbol is None:
                continue
            symbol = symbol.upper()
            strategy_symbols = self._paper_route_target_strategy_symbols(strategy)
            if strategy_symbols and symbol not in strategy_symbols:
                continue
            symbol_actions = _target_probe_symbol_actions(target, [symbol])
            action_text = _safe_text(payload.get("action")) or symbol_actions.get(
                symbol
            )
            if action_text not in {"buy", "sell"}:
                action_text = _target_probe_action(target)
            action = cast(Literal["buy", "sell"], action_text)
            if action == "sell" and not settings.trading_allow_shorts:
                continue
            if self._paper_route_target_account_has_open_exposure(flat_check_positions):
                logger.warning(
                    "Skipping materialized paper-route target source decision because "
                    "account is not flat for bounded SIM evidence decision_id=%s",
                    decision_row.id,
                )
                continue
            if self._paper_route_target_symbol_has_open_position(
                flat_check_positions, symbol
            ):
                continue
            if self._paper_route_target_symbol_has_open_strategy_exposure(
                session=session,
                strategy=strategy,
                symbol=symbol,
                account_label=self.account_label,
                window_start=window_start,
            ):
                continue
            if self._paper_route_target_symbol_has_open_profit_proof_exposure(
                session=session,
                strategy=strategy,
                symbol=symbol,
                account_label=self.account_label,
                window_start=window_start,
            ):
                continue
            decision = self._paper_route_materialized_decision_with_execution_metadata(
                decision_row=decision_row,
                payload=payload,
                target=target,
                strategy=strategy,
                symbol=symbol,
                action=action,
                window_start=window_start,
                window_end=window_end,
                max_notional=target_cap,
                now=now,
            )
            if decision is None:
                continue
            decisions.append(decision)
            seen.add(str(decision_row.id))
        if expired_count:
            session.commit()
            logger.warning(
                "Expired stale materialized paper-route target source decisions account_label=%s count=%s",
                self.account_label,
                expired_count,
            )
        return decisions

    def _process_paper_route_materialized_decisions(
        self,
        *,
        session: Session,
        strategies: list[Strategy],
        account: dict[str, str],
        positions: list[dict[str, Any]],
        allowed_symbols: set[str],
    ) -> None:
        decisions = self._paper_route_materialized_planned_decisions(
            session=session,
            strategies=strategies,
            positions=positions,
            allowed_symbols=allowed_symbols,
        )
        for decision in decisions:
            self.state.metrics.decisions_total += 1
            try:
                submitted = self._handle_decision(
                    session,
                    decision,
                    strategies,
                    account,
                    positions,
                    allowed_symbols,
                )
                if submitted is not None:
                    self._apply_simple_projected_buying_power(
                        account,
                        positions,
                        submitted,
                    )
                    self._apply_simple_projected_position(positions, submitted)
            except Exception:
                logger.exception(
                    "Materialized paper-route target source decision handling failed "
                    "strategy_id=%s symbol=%s timeframe=%s",
                    decision.strategy_id,
                    decision.symbol,
                    decision.timeframe,
                )
                self.state.metrics.orders_rejected_total += 1
                self.state.metrics.record_decision_rejection_reasons(
                    ["broker_submit_failed"]
                )

    def _reopen_bounded_sim_collection_decision(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
    ) -> TradeDecision | None:
        retry_transition = self._paper_route_retry_transition(
            decision_row,
            allowed_kinds=frozenset({"bounded_probe"}),
        )
        if retry_transition is None:
            return None
        retry_metadata = retry_transition.metadata
        if self.executor.execution_exists(session, decision_row):
            return None
        collection_metadata = _bounded_sim_collection_metadata_from_decision(
            decision,
            account_label=self.account_label,
            trading_mode=settings.trading_mode,
        )
        if collection_metadata is None:
            return None
        proof_floor = self._profitability_proof_floor(session=session)
        if self._proof_floor_submission_block_reason(proof_floor) is None:
            return None

        self.executor.update_decision_params(session, decision_row, decision.params)
        self.executor.sync_decision_state(session, decision_row, decision)
        decision_row.status = "planned"
        decision_row.created_at = self._trading_now()
        decision_json = dict(cast(Mapping[str, Any], decision_row.decision_json))
        retry_attempts = _safe_int(
            decision_json.get("paper_route_probe_retry_attempts")
        )
        decision_json["paper_route_probe_retry_attempts"] = retry_attempts + 1
        decision_json["bounded_sim_collection_retry"] = {
            **retry_metadata,
            "submission_stage": "bounded_sim_collection_retry_pending",
            "symbol": decision.symbol.strip().upper(),
            "strategy_id": decision.strategy_id,
            "collection_metadata": dict(collection_metadata),
        }
        decision_json["submission_stage"] = "bounded_sim_collection_retry_pending"
        decision_json.pop("submission_block_reason", None)
        decision_json.pop("submission_block_atomic", None)
        decision_row.decision_json = decision_json
        session.add(decision_row)
        session.commit()
        session.refresh(decision_row)
        logger.warning(
            "Reopening proof-floor-blocked decision for bounded SIM evidence collection strategy_id=%s decision_id=%s symbol=%s previous_reason=%s",
            decision.strategy_id,
            decision_row.id,
            decision.symbol,
            retry_metadata["previous_submission_block_reason"],
        )
        return decision_row

    def _claim_materialized_paper_route_decision_row(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        strategy: Strategy,
    ) -> TradeDecision | None:
        row_id_text = _safe_text(
            decision.params.get("paper_route_materialized_trade_decision_id")
        )
        if row_id_text is None:
            return None
        try:
            row_id = UUID(row_id_text)
        except ValueError:
            return None
        decision_row = session.get(TradeDecision, row_id)
        if decision_row is None:
            return None
        if decision_row.alpaca_account_label != self.account_label:
            return None
        retryable_status = (
            decision_row.status in {"blocked", "rejected"}
            and self._paper_route_retry_transition(decision_row) is not None
        )
        if decision_row.status != "planned" and not retryable_status:
            return None
        if self.executor.execution_exists(session, decision_row):
            return None

        decision_row.strategy_id = strategy.id
        decision_row.symbol = decision.symbol
        decision_row.timeframe = decision.timeframe
        decision_row.rationale = decision.rationale
        if decision_row.status == "planned":
            decision_row.decision_json = coerce_json_payload(
                decision.model_dump(mode="json")
            )
        session.add(decision_row)
        session.commit()
        session.refresh(decision_row)
        return decision_row

    def _ensure_pending_decision_row(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        strategy: Strategy,
    ) -> TradeDecision | None:
        decision = self._with_paper_route_target_lineage(decision, strategy=strategy)
        if (
            _safe_text(
                decision.params.get("paper_route_materialized_trade_decision_id")
            )
            is not None
        ):
            decision_row = self._claim_materialized_paper_route_decision_row(
                session=session,
                decision=decision,
                strategy=strategy,
            )
            if decision_row is None:
                return None
        else:
            decision_row = self.executor.ensure_decision(
                session, decision, strategy, self.account_label
            )
        reopened_quote_routeability = (
            self._reopen_rejected_paper_route_quote_routeability_decision(
                session=session,
                decision=decision,
                decision_row=decision_row,
            )
        )
        if reopened_quote_routeability is not None:
            return reopened_quote_routeability
        reopened_exit = self._reopen_rejected_paper_route_probe_exit_decision(
            session=session,
            decision=decision,
            decision_row=decision_row,
        )
        if reopened_exit is not None:
            return reopened_exit
        reopened_price_retry = self._reopen_rejected_paper_route_target_price_decision(
            session=session,
            decision=decision,
            decision_row=decision_row,
        )
        if reopened_price_retry is not None:
            return reopened_price_retry
        reopened_bounded_collection = self._reopen_bounded_sim_collection_decision(
            session=session,
            decision=decision,
            decision_row=decision_row,
        )
        if reopened_bounded_collection is not None:
            return reopened_bounded_collection
        if "paper_route_target_plan" in decision.params:
            self.executor.update_decision_params(session, decision_row, decision.params)
            self.executor.sync_decision_state(session, decision_row, decision)
        if (
            decision_row.status == "planned"
            and self._paper_route_target_source_cap(decision.params) is not None
        ):
            decision_row.created_at = self._trading_now()
            session.add(decision_row)
            session.commit()
            session.refresh(decision_row)
        if (
            _safe_text(
                decision.params.get("paper_route_materialized_trade_decision_id")
            )
            is not None
        ):
            return decision_row
        retry_transition = self._paper_route_retry_transition(
            decision_row,
            allowed_kinds=frozenset({"bounded_probe"}),
        )
        if retry_transition is None:
            return super()._ensure_pending_decision_row(
                session=session,
                decision=decision,
                strategy=strategy,
            )
        retry_metadata = retry_transition.metadata
        if self.executor.execution_exists(session, decision_row):
            return None

        proof_floor = self._profitability_proof_floor(session=session)
        if self._proof_floor_submission_block_reason(proof_floor) is None:
            return None
        probe_context = self._paper_route_probe_context(
            proof_floor=proof_floor,
            decision=decision,
            strategy=strategy,
            session=session,
            strategies=[strategy],
        )
        if probe_context is None:
            return None
        if self._paper_route_probe_reference_price(decision) is None:
            return None

        decision_row.status = "planned"
        decision_json = dict(cast(Mapping[str, Any], decision_row.decision_json))
        retry_attempts = _safe_int(
            decision_json.get("paper_route_probe_retry_attempts")
        )
        decision_json["paper_route_probe_retry_attempts"] = retry_attempts + 1
        decision_json["paper_route_probe_retry"] = {
            **retry_metadata,
            "submission_stage": "paper_route_probe_retry_pending",
            "symbol": decision.symbol.strip().upper(),
            "strategy_id": decision.strategy_id,
            "context": dict(probe_context),
        }
        decision_json["submission_stage"] = "paper_route_probe_retry_pending"
        decision_json.pop("submission_block_reason", None)
        decision_json.pop("submission_block_atomic", None)
        decision_row.decision_json = decision_json
        session.add(decision_row)
        session.commit()
        session.refresh(decision_row)
        logger.warning(
            "Reopening proof-floor-blocked decision for bounded paper route probe strategy_id=%s decision_id=%s symbol=%s previous_reason=%s",
            decision.strategy_id,
            decision_row.id,
            decision.symbol,
            retry_metadata["previous_submission_block_reason"],
        )
        return decision_row
