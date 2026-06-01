"""Torghut TigerBeetle ledger constants and value objects."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP


PNL_DIRECTION_PROFIT = "profit"
PNL_DIRECTION_LOSS = "loss"

LEDGER_USD_MICRO = 840001
USD_MICRO_SCALE = Decimal("1000000")

ACCOUNT_CODE_CASH_CONTROL = 1001
ACCOUNT_CODE_ORDER_HOLD = 1101
ACCOUNT_CODE_FILL_NOTIONAL = 1201
ACCOUNT_CODE_EXECUTION_COST = 1301
ACCOUNT_CODE_REALIZED_PNL = 1401
ACCOUNT_CODE_EVIDENCE_CONTROL = 1501
ACCOUNT_CODE_EXECUTION_EVIDENCE = 1502
ACCOUNT_CODE_RUNTIME_LEDGER_EVIDENCE = 1503
ACCOUNT_CODE_SMOKE_CASH = 9001
ACCOUNT_CODE_SMOKE_COUNTERPARTY = 9002

TRANSFER_CODE_SUBMITTED_PENDING = 2000
TRANSFER_CODE_FILL_POST = 2001
TRANSFER_CODE_CANCEL_VOID = 2002
TRANSFER_CODE_REJECT_VOID = 2003
TRANSFER_CODE_EXPLICIT_FEE = 2004
TRANSFER_CODE_EXECUTION_FILL = 2010
TRANSFER_CODE_EXECUTION_COST = 2011
TRANSFER_CODE_RUNTIME_NET_PNL = 2012
TRANSFER_CODE_SMOKE = 9000

TRANSFER_KIND_SUBMITTED_PENDING = "submitted_pending"
TRANSFER_KIND_FILL_POST = "fill_post"
TRANSFER_KIND_CANCEL_VOID = "cancel_void"
TRANSFER_KIND_REJECT_VOID = "reject_void"
TRANSFER_KIND_EXPLICIT_FEE = "explicit_fee"
TRANSFER_KIND_EXECUTION_FILL = "execution_fill"
TRANSFER_KIND_EXECUTION_COST = "execution_cost"
TRANSFER_KIND_RUNTIME_NET_PNL = "runtime_net_pnl"
TRANSFER_KIND_SMOKE = "smoke_transfer"

TRANSFER_CODE_BY_KIND: dict[str, int] = {
    TRANSFER_KIND_SUBMITTED_PENDING: TRANSFER_CODE_SUBMITTED_PENDING,
    TRANSFER_KIND_FILL_POST: TRANSFER_CODE_FILL_POST,
    TRANSFER_KIND_CANCEL_VOID: TRANSFER_CODE_CANCEL_VOID,
    TRANSFER_KIND_REJECT_VOID: TRANSFER_CODE_REJECT_VOID,
    TRANSFER_KIND_EXPLICIT_FEE: TRANSFER_CODE_EXPLICIT_FEE,
    TRANSFER_KIND_EXECUTION_FILL: TRANSFER_CODE_EXECUTION_FILL,
    TRANSFER_KIND_EXECUTION_COST: TRANSFER_CODE_EXECUTION_COST,
    TRANSFER_KIND_RUNTIME_NET_PNL: TRANSFER_CODE_RUNTIME_NET_PNL,
    TRANSFER_KIND_SMOKE: TRANSFER_CODE_SMOKE,
}


@dataclass(frozen=True)
class TigerBeetleAccountSpec:
    account_id: int
    account_key: str
    ledger: int
    code: int
    account_label: str | None = None
    symbol: str | None = None
    strategy_id: str | None = None


@dataclass(frozen=True)
class TigerBeetleTransferSpec:
    transfer_id: int
    transfer_kind: str
    debit_account_id: int
    credit_account_id: int
    amount: int
    ledger: int
    code: int
    pending_id: int = 0
    flags: int = 0
    timeout: int = 0


def decimal_usd_to_micros(value: Decimal) -> int:
    scaled = value * USD_MICRO_SCALE
    if scaled != scaled.to_integral_value():
        raise ValueError("usd_amount_exceeds_micro_precision")
    if scaled < 0:
        raise ValueError("usd_amount_negative")
    return int(scaled)


def decimal_usd_to_nearest_micros(value: Decimal) -> int:
    scaled = value * USD_MICRO_SCALE
    if scaled < 0:
        raise ValueError("usd_amount_negative")
    return int(scaled.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def transfer_kind_for_event(event_type: str | None, status: str | None) -> str | None:
    normalized = (event_type or status or "").strip().lower()
    if normalized in {"new", "accepted", "submitted", "order_submitted"}:
        return TRANSFER_KIND_SUBMITTED_PENDING
    if normalized in {"fill", "filled", "partial_fill", "partially_filled"}:
        return TRANSFER_KIND_FILL_POST
    if normalized in {"canceled", "cancelled", "expired"}:
        return TRANSFER_KIND_CANCEL_VOID
    if normalized in {"rejected"}:
        return TRANSFER_KIND_REJECT_VOID
    return None


def transfer_code_for_kind(transfer_kind: str) -> int:
    try:
        return TRANSFER_CODE_BY_KIND[transfer_kind]
    except KeyError as exc:
        raise ValueError(f"unknown_tigerbeetle_transfer_kind:{transfer_kind}") from exc
