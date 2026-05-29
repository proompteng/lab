#!/usr/bin/env python3
"""Flatten the Torghut paper account so runtime proof windows start clean."""

from __future__ import annotations

import argparse
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Protocol

from app.alpaca_client import TorghutAlpacaClient
from app.config import settings
from app.trading.firewall import OrderFirewall

DEFAULT_ACCOUNT_LABEL = "TORGHUT_SIM"
DEFAULT_PAPER_BASE_URL = "https://paper-api.alpaca.markets"
DEFAULT_MAX_GROSS_MARKET_VALUE = Decimal("2500")
DEFAULT_MAX_POSITION_COUNT = 25
TERMINAL_CLEAN_STATUSES = frozenset({"clean", "dry_run", "submitted"})


class PaperFlattenClient(Protocol):
    def list_positions(self) -> list[dict[str, Any]] | None: ...

    def cancel_all_orders(self) -> list[dict[str, Any]]: ...

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
    ) -> dict[str, Any]: ...


@dataclass(frozen=True)
class FlattenPosition:
    symbol: str
    qty: Decimal
    side: str
    market_value: Decimal

    @property
    def close_side(self) -> str:
        return "buy" if self.side == "short" or self.qty < 0 else "sell"

    @property
    def close_qty(self) -> Decimal:
        return abs(self.qty)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Cancel paper open orders and submit opposing market orders for open "
            "paper positions. Defaults to dry-run and refuses live/non-TORGHUT_SIM use."
        ),
    )
    parser.add_argument("--account-label", default=settings.trading_account_label)
    parser.add_argument("--expected-account-label", default=DEFAULT_ACCOUNT_LABEL)
    parser.add_argument("--trading-mode", default=settings.trading_mode)
    parser.add_argument(
        "--paper-base-url",
        default=DEFAULT_PAPER_BASE_URL,
        help="Alpaca paper endpoint to use; kept explicit to avoid inheriting live URLs.",
    )
    parser.add_argument(
        "--max-gross-market-value",
        default=str(DEFAULT_MAX_GROSS_MARKET_VALUE),
        help="Refuse to submit flatten orders above this absolute market value.",
    )
    parser.add_argument(
        "--max-position-count",
        type=int,
        default=DEFAULT_MAX_POSITION_COUNT,
        help="Refuse to submit flatten orders above this number of open positions.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Submit flatten orders. Without this flag, only report the plan.",
    )
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def _decimal(value: object, *, default: Decimal = Decimal("0")) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return default


def _position_qty(position: Mapping[str, Any]) -> Decimal:
    qty = _decimal(position.get("qty", position.get("quantity")))
    side = str(position.get("side") or "").strip().lower()
    if side == "short" and qty > 0:
        return -qty
    return qty


def _position_market_value(position: Mapping[str, Any], qty: Decimal) -> Decimal:
    raw_value = position.get("market_value", position.get("marketValue"))
    value = _decimal(raw_value)
    if value != 0:
        return abs(value)
    price = _decimal(
        position.get("current_price", position.get("currentPrice")),
        default=Decimal("0"),
    )
    return abs(qty) * abs(price)


def _normalize_positions(
    raw_positions: Sequence[Mapping[str, Any]] | None,
) -> list[FlattenPosition]:
    normalized: list[FlattenPosition] = []
    for raw in raw_positions or []:
        symbol = str(raw.get("symbol") or "").strip().upper()
        if not symbol:
            continue
        qty = _position_qty(raw)
        if qty == 0:
            continue
        side = str(raw.get("side") or "").strip().lower()
        if side not in {"long", "short"}:
            side = "short" if qty < 0 else "long"
        normalized.append(
            FlattenPosition(
                symbol=symbol,
                qty=qty,
                side=side,
                market_value=_position_market_value(raw, qty),
            )
        )
    return sorted(normalized, key=lambda item: item.symbol)


def _position_payload(position: FlattenPosition) -> dict[str, str]:
    return {
        "symbol": position.symbol,
        "qty": str(position.qty),
        "side": position.side,
        "market_value": str(position.market_value),
        "close_side": position.close_side,
        "close_qty": str(position.close_qty),
    }


def flatten_paper_account_positions(
    *,
    client: PaperFlattenClient,
    account_label: str,
    expected_account_label: str,
    trading_mode: str,
    apply: bool,
    max_gross_market_value: Decimal,
    max_position_count: int,
    generated_at: datetime | None = None,
) -> dict[str, Any]:
    generated_at = generated_at or datetime.now(timezone.utc)
    normalized_mode = trading_mode.strip().lower()
    normalized_label = account_label.strip()
    expected_label = expected_account_label.strip()
    blockers: list[str] = []

    if normalized_mode != "paper":
        blockers.append("paper_account_flatten_requires_paper_mode")
    if normalized_label != expected_label:
        blockers.append("paper_account_flatten_account_label_mismatch")

    raw_positions = client.list_positions()
    positions = _normalize_positions(raw_positions)
    gross_market_value = sum(
        (position.market_value for position in positions), Decimal("0")
    )
    if len(positions) > max(0, max_position_count):
        blockers.append("paper_account_flatten_position_count_above_limit")
    if gross_market_value > max_gross_market_value:
        blockers.append("paper_account_flatten_gross_market_value_above_limit")

    status = "clean" if not positions and not blockers else "blocked"
    cancelled_orders: list[dict[str, Any]] = []
    submitted_orders: list[dict[str, Any]] = []
    if blockers:
        status = "blocked"
    elif not apply:
        status = "dry_run" if positions else "clean"
    elif positions:
        cancelled_orders = client.cancel_all_orders()
        for position in positions:
            submitted_orders.append(
                client.submit_order(
                    symbol=position.symbol,
                    side=position.close_side,
                    qty=float(position.close_qty),
                    order_type="market",
                    time_in_force="day",
                    extra_params={
                        "client_order_id": (
                            "torghut-paper-flatten-"
                            f"{generated_at.strftime('%Y%m%d%H%M%S')}-"
                            f"{position.symbol.lower()}"
                        )
                    },
                )
            )
        status = "submitted"

    return {
        "schema_version": "torghut.paper-account-flatten.v1",
        "status": status,
        "apply": apply,
        "generated_at": generated_at.isoformat(),
        "account_label": normalized_label,
        "expected_account_label": expected_label,
        "trading_mode": normalized_mode,
        "position_count": len(positions),
        "gross_market_value": str(gross_market_value),
        "max_gross_market_value": str(max_gross_market_value),
        "max_position_count": max_position_count,
        "blockers": blockers,
        "positions": [_position_payload(position) for position in positions],
        "cancelled_order_count": len(cancelled_orders),
        "cancelled_orders": cancelled_orders,
        "submitted_order_count": len(submitted_orders),
        "submitted_orders": submitted_orders,
    }


def main() -> int:
    args = _parse_args()
    max_gross_market_value = _decimal(
        args.max_gross_market_value,
        default=DEFAULT_MAX_GROSS_MARKET_VALUE,
    )
    client = TorghutAlpacaClient(paper=True, base_url=str(args.paper_base_url or ""))
    firewall = OrderFirewall(client)
    payload = flatten_paper_account_positions(
        client=firewall,
        account_label=str(args.account_label or ""),
        expected_account_label=str(args.expected_account_label or ""),
        trading_mode=str(args.trading_mode or ""),
        apply=bool(args.apply),
        max_gross_market_value=max_gross_market_value,
        max_position_count=max(0, int(args.max_position_count)),
    )
    if args.json:
        print(json.dumps(payload, sort_keys=True))
    else:
        print(
            f"status={payload['status']} positions={payload['position_count']} "
            f"submitted={payload['submitted_order_count']} blockers={','.join(payload['blockers'])}"
        )
    return 0 if payload["status"] in TERMINAL_CLEAN_STATUSES else 2


if __name__ == "__main__":
    raise SystemExit(main())
