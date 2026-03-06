"""Order firewall enforcing deterministic kill switch behavior."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Optional, cast

from ..alpaca_client import OrderFirewallToken, TorghutAlpacaClient
from ..config import settings

logger = logging.getLogger(__name__)


class OrderFirewallBlocked(RuntimeError):
    """Raised when the order firewall blocks submission."""


@dataclass(frozen=True)
class OrderFirewallStatus:
    kill_switch_enabled: bool
    reason: str


class OrderFirewall:
    """Single audited gateway for order submission/cancellation."""

    def __init__(self, client: TorghutAlpacaClient) -> None:
        self._client = client
        self._token = OrderFirewallToken()

    def status(self) -> OrderFirewallStatus:
        if settings.trading_kill_switch_enabled:
            return OrderFirewallStatus(kill_switch_enabled=True, reason="kill_switch_enabled")
        return OrderFirewallStatus(kill_switch_enabled=False, reason="ok")

    def cancel_open_orders_if_kill_switch(self) -> bool:
        status = self.status()
        if not status.kill_switch_enabled:
            return False
        try:
            cancelled = self._client.cancel_all_orders(firewall_token=self._token)
            logger.warning("Kill switch enabled; canceled %s open orders", len(cancelled))
        except Exception:
            logger.exception("Kill switch enabled; failed to cancel open orders")
        return True

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
        status = self.status()
        if status.kill_switch_enabled:
            raise OrderFirewallBlocked(status.reason)
        return self._client.submit_order(
            symbol=symbol,
            side=side,
            qty=qty,
            order_type=order_type,
            time_in_force=time_in_force,
            limit_price=limit_price,
            stop_price=stop_price,
            extra_params=extra_params,
            firewall_token=self._token,
        )

    def cancel_order(self, alpaca_order_id: str) -> bool:
        return self._client.cancel_order(alpaca_order_id, firewall_token=self._token)

    def cancel_all_orders(self) -> list[dict[str, Any]]:
        orders = self._client.cancel_all_orders(firewall_token=self._token)
        return _normalize_mapping_list(orders)

    def get_order_by_client_order_id(self, client_order_id: str) -> dict[str, Any] | None:
        # Reads are always allowed; this is used for idempotency backfills.
        order = self._client.get_order_by_client_order_id(client_order_id)
        return _normalize_mapping(order)

    def get_order(self, alpaca_order_id: str) -> dict[str, Any]:
        order = self._client.get_order(alpaca_order_id)
        normalized = _normalize_mapping(order)
        if normalized is None:
            return {}
        return normalized

    def list_orders(self, status: str = 'all') -> list[dict[str, Any]]:
        lister = getattr(self._client, 'list_orders', None)
        if not callable(lister):
            return []
        result = lister(status=status)
        return _normalize_mapping_list(result)

    def list_positions(self) -> list[dict[str, Any]] | None:
        lister = getattr(self._client, 'list_positions', None)
        if not callable(lister):
            return None
        result = lister()
        if result is None:
            return None
        return _normalize_mapping_list(result)

    def get_account(self) -> dict[str, Any] | None:
        getter = getattr(self._client, 'get_account', None)
        if not callable(getter):
            return None
        result = getter()
        return _normalize_mapping(result)

    def get_asset(self, symbol_or_asset_id: str) -> dict[str, Any] | None:
        getter = getattr(self._client, 'get_asset', None)
        if not callable(getter):
            return None
        result = getter(symbol_or_asset_id)
        return _normalize_mapping(result)


def _normalize_mapping(value: object) -> dict[str, Any] | None:
    if not isinstance(value, Mapping):
        return None
    mapping = cast(Mapping[object, Any], value)
    return {str(key): item for key, item in mapping.items()}


def _normalize_mapping_list(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    normalized: list[dict[str, Any]] = []
    items = cast(list[object], value)
    for item in items:
        mapping = _normalize_mapping(item)
        if mapping is not None:
            normalized.append(mapping)
    return normalized
