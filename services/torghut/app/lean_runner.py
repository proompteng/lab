"""LEAN bridge runner API.

This service exposes an HTTP contract compatible with the Torghut LEAN adapter.
It is intentionally constrained to order-routing operations and delegates to Alpaca.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import asdict, is_dataclass
from datetime import datetime
from enum import Enum
from typing import Any, Optional, cast
from uuid import UUID

from alpaca.trading.client import TradingClient
from alpaca.trading.enums import OrderSide, QueryOrderStatus, TimeInForce
from alpaca.trading.requests import (
    GetOrdersRequest,
    LimitOrderRequest,
    MarketOrderRequest,
    StopLimitOrderRequest,
    StopOrderRequest,
)
from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from .config import settings

app = FastAPI(title='torghut-lean-runner')


class SubmitOrderBody(BaseModel):
    model_config = ConfigDict(extra='allow')

    symbol: str
    side: str
    qty: float
    order_type: str
    time_in_force: str
    limit_price: Optional[float] = None
    stop_price: Optional[float] = None
    extra_params: dict[str, Any] = Field(default_factory=dict)


def _client() -> TradingClient:
    client = getattr(app.state, 'trading_client', None)
    if client is None:
        client = _build_trading_client()
        app.state.trading_client = client
    return cast(TradingClient, client)


@app.on_event('startup')
def startup() -> None:
    app.state.trading_client = _build_trading_client()


@app.get('/healthz')
def healthz() -> dict[str, str]:
    return {'status': 'ok', 'service': 'torghut-lean-runner'}


@app.post('/v1/orders/submit')
def submit_order(body: SubmitOrderBody) -> dict[str, Any]:
    trading = _client()
    side_enum = OrderSide(body.side.lower())
    tif_enum = TimeInForce(body.time_in_force.lower())
    payload: dict[str, Any] = {
        'symbol': body.symbol,
        'qty': body.qty,
        'side': side_enum,
        'time_in_force': tif_enum,
    }
    if body.extra_params:
        payload.update(body.extra_params)

    order_type = body.order_type.lower()
    try:
        if order_type == 'market':
            request = MarketOrderRequest(**payload)
        elif order_type == 'limit':
            if body.limit_price is None:
                raise ValueError('limit_price is required for limit orders')
            request = LimitOrderRequest(limit_price=body.limit_price, **payload)
        elif order_type == 'stop':
            if body.stop_price is None:
                raise ValueError('stop_price is required for stop orders')
            request = StopOrderRequest(stop_price=body.stop_price, **payload)
        elif order_type == 'stop_limit':
            if body.limit_price is None or body.stop_price is None:
                raise ValueError('stop_limit orders require both stop_price and limit_price')
            request = StopLimitOrderRequest(limit_price=body.limit_price, stop_price=body.stop_price, **payload)
        else:
            raise ValueError(f'unsupported order_type: {body.order_type}')
        order = trading.submit_order(request)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f'lean_submit_failed:{exc}') from exc

    result = _model_to_dict(order)
    result['_execution_adapter'] = 'lean'
    return result


@app.post('/v1/orders/{order_id}/cancel')
def cancel_order(order_id: str) -> dict[str, bool]:
    try:
        _client().cancel_order_by_id(order_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f'lean_cancel_failed:{exc}') from exc
    return {'ok': True}


@app.post('/v1/orders/cancel-all')
def cancel_all_orders() -> dict[str, list[dict[str, Any]]]:
    try:
        responses = _client().cancel_orders()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f'lean_cancel_all_failed:{exc}') from exc
    return {'orders': [_model_to_dict(item) for item in responses]}


@app.get('/v1/orders/{order_id}')
def get_order(order_id: str) -> dict[str, Any]:
    try:
        order = _client().get_order_by_id(order_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f'lean_get_order_failed:{exc}') from exc
    result = _model_to_dict(order)
    result['_execution_adapter'] = 'lean'
    return result


@app.get('/v1/orders/client/{client_order_id}')
def get_order_by_client_id(client_order_id: str) -> dict[str, Any]:
    try:
        order = _lookup_order_by_client_id(client_order_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f'lean_get_order_by_client_id_failed:{exc}') from exc
    if order is None:
        raise HTTPException(status_code=404, detail='order_not_found')
    result = _model_to_dict(order)
    result['_execution_adapter'] = 'lean'
    return result


@app.get('/v1/orders')
def list_orders(status: str = Query(default='all')) -> dict[str, list[dict[str, Any]]]:
    try:
        query = GetOrdersRequest(status=QueryOrderStatus(status.lower()))
        orders = _client().get_orders(query)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f'lean_list_orders_failed:{exc}') from exc
    payload = [_model_to_dict(order) for order in orders]
    for order in payload:
        order['_execution_adapter'] = 'lean'
    return {'orders': payload}


def _build_trading_client() -> TradingClient:
    is_live = settings.trading_mode == 'live'
    return TradingClient(
        api_key=settings.apca_api_key_id,
        secret_key=settings.apca_api_secret_key,
        paper=not is_live,
        url_override=_normalize_alpaca_base_url(settings.apca_api_base_url),
    )


def _lookup_order_by_client_id(client_order_id: str) -> Any | None:
    client = _client()

    for method_name in ('get_order_by_client_order_id', 'get_order_by_client_id'):
        getter = cast(Callable[[str], Any] | None, getattr(client, method_name, None))
        if getter is None:
            continue
        try:
            return getter(client_order_id)
        except Exception as exc:
            message = str(exc).lower()
            if 'not found' in message:
                continue
            raise

    # Fallback for client SDK versions that do not expose direct client-order lookup.
    orders = client.get_orders(GetOrdersRequest(status=QueryOrderStatus.ALL))
    for order in orders:
        if str(getattr(order, 'client_order_id', '') or '') == client_order_id:
            return order
    return None


def _normalize_alpaca_base_url(base_url: Optional[str]) -> Optional[str]:
    if not base_url:
        return None
    trimmed = base_url.rstrip('/')
    if trimmed.endswith('/v2'):
        return trimmed[:-3]
    return trimmed


def _model_to_dict(model: Any) -> dict[str, Any]:
    def to_jsonable(value: Any) -> Any:
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        if isinstance(value, UUID):
            return str(value)
        if isinstance(value, datetime):
            return value.isoformat()
        if isinstance(value, Enum):
            return to_jsonable(value.value)
        if is_dataclass(value) and not isinstance(value, type):
            return to_jsonable(asdict(value))
        if isinstance(value, Mapping):
            mapped = cast(Mapping[object, Any], value)
            return {str(key): to_jsonable(item) for key, item in mapped.items()}
        if isinstance(value, (list, tuple, set, frozenset)):
            return [to_jsonable(item) for item in value]
        return str(value)

    if hasattr(model, 'model_dump'):
        dumped = model.model_dump(mode='json')
        if isinstance(dumped, Mapping):
            return cast(dict[str, Any], to_jsonable(dumped))
        return {'value': to_jsonable(dumped)}
    if isinstance(model, Mapping):
        mapped = cast(Mapping[str, Any], model)
        return {str(key): to_jsonable(item) for key, item in mapped.items()}
    if hasattr(model, '__dict__'):
        attrs = {key: value for key, value in model.__dict__.items() if not key.startswith('_')}
        return cast(dict[str, Any], to_jsonable(attrs))
    return {'value': to_jsonable(model)}
