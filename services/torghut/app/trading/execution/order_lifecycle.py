"""Bounded live lifecycle for marketable limit orders."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from decimal import Decimal, ROUND_DOWN, ROUND_UP
from typing import Protocol, cast

from alpaca.common.exceptions import APIError

from ..models import ExecutionRequest


class OrderLifecycleSafetyError(RuntimeError):
    """Raised when an active order cannot be observed or canceled safely."""


_TERMINAL_ORDER_STATUSES = {"canceled", "expired", "filled", "rejected"}
_RETRYABLE_TERMINAL_ORDER_STATUSES = {"canceled", "expired"}

# Previous live manifests permitted these broker idempotency-key attempts. Keep
# the read-only recovery boundary stable when new submission attempts are reduced.
HISTORICAL_LIVE_ORDER_ATTEMPT_SCAN_LIMIT = 3


def live_order_recovery_scan_limit(configured_attempts: int) -> int:
    """Include historical broker ids without authorizing new attempts."""

    return max(configured_attempts, HISTORICAL_LIVE_ORDER_ATTEMPT_SCAN_LIMIT)


class OrderLifecycleClient(Protocol):
    """Broker mutations and reads needed by bounded repricing."""

    def get_order(self, order_id: str) -> object: ...

    def cancel_order(self, order_id: str) -> object: ...

    def cancel_all_orders(self) -> object: ...


@dataclass(frozen=True)
class OrderLifecycleResult:
    final_order: dict[str, object]
    prior_orders: tuple[dict[str, object], ...]
    attempts: int
    exhausted: bool


@dataclass(frozen=True)
class OrderLifecycleIO:
    """Broker operations and clock used by one order lifecycle."""

    execution_client: OrderLifecycleClient
    submit: Callable[[ExecutionRequest, dict[str, object]], Mapping[str, object]]
    sleep: Callable[[float], None]


@dataclass(frozen=True)
class OrderLifecyclePolicy:
    """Bounded timing and slippage policy for one order lifecycle."""

    reprice_seconds: float
    max_attempts: int
    slippage_bps: Decimal

    @property
    def attempts(self) -> int:
        return max(1, self.max_attempts)


def _empty_order_payloads() -> list[dict[str, object]]:
    return []


@dataclass
class _LifecycleRun:
    request: ExecutionRequest
    extra_params: Mapping[str, object]
    policy: OrderLifecyclePolicy
    remaining_qty: Decimal
    prior_orders: list[dict[str, object]] = field(default_factory=_empty_order_payloads)

    @classmethod
    def start(
        cls,
        *,
        request: ExecutionRequest,
        extra_params: Mapping[str, object],
        policy: OrderLifecyclePolicy,
    ) -> _LifecycleRun:
        return cls(
            request=request,
            extra_params=extra_params,
            policy=policy,
            remaining_qty=request.qty,
        )

    def attempt_request(self, attempt: int) -> ExecutionRequest:
        initial_limit = self.request.limit_price
        if initial_limit is None:
            raise OrderLifecycleSafetyError("order_lifecycle_limit_missing")
        return self.request.model_copy(
            update={
                "qty": self.remaining_qty,
                "limit_price": _attempt_limit(
                    side=self.request.side,
                    initial_limit=initial_limit,
                    attempt=attempt,
                    max_attempts=self.policy.attempts,
                    slippage_bps=self.policy.slippage_bps,
                ),
            }
        )

    def attempt_params(self, attempt: int) -> dict[str, object]:
        params = dict(self.extra_params)
        params["client_order_id"] = _attempt_client_order_id(
            self.request.client_order_id,
            attempt,
        )
        return params

    def record_fill(
        self,
        order: Mapping[str, object],
        *,
        attempt_qty: Decimal,
        already_recorded: Decimal,
    ) -> Decimal:
        total_fill = min(
            attempt_qty,
            _nonnegative_decimal(order.get("filled_qty")),
        )
        incremental_fill = max(Decimal("0"), total_fill - already_recorded)
        self.remaining_qty = max(Decimal("0"), self.remaining_qty - incremental_fill)
        return total_fill


@dataclass(frozen=True)
class _AttemptResolution:
    result: OrderLifecycleResult | None = None
    retry: bool = False


def submit_with_bounded_repricing(
    *,
    io: OrderLifecycleIO,
    request: ExecutionRequest,
    extra_params: Mapping[str, object],
    policy: OrderLifecyclePolicy,
) -> OrderLifecycleResult:
    if request.order_type != "limit" or request.limit_price is None:
        order = _submit_mapping(io.submit, request, dict(extra_params))
        return OrderLifecycleResult(order, (), 1, False)

    run = _LifecycleRun.start(
        request=request,
        extra_params=extra_params,
        policy=policy,
    )
    for attempt in range(1, policy.attempts + 1):
        resolution = _run_attempt(io=io, run=run, attempt=attempt)
        if resolution.result is not None:
            return resolution.result
        if not resolution.retry:
            raise OrderLifecycleSafetyError("order_lifecycle_attempt_unresolved")
    raise OrderLifecycleSafetyError("order_lifecycle_attempts_exhausted_without_result")


def _run_attempt(
    *,
    io: OrderLifecycleIO,
    run: _LifecycleRun,
    attempt: int,
) -> _AttemptResolution:
    attempt_qty = run.remaining_qty
    submitted = _submit_mapping(
        io.submit,
        run.attempt_request(attempt),
        run.attempt_params(attempt),
    )
    submitted_fill = run.record_fill(
        submitted,
        attempt_qty=attempt_qty,
        already_recorded=Decimal("0"),
    )
    resolution = _resolve_attempt_order(run=run, order=submitted, attempt=attempt)
    if resolution.result is not None or resolution.retry:
        return resolution

    io.sleep(max(0.0, run.policy.reprice_seconds))
    observed = _observe_order(io.execution_client, submitted)
    observed_fill = run.record_fill(
        observed,
        attempt_qty=attempt_qty,
        already_recorded=submitted_fill,
    )
    resolution = _resolve_attempt_order(run=run, order=observed, attempt=attempt)
    if resolution.result is not None or resolution.retry:
        return resolution

    canceled = _cancel_and_observe(
        io.execution_client,
        observed,
        sleep=io.sleep,
    )
    run.record_fill(
        canceled,
        attempt_qty=attempt_qty,
        already_recorded=observed_fill,
    )
    resolution = _resolve_attempt_order(run=run, order=canceled, attempt=attempt)
    if resolution.result is None and not resolution.retry:
        raise OrderLifecycleSafetyError("order_lifecycle_cancel_not_terminal")
    return resolution


def _resolve_attempt_order(
    *,
    run: _LifecycleRun,
    order: Mapping[str, object],
    attempt: int,
) -> _AttemptResolution:
    status = _status(order)
    if status == "filled" or run.remaining_qty <= 0:
        return _AttemptResolution(
            result=OrderLifecycleResult(
                dict(order),
                tuple(run.prior_orders),
                attempt,
                False,
            )
        )
    if status in _RETRYABLE_TERMINAL_ORDER_STATUSES and attempt < run.policy.attempts:
        run.prior_orders.append(dict(order))
        return _AttemptResolution(retry=True)
    if status in _TERMINAL_ORDER_STATUSES:
        return _AttemptResolution(
            result=_exhausted_result(order=order, run=run, attempt=attempt)
        )
    return _AttemptResolution()


def _exhausted_result(
    *,
    order: Mapping[str, object],
    run: _LifecycleRun,
    attempt: int,
) -> OrderLifecycleResult:
    exhausted = dict(order)
    exhausted["_order_lifecycle"] = {
        "attempts": attempt,
        "exhausted": True,
        "filled_qty_total": str(max(Decimal("0"), run.request.qty - run.remaining_qty)),
        "remaining_qty": str(run.remaining_qty),
        "slippage_bps": str(run.policy.slippage_bps),
    }
    return OrderLifecycleResult(
        exhausted,
        tuple(run.prior_orders),
        attempt,
        True,
    )


def _submit_mapping(
    submit: Callable[[ExecutionRequest, dict[str, object]], Mapping[str, object]],
    request: ExecutionRequest,
    extra_params: dict[str, object],
) -> dict[str, object]:
    return {str(key): value for key, value in submit(request, extra_params).items()}


def _observe_order(
    execution_client: OrderLifecycleClient,
    submitted: Mapping[str, object],
) -> dict[str, object]:
    order_id = str(submitted.get("id") or submitted.get("order_id") or "").strip()
    if not order_id:
        raise OrderLifecycleSafetyError("order_lifecycle_read_unavailable")
    try:
        observed = execution_client.get_order(order_id)
    except (
        APIError,
        AttributeError,
        OSError,
        RuntimeError,
        TypeError,
        ValueError,
    ) as exc:
        _cancel_known_order(execution_client, order_id)
        raise OrderLifecycleSafetyError("order_lifecycle_read_failed") from exc
    if not isinstance(observed, Mapping):
        _cancel_known_order(execution_client, order_id)
        raise OrderLifecycleSafetyError("order_lifecycle_read_invalid")
    return {
        str(key): value
        for key, value in cast(Mapping[object, object], observed).items()
    }


def _cancel_and_observe(
    execution_client: OrderLifecycleClient,
    observed: Mapping[str, object],
    *,
    sleep: Callable[[float], None],
) -> dict[str, object]:
    order_id = str(observed.get("id") or observed.get("order_id") or "").strip()
    if not order_id:
        raise OrderLifecycleSafetyError("order_lifecycle_order_id_missing")
    _cancel_known_order(execution_client, order_id)
    latest = dict(observed)
    for confirmation_attempt in range(3):
        latest = _observe_order(execution_client, observed)
        if _status(latest) in _TERMINAL_ORDER_STATUSES:
            return latest
        if confirmation_attempt < 2:
            sleep(0.1)
    _cancel_all(execution_client)
    raise OrderLifecycleSafetyError("order_lifecycle_cancel_unconfirmed")


def _cancel_known_order(
    execution_client: OrderLifecycleClient,
    order_id: str,
) -> None:
    try:
        canceled = execution_client.cancel_order(order_id)
    except (
        APIError,
        AttributeError,
        OSError,
        RuntimeError,
        TypeError,
        ValueError,
    ) as exc:
        _cancel_all(execution_client)
        raise OrderLifecycleSafetyError("order_lifecycle_cancel_failed") from exc
    if canceled is False:
        _cancel_all(execution_client)
        raise OrderLifecycleSafetyError("order_lifecycle_cancel_rejected")


def _cancel_all(execution_client: OrderLifecycleClient) -> None:
    try:
        execution_client.cancel_all_orders()
    except (APIError, AttributeError, OSError, RuntimeError, TypeError, ValueError):
        pass


def _attempt_limit(
    *,
    side: str,
    initial_limit: Decimal,
    attempt: int,
    max_attempts: int,
    slippage_bps: Decimal,
) -> Decimal:
    denominator = max(1, max_attempts - 1)
    fraction = Decimal(max(0, attempt - 1)) / Decimal(denominator)
    adverse_fraction = max(Decimal("0"), slippage_bps) * fraction / Decimal("10000")
    multiplier = (
        Decimal("1") + adverse_fraction
        if side == "buy"
        else Decimal("1") - adverse_fraction
    )
    rounding = ROUND_UP if side == "buy" else ROUND_DOWN
    tick = Decimal("0.01") if initial_limit >= 1 else Decimal("0.0001")
    return (initial_limit * multiplier).quantize(tick, rounding=rounding)


def _attempt_client_order_id(client_order_id: str | None, attempt: int) -> str | None:
    if not client_order_id or attempt <= 1:
        return client_order_id
    suffix = f"-r{attempt}"
    return f"{client_order_id[: 128 - len(suffix)]}{suffix}"


def attempt_client_order_ids(
    client_order_id: str | None,
    *,
    max_attempts: int,
) -> tuple[str, ...]:
    """Return every broker idempotency key used by a bounded lifecycle."""

    return tuple(
        resolved
        for attempt in range(1, max(1, max_attempts) + 1)
        if (resolved := _attempt_client_order_id(client_order_id, attempt))
    )


def fetch_existing_orders(
    execution_client: object,
    client_order_id: str | None,
    *,
    max_attempts: int,
) -> list[dict[str, object]]:
    """Read every broker order created by one bounded lifecycle."""

    if not client_order_id:
        return []
    getter = getattr(execution_client, "get_order_by_client_order_id", None)
    if not callable(getter):
        return []
    orders: list[dict[str, object]] = []
    for attempt_id in attempt_client_order_ids(
        client_order_id, max_attempts=max_attempts
    ):
        try:
            order = getter(attempt_id)
        except (APIError, OSError, RuntimeError, TypeError, ValueError) as exc:
            raise OrderLifecycleSafetyError(
                "order_lifecycle_recovery_read_failed"
            ) from exc
        if order is None:
            continue
        if not isinstance(order, Mapping):
            raise OrderLifecycleSafetyError("order_lifecycle_recovery_read_invalid")
        orders.append(
            {
                str(key): value
                for key, value in cast(Mapping[object, object], order).items()
            }
        )
    return orders


def _status(order: Mapping[str, object]) -> str:
    return str(order.get("status") or "").strip().lower()


def _nonnegative_decimal(value: object) -> Decimal:
    try:
        parsed = Decimal(str(value or "0"))
    except (ArithmeticError, ValueError):
        return Decimal("0")
    return parsed if parsed.is_finite() and parsed >= 0 else Decimal("0")


__all__ = [
    "OrderLifecycleIO",
    "OrderLifecyclePolicy",
    "OrderLifecycleResult",
    "OrderLifecycleSafetyError",
    "attempt_client_order_ids",
    "fetch_existing_orders",
    "live_order_recovery_scan_limit",
    "submit_with_bounded_repricing",
]
