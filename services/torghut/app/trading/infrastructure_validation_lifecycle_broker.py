"""Strict broker-side state machine for the Alpaca paper lifecycle proof."""

from __future__ import annotations

import math
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Protocol

from alpaca.common.exceptions import APIError, RetryException
from requests.exceptions import RequestException
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from ..models import BrokerMutationReceipt, ExecutionOrderEvent
from .alpaca_observations import (
    alpaca_order_references,
    alpaca_position_observation,
)
from .alpaca_reduction_mutations import (
    AlpacaReductionMutationExecutor,
    AlpacaReductionReadClient,
)
from .broker_mutation_coordinator import BrokerMutationCoordinator
from .firewall import OrderFirewall, OrderFirewallBrokerClient
from .infrastructure_validation import (
    InfrastructureValidationLifecyclePlan,
    InfrastructureValidationPermit,
    authorize_infrastructure_validation_order,
    infrastructure_validation_client_order_id,
)
from .infrastructure_validation_records import InfrastructureValidationEvidence


_OPEN_ORDER_STATUSES = frozenset(
    {
        "accepted",
        "accepted_for_bidding",
        "calculated",
        "held",
        "new",
        "open",
        "partially_filled",
        "pending_cancel",
        "pending_new",
        "pending_replace",
    }
)
_TERMINAL_ORDER_STATUSES = frozenset(
    {
        "canceled",
        "cancelled",
        "done_for_day",
        "expired",
        "filled",
        "rejected",
        "replaced",
        "stopped",
        "suspended",
    }
)
_CLEANUP_ERRORS = (
    APIError,
    RetryException,
    RequestException,
    SQLAlchemyError,
    ArithmeticError,
    AttributeError,
    LookupError,
    OSError,
    RuntimeError,
    TypeError,
    ValueError,
)
_MAX_CRYPTO_TAKER_FEE_RATE = Decimal("0.0025")
_MIN_LIFECYCLE_LEG_NOTIONAL_USD = Decimal("12")


class InfrastructureValidationLifecycleClient(
    OrderFirewallBrokerClient,
    AlpacaReductionReadClient,
    Protocol,
):
    endpoint_class: str
    endpoint_url: str

    def get_account(self) -> dict[str, object]: ...

    def get_asset(self, symbol_or_asset_id: str) -> dict[str, object] | None: ...

    def get_order_by_client_order_id_strict(
        self,
        client_order_id: str,
    ) -> dict[str, object] | None: ...

    def get_order_by_id_strict(
        self,
        order_id: str,
    ) -> dict[str, object] | None: ...

    def list_open_orders(self) -> list[dict[str, object]]: ...

    def list_orders(
        self,
        status: str = "all",
        *,
        limit: int | None = None,
    ) -> list[dict[str, object]]: ...

    def list_positions(self) -> list[dict[str, object]]: ...


@dataclass(frozen=True, slots=True)
class InfrastructureValidationLifecycleContext:
    """Runtime dependencies and finite waits for one paper lifecycle."""

    client: InfrastructureValidationLifecycleClient
    session_factory: Callable[[], Session]
    configured_account_label: str
    evaluated_at: datetime | None = None
    order_timeout_seconds: float = 30.0
    # The single order-feed consumer may be finishing one bounded reconciliation
    # cycle when a later lifecycle fill arrives. Keep the broker exposure finite
    # while allowing that already-running cycle plus Kafka poll jitter to finish.
    evidence_timeout_seconds: float = 60.0
    cleanup_timeout_seconds: float = 30.0
    poll_interval_seconds: float = 0.5


@dataclass(frozen=True, slots=True)
class LifecycleOrderExpectation:
    """Broker order shape expected at one lifecycle checkpoint."""

    symbol: str
    side: str
    quantity: Decimal
    order_id: str | None = None
    client_order_id: str | None = None
    price_bound: Decimal | None = None


@dataclass(frozen=True, slots=True)
class _LifecycleAssetConstraints:
    minimum_order_size: Decimal
    quantity_increment: Decimal


class AlpacaPaperLifecycleBroker:
    """Own all broker observations, response checks, waits, and cleanup."""

    def __init__(
        self,
        *,
        context: InfrastructureValidationLifecycleContext,
        account_label: str,
        broker_account_number: str,
        evaluated_at: datetime,
        asset_constraints: _LifecycleAssetConstraints,
        firewall: OrderFirewall,
        coordinator: BrokerMutationCoordinator,
    ) -> None:
        self.context = context
        self.account_label = account_label
        self.broker_account_number = broker_account_number
        self.evaluated_at = evaluated_at
        self.asset_constraints = asset_constraints
        self.firewall = firewall
        self.coordinator = coordinator

    @classmethod
    def prepare(
        cls,
        *,
        permit: InfrastructureValidationPermit,
        plan: InfrastructureValidationLifecyclePlan,
        context: InfrastructureValidationLifecycleContext,
    ) -> "AlpacaPaperLifecycleBroker":
        account_label = context.configured_account_label.strip()
        if not account_label or account_label != permit.account_label:
            raise RuntimeError("infrastructure_validation_configured_account_mismatch")
        evaluated_at = context.evaluated_at or datetime.now(timezone.utc)
        if evaluated_at.tzinfo is None:
            raise ValueError("infrastructure_validation_now_must_be_timezone_aware")
        _validate_context_timeouts(context)
        if context.client.endpoint_class != "paper":
            raise RuntimeError("infrastructure_validation_client_not_paper")
        authorize_infrastructure_validation_order(
            permit,
            plan,
            account_label=account_label,
            broker_base_url=context.client.endpoint_url,
            now=evaluated_at,
        )
        if permit.expires_at <= evaluated_at + timedelta(
            seconds=context.order_timeout_seconds
        ):
            raise ValueError("infrastructure_validation_permit_window_too_short")
        account_number = _validate_broker_account(
            context.client.get_account(),
            permit,
        )
        asset_constraints = _validate_lifecycle_asset(
            context.client.get_asset(plan.symbol),
            plan,
        )
        positions, orders = _known_null_snapshot(context.client)
        if positions or orders:
            raise RuntimeError("infrastructure_validation_account_not_known_null")
        client_order_id = infrastructure_validation_client_order_id(permit, plan)
        with context.session_factory() as session:
            existing = session.scalar(
                select(func.count())
                .select_from(BrokerMutationReceipt)
                .where(BrokerMutationReceipt.client_request_id == client_order_id)
            )
            session.execute(select(ExecutionOrderEvent.position_qty).limit(1)).all()
        if int(existing or 0):
            raise RuntimeError(
                "infrastructure_validation_lifecycle_permit_already_used"
            )
        firewall = OrderFirewall(
            context.client,
            account_label=account_label,
        )
        if firewall.status().kill_switch_enabled:
            raise RuntimeError("infrastructure_validation_kill_switch_enabled")
        return cls(
            context=context,
            account_label=account_label,
            broker_account_number=account_number,
            evaluated_at=evaluated_at,
            asset_constraints=asset_constraints,
            firewall=firewall,
            coordinator=BrokerMutationCoordinator("validation-lifecycle"),
        )

    def reduction_executor(self) -> AlpacaReductionMutationExecutor:
        return AlpacaReductionMutationExecutor(
            firewall=self.firewall,
            read_client=self.context.client,
            session_factory=self.context.session_factory,
            account_label=self.account_label,
            endpoint_url=self.context.client.endpoint_url,
            coordinator=self.coordinator,
        )

    def wait_order_by_client_id(
        self,
        client_order_id: str,
        *,
        terminal: bool,
    ) -> Mapping[str, object]:
        return self._wait_order(
            lookup=lambda: self.context.client.get_order_by_client_order_id_strict(
                client_order_id
            ),
            identity=client_order_id,
            terminal=terminal,
        )

    def wait_order_by_id(
        self,
        order_id: str,
        *,
        terminal: bool,
    ) -> Mapping[str, object]:
        return self._wait_order(
            lookup=lambda: self.context.client.get_order_by_id_strict(order_id),
            identity=order_id,
            terminal=terminal,
        )

    def _wait_order(
        self,
        *,
        lookup: Callable[[], Mapping[str, object] | None],
        identity: str,
        terminal: bool,
    ) -> Mapping[str, object]:
        deadline = time.monotonic() + self.context.order_timeout_seconds
        latest_status = "missing"
        while time.monotonic() < deadline:
            order = lookup()
            latest_status = (
                str((order or {}).get("status") or "missing").strip().lower()
            )
            if order is not None:
                statuses = (
                    _TERMINAL_ORDER_STATUSES if terminal else _OPEN_ORDER_STATUSES
                )
                if latest_status in statuses:
                    return order
            time.sleep(self.context.poll_interval_seconds)
        raise RuntimeError(
            "infrastructure_validation_order_wait_timeout:"
            f"identity={identity}:status={latest_status}"
        )

    def wait_replaced_order(self, order_id: str) -> None:
        order = self.wait_order_by_id(order_id, terminal=True)
        if str(order.get("status") or "").strip().lower() != "replaced":
            raise RuntimeError("infrastructure_validation_original_order_not_replaced")

    def wait_canceled_order(self, order_id: str) -> None:
        order = self.wait_order_by_id(order_id, terminal=True)
        if str(order.get("status") or "").strip().lower() not in {
            "canceled",
            "cancelled",
        }:
            raise RuntimeError("infrastructure_validation_replacement_not_canceled")

    def require_open_zero_fill_order(
        self,
        order: Mapping[str, object],
        expectation: LifecycleOrderExpectation,
    ) -> None:
        _require_order_identity(
            order,
            expected_order_id=expectation.order_id,
            expected_symbol=expectation.symbol,
            expected_side=expectation.side,
        )
        if str(order.get("status") or "").strip().lower() not in _OPEN_ORDER_STATUSES:
            raise RuntimeError("infrastructure_validation_resting_order_not_open")
        if _decimal(order.get("qty"), "order_quantity") != expectation.quantity:
            raise RuntimeError(
                "infrastructure_validation_resting_order_quantity_mismatch"
            )
        if _decimal(order.get("filled_qty") or "0", "filled_quantity") != 0:
            raise RuntimeError("infrastructure_validation_resting_order_filled")
        if (
            expectation.price_bound is None
            or _decimal(order.get("limit_price"), "limit_price")
            != expectation.price_bound
        ):
            raise RuntimeError("infrastructure_validation_resting_order_price_mismatch")
        order_type = (
            str(order.get("type") or order.get("order_type") or "").strip().lower()
        )
        if order_type != "limit":
            raise RuntimeError("infrastructure_validation_resting_order_type_mismatch")
        if str(order.get("time_in_force") or "").strip().lower() != "gtc":
            raise RuntimeError("infrastructure_validation_resting_order_tif_mismatch")

    def require_filled_order(
        self,
        order: Mapping[str, object],
        expectation: LifecycleOrderExpectation,
    ) -> str:
        order_id = _require_order_identity(
            order,
            expected_order_id=expectation.order_id,
            expected_symbol=expectation.symbol,
            expected_side=expectation.side,
        )
        if (
            expectation.client_order_id is not None
            and str(order.get("client_order_id") or "").strip()
            != expectation.client_order_id
        ):
            raise RuntimeError(
                "infrastructure_validation_order_client_identity_mismatch"
            )
        if str(order.get("status") or "").strip().lower() != "filled":
            raise RuntimeError("infrastructure_validation_order_not_filled")
        if _decimal(order.get("qty"), "order_quantity") != expectation.quantity:
            raise RuntimeError(
                "infrastructure_validation_filled_order_quantity_mismatch"
            )
        if _decimal(order.get("filled_qty"), "filled_quantity") != expectation.quantity:
            raise RuntimeError("infrastructure_validation_filled_quantity_mismatch")
        average_fill_price = _positive_decimal(
            order.get("filled_avg_price") or order.get("avg_fill_price"),
            "average_fill_price",
        )
        if (
            expectation.price_bound is not None
            and average_fill_price > expectation.price_bound
        ):
            raise RuntimeError("infrastructure_validation_fill_price_exceeds_limit")
        return order_id

    def wait_entry_position(
        self,
        *,
        plan: InfrastructureValidationLifecyclePlan,
    ) -> Decimal:
        """Return the fee-adjusted position created by the filled buy order."""

        deadline = time.monotonic() + self.context.order_timeout_seconds
        latest = "missing"
        minimum_quantity = (
            plan.qty * (Decimal("1") - _MAX_CRYPTO_TAKER_FEE_RATE)
            - self.asset_constraints.quantity_increment
        )
        while time.monotonic() < deadline:
            raw_positions = self.context.client.list_positions()
            if len(raw_positions) == 1:
                position = alpaca_position_observation(raw_positions[0])
                latest = f"{position.symbol}:{position.signed_quantity}"
                if (
                    position.symbol == plan.symbol
                    and minimum_quantity <= position.signed_quantity <= plan.qty
                ):
                    self._require_entry_reduction_quantities(
                        plan=plan,
                        position_quantity=position.signed_quantity,
                        unit_notional=position.unit_notional,
                    )
                    return position.signed_quantity
            else:
                latest = f"count={len(raw_positions)}"
            time.sleep(self.context.poll_interval_seconds)
        raise RuntimeError(
            f"infrastructure_validation_entry_position_wait_timeout:{latest}"
        )

    def _require_entry_reduction_quantities(
        self,
        *,
        plan: InfrastructureValidationLifecyclePlan,
        position_quantity: Decimal,
        unit_notional: Decimal,
    ) -> None:
        residual_quantity = position_quantity - plan.partial_close_qty
        if residual_quantity <= 0:
            raise RuntimeError(
                "infrastructure_validation_fee_adjusted_residual_not_positive"
            )
        for field, quantity in (
            ("fee_adjusted_entry_quantity", position_quantity),
            ("fee_adjusted_residual_quantity", residual_quantity),
        ):
            if quantity < self.asset_constraints.minimum_order_size:
                raise RuntimeError(
                    f"infrastructure_validation_{field}_below_broker_minimum"
                )
            try:
                _require_increment(
                    quantity,
                    self.asset_constraints.quantity_increment,
                    field,
                )
                _require_numeric_21_9(quantity, field)
            except ValueError as exc:
                raise RuntimeError(str(exc)) from exc
        for field, quantity in (
            ("partial_close", plan.partial_close_qty),
            ("fee_adjusted_residual_close", residual_quantity),
        ):
            if quantity * unit_notional < _MIN_LIFECYCLE_LEG_NOTIONAL_USD:
                raise RuntimeError(
                    "infrastructure_validation_"
                    f"{field}_observed_notional_below_broker_cost_basis_floor"
                )

    def wait_position(self, *, symbol: str, quantity: Decimal) -> None:
        deadline = time.monotonic() + self.context.order_timeout_seconds
        latest = "missing"
        while time.monotonic() < deadline:
            raw_positions = self.context.client.list_positions()
            if len(raw_positions) == 1:
                position = alpaca_position_observation(raw_positions[0])
                latest = f"{position.symbol}:{position.signed_quantity}"
                if position.symbol == symbol and position.signed_quantity == quantity:
                    return
            else:
                latest = f"count={len(raw_positions)}"
            time.sleep(self.context.poll_interval_seconds)
        raise RuntimeError(f"infrastructure_validation_position_wait_timeout:{latest}")

    def wait_no_open_orders(self) -> None:
        deadline = time.monotonic() + self.context.order_timeout_seconds
        latest_count = 0
        while time.monotonic() < deadline:
            orders = self.context.client.list_open_orders()
            latest_count = len(orders)
            if not orders:
                return
            time.sleep(self.context.poll_interval_seconds)
        raise RuntimeError(
            f"infrastructure_validation_open_orders_remain:count={latest_count}"
        )

    def wait_known_null_account(self, timeout_seconds: float) -> None:
        deadline = time.monotonic() + timeout_seconds
        position_count = 0
        order_count = 0
        while time.monotonic() < deadline:
            positions, orders = self.known_null_snapshot()
            position_count = len(positions)
            order_count = len(orders)
            if not positions and not orders:
                return
            time.sleep(self.context.poll_interval_seconds)
        raise RuntimeError(
            "infrastructure_validation_terminal_account_not_null:"
            f"positions={position_count}:open_orders={order_count}"
        )

    def known_null_snapshot(
        self,
    ) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
        return _known_null_snapshot(self.context.client)

    def cleanup(
        self,
        *,
        latest_evidence: InfrastructureValidationEvidence | None,
    ) -> None:
        executor = self.reduction_executor()
        try:
            if self.context.client.list_open_orders():
                executor.cancel_all_orders(purpose="kill_switch")
            if self.context.client.list_positions():
                try:
                    executor.close_all_positions(
                        purpose="flatten",
                        validation_evidence=latest_evidence,
                    )
                except RuntimeError as exc:
                    if not str(exc).startswith("infrastructure_validation_position_"):
                        raise
                    executor.close_all_positions(purpose="flatten")
            self.wait_known_null_account(self.context.cleanup_timeout_seconds)
        except _CLEANUP_ERRORS as exc:
            raise RuntimeError(
                "infrastructure_validation_lifecycle_cleanup_failed:"
                f"{type(exc).__name__}:{exc}"
            ) from exc


def order_id(response: Mapping[str, object]) -> str:
    references = alpaca_order_references(response)
    if len(references) != 1:
        raise RuntimeError("infrastructure_validation_broker_order_identity_missing")
    return references[0]


def single_order_id(response: Sequence[Mapping[str, object]]) -> str:
    references = alpaca_order_references(response)
    if len(response) != 1 or len(references) != 1:
        raise RuntimeError(
            "infrastructure_validation_flatten_response_identity_invalid:"
            f"responses={len(response)}:references={len(references)}"
        )
    return references[0]


def decimal_text(value: Decimal) -> str:
    normalized = value.normalize()
    return format(Decimal("0") if normalized == 0 else normalized, "f")


def _validate_context_timeouts(
    context: InfrastructureValidationLifecycleContext,
) -> None:
    values = (
        context.order_timeout_seconds,
        context.evidence_timeout_seconds,
        context.cleanup_timeout_seconds,
        context.poll_interval_seconds,
    )
    if any(not math.isfinite(value) or value <= 0 for value in values):
        raise ValueError("infrastructure_validation_timeout_must_be_positive")
    if context.poll_interval_seconds > min(values[:3]):
        raise ValueError("infrastructure_validation_poll_interval_exceeds_timeout")


def _validate_broker_account(
    account: Mapping[str, object],
    permit: InfrastructureValidationPermit,
) -> str:
    account_number = str(account.get("account_number") or "").strip()
    if not account_number or account_number != permit.account_label:
        raise RuntimeError("infrastructure_validation_broker_account_mismatch")
    if str(account.get("status") or "").strip().upper() != "ACTIVE":
        raise RuntimeError("infrastructure_validation_broker_account_not_active")
    if any(
        account.get(field) is True
        for field in ("account_blocked", "trading_blocked", "trade_suspended_by_user")
    ):
        raise RuntimeError("infrastructure_validation_broker_account_blocked")
    if str(account.get("crypto_status") or "").strip().upper() != "ACTIVE":
        raise RuntimeError("infrastructure_validation_broker_crypto_not_active")
    return account_number


def _validate_lifecycle_asset(
    asset: Mapping[str, object] | None,
    plan: InfrastructureValidationLifecyclePlan,
) -> _LifecycleAssetConstraints:
    if not asset or not bool(asset.get("tradable")):
        raise RuntimeError("infrastructure_validation_asset_not_tradable")
    if str(asset.get("asset_class") or "").strip().lower() != "crypto":
        raise RuntimeError("infrastructure_validation_broker_asset_class_mismatch")
    if str(asset.get("status") or "").strip().lower() != "active":
        raise RuntimeError("infrastructure_validation_asset_not_active")
    minimum_order_size = _positive_decimal(
        asset.get("min_order_size"),
        "asset_min_order_size",
    )
    quantity_increment = _positive_decimal(
        asset.get("min_trade_increment"),
        "asset_min_trade_increment",
    )
    price_increment = _positive_decimal(
        asset.get("price_increment"),
        "asset_price_increment",
    )
    residual_quantity = plan.qty - plan.partial_close_qty
    for field, quantity in (
        ("entry_quantity", plan.qty),
        ("partial_close_quantity", plan.partial_close_qty),
        ("residual_quantity", residual_quantity),
    ):
        if quantity < minimum_order_size:
            raise ValueError(f"infrastructure_validation_{field}_below_broker_minimum")
        _require_increment(quantity, quantity_increment, field)
        _require_numeric_21_9(quantity, field)
    for field, price in (
        ("entry_limit_price", plan.limit_price),
        ("resting_close_limit_price", plan.resting_close_limit_price),
        ("replacement_close_limit_price", plan.replacement_close_limit_price),
    ):
        _require_increment(price, price_increment, field)
        _require_numeric_20_8(price, field)
    return _LifecycleAssetConstraints(
        minimum_order_size=minimum_order_size,
        quantity_increment=quantity_increment,
    )


def _require_increment(value: Decimal, increment: Decimal, field: str) -> None:
    quotient = value / increment
    if quotient != quotient.to_integral_value():
        raise ValueError(f"infrastructure_validation_{field}_increment_invalid")


def _require_numeric_21_9(value: Decimal, field: str) -> None:
    _require_numeric_precision(value, field=field, integer_digits=12, scale=9)


def _require_numeric_20_8(value: Decimal, field: str) -> None:
    _require_numeric_precision(value, field=field, integer_digits=12, scale=8)


def _require_numeric_precision(
    value: Decimal,
    *,
    field: str,
    integer_digits: int,
    scale: int,
) -> None:
    normalized = value.copy_abs().normalize()
    exponent = normalized.as_tuple().exponent
    if not isinstance(exponent, int):  # finite values are guaranteed by the plan
        raise ValueError(
            f"infrastructure_validation_{field}_database_precision_invalid"
        )
    fractional_digits = max(0, -exponent)
    observed_integer_digits = max(1, normalized.adjusted() + 1)
    if fractional_digits > scale or observed_integer_digits > integer_digits:
        raise ValueError(
            f"infrastructure_validation_{field}_database_precision_invalid"
        )


def _require_order_identity(
    order: Mapping[str, object],
    *,
    expected_order_id: str | None,
    expected_symbol: str,
    expected_side: str,
) -> str:
    observed_order_id = order_id(order)
    if expected_order_id is not None and observed_order_id != expected_order_id:
        raise RuntimeError("infrastructure_validation_order_identity_mismatch")
    if str(order.get("symbol") or "").strip().upper() != expected_symbol:
        raise RuntimeError("infrastructure_validation_order_symbol_mismatch")
    if str(order.get("side") or "").strip().lower() != expected_side:
        raise RuntimeError("infrastructure_validation_order_side_mismatch")
    return observed_order_id


def _known_null_snapshot(
    client: InfrastructureValidationLifecycleClient,
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    return client.list_positions(), client.list_open_orders()


def _decimal(value: object, field: str) -> Decimal:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise RuntimeError(f"infrastructure_validation_{field}_invalid") from exc
    if not parsed.is_finite():
        raise RuntimeError(f"infrastructure_validation_{field}_invalid")
    return parsed


def _positive_decimal(value: object, field: str) -> Decimal:
    parsed = _decimal(value, field)
    if parsed <= 0:
        raise RuntimeError(f"infrastructure_validation_{field}_invalid")
    return parsed


__all__ = [
    "AlpacaPaperLifecycleBroker",
    "InfrastructureValidationLifecycleContext",
    "decimal_text",
    "order_id",
    "single_order_id",
]
