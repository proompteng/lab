"""Broker-neutral execution adapters for trading order flow."""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from collections.abc import Mapping
from http.client import HTTPConnection, HTTPSConnection
from typing import Any, Optional, Protocol, cast
from urllib.parse import quote, urlencode
from urllib.parse import urlsplit
from uuid import uuid4

from ..alpaca_client import TorghutAlpacaClient
from ..config import settings
from .firewall import OrderFirewall

logger = logging.getLogger(__name__)


class ExecutionAdapter(Protocol):
    """Contract used by order execution + reconciliation."""

    @property
    def name(self) -> str:
        ...

    def submit_order(
        self,
        symbol: str,
        side: str,
        qty: float,
        order_type: str,
        time_in_force: str,
        limit_price: Optional[float] = None,
        stop_price: Optional[float] = None,
        extra_params: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        ...

    def cancel_order(self, order_id: str) -> bool:
        ...

    def cancel_all_orders(self) -> list[dict[str, Any]]:
        ...

    def get_order(self, order_id: str) -> dict[str, Any]:
        ...

    def get_order_by_client_order_id(self, client_order_id: str) -> dict[str, Any] | None:
        ...

    def list_orders(self, status: str = 'all') -> list[dict[str, Any]]:
        ...

    def list_positions(self) -> list[dict[str, Any]] | None:
        ...


class AlpacaExecutionAdapter:
    """Default adapter that mutates via OrderFirewall and reads via TorghutAlpacaClient."""

    name = 'alpaca'

    def __init__(self, *, firewall: OrderFirewall, read_client: TorghutAlpacaClient) -> None:
        self._firewall = firewall
        self._read_client = read_client
        self.last_route = self.name

    def submit_order(
        self,
        symbol: str,
        side: str,
        qty: float,
        order_type: str,
        time_in_force: str,
        limit_price: Optional[float] = None,
        stop_price: Optional[float] = None,
        extra_params: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        payload = self._firewall.submit_order(
            symbol=symbol,
            side=side,
            qty=qty,
            order_type=order_type,
            time_in_force=time_in_force,
            limit_price=limit_price,
            stop_price=stop_price,
            extra_params=extra_params,
        )
        self.last_route = self.name
        return payload

    def cancel_order(self, order_id: str) -> bool:
        self.last_route = self.name
        return self._firewall.cancel_order(order_id)

    def cancel_all_orders(self) -> list[dict[str, Any]]:
        self.last_route = self.name
        return self._firewall.cancel_all_orders()

    def get_order(self, order_id: str) -> dict[str, Any]:
        return self._read_client.get_order(order_id)

    def get_order_by_client_order_id(self, client_order_id: str) -> dict[str, Any] | None:
        try:
            return self._read_client.get_order_by_client_order_id(client_order_id)
        except Exception:
            return None

    def list_orders(self, status: str = 'all') -> list[dict[str, Any]]:
        return self._read_client.list_orders(status=status)

    def list_positions(self) -> list[dict[str, Any]]:
        return self._read_client.list_positions()


class SimulationExecutionAdapter:
    """Deterministic no-side-effect adapter for historical simulation runs."""

    name = 'simulation'

    def __init__(
        self,
        *,
        bootstrap_servers: str | None,
        topic: str,
        account_label: str,
        simulation_run_id: str | None,
        dataset_id: str | None,
    ) -> None:
        self.last_route = self.name
        self.last_correlation_id: str | None = None
        self.last_idempotency_key: str | None = None
        self._topic = topic.strip() or 'torghut.sim.trade-updates.v1'
        self._account_label = account_label.strip() or 'paper'
        self._simulation_run_id = (simulation_run_id or '').strip() or 'simulation'
        self._dataset_id = (dataset_id or '').strip() or 'unknown'
        self._seq = 0
        self._orders_by_id: dict[str, dict[str, Any]] = {}
        self._order_id_by_client_id: dict[str, str] = {}
        self._producer: Any | None = None
        self._producer_init_error: str | None = None
        if bootstrap_servers and bootstrap_servers.strip():
            self._producer = self._build_producer(bootstrap_servers.strip())

    def submit_order(
        self,
        symbol: str,
        side: str,
        qty: float,
        order_type: str,
        time_in_force: str,
        limit_price: Optional[float] = None,
        stop_price: Optional[float] = None,
        extra_params: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        payload = dict(extra_params or {})
        requested_client_order_id = payload.get('client_order_id')
        client_order_id = str(requested_client_order_id).strip() if requested_client_order_id else ''
        if not client_order_id:
            client_order_id = f'sim-client-{uuid4().hex[:20]}'
        correlation_id = f'sim-{uuid4().hex[:20]}'
        idempotency_key = client_order_id
        now = datetime.now(timezone.utc)
        order_id = self._order_id_by_client_id.get(client_order_id)
        if order_id is None:
            order_id = f'sim-order-{uuid4().hex[:20]}'
        fill_price = _resolve_simulated_fill_price(
            limit_price=limit_price,
            stop_price=stop_price,
        )
        qty_value = max(float(qty), 0.0)
        order: dict[str, Any] = {
            'id': order_id,
            'client_order_id': client_order_id,
            'symbol': symbol,
            'side': side,
            'type': order_type,
            'time_in_force': time_in_force,
            'qty': _float_to_order_text(qty_value),
            'filled_qty': _float_to_order_text(qty_value),
            'filled_avg_price': _float_to_order_text(fill_price),
            'status': 'filled',
            'submitted_at': now.isoformat(),
            'updated_at': now.isoformat(),
            'alpaca_account_label': self._account_label,
            '_execution_adapter': self.name,
            '_execution_route_expected': self.name,
            '_execution_route_actual': self.name,
            '_execution_correlation_id': correlation_id,
            '_execution_idempotency_key': idempotency_key,
        }
        simulation_context = _resolve_simulation_context_payload(
            simulation_run_id=self._simulation_run_id,
            dataset_id=self._dataset_id,
            symbol=symbol,
            source=payload.get('simulation_context') if isinstance(payload.get('simulation_context'), Mapping) else None,
        )
        order['_simulation_context'] = simulation_context
        order['simulation_context'] = simulation_context
        order['_execution_audit'] = {
            'adapter': self.name,
            'correlation_id': correlation_id,
            'idempotency_key': idempotency_key,
            'mode': 'historical_simulation',
            'simulation_context': simulation_context,
        }
        self.last_route = self.name
        self.last_correlation_id = correlation_id
        self.last_idempotency_key = idempotency_key
        self._orders_by_id[order_id] = dict(order)
        self._order_id_by_client_id[client_order_id] = order_id
        self._publish_trade_update(order, event_type='fill', event_ts=now)
        return dict(order)

    def cancel_order(self, order_id: str) -> bool:
        order = self._orders_by_id.get(order_id)
        if order is None:
            return False
        current_status = str(order.get('status') or '').strip().lower()
        if current_status in {'filled', 'canceled', 'cancelled', 'rejected', 'expired'}:
            self.last_route = self.name
            return False
        now = datetime.now(timezone.utc)
        order['status'] = 'canceled'
        order['updated_at'] = now.isoformat()
        order['filled_qty'] = order.get('filled_qty') or '0'
        self._publish_trade_update(order, event_type='canceled', event_ts=now)
        self.last_route = self.name
        return True

    def cancel_all_orders(self) -> list[dict[str, Any]]:
        canceled: list[dict[str, Any]] = []
        for order_id in list(self._orders_by_id):
            if self.cancel_order(order_id):
                canceled.append({'id': order_id})
        self.last_route = self.name
        return canceled

    def get_order(self, order_id: str) -> dict[str, Any]:
        self.last_route = self.name
        existing = self._orders_by_id.get(order_id)
        if existing is None:
            return {'id': order_id, 'status': 'not_found', '_execution_adapter': self.name}
        return dict(existing)

    def get_order_by_client_order_id(self, client_order_id: str) -> dict[str, Any] | None:
        self.last_route = self.name
        order_id = self._order_id_by_client_id.get(client_order_id)
        if order_id is None:
            return None
        existing = self._orders_by_id.get(order_id)
        if existing is None:
            return None
        return dict(existing)

    def list_orders(self, status: str = 'all') -> list[dict[str, Any]]:
        self.last_route = self.name
        normalized = status.strip().lower()
        values = list(self._orders_by_id.values())
        if normalized in {'all', ''}:
            return [dict(value) for value in values]
        return [dict(value) for value in values if str(value.get('status', '')).strip().lower() == normalized]

    def _build_producer(self, bootstrap_servers: str) -> Any | None:
        try:
            from kafka import KafkaProducer  # type: ignore[import-not-found]
        except Exception as exc:  # pragma: no cover - dependency/runtime error
            self._producer_init_error = f'kafka_import_failed:{exc}'
            logger.warning(
                'Simulation adapter cannot emit trade-updates topic=%s reason=%s',
                self._topic,
                self._producer_init_error,
            )
            return None

        try:
            producer = KafkaProducer(
                bootstrap_servers=[item.strip() for item in bootstrap_servers.split(',') if item.strip()],
                value_serializer=None,
                key_serializer=None,
                retries=1,
                request_timeout_ms=2_000,
                max_block_ms=2_000,
            )
            return producer
        except Exception as exc:  # pragma: no cover - environment-dependent
            self._producer_init_error = f'kafka_producer_init_failed:{exc}'
            logger.warning(
                'Simulation adapter cannot initialize Kafka producer topic=%s reason=%s',
                self._topic,
                self._producer_init_error,
            )
            return None

    def _publish_trade_update(self, order: Mapping[str, Any], *, event_type: str, event_ts: datetime) -> None:
        self._seq += 1
        simulation_context = (
            dict(cast(Mapping[str, Any], order.get('simulation_context')))
            if isinstance(order.get('simulation_context'), Mapping)
            else _resolve_simulation_context_payload(
                simulation_run_id=self._simulation_run_id,
                dataset_id=self._dataset_id,
                symbol=str(order.get('symbol') or '').strip().upper(),
                source=None,
            )
        )
        envelope = {
            'channel': 'trade_updates',
            'event_ts': event_ts.isoformat(),
            'seq': self._seq,
            'symbol': order.get('symbol'),
            'source': 'simulation',
            'simulation_context': simulation_context,
            'payload': {
                'event': event_type,
                'timestamp': event_ts.isoformat(),
                'order': {
                    'id': order.get('id'),
                    'client_order_id': order.get('client_order_id'),
                    'symbol': order.get('symbol'),
                    'status': order.get('status'),
                    'side': order.get('side'),
                    'type': order.get('type'),
                    'time_in_force': order.get('time_in_force'),
                    'qty': order.get('qty'),
                    'filled_qty': order.get('filled_qty'),
                    'filled_avg_price': order.get('filled_avg_price'),
                    'alpaca_account_label': self._account_label,
                },
            },
        }
        if self._producer is None:
            if self._producer_init_error is None:
                logger.debug('Simulation adapter producer disabled; skip trade-update publish topic=%s', self._topic)
            return

        try:
            payload = json.dumps(envelope, separators=(',', ':')).encode('utf-8')
            key = str(order.get('symbol') or '').encode('utf-8')
            self._producer.send(self._topic, key=key, value=payload, timestamp_ms=int(event_ts.timestamp() * 1000))
            self._producer.flush(timeout=1.5)
        except Exception:
            logger.warning(
                'Simulation adapter failed to publish trade-update topic=%s order_id=%s',
                self._topic,
                order.get('id'),
                exc_info=True,
            )


class LeanExecutionAdapter:
    """HTTP adapter to a LEAN runner service with optional Alpaca fallback."""

    name = 'lean'
    _required_order_keys = {'id', 'status', 'symbol', 'qty'}
    _required_read_order_keys = {'id', 'status'}

    def __init__(
        self,
        *,
        base_url: str,
        timeout_seconds: int,
        fallback: Optional[ExecutionAdapter] = None,
    ) -> None:
        self.base_url = base_url.rstrip('/')
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
        symbol: str,
        side: str,
        qty: float,
        order_type: str,
        time_in_force: str,
        limit_price: Optional[float] = None,
        stop_price: Optional[float] = None,
        extra_params: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        extra_params_payload: dict[str, Any] = dict(extra_params or {})
        client_order_id = extra_params_payload.get('client_order_id')
        correlation_id = f'torghut-{uuid4().hex[:20]}'
        idempotency_key = str(
            client_order_id
            or f'{symbol}:{side}:{qty}:{order_type}:{time_in_force}:{uuid4().hex[:8]}'
        )
        self.last_correlation_id = correlation_id
        self.last_idempotency_key = idempotency_key
        body: dict[str, Any] = {
            'symbol': symbol,
            'side': side,
            'qty': qty,
            'order_type': order_type,
            'time_in_force': time_in_force,
            'limit_price': limit_price,
            'stop_price': stop_price,
            'extra_params': extra_params_payload,
        }
        if settings.trading_lean_shadow_execution_enabled and not settings.trading_lean_lane_disable_switch:
            try:
                shadow_payload = self._request_json(
                    'POST',
                    '/v1/shadow/simulate',
                    {
                        'symbol': symbol,
                        'side': side,
                        'qty': qty,
                        'order_type': order_type,
                        'time_in_force': time_in_force,
                        'limit_price': limit_price,
                        'intent_price': limit_price,
                    },
                    headers={'X-Correlation-ID': correlation_id},
                    operation='shadow_simulate',
                )
                if isinstance(shadow_payload, Mapping):
                    extra_params_payload['_lean_shadow'] = dict(cast(Mapping[str, Any], shadow_payload))
            except Exception:
                logger.debug(
                    'lean shadow simulation request failed; continuing without shadow context',
                    exc_info=True,
                )
        payload = self._with_fallback(
            op='submit_order',
            request=lambda: self._validate_submit_payload(
                self._request_json(
                    'POST',
                    '/v1/orders/submit',
                    body,
                    headers={
                        'X-Correlation-ID': correlation_id,
                        'Idempotency-Key': idempotency_key,
                    },
                    operation='submit_order',
                ),
                adapter='lean',
                expected_client_order_id=client_order_id,
                expected_symbol=symbol,
            ),
            fallback=lambda: self._fallback_submit(
                symbol=symbol,
                side=side,
                qty=qty,
                order_type=order_type,
                time_in_force=time_in_force,
                limit_price=limit_price,
                stop_price=stop_price,
                extra_params=extra_params,
            ),
        )
        payload['_execution_route_expected'] = 'lean'
        shadow_event = extra_params_payload.get('_lean_shadow')
        if isinstance(shadow_event, Mapping):
            payload['_lean_shadow'] = dict(cast(Mapping[str, Any], shadow_event))
        payload['_execution_correlation_id'] = correlation_id
        payload['_execution_idempotency_key'] = idempotency_key
        payload['_execution_audit'] = payload.get('_lean_audit') or {
            'correlation_id': correlation_id,
            'idempotency_key': idempotency_key,
        }
        return payload

    def cancel_order(self, order_id: str) -> bool:
        payload = self._with_fallback(
            op='cancel_order',
            request=lambda: self._request_json('POST', f'/v1/orders/{quote(order_id)}/cancel'),
            fallback=lambda: self._fallback_cancel(order_id),
        )
        if isinstance(payload, Mapping):
            raw_ok = cast(Mapping[str, Any], payload).get('ok')
            if isinstance(raw_ok, bool):
                return raw_ok
        return True

    def cancel_all_orders(self) -> list[dict[str, Any]]:
        payload = self._with_fallback(
            op='cancel_all_orders',
            request=lambda: self._request_json('POST', '/v1/orders/cancel-all'),
            fallback=lambda: self._fallback_cancel_all(),
        )
        if isinstance(payload, list):
            items = cast(list[Any], payload)
            return [cast(dict[str, Any], item) for item in items if isinstance(item, Mapping)]
        if isinstance(payload, Mapping):
            orders = cast(Mapping[str, Any], payload).get('orders')
            if isinstance(orders, list):
                items = cast(list[Any], orders)
                return [cast(dict[str, Any], item) for item in items if isinstance(item, Mapping)]
        return []

    def get_order(self, order_id: str) -> dict[str, Any]:
        payload = self._with_fallback(
            op='get_order',
            request=lambda: self._validate_read_order_payload(
                self._request_json('GET', f'/v1/orders/{quote(order_id)}'),
                adapter='lean',
            ),
            fallback=lambda: self._fallback_get_order(order_id),
        )
        return self._coerce_order_dict(payload)

    def get_order_by_client_order_id(self, client_order_id: str) -> dict[str, Any] | None:
        try:
            payload = self._request_json(
                'GET',
                f'/v1/orders/client/{quote(client_order_id)}',
                operation='get_order_by_client_order_id',
            )
            self.last_route = self.name
            return self._validate_read_order_payload(payload, adapter='lean')
        except Exception as exc:
            if _is_http_status_error(exc, 404):
                self.last_route = self.name
                return None
            return self._fallback_get_order_by_client_id(client_order_id, exc)

    def list_orders(self, status: str = 'all') -> list[dict[str, Any]]:
        query = urlencode({'status': status}) if status else ''
        path = '/v1/orders'
        if query:
            path = f'{path}?{query}'
        payload = self._with_fallback(
            op='list_orders',
            request=lambda: self._request_and_validate_order_list(path),
            fallback=lambda: self._fallback_list_orders(status),
        )
        if isinstance(payload, list):
            items = cast(list[Any], payload)
            return [cast(dict[str, Any], item) for item in items if isinstance(item, Mapping)]
        if isinstance(payload, Mapping):
            orders = cast(Mapping[str, Any], payload).get('orders')
            if isinstance(orders, list):
                items = cast(list[Any], orders)
                return [cast(dict[str, Any], item) for item in items if isinstance(item, Mapping)]
        return []

    def list_positions(self) -> list[dict[str, Any]] | None:
        if self.fallback is None:
            return None
        lister = getattr(self.fallback, 'list_positions', None)
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
        return [cast(dict[str, Any], item) for item in items if isinstance(item, Mapping)]

    def _request_json_with_headers(
        self,
        method: str,
        path: str,
        payload: Optional[dict[str, Any]],
        *,
        headers: dict[str, str] | None,
        operation: str,
    ) -> Any:
        url = f'{self.base_url}{path}'
        started = time.perf_counter()
        request_body = None
        request_headers = {'accept': 'application/json'}
        if headers:
            request_headers.update(headers)
        if payload is not None:
            request_body = json.dumps(payload).encode('utf-8')
            request_headers['content-type'] = 'application/json'

        try:
            status, body = _http_request_text(
                url=url,
                method=method,
                headers=request_headers,
                body=request_body,
                timeout_seconds=self.timeout_seconds,
            )
            if status < 200 or status >= 300:
                raise RuntimeError(f'lean_runner_http_{status}:{body[:200]}')
        except Exception as exc:
            self._record_observability_failure(operation, exc)
            raise
        self._record_observability_success(operation, time.perf_counter() - started)
        if not body:
            return {}
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            raise RuntimeError(f'lean_runner_invalid_json: {body[:200]}')

    def _request_json(
        self,
        method: str,
        path: str,
        payload: Optional[dict[str, Any]] = None,
        *,
        headers: dict[str, str] | None = None,
        operation: str = 'request_json',
    ) -> Any:
        return self._request_json_with_headers(
            method,
            path,
            payload,
            headers=headers,
            operation=operation,
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
            fallback_reason = _classify_fallback_reason(op=op, exc=exc)
            logger.warning(
                'LEAN adapter failed op=%s; falling back to Alpaca adapter error=%s',
                op,
                _error_summary(exc),
            )
            self.last_fallback_reason = fallback_reason
            self.last_fallback_count = 1
            payload = fallback()
            self.last_route = 'alpaca_fallback'
            return payload

    def evaluate_strategy_shadow(self, intent: dict[str, Any]) -> dict[str, Any] | None:
        if settings.trading_lean_lane_disable_switch or not settings.trading_lean_strategy_shadow_enabled:
            return None
        correlation_id = f'torghut-shadow-{uuid4().hex[:18]}'
        strategy_id = str(intent.get('strategy_id') or 'unknown')
        symbol = str(intent.get('symbol') or 'unknown')
        payload = self._request_json(
            'POST',
            '/v1/strategy-shadow/evaluate',
            {
                'strategy_id': strategy_id,
                'symbol': symbol,
                'intent': intent,
            },
            headers={'X-Correlation-ID': correlation_id},
            operation='strategy_shadow',
        )
        if not isinstance(payload, Mapping):
            return None
        normalized = dict(cast(Mapping[str, Any], payload))
        normalized['_execution_correlation_id'] = correlation_id
        return normalized

    def get_observability_snapshot(self) -> dict[str, Any]:
        latency_avg: dict[str, float] = {}
        for operation, count in self._observability_latency_ms_count.items():
            if count <= 0:
                latency_avg[operation] = 0.0
                continue
            latency_avg[operation] = self._observability_latency_ms_sum.get(operation, 0.0) / count
        return {
            'requests_total': dict(self._observability_requests_total),
            'failures_total': dict(self._observability_failures_total),
            'latency_ms_last': dict(self._observability_latency_ms_last),
            'latency_ms_avg': latency_avg,
        }

    def _record_observability_success(self, operation: str, elapsed_seconds: float) -> None:
        self._observability_requests_total[operation] = self._observability_requests_total.get(operation, 0) + 1
        latency_ms = max(elapsed_seconds * 1000.0, 0.0)
        self._observability_latency_ms_last[operation] = latency_ms
        self._observability_latency_ms_sum[operation] = self._observability_latency_ms_sum.get(operation, 0.0) + latency_ms
        self._observability_latency_ms_count[operation] = self._observability_latency_ms_count.get(operation, 0) + 1

    def _record_observability_failure(self, operation: str, exc: Exception) -> None:
        taxonomy = _classify_failure_taxonomy(exc)
        key = f'{operation}:{taxonomy}'
        self._observability_failures_total[key] = self._observability_failures_total.get(key, 0) + 1

    def _fallback_submit(
        self,
        *,
        symbol: str,
        side: str,
        qty: float,
        order_type: str,
        time_in_force: str,
        limit_price: Optional[float],
        stop_price: Optional[float],
        extra_params: Optional[dict[str, Any]],
    ) -> dict[str, Any]:
        if self.fallback is None:
            raise RuntimeError('lean_fallback_not_configured')
        payload = self.fallback.submit_order(
            symbol=symbol,
            side=side,
            qty=qty,
            order_type=order_type,
            time_in_force=time_in_force,
            limit_price=limit_price,
            stop_price=stop_price,
            extra_params=extra_params,
        )
        payload = self._coerce_order_dict(payload)
        payload = self._validate_submit_payload(
            payload,
            adapter='alpaca_fallback',
            expected_client_order_id=(extra_params or {}).get('client_order_id'),
            expected_symbol=symbol,
        )
        payload['_execution_adapter'] = 'alpaca_fallback'
        payload['_execution_fallback_reason'] = (
            payload.get('_execution_fallback_reason') or self.last_fallback_reason or 'lean_submit_failed'
        )
        payload['_execution_fallback_count'] = int(payload.get('_execution_fallback_count') or self.last_fallback_count or 1)
        return payload

    def _fallback_cancel(self, order_id: str) -> dict[str, Any]:
        if self.fallback is None:
            raise RuntimeError('lean_fallback_not_configured')
        return {'ok': self.fallback.cancel_order(order_id)}

    def _fallback_cancel_all(self) -> list[dict[str, Any]]:
        if self.fallback is None:
            raise RuntimeError('lean_fallback_not_configured')
        return self.fallback.cancel_all_orders()

    def _fallback_get_order(self, order_id: str) -> dict[str, Any]:
        if self.fallback is None:
            raise RuntimeError('lean_fallback_not_configured')
        payload = self._coerce_order_dict(self.fallback.get_order(order_id))
        payload['_execution_adapter'] = payload.get('_execution_adapter') or 'alpaca_fallback'
        payload['_execution_fallback_reason'] = payload.get('_execution_fallback_reason') or self.last_fallback_reason
        payload['_execution_fallback_count'] = int(payload.get('_execution_fallback_count') or self.last_fallback_count or 1)
        return payload

    def _fallback_get_order_by_client_id(self, client_order_id: str, exc: Exception) -> dict[str, Any] | None:
        if self.fallback is None:
            raise exc
        logger.warning(
            'LEAN adapter failed op=get_order_by_client_order_id; falling back error=%s',
            _error_summary(exc),
        )
        self.last_route = 'alpaca_fallback'
        self.last_fallback_reason = _classify_fallback_reason(op='get_order_by_client_order_id', exc=exc)
        self.last_fallback_count = 1
        return self.fallback.get_order_by_client_order_id(client_order_id)

    def _fallback_list_orders(self, status: str) -> list[dict[str, Any]]:
        if self.fallback is None:
            raise RuntimeError('lean_fallback_not_configured')
        orders = self.fallback.list_orders(status=status)
        enriched: list[dict[str, Any]] = []
        for order in orders:
            payload = self._coerce_order_dict(order)
            payload['_execution_adapter'] = payload.get('_execution_adapter') or 'alpaca_fallback'
            payload['_execution_fallback_reason'] = payload.get('_execution_fallback_reason') or self.last_fallback_reason
            payload['_execution_fallback_count'] = int(payload.get('_execution_fallback_count') or self.last_fallback_count or 1)
            enriched.append(payload)
        return enriched

    @staticmethod
    def _coerce_order_dict(payload: Any) -> dict[str, Any]:
        if isinstance(payload, Mapping):
            mapped = cast(Mapping[str, Any], payload)
            return {str(key): value for key, value in mapped.items()}
        raise RuntimeError(f'invalid_order_payload:{type(payload)}')

    def _validate_submit_payload(
        self,
        payload: Any,
        *,
        adapter: str,
        expected_client_order_id: Any,
        expected_symbol: str,
    ) -> dict[str, Any]:
        order = self._coerce_order_dict(payload)
        missing_keys = [key for key in sorted(self._required_order_keys) if order.get(key) in (None, '')]
        if missing_keys:
            raise RuntimeError(f'lean_order_payload_missing_keys:{",".join(missing_keys)}')
        if expected_client_order_id not in (None, ''):
            observed = order.get('client_order_id')
            if observed not in (None, '') and str(observed) != str(expected_client_order_id):
                raise RuntimeError('lean_order_payload_client_order_id_mismatch')
        observed_symbol = str(order.get('symbol', '')).strip().upper()
        if observed_symbol != expected_symbol.strip().upper():
            raise RuntimeError('lean_order_payload_symbol_mismatch')
        qty_value = order.get('qty')
        try:
            qty = float(str(qty_value))
        except Exception as exc:
            raise RuntimeError('lean_order_payload_qty_invalid') from exc
        if qty <= 0:
            raise RuntimeError('lean_order_payload_qty_non_positive')
        order['_execution_adapter'] = adapter
        order['_execution_parity_check'] = 'contract_v1'
        return order

    def _validate_read_order_payload(
        self,
        payload: Any,
        *,
        adapter: str,
    ) -> dict[str, Any]:
        order = self._coerce_order_dict(payload)
        missing_keys = [key for key in sorted(self._required_read_order_keys) if order.get(key) in (None, '')]
        if missing_keys:
            raise RuntimeError(f'lean_read_order_payload_missing_keys:{",".join(missing_keys)}')
        qty_value = order.get('qty')
        if qty_value not in (None, ''):
            try:
                float(str(qty_value))
            except Exception as exc:
                raise RuntimeError('lean_read_order_payload_qty_invalid') from exc
        order['_execution_adapter'] = order.get('_execution_adapter') or adapter
        return order

    def _request_and_validate_order_list(self, path: str) -> list[dict[str, Any]]:
        payload = self._request_json('GET', path)
        if isinstance(payload, list):
            items = cast(list[Any], payload)
            return [
                self._validate_read_order_payload(item, adapter='lean')
                for item in items
                if isinstance(item, Mapping)
            ]
        if isinstance(payload, Mapping):
            orders = cast(Mapping[str, Any], payload).get('orders')
            if isinstance(orders, list):
                items = cast(list[Any], orders)
                return [
                    self._validate_read_order_payload(item, adapter='lean')
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

    alpaca_adapter = AlpacaExecutionAdapter(firewall=order_firewall, read_client=alpaca_client)
    simulation_enabled = settings.trading_simulation_enabled or settings.trading_execution_adapter == 'simulation'
    if simulation_enabled:
        bootstrap_servers = (
            settings.trading_simulation_order_updates_bootstrap_servers
            or settings.trading_order_feed_bootstrap_servers
        )
        return SimulationExecutionAdapter(
            bootstrap_servers=bootstrap_servers,
            topic=settings.trading_simulation_order_updates_topic,
            account_label=settings.trading_account_label,
            simulation_run_id=settings.trading_simulation_run_id,
            dataset_id=settings.trading_simulation_dataset_id,
        )

    if settings.trading_execution_adapter != 'lean':
        return alpaca_adapter
    if settings.trading_lean_lane_disable_switch:
        logger.warning('LEAN lanes disabled by TRADING_LEAN_LANE_DISABLE_SWITCH; using Alpaca adapter')
        return alpaca_adapter

    if not settings.trading_lean_runner_url:
        logger.warning('LEAN adapter requested but TRADING_LEAN_RUNNER_URL is missing; using Alpaca adapter')
        return alpaca_adapter

    fallback: ExecutionAdapter | None = None
    if settings.trading_execution_fallback_adapter == 'alpaca':
        fallback = alpaca_adapter
    if settings.trading_mode == 'live' and fallback is None:
        logger.warning('LEAN adapter disabled in live mode because fallback adapter is not configured')
        return alpaca_adapter
    if settings.trading_lean_runner_healthcheck_enabled:
        health_ok, health_error = _check_lean_runner_health(
            base_url=settings.trading_lean_runner_url,
            timeout_seconds=settings.trading_lean_runner_healthcheck_timeout_seconds,
        )
        if not health_ok and settings.trading_lean_runner_require_healthy:
            logger.warning(
                'LEAN adapter disabled because LEAN runner health check failed error=%s',
                health_error or 'unknown',
            )
            return alpaca_adapter

    return LeanExecutionAdapter(
        base_url=settings.trading_lean_runner_url,
        timeout_seconds=settings.trading_lean_runner_timeout_seconds,
        fallback=fallback,
    )


def adapter_enabled_for_symbol(symbol: str, *, allowlist: set[str] | None = None) -> bool:
    """Return whether LEAN should be used for execution routing."""

    _ = (symbol, allowlist)

    if settings.trading_simulation_enabled or settings.trading_execution_adapter == 'simulation':
        return True
    if settings.trading_execution_adapter != 'lean':
        return False
    if settings.trading_lean_lane_disable_switch:
        return False
    return True


def _resolve_simulated_fill_price(
    *,
    limit_price: float | None,
    stop_price: float | None,
) -> float:
    for candidate in (limit_price, stop_price):
        if candidate is None:
            continue
        try:
            value = float(candidate)
        except Exception:
            continue
        if value > 0:
            return value
    return 1.0


def _float_to_order_text(value: float) -> str:
    normalized = max(float(value), 0.0)
    rendered = f'{normalized:.8f}'.rstrip('0').rstrip('.')
    if not rendered:
        return '0'
    return rendered


def _resolve_simulation_context_payload(
    *,
    simulation_run_id: str | None,
    dataset_id: str | None,
    symbol: str,
    source: Mapping[str, Any] | None,
) -> dict[str, Any]:
    context: dict[str, Any] = {}
    if isinstance(source, Mapping):
        context.update({str(key): value for key, value in source.items()})
    if context.get('simulation_run_id') in (None, ''):
        context['simulation_run_id'] = (simulation_run_id or '').strip() or 'simulation'
    if context.get('dataset_id') in (None, ''):
        context['dataset_id'] = (dataset_id or '').strip() or 'unknown'
    if context.get('symbol') in (None, '') and symbol.strip():
        context['symbol'] = symbol.strip().upper()
    return context


def _error_summary(exc: Exception) -> str:
    message = str(exc).strip()
    if message:
        return message
    return exc.__class__.__name__


def _is_http_status_error(exc: Exception, status_code: int) -> bool:
    message = str(exc).strip().lower()
    return message.startswith(f'lean_runner_http_{status_code}')


def _classify_fallback_reason(*, op: str, exc: Exception) -> str:
    message = str(exc).strip().lower()
    if 'lean_order_payload_' in message or 'lean_read_order_payload_' in message:
        return f'lean_{op}_contract_violation'
    if isinstance(exc, TimeoutError) or 'timed out' in message:
        return f'lean_{op}_timeout'
    if 'network_error' in message:
        return f'lean_{op}_network_error'
    if message.startswith('lean_runner_http_') or '_http_' in message:
        if message.startswith('lean_runner_http_'):
            code = message.split(':', 1)[0].replace('lean_runner_http_', '')
            if code.isdigit():
                return f'lean_{op}_http_{code}'
        return f'lean_{op}_http_error'
    return f'lean_{op}_failed'


def _classify_failure_taxonomy(exc: Exception) -> str:
    if isinstance(exc, TimeoutError):
        return 'timeout'
    message = str(exc).lower().strip()
    if 'network_error' in message:
        return 'network_error'
    if message.startswith('lean_runner_http_'):
        code = message.split(':', 1)[0].replace('lean_runner_http_', '')
        if code.isdigit():
            return f'http_{code}'
        return 'http_error'
    if 'contract' in message:
        return 'contract_violation'
    if 'invalid_json' in message:
        return 'invalid_json'
    return 'unknown_error'


def _check_lean_runner_health(*, base_url: str, timeout_seconds: int) -> tuple[bool, str | None]:
    url = f'{base_url.rstrip("/")}/healthz'
    try:
        status, payload_raw = _http_request_text(
            url=url,
            method='GET',
            headers={'accept': 'application/json'},
            body=None,
            timeout_seconds=max(timeout_seconds, 1),
        )
        if status < 200 or status >= 300:
            return False, f'lean_health_http_{status}'
        if not payload_raw:
            return True, None
        payload = json.loads(payload_raw)
        if isinstance(payload, Mapping):
            status = str(cast(Mapping[str, Any], payload).get('status', '')).strip().lower()
            if status and status != 'ok':
                return False, f'lean_health_status_{status}'
        return True, None
    except TimeoutError:
        return False, 'lean_health_timeout'
    except OSError as exc:
        return False, f'lean_health_network_error:{exc}'
    except Exception as exc:  # pragma: no cover - defensive
        return False, f'lean_health_unknown_error:{exc}'


def _http_request_text(
    *,
    url: str,
    method: str,
    headers: Mapping[str, str],
    body: bytes | None,
    timeout_seconds: int,
) -> tuple[int, str]:
    parsed = urlsplit(url)
    scheme = parsed.scheme.lower()
    if scheme not in {'http', 'https'}:
        raise RuntimeError(f'unsupported_url_scheme:{scheme or "missing"}')
    if not parsed.hostname:
        raise RuntimeError('invalid_url_host')

    path = parsed.path or '/'
    if parsed.query:
        path = f'{path}?{parsed.query}'
    connection_class = HTTPSConnection if scheme == 'https' else HTTPConnection
    connection = connection_class(parsed.hostname, parsed.port, timeout=max(timeout_seconds, 1))
    try:
        connection.request(method, path, body=body, headers=dict(headers))
        response = connection.getresponse()
        raw = response.read().decode('utf-8', errors='replace').strip()
        return response.status, raw
    except OSError as exc:
        raise RuntimeError(f'network_error:{exc}') from exc
    finally:
        connection.close()


__all__ = [
    'ExecutionAdapter',
    'AlpacaExecutionAdapter',
    'SimulationExecutionAdapter',
    'LeanExecutionAdapter',
    'build_execution_adapter',
    'adapter_enabled_for_symbol',
]
