"""Read-only recovery identities for historical broker order attempts."""

from __future__ import annotations

from collections.abc import Mapping
from typing import cast

from alpaca.common.exceptions import APIError


class OrderLifecycleSafetyError(RuntimeError):
    """Raised when historical broker state cannot be read safely."""


# Older releases could create three repricing IDs. New submissions make exactly
# one broker call, but recovery must continue to find those historical orders.
HISTORICAL_LIVE_ORDER_ATTEMPT_SCAN_LIMIT = 3


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
    """Return historical idempotency keys used before durable receipts."""

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
    """Read broker orders for an exact current or historical client identity."""

    if not client_order_id:
        return []
    getter = getattr(execution_client, "get_order_by_client_order_id", None)
    if not callable(getter):
        return []
    orders: list[dict[str, object]] = []
    for attempt_id in attempt_client_order_ids(
        client_order_id,
        max_attempts=max_attempts,
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


__all__ = [
    "HISTORICAL_LIVE_ORDER_ATTEMPT_SCAN_LIMIT",
    "OrderLifecycleSafetyError",
    "attempt_client_order_ids",
    "fetch_existing_orders",
]
