"""Order firewall enforcing deterministic kill switch behavior."""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Protocol

from alpaca.common.exceptions import APIError, RetryException
from requests.exceptions import RequestException

from ..alpaca_client import (
    AlpacaSubmitRequest,
    OrderFirewallToken,
    build_alpaca_order_request,
)
from ..config import settings
from .broker_mutation_receipts import (
    BrokerMutationBrokerIoError,
    BrokerMutationIoPermit,
    BrokerMutationIoPermitExpectation,
    consume_broker_mutation_io_permit,
    fingerprint_broker_endpoint,
)
from .infrastructure_validation import (
    InfrastructureValidationOrderPlan,
    InfrastructureValidationPermit,
    authorize_infrastructure_validation_order,
    infrastructure_validation_client_order_id,
    infrastructure_validation_request_payload,
)

logger = logging.getLogger(__name__)

_ALPACA_MUTATION_ERRORS = (
    APIError,
    RetryException,
    RequestException,
    ArithmeticError,
    AttributeError,
    LookupError,
    OSError,
    RuntimeError,
    TypeError,
    ValueError,
)


class OrderFirewallBlocked(RuntimeError):
    """Raised when the order firewall blocks submission."""


class OrderFirewallRiskReductionBlocked(RuntimeError):
    """Raised when broker-observed position state cannot prove a reduction."""


@dataclass(frozen=True)
class OrderFirewallStatus:
    kill_switch_enabled: bool
    reason: str


def alpaca_submit_request_payload(request: AlpacaSubmitRequest) -> dict[str, object]:
    """Build the one canonical payload used by claims and Alpaca I/O."""

    normalized_qty = _positive_decimal(request.qty)
    normalized_limit = (
        _finite_decimal(request.limit_price)
        if request.limit_price is not None
        else None
    )
    normalized_stop = (
        _finite_decimal(request.stop_price) if request.stop_price is not None else None
    )
    if normalized_qty is None:
        raise ValueError("alpaca_submit_qty_invalid")
    if request.limit_price is not None and normalized_limit is None:
        raise ValueError("alpaca_submit_limit_price_invalid")
    if request.stop_price is not None and normalized_stop is None:
        raise ValueError("alpaca_submit_stop_price_invalid")
    normalized_symbol = str(request.symbol).strip().upper()
    normalized_side = str(request.side).strip().lower()
    normalized_order_type = str(request.order_type).strip().lower()
    normalized_time_in_force = str(request.time_in_force).strip().lower()
    if not all(
        (
            normalized_symbol,
            normalized_side,
            normalized_order_type,
            normalized_time_in_force,
        )
    ):
        raise ValueError("alpaca_submit_request_text_invalid")
    normalized_extra_params = dict(request.extra_params or {})
    build_alpaca_order_request(
        AlpacaSubmitRequest(
            symbol=normalized_symbol,
            side=normalized_side,
            qty=normalized_qty,
            order_type=normalized_order_type,
            time_in_force=normalized_time_in_force,
            limit_price=normalized_limit,
            stop_price=normalized_stop,
            extra_params=normalized_extra_params,
        )
    )
    return {
        "symbol": normalized_symbol,
        "side": normalized_side,
        "qty": normalized_qty,
        "order_type": normalized_order_type,
        "time_in_force": normalized_time_in_force,
        "limit_price": normalized_limit,
        "stop_price": normalized_stop,
        "extra_params": normalized_extra_params,
    }


class OrderFirewallBrokerClient(Protocol):
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

    def __init__(
        self,
        client: OrderFirewallBrokerClient,
        *,
        account_label: str | None = None,
    ) -> None:
        self._client = client
        self._token = OrderFirewallToken()
        self._account_label = str(
            account_label or settings.trading_account_label
        ).strip()
        if not self._account_label:
            raise ValueError("order_firewall_account_label_required")

    def status(self) -> OrderFirewallStatus:
        if settings.trading_kill_switch_enabled:
            return OrderFirewallStatus(
                kill_switch_enabled=True, reason="kill_switch_enabled"
            )
        return OrderFirewallStatus(kill_switch_enabled=False, reason="ok")

    @property
    def broker_endpoint_url(self) -> str:
        configured = getattr(self._client, "endpoint_url", None)
        if isinstance(configured, str) and configured.strip():
            return configured.strip()
        if settings.apca_api_base_url:
            return str(settings.apca_api_base_url)
        return (
            "https://api.alpaca.markets"
            if settings.trading_mode == "live"
            else "https://paper-api.alpaca.markets"
        )

    @property
    def account_label(self) -> str:
        return self._account_label

    def require_account_label(self, account_label: str) -> None:
        requested_account = account_label.strip()
        if requested_account and self.account_label == requested_account:
            return
        raise RuntimeError(
            json.dumps(
                {
                    "source": "local_pre_submit",
                    "code": "order_firewall_account_label_mismatch",
                    "requested_account_label": requested_account,
                    "firewall_account_label": self.account_label,
                },
                sort_keys=True,
            )
        )

    def cancel_open_orders_if_kill_switch(self) -> bool:
        status = self.status()
        if not status.kill_switch_enabled:
            return False
        try:
            cancelled = self._client.cancel_all_orders(firewall_token=self._token)
            logger.warning(
                "Kill switch enabled; canceled %s open orders", len(cancelled)
            )
        except _ALPACA_MUTATION_ERRORS:
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
        *,
        mutation_permit: BrokerMutationIoPermit,
    ) -> dict[str, Any]:
        request = AlpacaSubmitRequest(
            symbol=symbol,
            side=side,
            qty=qty,
            order_type=order_type,
            time_in_force=time_in_force,
            limit_price=limit_price,
            stop_price=stop_price,
            extra_params=extra_params,
        )
        request_payload = alpaca_submit_request_payload(request)
        status = self.status()
        if status.kill_switch_enabled:
            raise OrderFirewallBlocked(status.reason)
        consume_broker_mutation_io_permit(
            mutation_permit,
            expectation=BrokerMutationIoPermitExpectation(
                broker_route="alpaca",
                operation="submit_order",
                account_label=self.account_label,
                endpoint_fingerprint=fingerprint_broker_endpoint(
                    self.broker_endpoint_url
                ),
                request_payload=request_payload,
            ),
        )
        return self._submit_payload(request_payload, request.extra_params)

    def submit_verified_risk_reducing_order(
        self,
        request: AlpacaSubmitRequest,
        *,
        mutation_permit: BrokerMutationIoPermit,
    ) -> dict[str, Any]:
        """Submit only an observed reduction under a durable mutation permit."""

        normalized_symbol = str(request.symbol).strip().upper()
        normalized_side = str(request.side).strip().lower()
        requested_qty = _positive_decimal(request.qty)
        positions = self._client.list_positions()
        matching = [
            position
            for position in positions or []
            if str(position.get("symbol") or "").strip().upper() == normalized_symbol
        ]
        if len(matching) != 1:
            raise OrderFirewallRiskReductionBlocked(
                "risk_reduction_position_not_uniquely_observed"
            )
        position = matching[0]
        observed_qty = _position_signed_qty(position)
        expected_side = "buy" if observed_qty < 0 else "sell"
        if (
            requested_qty is None
            or observed_qty == 0
            or normalized_side != expected_side
            or requested_qty > abs(observed_qty)
        ):
            raise OrderFirewallRiskReductionBlocked(
                "risk_reduction_would_not_strictly_reduce_position"
            )
        normalized_request = AlpacaSubmitRequest(
            symbol=normalized_symbol,
            side=normalized_side,
            qty=requested_qty,
            order_type=request.order_type,
            time_in_force=request.time_in_force,
            limit_price=request.limit_price,
            stop_price=request.stop_price,
            extra_params=request.extra_params,
        )
        request_payload = alpaca_submit_request_payload(normalized_request)
        consume_broker_mutation_io_permit(
            mutation_permit,
            expectation=BrokerMutationIoPermitExpectation(
                broker_route="alpaca",
                operation="submit_order",
                risk_class="risk_reducing",
                account_label=self.account_label,
                endpoint_fingerprint=fingerprint_broker_endpoint(
                    self.broker_endpoint_url
                ),
                request_payload=request_payload,
            ),
        )
        return self._submit_payload(request_payload, normalized_request.extra_params)

    def submit_verified_infrastructure_validation_order(
        self,
        permit: InfrastructureValidationPermit,
        plan: InfrastructureValidationOrderPlan,
        *,
        mutation_permit: BrokerMutationIoPermit,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        """Submit one exact paper IOC whose evidence can never promote capital."""

        evaluated_at = now or datetime.now(timezone.utc)
        authorize_infrastructure_validation_order(
            permit,
            plan,
            account_label=self.account_label,
            account_mode="paper",
            broker_base_url=self.broker_endpoint_url,
            now=evaluated_at,
        )
        client_order_id = infrastructure_validation_client_order_id(permit, plan)
        request = AlpacaSubmitRequest(
            symbol=plan.symbol,
            side=plan.side,
            qty=plan.qty,
            order_type=plan.order_type,
            time_in_force=plan.time_in_force,
            limit_price=plan.limit_price,
            stop_price=None,
            extra_params={"client_order_id": client_order_id},
        )
        broker_request = alpaca_submit_request_payload(request)
        status = self.status()
        if status.kill_switch_enabled:
            raise OrderFirewallBlocked(status.reason)
        consume_broker_mutation_io_permit(
            mutation_permit,
            expectation=BrokerMutationIoPermitExpectation(
                broker_route="alpaca",
                operation="submit_order",
                risk_class="risk_neutral",
                account_label=self.account_label,
                endpoint_fingerprint=fingerprint_broker_endpoint(
                    self.broker_endpoint_url
                ),
                request_payload=infrastructure_validation_request_payload(
                    permit,
                    plan,
                ),
            ),
        )
        return self._submit_payload(broker_request, request.extra_params)

    def _submit_payload(
        self,
        request_payload: Mapping[str, object],
        extra_params: Mapping[str, object] | None,
    ) -> dict[str, Any]:
        try:
            return self._client.submit_order(
                symbol=str(request_payload["symbol"]),
                side=str(request_payload["side"]),
                qty=float(str(request_payload["qty"])),
                order_type=str(request_payload["order_type"]),
                time_in_force=str(request_payload["time_in_force"]),
                limit_price=(
                    float(str(request_payload["limit_price"]))
                    if request_payload["limit_price"] is not None
                    else None
                ),
                stop_price=(
                    float(str(request_payload["stop_price"]))
                    if request_payload["stop_price"] is not None
                    else None
                ),
                extra_params=dict(extra_params or {}),
                firewall_token=self._token,
            )
        except _ALPACA_MUTATION_ERRORS as exc:
            raise BrokerMutationBrokerIoError(
                f"alpaca_broker_io_failed:{type(exc).__name__}"
            ) from exc

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


def _positive_decimal(value: object) -> Decimal | None:
    parsed = _finite_decimal(value)
    return parsed if parsed is not None and parsed > 0 else None


def _finite_decimal(value: object) -> Decimal | None:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return parsed if parsed.is_finite() else None


def _position_signed_qty(position: dict[str, Any]) -> Decimal:
    qty = _finite_decimal(position.get("qty") or position.get("quantity"))
    if qty is None or qty == 0:
        raise OrderFirewallRiskReductionBlocked("risk_reduction_position_qty_invalid")
    side = str(position.get("side") or "").strip().lower()
    return -abs(qty) if side == "short" else qty
