"""Order firewall enforcing deterministic kill switch behavior."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Optional

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
        return self._client.cancel_all_orders(firewall_token=self._token)

