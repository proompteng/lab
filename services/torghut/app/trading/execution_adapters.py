"""Broker-neutral execution adapters for trading order flow."""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from typing import Any, Optional, Protocol, cast
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

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
        body = {
            'symbol': symbol,
            'side': side,
            'qty': qty,
            'order_type': order_type,
            'time_in_force': time_in_force,
            'limit_price': limit_price,
            'stop_price': stop_price,
            'extra_params': extra_params or {},
        }
        payload = self._with_fallback(
            op='submit_order',
            request=lambda: self._validate_submit_payload(
                self._request_json('POST', '/v1/orders/submit', body),
                adapter='lean',
                expected_client_order_id=(extra_params or {}).get('client_order_id'),
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
            payload = self._request_json('GET', f'/v1/orders/client/{quote(client_order_id)}')
            self.last_route = self.name
            return self._validate_read_order_payload(payload, adapter='lean')
        except HTTPError as exc:
            if exc.code == 404:
                self.last_route = self.name
                return None
            return self._fallback_get_order_by_client_id(client_order_id, exc)
        except Exception as exc:
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

    def _request_json(self, method: str, path: str, payload: Optional[dict[str, Any]] = None) -> Any:
        url = f'{self.base_url}{path}'
        request_body = None
        headers = {'accept': 'application/json'}
        if payload is not None:
            request_body = json.dumps(payload).encode('utf-8')
            headers['content-type'] = 'application/json'
        request = Request(url=url, data=request_body, method=method, headers=headers)
        with urlopen(request, timeout=self.timeout_seconds) as response:
            body = response.read().decode('utf-8').strip()
        if not body:
            return {}
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            raise RuntimeError(f'lean_runner_invalid_json: {body[:200]}')

    def _with_fallback(self, *, op: str, request: Any, fallback: Any) -> Any:
        try:
            payload = request()
            self.last_route = self.name
            self.last_fallback_reason = None
            self.last_fallback_count = 0
            return payload
        except (HTTPError, URLError, TimeoutError, RuntimeError) as exc:
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
    if settings.trading_execution_adapter != 'lean':
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


def adapter_enabled_for_symbol(symbol: str) -> bool:
    """Apply adapter routing policy constraints for symbol-level canaries."""

    if settings.trading_execution_adapter != 'lean':
        return False
    if settings.trading_execution_adapter_policy == 'all':
        return True
    allowlist = settings.trading_execution_adapter_symbols
    # When the symbol allowlist is omitted, route all symbols through the primary adapter.
    # This keeps WS/strategy-driven symbol onboarding as the canonical source of symbols
    # and avoids an implicit LEAN-disable path from an empty env var.
    if not allowlist:
        return True
    return symbol in allowlist


def _error_summary(exc: Exception) -> str:
    if isinstance(exc, HTTPError):
        body = ''
        try:
            body = exc.read().decode('utf-8').strip()
        except Exception:
            body = ''
        if body:
            return f'HTTP {exc.code}: {body[:200]}'
        return f'HTTP {exc.code}: {exc.reason}'
    return str(exc)


def _classify_fallback_reason(*, op: str, exc: Exception) -> str:
    message = str(exc).strip().lower()
    if 'lean_order_payload_' in message or 'lean_read_order_payload_' in message:
        return f'lean_{op}_contract_violation'
    if isinstance(exc, TimeoutError) or 'timed out' in message:
        return f'lean_{op}_timeout'
    if isinstance(exc, URLError):
        return f'lean_{op}_network_error'
    if isinstance(exc, HTTPError):
        return f'lean_{op}_http_{exc.code}'
    return f'lean_{op}_failed'


def _check_lean_runner_health(*, base_url: str, timeout_seconds: int) -> tuple[bool, str | None]:
    url = f'{base_url.rstrip("/")}/healthz'
    request = Request(url=url, method='GET', headers={'accept': 'application/json'})
    try:
        with urlopen(request, timeout=max(timeout_seconds, 1)) as response:
            payload_raw = response.read().decode('utf-8').strip()
            if response.status < 200 or response.status >= 300:
                return False, f'lean_health_http_{response.status}'
        if not payload_raw:
            return True, None
        payload = json.loads(payload_raw)
        if isinstance(payload, Mapping):
            status = str(cast(Mapping[str, Any], payload).get('status', '')).strip().lower()
            if status and status != 'ok':
                return False, f'lean_health_status_{status}'
        return True, None
    except HTTPError as exc:
        return False, f'lean_health_http_{exc.code}'
    except URLError as exc:
        return False, f'lean_health_network_error:{exc.reason}'
    except TimeoutError:
        return False, 'lean_health_timeout'
    except Exception as exc:  # pragma: no cover - defensive
        return False, f'lean_health_unknown_error:{exc}'


__all__ = [
    'ExecutionAdapter',
    'AlpacaExecutionAdapter',
    'LeanExecutionAdapter',
    'build_execution_adapter',
    'adapter_enabled_for_symbol',
]
