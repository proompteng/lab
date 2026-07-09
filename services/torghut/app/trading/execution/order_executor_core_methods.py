"""Order execution and idempotency helpers."""

from __future__ import annotations

import json
import time
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import TYPE_CHECKING, Any, Optional, cast

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...models import (
    Execution,
    Strategy,
    TradeDecision,
    coerce_json_payload,
)
from ...config import settings
from ...snapshots import sync_order_to_db
from ..route_metadata import resolve_order_route_metadata
from ..execution_policy import should_retry_order_error
from ..execution_adapters import OrderSubmission
from ..firewall import OrderFirewall
from ..models import ExecutionRequest, StrategyDecision, decision_hash
from ..quantity_rules import (
    min_qty_for_symbol,
    quantize_qty_for_symbol,
)
from ..simulation import (
    resolve_event_persisted_at,
)
from ..tca import upsert_execution_tca_metric


from .shared_context import (
    OrderExecutorContract as _OrderExecutorContract,
    SHORTING_METADATA_CACHE_TTL_SECONDS as _SHORTING_METADATA_CACHE_TTL_SECONDS,
    target_plan_source_decision_needs_refresh as _target_plan_source_decision_needs_refresh,
    logger,
)

from .order_executor_core_support import (
    PreparedOrderSubmission as _PreparedOrderSubmission,
    ResolvedSellInventory as _ResolvedSellInventory,
    SellInventoryReservations as _SellInventoryReservations,
    apply_execution_status as _apply_execution_status,
    attach_execution_policy_context as _attach_execution_policy_context,
    coerce_json as _coerce_json,
    coerce_string_list as _coerce_string_list,
    decision_state_payload as _decision_state_payload,
    extract_execution_policy_context as _extract_execution_policy_context,
    extract_sizing_debug as _extract_sizing_debug,
    execution_request_from_decision as _execution_request_from_decision,
    merge_decision_metadata as _merge_decision_metadata,
    merge_unique_strings as _merge_unique_strings,
    normalize_reject_reasons as _normalize_reject_reasons,
    normalize_submission_block_reasons as _normalize_submission_block_reasons,
    open_sell_order_reserves_symbol as _open_sell_order_reserves_symbol,
    optional_decimal as _optional_decimal,
    order_payload_with_execution_metadata as _order_payload_with_execution_metadata,
    persist_lean_shadow_event as _persist_lean_shadow_event,
    sell_inventory_conflict_payload as _sell_inventory_conflict_payload,
    sell_inventory_metadata_update as _sell_inventory_metadata_update,
    sell_inventory_request_symbol as _sell_inventory_request_symbol,
    submission_extra_params as _submission_extra_params,
    unknown_position_sell_inventory_conflict as _unknown_position_sell_inventory_conflict,
    validate_pre_submit_request as _validate_pre_submit_request,
)


_BROKER_DURABLE_POSITION_ADAPTERS = frozenset(
    {"alpaca", "alpaca_fallback", "alpaca_paper"}
)


if TYPE_CHECKING:
    _OrderExecutorCoreBase = _OrderExecutorContract
else:
    _OrderExecutorCoreBase = object


@dataclass(frozen=True, slots=True)
class _OrderPreparationInputs:
    session: Session
    execution_client: Any
    decision: StrategyDecision
    decision_row: TradeDecision
    account_label: str
    execution_policy_context: dict[str, Any]


class _OrderExecutorCoreMethods(_OrderExecutorCoreBase):
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
            decision_payload = coerce_json_payload(decision.model_dump(mode="json"))
            if _target_plan_source_decision_needs_refresh(
                existing.decision_json,
                decision_payload,
            ):
                existing.decision_json = decision_payload
                existing.rationale = decision.rationale
                existing.strategy_id = strategy.id
                existing.symbol = decision.symbol
                existing.timeframe = decision.timeframe
                session.add(existing)
                session.commit()
                session.refresh(existing)
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
            created_at=resolve_event_persisted_at(
                event_ts=decision.event_ts,
                account_label=account_label,
            ),
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

        prepared = self._prepare_order_submission(
            _OrderPreparationInputs(
                session=session,
                execution_client=execution_client,
                decision=decision,
                decision_row=decision_row,
                account_label=account_label,
                execution_policy_context=execution_policy_context,
            )
        )
        if retry_delays is None:
            retry_delays = []
        self._raise_if_conflicting_open_order(execution_client, prepared.request)
        resolved_inventory = self._resolve_sell_inventory_before_submission(
            session=session,
            execution_client=execution_client,
            decision=decision,
            decision_row=decision_row,
            request=prepared.request,
            fractional_equities_enabled=bool(
                prepared.quantity_resolution.fractional_allowed
            ),
        )
        order_response = self._submit_order_with_retry(
            execution_client=execution_client,
            request=resolved_inventory.request,
            retry_delays=retry_delays,
            decision_id=str(decision_row.id),
            extra_params=prepared.extra_params,
        )
        return self._sync_submitted_order_execution(
            session=session,
            execution_client=execution_client,
            decision=resolved_inventory.decision,
            decision_row=decision_row,
            account_label=account_label,
            execution_expected_adapter=execution_expected_adapter,
            execution_policy_context=execution_policy_context,
            order_response=order_response,
        )

    def _prepare_order_submission(
        self,
        inputs: _OrderPreparationInputs,
    ) -> _PreparedOrderSubmission:
        request = _execution_request_from_decision(inputs.decision, inputs.decision_row)
        durable_position_qty = self._durable_position_qty_for_symbol(
            session=inputs.session,
            symbol=request.symbol,
            account_label=inputs.account_label,
        )
        quantity_resolution = self._quantity_resolution_for_request(
            inputs.execution_client,
            request,
            durable_position_qty=durable_position_qty,
        )
        if quantity_resolution.position_qty is not None:
            request.extra_params["_prechecked_position_qty"] = str(
                quantity_resolution.position_qty
            )
        self._raise_order_submission_precheck_errors(
            execution_client=inputs.execution_client,
            request=request,
            quantity_resolution=quantity_resolution,
        )
        return _PreparedOrderSubmission(
            request=request,
            quantity_resolution=quantity_resolution,
            extra_params=_submission_extra_params(
                execution_client=inputs.execution_client,
                decision=inputs.decision,
                decision_row=inputs.decision_row,
                execution_policy_context=inputs.execution_policy_context,
                request=request,
            ),
        )

    def _raise_order_submission_precheck_errors(
        self,
        *,
        execution_client: Any,
        request: ExecutionRequest,
        quantity_resolution: Any,
    ) -> None:
        pre_submit_error = _validate_pre_submit_request(
            request,
            quantity_resolution=quantity_resolution,
        )
        if pre_submit_error is not None:
            raise RuntimeError(json.dumps(pre_submit_error))
        short_precheck_error = self._validate_short_sell_constraints(
            execution_client,
            request,
            quantity_resolution=quantity_resolution,
        )
        if short_precheck_error is not None:
            raise RuntimeError(json.dumps(short_precheck_error))

    @staticmethod
    def _durable_position_qty_for_symbol(
        *,
        session: Session,
        symbol: str,
        account_label: str,
    ) -> Decimal | None:
        normalized_symbol = symbol.strip().upper()
        if not normalized_symbol:
            return None
        stmt = select(
            Execution.side,
            Execution.filled_qty,
            Execution.execution_actual_adapter,
        ).where(
            Execution.alpaca_account_label == account_label,
            Execution.symbol == normalized_symbol,
        )
        total = Decimal("0")
        observed = False
        for side, filled_qty, actual_adapter in session.execute(stmt):
            if (
                str(actual_adapter or "").strip().lower()
                not in _BROKER_DURABLE_POSITION_ADAPTERS
            ):
                continue
            qty = _optional_decimal(filled_qty) or Decimal("0")
            if qty <= 0:
                continue
            normalized_side = str(side or "").strip().lower()
            if normalized_side == "buy":
                total += qty
                observed = True
            elif normalized_side == "sell":
                total -= qty
                observed = True
        return total if observed else None

    def _resolve_sell_inventory_before_submission(
        self,
        *,
        session: Session,
        execution_client: Any,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        request: ExecutionRequest,
        fractional_equities_enabled: bool,
    ) -> _ResolvedSellInventory:
        conflict = self._find_sell_inventory_conflict(
            execution_client,
            request,
            self._list_open_orders(execution_client),
        )
        if conflict is None:
            return _ResolvedSellInventory(request=request, decision=decision)
        return self._resolve_or_recover_sell_inventory_conflict(
            session=session,
            execution_client=execution_client,
            decision=decision,
            decision_row=decision_row,
            request=request,
            conflict=conflict,
            fractional_equities_enabled=fractional_equities_enabled,
        )

    def _resolve_or_recover_sell_inventory_conflict(
        self,
        *,
        session: Session,
        execution_client: Any,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        request: ExecutionRequest,
        conflict: Mapping[str, Any],
        fractional_equities_enabled: bool,
    ) -> _ResolvedSellInventory:
        request, adjustment, unresolved = self._resolve_sell_inventory_conflict(
            request,
            conflict=conflict,
            fractional_equities_enabled=fractional_equities_enabled,
        )
        recovery: dict[str, Any] | None = None
        if unresolved is not None:
            request, adjustment, unresolved, recovery = (
                self._retry_sell_inventory_conflict_after_cancel(
                    execution_client=execution_client,
                    request=request,
                    conflict=unresolved,
                    fractional_equities_enabled=fractional_equities_enabled,
                )
            )
        if unresolved is not None:
            if recovery is not None:
                self.update_decision_json(
                    session,
                    decision_row,
                    {"broker_precheck_recovery": recovery},
                )
            raise RuntimeError(json.dumps(unresolved))
        return self._sync_sell_inventory_adjustment(
            session=session,
            decision=decision,
            decision_row=decision_row,
            request=request,
            adjustment=adjustment,
            recovery=recovery,
        )

    def _sync_sell_inventory_adjustment(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        request: ExecutionRequest,
        adjustment: dict[str, Any] | None,
        recovery: dict[str, Any] | None,
    ) -> _ResolvedSellInventory:
        metadata_update = _sell_inventory_metadata_update(adjustment, recovery)
        if metadata_update or request.qty != decision.qty:
            decision = decision.model_copy(update={"qty": request.qty})
            self.sync_decision_state(
                session,
                decision_row,
                decision,
                metadata_update=metadata_update or None,
            )
        return _ResolvedSellInventory(request=request, decision=decision)

    def _sync_submitted_order_execution(
        self,
        *,
        session: Session,
        execution_client: Any,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        account_label: str,
        execution_expected_adapter: Optional[str],
        execution_policy_context: dict[str, Any],
        order_response: Any,
    ) -> Execution:
        order_payload = _order_payload_with_execution_metadata(
            order_response,
            decision=decision,
            decision_row=decision_row,
            execution_policy_context=execution_policy_context,
        )
        execution = self._sync_execution_payload(
            session=session,
            execution_client=execution_client,
            order_payload=order_payload,
            decision_row=decision_row,
            account_label=account_label,
            execution_expected_adapter=execution_expected_adapter,
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
            submitted_at=resolve_event_persisted_at(
                event_ts=decision.event_ts,
                account_label=account_label,
            ),
            status_override="submitted",
        )
        session.add(decision_row)
        session.commit()
        return execution

    def _sync_execution_payload(
        self,
        *,
        session: Session,
        execution_client: Any,
        order_payload: dict[str, Any],
        decision_row: TradeDecision,
        account_label: str,
        execution_expected_adapter: Optional[str],
    ) -> Execution:
        route_expected, route_actual, fallback_reason, fallback_count = (
            resolve_order_route_metadata(
                expected_adapter=execution_expected_adapter,
                execution_client=execution_client,
                order_response=order_payload,
            )
        )
        return sync_order_to_db(
            session,
            order_payload,
            trade_decision_id=str(decision_row.id),
            alpaca_account_label=account_label,
            execution_expected_adapter=route_expected,
            execution_actual_adapter=route_actual,
            execution_fallback_reason=fallback_reason,
            execution_fallback_count=fallback_count,
        )

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
        existing_payload = _order_payload_with_execution_metadata(
            existing_order,
            decision,
            decision_row=decision_row,
            execution_policy_context=execution_policy_context,
        )
        execution = self._sync_execution_payload(
            session=session,
            execution_client=execution_client,
            order_payload=existing_payload,
            decision_row=decision_row,
            account_label=account_label,
            execution_expected_adapter=execution_expected_adapter,
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
            existing_order_side = str(
                conflicting_order.get("side") or "unknown"
            ).lower()
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
                limit_price = (
                    float(request.limit_price)
                    if request.limit_price is not None
                    else None
                )
                stop_price = (
                    float(request.stop_price)
                    if request.stop_price is not None
                    else None
                )
                if isinstance(execution_client, OrderFirewall):
                    return execution_client.submit_order(
                        symbol=request.symbol,
                        side=request.side,
                        qty=float(request.qty),
                        order_type=request.order_type,
                        time_in_force=request.time_in_force,
                        limit_price=limit_price,
                        stop_price=stop_price,
                        extra_params=dict(extra_params),
                    )
                return execution_client.submit_order(
                    OrderSubmission(
                        symbol=request.symbol,
                        side=request.side,
                        qty=float(request.qty),
                        order_type=request.order_type,
                        time_in_force=request.time_in_force,
                        limit_price=limit_price,
                        stop_price=stop_price,
                        extra_params=dict(extra_params),
                    )
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
        decision_json["submission_stage"] = str(
            decision_json.get("submission_stage") or "rejected"
        )
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
        _merge_decision_metadata(decision_json, metadata_update)
        decision_row.decision_json = decision_json
        session.add(decision_row)
        session.commit()

    def mark_blocked(
        self,
        session: Session,
        decision_row: TradeDecision,
        reason: str,
        metadata_update: Mapping[str, Any] | None = None,
    ) -> None:
        decision_row.status = "blocked"
        decision_json = _coerce_json(decision_row.decision_json)
        decision_json["submission_block_reason"] = reason
        decision_json["submission_stage"] = str(
            decision_json.get("submission_stage") or "blocked"
        )
        block_atomic = _merge_unique_strings(
            _coerce_string_list(decision_json.get("submission_block_atomic")),
            _normalize_submission_block_reasons(reason),
        )
        if block_atomic:
            decision_json["submission_block_atomic"] = block_atomic
        _merge_decision_metadata(decision_json, metadata_update)
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
        request_symbol = _sell_inventory_request_symbol(request)
        if request_symbol is None:
            return None

        reservations = cls._sell_inventory_reservations(request_symbol, open_orders)
        if reservations.held_qty <= 0:
            return None

        resolved_position_qty = _optional_decimal(
            request.extra_params.get("_prechecked_position_qty")
        )
        if resolved_position_qty is None:
            resolved_position_qty = cls._position_qty_for_symbol(
                execution_client, request_symbol
            )
        if resolved_position_qty is None:
            return _unknown_position_sell_inventory_conflict(
                request,
                request_symbol=request_symbol,
                reservations=reservations,
            )
        if resolved_position_qty <= 0:
            return None

        available_qty = resolved_position_qty - reservations.held_qty
        if available_qty < 0:
            available_qty = Decimal("0")
        if request.qty <= available_qty:
            return None

        return _sell_inventory_conflict_payload(
            request,
            request_symbol=request_symbol,
            reservations=reservations,
            position_qty=resolved_position_qty,
            available_qty=available_qty,
        )

    @classmethod
    def _sell_inventory_reservations(
        cls,
        request_symbol: str,
        open_orders: list[dict[str, Any]],
    ) -> _SellInventoryReservations:
        held_qty = Decimal("0")
        existing_order_ids: list[str] = []
        for order in open_orders:
            if not _open_sell_order_reserves_symbol(order, request_symbol):
                continue
            remaining_qty = cls._remaining_order_qty(order)
            if remaining_qty <= 0:
                continue
            held_qty += remaining_qty
            existing_order_id = (
                order.get("id") or order.get("order_id") or order.get("client_order_id")
            )
            if existing_order_id is not None:
                existing_order_ids.append(str(existing_order_id))
        return _SellInventoryReservations(
            held_qty=held_qty,
            existing_order_ids=existing_order_ids,
        )

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


# Public aliases used by split-module consumers.
OrderExecutorCoreMethods = _OrderExecutorCoreMethods

__all__ = ("OrderExecutorCoreMethods",)
