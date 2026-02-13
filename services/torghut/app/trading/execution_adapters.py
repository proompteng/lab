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
        return self._with_fallback(
            op='submit_order',
            request=lambda: self._request_json('POST', '/v1/orders/submit', body),
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
            request=lambda: self._request_json('GET', f'/v1/orders/{quote(order_id)}'),
            fallback=lambda: self._fallback_get_order(order_id),
        )
        return self._coerce_order_dict(payload)

    def get_order_by_client_order_id(self, client_order_id: str) -> dict[str, Any] | None:
        try:
            payload = self._request_json('GET', f'/v1/orders/client/{quote(client_order_id)}')
            self.last_route = self.name
            return self._coerce_order_dict(payload)
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
            request=lambda: self._request_json('GET', path),
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
            return payload
        except (HTTPError, URLError, TimeoutError, RuntimeError) as exc:
            if self.fallback is None:
                raise
            logger.warning(
                'LEAN adapter failed op=%s; falling back to Alpaca adapter error=%s',
                op,
                _error_summary(exc),
            )
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
        payload['_execution_adapter'] = 'alpaca_fallback'
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
        return self.fallback.get_order(order_id)

    def _fallback_get_order_by_client_id(self, client_order_id: str, exc: Exception) -> dict[str, Any] | None:
        if self.fallback is None:
            raise exc
        logger.warning(
            'LEAN adapter failed op=get_order_by_client_order_id; falling back error=%s',
            _error_summary(exc),
        )
        self.last_route = 'alpaca_fallback'
        return self.fallback.get_order_by_client_order_id(client_order_id)

    def _fallback_list_orders(self, status: str) -> list[dict[str, Any]]:
        if self.fallback is None:
            raise RuntimeError('lean_fallback_not_configured')
        return self.fallback.list_orders(status=status)

    @staticmethod
    def _coerce_order_dict(payload: Any) -> dict[str, Any]:
        if isinstance(payload, Mapping):
            mapped = cast(Mapping[str, Any], payload)
            return {str(key): value for key, value in mapped.items()}
        raise RuntimeError(f'invalid_order_payload:{type(payload)}')


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


__all__ = [
    'ExecutionAdapter',
    'AlpacaExecutionAdapter',
    'LeanExecutionAdapter',
    'build_execution_adapter',
    'adapter_enabled_for_symbol',
]
