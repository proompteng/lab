"""Order execution and idempotency helpers."""

from __future__ import annotations

import hashlib
import json
import time
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal
from typing import TYPE_CHECKING, Any, NamedTuple, cast


from ...models import (
    coerce_json_payload,
)
from ..broker_risk_snapshot import (
    normalize_live_open_order_rows,
    normalize_live_position_rows,
)
from ...config import settings
from ..models import ExecutionRequest, StrategyDecision
from ..quantity_rules import (
    QuantityResolution,
    resolve_quantity_resolution,
)


from .shared_context import (
    OrderExecutorContract as _OrderExecutorContract,
    OrderExecutorFields as _OrderExecutorFields,
    SHORTING_METADATA_CACHE_TTL_SECONDS as _SHORTING_METADATA_CACHE_TTL_SECONDS,
    logger,
)
from .order_executor_core_methods import (
    OrderExecutorCoreMethods as _OrderExecutorCoreMethods,
)


def _optional_decimal(value: Any) -> Decimal | None:
    from .validate_pre_submit_request import (
        optional_decimal,
    )

    return optional_decimal(value)


if TYPE_CHECKING:
    _OrderExecutorSubmissionBase = _OrderExecutorContract
else:
    _OrderExecutorSubmissionBase = object


class _OrderExecutorSubmissionMethods(_OrderExecutorSubmissionBase):
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
            position_qty=_optional_decimal(conflict.get("position_qty")),
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

    def _quantity_resolution_for_request(
        self,
        execution_client: Any,
        request: ExecutionRequest,
        *,
        durable_position_qty: Decimal | None = None,
    ) -> QuantityResolution:
        position_qty = self._position_qty_for_symbol(
            execution_client,
            request.symbol.strip().upper(),
        )
        position_qty = self._submission_position_qty(
            request=request,
            broker_position_qty=position_qty,
            durable_position_qty=durable_position_qty,
        )
        return resolve_quantity_resolution(
            request.symbol,
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
        *,
        quantity_resolution: QuantityResolution,
    ) -> dict[str, Any] | None:
        if request.side.strip().lower() != "sell":
            return None
        symbol = request.symbol.strip().upper()
        if not symbol:
            return None

        position_qty = quantity_resolution.position_qty
        if not (
            quantity_resolution.short_increasing
            or self._is_short_increasing_sell(position_qty, request.qty)
        ):
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

    @staticmethod
    def _submission_position_qty(
        *,
        request: ExecutionRequest,
        broker_position_qty: Decimal | None,
        durable_position_qty: Decimal | None,
    ) -> Decimal | None:
        if request.side.strip().lower() != "sell":
            return broker_position_qty
        if durable_position_qty is None or durable_position_qty <= 0:
            return broker_position_qty
        if broker_position_qty is None or broker_position_qty <= 0:
            return durable_position_qty
        return broker_position_qty

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
            if settings.trading_mode == "live":
                raise RuntimeError("live_broker_open_order_read_unavailable")
            return []
        orders: Any
        try:
            orders = lister(status="open")
        except TypeError:
            try:
                orders = lister()
            except Exception as exc:
                if settings.trading_mode == "live":
                    raise RuntimeError("live_broker_open_order_read_failed") from exc
                logger.warning(
                    "Failed to list open orders for broker precheck: %s", exc
                )
                return []
        except Exception as exc:
            if settings.trading_mode == "live":
                raise RuntimeError("live_broker_open_order_read_failed") from exc
            logger.warning("Failed to list open orders for broker precheck: %s", exc)
            return []

        if not isinstance(orders, list):
            if settings.trading_mode == "live":
                raise RuntimeError("live_broker_open_order_read_invalid")
            return []
        raw_orders = cast(list[object], orders)
        normalized: list[dict[str, Any]] = []
        for order in raw_orders:
            if not isinstance(order, Mapping):
                if settings.trading_mode == "live":
                    raise RuntimeError("live_broker_open_order_read_invalid")
                continue
            mapped = cast(Mapping[object, Any], order)
            normalized.append({str(key): value for key, value in mapped.items()})
        if settings.trading_mode != "live":
            return normalized
        return cast(list[dict[str, Any]], normalize_live_open_order_rows(normalized))

    @staticmethod
    def _list_positions(execution_client: Any) -> list[dict[str, Any]] | None:
        lister = getattr(execution_client, "list_positions", None)
        if not callable(lister):
            return None
        positions: Any
        try:
            positions = lister()
        except Exception as exc:
            if settings.trading_mode == "live":
                raise RuntimeError("live_broker_position_read_failed") from exc
            logger.warning("Failed to list positions for broker precheck: %s", exc)
            return None
        if positions is None:
            if settings.trading_mode == "live":
                raise RuntimeError("live_broker_position_read_unavailable")
            return None
        if not isinstance(positions, list):
            if settings.trading_mode == "live":
                raise RuntimeError("live_broker_position_read_invalid")
            return []
        raw_positions = cast(list[object], positions)
        normalized: list[dict[str, Any]] = []
        for position in raw_positions:
            if not isinstance(position, Mapping):
                if settings.trading_mode == "live":
                    raise RuntimeError("live_broker_position_read_invalid")
                continue
            mapped = cast(Mapping[object, Any], position)
            normalized.append({str(key): value for key, value in mapped.items()})
        if settings.trading_mode != "live":
            return normalized
        return cast(list[dict[str, Any]], normalize_live_position_rows(normalized))

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


class OrderExecutor(
    _OrderExecutorFields,
    _OrderExecutorCoreMethods,
    _OrderExecutorSubmissionMethods,
):
    pass


def _coerce_json(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        raw = cast(Mapping[str, Any], value)
        return {str(key): val for key, val in raw.items()}
    return {}


def _copy_mapping(value: Mapping[str, Any]) -> dict[str, Any]:
    return {
        str(key): coerce_json_payload(item)
        for key, item in cast(Mapping[object, Any], value).items()
    }


def _json_default(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    return str(value)


def _stable_payload_hash(value: Mapping[str, Any] | None) -> str | None:
    if not isinstance(value, Mapping) or not value:
        return None
    encoded = json.dumps(
        _copy_mapping(value),
        sort_keys=True,
        separators=(",", ":"),
        default=_json_default,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _first_param_value(
    params_candidates: Sequence[Mapping[str, Any]],
    *keys: str,
) -> Any | None:
    for params in params_candidates:
        for key in keys:
            if key in params and params.get(key) is not None:
                return params.get(key)
    return None


def _first_param_text(
    params_candidates: Sequence[Mapping[str, Any]],
    *keys: str,
) -> str | None:
    for params in params_candidates:
        for key in keys:
            value = params.get(key)
            text = str(value or "").strip()
            if text:
                return text
    return None


def _first_param_mapping(
    params_candidates: Sequence[Mapping[str, Any]],
    *keys: str,
) -> dict[str, Any] | None:
    for params in params_candidates:
        for key in keys:
            value = params.get(key)
            if isinstance(value, Mapping):
                return _copy_mapping(cast(Mapping[str, Any], value))
    return None


def _first_mapping_value(payload: Mapping[str, Any], *keys: str) -> Any | None:
    for key in keys:
        if key in payload and payload.get(key) is not None:
            return payload.get(key)
    return None


def _first_mapping_text(payload: Mapping[str, Any], *keys: str) -> str | None:
    for key in keys:
        text = str(payload.get(key) or "").strip()
        if text:
            return text
    return None


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


def _merge_decision_metadata(
    decision_json: dict[str, Any],
    metadata_update: Mapping[str, Any] | None,
) -> None:
    if not metadata_update:
        return
    for key, value in metadata_update.items():
        if key == "control_plane_snapshot" and isinstance(value, Mapping):
            existing_snapshot = _coerce_json(
                decision_json.get("control_plane_snapshot")
            )
            for snapshot_key, snapshot_value in cast(
                Mapping[object, Any], value
            ).items():
                existing_snapshot[str(snapshot_key)] = coerce_json_payload(
                    snapshot_value
                )
            decision_json["control_plane_snapshot"] = coerce_json_payload(
                existing_snapshot
            )
            continue
        decision_json[str(key)] = coerce_json_payload(value)


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
        return _NormalizedRejectReason(
            "market_context_block", "market_context", "market_context"
        )
    if normalized == "symbol_capacity_exhausted":
        return _NormalizedRejectReason(
            "symbol_capacity_exhausted", "capacity", "portfolio_sizing"
        )
    if normalized == "qty_below_min":
        return _NormalizedRejectReason("qty_below_min", "capacity", "portfolio_sizing")
    if normalized == "max_position_pct_exceeded":
        return _NormalizedRejectReason(
            "max_position_pct_exceeded", "policy", "risk_engine"
        )
    if normalized.startswith("runtime_uncertainty_gate_"):
        return _NormalizedRejectReason(normalized, "policy", "runtime_uncertainty_gate")
    if "code=precheck_sell_qty_exceeds_available" in normalized:
        return _NormalizedRejectReason(
            "sell_inventory_unavailable", "broker_precheck", "broker_precheck"
        )
    if (
        "code=shorting_metadata_unavailable" in normalized
        or "code=local_account_metadata_unavailable" in normalized
    ):
        return _NormalizedRejectReason(
            "shorting_metadata_unavailable", "broker_precheck", "local_pre_submit"
        )
    if normalized.startswith("local_pre_submit_rejected"):
        return _NormalizedRejectReason(
            "broker_precheck_rejected", "broker_precheck", "local_pre_submit"
        )
    if normalized.startswith("broker_precheck_rejected"):
        return _NormalizedRejectReason(
            "broker_precheck_rejected", "broker_precheck", "broker_precheck"
        )
    if normalized.startswith("llm_"):
        return _NormalizedRejectReason(normalized, "policy", "llm_review")
    return _NormalizedRejectReason(normalized, "runtime", "scheduler")


def _normalize_reject_reasons(reason: str) -> list[_NormalizedRejectReason]:
    return [
        _normalize_reject_reason(part.strip())
        for part in reason.split(";")
        if part.strip()
    ]


def _normalize_submission_block_reasons(reason: str) -> list[str]:
    return [
        normalized
        for normalized in (
            part.strip().replace(" ", "_").lower() for part in reason.split(";")
        )
        if normalized
    ]


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
        "limit_price": str(decision.limit_price)
        if decision.limit_price is not None
        else None,
        "stop_price": str(decision.stop_price)
        if decision.stop_price is not None
        else None,
    }


# Public aliases used by split-module consumers.
coerce_json = _coerce_json
coerce_string_list = _coerce_string_list
decision_state_payload = _decision_state_payload
extract_sizing_debug = _extract_sizing_debug
merge_decision_metadata = _merge_decision_metadata
merge_unique_strings = _merge_unique_strings
normalize_reject_reasons = _normalize_reject_reasons
normalize_submission_block_reasons = _normalize_submission_block_reasons
NormalizedRejectReason = _NormalizedRejectReason
OrderExecutorSubmissionMethods = _OrderExecutorSubmissionMethods
copy_mapping = _copy_mapping
first_mapping_text = _first_mapping_text
first_mapping_value = _first_mapping_value
first_param_mapping = _first_param_mapping
first_param_text = _first_param_text
first_param_value = _first_param_value
json_default = _json_default
normalize_reject_reason = _normalize_reject_reason
stable_payload_hash = _stable_payload_hash

__all__ = (
    "OrderExecutor",
    "coerce_json",
    "coerce_string_list",
    "decision_state_payload",
    "extract_sizing_debug",
    "merge_decision_metadata",
    "merge_unique_strings",
    "normalize_reject_reasons",
    "normalize_submission_block_reasons",
    "NormalizedRejectReason",
    "OrderExecutorSubmissionMethods",
    "copy_mapping",
    "first_mapping_text",
    "first_mapping_value",
    "first_param_mapping",
    "first_param_text",
    "first_param_value",
    "json_default",
    "normalize_reject_reason",
    "stable_payload_hash",
)
