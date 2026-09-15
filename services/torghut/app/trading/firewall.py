"""Order firewall enforcing deterministic kill switch behavior."""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import NoReturn, Protocol, TypeVar, cast

from alpaca.common.exceptions import APIError, RetryException
from requests.exceptions import RequestException

from ..alpaca_client import (
    AlpacaSubmitRequest,
    OrderFirewallToken,
    build_alpaca_order_request,
    issue_order_firewall_token,
)
from ..config import settings
from .alpaca_observations import (
    alpaca_order_observation,
    alpaca_position_observation,
)
from .broker_mutation_receipts import (
    BrokerMutationBrokerIoError,
    BrokerMutationExplicitRejection,
    BrokerMutationIoPermit,
    BrokerMutationIoPermitExpectation,
    consume_broker_mutation_io_permit,
    fingerprint_broker_endpoint,
)
from .infrastructure_validation import (
    InfrastructureValidationPermit,
    InfrastructureValidationSubmitPlan,
    authorize_infrastructure_validation_order,
    infrastructure_validation_client_order_id,
    infrastructure_validation_request_payload,
)
from .risk_reduction_mutation_authority import (
    RiskReductionMutationAuthority,
    RiskReductionMutationExpectation,
    consume_risk_reduction_mutation_authority,
    validate_risk_reduction_mutation_authority,
)
from .risk_reduction import (
    BrokerReductionSnapshot,
    RiskReductionPermitError,
)
from .risk_reduction_boundary import validate_submit_close_order_boundary

logger = logging.getLogger(__name__)
_MutationResult = TypeVar("_MutationResult")

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
_EXPLICIT_ALPACA_REJECTION_STATUSES = frozenset({400, 401, 403, 404, 422})
_RISK_REDUCTION_OPEN_ORDER_LIMIT = 500


def _raise_alpaca_mutation_error(exc: Exception) -> NoReturn:
    if isinstance(exc, BrokerMutationExplicitRejection):
        raise exc
    if isinstance(exc, APIError):
        rejection = _explicit_alpaca_rejection(exc)
        if rejection is not None:
            raise rejection from exc
    raise BrokerMutationBrokerIoError(
        f"alpaca_broker_io_failed:{type(exc).__name__}"
    ) from exc


def _explicit_alpaca_rejection(
    exc: APIError,
) -> BrokerMutationExplicitRejection | None:
    status_code: object = getattr(exc, "status_code", None)
    if type(status_code) is not int:
        return None
    normalized_status = status_code
    if normalized_status not in _EXPLICIT_ALPACA_REJECTION_STATUSES:
        return None
    try:
        raw_payload: object = json.loads(str(exc))
    except (TypeError, ValueError):
        raw_payload = {}
    payload: Mapping[object, object]
    if isinstance(raw_payload, Mapping):
        payload = cast(Mapping[object, object], raw_payload)
    else:
        payload = {}
    return BrokerMutationExplicitRejection(
        broker_status=f"http_{normalized_status}",
        rejection_code=_stable_alpaca_rejection_code(
            payload.get("code"),
            status_code=normalized_status,
        ),
        detail=str(payload.get("message") or "broker_request_rejected"),
    )


def _stable_alpaca_rejection_code(value: object, *, status_code: int) -> str:
    allowed = frozenset("abcdefghijklmnopqrstuvwxyz0123456789_.:-")
    raw = str(value or "").strip().lower()
    normalized = "".join(
        character if character in allowed else "_" for character in raw
    )
    normalized = normalized.strip("_")[:128]
    if not normalized or normalized[0] not in "abcdefghijklmnopqrstuvwxyz0123456789":
        return f"http_{status_code}"
    return normalized


class OrderFirewallBlocked(RuntimeError):
    """Raised when the order firewall blocks submission."""


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
        extra_params: dict[str, object] | None = None,
        firewall_token: OrderFirewallToken,
    ) -> dict[str, object]: ...

    def cancel_order(
        self, alpaca_order_id: str, *, firewall_token: OrderFirewallToken
    ) -> bool: ...

    def cancel_all_orders(
        self, *, firewall_token: OrderFirewallToken
    ) -> list[dict[str, object]]: ...

    def replace_order(
        self,
        alpaca_order_id: str,
        *,
        limit_price: float,
        firewall_token: OrderFirewallToken,
    ) -> dict[str, object]: ...

    def close_position(
        self,
        symbol_or_asset_id: str,
        *,
        qty: Decimal,
        firewall_token: OrderFirewallToken,
    ) -> dict[str, object]: ...

    def close_all_positions(
        self, *, firewall_token: OrderFirewallToken
    ) -> list[dict[str, object]]: ...

    def get_order_by_client_order_id(
        self, client_order_id: str
    ) -> dict[str, object] | None: ...

    def get_order(self, alpaca_order_id: str) -> dict[str, object]: ...

    def list_orders(
        self,
        status: str = "all",
        *,
        limit: int | None = None,
    ) -> list[dict[str, object]]: ...

    def list_positions(self) -> list[dict[str, object]] | None: ...

    def get_account(self) -> dict[str, object] | None: ...

    def get_asset(self, symbol_or_asset_id: str) -> dict[str, object] | None: ...


class OrderFirewall:
    """Single audited gateway for every Alpaca broker mutation."""

    def __init__(
        self,
        client: OrderFirewallBrokerClient,
        *,
        account_label: str | None = None,
    ) -> None:
        self._client = client
        self._token = issue_order_firewall_token()
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

    def submit_order(
        self,
        symbol: str,
        side: str,
        qty: float,
        order_type: str,
        time_in_force: str,
        limit_price: float | None = None,
        stop_price: float | None = None,
        extra_params: dict[str, object] | None = None,
        *,
        mutation_permit: BrokerMutationIoPermit,
    ) -> dict[str, object]:
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

    def cancel_order(
        self,
        alpaca_order_id: str,
        *,
        authority: RiskReductionMutationAuthority,
    ) -> bool:
        request_payload = authority.request_payload
        if str(request_payload.get("order_id") or "").strip() != alpaca_order_id:
            raise ValueError("alpaca_cancel_order_request_mismatch")
        consume_risk_reduction_mutation_authority(
            authority,
            RiskReductionMutationExpectation(
                broker_route="alpaca",
                account_label=self.account_label,
                endpoint_fingerprint=fingerprint_broker_endpoint(
                    self.broker_endpoint_url
                ),
                operation="cancel_order",
                risk_class="risk_neutral",
                target_key=alpaca_order_id,
            ),
        )
        return self._broker_call(
            lambda: self._client.cancel_order(
                alpaca_order_id,
                firewall_token=self._token,
            )
        )

    def submit_risk_reducing_order(
        self,
        request: AlpacaSubmitRequest,
        *,
        authority: RiskReductionMutationAuthority,
    ) -> dict[str, object]:
        """Submit a broker-observed close order even while entries are blocked."""

        broker_request = alpaca_submit_request_payload(request)
        _require_submit_request_match(authority.request_payload, broker_request)
        normalized_symbol = str(broker_request["symbol"])
        expectation = RiskReductionMutationExpectation(
            broker_route="alpaca",
            account_label=self.account_label,
            endpoint_fingerprint=fingerprint_broker_endpoint(self.broker_endpoint_url),
            operation="submit_order",
            risk_class="risk_reducing",
            target_key=normalized_symbol,
        )
        validate_risk_reduction_mutation_authority(authority, expectation)
        reduction_evidence = authority.request_payload.get("risk_reduction")
        if not isinstance(reduction_evidence, Mapping):
            raise RiskReductionPermitError("risk_reduction_evidence_required")
        validate_submit_close_order_boundary(
            cast(Mapping[str, object], reduction_evidence),
            self._current_risk_reduction_snapshot(),
            target_key=normalized_symbol,
        )
        consume_risk_reduction_mutation_authority(
            authority,
            expectation,
        )
        return self._submit_payload(broker_request, request.extra_params)

    def _current_risk_reduction_snapshot(self) -> BrokerReductionSnapshot:
        raw_positions = self._client.list_positions()
        if raw_positions is None:
            raise RiskReductionPermitError("alpaca_positions_unavailable")
        raw_orders = self._client.list_orders(
            status="open",
            limit=_RISK_REDUCTION_OPEN_ORDER_LIMIT,
        )
        return BrokerReductionSnapshot(
            broker_route="alpaca",
            account_label=self.account_label,
            endpoint_fingerprint=fingerprint_broker_endpoint(self.broker_endpoint_url),
            observed_at=datetime.now(timezone.utc),
            complete=len(raw_orders) < _RISK_REDUCTION_OPEN_ORDER_LIMIT,
            orders=tuple(alpaca_order_observation(order) for order in raw_orders),
            positions=tuple(
                alpaca_position_observation(position) for position in raw_positions
            ),
        )

    def cancel_all_orders(
        self,
        *,
        authority: RiskReductionMutationAuthority,
    ) -> list[dict[str, object]]:
        consume_risk_reduction_mutation_authority(
            authority,
            RiskReductionMutationExpectation(
                broker_route="alpaca",
                account_label=self.account_label,
                endpoint_fingerprint=fingerprint_broker_endpoint(
                    self.broker_endpoint_url
                ),
                operation="cancel_all_orders",
                risk_class="risk_neutral",
                target_key=self.account_label,
            ),
        )
        return self._broker_call(
            lambda: self._client.cancel_all_orders(firewall_token=self._token)
        )

    def replace_order(
        self,
        alpaca_order_id: str,
        *,
        limit_price: Decimal,
        authority: RiskReductionMutationAuthority,
    ) -> dict[str, object]:
        request_payload = authority.request_payload
        payload_limit_price = _finite_decimal(request_payload.get("limit_price"))
        normalized_limit_price = _finite_decimal(limit_price)
        if str(request_payload.get("order_id") or "").strip() != alpaca_order_id or (
            payload_limit_price is None
            or normalized_limit_price is None
            or payload_limit_price != normalized_limit_price
        ):
            raise ValueError("alpaca_replace_order_request_mismatch")
        consume_risk_reduction_mutation_authority(
            authority,
            RiskReductionMutationExpectation(
                broker_route="alpaca",
                account_label=self.account_label,
                endpoint_fingerprint=fingerprint_broker_endpoint(
                    self.broker_endpoint_url
                ),
                operation="replace_order",
                risk_class="risk_neutral",
                target_key=alpaca_order_id,
            ),
        )
        return self._broker_call(
            lambda: self._client.replace_order(
                alpaca_order_id,
                limit_price=float(limit_price),
                firewall_token=self._token,
            )
        )

    def close_position(
        self,
        symbol: str,
        quantity: Decimal,
        *,
        broker_symbol: str | None = None,
        authority: RiskReductionMutationAuthority,
    ) -> dict[str, object]:
        request_payload = authority.request_payload
        normalized_symbol = symbol.strip().upper()
        normalized_broker_symbol = str(broker_symbol or normalized_symbol).strip()
        payload_quantity = _positive_decimal(request_payload.get("quantity"))
        normalized_quantity = _positive_decimal(quantity)
        if (
            str(request_payload.get("symbol") or "").strip().upper()
            != normalized_symbol
            or str(request_payload.get("broker_symbol") or normalized_symbol).strip()
            != normalized_broker_symbol
            or not normalized_broker_symbol
            or (
                payload_quantity is None
                or normalized_quantity is None
                or payload_quantity != normalized_quantity
            )
        ):
            raise ValueError("alpaca_close_position_request_mismatch")
        consume_risk_reduction_mutation_authority(
            authority,
            RiskReductionMutationExpectation(
                broker_route="alpaca",
                account_label=self.account_label,
                endpoint_fingerprint=fingerprint_broker_endpoint(
                    self.broker_endpoint_url
                ),
                operation="close_position",
                risk_class="risk_reducing",
                target_key=normalized_symbol,
            ),
        )
        return self._broker_call(
            lambda: self._client.close_position(
                normalized_broker_symbol,
                qty=quantity,
                firewall_token=self._token,
            )
        )

    def close_all_positions(
        self,
        *,
        authority: RiskReductionMutationAuthority,
    ) -> list[dict[str, object]]:
        consume_risk_reduction_mutation_authority(
            authority,
            RiskReductionMutationExpectation(
                broker_route="alpaca",
                account_label=self.account_label,
                endpoint_fingerprint=fingerprint_broker_endpoint(
                    self.broker_endpoint_url
                ),
                operation="close_all_positions",
                risk_class="risk_reducing",
                target_key=self.account_label,
            ),
        )
        return self._broker_call(
            lambda: self._client.close_all_positions(firewall_token=self._token)
        )

    def submit_verified_infrastructure_validation_order(
        self,
        permit: InfrastructureValidationPermit,
        plan: InfrastructureValidationSubmitPlan,
        *,
        mutation_permit: BrokerMutationIoPermit,
        now: datetime | None = None,
    ) -> dict[str, object]:
        """Submit one exact paper IOC whose evidence can never promote capital."""

        evaluated_at = now or datetime.now(timezone.utc)
        authorize_infrastructure_validation_order(
            permit,
            plan,
            account_label=self.account_label,
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
    ) -> dict[str, object]:
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
            _raise_alpaca_mutation_error(exc)

    @staticmethod
    def _broker_call(callback: Callable[[], _MutationResult]) -> _MutationResult:
        try:
            return callback()
        except _ALPACA_MUTATION_ERRORS as exc:
            raise BrokerMutationBrokerIoError(
                f"alpaca_broker_io_failed:{type(exc).__name__}"
            ) from exc

    def get_order_by_client_order_id(
        self, client_order_id: str
    ) -> dict[str, object] | None:
        # Reads are always allowed; this is used for idempotency backfills.
        return self._client.get_order_by_client_order_id(client_order_id)

    def get_order(self, alpaca_order_id: str) -> dict[str, object]:
        return self._client.get_order(alpaca_order_id)

    def list_orders(
        self,
        status: str = "all",
        *,
        limit: int | None = None,
    ) -> list[dict[str, object]]:
        if limit is None:
            return self._client.list_orders(status=status)
        return self._client.list_orders(status=status, limit=limit)

    def list_positions(self) -> list[dict[str, object]] | None:
        return self._client.list_positions()

    def get_account(self) -> dict[str, object] | None:
        return self._client.get_account()

    def get_asset(self, symbol_or_asset_id: str) -> dict[str, object] | None:
        return self._client.get_asset(symbol_or_asset_id)


def _positive_decimal(value: object) -> Decimal | None:
    parsed = _finite_decimal(value)
    return parsed if parsed is not None and parsed > 0 else None


def _require_submit_request_match(
    request_payload: Mapping[str, object],
    broker_request: Mapping[str, object],
) -> None:
    for key in ("symbol", "side", "order_type", "time_in_force"):
        if (
            str(request_payload.get(key) or "").strip().lower()
            != str(broker_request.get(key) or "").strip().lower()
        ):
            raise ValueError("alpaca_risk_reducing_submit_request_mismatch")
    if _positive_decimal(request_payload.get("qty")) != _positive_decimal(
        broker_request.get("qty")
    ):
        raise ValueError("alpaca_risk_reducing_submit_request_mismatch")
    for key in ("limit_price", "stop_price"):
        if _finite_decimal(request_payload.get(key)) != _finite_decimal(
            broker_request.get(key)
        ):
            raise ValueError("alpaca_risk_reducing_submit_request_mismatch")
    raw_extra = request_payload.get("extra_params")
    raw_broker_extra = broker_request.get("extra_params")
    if not isinstance(raw_extra, Mapping) or not isinstance(raw_broker_extra, Mapping):
        raise ValueError("alpaca_risk_reducing_submit_request_mismatch")
    normalized_extra = {
        str(key): value
        for key, value in cast(Mapping[object, object], raw_extra).items()
    }
    normalized_broker_extra = {
        str(key): value
        for key, value in cast(Mapping[object, object], raw_broker_extra).items()
    }
    if normalized_extra != normalized_broker_extra:
        raise ValueError("alpaca_risk_reducing_submit_request_mismatch")


def _finite_decimal(value: object) -> Decimal | None:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return parsed if parsed.is_finite() else None
