"""Order firewall enforcing deterministic kill switch behavior."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Protocol

from ..alpaca_client import OrderFirewallToken
from ..config import settings

logger = logging.getLogger(__name__)


class OrderFirewallBlocked(RuntimeError):
    """Raised when the order firewall blocks submission."""


@dataclass(frozen=True)
class OrderFirewallStatus:
    kill_switch_enabled: bool
    reason: str


class _OrderFirewallBrokerClient(Protocol):
    """Broker methods the order firewall is allowed to call."""

    def submit_order(
        self,
        *,
        symbol: str,
        side: str,
        qty: float,
        order_type: str,
        time_in_force: str,
        limit_price: float | None = None,
        stop_price: float | None = None,
        extra_params: dict[str, Any] | None = None,
        firewall_token: OrderFirewallToken,
    ) -> dict[str, Any]: ...

    def cancel_order(
        self, alpaca_order_id: str, *, firewall_token: OrderFirewallToken
    ) -> bool: ...

    def cancel_all_orders(
        self, *, firewall_token: OrderFirewallToken
    ) -> list[dict[str, Any]]: ...

    def get_order_by_client_order_id(
        self, client_order_id: str
    ) -> dict[str, Any] | None: ...

    def get_order(self, alpaca_order_id: str) -> dict[str, Any]: ...

    def list_orders(self, status: str = "all") -> list[dict[str, Any]]: ...

    def list_positions(self) -> list[dict[str, Any]] | None: ...

    def get_account(self) -> dict[str, Any] | None: ...

    def get_asset(self, symbol_or_asset_id: str) -> dict[str, Any] | None: ...


class OrderFirewall:
    """Single audited gateway for order submission/cancellation."""

    def __init__(self, client: _OrderFirewallBrokerClient) -> None:
        self._client = client
        self._token = OrderFirewallToken()

    def status(self) -> OrderFirewallStatus:
        if settings.trading_kill_switch_enabled:
            return OrderFirewallStatus(
                kill_switch_enabled=True, reason="kill_switch_enabled"
            )
        return OrderFirewallStatus(kill_switch_enabled=False, reason="ok")

    def cancel_open_orders_if_kill_switch(self) -> bool:
        status = self.status()
        if not status.kill_switch_enabled:
            return False
        try:
            cancelled = self._client.cancel_all_orders(firewall_token=self._token)
            logger.warning(
                "Kill switch enabled; canceled %s open orders", len(cancelled)
            )
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
        limit_price: float | None = None,
        stop_price: float | None = None,
        extra_params: dict[str, Any] | None = None,
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
        return self._client.cancel_all_orders(firewall_token=self._token)

    def get_order_by_client_order_id(
        self, client_order_id: str
    ) -> dict[str, Any] | None:
        # Reads are always allowed; this is used for idempotency backfills.
        return self._client.get_order_by_client_order_id(client_order_id)

    def get_order(self, alpaca_order_id: str) -> dict[str, Any]:
        return self._client.get_order(alpaca_order_id)

    def list_orders(self, status: str = "all") -> list[dict[str, Any]]:
        return self._client.list_orders(status=status)

    def list_positions(self) -> list[dict[str, Any]] | None:
        return self._client.list_positions()

    def get_account(self) -> dict[str, Any] | None:
        return self._client.get_account()

    def get_asset(self, symbol_or_asset_id: str) -> dict[str, Any] | None:
        return self._client.get_asset(symbol_or_asset_id)
