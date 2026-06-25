"""Broker-neutral execution adapters for trading order flow."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from collections.abc import Mapping
from typing import Any, Optional, cast
from urllib.parse import quote, urlencode
from uuid import uuid4

from ...alpaca_client import TorghutAlpacaClient
from ...config import settings
from ..firewall import OrderFirewall


from .adapter_types import (
    AlpacaExecutionAdapter,
    ExecutionAdapter,
    OrderSubmission,
    SimulationExecutionAdapter,
    logger,
)
from .order_text import (
    classify_failure_taxonomy,
    classify_fallback_reason,
    error_summary,
    http_request_text,
    is_http_status_error,
)


@dataclass(frozen=True)
class LeanRequest:
    method: str
    path: str
    payload: Optional[dict[str, Any]]
    headers: dict[str, str] | None
    operation: str


class LeanExecutionAdapter:
    """HTTP adapter to a LEAN runner service with optional Alpaca fallback."""

    name = "lean"
    _required_order_keys = {"id", "status", "symbol", "qty"}
    _required_read_order_keys = {"id", "status"}

    def __init__(
        self,
        *,
        base_url: str,
        timeout_seconds: int,
        fallback: Optional[ExecutionAdapter] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = max(timeout_seconds, 1)
        self.fallback = fallback
        self.last_route = self.name
        self.last_fallback_reason: str | None = None
        self.last_fallback_count: int = 0
        self.last_correlation_id: str | None = None
        self.last_idempotency_key: str | None = None
        self._observability_requests_total: dict[str, int] = {}
        self._observability_failures_total: dict[str, int] = {}
        self._observability_latency_ms_last: dict[str, float] = {}
        self._observability_latency_ms_sum: dict[str, float] = {}
        self._observability_latency_ms_count: dict[str, int] = {}

    def submit_order(
        self,
        request: OrderSubmission,
        /,
    ) -> dict[str, Any]:
        extra_params_payload: dict[str, Any] = dict(request.extra_params or {})
        client_order_id = extra_params_payload.get("client_order_id")
        correlation_id = f"torghut-{uuid4().hex[:20]}"
        idempotency_key = str(
            client_order_id
            or (
                f"{request.symbol}:{request.side}:{request.qty}:"
                f"{request.order_type}:{request.time_in_force}:{uuid4().hex[:8]}"
            )
        )
        self.last_correlation_id = correlation_id
        self.last_idempotency_key = idempotency_key
        body = self._submit_body(request, extra_params_payload)
        self._attach_shadow_context(request, extra_params_payload, correlation_id)
        payload = self._with_fallback(
            op="submit_order",
            request=lambda: self._validate_submit_payload(
                self._request_json(
                    "POST",
                    "/v1/orders/submit",
                    body,
                    headers={
                        "X-Correlation-ID": correlation_id,
                        "Idempotency-Key": idempotency_key,
                    },
                    operation="submit_order",
                ),
                adapter="lean",
                expected_client_order_id=client_order_id,
                expected_symbol=request.symbol,
            ),
            fallback=lambda: self._fallback_submit(request),
        )
        payload["_execution_route_expected"] = "lean"
        shadow_event = extra_params_payload.get("_lean_shadow")
        if isinstance(shadow_event, Mapping):
            payload["_lean_shadow"] = dict(cast(Mapping[str, Any], shadow_event))
        payload["_execution_correlation_id"] = correlation_id
        payload["_execution_idempotency_key"] = idempotency_key
        payload["_execution_audit"] = payload.get("_lean_audit") or {
            "correlation_id": correlation_id,
            "idempotency_key": idempotency_key,
        }
        return payload

    @staticmethod
    def _submit_body(
        request: OrderSubmission, extra_params_payload: dict[str, Any]
    ) -> dict[str, Any]:
        return {
            "symbol": request.symbol,
            "side": request.side,
            "qty": request.qty,
            "order_type": request.order_type,
            "time_in_force": request.time_in_force,
            "limit_price": request.limit_price,
            "stop_price": request.stop_price,
            "extra_params": extra_params_payload,
        }

    def _attach_shadow_context(
        self,
        request: OrderSubmission,
        extra_params_payload: dict[str, Any],
        correlation_id: str,
    ) -> None:
        if (
            not settings.trading_lean_shadow_execution_enabled
            or settings.trading_lean_lane_disable_switch
        ):
            return
        try:
            shadow_payload = self._request_json(
                "POST",
                "/v1/shadow/simulate",
                {
                    "symbol": request.symbol,
                    "side": request.side,
                    "qty": request.qty,
                    "order_type": request.order_type,
                    "time_in_force": request.time_in_force,
                    "limit_price": request.limit_price,
                    "intent_price": request.limit_price,
                },
                headers={"X-Correlation-ID": correlation_id},
                operation="shadow_simulate",
            )
            if isinstance(shadow_payload, Mapping):
                extra_params_payload["_lean_shadow"] = dict(
                    cast(Mapping[str, Any], shadow_payload)
                )
        except Exception:
            logger.debug(
                "lean shadow simulation request failed; continuing without shadow context",
                exc_info=True,
            )

    def cancel_order(self, order_id: str) -> bool:
        payload = self._with_fallback(
            op="cancel_order",
            request=lambda: self._request_json(
                "POST", f"/v1/orders/{quote(order_id)}/cancel"
            ),
            fallback=lambda: self._fallback_cancel(order_id),
        )
        if isinstance(payload, Mapping):
            raw_ok = cast(Mapping[str, Any], payload).get("ok")
            if isinstance(raw_ok, bool):
                return raw_ok
        return True

    def cancel_all_orders(self) -> list[dict[str, Any]]:
        payload = self._with_fallback(
            op="cancel_all_orders",
            request=lambda: self._request_json("POST", "/v1/orders/cancel-all"),
            fallback=lambda: self._fallback_cancel_all(),
        )
        if isinstance(payload, list):
            items = cast(list[Any], payload)
            return [
                cast(dict[str, Any], item)
                for item in items
                if isinstance(item, Mapping)
            ]
        if isinstance(payload, Mapping):
            orders = cast(Mapping[str, Any], payload).get("orders")
            if isinstance(orders, list):
                items = cast(list[Any], orders)
                return [
                    cast(dict[str, Any], item)
                    for item in items
                    if isinstance(item, Mapping)
                ]
        return []

    def get_order(self, order_id: str) -> dict[str, Any]:
        payload = self._with_fallback(
            op="get_order",
            request=lambda: self._validate_read_order_payload(
                self._request_json("GET", f"/v1/orders/{quote(order_id)}"),
                adapter="lean",
            ),
            fallback=lambda: self._fallback_get_order(order_id),
        )
        return self._coerce_order_dict(payload)

    def get_order_by_client_order_id(
        self, client_order_id: str
    ) -> dict[str, Any] | None:
        try:
            payload = self._request_json(
                "GET",
                f"/v1/orders/client/{quote(client_order_id)}",
                operation="get_order_by_client_order_id",
            )
            self.last_route = self.name
            return self._validate_read_order_payload(payload, adapter="lean")
        except Exception as exc:
            if is_http_status_error(exc, 404):
                self.last_route = self.name
                return None
            return self._fallback_get_order_by_client_id(client_order_id, exc)

    def list_orders(self, status: str = "all") -> list[dict[str, Any]]:
        query = urlencode({"status": status}) if status else ""
        path = "/v1/orders"
        if query:
            path = f"{path}?{query}"
        payload = self._with_fallback(
            op="list_orders",
            request=lambda: self._request_and_validate_order_list(path),
            fallback=lambda: self._fallback_list_orders(status),
        )
        if isinstance(payload, list):
            items = cast(list[Any], payload)
            return [
                cast(dict[str, Any], item)
                for item in items
                if isinstance(item, Mapping)
            ]
        if isinstance(payload, Mapping):
            orders = cast(Mapping[str, Any], payload).get("orders")
            if isinstance(orders, list):
                items = cast(list[Any], orders)
                return [
                    cast(dict[str, Any], item)
                    for item in items
                    if isinstance(item, Mapping)
                ]
        return []

    def list_positions(self) -> list[dict[str, Any]] | None:
        if self.fallback is None:
            return None
        lister = getattr(self.fallback, "list_positions", None)
        if not callable(lister):
            return None
        try:
            positions = lister()
        except Exception as exc:
            logger.warning("Lean adapter fallback list_positions failed: %s", exc)
            return None
        if positions is None:
            return None
        if not isinstance(positions, list):
            return []
        items = cast(list[Any], positions)
        return [
            cast(dict[str, Any], item) for item in items if isinstance(item, Mapping)
        ]

    def get_account(self) -> dict[str, Any] | None:
        if self.fallback is None:
            return None
        getter = getattr(self.fallback, "get_account", None)
        if not callable(getter):
            return None
        try:
            payload = getter()
        except Exception as exc:
            logger.warning("Lean adapter fallback get_account failed: %s", exc)
            return None
        if not isinstance(payload, Mapping):
            return None
        account = cast(Mapping[str, Any], payload)
        return {str(key): value for key, value in account.items()}

    def get_asset(self, symbol_or_asset_id: str) -> dict[str, Any] | None:
        if self.fallback is None:
            return None
        getter = getattr(self.fallback, "get_asset", None)
        if not callable(getter):
            return None
        try:
            payload = getter(symbol_or_asset_id)
        except Exception as exc:
            logger.warning(
                "Lean adapter fallback get_asset failed symbol=%s: %s",
                symbol_or_asset_id,
                exc,
            )
            return None
        if not isinstance(payload, Mapping):
            return None
        asset = cast(Mapping[str, Any], payload)
        return {str(key): value for key, value in asset.items()}

    def _request_json_with_headers(self, request: LeanRequest) -> Any:
        url = f"{self.base_url}{request.path}"
        started = time.perf_counter()
        request_body = None
        request_headers = {"accept": "application/json"}
        if request.headers:
            request_headers.update(request.headers)
        if request.payload is not None:
            request_body = json.dumps(request.payload).encode("utf-8")
            request_headers["content-type"] = "application/json"

        try:
            status, body = http_request_text(
                url=url,
                method=request.method,
                headers=request_headers,
                body=request_body,
                timeout_seconds=self.timeout_seconds,
            )
            if status < 200 or status >= 300:
                raise RuntimeError(f"lean_runner_http_{status}:{body[:200]}")
        except Exception as exc:
            self._record_observability_failure(request.operation, exc)
            raise
        self._record_observability_success(
            request.operation, time.perf_counter() - started
        )
        if not body:
            return {}
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            raise RuntimeError(f"lean_runner_invalid_json: {body[:200]}")

    def _request_json(
        self,
        method: str,
        path: str,
        payload: Optional[dict[str, Any]] = None,
        **options: Any,
    ) -> Any:
        return self._request_json_with_headers(
            LeanRequest(
                method=method,
                path=path,
                payload=payload,
                headers=cast(dict[str, str] | None, options.get("headers")),
                operation=str(options.get("operation") or "request_json"),
            )
        )

    def _with_fallback(self, *, op: str, request: Any, fallback: Any) -> Any:
        try:
            payload = request()
            self.last_route = self.name
            self.last_fallback_reason = None
            self.last_fallback_count = 0
            return payload
        except (TimeoutError, RuntimeError) as exc:
            if self.fallback is None:
                raise
            fallback_reason = classify_fallback_reason(op=op, exc=exc)
            logger.warning(
                "LEAN adapter failed op=%s; falling back to Alpaca adapter error=%s",
                op,
                error_summary(exc),
            )
            self.last_fallback_reason = fallback_reason
            self.last_fallback_count = 1
            payload = fallback()
            self.last_route = "alpaca_fallback"
            return payload

    def evaluate_strategy_shadow(self, intent: dict[str, Any]) -> dict[str, Any] | None:
        if (
            settings.trading_lean_lane_disable_switch
            or not settings.trading_lean_strategy_shadow_enabled
        ):
            return None
        correlation_id = f"torghut-shadow-{uuid4().hex[:18]}"
        strategy_id = str(intent.get("strategy_id") or "unknown")
        symbol = str(intent.get("symbol") or "unknown")
        payload = self._request_json(
            "POST",
            "/v1/strategy-shadow/evaluate",
            {
                "strategy_id": strategy_id,
                "symbol": symbol,
                "intent": intent,
            },
            headers={"X-Correlation-ID": correlation_id},
            operation="strategy_shadow",
        )
        if not isinstance(payload, Mapping):
            return None
        normalized = dict(cast(Mapping[str, Any], payload))
        normalized["_execution_correlation_id"] = correlation_id
        return normalized

    def get_observability_snapshot(self) -> dict[str, Any]:
        latency_avg: dict[str, float] = {}
        for operation, count in self._observability_latency_ms_count.items():
            if count <= 0:
                latency_avg[operation] = 0.0
                continue
            latency_avg[operation] = (
                self._observability_latency_ms_sum.get(operation, 0.0) / count
            )
        return {
            "requests_total": dict(self._observability_requests_total),
            "failures_total": dict(self._observability_failures_total),
            "latency_ms_last": dict(self._observability_latency_ms_last),
            "latency_ms_avg": latency_avg,
        }

    def _record_observability_success(
        self, operation: str, elapsed_seconds: float
    ) -> None:
        self._observability_requests_total[operation] = (
            self._observability_requests_total.get(operation, 0) + 1
        )
        latency_ms = max(elapsed_seconds * 1000.0, 0.0)
        self._observability_latency_ms_last[operation] = latency_ms
        self._observability_latency_ms_sum[operation] = (
            self._observability_latency_ms_sum.get(operation, 0.0) + latency_ms
        )
        self._observability_latency_ms_count[operation] = (
            self._observability_latency_ms_count.get(operation, 0) + 1
        )

    def _record_observability_failure(self, operation: str, exc: Exception) -> None:
        taxonomy = classify_failure_taxonomy(exc)
        key = f"{operation}:{taxonomy}"
        self._observability_failures_total[key] = (
            self._observability_failures_total.get(key, 0) + 1
        )

    def _fallback_submit(self, request: OrderSubmission) -> dict[str, Any]:
        if self.fallback is None:
            raise RuntimeError("lean_fallback_not_configured")
        payload = self.fallback.submit_order(
            request,
        )
        payload = self._coerce_order_dict(payload)
        payload = self._validate_submit_payload(
            payload,
            adapter="alpaca_fallback",
            expected_client_order_id=(request.extra_params or {}).get(
                "client_order_id"
            ),
            expected_symbol=request.symbol,
        )
        payload["_execution_adapter"] = "alpaca_fallback"
        payload["_execution_fallback_reason"] = (
            payload.get("_execution_fallback_reason")
            or self.last_fallback_reason
            or "lean_submit_failed"
        )
        payload["_execution_fallback_count"] = int(
            payload.get("_execution_fallback_count") or self.last_fallback_count or 1
        )
        return payload

    def _fallback_cancel(self, order_id: str) -> dict[str, Any]:
        if self.fallback is None:
            raise RuntimeError("lean_fallback_not_configured")
        return {"ok": self.fallback.cancel_order(order_id)}

    def _fallback_cancel_all(self) -> list[dict[str, Any]]:
        if self.fallback is None:
            raise RuntimeError("lean_fallback_not_configured")
        return self.fallback.cancel_all_orders()

    def _fallback_get_order(self, order_id: str) -> dict[str, Any]:
        if self.fallback is None:
            raise RuntimeError("lean_fallback_not_configured")
        payload = self._coerce_order_dict(self.fallback.get_order(order_id))
        payload["_execution_adapter"] = (
            payload.get("_execution_adapter") or "alpaca_fallback"
        )
        payload["_execution_fallback_reason"] = (
            payload.get("_execution_fallback_reason") or self.last_fallback_reason
        )
        payload["_execution_fallback_count"] = int(
            payload.get("_execution_fallback_count") or self.last_fallback_count or 1
        )
        return payload

    def _fallback_get_order_by_client_id(
        self, client_order_id: str, exc: Exception
    ) -> dict[str, Any] | None:
        if self.fallback is None:
            raise exc
        logger.warning(
            "LEAN adapter failed op=get_order_by_client_order_id; falling back error=%s",
            error_summary(exc),
        )
        self.last_route = "alpaca_fallback"
        self.last_fallback_reason = classify_fallback_reason(
            op="get_order_by_client_order_id", exc=exc
        )
        self.last_fallback_count = 1
        return self.fallback.get_order_by_client_order_id(client_order_id)

    def _fallback_list_orders(self, status: str) -> list[dict[str, Any]]:
        if self.fallback is None:
            raise RuntimeError("lean_fallback_not_configured")
        orders = self.fallback.list_orders(status=status)
        enriched: list[dict[str, Any]] = []
        for order in orders:
            payload = self._coerce_order_dict(order)
            payload["_execution_adapter"] = (
                payload.get("_execution_adapter") or "alpaca_fallback"
            )
            payload["_execution_fallback_reason"] = (
                payload.get("_execution_fallback_reason") or self.last_fallback_reason
            )
            payload["_execution_fallback_count"] = int(
                payload.get("_execution_fallback_count")
                or self.last_fallback_count
                or 1
            )
            enriched.append(payload)
        return enriched

    @staticmethod
    def _coerce_order_dict(payload: Any) -> dict[str, Any]:
        if isinstance(payload, Mapping):
            mapped = cast(Mapping[str, Any], payload)
            return {str(key): value for key, value in mapped.items()}
        raise RuntimeError(f"invalid_order_payload:{type(payload)}")

    def _validate_submit_payload(
        self,
        payload: Any,
        *,
        adapter: str,
        expected_client_order_id: Any,
        expected_symbol: str,
    ) -> dict[str, Any]:
        order = self._coerce_order_dict(payload)
        missing_keys = [
            key
            for key in sorted(self._required_order_keys)
            if order.get(key) in (None, "")
        ]
        if missing_keys:
            raise RuntimeError(
                f"lean_order_payload_missing_keys:{','.join(missing_keys)}"
            )
        if expected_client_order_id not in (None, ""):
            observed = order.get("client_order_id")
            if observed not in (None, "") and str(observed) != str(
                expected_client_order_id
            ):
                raise RuntimeError("lean_order_payload_client_order_id_mismatch")
        observed_symbol = str(order.get("symbol", "")).strip().upper()
        if observed_symbol != expected_symbol.strip().upper():
            raise RuntimeError("lean_order_payload_symbol_mismatch")
        qty_value = order.get("qty")
        try:
            qty = float(str(qty_value))
        except Exception as exc:
            raise RuntimeError("lean_order_payload_qty_invalid") from exc
        if qty <= 0:
            raise RuntimeError("lean_order_payload_qty_non_positive")
        order["_execution_adapter"] = adapter
        order["_execution_parity_check"] = "contract_v1"
        return order

    def _validate_read_order_payload(
        self,
        payload: Any,
        *,
        adapter: str,
    ) -> dict[str, Any]:
        order = self._coerce_order_dict(payload)
        missing_keys = [
            key
            for key in sorted(self._required_read_order_keys)
            if order.get(key) in (None, "")
        ]
        if missing_keys:
            raise RuntimeError(
                f"lean_read_order_payload_missing_keys:{','.join(missing_keys)}"
            )
        qty_value = order.get("qty")
        if qty_value not in (None, ""):
            try:
                float(str(qty_value))
            except Exception as exc:
                raise RuntimeError("lean_read_order_payload_qty_invalid") from exc
        order["_execution_adapter"] = order.get("_execution_adapter") or adapter
        return order

    def _request_and_validate_order_list(self, path: str) -> list[dict[str, Any]]:
        payload = self._request_json("GET", path)
        if isinstance(payload, list):
            items = cast(list[Any], payload)
            return [
                self._validate_read_order_payload(item, adapter="lean")
                for item in items
                if isinstance(item, Mapping)
            ]
        if isinstance(payload, Mapping):
            orders = cast(Mapping[str, Any], payload).get("orders")
            if isinstance(orders, list):
                items = cast(list[Any], orders)
                return [
                    self._validate_read_order_payload(item, adapter="lean")
                    for item in items
                    if isinstance(item, Mapping)
                ]
        return []


def build_execution_adapter(
    *,
    alpaca_client: TorghutAlpacaClient,
    order_firewall: OrderFirewall,
) -> ExecutionAdapter:
    """Build the primary execution adapter from runtime settings."""

    alpaca_adapter = AlpacaExecutionAdapter(
        firewall=order_firewall, read_client=alpaca_client
    )
    simulation_adapter = _build_simulation_execution_adapter()
    if simulation_adapter is not None:
        return simulation_adapter
    return alpaca_adapter


def _build_simulation_execution_adapter() -> SimulationExecutionAdapter | None:
    if not settings.trading_simulation_enabled:
        return None
    bootstrap_servers = (
        settings.trading_simulation_order_updates_bootstrap_servers
        or settings.trading_order_feed_bootstrap_servers
    )
    return SimulationExecutionAdapter(
        bootstrap_servers=bootstrap_servers,
        security_protocol=(
            settings.trading_simulation_order_updates_security_protocol
            or settings.trading_order_feed_security_protocol
        ),
        sasl_mechanism=(
            settings.trading_simulation_order_updates_sasl_mechanism
            or settings.trading_order_feed_sasl_mechanism
        ),
        sasl_username=(
            settings.trading_simulation_order_updates_sasl_username
            or settings.trading_order_feed_sasl_username
        ),
        sasl_password=(
            settings.trading_simulation_order_updates_sasl_password
            or settings.trading_order_feed_sasl_password
        ),
        topic=settings.trading_simulation_order_updates_topic,
        account_label=settings.trading_account_label,
        simulation_run_id=settings.trading_simulation_run_id,
        dataset_id=settings.trading_simulation_dataset_id,
    )


__all__ = [
    "LeanExecutionAdapter",
    "build_execution_adapter",
]
