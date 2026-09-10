"""Construction of the broker-read and simulation execution adapters."""

from __future__ import annotations

from collections.abc import Callable

from sqlalchemy.orm import Session

from ...alpaca_client import TorghutAlpacaClient
from ...config import settings
from ..firewall import OrderFirewall
from .adapter_types import (
    AlpacaExecutionAdapter,
    ExecutionAdapter,
    SimulationExecutionAdapter,
)


def build_execution_adapter(
    *,
    alpaca_client: TorghutAlpacaClient,
    order_firewall: OrderFirewall,
    session_factory: Callable[[], Session],
    account_label: str,
    endpoint_url: str,
) -> ExecutionAdapter:
    """Build the only runtime adapter allowed by the scheduler."""

    if settings.trading_simulation_enabled:
        return _build_simulation_execution_adapter()
    return AlpacaExecutionAdapter(
        firewall=order_firewall,
        read_client=alpaca_client,
        session_factory=session_factory,
        account_label=account_label,
        endpoint_url=endpoint_url,
    )


def _build_simulation_execution_adapter() -> SimulationExecutionAdapter:
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


__all__ = ["build_execution_adapter"]
