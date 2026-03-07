"""Order execution and idempotency helpers."""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, NamedTuple, Optional, cast

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..models import (
    Execution,
    LeanExecutionShadowEvent,
    Strategy,
    TradeDecision,
    coerce_json_payload,
)
from ..config import settings
from ..snapshots import sync_order_to_db
from .route_metadata import resolve_order_route_metadata
from .execution_policy import should_retry_order_error
from .models import ExecutionRequest, StrategyDecision, decision_hash
from .quantity_rules import (
    fractional_equities_enabled_for_trade,
    min_qty_for_symbol,
    quantize_qty_for_symbol,
    qty_has_valid_increment,
    qty_step_for_symbol,
)
from .simulation import resolve_simulation_context
from .time_source import trading_now
from .tca import upsert_execution_tca_metric

logger = logging.getLogger(__name__)

_SHORTING_METADATA_CACHE_TTL_SECONDS = 30.0


class OrderExecutor:
    """Submit orders to a broker adapter with idempotency guards."""

    def __init__(self) -> None:
        self._account_metadata_cache: dict[str, Any] | None = None
        self._account_metadata_cached_at_monotonic: float | None = None
        self._asset_metadata_cache: dict[str, tuple[dict[str, Any] | None, float]] = {}
        self._shorting_metadata_status: dict[str, Any] = {
            "account_ready": None,
            "last_refresh_at": None,
            "last_error": None,
            "cache_ttl_seconds": _SHORTING_METADATA_CACHE_TTL_SECONDS,
        }

    def ensure_decision(
        self,
        session: Session,
        decision: StrategyDecision,
        strategy: Strategy,
        account_label: str,
    ) -> TradeDecision:
        digest = decision_hash(
            decision,
            account_label=account_label
            if settings.trading_multi_account_enabled
            else None,
        )
        stmt = select(TradeDecision).where(
            TradeDecision.decision_hash == digest,
            TradeDecision.alpaca_account_label == account_label,
        )
        existing = session.execute(stmt).scalar_one_or_none()
        if existing:
            return existing

        decision_payload = coerce_json_payload(decision.model_dump(mode="json"))
        decision_row = TradeDecision(
            strategy_id=strategy.id,
            alpaca_account_label=account_label,
            symbol=decision.symbol,
            timeframe=decision.timeframe,
            decision_json=decision_payload,
            rationale=decision.rationale,
            status="planned",
            decision_hash=digest,
            created_at=decision.event_ts if settings.trading_simulation_enabled else trading_now(account_label=account_label),
        )
        session.add(decision_row)
        try:
            session.commit()
            session.refresh(decision_row)
            return decision_row
        except IntegrityError:
            session.rollback()
            existing = session.execute(stmt).scalar_one_or_none()
            if existing is None:
                raise
            return existing

    def execution_exists(self, session: Session, decision_row: TradeDecision) -> bool:
        return self._fetch_execution(session, decision_row) is not None

    def _fetch_execution(
        self, session: Session, decision_row: TradeDecision
    ) -> Optional[Execution]:
        # Resolve by exact decision linkage first, then fall back to account-scoped
        # client_order_id idempotency. Never match by account label alone.
        linked_stmt = (
            select(Execution)
            .where(Execution.trade_decision_id == decision_row.id)
            .order_by(Execution.created_at.desc())
            .limit(1)
        )
        linked = session.execute(linked_stmt).scalars().first()
        if linked is not None:
            return linked

        if not decision_row.decision_hash:
            return None
        hash_stmt = (
            select(Execution)
            .where(
                Execution.client_order_id == decision_row.decision_hash,
                Execution.alpaca_account_label == decision_row.alpaca_account_label,
            )
            .order_by(Execution.created_at.desc())
            .limit(1)
        )
        return session.execute(hash_stmt).scalars().first()

    def submit_order(
        self,
        session: Session,
        execution_client: Any,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        account_label: str,
        *,
        execution_expected_adapter: Optional[str] = None,
        retry_delays: Optional[list[float]] = None,
    ) -> Optional[Execution]:
        existing_execution = self._fetch_execution(session, decision_row)
        if existing_execution is not None:
            logger.info("Execution already exists for decision %s", decision_row.id)
            return None
        execution_policy_context = _extract_execution_policy_context(
            decision, decision_row=decision_row
        )
        if self._sync_existing_order_if_present(
            session=session,
            execution_client=execution_client,
            decision=decision,
            decision_row=decision_row,
            account_label=account_label,
            execution_expected_adapter=execution_expected_adapter,
            execution_policy_context=execution_policy_context,
        ):
            return None

        request = ExecutionRequest(
            decision_id=str(decision_row.id),
            symbol=decision.symbol,
            side=decision.action,
            qty=decision.qty,
            order_type=decision.order_type,
            time_in_force=decision.time_in_force,
            limit_price=decision.limit_price,
            stop_price=decision.stop_price,
            client_order_id=decision_row.decision_hash,
        )
        fractional_equities_enabled = self._fractional_equities_enabled_for_request(
            execution_client,
            request,
        )
        pre_submit_error = _validate_pre_submit_request(
            request,
            fractional_equities_enabled=fractional_equities_enabled,
        )
        if pre_submit_error is not None:
            raise RuntimeError(json.dumps(pre_submit_error))
        short_precheck_error = self._validate_short_sell_constraints(
            execution_client,
            request,
        )
        if short_precheck_error is not None:
            raise RuntimeError(json.dumps(short_precheck_error))

        if retry_delays is None:
            retry_delays = []
        submission_extra_params: dict[str, Any] = {
            "client_order_id": request.client_order_id
        }
        simulation_context = _resolve_submission_simulation_context(
            execution_client=execution_client,
            decision=decision,
            decision_row=decision_row,
        )
        if simulation_context is not None:
            submission_extra_params["simulation_context"] = simulation_context
        self._raise_if_conflicting_open_order(execution_client, request)
        sell_inventory_conflict = self._find_sell_inventory_conflict(
            execution_client,
            request,
            self._list_open_orders(execution_client),
        )
        if sell_inventory_conflict is not None:
            request, sell_qty_adjustment, unresolved_conflict = (
                self._resolve_sell_inventory_conflict(
                    request,
                    conflict=sell_inventory_conflict,
                    fractional_equities_enabled=fractional_equities_enabled,
                )
            )
            sell_inventory_recovery: dict[str, Any] | None = None
            if unresolved_conflict is not None:
                (
                    request,
                    sell_qty_adjustment,
                    unresolved_conflict,
                    sell_inventory_recovery,
                ) = self._retry_sell_inventory_conflict_after_cancel(
                    execution_client=execution_client,
                    request=request,
                    conflict=unresolved_conflict,
                    fractional_equities_enabled=fractional_equities_enabled,
                )
            if unresolved_conflict is not None:
                if sell_inventory_recovery is not None:
                    self.update_decision_json(
                        session,
                        decision_row,
                        {"broker_precheck_recovery": sell_inventory_recovery},
                    )
                raise RuntimeError(json.dumps(unresolved_conflict))
            metadata_update: dict[str, Any] = {}
            if sell_qty_adjustment is not None:
                metadata_update["broker_precheck_adjustment"] = sell_qty_adjustment
            if sell_inventory_recovery is not None:
                metadata_update["broker_precheck_recovery"] = sell_inventory_recovery
            if metadata_update or request.qty != decision.qty:
                decision = decision.model_copy(update={"qty": request.qty})
                self.sync_decision_state(
                    session,
                    decision_row,
                    decision,
                    metadata_update=metadata_update or None,
                )
        order_response = self._submit_order_with_retry(
            execution_client=execution_client,
            request=request,
            retry_delays=retry_delays,
            decision_id=str(decision_row.id),
            extra_params=submission_extra_params,
        )

        route_expected, route_actual, fallback_reason, fallback_count = (
            resolve_order_route_metadata(
                expected_adapter=execution_expected_adapter,
                execution_client=execution_client,
                order_response=order_response,
            )
        )
        order_payload = dict(order_response)
        advice_provenance = _extract_execution_advice_provenance(
            decision,
            decision_row=decision_row,
        )
        if advice_provenance is not None:
            order_payload["_execution_advice_provenance"] = advice_provenance
        execution = sync_order_to_db(
            session,
            order_payload,
            trade_decision_id=str(decision_row.id),
            alpaca_account_label=account_label,
            execution_expected_adapter=route_expected,
            execution_actual_adapter=route_actual,
            execution_fallback_reason=fallback_reason,
            execution_fallback_count=fallback_count,
        )
        _persist_lean_shadow_event(
            session,
            execution=execution,
            order_payload=order_payload,
            decision=decision,
        )
        _attach_execution_policy_context(execution, execution_policy_context)
        upsert_execution_tca_metric(session, execution)
        _apply_execution_status(
            decision_row,
            execution,
            account_label,
            submitted_at=decision.event_ts if settings.trading_simulation_enabled else trading_now(account_label=account_label),
            status_override="submitted",
        )
        session.add(decision_row)
        session.commit()
        return execution

    def _sync_existing_order_if_present(
        self,
        *,
        session: Session,
        execution_client: Any,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        account_label: str,
        execution_expected_adapter: Optional[str],
        execution_policy_context: dict[str, Any],
    ) -> bool:
        existing_order = self._fetch_existing_order(
            execution_client, decision_row.decision_hash
        )
        if existing_order is None:
            return False
        existing_payload = dict(existing_order)
        advice_provenance = _extract_execution_advice_provenance(
            decision,
            decision_row=decision_row,
        )
        if advice_provenance is not None:
            existing_payload["_execution_advice_provenance"] = advice_provenance
        route_expected, route_actual, fallback_reason, fallback_count = (
            resolve_order_route_metadata(
                expected_adapter=execution_expected_adapter,
                execution_client=execution_client,
                order_response=existing_payload,
            )
        )
        execution = sync_order_to_db(
            session,
            existing_payload,
            trade_decision_id=str(decision_row.id),
            alpaca_account_label=account_label,
            execution_expected_adapter=route_expected,
            execution_actual_adapter=route_actual,
            execution_fallback_reason=fallback_reason,
            execution_fallback_count=fallback_count,
        )
        _attach_execution_policy_context(execution, execution_policy_context)
        upsert_execution_tca_metric(session, execution)
        _apply_execution_status(decision_row, execution, account_label)
        session.add(decision_row)
        session.commit()
        logger.info(
            "Backfilled execution for decision %s from broker state",
            decision_row.id,
        )
        return True

    def _raise_if_conflicting_open_order(
        self,
        execution_client: Any,
        request: ExecutionRequest,
    ) -> None:
        open_orders = self._list_open_orders(execution_client)
        conflicting_order = self._find_conflicting_open_order(request, open_orders)
        if conflicting_order is not None:
            existing_order_id = (
                conflicting_order.get("id")
                or conflicting_order.get("order_id")
                or conflicting_order.get("client_order_id")
            )
            existing_order_type = str(
                conflicting_order.get("type")
                or conflicting_order.get("order_type")
                or "unknown"
            ).lower()
            existing_order_side = str(conflicting_order.get("side") or "unknown").lower()
            payload = {
                "source": "broker_precheck",
                "code": "precheck_opposite_side_open_order",
                "reject_reason": f"opposite side {existing_order_type} order exists",
                "existing_order_id": existing_order_id,
                "existing_order_side": existing_order_side,
                "existing_order_type": existing_order_type,
            }
            raise RuntimeError(json.dumps(payload))

    def _submit_order_with_retry(
        self,
        *,
        execution_client: Any,
        request: ExecutionRequest,
        retry_delays: list[float],
        decision_id: str,
        extra_params: dict[str, Any],
    ) -> Any:
        attempt = 0
        while True:
            try:
                return execution_client.submit_order(
                    symbol=request.symbol,
                    side=request.side,
                    qty=float(request.qty),
                    order_type=request.order_type,
                    time_in_force=request.time_in_force,
                    limit_price=float(request.limit_price)
                    if request.limit_price is not None
                    else None,
                    stop_price=float(request.stop_price)
                    if request.stop_price is not None
                    else None,
                    extra_params=dict(extra_params),
                )
            except Exception as exc:
                if attempt >= len(retry_delays) or not should_retry_order_error(exc):
                    raise
                delay = retry_delays[attempt]
                attempt += 1
                logger.warning(
                    "Retrying order submission attempt=%s decision_id=%s error=%s",
                    attempt,
                    decision_id,
                    exc,
                )
                time.sleep(delay)

    def mark_rejected(
        self,
        session: Session,
        decision_row: TradeDecision,
        reason: str,
        metadata_update: Mapping[str, Any] | None = None,
    ) -> None:
        decision_row.status = "rejected"
        decision_json = _coerce_json(decision_row.decision_json)
        existing = decision_json.get("risk_reasons")
        if isinstance(existing, list):
            risk_reasons = [str(item) for item in cast(list[Any], existing)]
        else:
            risk_reasons = []
        risk_reasons.append(reason)
        decision_json["risk_reasons"] = risk_reasons
        reject_atomic = _merge_unique_strings(
            _coerce_string_list(decision_json.get("reject_reason_atomic")),
            [
                normalized.atomic_reason
                for normalized in _normalize_reject_reasons(reason)
            ],
        )
        if reject_atomic:
            decision_json["reject_reason_atomic"] = reject_atomic
            primary = _normalize_reject_reasons(reason)[0]
            decision_json["reject_class"] = primary.reject_class
            decision_json["reject_origin"] = primary.reject_origin
        sizing_debug = _extract_sizing_debug(decision_json)
        if sizing_debug and any(
            atomic_reason in {"qty_below_min", "symbol_capacity_exhausted"}
            for atomic_reason in reject_atomic
        ):
            decision_json["sizing_debug"] = sizing_debug
        if metadata_update:
            for key, value in metadata_update.items():
                decision_json[key] = coerce_json_payload(value)
        decision_row.decision_json = decision_json
        session.add(decision_row)
        session.commit()

    def update_decision_json(
        self,
        session: Session,
        decision_row: TradeDecision,
        update: Mapping[str, Any],
    ) -> None:
        decision_json = _coerce_json(decision_row.decision_json)
        for key, value in update.items():
            decision_json[key] = coerce_json_payload(value)
        decision_row.decision_json = decision_json
        session.add(decision_row)
        session.commit()

    def update_decision_params(
        self,
        session: Session,
        decision_row: TradeDecision,
        params_update: Mapping[str, Any],
    ) -> None:
        decision_json = _coerce_json(decision_row.decision_json)
        params_value = decision_json.get("params")
        if isinstance(params_value, Mapping):
            params = dict(cast(Mapping[str, Any], params_value))
        else:
            params = {}
        params.update(params_update)
        decision_json["params"] = params
        decision_row.decision_json = decision_json
        session.add(decision_row)
        session.commit()

    def sync_decision_state(
        self,
        session: Session,
        decision_row: TradeDecision,
        decision: StrategyDecision,
        *,
        metadata_update: Mapping[str, Any] | None = None,
    ) -> None:
        update = _decision_state_payload(decision)
        if metadata_update:
            update.update({str(key): value for key, value in metadata_update.items()})
        self.update_decision_json(session, decision_row, update)

    def prime_shorting_metadata_cache(self, execution_client: Any) -> None:
        self._get_account(execution_client, force_refresh=True)

    def shorting_metadata_status(self) -> dict[str, Any]:
        return dict(self._shorting_metadata_status)

    def position_qty_for_symbol(
        self,
        execution_client: Any,
        symbol: str,
    ) -> Decimal | None:
        return self._position_qty_for_symbol(execution_client, symbol)

    @staticmethod
    def _fetch_existing_order(
        execution_client: Any,
        decision_hash_value: Optional[str],
    ) -> Optional[dict[str, Any]]:
        if not decision_hash_value:
            return None
        try:
            getter = getattr(execution_client, "get_order_by_client_order_id", None)
            if getter is None:
                return None
            order = getter(decision_hash_value)
        except Exception as exc:  # pragma: no cover - external failure
            logger.warning("Failed to fetch broker order for client_order_id: %s", exc)
            return None
        if not order:
            return None
        return order

    @classmethod
    def _find_conflicting_open_order(
        cls,
        request: ExecutionRequest,
        open_orders: list[dict[str, Any]],
    ) -> Optional[dict[str, Any]]:
        request_symbol = request.symbol.strip().upper()
        request_side = request.side.strip().lower()
        if not request_symbol or request_side not in {"buy", "sell"}:
            return None
        for order in open_orders:
            symbol = str(order.get("symbol") or "").strip().upper()
            if symbol != request_symbol:
                continue
            side = str(order.get("side") or "").strip().lower()
            if side not in {"buy", "sell"} or side == request_side:
                continue
            order_type = (
                str(order.get("type") or order.get("order_type") or "").strip().lower()
            )
            if order_type not in {"market", "stop", "stop_limit"}:
                continue
            status = str(order.get("status") or "").strip().lower()
            if status in {"filled", "canceled", "cancelled", "rejected", "expired"}:
                continue
            return order
        return None

    @classmethod
    def _find_sell_inventory_conflict(
        cls,
        execution_client: Any,
        request: ExecutionRequest,
        open_orders: list[dict[str, Any]],
    ) -> dict[str, Any] | None:
        request_symbol = request.symbol.strip().upper()
        request_side = request.side.strip().lower()
        if not request_symbol or request_side != "sell":
            return None

        held_for_open_sells = Decimal("0")
        existing_order_ids: list[str] = []
        for order in open_orders:
            symbol = str(order.get("symbol") or "").strip().upper()
            if symbol != request_symbol:
                continue
            side = str(order.get("side") or "").strip().lower()
            if side != "sell":
                continue
            status = str(order.get("status") or "").strip().lower()
            if status in {"filled", "canceled", "cancelled", "rejected", "expired"}:
                continue
            remaining_qty = cls._remaining_order_qty(order)
            if remaining_qty <= 0:
                continue
            held_for_open_sells += remaining_qty
            existing_order_id = (
                order.get("id")
                or order.get("order_id")
                or order.get("client_order_id")
            )
            if existing_order_id is not None:
                existing_order_ids.append(str(existing_order_id))

        if held_for_open_sells <= 0:
            return None

        position_qty = cls._position_qty_for_symbol(execution_client, request_symbol)
        if position_qty is None:
            if request.qty > held_for_open_sells:
                return None
            return {
                "source": "broker_precheck",
                "code": "precheck_sell_qty_exceeds_available",
                "reject_reason": (
                    "sell qty may exceed available inventory; position lookup unavailable and "
                    "open sell reservations cover requested qty"
                ),
                "symbol": request_symbol,
                "qty": str(request.qty),
                "position_qty": None,
                "held_for_open_sells": str(held_for_open_sells),
                "available_qty": None,
                "existing_order_id": existing_order_ids[0] if existing_order_ids else None,
                "existing_order_ids": existing_order_ids,
            }
        if position_qty <= 0:
            return None

        available_qty = position_qty - held_for_open_sells
        if available_qty < 0:
            available_qty = Decimal("0")
        if request.qty <= available_qty:
            return None

        return {
            "source": "broker_precheck",
            "code": "precheck_sell_qty_exceeds_available",
            "reject_reason": "sell qty exceeds available inventory after open sell reservations",
            "symbol": request_symbol,
            "qty": str(request.qty),
            "position_qty": str(position_qty),
            "held_for_open_sells": str(held_for_open_sells),
            "available_qty": str(available_qty),
            "existing_order_id": existing_order_ids[0] if existing_order_ids else None,
            "existing_order_ids": existing_order_ids,
        }

    @classmethod
    def _resolve_sell_inventory_conflict(
        cls,
        request: ExecutionRequest,
        *,
        conflict: Mapping[str, Any],
        fractional_equities_enabled: bool,
    ) -> tuple[ExecutionRequest, dict[str, Any] | None, dict[str, Any] | None]:
        available_qty = _optional_decimal(conflict.get("available_qty"))
        if available_qty is None or available_qty <= 0:
            return request, None, dict(conflict)
        if request.qty <= available_qty:
            return request, None, None
        adjusted_qty = quantize_qty_for_symbol(
            request.symbol,
            available_qty,
            fractional_equities_enabled=fractional_equities_enabled,
        )
        min_qty = min_qty_for_symbol(
            request.symbol, fractional_equities_enabled=fractional_equities_enabled
        )
        if adjusted_qty <= 0 or adjusted_qty < min_qty or adjusted_qty >= request.qty:
            return request, None, dict(conflict)
        adjusted_request = request.model_copy(update={"qty": adjusted_qty})
        adjustment = {
            "source": "broker_precheck",
            "code": "sell_qty_clipped_to_available_inventory",
            "symbol": request.symbol,
            "requested_qty": str(request.qty),
            "adjusted_qty": str(adjusted_qty),
            "available_qty": str(available_qty),
            "held_for_open_sells": conflict.get("held_for_open_sells"),
            "position_qty": conflict.get("position_qty"),
            "existing_order_id": conflict.get("existing_order_id"),
            "existing_order_ids": conflict.get("existing_order_ids"),
        }
        return adjusted_request, adjustment, None

    def _retry_sell_inventory_conflict_after_cancel(
        self,
        *,
        execution_client: Any,
        request: ExecutionRequest,
        conflict: Mapping[str, Any],
        fractional_equities_enabled: bool,
    ) -> tuple[
        ExecutionRequest,
        dict[str, Any] | None,
        dict[str, Any] | None,
        dict[str, Any] | None,
    ]:
        existing_order_ids = self._sell_inventory_conflict_order_ids(conflict)
        if not existing_order_ids:
            return request, None, dict(conflict), None

        canceled_order_ids: list[str] = []
        for order_id in existing_order_ids:
            try:
                cancel_order = getattr(execution_client, "cancel_order", None)
                if not callable(cancel_order):
                    break
                if cancel_order(order_id):
                    canceled_order_ids.append(order_id)
            except Exception as exc:
                logger.warning(
                    "Failed to cancel sell inventory conflict order symbol=%s order_id=%s error=%s",
                    request.symbol,
                    order_id,
                    exc,
                )
        if not canceled_order_ids:
            return request, None, dict(conflict), None

        refreshed_conflict = self._find_sell_inventory_conflict(
            execution_client,
            request,
            self._list_open_orders(execution_client),
        )
        recovery: dict[str, Any] = {
            "source": "broker_precheck",
            "code": "sell_inventory_conflict_retried_after_cancel",
            "symbol": request.symbol,
            "requested_qty": str(request.qty),
            "canceled_existing_order_ids": canceled_order_ids,
        }
        if refreshed_conflict is None:
            recovery["status"] = "cleared"
            return request, None, None, recovery

        adjusted_request, adjustment, unresolved_conflict = (
            self._resolve_sell_inventory_conflict(
                request,
                conflict=refreshed_conflict,
                fractional_equities_enabled=fractional_equities_enabled,
            )
        )
        recovery["status"] = "adjusted" if unresolved_conflict is None else "blocked"
        recovery["remaining_conflict"] = dict(refreshed_conflict)
        return adjusted_request, adjustment, unresolved_conflict, recovery

    @staticmethod
    def _sell_inventory_conflict_order_ids(conflict: Mapping[str, Any]) -> list[str]:
        order_ids: list[str] = []
        existing_order_ids = conflict.get("existing_order_ids")
        if isinstance(existing_order_ids, Sequence) and not isinstance(
            existing_order_ids, (str, bytes)
        ):
            existing_order_sequence = cast(Sequence[Any], existing_order_ids)
            order_ids.extend(
                str(order_id) for order_id in existing_order_sequence if order_id
            )
        existing_order_id = conflict.get("existing_order_id")
        if existing_order_id and str(existing_order_id) not in order_ids:
            order_ids.append(str(existing_order_id))
        return order_ids

    @classmethod
    def _remaining_order_qty(cls, order: Mapping[str, Any]) -> Decimal:
        qty = _optional_decimal(order.get("qty") or order.get("quantity"))
        filled_qty = _optional_decimal(
            order.get("filled_qty") or order.get("filled_quantity")
        ) or Decimal("0")
        if qty is None:
            return Decimal("0")
        remaining = qty - filled_qty
        if remaining < 0:
            return Decimal("0")
        return remaining

    def _fractional_equities_enabled_for_request(
        self,
        execution_client: Any,
        request: ExecutionRequest,
    ) -> bool:
        position_qty = self._position_qty_for_symbol(
            execution_client,
            request.symbol.strip().upper(),
        )
        return fractional_equities_enabled_for_trade(
            action=request.side,
            global_enabled=settings.trading_fractional_equities_enabled,
            allow_shorts=settings.trading_allow_shorts,
            position_qty=position_qty,
            requested_qty=request.qty,
        )

    def _validate_short_sell_constraints(
        self,
        execution_client: Any,
        request: ExecutionRequest,
    ) -> dict[str, Any] | None:
        if request.side.strip().lower() != "sell":
            return None
        symbol = request.symbol.strip().upper()
        if not symbol:
            return None

        position_qty = self._position_qty_for_symbol(execution_client, symbol)
        if not self._is_short_increasing_sell(position_qty, request.qty):
            return None

        if not settings.trading_allow_shorts:
            return {
                "source": "local_pre_submit",
                "code": "local_shorts_not_allowed",
                "reject_reason": "short selling disabled by runtime policy",
                "symbol": symbol,
                "qty": str(request.qty),
            }

        strict_short_precheck = settings.trading_mode == "live"
        account = self._get_account(execution_client)
        if account is None:
            if strict_short_precheck:
                return {
                    "source": "local_pre_submit",
                    "code": "shorting_metadata_unavailable",
                    "reject_reason": "account shorting eligibility metadata unavailable in live mode",
                    "symbol": symbol,
                    "qty": str(request.qty),
                }
        else:
            shorting_enabled = account.get("shorting_enabled")
            if isinstance(shorting_enabled, bool):
                if not shorting_enabled:
                    return {
                        "source": "local_pre_submit",
                        "code": "local_account_shorting_disabled",
                        "reject_reason": "account shorting is disabled",
                        "symbol": symbol,
                        "qty": str(request.qty),
                    }
            elif strict_short_precheck:
                return {
                    "source": "local_pre_submit",
                    "code": "shorting_metadata_unavailable",
                    "reject_reason": "account shorting eligibility unknown in live mode",
                    "symbol": symbol,
                    "qty": str(request.qty),
                }

        asset = self._get_asset(execution_client, symbol)
        if asset is None:
            if strict_short_precheck:
                return {
                    "source": "local_pre_submit",
                    "code": "shorting_metadata_unavailable",
                    "reject_reason": "asset shortability metadata unavailable in live mode",
                    "symbol": symbol,
                    "qty": str(request.qty),
                }
            return None

        tradable = asset.get("tradable")
        if isinstance(tradable, bool):
            if not tradable:
                return {
                    "source": "local_pre_submit",
                    "code": "local_symbol_not_tradable",
                    "reject_reason": "symbol is not tradable",
                    "symbol": symbol,
                    "qty": str(request.qty),
                }
        elif strict_short_precheck:
            return {
                "source": "local_pre_submit",
                "code": "shorting_metadata_unavailable",
                "reject_reason": "symbol tradability unknown in live mode",
                "symbol": symbol,
                "qty": str(request.qty),
            }

        shortable = asset.get("shortable")
        if isinstance(shortable, bool):
            if not shortable:
                return {
                    "source": "local_pre_submit",
                    "code": "local_symbol_not_shortable",
                    "reject_reason": "symbol is not shortable",
                    "symbol": symbol,
                    "qty": str(request.qty),
                }
        elif strict_short_precheck:
            return {
                "source": "local_pre_submit",
                "code": "shorting_metadata_unavailable",
                "reject_reason": "symbol shortability unknown in live mode",
                "symbol": symbol,
                "qty": str(request.qty),
            }

        easy_to_borrow = asset.get("easy_to_borrow")
        if isinstance(easy_to_borrow, bool):
            if not easy_to_borrow:
                return {
                    "source": "local_pre_submit",
                    "code": "local_symbol_not_easy_to_borrow",
                    "reject_reason": "symbol is not easy-to-borrow",
                    "symbol": symbol,
                    "qty": str(request.qty),
                }
        elif strict_short_precheck:
            return {
                "source": "local_pre_submit",
                "code": "shorting_metadata_unavailable",
                "reject_reason": "easy-to-borrow status unknown in live mode",
                "symbol": symbol,
                "qty": str(request.qty),
            }

        return None

    @staticmethod
    def _is_short_increasing_sell(
        position_qty: Decimal | None,
        request_qty: Decimal,
    ) -> bool:
        if request_qty <= 0:
            return False
        if position_qty is None:
            # Position lookup can fail transiently; avoid false local rejects.
            return False
        if position_qty <= 0:
            return True
        return request_qty > position_qty

    @classmethod
    def _position_qty_for_symbol(
        cls,
        execution_client: Any,
        symbol: str,
    ) -> Decimal | None:
        positions = cls._list_positions(execution_client)
        if positions is None:
            return None
        total_qty = Decimal("0")
        for position in positions:
            position_symbol = str(position.get("symbol") or "").strip().upper()
            if position_symbol != symbol:
                continue
            qty = _optional_decimal(position.get("qty") or position.get("quantity"))
            if qty is None:
                continue
            side = str(position.get("side") or "").strip().lower()
            if side == "short":
                qty = -abs(qty)
            total_qty += qty
        return total_qty

    @staticmethod
    def _list_open_orders(execution_client: Any) -> list[dict[str, Any]]:
        lister = getattr(execution_client, "list_orders", None)
        if not callable(lister):
            return []
        orders: Any
        try:
            orders = lister(status="open")
        except TypeError:
            try:
                orders = lister()
            except Exception as exc:
                logger.warning(
                    "Failed to list open orders for broker precheck: %s", exc
                )
                return []
        except Exception as exc:
            logger.warning("Failed to list open orders for broker precheck: %s", exc)
            return []

        if not isinstance(orders, list):
            return []
        raw_orders = cast(list[object], orders)
        normalized: list[dict[str, Any]] = []
        for order in raw_orders:
            if not isinstance(order, Mapping):
                continue
            mapped = cast(Mapping[object, Any], order)
            normalized.append({str(key): value for key, value in mapped.items()})
        return normalized

    @staticmethod
    def _list_positions(execution_client: Any) -> list[dict[str, Any]] | None:
        lister = getattr(execution_client, "list_positions", None)
        if not callable(lister):
            return None
        positions: Any
        try:
            positions = lister()
        except Exception as exc:
            logger.warning("Failed to list positions for broker precheck: %s", exc)
            return None
        if positions is None:
            return None
        if not isinstance(positions, list):
            return []
        raw_positions = cast(list[object], positions)
        normalized: list[dict[str, Any]] = []
        for position in raw_positions:
            if not isinstance(position, Mapping):
                continue
            mapped = cast(Mapping[object, Any], position)
            normalized.append({str(key): value for key, value in mapped.items()})
        return normalized

    def _get_account(
        self, execution_client: Any, *, force_refresh: bool = False
    ) -> dict[str, Any] | None:
        now = time.monotonic()
        if (
            not force_refresh
            and self._account_metadata_cached_at_monotonic is not None
            and now - self._account_metadata_cached_at_monotonic
            < _SHORTING_METADATA_CACHE_TTL_SECONDS
        ):
            return self._account_metadata_cache
        getter = getattr(execution_client, "get_account", None)
        if not callable(getter):
            self._account_metadata_cache = None
            self._account_metadata_cached_at_monotonic = now
            self._shorting_metadata_status.update(
                {
                    "account_ready": False,
                    "last_refresh_at": datetime.now(timezone.utc).isoformat(),
                    "last_error": "get_account_unavailable",
                }
            )
            return None
        try:
            account = getter()
        except Exception as exc:
            logger.warning("Failed to fetch account for short precheck: %s", exc)
            self._account_metadata_cache = None
            self._account_metadata_cached_at_monotonic = now
            self._shorting_metadata_status.update(
                {
                    "account_ready": False,
                    "last_refresh_at": datetime.now(timezone.utc).isoformat(),
                    "last_error": str(exc),
                }
            )
            return None
        if not isinstance(account, Mapping):
            self._account_metadata_cache = None
            self._account_metadata_cached_at_monotonic = now
            self._shorting_metadata_status.update(
                {
                    "account_ready": False,
                    "last_refresh_at": datetime.now(timezone.utc).isoformat(),
                    "last_error": "account_metadata_not_mapping",
                }
            )
            return None
        payload = cast(Mapping[object, Any], account)
        normalized = {str(key): value for key, value in payload.items()}
        self._account_metadata_cache = normalized
        self._account_metadata_cached_at_monotonic = now
        self._shorting_metadata_status.update(
            {
                "account_ready": isinstance(normalized.get("shorting_enabled"), bool),
                "last_refresh_at": datetime.now(timezone.utc).isoformat(),
                "last_error": None,
            }
        )
        return normalized

    def _get_asset(
        self,
        execution_client: Any,
        symbol: str,
        *,
        force_refresh: bool = False,
    ) -> dict[str, Any] | None:
        now = time.monotonic()
        cached = self._asset_metadata_cache.get(symbol)
        if (
            not force_refresh
            and cached is not None
            and now - cached[1] < _SHORTING_METADATA_CACHE_TTL_SECONDS
        ):
            return cached[0]
        getter = getattr(execution_client, "get_asset", None)
        if not callable(getter):
            self._asset_metadata_cache[symbol] = (None, now)
            return None
        try:
            asset = getter(symbol)
        except Exception as exc:
            logger.warning(
                "Failed to fetch asset metadata for short precheck symbol=%s: %s",
                symbol,
                exc,
            )
            self._asset_metadata_cache[symbol] = (None, now)
            return None
        if not isinstance(asset, Mapping):
            self._asset_metadata_cache[symbol] = (None, now)
            return None
        payload = cast(Mapping[object, Any], asset)
        normalized = {str(key): value for key, value in payload.items()}
        self._asset_metadata_cache[symbol] = (normalized, now)
        return normalized


def _coerce_json(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        raw = cast(Mapping[str, Any], value)
        return {str(key): val for key, val in raw.items()}
    return {}


def _coerce_string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in cast(list[Any], value):
        if isinstance(item, (str, int, float, bool)):
            result.append(str(item))
    return result


def _merge_unique_strings(existing: list[str], updates: list[str]) -> list[str]:
    merged = list(existing)
    for update in updates:
        if update not in merged:
            merged.append(update)
    return merged


class _NormalizedRejectReason(NamedTuple):
    atomic_reason: str
    reject_class: str
    reject_origin: str


def _normalize_reject_reason(reason: str) -> _NormalizedRejectReason:
    normalized = reason.strip()
    if normalized in {"llm_policy_veto", "llm_veto"}:
        return _NormalizedRejectReason("llm_policy_veto", "policy", "llm_review")
    if normalized.startswith("llm_runtime_fallback"):
        return _NormalizedRejectReason("llm_runtime_fallback", "runtime", "llm_runtime")
    if normalized == "llm_error" or normalized.startswith("llm_error"):
        return _NormalizedRejectReason("llm_error", "runtime", "llm_review")
    if normalized == "market_context_block" or normalized.startswith("market_context_"):
        return _NormalizedRejectReason("market_context_block", "market_context", "market_context")
    if normalized == "symbol_capacity_exhausted":
        return _NormalizedRejectReason("symbol_capacity_exhausted", "capacity", "portfolio_sizing")
    if normalized == "qty_below_min":
        return _NormalizedRejectReason("qty_below_min", "capacity", "portfolio_sizing")
    if normalized == "max_position_pct_exceeded":
        return _NormalizedRejectReason("max_position_pct_exceeded", "policy", "risk_engine")
    if normalized.startswith("runtime_uncertainty_gate_"):
        return _NormalizedRejectReason(normalized, "policy", "runtime_uncertainty_gate")
    if "code=precheck_sell_qty_exceeds_available" in normalized:
        return _NormalizedRejectReason("sell_inventory_unavailable", "broker_precheck", "broker_precheck")
    if "code=shorting_metadata_unavailable" in normalized or "code=local_account_metadata_unavailable" in normalized:
        return _NormalizedRejectReason("shorting_metadata_unavailable", "broker_precheck", "local_pre_submit")
    if normalized.startswith("local_pre_submit_rejected"):
        return _NormalizedRejectReason("broker_precheck_rejected", "broker_precheck", "local_pre_submit")
    if normalized.startswith("broker_precheck_rejected"):
        return _NormalizedRejectReason("broker_precheck_rejected", "broker_precheck", "broker_precheck")
    if normalized.startswith("llm_"):
        return _NormalizedRejectReason(normalized, "policy", "llm_review")
    return _NormalizedRejectReason(normalized, "runtime", "scheduler")


def _normalize_reject_reasons(reason: str) -> list[_NormalizedRejectReason]:
    return [_normalize_reject_reason(part.strip()) for part in reason.split(";") if part.strip()]


def _extract_sizing_debug(decision_json: Mapping[str, Any]) -> dict[str, Any]:
    params = decision_json.get("params")
    if not isinstance(params, Mapping):
        return {}
    params_mapping = cast(Mapping[str, Any], params)
    portfolio_sizing = params_mapping.get("portfolio_sizing")
    if not isinstance(portfolio_sizing, Mapping):
        return {}
    portfolio_sizing_mapping = cast(Mapping[str, Any], portfolio_sizing)
    output = portfolio_sizing_mapping.get("output")
    if not isinstance(output, Mapping):
        return {}
    output_mapping = cast(Mapping[str, Any], output)
    return {
        "requested_qty": decision_json.get("qty"),
        "final_qty": output_mapping.get("final_qty"),
        "min_executable_qty": output_mapping.get("min_executable_qty"),
        "remaining_room_notional": output_mapping.get("remaining_room_notional"),
        "fractional_allowed": output_mapping.get("fractional_allowed"),
        "limiting_constraint": output_mapping.get("limiting_constraint"),
    }


def _decision_state_payload(decision: StrategyDecision) -> dict[str, Any]:
    return {
        "action": decision.action,
        "qty": str(decision.qty),
        "order_type": decision.order_type,
        "time_in_force": decision.time_in_force,
        "limit_price": str(decision.limit_price) if decision.limit_price is not None else None,
        "stop_price": str(decision.stop_price) if decision.stop_price is not None else None,
    }


def _validate_pre_submit_request(
    request: ExecutionRequest,
    *,
    fractional_equities_enabled: bool,
) -> dict[str, Any] | None:
    if request.qty <= 0:
        return {
            "source": "local_pre_submit",
            "code": "local_qty_non_positive",
            "reject_reason": "qty must be positive",
            "symbol": request.symbol,
            "qty": str(request.qty),
        }
    min_qty = min_qty_for_symbol(
        request.symbol, fractional_equities_enabled=fractional_equities_enabled
    )
    if request.qty < min_qty:
        return {
            "source": "local_pre_submit",
            "code": "local_qty_below_min",
            "reject_reason": f"qty below minimum increment {min_qty}",
            "symbol": request.symbol,
            "qty": str(request.qty),
            "min_qty": str(min_qty),
        }
    if not qty_has_valid_increment(
        request.symbol,
        request.qty,
        fractional_equities_enabled=fractional_equities_enabled,
    ):
        step = qty_step_for_symbol(
            request.symbol, fractional_equities_enabled=fractional_equities_enabled
        )
        quantized_qty = quantize_qty_for_symbol(
            request.symbol,
            request.qty,
            fractional_equities_enabled=fractional_equities_enabled,
        )
        return {
            "source": "local_pre_submit",
            "code": "local_qty_invalid_increment",
            "reject_reason": f"qty increment invalid; step={step}",
            "symbol": request.symbol,
            "qty": str(request.qty),
            "qty_step": str(step),
            "quantized_qty": str(quantized_qty),
        }
    return None


def _extract_execution_policy_context(
    decision: StrategyDecision,
    *,
    decision_row: Optional[TradeDecision] = None,
) -> dict[str, Any]:
    execution_policy: Any = None
    decision_json: Mapping[str, Any] = {}
    decision_params: Mapping[str, Any] | None = None
    if decision_row is not None:
        decision_json = _coerce_json(decision_row.decision_json)
        params_value = decision_json.get("params")
        if isinstance(params_value, Mapping):
            decision_params = cast(Mapping[str, Any], params_value)
            execution_policy = decision_params.get("execution_policy")
            execution_advisor = decision_params.get("execution_advisor")
            execution_microstructure = decision_params.get("execution_microstructure")
        else:
            execution_advisor = None
            execution_microstructure = None
    else:
        execution_advisor = None
        execution_microstructure = None
    if not isinstance(execution_policy, Mapping):
        execution_policy = decision.params.get("execution_policy")
        execution_advisor = decision.params.get("execution_advisor")
        execution_microstructure = decision.params.get("execution_microstructure")
    if not isinstance(decision_params, Mapping):
        decision_params = decision.params
    policy_map: dict[str, Any] = {}
    if isinstance(execution_policy, Mapping):
        policy_map = {
            str(key): value
            for key, value in cast(Mapping[object, Any], execution_policy).items()
        }
    adaptive = policy_map.get("adaptive")
    adaptive_payload: dict[str, Any] = {}
    if isinstance(adaptive, Mapping):
        adaptive_payload = {
            str(key): value for key, value in cast(Mapping[str, Any], adaptive).items()
        }
    has_explicit_advisor = isinstance(execution_advisor, Mapping) or isinstance(
        decision_params.get("execution_advisor"), Mapping
    )
    has_explicit_microstructure = isinstance(
        execution_microstructure, Mapping
    ) or isinstance(decision_params.get("execution_microstructure"), Mapping)
    if (
        not policy_map
        and not adaptive_payload
        and not has_explicit_advisor
        and not has_explicit_microstructure
    ):
        return {}
    context: dict[str, Any] = {
        'selected_order_type': str(
            policy_map.get('selected_order_type') or decision.order_type
        ),
        'adaptive': adaptive_payload,
    }
    if isinstance(execution_advisor, Mapping):
        context["execution_advisor"] = {
            str(key): value for key, value in cast(Mapping[str, Any], execution_advisor).items()
        }
    elif isinstance(decision_params.get("execution_advisor"), Mapping):
        context["execution_advisor"] = {
            str(key): value for key, value in cast(Mapping[str, Any], decision_params.get("execution_advisor")).items()
        }

    if isinstance(execution_microstructure, Mapping):
        context["execution_microstructure"] = {
            str(key): value
            for key, value in cast(Mapping[str, Any], execution_microstructure).items()
        }
    elif isinstance(decision_params.get("execution_microstructure"), Mapping):
        context["execution_microstructure"] = {
            str(key): value
            for key, value in cast(
                Mapping[str, Any], decision_params.get("execution_microstructure")
            ).items()
        }
    return context


def _resolve_submission_simulation_context(
    *,
    execution_client: Any,
    decision: StrategyDecision,
    decision_row: TradeDecision,
) -> dict[str, Any] | None:
    adapter_name = str(getattr(execution_client, "name", "") or "").strip().lower()
    if adapter_name != "simulation" and not settings.trading_simulation_enabled:
        return None
    source_context = decision.params.get("simulation_context")
    source_context_payload: dict[str, Any] | None = None
    if isinstance(source_context, Mapping):
        source_context_payload = {
            str(key): value
            for key, value in cast(Mapping[object, Any], source_context).items()
        }
    return resolve_simulation_context(
        source=source_context_payload,
        decision_id=str(decision_row.id),
        decision_hash=decision_row.decision_hash,
    )


def _attach_execution_policy_context(execution: Execution, context: dict[str, Any]) -> None:
    if not context:
        return
    raw_order = _coerce_json(execution.raw_order)
    raw_order['execution_policy'] = context
    execution.raw_order = raw_order


def _extract_execution_advice_provenance(
    decision: StrategyDecision,
    *,
    decision_row: Optional[TradeDecision] = None,
) -> dict[str, Any] | None:
    persisted_params: Mapping[str, Any] = {}
    if decision_row is not None:
        decision_json = _coerce_json(decision_row.decision_json)
        params_value = decision_json.get("params")
        if isinstance(params_value, Mapping):
            persisted_params = cast(Mapping[str, Any], params_value)

    for key in ("execution_advisor", "execution_advice"):
        payload = persisted_params.get(key)
        if not isinstance(payload, Mapping):
            payload = decision.params.get(key)
        if isinstance(payload, Mapping):
            return {
                str(item_key): item_value
                for item_key, item_value in cast(
                    Mapping[object, object], payload
                ).items()
            }
    return None


def _apply_execution_status(
    decision_row: TradeDecision,
    execution: Execution,
    account_label: str,
    submitted_at: Optional[datetime] = None,
    status_override: Optional[str] = None,
) -> None:
    decision_row.status = status_override or execution.status or "submitted"
    decision_row.alpaca_account_label = account_label
    if submitted_at is not None and decision_row.executed_at is None:
        decision_row.executed_at = submitted_at
    if execution.status == "filled" and decision_row.executed_at is None:
        simulation_payload = getattr(execution, "simulation_json", None)
        simulation_context = (
            cast(Mapping[str, Any], simulation_payload)
            if isinstance(simulation_payload, Mapping)
            else None
        )
        signal_event_ts = simulation_context.get("signal_event_ts") if simulation_context is not None else None
        if isinstance(signal_event_ts, str) and signal_event_ts.strip():
            normalized = (
                f'{signal_event_ts[:-1]}+00:00'
                if signal_event_ts.endswith("Z")
                else signal_event_ts
            )
            try:
                parsed = datetime.fromisoformat(normalized)
            except ValueError:
                parsed = None
            if parsed is not None:
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                decision_row.executed_at = parsed.astimezone(timezone.utc)
                return
        decision_row.executed_at = trading_now(account_label=account_label)


def _persist_lean_shadow_event(
    session: Session,
    *,
    execution: Execution,
    order_payload: Mapping[str, Any],
    decision: StrategyDecision,
) -> None:
    raw_shadow = order_payload.get('_lean_shadow')
    if not isinstance(raw_shadow, Mapping):
        return
    shadow = cast(Mapping[str, Any], raw_shadow)

    parity_status = str(shadow.get('parity_status') or 'unknown').strip() or 'unknown'
    event = LeanExecutionShadowEvent(
        correlation_id=str(order_payload.get('_execution_correlation_id') or '').strip() or None,
        trade_decision_id=execution.trade_decision_id,
        execution_id=execution.id,
        symbol=decision.symbol,
        side=decision.action,
        qty=decision.qty,
        intent_notional=_optional_decimal(shadow.get('intent_notional')),
        simulated_fill_price=_optional_decimal(shadow.get('simulated_fill_price')),
        simulated_slippage_bps=_optional_decimal(shadow.get('simulated_slippage_bps')),
        parity_delta_bps=_optional_decimal(shadow.get('parity_delta_bps')),
        parity_status=parity_status,
        failure_taxonomy=(
            str(shadow.get('failure_taxonomy') or '').strip() or None
        ),
        simulation_json=coerce_json_payload(dict(shadow)),
    )
    session.add(event)


def _optional_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except Exception:
        return None


__all__ = ["OrderExecutor"]
