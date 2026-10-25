"""Strictly parse one exact Hyperliquid order-status response."""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Literal, cast

from ..trading.risk_reduction import BrokerOrderObservation
from .exchange_reconciliation import decimal_value
from .models import OpenOrder


def open_order_observation(
    raw_status: object,
    expected: OpenOrder,
) -> BrokerOrderObservation | None:
    envelope = _order_envelope(raw_status)
    if envelope is None:
        return None
    raw = _nested_order(envelope)
    order_id, cloid, coin = _validated_identity(raw, expected)
    order_status = str(envelope.get("status") or raw.get("status") or "").strip()
    if order_status != "open":
        return None
    raw_limit = raw.get("limitPx") or raw.get("limit_price")
    return BrokerOrderObservation(
        order_id=order_id,
        client_order_id=cloid or expected.cloid,
        symbol=coin,
        side=_order_side(raw),
        quantity=decimal_value(raw.get("sz") or raw.get("size")),
        filled_quantity=Decimal("0"),
        status="open",
        limit_price=decimal_value(raw_limit) if raw_limit is not None else None,
    )


def _order_envelope(raw_status: object) -> Mapping[str, object] | None:
    if not isinstance(raw_status, Mapping):
        raise ValueError("hyperliquid_order_status_invalid")
    status_payload = cast(Mapping[str, object], raw_status)
    lookup_status = str(status_payload.get("status") or "").strip()
    if lookup_status in {"unknownOid", "unknown_oid", "not_found"}:
        return None
    if lookup_status != "order":
        raise ValueError("hyperliquid_order_status_invalid")
    envelope = status_payload.get("order")
    if not isinstance(envelope, Mapping):
        raise ValueError("hyperliquid_order_status_payload_invalid")
    return cast(Mapping[str, object], envelope)


def _nested_order(envelope: Mapping[str, object]) -> Mapping[str, object]:
    nested = envelope.get("order")
    if isinstance(nested, Mapping):
        return cast(Mapping[str, object], nested)
    return envelope


def _validated_identity(
    raw: Mapping[str, object],
    expected: OpenOrder,
) -> tuple[str, str, str]:
    order_id = str(raw.get("oid") or raw.get("order_id") or "").strip()
    cloid = str(raw.get("cloid") or "").strip()
    coin = str(raw.get("coin") or "").strip()
    if not order_id:
        raise ValueError("hyperliquid_open_order_id_invalid")
    if (
        expected.exchange_order_id is not None
        and order_id != expected.exchange_order_id
    ):
        raise ValueError("hyperliquid_open_order_id_mismatch")
    if cloid and cloid != expected.cloid:
        raise ValueError("hyperliquid_open_order_cloid_mismatch")
    if expected.exchange_order_id is None and cloid != expected.cloid:
        raise ValueError("hyperliquid_open_order_cloid_mismatch")
    if not coin:
        raise ValueError("hyperliquid_open_order_coin_invalid")
    if coin != expected.coin:
        raise ValueError("hyperliquid_open_order_coin_mismatch")
    return order_id, cloid, coin


def _order_side(raw: Mapping[str, object]) -> Literal["buy", "sell"]:
    side = str(raw.get("side") or "").strip().lower()
    if side in {"b", "buy", "bid"}:
        return "buy"
    if side in {"a", "ask", "s", "sell"}:
        return "sell"
    raise ValueError("hyperliquid_open_order_side_invalid")


__all__ = ["open_order_observation"]
